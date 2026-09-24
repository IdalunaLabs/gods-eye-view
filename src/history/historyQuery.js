import { HISTORY_LAYERS } from './historyStore.js';

/**
 * Interpolate interned contact snapshots.
 * After the output arrays have grown to the working set, later calls reuse them.
 * @param {ReturnType<import('./historyStore.js').createHistoryStore>} store
 */
export function createHistoryQuery(store) {
  const outputs = new Map();

  /**
   * Positions at `tMs` for one layer.
   * Ids in both brackets are interpolated. Ids in only one bracket are held
   * with `held` set. Times outside the buffer hold the nearest snapshot.
   * @param {'flights'|'vessels'} layer
   * @param {number} tMs
   * @returns {{tMs: number, count: number, ids: string[], lat: Float32Array, lon: Float32Array, alt: Float32Array, heading: Float32Array, speed: Float32Array, held: Uint8Array}}
   */
  function sampleAt(layer, tMs) {
    if (!HISTORY_LAYERS.includes(layer)) {
      throw new TypeError(`Unknown history layer: ${layer}`);
    }
    const out = outputFor(layer);
    const snaps = store.snapshots(layer);
    out.tMs = tMs;
    if (!snaps.length || !Number.isFinite(tMs)) {
      out.count = 0;
      out.ids.length = 0;
      return out;
    }
    const bracket = locate(snaps, tMs);
    if (bracket.single) {
      paint(out, bracket.left, bracket.held ? 1 : 0);
      return out;
    }
    blend(out, bracket.left, bracket.right, bracket.u);
    return out;
  }

  /**
   * @param {'flights'|'vessels'} layer
   */
  function outputFor(layer) {
    let out = outputs.get(layer);
    if (!out) {
      out = {
        tMs: 0,
        count: 0,
        ids: [],
        lat: new Float32Array(0),
        lon: new Float32Array(0),
        alt: new Float32Array(0),
        heading: new Float32Array(0),
        speed: new Float32Array(0),
        held: new Uint8Array(0),
        _left: new Int32Array(0),
        _right: new Int32Array(0),
      };
      outputs.set(layer, out);
    }
    return out;
  }

  /**
   * @param {object} out
   * @param {object} snap
   * @param {number} held
   */
  function paint(out, snap, held) {
    ensure(out, snap.count);
    out.count = snap.count;
    out.ids.length = snap.count;
    for (let i = 0; i < snap.count; i += 1) {
      out.ids[i] = snap.ids[i];
      out.lat[i] = snap.lat[i];
      out.lon[i] = snap.lon[i];
      out.alt[i] = snap.alt[i];
      out.heading[i] = snap.heading[i];
      out.speed[i] = snap.speed[i];
      out.held[i] = held;
    }
  }

  /**
   * @param {object} out
   * @param {object} left
   * @param {object} right
   * @param {number} u
   */
  function blend(out, left, right, u) {
    const slots = Math.max(store.slotCount(), 1);
    out._left = indexInto(out._left, slots, left);
    out._right = indexInto(out._right, slots, right);
    const capacity = left.count + right.count;
    ensure(out, capacity);
    let count = 0;
    for (let i = 0; i < left.count; i += 1) {
      const slot = left.slots[i];
      const j = out._right[slot];
      writePair(out, count, left, i, j >= 0 ? right : null, j, u);
      count += 1;
    }
    for (let j = 0; j < right.count; j += 1) {
      const slot = right.slots[j];
      if (out._left[slot] >= 0) continue;
      writePair(out, count, null, -1, right, j, u);
      count += 1;
    }
    out.count = count;
    out.ids.length = count;
  }

  return { sampleAt };
}

/**
 * @param {object[]} snaps
 * @param {number} tMs
 */
