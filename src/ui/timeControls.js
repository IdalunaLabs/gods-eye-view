import {
  holdContinuousRender,
  releaseContinuousRender,
  governorRequestRender,
} from '../renderGovernor.js';
import {
  attachSharedHistoryPersistence,
  createHistoryPersistence,
} from '../history/historyPersistence.js';
import { sharedHistorySession } from '../history/session.js';

/**
 * Bind the time-travel bar, replay badge, and playback clock.
 * Replay is session-only. The bar labels every non-live cursor as REPLAY.
 * @param {object} [options]
 * @param {object} [options.session] Store, query, and replay controller.
 * @param {object} [options.viewer] Cesium viewer used to advance playback.
 * @param {Document} [options.documentRef]
 * @param {() => {setReplayBadge?: Function}|null} [options.readHud]
 * @param {object|null} [options.storage] IndexedDB stand-in. Null skips persistence.
 * @param {object} [options.elements] DOM controls. Defaults to ids in `documentRef`.
 * @returns {{destroy: Function, step: Function, goLive: Function}}
 */
export function bindTimeControls({
  session = sharedHistorySession(),
  viewer = null,
  documentRef = globalThis.document,
  readHud = null,
  storage = undefined,
  elements = null,
} = {}) {
  const controls = elements || readElements(documentRef);
  const removers = [];
  let persistence = null;
  let lastMode = null;
  if (storage) {
    persistence = createHistoryPersistence({
      store: session.store,
      storage,
    });
    persistence.load().catch(() => {
      /* A failed restore leaves the empty in-memory buffer. */
    });
  } else if (storage === undefined) {
    attachSharedHistoryPersistence();
  }

  const listen = (element, type, handler) => {
    if (!element) return;
    element.addEventListener(type, handler);
    removers.push(() => element.removeEventListener(type, handler));
  };

  listen(controls.liveButton, 'click', () => session.replay.goLive());
  listen(controls.playButton, 'click', () => {
    if (session.replay.mode === 'REPLAY_PLAYING') session.replay.pause();
    else session.replay.play();
  });
  listen(controls.speedSelect, 'change', () => {
    session.replay.setSpeed(Number(controls.speedSelect.value));
  });
  listen(controls.scrubber, 'input', () => {
    session.replay.seek(Number(controls.scrubber.value));
  });

  const unsubscribe = session.replay.subscribe(paint);
  const unsubscribeStore = session.store.subscribe(() => paint(session.replay.snapshot()));
  let removeTick = null;
  if (viewer?.scene?.preRender?.addEventListener) {
    removeTick = viewer.scene.preRender.addEventListener(() => {
      session.replay.tick(Date.now());
    });
  }
  paint(session.replay.snapshot());

  /**
   * @param {object} state
   */
  function paint(state) {
    const replaying = !state.live;
    if (state.playing) holdContinuousRender('history-replay');
    else releaseContinuousRender('history-replay');
    if (replaying) governorRequestRender('history-replay');
    const bar = controls.bar;
    if (bar) bar.classList.toggle('is-replay', replaying);
    if (controls.liveButton) {
      controls.liveButton.classList.toggle('active', state.live);
      controls.liveButton.setAttribute('aria-pressed', String(state.live));
    }
    if (controls.playButton) {
      const empty = state.startMs == null;
      controls.playButton.disabled = empty;
      controls.playButton.textContent = state.playing ? 'PAUSE' : 'PLAY';
      controls.playButton.setAttribute(
        'aria-label',
        state.playing ? 'Pause replay' : 'Play replay',
      );
    }
    if (controls.speedSelect && controls.speedSelect.value !== String(state.speed)) {
      controls.speedSelect.value = String(state.speed);
    }
    if (controls.scrubber) {
      const empty = state.startMs == null || state.endMs == null;
      controls.scrubber.disabled = empty;
      controls.scrubber.min = empty ? '0' : String(state.startMs);
      controls.scrubber.max = empty ? '0' : String(state.endMs);
      const value = state.live ? state.endMs : state.timeMs;
      if (!empty && documentRef?.activeElement !== controls.scrubber) {
        controls.scrubber.value = String(value);
      }
    }
    if (controls.offset) {
      controls.offset.textContent = state.live ? '-00:00' : state.offsetLabel;
    }
    const label = replaying ? `REPLAY ${state.offsetLabel}` : '';
    const hudOn = documentRef
      ?.getElementById?.('intel-hud')
      ?.classList?.contains?.('active');
    readHud?.()?.setReplayBadge?.(hudOn ? label : '');
    if (controls.badge) {
      const showFixed = Boolean(label) && !hudOn;
      controls.badge.hidden = !showFixed;
      if (showFixed) controls.badge.textContent = label;
    }
    if (state.mode !== lastMode) {
      lastMode = state.mode;
      documentRef?.dispatchEvent?.(
        new CustomEvent('gev:history-replay', { detail: state.mode }),
      );
    }
  }

  return {
    /**
     * @param {number} deltaMs
     * @returns {void}
     */
    step(deltaMs) {
      session.replay.step(deltaMs);
    },
    /**
     * @returns {void}
     */
    goLive() {
      session.replay.goLive();
    },
    /**
     * @returns {void}
     */
    destroy() {
      unsubscribe();
      unsubscribeStore();
      if (removeTick) removeTick();
      persistence?.destroy();
      releaseContinuousRender('history-replay');
      for (const remove of removers.splice(0)) remove();
    },
  };
}

/**
 * @param {Document|null|undefined} documentRef
 */
function readElements(documentRef) {
  const byId = (id) => documentRef?.getElementById?.(id) || null;
  return {
    bar: byId('time-travel-bar'),
    liveButton: byId('time-travel-live'),
    playButton: byId('time-travel-play'),
    speedSelect: byId('time-travel-speed'),
    scrubber: byId('time-travel-scrubber'),
    offset: byId('time-travel-offset'),
    badge: byId('history-replay-badge'),
  };
}
