/**
 * Versioned browser watch list: contacts, saved places, and geofences.
 * Storage is injected. This module does not touch the DOM or Cesium.
 */

/** localStorage key for the version 1 document. */
export const WATCH_STORAGE_KEY = 'godsEyeView.watch.v1';

/** Document version this build reads and writes. */
export const WATCH_VERSION = 1;

/** Maximum saved entries. Further adds fail with a capacity error. */
export const WATCH_ENTRY_CAP = 200;

/** Layers a watched contact or geofence may name. */
export const WATCH_ENTITY_LAYERS = Object.freeze([
  'flights',
  'military',
  'vessels',
  'satellites',
]);

const LAYER_SET = new Set(WATCH_ENTITY_LAYERS);
const TRIGGERS = new Set(['enter', 'exit', 'both']);
const KINDS = new Set(['entity', 'place', 'geofence']);

/**
 * Error raised for an invalid, full, or unreadable watch list.
 */
export class WatchStoreError extends Error {
  /**
   * @param {'capacity'|'invalid'|'version'|'migrate'|'storage'|'import'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'WatchStoreError';
    this.code = code;
  }
}

/**
 * In-memory storage adapter with the `localStorage` get/set/remove surface.
 * @param {string|null} [initial] Value already stored at {@link WATCH_STORAGE_KEY}.
 * @returns {{getItem: Function, setItem: Function, removeItem: Function}}
 */
export function createMemoryStorage(initial = null) {
  const values = new Map();
  if (initial != null) values.set(WATCH_STORAGE_KEY, String(initial));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(String(key), String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

/**
 * Advance a stored document to {@link WATCH_VERSION}.
 * `migrations[n]` receives the document at version n-1 and must return version n.
 * A newer document is rejected so this build cannot overwrite it.
 * @param {object} raw
 * @param {Record<number, Function>} [migrations]
 * @returns {{version: number, entries: Array<object>}}
 */
export function migrateWatchDocument(raw, migrations = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new WatchStoreError('invalid', 'Watch document is not an object');
  }
  if (!Number.isInteger(raw.version)) {
    throw new WatchStoreError('version', 'Watch document has no version');
  }
  let doc = raw;
  const seen = new Set();
  while (doc.version !== WATCH_VERSION) {
    if (doc.version > WATCH_VERSION) {
      throw new WatchStoreError(
        'version',
        `Watch list version ${doc.version} is newer than this app`,
      );
    }
    if (seen.has(doc.version)) {
      throw new WatchStoreError('migrate', 'Watch migration did not advance');
    }
    seen.add(doc.version);
    const target = doc.version + 1;
    const step = migrations[target];
    if (typeof step !== 'function') {
      throw new WatchStoreError(
        'migrate',
        `No migration from watch version ${doc.version}`,
      );
    }
    const next = step(doc);
    if (!next || next.version !== target) {
      throw new WatchStoreError(
        'migrate',
        `Migration to watch version ${target} did not advance`,
      );
    }
    doc = next;
  }
  if (!Array.isArray(doc.entries)) {
    throw new WatchStoreError('invalid', 'Watch document has no entries');
  }
  return doc;
}

/**
 * @param {object} [options]
 * @param {{getItem: Function, setItem: Function, removeItem: Function}} [options.storage]
 * @param {() => number} [options.now]
 * @param {() => string} [options.id]
 * @param {Record<number, Function>} [options.migrations]
 */
export function createWatchStore({
  storage = createMemoryStorage(),
  now = () => Date.now(),
  id = defaultId,
  migrations = {},
} = {}) {
  /** @type {Array<object>} */
  let entries = [];
  /** @type {WatchStoreError|null} */
  let loadError = null;
  let writable = true;
  const listeners = new Set();

  function snapshot() {
    return entries.map((entry) => clone(entry));
  }

  function notify() {
    const next = snapshot();
    for (const listener of listeners) {
      try {
        listener(next);
      } catch {
        /* a listener must not roll back the write */
      }
    }
  }

  function persist() {
    storage.setItem(
      WATCH_STORAGE_KEY,
      JSON.stringify({ version: WATCH_VERSION, entries: snapshot() }),
    );
  }

  function assertWritable() {
    if (writable) return;
    throw (
      loadError ||
      new WatchStoreError('version', 'Watch list version is not writable')
    );
  }

  function load() {
    let text = null;
    try {
      text = storage.getItem(WATCH_STORAGE_KEY);
    } catch (error) {
      loadError = new WatchStoreError(
        'storage',
        'Saved watch list could not be read',
      );
      loadError.cause = error;
      writable = false;
      return;
    }
    if (text == null || text === '') return;
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      loadError = new WatchStoreError(
        'storage',
        'Saved watch list is not valid JSON',
      );
      writable = false;
      return;
    }
    try {
      const doc = migrateWatchDocument(raw, migrations);
      const accepted = [];
      for (const candidate of doc.entries) {
        const parsed = parseEntry(candidate, { assignId: false, now });
        if (parsed.entry) accepted.push(parsed.entry);
      }
      entries = dedupe(accepted).slice(0, WATCH_ENTRY_CAP);
    } catch (error) {
      loadError =
        error instanceof WatchStoreError
          ? error
          : new WatchStoreError('storage', 'Saved watch list could not be read');
      writable = false;
      entries = [];
    }
  }

  load();

  /**
   * @param {object} input
   * @returns {{entry: object, created: boolean}}
   */
  function add(input) {
    assertWritable();
    const parsed = parseEntry(input, { assignId: true, id, now });
    if (!parsed.entry) {
      throw new WatchStoreError(
        'invalid',
        parsed.error || 'Watch entry is not valid',
      );
    }
    const duplicate = entries.find((entry) => sameIdentity(entry, parsed.entry));
    if (duplicate) return { entry: clone(duplicate), created: false };
    if (entries.length >= WATCH_ENTRY_CAP) {
      throw new WatchStoreError(
        'capacity',
        `Watch list is full (${WATCH_ENTRY_CAP} entries). Remove one before adding another.`,
      );
    }
    entries = [...entries, parsed.entry];
    persist();
    notify();
    return { entry: clone(parsed.entry), created: true };
  }

  /**
   * @param {string} entryId
   * @param {{label?: string, enabled?: boolean}} patch
   * @returns {object|null}
   */
  function update(entryId, patch = {}) {
    assertWritable();
    const index = entries.findIndex((entry) => entry.id === entryId);
    if (index < 0) return null;
    const current = entries[index];
    const next = clone(current);
    if (Object.hasOwn(patch, 'label')) {
      const label = cleanLabel(patch.label);
      if (!label) {
        throw new WatchStoreError('invalid', 'Watch entry needs a name');
      }
      next.label = label;
    }
    if (Object.hasOwn(patch, 'enabled')) {
      if (typeof patch.enabled !== 'boolean') {
        throw new WatchStoreError('invalid', 'Enabled must be true or false');
      }
      next.enabled = patch.enabled;
    }
    entries = entries.map((entry, at) => (at === index ? next : entry));
    persist();
    notify();
    return clone(next);
  }

  /**
   * @param {string} entryId
   * @returns {boolean}
   */
  function remove(entryId) {
    assertWritable();
    const next = entries.filter((entry) => entry.id !== entryId);
    if (next.length === entries.length) return false;
    entries = next;
    persist();
    notify();
    return true;
  }

  /**
   * @param {string|object} payload JSON text or a document/array.
   * @returns {{added: number, skipped: number, invalid: number}}
   */
  function importJson(payload) {
    assertWritable();
    let raw = payload;
    if (typeof payload === 'string') {
      try {
        raw = JSON.parse(payload);
      } catch {
        throw new WatchStoreError('import', 'Watch import is not valid JSON');
      }
    }
    const incoming = Array.isArray(raw)
      ? raw
      : raw && typeof raw === 'object'
        ? raw.entries
        : null;
    if (!Array.isArray(incoming)) {
      throw new WatchStoreError('import', 'Watch import has no entries');
    }
    const accepted = [];
    let invalid = 0;
    let skipped = 0;
    const seen = entries.map((entry) => entry);
    for (const candidate of incoming) {
      const parsed = parseEntry(candidate, { assignId: true, id, now });
      if (!parsed.entry) {
        invalid += 1;
        continue;
      }
      if (seen.some((entry) => sameIdentity(entry, parsed.entry))) {
        skipped += 1;
        continue;
      }
      seen.push(parsed.entry);
      accepted.push(parsed.entry);
    }
    if (entries.length + accepted.length > WATCH_ENTRY_CAP) {
      throw new WatchStoreError(
        'capacity',
        `Watch list is full (${WATCH_ENTRY_CAP} entries). Remove one before adding another.`,
      );
    }
    if (accepted.length) {
      entries = [...entries, ...accepted];
      persist();
      notify();
    }
    return { added: accepted.length, skipped, invalid };
  }

  return {
    /** @returns {Array<object>} */
    list: snapshot,
    /**
     * @param {string} entryId
     * @returns {object|null}
     */
    get(entryId) {
      const found = entries.find((entry) => entry.id === entryId);
      return found ? clone(found) : null;
    },
    add,
    update,
    remove,
    /**
     * @param {string} entryId
     * @param {boolean} enabled
     */
    setEnabled(entryId, enabled) {
      return update(entryId, { enabled });
    },
    /**
     * @param {string} entryId
     * @param {string} label
     */
    rename(entryId, label) {
      return update(entryId, { label });
    },
    /** @returns {string} */
    exportJson() {
      return JSON.stringify({ version: WATCH_VERSION, entries: snapshot() });
    },
    importJson,
    /** @returns {WatchStoreError|null} */
    getLoadError() {
      return loadError;
    },
    /**
     * @param {(entries: Array<object>) => void} listener
     * @returns {() => void}
     */
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * @param {object} input
 * @param {{assignId: boolean, id?: Function, now: Function}} context
 * @returns {{entry: object|null, error: string|null}}
 */
function parseEntry(input, { assignId, id, now }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { entry: null, error: 'Watch entry is not an object' };
  }
  if (!KINDS.has(input.kind)) {
    return { entry: null, error: 'Watch entry kind is not supported' };
  }
  const label = cleanLabel(input.label);
  if (!label) return { entry: null, error: 'Watch entry needs a name' };
  const enabled = input.enabled === undefined ? true : input.enabled;
  if (typeof enabled !== 'boolean') {
    return { entry: null, error: 'Enabled must be true or false' };
  }
  let createdAt = input.createdAt === undefined ? now() : Number(input.createdAt);
  if (!Number.isFinite(createdAt)) {
    return { entry: null, error: 'Watch entry has no created time' };
  }
  createdAt = Math.round(createdAt);
  let entryId = cleanId(input.id);
  if (!entryId) {
    if (!assignId) return { entry: null, error: 'Watch entry has no id' };
    entryId = cleanId(id());
  }
  if (!entryId) return { entry: null, error: 'Watch entry has no id' };
  const entry = { id: entryId, kind: input.kind, label, createdAt, enabled };
  if (input.kind === 'entity') {
    const entity = parseEntity(input.entity);
    if (!entity) return { entry: null, error: 'Watched contact is not valid' };
    entry.entity = entity;
  } else if (input.kind === 'place') {
    const place = parsePlace(input.place);
    if (!place) return { entry: null, error: 'Saved place is not valid' };
    entry.place = place;
  } else {
    const geofence = parseGeofence(input.geofence);
    if (!geofence) return { entry: null, error: 'Geofence is not valid' };
    entry.geofence = geofence;
  }
  return { entry, error: null };
}

/**
 * @param {object} value
 * @returns {object|null}
 */
function parseEntity(value) {
  if (!value || typeof value !== 'object') return null;
  if (!LAYER_SET.has(value.layer)) return null;
  const entityId = cleanId(value.id);
  if (!entityId) return null;
  const entity = { layer: value.layer, id: entityId };
  if (value.meta === undefined) return entity;
  const meta = parseMeta(value.meta);
  if (!meta) return null;
  if (Object.keys(meta).length) entity.meta = meta;
  return entity;
}

/**
 * @param {object} value
 * @returns {object|null}
 */
function parsePlace(value) {
  if (!value || typeof value !== 'object') return null;
  const lat = Number(value.lat);
  const lon = Number(value.lon);
  const height = Number(value.height);
  const heading = Number(value.heading);
  const pitch = Number(value.pitch);
  const roll = Number(value.roll);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return null;
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) return null;
  if (!Number.isFinite(height) || height < -10000 || height > 1e8) return null;
  if (![heading, pitch, roll].every(Number.isFinite)) return null;
  const place = { lat, lon, height, heading, pitch, roll };
  if (value.style !== undefined) {
    const style = cleanLabel(value.style);
    if (!style) return null;
    place.style = style;
  }
  if (value.layers !== undefined) {
    const layers = parseLayerIds(value.layers);
    if (!layers) return null;
    place.layers = layers;
  }
  if (value.radiusKm !== undefined) {
    const radiusKm = Number(value.radiusKm);
    if (!Number.isFinite(radiusKm) || radiusKm <= 0 || radiusKm > 20000) {
      return null;
    }
    place.radiusKm = radiusKm;
  }
  return place;
}

/**
 * @param {object} value
 * @returns {object|null}
 */
function parseGeofence(value) {
  if (!value || typeof value !== 'object') return null;
  if (!Array.isArray(value.polygon) || value.polygon.length < 3) return null;
  if (value.polygon.length > 512) return null;
  const polygon = [];
  for (const pair of value.polygon) {
    const lat = Number(pair?.[0]);
    const lon = Number(pair?.[1]);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) return null;
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) return null;
    const prev = polygon[polygon.length - 1];
    if (prev && prev[0] === lat && prev[1] === lon) continue;
    polygon.push([lat, lon]);
  }
  if (polygon.length >= 2) {
    const first = polygon[0];
    const last = polygon[polygon.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) polygon.pop();
  }
  if (polygon.length < 3) return null;
  const layers = [];
  if (!Array.isArray(value.layers)) return null;
  for (const layer of value.layers) {
    if (!LAYER_SET.has(layer) || layers.includes(layer)) continue;
    layers.push(layer);
  }
  if (!layers.length) return null;
  if (!TRIGGERS.has(value.trigger)) return null;
  return { polygon, layers, trigger: value.trigger };
}

