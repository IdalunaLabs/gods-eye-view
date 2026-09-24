import assert from 'node:assert/strict';
import test from 'node:test';
import { createHistoryStore } from './historyStore.js';

function contact(id, lat, lon, extra = {}) {
  return { id, lat, lon, alt: 100, heading: 10, speed: 20, ...extra };
}

test('snapshots evict oldest-first by count, time span, and memory', () => {
  const counted = createHistoryStore({ maxSnapshots: 2, windowMs: 60_000 });
  counted.append('flights', [contact('A', 1, 2)], 0);
  counted.append('flights', [contact('A', 1, 2)], 10);
  counted.append('flights', [contact('A', 1, 2)], 20);
  assert.equal(counted.range('flights').count, 2);
  assert.equal(counted.range('flights').startMs, 10);
  assert.equal(counted.range('flights').endMs, 20);

  const timed = createHistoryStore({ windowMs: 1000, maxSnapshots: 10 });
  timed.append('vessels', [contact('M', 3, 4)], 0);
  timed.append('vessels', [contact('M', 3, 4)], 500);
  timed.append('vessels', [contact('M', 3, 4)], 1600);
  assert.equal(timed.range('vessels').count, 1);
  assert.equal(timed.range('vessels').startMs, 1600);

  const tight = createHistoryStore({
    memoryBudgetBytes: 200,
    maxSnapshots: 10,
    windowMs: 60_000,
  });
  tight.append('flights', [contact('A', 1, 2)], 0);
  tight.append('flights', [contact('B', 3, 4)], 10);
  const stats = tight.stats();
  assert.ok(stats.bytes <= stats.memoryBudgetBytes);
  assert.equal(stats.layers.flights.count, 1);
  assert.equal(stats.layers.flights.startMs, 10);
  assert.equal(tight.metadata('A'), null);
  assert.equal(tight.metadata('B').name, '');
});

test('ids are interned once and metadata is kept per id', () => {
  const store = createHistoryStore();
  const first = String.fromCharCode(65);
  const second = ['A'].join('');
  store.append(
    'flights',
    [contact(first, 10, 20, { callsign: 'UAL1', type: 'jet' })],
    5,
  );
  store.append('flights', [contact(second, 11, 21)], 15);
  assert.equal(store.slotCount(), 1);
  assert.equal(store.slotOf(first), store.slotOf(second));
  assert.equal(store.idForSlot(store.slotOf('A')), store.canonical('A'));
  assert.equal(store.snapshots('flights')[0].ids[0], store.canonical('A'));
  assert.equal(store.snapshots('flights')[1].ids[0], store.canonical('A'));
  assert.equal(store.metadata('A').callsign, 'UAL1');
  assert.equal(store.metadata('A').type, 'jet');
});

test('the time window cannot be configured past 24 hours', () => {
  const store = createHistoryStore({ windowMs: 48 * 60 * 60 * 1000 });
  assert.equal(store.stats().windowMs, 24 * 60 * 60 * 1000);
});
