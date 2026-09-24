import { haversineKm } from './geo.js';
import { detectConvergence } from './detectors/convergence.js';
import { detectLoiter } from './detectors/loiter.js';
import { detectDarkPeriod } from './detectors/darkPeriod.js';
import { detectHotspotProximity } from './detectors/hotspotProximity.js';

/** localStorage key for detector enable flags. */
export const FUSION_DETECTOR_STORAGE_KEY = 'godsEyeView.v6.fusionDetectors';

/** Convergence and dark-period on; loiter and hotspot proximity off. */
export const DEFAULT_DETECTOR_FLAGS = Object.freeze({
  convergence: true,
  darkPeriod: true,
  loiter: false,
  hotspot: false,
});

const FLAG_NAMES = Object.keys(DEFAULT_DETECTOR_FLAGS);
const AIRCRAFT_LAYERS = ['flights', 'military'];
const TRACK_LIMIT = 8;
const VESSEL_SAMPLE_LIMIT = 8;
const VESSEL_MEMORY_MS = 6 * 60 * 60 * 1000;

/**
 * Read persisted flags. Unknown or partial JSON keeps the defaults per key.
 * @param {{getItem: Function}|null|undefined} storage
 * @returns {Record<string, boolean>}
 */
export function readDetectorFlags(storage) {
  const flags = { ...DEFAULT_DETECTOR_FLAGS };
  if (!storage || typeof storage.getItem !== 'function') return flags;
  try {
    const parsed = JSON.parse(storage.getItem(FUSION_DETECTOR_STORAGE_KEY) || '');
    if (!parsed || typeof parsed !== 'object') return flags;
    for (const name of FLAG_NAMES) {
      if (typeof parsed[name] === 'boolean') flags[name] = parsed[name];
    }
  } catch {
    /* keep defaults */
  }
  return flags;
}

function writeDetectorFlags(storage, flags) {
  if (!storage || typeof storage.setItem !== 'function') return;
  try {
    storage.setItem(FUSION_DETECTOR_STORAGE_KEY, JSON.stringify(flags));
  } catch {
    /* storage unavailable */
  }
}

