/** Shared spherical helpers for the portable fusion graph. */

const EARTH_R_KM = 6371.0088;

/** Metres per degree of latitude on the WGS84 meridional approximation. */
export const METRES_PER_DEG_LAT = 111132.92;

/** Knots to metres per second. */
export const KNOTS_TO_MPS = 0.514444;

/**
 * Wrap a longitude into [-180, 180). +180 shares the antimeridian with -180.
 * @param {number} lon
 * @returns {number}
 */
export function wrapLon(lon) {
  if (!Number.isFinite(lon)) return NaN;
  let wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
  if (wrapped === 180) wrapped = -180;
  return wrapped;
}

/**
 * Clamp latitude into [-90, 90].
 * @param {number} lat
 * @returns {number}
 */
export function clampLat(lat) {
  if (!Number.isFinite(lat)) return NaN;
  return Math.max(-90, Math.min(90, lat));
}

/**
 * Great-circle distance in kilometres.
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @returns {number}
 */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const d2r = Math.PI / 180;
  const dLat = (lat2 - lat1) * d2r;
  const dLon = (wrapLon(lon2 - lon1 + 180) - 180) * d2r;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * d2r) * Math.cos(lat2 * d2r) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R_KM * Math.asin(Math.min(1, Math.sqrt(Math.max(0, a))));
}

/**
 * Local east/north metres of (lat, lon) relative to (lat0, lon0).
 * Longitude is wrapped so a pair across the antimeridian stays short.
 * @param {number} lat
 * @param {number} lon
 * @param {number} lat0
 * @param {number} lon0
 * @returns {{east: number, north: number, metresPerDegLon: number, metresPerDegLat: number}}
 */
export function localMetres(lat, lon, lat0, lon0) {
  const metresPerDegLon = Math.max(
    1e-3,
    111412.84 * Math.cos((lat0 * Math.PI) / 180),
  );
  return {
    east: wrapLon(lon - lon0) * metresPerDegLon,
    north: (lat - lat0) * METRES_PER_DEG_LAT,
    metresPerDegLon,
    metresPerDegLat: METRES_PER_DEG_LAT,
  };
}

/**
 * Horizontal velocity from a navigational heading (0° north, 90° east).
 * @param {number} speedMps
 * @param {number} headingDeg
 * @returns {{east: number, north: number}}
 */
export function headingVelocity(speedMps, headingDeg) {
  const heading = (headingDeg * Math.PI) / 180;
  return {
    east: speedMps * Math.sin(heading),
    north: speedMps * Math.cos(heading),
  };
}

/**
 * Clamp a confidence into the closed unit interval.
 * @param {number} value
 * @returns {number}
 */
export function clampConfidence(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
