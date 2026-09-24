import assert from 'node:assert/strict';
import test from 'node:test';
import { distanceKm, pointInPolygon, polygonBbox } from './geometry.js';

const SQUARE = [
  [0, 0],
  [0, 2],
  [2, 2],
  [2, 0],
];

test('pointInPolygon contains an interior point and rejects an exterior one', () => {
  assert.equal(pointInPolygon(1, 1, SQUARE), true);
  assert.equal(pointInPolygon(3, 3, SQUARE), false);
  assert.equal(pointInPolygon(1, 1, null), false);
  assert.equal(pointInPolygon(1, 1, SQUARE.slice(0, 2)), false);
});

test('pointInPolygon contains a point inside a ring that crosses the antimeridian', () => {
  const ring = [
    [0, 170],
    [0, -170],
    [2, -170],
    [2, 170],
  ];
  assert.equal(pointInPolygon(1, 175, ring), true);
  assert.equal(pointInPolygon(1, -175, ring), true);
  assert.equal(pointInPolygon(1, 0, ring), false);
});

test('polygonBbox reports antimeridian rings with west greater than east', () => {
  assert.deepEqual(polygonBbox(SQUARE), {
    south: 0,
    north: 2,
    west: 0,
    east: 2,
  });
  const ring = [
    [0, 170],
    [0, -170],
    [1, -170],
    [1, 170],
  ];
  const box = polygonBbox(ring);
  assert.equal(box.south, 0);
  assert.equal(box.north, 1);
  assert.ok(box.west > box.east);
  assert.equal(polygonBbox([]), null);
});

test('distanceKm is a haversine in kilometres', () => {
  assert.equal(distanceKm(0, 0, 0, 0), 0);
  const oneDegree = distanceKm(0, 0, 0, 1);
  assert.ok(oneDegree > 110 && oneDegree < 112, String(oneDegree));
  assert.ok(Number.isNaN(distanceKm(0, 0, Number.NaN, 1)));
});
