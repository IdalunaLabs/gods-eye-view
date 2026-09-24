/** Spherical Earth radius used by the shared great-circle helpers, in kilometres. */
export const EARTH_RADIUS_KM = 6371;

const DEG = Math.PI / 180;

/**
 * @param {number} degrees
 * @returns {number}
 */
function toRad(degrees) {
  return degrees * DEG;
}

/**
 * Great-circle distance in kilometres. Arguments are latitude then longitude.
 * @param {number} latA
 * @param {number} lonA
 * @param {number} latB
 * @param {number} lonB
 * @returns {number}
 */
export function haversineKm(latA, lonA, latB, lonB) {
  const dLat = toRad(latB - latA);
  const dLon = toRad(lonB - lonA);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(latA)) * Math.cos(toRad(latB)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Great-circle distance in metres.
 * @param {number} latA
 * @param {number} lonA
 * @param {number} latB
 * @param {number} lonB
 * @returns {number}
 */
export function haversineMeters(latA, lonA, latB, lonB) {
  return haversineKm(latA, lonA, latB, lonB) * 1000;
}

/**
 * Initial great-circle bearing in degrees clockwise from north, in [0, 360).
 * @param {number} latA
 * @param {number} lonA
 * @param {number} latB
 * @param {number} lonB
 * @returns {number}
 */
export function initialBearingDeg(latA, lonA, latB, lonB) {
  const lat1 = toRad(latA);
  const lat2 = toRad(latB);
  const dLon = toRad(lonB - lonA);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (((Math.atan2(y, x) / DEG) % 360) + 360) % 360;
}

/**
 * Point reached by travelling `distanceKm` from `lat`/`lon` on the initial bearing.
 * @param {number} lat
 * @param {number} lon
 * @param {number} bearingDeg Clockwise from north.
 * @param {number} distanceKm
 * @returns {{ lat: number, lon: number }}
 */
export function destinationPoint(lat, lon, bearingDeg, distanceKm) {
  const angular = distanceKm / EARTH_RADIUS_KM;
  const bearing = toRad(bearingDeg);
  const lat1 = toRad(lat);
  const lon1 = toRad(lon);
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angular) +
      Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing),
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
      Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2),
    );
  return {
    lat: lat2 / DEG,
    lon: ((lon2 / DEG + 540) % 360) - 180,
  };
}