function locate(snaps, tMs) {
  const last = snaps.length - 1;
  if (tMs <= snaps[0].tMs) {
    return { single: true, left: snaps[0], held: tMs < snaps[0].tMs };
  }
  if (tMs >= snaps[last].tMs) {
    return { single: true, left: snaps[last], held: tMs > snaps[last].tMs };
  }
  let lo = 0;
  let hi = last;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (snaps[mid].tMs <= tMs) lo = mid;
    else hi = mid - 1;
  }
  if (snaps[lo].tMs === tMs) return { single: true, left: snaps[lo], held: false };
  const span = snaps[lo + 1].tMs - snaps[lo].tMs;
  return {
    single: false,
    left: snaps[lo],
    right: snaps[lo + 1],
    u: span <= 0 ? 0 : (tMs - snaps[lo].tMs) / span,
  };
}

/**
 * @param {Int32Array} index
 * @param {number} slots
 * @param {object} snap
 * @returns {Int32Array}
 */
function indexInto(index, slots, snap) {
  let table = index;
  if (table.length < slots) {
    const grown = new Int32Array(Math.max(slots, table.length * 2 || 16));
    grown.fill(-1);
    table = grown;
  } else {
    table.fill(-1, 0, slots);
  }
  for (let i = 0; i < snap.count; i += 1) table[snap.slots[i]] = i;
  return table;
}

/**
 * @param {object} out
 * @param {number} count
 */
function ensure(out, count) {
  if (out.lat.length >= count) return;
  const next = Math.max(count, out.lat.length * 2 || 8);
  out.lat = new Float32Array(next);
  out.lon = new Float32Array(next);
  out.alt = new Float32Array(next);
  out.heading = new Float32Array(next);
  out.speed = new Float32Array(next);
  out.held = new Uint8Array(next);
}

/**
 * @param {object} out
 * @param {number} index
 * @param {object|null} left
 * @param {number} i
 * @param {object|null} right
 * @param {number} j
 * @param {number} u
 */
function writePair(out, index, left, i, right, j, u) {
  const fromLeft = left != null;
  const fromRight = right != null && j >= 0;
  if (fromLeft && fromRight) {
    out.ids[index] = left.ids[i];
    out.lat[index] = left.lat[i] + (right.lat[j] - left.lat[i]) * u;
    out.lon[index] = lerpLon(left.lon[i], right.lon[j], u);
    out.alt[index] = lerpFinite(left.alt[i], right.alt[j], u);
    out.heading[index] = lerpHeading(left.heading[i], right.heading[j], u);
    out.speed[index] = lerpFinite(left.speed[i], right.speed[j], u);
    out.held[index] = 0;
    return;
  }
  const snap = fromLeft ? left : right;
  const at = fromLeft ? i : j;
  out.ids[index] = snap.ids[at];
  out.lat[index] = snap.lat[at];
  out.lon[index] = snap.lon[at];
  out.alt[index] = snap.alt[at];
  out.heading[index] = snap.heading[at];
  out.speed[index] = snap.speed[at];
  out.held[index] = 1;
}

/**
 * @param {number} a
 * @param {number} b
 * @param {number} u
 * @returns {number}
 */
function lerpFinite(a, b, u) {
  const aOk = Number.isFinite(a);
  const bOk = Number.isFinite(b);
  if (aOk && bOk) return a + (b - a) * u;
  if (aOk) return a;
  if (bOk) return b;
  return Number.NaN;
}

/**
 * Shortest-longitude step, including across the antimeridian.
 * @param {number} a
 * @param {number} b
 * @param {number} u
 * @returns {number}
 */
export function lerpLon(a, b, u) {
  let delta = b - a;
  if (delta > 180) delta -= 360;
  else if (delta < -180) delta += 360;
  let lon = a + delta * u;
  if (lon > 180) lon -= 360;
  else if (lon <= -180) lon += 360;
  return lon;
}

/**
 * Shortest-arc heading in degrees, wrapped to [0, 360).
 * @param {number} a
 * @param {number} b
 * @param {number} u
 * @returns {number}
 */
export function lerpHeading(a, b, u) {
  const aOk = Number.isFinite(a);
  const bOk = Number.isFinite(b);
  if (aOk && bOk) {
    const delta = ((((b - a) % 360) + 540) % 360) - 180;
    return (((a + delta * u) % 360) + 360) % 360;
  }
  if (aOk) return ((a % 360) + 360) % 360;
  if (bOk) return ((b % 360) + 360) % 360;
  return Number.NaN;
}
