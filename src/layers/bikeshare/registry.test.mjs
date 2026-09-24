import test from 'node:test';
import assert from 'node:assert/strict';
import { CITY_RANGE_BASE_KM } from './policy.js';
import { normalizeRegistryEntry } from './registry.js';

test('a city without loadRadiusKm uses the shared city-range constant', () => {
  const entry = normalizeRegistryEntry({
    id: 'fixture-city',
    city: 'Fixture',
    centerLat: 0,
    centerLon: 0,
    stationInformationUrl: 'https://example.test/station_information.json',
    stationStatusUrl: 'https://example.test/station_status.json',
  });
  assert.equal(entry.loadRadiusKm, CITY_RANGE_BASE_KM);
  assert.equal(entry.loadRadiusKm, 100);
});
