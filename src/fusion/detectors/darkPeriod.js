import { clampConfidence, haversineKm } from '../geo.js';

/**
 * Vessels that stopped reporting after their last fixes showed motion.
 *
 * A contact alerts when it is absent from the current snapshot for more than
 * `silentMin` minutes (default 20) and the retained samples show motion: a
 * reported speed of at least 1 kt, or at least `minMoveKm` (default 0.3) of
 * travel between samples. AIS navigational status matching anchored, moored,
 * or aground suppresses the alert when that field is present.
 *
 * There is no shoreline model. "Open water" here means the last reports were
 * moving and not a moored/anchored status — not a charted distance from land.
 * A gap is a missing report, not evidence the vessel disabled AIS or left.
 */
export const DARK_PERIOD_DEFAULTS = Object.freeze({
  silentMin: 20,
  minSpeedKts: 1,
  minMoveKm: 0.3,
  warnAfterMin: 60,
  maxAlerts: 50,
});

const MOORED = /anchor|moor|aground/i;

/**
 * @param {object} vessel
 * @param {object} settings
 * @returns {boolean}
 */
function showedMotion(vessel, settings) {
  const samples = Array.isArray(vessel.samples) ? vessel.samples : [];
  if (
    samples.some(
      (sample) =>
        Number.isFinite(sample?.speedKts) &&
        sample.speedKts >= settings.minSpeedKts,
    )
  ) {
    return true;
  }
  if (
    Number.isFinite(vessel.speedKts) &&
    vessel.speedKts >= settings.minSpeedKts
  ) {
    return true;
  }
  const located = samples.filter(
    (sample) => Number.isFinite(sample?.lat) && Number.isFinite(sample?.lon),
  );
  if (located.length < 2) return false;
  const first = located[0];
  const last = located[located.length - 1];
  return (
    haversineKm(first.lat, first.lon, last.lat, last.lon) >= settings.minMoveKm
  );
}

/**
 * @param {object} snapshot
 * @param {object} [options]
 * @returns {object[]}
 */
export function detectDarkPeriod(snapshot, options = {}) {
  const settings = { ...DARK_PERIOD_DEFAULTS, ...options };
  const nowMs = Number.isFinite(snapshot?.nowMs) ? snapshot.nowMs : 0;
  const silentMs = Math.max(1, settings.silentMin) * 60 * 1000;
  const alerts = [];
  for (const vessel of snapshot?.vessels || []) {
    if (!vessel || vessel.reporting !== false) continue;
    if (!Number.isFinite(vessel.lastSeenMs)) continue;
    if (!Number.isFinite(vessel.lat) || !Number.isFinite(vessel.lon)) continue;
    const quiet = nowMs - vessel.lastSeenMs;
    if (quiet <= silentMs) continue;
    if (MOORED.test(String(vessel.navStatus || ''))) continue;
    if (!showedMotion(vessel, settings)) continue;
    const minutes = Math.round(quiet / 60000);
    const status = String(vessel.navStatus || '').trim();
    const statusSentence = status
      ? `Last AIS navigational status was "${status}", which is not moored, anchored, or aground. Status is the last report, not a verified condition.`
      : 'AIS navigational status was not available, so a moored or anchored vessel without status cannot be excluded.';
    alerts.push({
      id: `dark-period:${vessel.id}`,
      kind: 'dark-period',
      severity: minutes >= settings.warnAfterMin ? 'warn' : 'watch',
      entities: [
        {
          layer: 'ais-live-vessels',
          id: String(vessel.id),
          label: vessel.label || String(vessel.id),
        },
      ],
      position: { lat: vessel.lat, lon: vessel.lon },
      explanation:
        `No position report for ${minutes} min after the last fixes showed motion. ` +
        'This is a reporting gap, not confirmation the vessel went dark on purpose or left the area. ' +
        `${statusSentence} There is no shoreline check; open water is inferred only from motion and status.`,
      confidence: clampConfidence(status ? 0.62 : 0.45),
      firstSeenMs: nowMs,
      lastSeenMs: nowMs,
      quietMin: minutes,
    });
  }
  alerts.sort(
    (a, b) =>
      b.quietMin - a.quietMin || String(a.id).localeCompare(String(b.id)),
  );
  return alerts.slice(0, settings.maxAlerts).map(({ quietMin, ...alert }) => {
    void quietMin;
    return alert;
  });
}
