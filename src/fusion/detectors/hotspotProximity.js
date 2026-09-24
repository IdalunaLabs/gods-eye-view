import { clampConfidence, haversineKm } from '../geo.js';
import { createSpatialIndex } from '../spatialIndex.js';

/**
 * Airborne aircraft near a FIRMS cluster or a recent strong earthquake.
 *
 * A FIRMS cluster is a connected group of at least `minCluster` detections
 * (default 3) joined when each step is within `clusterKm` (default 5). An
 * aircraft within `radiusKm` (default 15) of any member alerts. Earthquakes
 * alert when magnitude is at least `minMagnitude` (default 5) and `timeMs`
 * falls inside the last hour. On-ground aircraft are skipped. An earthquake
 * with no origin time is skipped because recency cannot be shown.
 *
 * Proximity is geometric over the loaded snapshot. It is not a fire-behavior
 * model, a damage assessment, or a claim that the aircraft is responding.
 */
export const HOTSPOT_DEFAULTS = Object.freeze({
  radiusKm: 15,
  minCluster: 3,
  clusterKm: 5,
  minMagnitude: 5,
  quakeWindowMs: 60 * 60 * 1000,
  maxAlerts: 50,
});

/**
 * @param {Array<{id: string, lat: number, lon: number}>} points
 * @param {number} radiusKm
 * @param {number} minCount
 * @returns {object[][]}
 */
function clusterPoints(points, radiusKm, minCount) {
  const index = createSpatialIndex({ cellDegrees: 0.5 });
  points.forEach((point, ordinal) => {
    index.insert(ordinal, point.lat, point.lon);
  });
  const seen = new Set();
  const groups = [];
  for (let start = 0; start < points.length; start += 1) {
    if (seen.has(start)) continue;
    const queue = [start];
    seen.add(start);
    const members = [];
    while (queue.length) {
      const current = queue.pop();
      members.push(points[current]);
      const near = index.queryRadiusKm(
        points[current].lat,
        points[current].lon,
        radiusKm,
      );
      for (const hit of near) {
        if (seen.has(hit.id)) continue;
        seen.add(hit.id);
        queue.push(hit.id);
      }
    }
    if (members.length >= minCount) groups.push(members);
  }
  return groups;
}

function aircraftList(snapshot) {
  return (snapshot?.aircraft || []).filter(
    (craft) =>
      craft &&
      craft.onGround !== true &&
      Number.isFinite(craft.lat) &&
      Number.isFinite(craft.lon),
  );
}

/**
 * @param {object} snapshot
 * @param {object} [options]
 * @returns {object[]}
 */
export function detectHotspotProximity(snapshot, options = {}) {
  const settings = { ...HOTSPOT_DEFAULTS, ...options };
  const nowMs = Number.isFinite(snapshot?.nowMs) ? snapshot.nowMs : 0;
  const aircraft = aircraftList(snapshot);
  if (!aircraft.length) return [];
  const alerts = [];

  const firms = (snapshot?.firms || []).filter(
    (fire) =>
      Number.isFinite(fire?.lat) &&
      Number.isFinite(fire?.lon) &&
      fire.id != null,
  );
  const groups = clusterPoints(firms, settings.clusterKm, settings.minCluster);
  for (const craft of aircraft) {
    for (const members of groups) {
      let nearest = Infinity;
      for (const member of members) {
        const distance = haversineKm(
          craft.lat,
          craft.lon,
          member.lat,
          member.lon,
        );
        if (distance < nearest) nearest = distance;
      }
      if (nearest > settings.radiusKm) continue;
      const clusterKey = members
        .map((member) => String(member.id))
        .sort()
        .slice(0, 8)
        .join(',');
      alerts.push({
        id: `hotspot:firms:${craft.layer}:${craft.id}:${clusterKey}`,
        kind: 'hotspot-proximity',
        severity: nearest < 5 ? 'warn' : 'watch',
        entities: [
          {
            layer: craft.layer,
            id: String(craft.id),
            label: craft.label || String(craft.id),
          },
          ...members.slice(0, 3).map((member) => ({
            layer: 'local-firms',
            id: String(member.id),
            label: String(member.id),
          })),
        ],
        position: { lat: craft.lat, lon: craft.lon },
        explanation:
          `Aircraft is ${nearest.toFixed(1)} km from a FIRMS cluster of ${members.length} detections ` +
          `linked within ${settings.clusterKm} km. Proximity is geometric over the current loaded snapshot; ` +
          'it is not a fire-behavior model or a statement that the aircraft is responding. ' +
          `The firms layer's own trailing window and analyst cap bound which detections are visible.`,
        confidence: clampConfidence(nearest < 5 ? 0.7 : 0.58),
        firstSeenMs: nowMs,
        lastSeenMs: nowMs,
        distanceKm: nearest,
      });
    }
  }

  const quakes = (snapshot?.earthquakes || []).filter((quake) => {
    if (!Number.isFinite(quake?.lat) || !Number.isFinite(quake?.lon))
      return false;
    if (
      !Number.isFinite(quake.magnitude) ||
      quake.magnitude < settings.minMagnitude
    ) {
      return false;
    }
    if (!Number.isFinite(quake.timeMs)) return false;
    const age = nowMs - quake.timeMs;
    return age >= 0 && age <= settings.quakeWindowMs;
  });
  for (const craft of aircraft) {
    for (const quake of quakes) {
      const distance = haversineKm(craft.lat, craft.lon, quake.lat, quake.lon);
      if (distance > settings.radiusKm) continue;
      const ageMin = Math.max(0, Math.round((nowMs - quake.timeMs) / 60000));
      alerts.push({
        id: `hotspot:quake:${craft.layer}:${craft.id}:${quake.id}`,
        kind: 'hotspot-proximity',
        severity: quake.magnitude >= 6.5 || distance < 5 ? 'warn' : 'watch',
        entities: [
          {
            layer: craft.layer,
            id: String(craft.id),
            label: craft.label || String(craft.id),
          },
          {
            layer: 'earthquakes',
            id: String(quake.id),
            label: quake.label || quake.place || String(quake.id),
          },
        ],
        position: { lat: craft.lat, lon: craft.lon },
        explanation:
          `Aircraft is ${distance.toFixed(1)} km from M${Number(quake.magnitude).toFixed(1)} ` +
          `${quake.label || quake.place || 'earthquake'}, origin ${ageMin} min ago. ` +
          `Only events at or above M${settings.minMagnitude} in the last hour are considered. ` +
          'Proximity is geometric; it is not a damage, shaking, or routing assessment.',
        confidence: clampConfidence(0.66),
        firstSeenMs: nowMs,
        lastSeenMs: nowMs,
        distanceKm: distance,
      });
    }
  }

  alerts.sort(
    (a, b) =>
      a.distanceKm - b.distanceKm || String(a.id).localeCompare(String(b.id)),
  );
  return alerts.slice(0, settings.maxAlerts).map(({ distanceKm, ...alert }) => {
    void distanceKm;
    return alert;
  });
}
