import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EARTH_RADIUS_KM,
  destinationPoint,
  haversineKm,
  haversineMeters,
  initialBearingDeg,
} from './greatCircle.js';

test('zero distance and symmetry', () => {
  assert.equal(haversineKm(12.5, -40.25, 12.5, -40.25), 0);
  assert.equal(haversineMeters(0, 0, 0, 0), 0);
  const forward = haversineKm(37.6, -122.4, 40.7, -74);
  const backward = haversineKm(40.7, -74, 37.6, -122.4);
  assert.ok(Math.abs(forward - backward) < 1e-9);
  assert.equal(haversineMeters(37.6, -122.4, 40.7, -74), forward * 1000);
});

test('antimeridian is the short arc', () => {
  const across = haversineKm(0, 179.5, 0, -179.5);
  const longWay = haversineKm(0, 179.5, 0, 0);
  assert.ok(across > 100 && across < 120, `short arc ${across}`);
  assert.ok(longWay > across * 10);
});

test('poles are a single point regardless of longitude', () => {
  assert.ok(haversineKm(90, 0, 90, 180) < 1e-6);
  assert.ok(haversineKm(-90, 12, -90, -170) < 1e-6);
  const quarter = haversineKm(90, 0, 0, 0);
  assert.ok(Math.abs(quarter - (EARTH_RADIUS_KM * Math.PI) / 2) < 1e-6);
});

test('bearings and destination points round-trip', () => {
  assert.ok(Math.abs(initialBearingDeg(0, 0, 1, 0)) < 1e-9);
  assert.ok(Math.abs(initialBearingDeg(0, 0, 0, 1) - 90) < 1e-6);
  const distanceKm = 250;
  const start = { lat: -33.9, lon: 151.2 };
  const bearing = 47;
  const end = destinationPoint(start.lat, start.lon, bearing, distanceKm);
  assert.ok(
    Math.abs(haversineKm(start.lat, start.lon, end.lat, end.lon) - distanceKm) <
      1e-6,
  );
  assert.ok(
    Math.abs(
      initialBearingDeg(start.lat, start.lon, end.lat, end.lon) - bearing,
    ) < 1e-6,
  );
  const wrapped = destinationPoint(0, 179, 90, 300);
  assert.ok(wrapped.lon < 0, `crossed the antimeridian, got ${wrapped.lon}`);
  assert.ok(
    Math.abs(haversineKm(0, 179, wrapped.lat, wrapped.lon) - 300) < 1e-6,
  );
});

test('the old longitude-first call order is a different distance', () => {
  const correct = haversineKm(60, 10, 61, 30);
  const previousNaturalEarthOrder = haversineKm(10, 60, 30, 61);
  assert.ok(Math.abs(correct - previousNaturalEarthOrder) > 500);
});
