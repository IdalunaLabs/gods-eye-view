import assert from 'node:assert/strict';
import test from 'node:test';
import { haversineKm } from './geo.js';
import { createSpatialIndex } from './spatialIndex.js';

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function byDistance(a, b) {
  return a.distanceKm - b.distanceKm || String(a.id).localeCompare(String(b.id));
}

function bruteRadius(points, lat, lon, km) {
  return points
    .map((point) => ({
      id: point.id,
      distanceKm: haversineKm(lat, lon, point.lat, point.lon),
    }))
    .filter((point) => point.distanceKm <= km)
    .sort(byDistance)
    .map((point) => point.id);
}

function bruteNearest(points, lat, lon, k) {
  return points
    .map((point) => ({
      id: point.id,
      distanceKm: haversineKm(lat, lon, point.lat, point.lon),
    }))
    .sort(byDistance)
    .slice(0, k)
    .map((point) => point.id);
}

function bruteBbox(points, box) {
  const wraps = box.west > box.east;
  return points
    .filter((point) => {
      if (point.lat < box.south || point.lat > box.north) return false;
      if (wraps) return point.lon >= box.west || point.lon <= box.east;
      return point.lon >= box.west && point.lon <= box.east;
    })
    .map((point) => point.id)
    .sort();
}

test('spatial index matches brute force for radius, bbox, and nearest on 10k points', () => {
  const random = mulberry32(0x5eed);
  const points = [];
  for (let i = 0; i < 10000; i += 1) {
    points.push({
      id: `p${String(i).padStart(5, '0')}`,
      lat: random() * 180 - 90,
      lon: random() * 360 - 180,
    });
  }
  points.push({ id: 'pole-n', lat: 90, lon: 12 });
  points.push({ id: 'pole-s', lat: -90, lon: -40 });
  points.push({ id: 'meridian-w', lat: 5, lon: 179.8 });
  points.push({ id: 'meridian-e', lat: 5.1, lon: -179.7 });
  const index = createSpatialIndex({ cellDegrees: 1 });
  for (const point of points) index.insert(point.id, point.lat, point.lon);
  assert.equal(index.size, points.length);

  const probes = [0, 17, 250, 4000, 9999].map((ordinal) => points[ordinal]);
  probes.push({ lat: 90, lon: 12 }, { lat: 5, lon: 180 }, { lat: -89.5, lon: -40 });
  for (const probe of probes) {
    for (const km of [25, 80, 250]) {
      const expected = bruteRadius(points, probe.lat, probe.lon, km);
      const got = index.queryRadiusKm(probe.lat, probe.lon, km).map((hit) => hit.id);
      assert.deepEqual(got, expected, `radius ${km} at ${probe.lat},${probe.lon}`);
    }
    assert.deepEqual(
      index.nearestK(probe.lat, probe.lon, 7).map((hit) => hit.id),
      bruteNearest(points, probe.lat, probe.lon, 7),
    );
  }

  const boxes = [
    { west: -10, south: -10, east: 10, north: 10 },
    { west: 170, south: -20, east: -170, north: 20 },
    { west: -180, south: 80, east: 180, north: 90 },
  ];
  for (const box of boxes) {
    assert.deepEqual(
      index.queryBbox(box).map((hit) => hit.id),
      bruteBbox(points, box),
    );
  }
});

test('spatial index updates, removes, and rejects non-finite coordinates', () => {
  const index = createSpatialIndex({ cellDegrees: 2 });
  assert.equal(index.insert('a', Number.NaN, 1), false);
  assert.equal(index.insert('a', 10, 20), true);
  assert.equal(index.update('missing', 1, 2), false);
  assert.equal(index.update('a', 12, 22), true);
  assert.equal(index.queryRadiusKm(12, 22, 1)[0].id, 'a');
  assert.equal(index.remove('a'), true);
  assert.equal(index.remove('a'), false);
  assert.equal(index.size, 0);
  index.insert('b', 1, 1);
  index.clear();
  assert.equal(index.size, 0);
  assert.deepEqual(index.queryRadiusKm(1, 1, 10), []);
  assert.deepEqual(index.nearestK(1, 1, 0), []);
});

test('spatial index finds neighbours across the antimeridian and at the poles', () => {
  const index = createSpatialIndex({ cellDegrees: 1 });
  index.insert('west', 0, 179.9);
  index.insert('east', 0, -179.9);
  index.insert('far', 0, 0);
  const across = index.queryRadiusKm(0, 180, 40).map((hit) => hit.id);
  assert.deepEqual(across, ['east', 'west']);
  index.insert('north', 90, 10);
  index.insert('near-north', 89.6, 10);
  const polar = index.queryRadiusKm(90, 10, 50).map((hit) => hit.id);
  assert.ok(polar.includes('north'));
  assert.ok(polar.includes('near-north'));
  assert.ok(!polar.includes('far'));
});

test('spatial index times 10k inserts and 1k radius queries', () => {
  const random = mulberry32(0xc0ffee);
  const points = [];
  for (let i = 0; i < 10000; i += 1) {
    points.push({
      id: i,
      lat: random() * 160 - 80,
      lon: random() * 360 - 180,
    });
  }
  const index = createSpatialIndex({ cellDegrees: 1, capacity: 256 });
  const insertStart = performance.now();
  for (const point of points) index.insert(point.id, point.lat, point.lon);
  const insertMs = performance.now() - insertStart;
  const queryStart = performance.now();
  let hits = 0;
  for (let i = 0; i < 1000; i += 1) {
    const point = points[(i * 17) % points.length];
    hits += index.queryRadiusKm(point.lat, point.lon, 50).length;
  }
  const queryMs = performance.now() - queryStart;
  console.log(
    `spatialIndex perf: 10k insert ${insertMs.toFixed(1)} ms; 1k radius queries ${queryMs.toFixed(1)} ms; hits ${hits}`,
  );
  assert.equal(index.size, 10000);
  assert.ok(insertMs < 2000, `insert took ${insertMs} ms`);
  assert.ok(queryMs < 8000, `queries took ${queryMs} ms`);
  assert.ok(hits > 0);
});
