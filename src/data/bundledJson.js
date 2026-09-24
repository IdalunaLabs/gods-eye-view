/**
 * Read one bundled JSON dataset.
 *
 * Callers pass `new URL('./local_data/<file>', import.meta.url)`. Vite rewrites
 * that reference to a hashed static asset. Node's fetch does not implement
 * `file:`, so unit tests read that scheme through the runtime builtin. The
 * builtin is not a module import, so it never enters the browser graph.
 *
 * @param {URL|string} url Dataset URL.
 * @param {object} [options]
 * @param {AbortSignal} [options.signal] Cancel before the body is used.
 * @param {typeof fetch} [options.fetchImpl] HTTP fetch seam.
 * @returns {Promise<any>} Parsed JSON.
 */
export async function loadBundledJson(
  url,
  { signal, fetchImpl = globalThis.fetch } = {},
) {
  const target = url instanceof URL ? url : new URL(String(url));
  signal?.throwIfAborted();
  if (target.protocol === 'file:') return readFileJson(target, signal);
  if (typeof fetchImpl !== 'function') {
    throw new Error('dataset unavailable (no fetch)');
  }
  const response = await fetchImpl(target, { signal });
  if (!response?.ok) {
    try {
      await response?.body?.cancel();
    } catch {
      /* best effort */
    }
    throw new Error(`HTTP ${response?.status ?? '?'}`);
  }
  const json = await response.json();
  signal?.throwIfAborted();
  return json;
}

/**
 * @param {URL} target
 * @param {AbortSignal|undefined} signal
 */
async function readFileJson(target, signal) {
  const fs = globalThis.process?.getBuiltinModule?.('node:fs/promises');
  if (typeof fs?.readFile !== 'function') {
    throw new Error('dataset unavailable (file URL is not readable here)');
  }
  const text = await fs.readFile(target, 'utf8');
  signal?.throwIfAborted();
  return JSON.parse(text);
}

/**
 * Snapshot a bundled-dataset load for the shared loading chip.
 * `idle` is an honest not-yet-loaded result, not an empty success.
 *
 * @param {object} [status]
 * @param {string} [status.id]
 * @param {string} [status.label]
 * @param {'idle'|'loading'|'ready'|'error'} [status.state]
 * @param {string|null} [status.error]
 * @param {number} [status.count]
 * @param {number|null} [status.loadedAt]
 * @returns {{id:string,name:string,enabled:boolean,lifecycleState:string,stats:object}}
 */
export function bundledDatasetLoadingLayer(status = {}) {
  const state = ['idle', 'loading', 'ready', 'error'].includes(status.state)
    ? status.state
    : 'idle';
  const loading = state === 'loading';
  const failed = state === 'error';
  const count = Number(status.count);
  return {
    id: String(status.id || 'bundled-dataset'),
    name: String(status.label || 'Bundled dataset'),
    enabled: loading || state === 'ready',
    lifecycleState: loading
      ? 'enabling'
      : state === 'ready'
        ? 'enabled'
        : 'disabled',
    stats: {
      loading,
      error: failed
        ? String(status.error || 'dataset unavailable')
        : null,
      unavailable: failed,
      count: Number.isFinite(count) && count >= 0 ? count : 0,
      lastUpdate: Number.isFinite(status.loadedAt) ? status.loadedAt : null,
    },
  };
}
