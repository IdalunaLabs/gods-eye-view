/**
 * Throttled watch evaluation over layer snapshots.
 * Records come from an injected reader — the same shape the analyst engine
 * reads (`id` / `icao24` / `mmsi`, `lat`/`latitude`, `lon`/`longitude`).
 * A missing report is not a disappearance; lost events say so.
 */

import { distanceKm, pointInPolygon } from './geometry.js';
import { WATCH_ENTITY_LAYERS } from './watchStore.js';

/** Default gap between snapshot evaluations. */
export const DEFAULT_EVALUATE_INTERVAL_MS = 5000;

/** Default minimum gap between repeated alerts for one entry and subject. */
export const DEFAULT_COOLDOWN_MS = 60_000;

/** How long a layer may go without a report before a watched contact is quiet. */
export const DEFAULT_STALENESS_MS = Object.freeze({
  flights: 120_000,
  military: 120_000,
  vessels: 120_000,
  satellites: 600_000,
});

/** Recent-event ring length. */
export const DEFAULT_EVENT_LIMIT = 100;

/**
 * @param {object} options
 * @param {() => Array<object>} options.readEntries
 * @param {(layer: string) => Array<object>|null} options.getRecords
 *   `null` means the layer was not read (disabled or unavailable) and must not
 *   be treated as "no report". An array, including empty, is a snapshot.
 * @param {() => number} [options.now]
 * @param {number} [options.intervalMs]
 * @param {number} [options.cooldownMs]
 * @param {Record<string, number>} [options.stalenessMs]
 * @param {number} [options.eventLimit]
 * @param {(fn: Function, ms: number) => unknown} [options.setTimer]
 * @param {(handle: unknown) => void} [options.clearTimer]
 */
