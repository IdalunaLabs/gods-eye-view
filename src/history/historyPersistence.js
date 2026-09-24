import { HISTORY_LAYERS } from './historyStore.js';
import { sharedHistorySession } from './session.js';

let sharedPersistence = null;

/**
 * Start one IndexedDB restore for the shared session, if the browser has IndexedDB.
 * Repeated calls return the same adapter. A buffer that already has samples is left alone.
 * @returns {{load: Function, flush: Function, destroy: Function}}
 */
export function attachSharedHistoryPersistence() {
  if (sharedPersistence) return sharedPersistence;
  const storage = createIndexedDbHistoryStorage();
  if (!storage) {
    sharedPersistence = {
      async load() {
        return false;
      },
      async flush() {},
      destroy() {},
    };
    return sharedPersistence;
  }
  sharedPersistence = createHistoryPersistence({
    store: sharedHistorySession().store,
    storage,
  });
  sharedPersistence.load().catch(() => {
    /* Keep the empty buffer when restore fails. */
  });
  return sharedPersistence;
}

/**
 * In-memory storage stand-in for tests and for runtimes without IndexedDB.
 * @returns {{read: Function, write: Function, delete: Function}}
 */
export function createMemoryHistoryStorage() {
  const records = new Map();
  return {
    /**
     * @param {string} key
     * @returns {Promise<object|undefined>}
     */
    async read(key) {
      if (!records.has(key)) return undefined;
      return structuredClone(records.get(key));
    },
    /**
     * @param {string} key
     * @param {object} value
     * @returns {Promise<void>}
     */
    async write(key, value) {
      records.set(key, structuredClone(value));
    },
    /**
     * @param {string} key
     * @returns {Promise<void>}
     */
    async delete(key) {
      records.delete(key);
    },
  };
}

/**
 * IndexedDB adapter. Returns null when the platform has no IndexedDB.
 * Browser-only; callers inject storage in tests.
 * @param {object} [options]
 * @param {IDBFactory|null} [options.idb]
 * @param {string} [options.dbName]
 * @param {string} [options.storeName]
 * @returns {{read: Function, write: Function, delete: Function}|null}
 */
export function createIndexedDbHistoryStorage({
  idb = globalThis.indexedDB,
  dbName = 'gods-eye-view-history',
  storeName = 'buffer',
} = {}) {
  if (!idb || typeof idb.open !== 'function') return null;
  let opening = null;

  function open() {
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      const request = idb.open(dbName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return opening;
  }

  /**
   * @param {'readonly'|'readwrite'} mode
   * @param {(store: IDBObjectStore) => IDBRequest} run
   */
  async function transaction(mode, run) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const request = run(tx.objectStore(storeName));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  return {
    read: (key) => transaction('readonly', (store) => store.get(key)),
    write: (key, value) =>
      transaction('readwrite', (store) => store.put(value, key)),
    delete: (key) => transaction('readwrite', (store) => store.delete(key)),
  };
}

/**
 * Write the store behind the poll path, no faster than `throttleMs`.
 * @param {object} options
 * @param {object} options.store History store.
 * @param {{read: Function, write: Function}} options.storage
 * @param {number} [options.throttleMs]
 * @param {string} [options.key]
 * @param {(callback: Function, ms: number) => unknown} [options.schedule]
 * @param {(timer: unknown) => void} [options.cancel]
 */
export function createHistoryPersistence({
  store,
  storage,
  throttleMs = 2000,
  key = 'state',
  schedule = (callback, ms) => setTimeout(callback, ms),
  cancel = (timer) => clearTimeout(timer),
}) {
  let timer = null;
  let dirty = false;
  let writing = null;
  const unsubscribe = store.subscribe(() => {
    dirty = true;
    arm();
  });

  function arm() {
    if (timer != null || writing) return;
    timer = schedule(() => {
      timer = null;
      void flush();
    }, throttleMs);
  }

  /**
   * Persist the current buffer immediately.
   * @returns {Promise<void>}
   */
  async function flush() {
    if (writing) return writing;
    if (!dirty) return undefined;
    dirty = false;
    writing = storage
      .write(key, store.exportState())
      .catch((error) => {
        dirty = true;
        throw error;
      })
      .finally(() => {
        writing = null;
        if (dirty) arm();
      });
    return writing;
  }

  /**
   * Restore a previously stored buffer into the same caps.
   * @returns {Promise<boolean>} True when a buffer was applied.
   */
  async function load() {
    const state = await storage.read(key);
    if (!state) return false;
    const stats = store.stats();
    const occupied = HISTORY_LAYERS.some(
      (layer) => (stats.layers?.[layer]?.count || 0) > 0,
    );
    if (occupied) return false;
    store.importState(state);
    dirty = false;
    return true;
  }

  /**
   * Cancel a pending write. In-flight writes still finish.
   * @returns {void}
   */
  function destroy() {
    unsubscribe();
    if (timer != null) cancel(timer);
    timer = null;
  }

  return { load, flush, destroy };
}
