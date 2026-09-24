import {
  prepareSatrecs,
  propagateBatch,
  propagationBufferLength,
  propagationGmstIndex,
} from './propagation.js';

const LOST_RESPONSE_MS = 5000;

/**
 * Main-thread fleet propagator. Uses a module worker when `Worker` exists and
 * the same synchronous batch otherwise. Rendering reads the latest completed
 * sample and never waits for an in-flight tick.
 * @param {{WorkerImpl?: (new () => Worker)|null, now?: () => number, lostAfterMs?: number, logger?: {warn: Function}}} [options]
 * @returns {object}
 */
export function createPropagationClient(options = {}) {
  const WorkerImpl = options.WorkerImpl;
  const clock = typeof options.now === 'function' ? options.now : Date.now;
  const lostAfterMs = options.lostAfterMs ?? LOST_RESPONSE_MS;
  const warn =
    options.logger && typeof options.logger.warn === 'function'
      ? options.logger.warn.bind(options.logger)
      : console.warn.bind(console);
  const workerAllowed =
    WorkerImpl !== null &&
    (typeof WorkerImpl === 'function' || typeof Worker !== 'undefined');

  let backend = workerAllowed ? 'worker' : 'sync';
  let worker = null;
  let warned = false;
  let generation = 0;
  let pendingLoadGeneration = 0;
  let readyGeneration = 0;
  let ready = false;
  let inflight = false;
  let inflightAtMs = 0;
  let boundRevisionValue = null;
  let records = [];
  let ids = [];
  let idSet = new Set();
  let syncSatrecs = null;
  let spareView = null;
  let idleView = null;
  let completedView = null;
  const published = {
    dateMs: 0,
    gmst: 0,
    buffer: null,
    ids: [],
    sequence: 0,
    generation: 0,
  };

  function warnOnce(reason) {
    if (warned) return;
    warned = true;
    warn(
      '[Data:Satellites] Propagation worker unavailable; using main-thread SGP4.',
      reason instanceof Error ? reason.message : reason,
    );
  }

  function terminateWorker() {
    const current = worker;
    worker = null;
    if (!current) return;
    current.removeEventListener?.('message', onMessage);
    current.removeEventListener?.('error', onWorkerError);
    current.removeEventListener?.('messageerror', onWorkerError);
    try {
      current.terminate();
    } catch {
      // The worker already stopped.
    }
  }

  function activateSync(loadGeneration) {
    if (loadGeneration !== pendingLoadGeneration) return;
    syncSatrecs = prepareSatrecs(records).map(
      (satrec, index) => satrec || records[index]?.satrec || null,
    );
    readyGeneration = loadGeneration;
    ready = true;
    idSet = new Set(ids);
    ensureBuffers(ids.length);
  }

  function fallback(reason) {
    if (backend === 'sync') return;
    backend = 'sync';
    inflight = false;
    terminateWorker();
    warnOnce(reason);
    activateSync(pendingLoadGeneration);
  }

  function ensureWorker() {
    if (backend !== 'worker' || worker) return;
    try {
      worker = openWorker();
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onWorkerError);
      worker.addEventListener('messageerror', onWorkerError);
    } catch (error) {
      fallback(error);
    }
  }

  function openWorker() {
    if (typeof WorkerImpl === 'function') return new WorkerImpl();
    return createBrowserWorker();
  }

  function ensureBuffers(count) {
    const bytes =
      propagationBufferLength(count) * Float64Array.BYTES_PER_ELEMENT;
    const fits = (view) => view && view.buffer.byteLength === bytes;
    if (fits(spareView) && (fits(idleView) || fits(completedView))) return;
    spareView = new Float64Array(propagationBufferLength(count));
    idleView = new Float64Array(propagationBufferLength(count));
    completedView = null;
    published.buffer = null;
  }

  function recycle(buffer) {
    if (!(buffer instanceof ArrayBuffer)) return;
    const bytes =
      propagationBufferLength(ids.length) * Float64Array.BYTES_PER_ELEMENT;
    if (buffer.byteLength !== bytes || spareView) return;
    spareView = new Float64Array(buffer);
  }

  function publish(view, dateMs) {
    completedView = view;
    published.buffer = view;
    published.ids = ids;
    published.dateMs = dateMs;
    published.gmst = view[propagationGmstIndex(ids.length)];
    published.generation = readyGeneration;
    published.sequence += 1;
  }

  function writeSync(dateMs) {
    if (!syncSatrecs) activateSync(pendingLoadGeneration);
    if (!syncSatrecs) return false;
    ensureBuffers(syncSatrecs.length);
    propagateBatch(syncSatrecs, dateMs, spareView);
    const written = spareView;
    spareView = completedView || idleView;
    idleView = null;
    publish(written, dateMs);
    return true;
  }

  function sendPropagate(dateMs) {
    ensureBuffers(ids.length);
    const buffer = spareView.buffer;
    spareView = null;
    inflight = true;
    inflightAtMs = clock();
    worker.postMessage(
      {
        type: 'propagate',
        dateMs,
        generation: readyGeneration,
        buffer,
      },
      [buffer],
    );
  }

  function onLoaded(message) {
    if (message.generation !== pendingLoadGeneration || backend !== 'worker')
      return;
    if (message.count !== ids.length) {
      fallback('propagation catalog length mismatch');
      return;
    }
    readyGeneration = message.generation;
    ready = true;
    idSet = new Set(ids);
    ensureBuffers(ids.length);
  }

  function onPropagated(message) {
    inflight = false;
    if (
      backend !== 'worker' ||
      message.generation !== readyGeneration ||
      !ready ||
      !(message.buffer instanceof ArrayBuffer)
    ) {
      recycle(message.buffer);
      return;
    }
    const previous = completedView;
    const view = new Float64Array(message.buffer);
    if (view.length < propagationBufferLength(ids.length)) {
      fallback('propagation buffer was short');
      return;
    }
    spareView = previous || idleView;
    idleView = null;
    publish(view, message.dateMs);
  }

  function onMessage(event) {
    const message = event?.data;
    if (!message || backend !== 'worker') return;
    if (message.type === 'loaded') {
      onLoaded(message);
      return;
    }
    if (message.type === 'propagated') {
      onPropagated(message);
      return;
    }
    if (message.type === 'error')
      fallback(message.message || 'propagation worker failed');
  }

  function onWorkerError(event) {
    fallback(event?.message || event?.error || 'propagation worker failed');
  }

  function poll() {
    if (
      backend === 'worker' &&
      inflight &&
      clock() - inflightAtMs > lostAfterMs
    ) {
      fallback('propagation response was lost');
    }
  }

  /**
   * Replace the worker catalog. `revision` is the layer's catalog generation.
   * @param {Array<{id: number, line1?: string, line2?: string, satrec?: object|null}>} nextRecords
   * @param {number} revision
   * @returns {void}
   */
  function load(nextRecords, revision) {
    records = nextRecords.map((record) => ({
      id: record.id,
      line1: record.line1,
      line2: record.line2,
      satrec: record.satrec || null,
    }));
    ids = records.map((record) => record.id);
    generation += 1;
    pendingLoadGeneration = generation;
    ready = false;
    idSet = new Set();
    syncSatrecs = null;
    published.buffer = null;
    inflight = false;
    boundRevisionValue = revision;
    if (backend === 'sync') {
      activateSync(pendingLoadGeneration);
      return;
    }
    ensureWorker();
    if (backend === 'sync') return;
    try {
      worker.postMessage({
        type: 'load',
        generation: pendingLoadGeneration,
        tles: records.map((record) => ({
          line1: record.line1,
          line2: record.line2,
        })),
      });
    } catch (error) {
      fallback(error);
    }
  }

  /**
   * Request one catalog sample. Synchronous backends publish it immediately.
   * @param {number} dateMs
   * @returns {boolean} True when a sample was published or a worker request was sent.
   */
  function propagate(dateMs) {
    poll();
    if (!ids.length || !ready) return false;
    if (backend === 'sync') return writeSync(dateMs);
    if (inflight) return false;
    try {
      sendPropagate(dateMs);
      return true;
    } catch (error) {
      fallback(error);
      return writeSync(dateMs);
    }
  }

  /**
   * Latest completed sample, or null when none is ready.
   * @returns {{dateMs:number,gmst:number,buffer:Float64Array,ids:number[],sequence:number,generation:number}|null}
   */
  function latest() {
    if (!published.buffer) return null;
    return published;
  }

  /**
   * @param {Array<number>} list
   * @returns {boolean}
   */
  function coversAll(list) {
    if (!ready) return false;
    for (let i = 0; i < list.length; i += 1) {
      if (!idSet.has(list[i])) return false;
    }
    return true;
  }

  /** Drop the worker and any completed sample. */
  function reset() {
    terminateWorker();
    records = [];
    ids = [];
    idSet = new Set();
    syncSatrecs = null;
    spareView = null;
    idleView = null;
    completedView = null;
    published.buffer = null;
    ready = false;
    inflight = false;
    boundRevisionValue = null;
    generation += 1;
    pendingLoadGeneration = generation;
  }

  return {
    load,
    propagate,
    poll,
    latest,
    coversAll,
    reset,
    mode: () => backend,
    ready: () => ready,
    recordCount: () => ids.length,
    boundRevision: () => boundRevisionValue,
  };
}

/** Browser module worker. Vite emits this file as its own chunk. */
function createBrowserWorker() {
  return new Worker(new URL('./propagationWorker.js', import.meta.url), {
    type: 'module',
  });
}
