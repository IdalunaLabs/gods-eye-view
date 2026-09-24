import { HISTORY_LAYERS } from './historyStore.js';

/** Playback speeds offered by the scrubber. */
export const REPLAY_SPEEDS = Object.freeze([1, 4, 16]);

/** @typedef {'LIVE'|'REPLAY_PAUSED'|'REPLAY_PLAYING'} ReplayMode */

/**
 * Format a signed offset from the live edge as `-MM:SS`.
 * Minutes may exceed 59.
 * @param {number} offsetMs Negative while the cursor is behind the buffer edge.
 * @returns {string}
 */
export function formatReplayOffset(offsetMs) {
  const negative = offsetMs < 0;
  const totalSec = Math.max(0, Math.round(Math.abs(offsetMs) / 1000));
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${negative ? '-' : ''}${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Portable LIVE / paused / playing clock over a history store.
 * @param {object} options
 * @param {object} options.store
 * @param {() => number} [options.now]
 */
export function createReplayController({ store, now = () => Date.now() }) {
  /** @type {ReplayMode} */
  let mode = 'LIVE';
  let speed = 1;
  let cursorMs = null;
  let lastTickMs = null;
  const listeners = new Set();

  /**
   * Union of buffered layer extents.
   * @returns {{startMs: number|null, endMs: number|null}}
   */
  function bufferedRange() {
    let startMs = null;
    let endMs = null;
    for (const layer of HISTORY_LAYERS) {
      const extent = store.range(layer);
      if (extent.startMs == null) continue;
      startMs =
        startMs == null ? extent.startMs : Math.min(startMs, extent.startMs);
      endMs = endMs == null ? extent.endMs : Math.max(endMs, extent.endMs);
    }
    return { startMs, endMs };
  }

  /**
   * @param {number} tMs
   * @returns {number|null}
   */
  function clampTime(tMs) {
    const { startMs, endMs } = bufferedRange();
    if (startMs == null || endMs == null) return null;
    return Math.min(endMs, Math.max(startMs, tMs));
  }

  /**
   * @returns {object}
   */
  function snapshot() {
    const { startMs, endMs } = bufferedRange();
    const timeMs = mode === 'LIVE' ? null : cursorMs;
    const offsetMs = timeMs == null || endMs == null ? 0 : timeMs - endMs;
    return {
      mode,
      speed,
      timeMs,
      startMs,
      endMs,
      offsetMs,
      offsetLabel: formatReplayOffset(offsetMs),
      playing: mode === 'REPLAY_PLAYING',
      live: mode === 'LIVE',
    };
  }

  function emit() {
    const state = snapshot();
    for (const listener of listeners) {
      try {
        listener(state);
      } catch {
        /* Observers cannot block the clock. */
      }
    }
    return state;
  }

  /**
   * @param {() => void} listener
   * @returns {() => void}
   */
  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /**
   * Move the cursor into the buffer and pause when leaving LIVE.
   * @param {number} tMs
   * @returns {object}
   */
  function seek(tMs) {
    const next = clampTime(tMs);
    if (next == null) return snapshot();
    cursorMs = next;
    if (mode === 'LIVE') mode = 'REPLAY_PAUSED';
    return emit();
  }

  /**
   * Step the cursor by a signed duration. From LIVE, the step starts at the buffer edge.
   * @param {number} deltaMs
   * @returns {object}
   */
  function step(deltaMs) {
    const { endMs } = bufferedRange();
    if (endMs == null) return snapshot();
    const origin = mode === 'LIVE' || cursorMs == null ? endMs : cursorMs;
    return seek(origin + deltaMs);
  }

  /**
   * Play from the start of the buffer when LIVE or already at the live edge.
   * @returns {object}
   */
  function play() {
    const { startMs, endMs } = bufferedRange();
    if (startMs == null || endMs == null) return snapshot();
    if (mode === 'LIVE' || cursorMs == null || cursorMs >= endMs)
      cursorMs = startMs;
    mode = 'REPLAY_PLAYING';
    lastTickMs = now();
    return emit();
  }

  /**
   * @returns {object}
   */
  function pause() {
    if (mode !== 'REPLAY_PLAYING') return snapshot();
    mode = 'REPLAY_PAUSED';
    lastTickMs = null;
    return emit();
  }

  /**
   * @returns {object}
   */
  function goLive() {
    if (mode === 'LIVE' && cursorMs == null) return snapshot();
    mode = 'LIVE';
    cursorMs = null;
    lastTickMs = null;
    return emit();
  }

  /**
   * @param {number} next
   * @returns {object}
   */
  function setSpeed(next) {
    if (!REPLAY_SPEEDS.includes(next) || next === speed) return snapshot();
    speed = next;
    return emit();
  }

  /**
   * Advance a playing cursor. Paused and LIVE clocks ignore the timestamp.
   * @param {number} nowMs
   * @returns {object}
   */
  function tick(nowMs) {
    if (mode !== 'REPLAY_PLAYING') return snapshot();
    const dt = lastTickMs == null ? 0 : Math.max(0, nowMs - lastTickMs);
    lastTickMs = nowMs;
    const { endMs } = bufferedRange();
    if (endMs == null || cursorMs == null) return goLive();
    const next = cursorMs + dt * speed;
    if (next >= endMs) {
      cursorMs = endMs;
      mode = 'REPLAY_PAUSED';
      lastTickMs = null;
      return emit();
    }
    if (next === cursorMs) return snapshot();
    cursorMs = next;
    return emit();
  }

  return {
    get mode() {
      return mode;
    },
    get speed() {
      return speed;
    },
    get timeMs() {
      return mode === 'LIVE' ? null : cursorMs;
    },
    bufferedRange,
    snapshot,
    subscribe,
    seek,
    step,
    play,
    pause,
    goLive,
    setSpeed,
    tick,
  };
}
