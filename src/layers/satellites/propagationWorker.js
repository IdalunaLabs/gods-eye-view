import { prepareSatrecs, propagateBatch } from './propagation.js';

/**
 * Mutable catalog owned by one propagation worker.
 * @returns {{satrecs: Array<object|null>}}
 */
export function createPropagationWorkerState() {
  return { satrecs: [] };
}

/**
 * Handle one catalog load or one full-catalog propagation.
 * Propagation replies transfer the filled buffer back to the caller.
 * @param {{satrecs: Array<object|null>}} state
 * @param {{type?: string, tles?: Array<{line1?: string, line2?: string}>, dateMs?: number, generation?: number, buffer?: ArrayBuffer}} message
 * @returns {{reply: object, transfer?: ArrayBuffer[]}|null}
 */
export function handlePropagationMessage(state, message) {
  if (!message || typeof message !== 'object') {
    return { reply: { type: 'error', message: 'Empty propagation message' } };
  }
  if (message.type === 'load') {
    state.satrecs = prepareSatrecs(
      Array.isArray(message.tles) ? message.tles : [],
    );
    return {
      reply: {
        type: 'loaded',
        generation: message.generation,
        count: state.satrecs.length,
      },
    };
  }
  if (message.type === 'propagate') {
    const out = new Float64Array(message.buffer);
    propagateBatch(state.satrecs, message.dateMs, out);
    return {
      reply: {
        type: 'propagated',
        dateMs: message.dateMs,
        generation: message.generation,
        buffer: message.buffer,
      },
      transfer: [message.buffer],
    };
  }
  return { reply: { type: 'error', message: 'Unknown propagation message' } };
}

const workerState = createPropagationWorkerState();

if (
  typeof DedicatedWorkerGlobalScope !== 'undefined' &&
  typeof self !== 'undefined' &&
  self instanceof DedicatedWorkerGlobalScope
) {
  self.addEventListener('message', (event) => {
    try {
      const result = handlePropagationMessage(workerState, event.data);
      if (!result) return;
      if (result.transfer) self.postMessage(result.reply, result.transfer);
      else self.postMessage(result.reply);
    } catch (error) {
      self.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : 'Propagation failed',
      });
    }
  });
}
