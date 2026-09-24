// @ts-check
import { normalizeEarthquakeSnapshot } from './records.js';
const API_URL =
  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson';
/** Request and validate a complete USGS snapshot before it can replace displayed events. */
export function createUsgsEarthquakeSource({
  fetchImpl = globalThis.fetch,
} = {}) {
  return {
    async getSnapshot(
      { signal } = /** @type {{ signal?: AbortSignal }} */ ({}),
    ) {
      signal?.throwIfAborted();
      const response = await fetchImpl(API_URL, { signal });
      if (!response.ok) throw new Error(`USGS HTTP ${response.status}`);
      const payload = await response.json();
      signal?.throwIfAborted();
      const rows = normalizeEarthquakeSnapshot(payload);
      if (!rows) throw new Error('Malformed USGS response');
      return rows;
    },
  };
}
