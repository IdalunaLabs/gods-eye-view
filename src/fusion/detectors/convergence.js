import {
  clampConfidence,
  haversineKm,
  headingVelocity,
  KNOTS_TO_MPS,
  localMetres,
} from '../geo.js';
import { createSpatialIndex } from '../spatialIndex.js';

/**
 * Aircraft–aircraft and aircraft–vessel closure.
 *
 * Dead reckoning is constant heading and speed on a local tangent plane for
 * the next `horizonMin` minutes (default 10). A pair alerts only when the
 * closest approach in that window is under `thresholdKm` (default 2) and the
 * tracks are still closing.
 *
 * Skipped contacts: aircraft on the ground or slower than 15 m/s, and vessels
 * slower than 0.5 kt or whose AIS navigational status matches anchored, moored,
 * or aground. A missing heading or course is also skipped — there is nothing
 * to project.
 *
 * Terminal-area heuristic: two aircraft both below 914 m (about 3,000 ft)
 * whose current separation is under 15 km are skipped. Arrival and departure
 * streams routinely pass inside the closure gate there. This is not an airport
 * boundary and it is not an ATC intent check.
 *
 * Vertical gate: when both aircraft have altitudes and they differ by more
 * than 610 m (about 2,000 ft), the pair is skipped. A horizontal miss at that
 * separation is not a closure of the two tracks. If either altitude is missing
 * the gate is not applied, and the explanation says so.
 */
export const CONVERGENCE_DEFAULTS = Object.freeze({
  horizonMin: 10,
  thresholdKm: 2,
  minAircraftSpeedMps: 15,
  minVesselSpeedKts: 0.5,
  terminalAltitudeM: 914,
  terminalSeparationKm: 15,
  verticalSeparationM: 610,
  maxAlerts: 50,
});

const MOORED = /anchor|moor|aground/i;

/**
 * @param {object} craft
 * @param {object} options
 * @returns {boolean}
 */
function parkedAircraft(craft, options) {
  if (!craft) return true;
  if (craft.onGround === true) return true;
  if (!Number.isFinite(craft.lat) || !Number.isFinite(craft.lon)) return true;
  if (
    !Number.isFinite(craft.speedMps) ||
    craft.speedMps < options.minAircraftSpeedMps
  ) {
    return true;
  }
  if (!Number.isFinite(craft.headingDeg)) return true;
  return false;
}

/**
 * @param {object} vessel
 * @param {object} options
 * @returns {boolean}
 */
function parkedVessel(vessel, options) {
  if (!vessel) return true;
  if (!Number.isFinite(vessel.lat) || !Number.isFinite(vessel.lon)) return true;
  if (MOORED.test(String(vessel.navStatus || ''))) return true;
  if (
    !Number.isFinite(vessel.speedKts) ||
    vessel.speedKts < options.minVesselSpeedKts
  ) {
    return true;
  }
  const heading = Number.isFinite(vessel.headingDeg)
    ? vessel.headingDeg
    : vessel.courseDeg;
  if (!Number.isFinite(heading)) return true;
  return false;
}

/**
 * Constant-velocity closest approach on a local east/north plane.
 * @param {object} a
 * @param {object} b
 * @param {number} speedBMps
 * @param {number} headingB
 * @param {number} horizonSec
 * @returns {{tSec: number, distanceKm: number, lat: number, lon: number}|null}
 */
export function horizontalCpa(a, b, speedBMps, headingB, horizonSec) {
  const originLat = a.lat;
  const originLon = a.lon;
  const pb = localMetres(b.lat, b.lon, originLat, originLon);
  const va = headingVelocity(a.speedMps, a.headingDeg);
  const vb = headingVelocity(speedBMps, headingB);
  const re = pb.east;
  const rn = pb.north;
  const ve = vb.east - va.east;
  const vn = vb.north - va.north;
  const vv = ve * ve + vn * vn;
  if (vv < 0.25) return null;
  const tSec = -(re * ve + rn * vn) / vv;
  if (!(tSec > 0) || tSec > horizonSec) return null;
  const ce = re + ve * tSec;
  const cn = rn + vn * tSec;
  const distanceKm = Math.hypot(ce, cn) / 1000;
  const lat = originLat + (va.north * tSec) / pb.metresPerDegLat;
  const lon = originLon + (va.east * tSec) / pb.metresPerDegLon;
  return { tSec, distanceKm, lat, lon };
}

function entityKey(entity) {
  return `${entity.layer}:${entity.id}`;
}

function pairId(a, b) {
  const keys = [entityKey(a), entityKey(b)].sort();
  return `convergence:${keys[0]}:${keys[1]}`;
}

/**
 * @param {object} snapshot
 * @param {object} [options]
 * @returns {object[]}
 */