export function createWatchEngine({
  readEntries,
  getRecords,
  now = () => Date.now(),
  intervalMs = DEFAULT_EVALUATE_INTERVAL_MS,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  stalenessMs = {},
  eventLimit = DEFAULT_EVENT_LIMIT,
  setTimer = (fn, ms) => setInterval(fn, ms),
  clearTimer = (handle) => clearInterval(handle),
} = {}) {
  if (typeof readEntries !== 'function' || typeof getRecords !== 'function') {
    throw new TypeError('Watch engine needs readEntries and getRecords');
  }
  const listeners = new Set();
  const events = [];
  const entityState = new Map();
  const fenceState = new Map();
  const proximityState = new Map();
  const cooldownAt = new Map();
  const held = new Map();
  let timer = null;
  let seq = 0;

  /**
   * @param {(event: object) => void} listener
   * @returns {() => void}
   */
  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /** @returns {Array<object>} Oldest first, capped. */
  function getRecentEvents() {
    return events.map((event) => ({ ...event }));
  }

  /**
   * @param {number} [at]
   * @returns {Array<object>} Events emitted by this pass, excluding held ones.
   */
  function evaluate(at = now()) {
    const stamped = Number.isFinite(at) ? at : now();
    const emitted = [];
    flushHeld(stamped, emitted);
    const all = safeEntries();
    const enabled = all.filter((entry) => entry?.enabled !== false);
    const known = new Set(all.map((entry) => entry?.id).filter(Boolean));
    forgetUnknown(known);
    const snapshots = new Map();
    const rowsFor = (layer) => {
      if (!snapshots.has(layer)) snapshots.set(layer, readLayer(layer));
      return snapshots.get(layer);
    };
    for (const entry of enabled) {
      if (entry.kind === 'entity') {
        evaluateEntity(entry, rowsFor, stamped, emitted);
      } else if (entry.kind === 'geofence') {
        evaluateGeofence(entry, rowsFor, stamped, emitted);
      } else if (entry.kind === 'place') {
        evaluatePlace(entry, rowsFor, stamped, emitted);
      }
    }
    return emitted;
  }

  function start() {
    if (timer != null) return;
    evaluate(now());
    timer = setTimer(() => evaluate(now()), intervalMs);
  }

  function stop() {
    if (timer == null) return;
    clearTimer(timer);
    timer = null;
  }

  /**
   * @param {object} entry
   * @param {Function} rowsFor
   * @param {number} at
   * @param {Array<object>} emitted
   */
  function evaluateEntity(entry, rowsFor, at, emitted) {
    const layer = entry.entity?.layer;
    const rows = rowsFor(layer);
    if (rows == null) return;
    const wanted = normId(entry.entity.id);
    const record = rows.find((row) => recordId(row) === wanted) || null;
    const position = record ? recordPosition(record) : null;
    const state = entityState.get(entry.id) || { phase: 'unseen' };
    if (position) {
      const label = recordLabel(record, entry.label);
      const previous = state.phase;
      state.phase = 'present';
      state.lastReportAt = at;
      state.position = position;
      state.label = label;
      entityState.set(entry.id, state);
      if (previous === 'unseen' || previous === 'lost') {
        publish(
          {
            type: 'entity-seen',
            entryId: entry.id,
            label,
            layer,
            entityId: entry.entity.id,
            position,
            message: `${label} reported`,
          },
          at,
          emitted,
        );
      }
      return;
    }
    if (state.phase !== 'present' && state.phase !== 'gap') return;
    const elapsed = at - state.lastReportAt;
    if (elapsed >= stalenessFor(layer)) {
      const minutes = Math.max(1, Math.round(elapsed / 60_000));
      state.phase = 'lost';
      entityState.set(entry.id, state);
      publish(
        {
          type: 'entity-lost',
          entryId: entry.id,
          label: state.label || entry.label,
          layer,
          entityId: entry.entity.id,
          position: state.position || null,
          minutes,
          message: `${state.label || entry.label}: no report for ${minutes} min`,
        },
        at,
        emitted,
      );
      return;
    }
    state.phase = 'gap';
    entityState.set(entry.id, state);
  }

  /**
   * @param {object} entry
   * @param {Function} rowsFor
   * @param {number} at
   * @param {Array<object>} emitted
   */
  function evaluateGeofence(entry, rowsFor, at, emitted) {
    const polygon = entry.geofence?.polygon;
    const trigger = entry.geofence?.trigger;
    if (!Array.isArray(polygon) || !trigger) return;
    for (const layer of entry.geofence.layers || []) {
      const rows = rowsFor(layer);
      if (rows == null) continue;
      for (const record of rows) {
        const entityId = recordId(record);
        const position = recordPosition(record);
        if (!entityId || !position) continue;
        const key = fenceKey(entry.id, layer, entityId);
        const inside = pointInPolygon(position.lat, position.lon, polygon);
        const previous = fenceState.get(key);
        fenceState.set(key, inside ? 'in' : 'out');
        if (previous === undefined) {
          if (inside && (trigger === 'enter' || trigger === 'both')) {
            publish(
              fenceEvent(
                'geofence-enter',
                entry,
                layer,
                entityId,
                record,
                position,
              ),
              at,
              emitted,
            );
          }
          continue;
        }
        if (
          previous === 'out' &&
          inside &&
          (trigger === 'enter' || trigger === 'both')
        ) {
          publish(
            fenceEvent('geofence-enter', entry, layer, entityId, record, position),
            at,
            emitted,
          );
        } else if (
          previous === 'in' &&
          !inside &&
          (trigger === 'exit' || trigger === 'both')
        ) {
          publish(
            fenceEvent('geofence-exit', entry, layer, entityId, record, position),
            at,
            emitted,
          );
        }
      }
    }
  }

  /**
   * @param {object} entry
   * @param {Function} rowsFor
   * @param {number} at
   * @param {Array<object>} emitted
   */
  function evaluatePlace(entry, rowsFor, at, emitted) {
    const radiusKm = entry.place?.radiusKm;
    if (!(radiusKm > 0)) return;
    for (const layer of WATCH_ENTITY_LAYERS) {
      const rows = rowsFor(layer);
      if (rows == null) continue;
      for (const record of rows) {
        const entityId = recordId(record);
        const position = recordPosition(record);
        if (!entityId || !position) continue;
        const key = fenceKey(entry.id, layer, entityId);
        const km = distanceKm(
          entry.place.lat,
          entry.place.lon,
          position.lat,
          position.lon,
        );
        const inside = Number.isFinite(km) && km <= radiusKm;
        const previous = proximityState.get(key);
        proximityState.set(key, inside ? 'in' : 'out');
        if (previous === 'in' || !inside) continue;
        if (previous !== 'out' && previous !== undefined) continue;
        if (previous === undefined && !inside) continue;
        const label = recordLabel(record, entityId);
        publish(
          {
            type: 'place-proximity',
            entryId: entry.id,
            label: entry.label,
            layer,
            entityId,
            position,
            distanceKm: Math.round(km * 10) / 10,
            message: `${label} is within ${formatKm(km)} km of ${entry.label}`,
          },
          at,
          emitted,
        );
      }
    }
  }

  /**
   * @param {object} event
   * @param {number} at
   * @param {Array<object>} emitted
   * @returns {boolean}
   */
  function publish(event, at, emitted) {
    const key = cooldownKey(event);
    const last = cooldownAt.get(key);
    if (last != null && at - last < cooldownMs) {
      held.set(key, { ...event, at });
      return false;
    }
    cooldownAt.set(key, at);
    held.delete(key);
    const stored = {
      ...event,
      id: `e${at.toString(36)}-${(seq += 1).toString(36)}`,
      at,
    };
    events.push(stored);
    if (events.length > eventLimit) events.splice(0, events.length - eventLimit);
    emitted.push({ ...stored });
    for (const listener of listeners) {
      try {
        listener({ ...stored });
      } catch {
        /* listeners cannot stop the rest of the pass */
      }
    }
    return true;
  }

  /**
   * @param {number} at
   * @param {Array<object>} emitted
   */
  function flushHeld(at, emitted) {
    for (const [key, event] of held) {
      const last = cooldownAt.get(key) ?? 0;
      if (at - last < cooldownMs) continue;
      held.delete(key);
      publish({ ...event, at }, at, emitted);
    }
  }

  /**
   * @param {string} layer
   * @returns {number}
   */
  function stalenessFor(layer) {
    const override = stalenessMs?.[layer];
    if (Number.isFinite(override) && override >= 0) return override;
    return DEFAULT_STALENESS_MS[layer] ?? 120_000;
  }

  /** @returns {Array<object>} */
  function safeEntries() {
    try {
      const value = readEntries();
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  }

  /**
   * @param {string} layer
   * @returns {Array<object>|null}
   */
  function readLayer(layer) {
    if (!WATCH_ENTITY_LAYERS.includes(layer)) return null;
    try {
      const value = getRecords(layer);
      return Array.isArray(value) ? value : null;
    } catch {
      return null;
    }
  }

  /** @param {Set<string>} known */
  function forgetUnknown(known) {
    for (const id of entityState.keys()) {
      if (!known.has(id)) entityState.delete(id);
    }
    for (const key of fenceState.keys()) {
      if (!known.has(key.split('\0')[0])) fenceState.delete(key);
    }
    for (const key of proximityState.keys()) {
      if (!known.has(key.split('\0')[0])) proximityState.delete(key);
    }
  }

  return {
    subscribe,
    getRecentEvents,
    evaluate,
    start,
    stop,
    destroy: stop,
  };
}

/**
 * @param {'geofence-enter'|'geofence-exit'} type
 * @param {object} entry
 * @param {string} layer
 * @param {string} entityId
 * @param {object} record
 * @param {{lat: number, lon: number}} position
 */
function fenceEvent(type, entry, layer, entityId, record, position) {
  const label = recordLabel(record, entityId);
  const verb = type === 'geofence-enter' ? 'entered' : 'left';
  return {
    type,
    entryId: entry.id,
    label: entry.label,
    layer,
    entityId,
    position,
    message: `${label} ${verb} ${entry.label}`,
  };
}

/**
 * @param {object} event
 * @returns {string}
 */
function cooldownKey(event) {
  return `${event.type}|${event.entryId}|${normId(event.entityId)}`;
}

/**
 * @param {string} entryId
 * @param {string} layer
 * @param {string} entityId
 * @returns {string}
 */
function fenceKey(entryId, layer, entityId) {
  return `${entryId}\0${layer}\0${entityId}`;
}

/**
 * @param {object|null} record
 * @returns {string}
 */
function recordId(record) {
  const stable = record?.icao24 ?? record?.mmsi ?? record?.id;
  return normId(stable);
}

/**
 * @param {object|null} record
 * @returns {{lat: number, lon: number}|null}
 */
function recordPosition(record) {
  const lat = Number(record?.lat ?? record?.latitude);
  const lon = Number(record?.lon ?? record?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

/**
 * @param {object|null} record
 * @param {string} fallback
 * @returns {string}
 */
function recordLabel(record, fallback) {
  const text = String(
    record?.callsign || record?.name || record?.label || fallback || '',
  ).trim();
  return text || 'Contact';
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normId(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

/**
 * @param {number} km
 * @returns {string}
 */
function formatKm(km) {
  if (km >= 100) return String(Math.round(km));
  return String(Math.round(km * 10) / 10);
}
