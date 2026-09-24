/** Layers that keep a local contact history. */
export const HISTORY_LAYERS = Object.freeze(['flights', 'vessels']);

/** Default retained sample budget across every layer. */
export const DEFAULT_MEMORY_BUDGET_BYTES = 200 * 1024 * 1024;

/** Default age of the oldest sample that may remain. */
export const DEFAULT_WINDOW_MS = 60 * 60 * 1000;

/** Hard ceiling for the configured time window. */
export const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Default cap on snapshots stored for one layer. */
export const DEFAULT_MAX_SNAPSHOTS = 4096;

const SAMPLE_BYTES = 5 * 4 + 4 + 8;
const SNAPSHOT_OVERHEAD_BYTES = 64;
const METADATA_OVERHEAD_BYTES = 64;

/**
 * Bounded ring of per-poll contact snapshots.
 * Portable: no Cesium, DOM, or host storage.
 * @param {object} [options]
 * @param {number} [options.memoryBudgetBytes] Shared byte budget. Default 200 MB.
 * @param {number} [options.windowMs] Maximum sample age. Clamped to 24 h. Default 60 min.
 * @param {number} [options.maxSnapshots] Per-layer snapshot cap.
 * @param {() => number} [options.now] Clock used when a sample omits time.
 */
export function createHistoryStore(options = {}) {
  const memoryBudgetBytes = positiveInteger(
    options.memoryBudgetBytes,
    DEFAULT_MEMORY_BUDGET_BYTES,
  );
  const windowMs = Math.min(
    MAX_WINDOW_MS,
    positiveInteger(options.windowMs, DEFAULT_WINDOW_MS),
  );
  const maxSnapshots = positiveInteger(
    options.maxSnapshots,
    DEFAULT_MAX_SNAPSHOTS,
  );
  const now = options.now || (() => Date.now());
  const layers = { flights: [], vessels: [] };
  const idToSlot = new Map();
  const slotToId = [];
  const metadata = new Map();
  const listeners = new Set();
  let bytes = 0;
  let silent = 0;

  /**
   * Return the canonical id string for a contact, creating it once.
   * @param {string} id
   * @returns {string}
   */
  function canonical(id) {
    const key = String(id);
    let slot = idToSlot.get(key);
    if (slot === undefined) {
      slot = slotToId.length;
      slotToId.push(key);
      idToSlot.set(key, slot);
    }
    return slotToId[slot];
  }

  /**
   * Dense slot assigned to an interned id, or -1 when unknown.
   * @param {string} id
   * @returns {number}
   */
  function slotOf(id) {
    const slot = idToSlot.get(String(id));
    return slot === undefined ? -1 : slot;
  }

  /**
   * Interned id for a slot.
   * @param {number} slot
   * @returns {string|undefined}
   */
  function idForSlot(slot) {
    return slotToId[slot];
  }

  /**
   * Metadata recorded once per id.
   * @param {string} id
   * @returns {{callsign: string, name: string, type: string}|null}
   */
  function metadataFor(id) {
    const slot = idToSlot.get(String(id));
    if (slot === undefined) return null;
    return metadata.get(slotToId[slot]) || null;
  }

  function remember(id, row) {
    let meta = metadata.get(id);
    if (!meta) {
      meta = { callsign: '', name: '', type: '' };
      metadata.set(id, meta);
      bytes += METADATA_OVERHEAD_BYTES;
    }
    if (row.callsign) meta.callsign = String(row.callsign);
    if (row.name) meta.name = String(row.name);
    if (row.type) meta.type = String(row.type);
  }

  function snapshotBytes(count) {
    return SNAPSHOT_OVERHEAD_BYTES + count * SAMPLE_BYTES;
  }

  function dropHead(layer) {
    const removed = layers[layer].shift();
    if (!removed) return false;
    bytes -= snapshotBytes(removed.count);
    return true;
  }

  function dropOldest() {
    let oldestLayer = null;
    let oldestTime = Infinity;
    for (const layer of HISTORY_LAYERS) {
      const head = layers[layer][0];
      if (head && head.tMs < oldestTime) {
        oldestTime = head.tMs;
        oldestLayer = layer;
      }
    }
    if (!oldestLayer) return false;
    return dropHead(oldestLayer);
  }

  function pruneMetadata() {
    const live = new Set();
    for (const layer of HISTORY_LAYERS) {
      for (const snap of layers[layer]) {
        for (let i = 0; i < snap.count; i += 1) live.add(snap.ids[i]);
      }
    }
    for (const id of metadata.keys()) {
      if (live.has(id)) continue;
      metadata.delete(id);
      bytes -= METADATA_OVERHEAD_BYTES;
    }
  }

  function evict() {
    let dropped = false;
    for (const layer of HISTORY_LAYERS) {
      const snaps = layers[layer];
      while (
        snaps.length > 1 &&
        snaps[snaps.length - 1].tMs - snaps[0].tMs > windowMs
      ) {
        dropHead(layer);
        dropped = true;
      }
      while (snaps.length > maxSnapshots) {
        dropHead(layer);
        dropped = true;
      }
    }
    let guard = 0;
    while (bytes > memoryBudgetBytes && guard < 100000) {
      if (!dropOldest()) break;
      dropped = true;
      pruneMetadata();
      guard += 1;
    }
    if (dropped) pruneMetadata();
  }

  function notify() {
    if (silent) return;
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* Observers cannot block capture. */
      }
    }
  }

  /**
   * Append one reconciled poll. Oldest samples leave first when a cap is exceeded.
   * @param {'flights'|'vessels'} layer
   * @param {Array<{id: string, lat: number, lon: number, alt?: number, heading?: number, speed?: number, callsign?: string, name?: string, type?: string}>} records
   * @param {number} [tMs] Sample time. Defaults to the store clock.
   * @returns {{tMs: number, count: number}|null} Stored sample, or null when nothing was kept.
   */
  function append(layer, records, tMs = now()) {
    if (!HISTORY_LAYERS.includes(layer)) {
      throw new TypeError(`Unknown history layer: ${layer}`);
    }
    if (!Number.isFinite(tMs)) return null;
    const snaps = layers[layer];
    const last = snaps[snaps.length - 1];
    if (last && tMs < last.tMs) return null;
    const rows = [];
    for (const row of records || []) {
      if (!row || row.id == null || row.id === '') continue;
      const lat = Number(row.lat);
      const lon = Number(row.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      rows.push(row);
    }
    if (!rows.length) return null;
    const count = rows.length;
    const ids = new Array(count);
    const slots = new Uint32Array(count);
    const lat = new Float32Array(count);
    const lon = new Float32Array(count);
    const alt = new Float32Array(count);
    const heading = new Float32Array(count);
    const speed = new Float32Array(count);
    for (let i = 0; i < count; i += 1) {
      const row = rows[i];
      const id = canonical(row.id);
      ids[i] = id;
      slots[i] = idToSlot.get(id);
      lat[i] = Number(row.lat);
      lon[i] = Number(row.lon);
      alt[i] = finiteOrNaN(row.alt);
      heading[i] = finiteOrNaN(row.heading);
      speed[i] = finiteOrNaN(row.speed);
      remember(id, row);
    }
    const snapshot = { tMs, count, ids, slots, lat, lon, alt, heading, speed };
    if (last && tMs === last.tMs) {
      bytes -= snapshotBytes(last.count);
      snaps[snaps.length - 1] = snapshot;
    } else {
      snaps.push(snapshot);
    }
    bytes += snapshotBytes(count);
    evict();
    const kept = snaps.includes(snapshot);
    notify();
    return kept ? { tMs, count } : null;
  }

  /**
   * Buffered extent for one layer.
   * @param {'flights'|'vessels'} layer
   * @returns {{startMs: number|null, endMs: number|null, count: number}}
   */
  function range(layer) {
    if (!HISTORY_LAYERS.includes(layer)) {
      throw new TypeError(`Unknown history layer: ${layer}`);
    }
    const snaps = layers[layer];
    if (!snaps.length) return { startMs: null, endMs: null, count: 0 };
    return {
      startMs: snaps[0].tMs,
      endMs: snaps[snaps.length - 1].tMs,
      count: snaps.length,
    };
  }

  /**
   * Budget, occupancy, and per-layer extent.
   * @returns {object}
   */
  function stats() {
    const layerStats = {};
    for (const layer of HISTORY_LAYERS) {
      const extent = range(layer);
      let samples = 0;
      for (const snap of layers[layer]) samples += snap.count;
      layerStats[layer] = { ...extent, samples };
    }
    return {
      memoryBudgetBytes,
      bytes,
      windowMs,
      maxSnapshots,
      idCount: slotToId.length,
      layers: layerStats,
    };
  }

  /**
   * @param {() => void} listener
   * @returns {() => void} Unsubscribe.
   */
  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /**
   * Plain copy safe to structured-clone into storage.
   * @returns {object}
   */
  function exportState() {
    const exported = { version: 1, layers: {}, metadata: [] };
    for (const layer of HISTORY_LAYERS) {
      exported.layers[layer] = layers[layer].map((snap) => ({
        tMs: snap.tMs,
        ids: snap.ids.slice(),
        lat: Array.from(snap.lat),
        lon: Array.from(snap.lon),
        alt: Array.from(snap.alt),
        heading: Array.from(snap.heading),
        speed: Array.from(snap.speed),
      }));
    }
    for (const [id, meta] of metadata) {
      exported.metadata.push([id, { ...meta }]);
    }
    return exported;
  }

  /**
   * Replace the buffer from an exported copy, then enforce the same caps.
   * @param {object|null|undefined} state
   * @returns {void}
   */
  function importState(state) {
    silent += 1;
    try {
      for (const layer of HISTORY_LAYERS) layers[layer].length = 0;
      metadata.clear();
      bytes = 0;
      if (!state || state.version !== 1) return;
      for (const layer of HISTORY_LAYERS) {
        const snaps = Array.isArray(state.layers?.[layer])
          ? state.layers[layer]
          : [];
        for (const snap of snaps) {
          if (!snap || !Number.isFinite(snap.tMs) || !Array.isArray(snap.ids)) {
            continue;
          }
          const records = [];
          for (let i = 0; i < snap.ids.length; i += 1) {
            records.push({
              id: snap.ids[i],
              lat: snap.lat?.[i],
              lon: snap.lon?.[i],
              alt: snap.alt?.[i],
              heading: snap.heading?.[i],
              speed: snap.speed?.[i],
            });
          }
          append(layer, records, snap.tMs);
        }
      }
      if (Array.isArray(state.metadata)) {
        for (const entry of state.metadata) {
          const id = entry?.[0];
          const meta = entry?.[1];
          if (!id || !meta) continue;
          remember(canonical(id), meta);
        }
      }
      evict();
    } finally {
      silent -= 1;
    }
    notify();
  }

  return {
    append,
    range,
    stats,
    subscribe,
    canonical,
    slotOf,
    idForSlot,
    slotCount: () => slotToId.length,
    metadata: metadataFor,
    exportState,
    importState,
    /**
     * Chronological snapshots for interpolation. Treat the array as read-only.
     * @param {'flights'|'vessels'} layer
     * @returns {object[]}
     */
    snapshots(layer) {
      if (!HISTORY_LAYERS.includes(layer)) {
        throw new TypeError(`Unknown history layer: ${layer}`);
      }
      return layers[layer];
    },
  };
}

/**
 * @param {number} value
 * @param {number} fallback
 * @returns {number}
 */
function positiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.floor(number);
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function finiteOrNaN(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : Number.NaN;
}
