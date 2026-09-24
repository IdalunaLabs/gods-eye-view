import {
  degreesLat,
  degreesLong,
  eciToGeodetic,
  gstime,
  propagate,
  twoline2satrec,
} from 'satellite.js';

/** ECEF x, y, z metres plus a 0/1 validity flag. */
export const PROPAGATION_STRIDE = 4;

const WGS84_EQUATORIAL_RADIUS_SQ = 6378137.0 * 6378137.0;
const WGS84_POLAR_RADIUS_SQ = 6356752.3142451793 * 6356752.3142451793;
const RADIANS_PER_DEGREE = Math.PI / 180.0;

/**
 * Float64 slots required for one catalog sample, including the trailing GMST.
 * Layout: for satellite i, `[x, y, z, valid]` at `i * PROPAGATION_STRIDE`.
 * GMST (radians) is the final element.
 * @param {number} count
 * @returns {number}
 */
export function propagationBufferLength(count) {
  return count * PROPAGATION_STRIDE + 1;
}

/**
 * Index of the GMST written by {@link propagateBatch}.
 * @param {number} count
 * @returns {number}
 */
export function propagationGmstIndex(count) {
  return count * PROPAGATION_STRIDE;
}

/**
 * Parse TLEs into satrecs aligned with the input. Invalid elements are null.
 * @param {Array<{line1?: string, line2?: string}>} tles
 * @returns {Array<object|null>}
 */
export function prepareSatrecs(tles) {
  const satrecs = new Array(tles.length);
  for (let i = 0; i < tles.length; i += 1) {
    satrecs[i] = satrecFromTle(tles[i]);
  }
  return satrecs;
}

/**
 * Geodetic sample used by the satellites layer before fleet ECEF batching.
 * @param {object|null|undefined} satrec
 * @param {Date} date
 * @returns {{longitude:number,latitude:number,altitude:number,speedMps:number|null}|null}
 */
export function propagateGeodetic(satrec, date) {
  const gmst = gstime(date);
  const sample = sampleSatellite(satrec, date, gmst);
  if (!sample) return null;
  return {
    longitude: sample.longitude,
    latitude: sample.latitude,
    altitude: sample.altitude,
    speedMps: sample.speedMps,
  };
}

/**
 * Propagate every satrec at one epoch into a preallocated ECEF buffer.
 * Valid satellites match `Cesium.Cartesian3.fromDegrees` of {@link propagateGeodetic}.
 * @param {Array<object|null|undefined>} satrecs
 * @param {number} dateMs
 * @param {Float64Array} out
 * @returns {number} GMST in radians at `dateMs`.
 */
export function propagateBatch(satrecs, dateMs, out) {
  const count = satrecs.length;
  const needed = propagationBufferLength(count);
  if (!out || out.length < needed) {
    throw new RangeError('propagation buffer is shorter than the catalog');
  }
  const date = new Date(dateMs);
  const gmst = gstime(date);
  for (let i = 0; i < count; i += 1) {
    const base = i * PROPAGATION_STRIDE;
    const sample = sampleSatellite(satrecs[i], date, gmst);
    if (
      !sample ||
      !Number.isFinite(sample.longitude) ||
      !Number.isFinite(sample.latitude) ||
      !Number.isFinite(sample.altitude)
    ) {
      out[base] = 0;
      out[base + 1] = 0;
      out[base + 2] = 0;
      out[base + 3] = 0;
      continue;
    }
    writeEcefMetres(
      sample.longitude,
      sample.latitude,
      sample.altitude,
      out,
      base,
    );
    out[base + 3] = 1;
  }
  out[propagationGmstIndex(count)] = gmst;
  return gmst;
}

/**
 * @param {{line1?: string, line2?: string}|null|undefined} tle
 * @returns {object|null}
 */
function satrecFromTle(tle) {
  try {
    const satrec = twoline2satrec(
      String(tle?.line1 || ''),
      String(tle?.line2 || ''),
    );
    return satrec && satrec.error === 0 ? satrec : null;
  } catch {
    return null;
  }
}

/**
 * @param {object|null|undefined} satrec
 * @param {Date} date
 * @param {number} gmst
 * @returns {{longitude:number,latitude:number,altitude:number,speedMps:number|null}|null}
 */
function sampleSatellite(satrec, date, gmst) {
  if (!satrec) return null;
  try {
    const posVel = propagate(satrec, date);
    if (!posVel?.position || typeof posVel.position === 'boolean') return null;
    const geo = eciToGeodetic(posVel.position, gmst);
    const velocity =
      posVel.velocity && typeof posVel.velocity !== 'boolean'
        ? posVel.velocity
        : null;
    const speedMps = velocity
      ? Math.hypot(velocity.x, velocity.y, velocity.z) * 1000
      : null;
    return {
      longitude: degreesLong(geo.longitude),
      latitude: degreesLat(geo.latitude),
      altitude: geo.height * 1000,
      speedMps: Number.isFinite(speedMps) ? speedMps : null,
    };
  } catch {
    return null;
  }
}

/**
 * WGS84 ECEF metres using the same operations as Cesium.Cartesian3.fromDegrees.
 * @param {number} longitudeDeg
 * @param {number} latitudeDeg
 * @param {number} heightM
 * @param {Float64Array} out
 * @param {number} offset
 * @returns {void}
 */
function writeEcefMetres(longitudeDeg, latitudeDeg, heightM, out, offset) {
  const longitude = longitudeDeg * RADIANS_PER_DEGREE;
  const latitude = latitudeDeg * RADIANS_PER_DEGREE;
  const height = heightM ?? 0;
  const cosLatitude = Math.cos(latitude);
  let x = cosLatitude * Math.cos(longitude);
  let y = cosLatitude * Math.sin(longitude);
  let z = Math.sin(latitude);
  const magnitude = Math.sqrt(x * x + y * y + z * z);
  x /= magnitude;
  y /= magnitude;
  z /= magnitude;
  const kx = WGS84_EQUATORIAL_RADIUS_SQ * x;
  const ky = WGS84_EQUATORIAL_RADIUS_SQ * y;
  const kz = WGS84_POLAR_RADIUS_SQ * z;
  const gamma = Math.sqrt(x * kx + y * ky + z * kz);
  out[offset] = kx / gamma + x * height;
  out[offset + 1] = ky / gamma + y * height;
  out[offset + 2] = kz / gamma + z * height;
}
