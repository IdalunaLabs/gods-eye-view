import assert from 'node:assert/strict';
import test from 'node:test';
import { createHistoryStore } from './historyStore.js';
import { createHistoryQuery, lerpHeading, lerpLon } from './historyQuery.js';

function contact(id, lat, lon, alt, heading, speed) {
  return { id, lat, lon, alt, heading, speed };
}

function sample(store, query, tMs) {
  return query.sampleAt('flights', tMs);
}

test('sampleAt interpolates across the antimeridian and wraps heading', () => {
  assert.equal(lerpLon(179, -179, 0.5), 180);
  assert.equal(lerpHeading(350, 10, 0.5), 0);
  const store = createHistoryStore();
  store.append(
    'flights',
    [contact('A', 0, 179, 1000, 350, 100), contact('B', 1, 10, 0, 0, 0)],
    0,
  );
  store.append(
    'flights',
    [contact('A', 2, -179, 3000, 10, 200)],
    1000,
  );
  const query = createHistoryQuery(store);
  const mid = sample(store, query, 500);
  assert.equal(mid.count, 2);
  const a = mid.ids.indexOf('A');
  const b = mid.ids.indexOf('B');
  assert.ok(Math.abs(mid.lat[a] - 1) < 1e-4);
  assert.ok(Math.abs(mid.lon[a] - 180) < 1e-3);
  assert.ok(Math.abs(mid.alt[a] - 2000) < 1e-2);
  assert.ok(mid.heading[a] < 1e-3 || Math.abs(mid.heading[a] - 360) < 1e-3);
  assert.ok(Math.abs(mid.speed[a] - 150) < 1e-2);
  assert.equal(mid.held[a], 0);
  assert.equal(mid.held[b], 1);
  assert.equal(mid.lat[b], 1);
  assert.equal(mid.lon[b], 10);
});

test('sampleAt drops ids that are gone at an exact later snapshot and reuses buffers', () => {
  const store = createHistoryStore();
  store.append('flights', [contact('A', 0, 0, 0, 0, 0), contact('B', 5, 5, 1, 1, 1)], 0);
  store.append('flights', [contact('A', 4, 4, 4, 4, 4)], 1000);
  const query = createHistoryQuery(store);
  const between = query.sampleAt('flights', 500);
  assert.equal(between.ids.filter((_, index) => index < between.count).length, 2);
  const later = query.sampleAt('flights', 1000);
  assert.equal(later.count, 1);
  assert.equal(later.ids[0], 'A');
  assert.equal(later.held[0], 0);
  assert.equal(later, between);
  assert.equal(later.lat, between.lat);
  const outside = query.sampleAt('flights', 5000);
  assert.equal(outside.count, 1);
  assert.equal(outside.held[0], 1);
  assert.equal(outside.lat, later.lat);
});

test('an id that exists only in the later bracket is held', () => {
  const store = createHistoryStore();
  store.append('flights', [contact('A', 0, 0, 0, 0, 0)], 0);
  store.append(
    'flights',
    [contact('A', 10, 10, 10, 10, 10), contact('C', 3, 4, 5, 6, 7)],
    1000,
  );
  const mid = createHistoryQuery(store).sampleAt('flights', 250);
  const c = mid.ids.indexOf('C');
  assert.equal(mid.held[c], 1);
  assert.equal(mid.lat[c], 3);
  assert.equal(mid.lon[c], 4);
});