/**
 * @param {object} value
 * @returns {object|null}
 */
function parseMeta(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const meta = {};
  for (const [key, item] of Object.entries(value)) {
    if (!cleanId(key) || Object.keys(meta).length >= 8) continue;
    if (
      item === null ||
      typeof item === 'string' ||
      typeof item === 'boolean' ||
      (typeof item === 'number' && Number.isFinite(item))
    ) {
      meta[key] = typeof item === 'string' ? item.slice(0, 80) : item;
    }
  }
  return meta;
}

/**
 * @param {Array<unknown>} value
 * @returns {string[]|null}
 */
function parseLayerIds(value) {
  if (!Array.isArray(value) || value.length > 40) return null;
  const layers = [];
  for (const item of value) {
    const layerId = cleanId(item);
    if (!layerId || layers.includes(layerId)) continue;
    layers.push(layerId);
  }
  return layers;
}

/**
 * @param {Array<object>} list
 * @returns {Array<object>}
 */
function dedupe(list) {
  const kept = [];
  for (const entry of list) {
    if (kept.some((other) => sameIdentity(other, entry))) continue;
    kept.push(entry);
  }
  return kept;
}

/**
 * @param {object} left
 * @param {object} right
 * @returns {boolean}
 */
function sameIdentity(left, right) {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'entity') {
    return (
      left.entity.layer === right.entity.layer &&
      left.entity.id.toLowerCase() === right.entity.id.toLowerCase()
    );
  }
  if (left.kind === 'place') {
    return (
      round(left.place.lat, 4) === round(right.place.lat, 4) &&
      round(left.place.lon, 4) === round(right.place.lon, 4) &&
      Math.round(left.place.height) === Math.round(right.place.height)
    );
  }
  return polygonKey(left.geofence.polygon) === polygonKey(right.geofence.polygon);
}

/**
 * @param {Array<[number, number]>} polygon
 * @returns {string}
 */
function polygonKey(polygon) {
  return polygon
    .map((pair) => `${round(pair[0], 4)},${round(pair[1], 4)}`)
    .join(';');
}

/**
 * @param {number} value
 * @param {number} digits
 * @returns {number}
 */
function round(value, digits) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function cleanLabel(value) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, 80) : '';
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function cleanId(value) {
  const text = String(value ?? '').trim();
  if (!text || text.length > 80) return '';
  return text;
}

/**
 * @param {object} value
 * @returns {object}
 */
function clone(value) {
  return structuredClone(value);
}

/** @returns {string} */
function defaultId() {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `w-${uuid}`;
  return `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