function readRows(getRecords, layerKey) {
  try {
    const rows = getRecords?.(layerKey);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function asAircraft(row, layer) {
  const id = String(row?.icao24 || row?.id || '').trim();
  if (!id || !Number.isFinite(row?.lat) || !Number.isFinite(row?.lon)) return null;
  const positions = Array.isArray(row.positions)
    ? row.positions
    : Array.isArray(row.track)
      ? row.track
      : null;
  return {
    layer,
    id,
    label: row.callsign || row.id || id,
    lat: row.lat,
    lon: row.lon,
    altitudeM: row.altitudeM,
    speedMps: row.speedMps,
    headingDeg: row.heading,
    onGround: row.onGround === true,
    positions,
  };
}

function asVessel(row) {
  const id = String(row?.mmsi || row?.id || '').trim();
  if (!id || !Number.isFinite(row?.lat) || !Number.isFinite(row?.lon)) return null;
  return {
    layer: 'ais-live-vessels',
    id,
    label: row.name || row.id || id,
    lat: row.lat,
    lon: row.lon,
    speedKts: row.speedKts,
    courseDeg: row.courseDeg,
    headingDeg: Number.isFinite(row.heading) ? row.heading : null,
    navStatus: row.navStatus ?? null,
  };
}

function asFirm(row) {
  if (!Number.isFinite(row?.lat) || !Number.isFinite(row?.lon) || row.id == null) {
    return null;
  }
  return { id: String(row.id), lat: row.lat, lon: row.lon, acqTime: row.acqTime ?? null };
}

function asQuake(row) {
  if (!Number.isFinite(row?.lat) || !Number.isFinite(row?.lon)) return null;
  return {
    id: String(row.id || ''),
    label: row.place || row.id || 'earthquake',
    lat: row.lat,
    lon: row.lon,
    magnitude: row.magnitude,
    timeMs: row.timeMs,
  };
}

/**
 * Throttled fusion runner. Detectors are pure; this owner samples tracks,
 * debounces alerts, and persists enable flags through an injected storage port.
 * It does not touch the DOM, Cesium, or the render loop. Pass `requestRender`
 * to ask for one frame when the published list changes.
 * @param {object} [options]
 * @param {Function} [options.getRecords] Same accessor shape analystEngine uses.
 * @param {{getItem: Function, setItem: Function}} [options.storage]
 * @param {Function} [options.now]
 * @param {Function} [options.schedule]
 * @param {Function} [options.clearSchedule]
 * @param {number} [options.intervalMs=5000]
 * @param {Function} [options.requestRender]
 * @param {Function} [options.detect] Test seam replacing the detector suite.
 * @param {boolean} [options.autostart=false]
 * @returns {object}
 */
export function createFusionEngine({
  getRecords = () => [],
  storage = null,
  now = () => Date.now(),
  schedule = (fn, ms) => setTimeout(fn, ms),
  clearSchedule = (id) => clearTimeout(id),
  intervalMs = 5000,
  requestRender = () => {},
  detect = null,
  autostart = false,
} = {}) {
  const flags = readDetectorFlags(storage);
  const listeners = new Set();
  const slots = new Map();
  const tracks = new Map();
  const vesselMemory = new Map();
  let started = false;
  let timer = null;
  let publishedSignature = '';

  function anyEnabled() {
    return FLAG_NAMES.some((name) => flags[name]);
  }

  function kindEnabled(kind) {
    if (kind === 'convergence') return flags.convergence;
    if (kind === 'loiter') return flags.loiter;
    if (kind === 'dark-period') return flags.darkPeriod;
    if (kind === 'hotspot-proximity') return flags.hotspot;
    return false;
  }

  function rememberAircraft(aircraft, nowMs) {
    const seen = new Set();
    for (const craft of aircraft) {
      const key = `${craft.layer}:${craft.id}`;
      seen.add(key);
      if (Array.isArray(craft.positions) && craft.positions.length) continue;
      let ring = tracks.get(key);
      if (!ring) {
        ring = [];
        tracks.set(key, ring);
      }
      const last = ring[ring.length - 1];
      if (
        !last ||
        haversineKm(last.lat, last.lon, craft.lat, craft.lon) > 0.02
      ) {
        ring.push({ lat: craft.lat, lon: craft.lon, tMs: nowMs });
        if (ring.length > TRACK_LIMIT) ring.shift();
      }
      craft.track = ring;
    }
    for (const key of tracks.keys()) {
      if (!seen.has(key)) tracks.delete(key);
    }
  }

  function rememberVessels(rows, nowMs) {
    const seen = new Set();
    for (const row of rows) {
      seen.add(row.id);
      let memory = vesselMemory.get(row.id);
      if (!memory) {
        memory = { id: row.id, samples: [] };
        vesselMemory.set(row.id, memory);
      }
      memory.label = row.label;
      memory.lat = row.lat;
      memory.lon = row.lon;
      memory.speedKts = row.speedKts;
      memory.courseDeg = row.courseDeg;
      memory.headingDeg = row.headingDeg;
      memory.navStatus = row.navStatus;
      memory.lastSeenMs = nowMs;
      memory.reporting = true;
      memory.samples.push({
        lat: row.lat,
        lon: row.lon,
        speedKts: row.speedKts,
        tMs: nowMs,
      });
      if (memory.samples.length > VESSEL_SAMPLE_LIMIT) memory.samples.shift();
    }
    for (const [id, memory] of vesselMemory) {
      if (!seen.has(id)) memory.reporting = false;
      if (nowMs - memory.lastSeenMs > VESSEL_MEMORY_MS) vesselMemory.delete(id);
    }
  }

  function snapshot(nowMs) {
    const aircraft = [];
    for (const layer of AIRCRAFT_LAYERS) {
      for (const row of readRows(getRecords, layer)) {
        const craft = asAircraft(row, layer);
        if (craft) aircraft.push(craft);
      }
    }
    const freshVessels = [];
    for (const row of readRows(getRecords, 'ais-live-vessels')) {
      const vessel = asVessel(row);
      if (vessel) freshVessels.push(vessel);
    }
    rememberAircraft(aircraft, nowMs);
    rememberVessels(freshVessels, nowMs);
    const firms = readRows(getRecords, 'local-firms')
      .map(asFirm)
      .filter(Boolean);
    const earthquakes = readRows(getRecords, 'earthquakes')
      .map(asQuake)
      .filter(Boolean);
    return {
      nowMs,
      aircraft,
      vessels: [...vesselMemory.values()],
      firms,
      earthquakes,
    };
  }

  function defaultDetect(view, enabled) {
    const found = [];
    if (enabled.convergence) found.push(...detectConvergence(view));
    if (enabled.loiter) found.push(...detectLoiter(view));
    if (enabled.darkPeriod) found.push(...detectDarkPeriod(view));
    if (enabled.hotspot) found.push(...detectHotspotProximity(view));
    return found;
  }

  function integrate(detected, nowMs) {
    const seen = new Set();
    for (const raw of detected) {
      if (!raw?.id || !kindEnabled(raw.kind)) continue;
      seen.add(raw.id);
      const existing = slots.get(raw.id);
      if (!existing) {
        slots.set(raw.id, {
          consecutive: 1,
          misses: 0,
          published: false,
          alert: { ...raw, firstSeenMs: nowMs, lastSeenMs: nowMs },
        });
        continue;
      }
      existing.misses = 0;
      existing.consecutive += 1;
      existing.alert = {
        ...raw,
        firstSeenMs: existing.alert.firstSeenMs,
        lastSeenMs: nowMs,
      };
      if (existing.consecutive >= 2) existing.published = true;
    }
    for (const [id, slot] of slots) {
      if (!kindEnabled(slot.alert.kind)) {
        slots.delete(id);
        continue;
      }
      if (seen.has(id)) continue;
      slot.consecutive = 0;
      slot.misses += 1;
      if (slot.misses >= 3) slots.delete(id);
    }
  }

  function publishedAlerts() {
    const alerts = [];
    for (const slot of slots.values()) {
      if (!slot.published || slot.misses >= 3) continue;
      alerts.push({ ...slot.alert, entities: slot.alert.entities.map((entity) => ({ ...entity })) });
    }
    alerts.sort(
      (a, b) =>
        b.firstSeenMs - a.firstSeenMs ||
        b.lastSeenMs - a.lastSeenMs ||
        String(a.id).localeCompare(String(b.id)),
    );
    return alerts;
  }

  function signature(alerts) {
    return alerts
      .map((alert) => `${alert.id}:${alert.lastSeenMs}:${alert.severity}:${alert.explanation}`)
      .join('|');
  }

  function publish() {
    const alerts = publishedAlerts();
    const next = signature(alerts);
    if (next === publishedSignature) return alerts;
    publishedSignature = next;
    try {
      requestRender('fusion-alerts');
    } catch {
      /* render hook is best-effort */
    }
    for (const listener of listeners) {
      try {
        listener(alerts);
      } catch {
        /* a listener cannot stop the others */
      }
    }
    return alerts;
  }

  function tick() {
    if (!anyEnabled()) {
      if (slots.size) {
        slots.clear();
        publish();
      }
      return;
    }
    const nowMs = now();
    let detected = [];
    try {
      const view = snapshot(nowMs);
      detected = detect ? detect(view, { ...flags }) : defaultDetect(view, flags);
    } catch {
      detected = [];
    }
    integrate(Array.isArray(detected) ? detected : [], nowMs);
    publish();
  }

  function disarm() {
    if (timer == null) return;
    clearSchedule(timer);
    timer = null;
  }

  function arm() {
    if (!started || timer != null || !anyEnabled()) return;
    timer = schedule(() => {
      timer = null;
      tick();
      arm();
    }, intervalMs);
  }

  function start() {
    started = true;
    arm();
    return api;
  }

  function stop() {
    started = false;
    disarm();
    return api;
  }

  function setDetectorEnabled(name, enabled) {
    if (!FLAG_NAMES.includes(name) || typeof enabled !== 'boolean') return flags;
    flags[name] = enabled;
    writeDetectorFlags(storage, flags);
    if (!kindEnabled(name === 'darkPeriod' ? 'dark-period' : name === 'hotspot' ? 'hotspot-proximity' : name)) {
      for (const [id, slot] of slots) {
        if (!kindEnabled(slot.alert.kind)) slots.delete(id);
      }
      publish();
    }
    if (!anyEnabled()) {
      disarm();
      if (slots.size) {
        slots.clear();
        publish();
      }
    } else if (started) {
      arm();
    }
    return { ...flags };
  }

  const api = {
    start,
    stop,
    /** Run one detector pass immediately. The throttle does not call this on the render path. */
    runOnce: tick,
    /**
     * @param {Function} listener
     * @returns {Function} Unsubscribe.
     */
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** @returns {object[]} Published alerts, newest first. */
    getAlerts() {
      return publishedAlerts();
    },
    /** @returns {Record<string, boolean>} */
    getDetectorFlags() {
      return { ...flags };
    },
    /**
     * @param {'convergence'|'darkPeriod'|'loiter'|'hotspot'} name
     * @param {boolean} enabled
     * @returns {Record<string, boolean>}
     */
    setDetectorEnabled,
  };

  if (autostart) start();
  return api;
}
