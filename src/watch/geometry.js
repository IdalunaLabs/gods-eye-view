/**
 * Portable geographic helpers for watch geofences.
 * `distanceKm` is a private haversine until `src/geo/greatCircle.js` lands on
 * this branch; switch this module to that import when it does.
 */

const EARTH_RADIUS_KM = 6371;

/**
 * Longitude unwrapped into the same 360° turn as `origin`.
 * @param {number} lon
 * @param {number} origin
 * @returns {number}
 */
function unwrapLongitude(lon, origin) {
  if (!Number.isFinite(lon) || !Number.isFinite(origin)) return NaN;
  let value = lon;
  while (value - origin > 180) value -= 360;
  while (origin - value > 180) value += 360;
  return value;
}

/**
 * Longitude wrapped into [-180, 180].
 * @param {number} lon
 * @returns {number}
 */
function wrapLongitude(lon) {
  if (!Number.isFinite(lon)) return NaN;
  let value = lon;
  while (value > 180) value -= 360;
  while (value < -180) value += 360;
  return value;
}

/**
 * Even-odd ray cast. Longitudes are unwrapped relative to the polygon's first
 * vertex so a ring that crosses the antimeridian still contains the points on
 * that ring. Holes are not supported.
 * @param {number} lat
 * @param {number} lon
 * @param {Array<[number, number]>} polygon `[lat, lon]` vertices.
 * @returns {boolean}
 */
export function pointInPolygon(lat, lon, polygon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (!Array.isArray(polygon) || polygon.length < 3) return false;
  const origin = Number(polygon[0]?.[1]);
  const x = unwrapLongitude(lon, origin);
  const y = lat;
  if (!Number.isFinite(x)) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const yi = Number(polygon[i]?.[0]);
    const xi = unwrapLongitude(Number(polygon[i]?.[1]), origin);
    const yj = Number(polygon[j]?.[0]);
    const xj = unwrapLongitude(Number(polygon[j]?.[1]), origin);
    if (![yi, xi, yj, xj].every(Number.isFinite)) continue;
    const crosses = yi > y !== yj > y;
    if (!crosses || yj === yi) continue;
    const edgeX = ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (x < edgeX) inside = !inside;
  }
  return inside;
}

/**
 * Axis-aligned bounds. `west` may be greater than `east` when the ring crosses
 * the antimeridian.
 * @param {Array<[number, number]>} polygon `[lat, lon]` vertices.
 * @returns {{south: number, north: number, west: number, east: number}|null}
 */
export function polygonBbox(polygon) {
  if (!Array.isArray(polygon) || !polygon.length) return null;
  const origin = Number(polygon[0]?.[1]);
  if (!Number.isFinite(origin)) return null;
  let south = Infinity;
  let north = -Infinity;
  let west = Infinity;
  let east = -Infinity;
  let count = 0;
  for (const pair of polygon) {
    const lat = Number(pair?.[0]);
    const lon = unwrapLongitude(Number(pair?.[1]), origin);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    south = Math.min(south, lat);
    north = Math.max(north, lat);
    west = Math.min(west, lon);
    east = Math.max(east, lon);
    count += 1;
  }
  if (!count) return null;
  return {
    south,
    north,
    west: wrapLongitude(west),
    east: wrapLongitude(east),
  };
}

/**
 * Great-circle distance in kilometres.
 * Follow-up: replace this private haversine with `src/geo/greatCircle.js` once
 * that module is on this branch.
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @returns {number}
 */
export function distanceKm(lat1, lon1, lat2, lon2) {
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return NaN;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) *
      Math.cos(lat2 * toRad) *
      Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}
