import assert from 'node:assert/strict';
import test from 'node:test';
import { createHistoryStore } from './historyStore.js';
import {
  createReplayController,
  formatReplayOffset,
} from './replayController.js';

function clockedStore() {
  const store = createHistoryStore();
  store.append('flights', [{ id: 'A', lat: 0, lon: 0 }], 0);
  store.append('flights', [{ id: 'A', lat: 1, lon: 1 }], 10_000);
  store.append('vessels', [{ id: 'B', lat: 2, lon: 2 }], 4_000);
  return store;
}

test('seek clamps, speed is limited, and LIVE returns the clock', () => {
  const replay = createReplayController({
    store: clockedStore(),
    now: () => 0,
  });
  assert.equal(replay.mode, 'LIVE');
  assert.equal(replay.seek(-50).timeMs, 0);
  assert.equal(replay.mode, 'REPLAY_PAUSED');
  assert.equal(replay.seek(50_000).timeMs, 10_000);
  assert.equal(replay.setSpeed(4).speed, 4);
  assert.equal(replay.setSpeed(3).speed, 4);
  replay.play();
  assert.equal(replay.mode, 'REPLAY_PLAYING');
  assert.equal(replay.timeMs, 0);
  const played = replay.tick(1000);
  assert.equal(played.timeMs, 4000);
  assert.equal(played.speed, 4);
  assert.equal(replay.goLive().mode, 'LIVE');
  assert.equal(replay.timeMs, null);
  assert.equal(replay.tick(9000).mode, 'LIVE');
});

test('playback pauses at the live edge and steps ten seconds from LIVE', () => {
  const replay = createReplayController({
    store: clockedStore(),
    now: () => 0,
  });
  replay.setSpeed(16);
  replay.play();
  const ended = replay.tick(1000);
  assert.equal(ended.mode, 'REPLAY_PAUSED');
  assert.equal(ended.timeMs, 10_000);
  replay.goLive();
  const stepped = replay.step(-10_000);
  assert.equal(stepped.mode, 'REPLAY_PAUSED');
  assert.equal(stepped.timeMs, 0);
  assert.equal(formatReplayOffset(stepped.offsetMs), '-00:10');
  assert.equal(formatReplayOffset(-12 * 60 * 1000 - 34 * 1000), '-12:34');
});
