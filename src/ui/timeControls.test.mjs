import assert from 'node:assert/strict';
import test from 'node:test';
import { createHistorySession } from '../history/session.js';
import { _resetRenderGovernorForTest } from '../renderGovernor.js';
import { bindApplicationShortcuts } from './applicationShortcuts.js';
import { bindTimeControls } from './timeControls.js';

function controlNode(tag = 'button') {
  const node = new EventTarget();
  node.tagName = tag.toUpperCase();
  node.disabled = false;
  node.hidden = true;
  node.value = '1';
  node.textContent = '';
  node.classList = {
    toggle(name, on) {
      this[name] = on;
    },
  };
  node.setAttribute = () => {};
  return node;
}

function harness() {
  const session = createHistorySession();
  session.store.append('flights', [{ id: 'A', lat: 1, lon: 2 }], 0);
  session.store.append('flights', [{ id: 'A', lat: 3, lon: 4 }], 60_000);
  const elements = {
    bar: controlNode('div'),
    liveButton: controlNode(),
    playButton: controlNode(),
    speedSelect: controlNode('select'),
    scrubber: controlNode('input'),
    offset: controlNode('span'),
    badge: controlNode('div'),
  };
  const control = bindTimeControls({
    session,
    storage: null,
    documentRef: {
      activeElement: null,
      dispatchEvent() {},
    },
    elements,
  });
  return { session, elements, control };
}

test('the bar plays, scrubs, and labels replay instead of live', () => {
  const { session, elements, control } = harness();
  assert.equal(elements.offset.textContent, '-00:00');
  assert.equal(elements.badge.hidden, true);
  elements.playButton.dispatchEvent(new Event('click'));
  assert.equal(session.replay.mode, 'REPLAY_PLAYING');
  assert.equal(elements.playButton.textContent, 'PAUSE');
  assert.equal(elements.badge.hidden, false);
  assert.match(elements.badge.textContent, /^REPLAY -01:00$/);
  elements.speedSelect.value = '16';
  elements.speedSelect.dispatchEvent(new Event('change'));
  assert.equal(session.replay.speed, 16);
  elements.scrubber.value = '999999';
  elements.scrubber.dispatchEvent(new Event('input'));
  assert.equal(session.replay.timeMs, 60_000);
  control.goLive();
  assert.equal(session.replay.mode, 'LIVE');
  assert.equal(elements.badge.hidden, true);
  assert.equal(elements.liveButton.classList.active, true);
  control.destroy();
  _resetRenderGovernorForTest();
});

test('bracket keys step ten seconds and Shift+L returns to LIVE', () => {
  const { session, control } = harness();
  const listeners = new Set();
  const documentRef = {
    addEventListener(type, listener) {
      if (type === 'keydown') listeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === 'keydown') listeners.delete(listener);
    },
  };
  const shortcuts = bindApplicationShortcuts({
    documentRef,
    searchInput: controlNode('input'),
    actions: {
      setStyle() {},
      dismissSearch() {},
      toggleHud() {},
      toggleOrbit() {},
      toggleCleanView() {},
      toggleLayers() {},
      cycleDetection() {},
      toggleCctv() {},
      stepReplay: (deltaMs) => control.step(deltaMs),
      goLive: () => control.goLive(),
    },
  });
  const press = (key, extra = {}) => {
    for (const listener of listeners) {
      listener({ key, target: {}, ...extra });
    }
  };
  press('[');
  assert.equal(session.replay.mode, 'REPLAY_PAUSED');
  assert.equal(session.replay.timeMs, 50_000);
  press(']', { target: { matches: () => true } });
  assert.equal(session.replay.timeMs, 50_000);
  press(']');
  assert.equal(session.replay.timeMs, 60_000);
  press('L', { shiftKey: true });
  assert.equal(session.replay.mode, 'LIVE');
  shortcuts.destroy();
  control.destroy();
  _resetRenderGovernorForTest();
});