export function detectConvergence(snapshot, options = {}) {
  const settings = { ...CONVERGENCE_DEFAULTS, ...options };
  const nowMs = Number.isFinite(snapshot?.nowMs) ? snapshot.nowMs : 0;
  const horizonSec = Math.max(1, settings.horizonMin) * 60;
  const aircraft = (snapshot?.aircraft || []).filter(
    (craft) => !parkedAircraft(craft, settings),
  );
  const vessels = (snapshot?.vessels || []).filter(
    (vessel) => vessel.reporting !== false && !parkedVessel(vessel, settings),
  );
  if (!aircraft.length) return [];

  const index = createSpatialIndex({ cellDegrees: 1 });
  const contacts = new Map();
  for (const craft of aircraft) {
    const key = entityKey(craft);
    contacts.set(key, { kind: 'aircraft', body: craft });
    index.insert(key, craft.lat, craft.lon);
  }
  for (const vessel of vessels) {
    const key = entityKey({ layer: 'ais-live-vessels', id: vessel.id });
    contacts.set(key, { kind: 'vessel', body: vessel });
    index.insert(key, vessel.lat, vessel.lon);
  }

  const alerts = [];
  const seen = new Set();
  for (const craft of aircraft) {
    const self = entityKey(craft);
    const searchKm =
      settings.thresholdKm + ((craft.speedMps + 300) * horizonSec) / 1000;
    const nearby = index.queryRadiusKm(craft.lat, craft.lon, searchKm);
    for (const hit of nearby) {
      if (hit.id === self) continue;
      const other = contacts.get(hit.id);
      if (!other) continue;
      const pairKey = [self, hit.id].sort().join('|');
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);
      const alert =
        other.kind === 'aircraft'
          ? aircraftPair(craft, other.body, settings, horizonSec, nowMs)
          : vesselPair(craft, other.body, settings, horizonSec, nowMs);
      if (alert) alerts.push(alert);
    }
  }
  alerts.sort(
    (a, b) =>
      a.cpaKm - b.cpaKm ||
      a.tSec - b.tSec ||
      String(a.id).localeCompare(String(b.id)),
  );
  return alerts
    .slice(0, settings.maxAlerts)
    .map(({ cpaKm, tSec, ...alert }) => {
      void cpaKm;
      void tSec;
      return alert;
    });
}

function aircraftPair(a, b, settings, horizonSec, nowMs) {
  const currentKm = haversineKm(a.lat, a.lon, b.lat, b.lon);
  if (
    Number.isFinite(a.altitudeM) &&
    Number.isFinite(b.altitudeM) &&
    a.altitudeM < settings.terminalAltitudeM &&
    b.altitudeM < settings.terminalAltitudeM &&
    currentKm < settings.terminalSeparationKm
  ) {
    return null;
  }
  const altitudesKnown =
    Number.isFinite(a.altitudeM) && Number.isFinite(b.altitudeM);
  if (
    altitudesKnown &&
    Math.abs(a.altitudeM - b.altitudeM) > settings.verticalSeparationM
  ) {
    return null;
  }
  const cpa = horizontalCpa(a, b, b.speedMps, b.headingDeg, horizonSec);
  if (!cpa || cpa.distanceKm > settings.thresholdKm) return null;
  return finishPair(a, b, cpa, settings, nowMs, altitudesKnown, 'aircraft');
}

function vesselPair(craft, vessel, settings, horizonSec, nowMs) {
  const heading = Number.isFinite(vessel.headingDeg)
    ? vessel.headingDeg
    : vessel.courseDeg;
  const cpa = horizontalCpa(
    craft,
    vessel,
    vessel.speedKts * KNOTS_TO_MPS,
    heading,
    horizonSec,
  );
  if (!cpa || cpa.distanceKm > settings.thresholdKm) return null;
  const vesselEntity = {
    layer: 'ais-live-vessels',
    id: vessel.id,
    label: vessel.label || vessel.id,
    lat: vessel.lat,
    lon: vessel.lon,
  };
  return finishPair(
    craft,
    vesselEntity,
    cpa,
    settings,
    nowMs,
    Number.isFinite(craft.altitudeM),
    'vessel',
  );
}

function finishPair(a, b, cpa, settings, nowMs, altitudeKnown, otherKind) {
  const minutes = cpa.tSec / 60;
  const vertical = altitudeKnown
    ? otherKind === 'aircraft'
      ? ` Vertical separation now is ${Math.round(Math.abs(a.altitudeM - b.altitudeM))} m.`
      : ` Aircraft altitude is ${Math.round(a.altitudeM)} m; the vessel is on the surface, so this is a horizontal closure only.`
    : ' Altitude was missing, so vertical separation was not applied.';
  const severity = cpa.distanceKm < 0.5 || cpa.tSec < 120 ? 'warn' : 'watch';
  const confidence = clampConfidence(
    0.55 +
      (cpa.tSec < settings.horizonMin * 30 ? 0.1 : 0) +
      (altitudeKnown ? 0.1 : 0),
  );
  return {
    id: pairId(a, { layer: b.layer, id: b.id }),
    kind: 'convergence',
    severity,
    entities: [
      { layer: a.layer, id: String(a.id), label: a.label || String(a.id) },
      { layer: b.layer, id: String(b.id), label: b.label || String(b.id) },
    ],
    position: { lat: cpa.lat, lon: cpa.lon },
    explanation:
      `Dead-reckoned closest approach is ${cpa.distanceKm.toFixed(1)} km in ${minutes.toFixed(1)} min, inside a ${settings.horizonMin} min / ${settings.thresholdKm} km gate. ` +
      'Projected from the latest heading and speed on a local flat plane; not a prediction of intent, an ATC clearance, or a collision warning.' +
      vertical,
    confidence,
    firstSeenMs: nowMs,
    lastSeenMs: nowMs,
    cpaKm: cpa.distanceKm,
    tSec: cpa.tSec,
  };
}
