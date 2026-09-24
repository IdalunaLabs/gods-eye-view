import assert from 'node:assert/strict';
import test from 'node:test';
import { createHistoryQuery } from './historyQuery.js';
import {
  createHistoryPersistence,
  createIndexedDbHistoryStorage,
  createMemoryHistoryStorage,
} from './historyPersistence.js';
import { createHistoryStore } from './historyStore.js';

test('a memory storage fake round-trips snapshots inside the same caps', async () => {
  const storage = createMemoryHistoryStorage();
  const queued = [];
  const store = createHistoryStore();
  const persistence = createHistoryPersistence({
    store,
    storage,
    throttleMs: 1000,
    schedule(callback) {
      queued.push(callback);
      return queued.length;
    },
    cancel() {},
  });
  store.append(
    'flights',
    [{ id: 'A', lat: 1, lon: 2, alt: 3, heading: 4, speed: 5, callsign: 'UA1' }],
    1000,
  );
  store.append(
    'vessels',
    [{ id: 'B', lat: 10, lon: 20, alt: 0, heading: 90, speed: 1, name: 'SHIP' }],
    2000,
  );
  assert.equal(queued.length, 1);
  queued[0]();
  await persistence.flush();
  persistence.destroy();

  const restored = createHistoryStore();
  const loader = createHistoryPersistence({
    store: restored,
    storage,
    schedule() {
      return 0;
    },
  });
  assert.equal(await loader.load(), true);
  loader.destroy();
  assert.equal(restored.range('flights').count, 1);
  assert.equal(restored.range('vessels').startMs, 2000);
  const sample = createHistoryQuery(restored).sampleAt('flights', 1000);
  assert.equal(sample.ids[0], 'A');
  assert.equal(sample.lat[0], 1);
  assert.equal(restored.metadata('A').callsign, 'UA1');
  assert.equal(restored.metadata('B').name, 'SHIP');
});

test('IndexedDB storage is absent when the platform has no factory', () => {
  assert.equal(createIndexedDbHistoryStorage({ idb: null }), null);
  assert.equal(createIndexedDbHistoryStorage({ idb: {} }), null);
});
