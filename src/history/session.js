import { createHistoryCapture } from './historyCapture.js';
import { createHistoryQuery } from './historyQuery.js';
import { createHistoryStore } from './historyStore.js';
import { createReplayController } from './replayController.js';

let shared = null;

/**
 * Process-wide history buffer, sampler, and replay clock.
 * @returns {{store: object, query: object, replay: object, noteRecords: Function}}
 */
export function sharedHistorySession() {
  if (!shared) shared = createHistorySession();
  return shared;
}

/**
 * Drop the shared session. Tests use this so captures do not leak.
 * @returns {void}
 */
export function resetSharedHistorySessionForTest() {
  shared = null;
}

/**
 * @param {object} [options] Forwarded to the store.
 * @returns {{store: object, query: object, replay: object, noteRecords: Function}}
 */
export function createHistorySession(options) {
  const store = createHistoryStore(options);
  const query = createHistoryQuery(store);
  const replay = createReplayController({ store });
  const capture = createHistoryCapture(store);
  return {
    store,
    query,
    replay,
    noteRecords: capture.noteRecords,
  };
}
