import { clampConfidence, haversineKm } from '../geo.js';

/**
 * Airborne aircraft whose recent positions stay inside a small radius.
 *
 * The last `samples` positions (default 8) must all lie within `radiusKm`
 * (default 3) of their centroid, and ground speed must exceed `minSpeedMps`
 * (default 40). On-ground contacts are skipped. The positions are the layer
 * track when one is attached, otherwise the engine's per-id ring sampled at
 * the fusion cadence. A tight cluster of fixes is not a holding clearance
 * and not a claim about intent.
 */
export const LOITER_DEFAULTS = Object.freeze({
  samples: 8,
  radiusKm: 3,
  minSpeedMps: 40,
  maxAlerts: 50,
});

/**
 * @param {object} snapshot
 * @param {object} [options]
 * @returns {object[]}
 */
export function detectLoiter(snapshot, options = {}) {
  const settings = { ...LOITER_DEFAULTS, ...options };
  const nowMs = Number.isFinite(snapshot?.nowMs) ? snapshot.nowMs : 0;
  const need = Math.max(3, Math.floor(settings.samples) || 8);
  const alerts = [];
  for (const craft of snapshot?.aircraft || []) {
    if (!craft || craft.onGround === true) continue;
    if (!Number.isFinite(craft.lat) || !Number.isFinite(craft.lon)) continue;
    if (
      !Number.isFinite(craft.speedMps) ||
      craft.speedMps <= settings.minSpeedMps
    ) {
      continue;
    }
    const track = Array.isArray(craft.positions)
      ? craft.positions
      : Array.isArray(craft.track)
        ? craft.track
        : [];
    const points = track
      .filter(
        (point) => Number.isFinite(point?.lat) && Number.isFinite(point?.lon),
      )
      .slice(-need);
    if (points.length < need) continue;
    let latSum = 0;
    let lonSum = 0;
    for (const point of points) {
      latSum += point.lat;
      lonSum += point.lon;
    }
    const centroid = {
      lat: latSum / points.length,
      lon: lonSum / points.length,
    };
    let farthest = 0;
    let inside = true;
    for (const point of points) {
      const distance = haversineKm(
        centroid.lat,
        centroid.lon,
        point.lat,
        point.lon,
      );
      if (distance > farthest) farthest = distance;
      if (distance > settings.radiusKm) {
        inside = false;
        break;
      }
    }
    if (!inside) continue;
    const tightness = farthest <= settings.radiusKm * 0.6 ? 0.15 : 0;
    alerts.push({
      id: `loiter:${craft.layer}:${craft.id}`,
      kind: 'loiter',
      severity: 'info',
      entities: [
        {
          layer: craft.layer,
          id: String(craft.id),
          label: craft.label || String(craft.id),
        },
      ],
      position: { lat: craft.lat, lon: craft.lon },
      explanation:
        `The last ${need} positions all lie within ${settings.radiusKm} km of their centroid ` +
        `(farthest ${farthest.toFixed(1)} km) while airborne at ${Math.round(craft.speedMps)} m/s. ` +
        'This is a geometric cluster of reported fixes, not a determination that the aircraft is intentionally loitering, and not a holding clearance. ' +
        'When the layer has no track, positions are the fusion sampler, not the full trail.',
      confidence: clampConfidence(0.5 + tightness),
      firstSeenMs: nowMs,
      lastSeenMs: nowMs,
    });
    if (alerts.length >= settings.maxAlerts) break;
  }
  return alerts;
}
