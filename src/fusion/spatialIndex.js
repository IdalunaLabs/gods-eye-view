import { clampLat, haversineKm, wrapLon } from './geo.js';

/**
 * Uniform latitude/longitude grid index.
 *
 * Coordinates live in growable Float64Arrays. Cell membership is an Int32Array
 * of slot indexes per cell. Latitude cells clamp at the poles so ±90° does not
 * fall into an empty cell past the last in-range row. Longitude wraps into
 * [-180, 180), and +180° shares the antimeridian cell with -180°.
 */

/**
 * @param {object} [options]
 * @param {number} [options.cellDegrees=1] Cell edge in degrees. Must be positive and at most 90.
 * @param {number} [options.capacity=1024] Initial coordinate capacity.
 * @returns {object} Index with insert, update, remove, clear, queryRadiusKm, queryBbox, nearestK.
 */
export function createSpatialIndex({
  cellDegrees = 1,
  capacity: initialCapacity = 1024,
} = {}) {
  if (!Number.isFinite(cellDegrees) || cellDegrees <= 0 || cellDegrees > 90) {
    throw new RangeError('cellDegrees must be in (0, 90]');
  }
  let capacity = Math.max(8, Math.floor(initialCapacity) || 1024);
  let lat = new Float64Array(capacity);
  let lon = new Float64Array(capacity);
  /** @type {Array<string|number|undefined>} */
  const ids = new Array(capacity);
  /** @type {Array<string|undefined>} */
  const cellOf = new Array(capacity);
  /** @type {Map<string, {arr: Int32Array, n: number}>} */
  const cells = new Map();
  /** @type {Map<string|number, number>} */
  const idToSlot = new Map();
  /** @type {number[]} */
  const free = [];
  let high = 0;

  const minLatIndex = latIndex(-90);
  const maxLatIndex = latIndex(90);
  const minLonIndex = lonIndex(-180);
  const maxLonIndex = lonIndex(180 - 1e-9);

  /**
   * @param {number} latitude
   * @returns {number}
   */
  function latIndex(latitude) {
    const clamped = clampLat(latitude);
    const probe =
      clamped >= 90 ? 90 - 1e-9 : clamped <= -90 ? -90 + 1e-9 : clamped;
    return Math.floor(probe / cellDegrees);
  }

  /**
   * @param {number} longitude
   * @returns {number}
   */
  function lonIndex(longitude) {
    return Math.floor(wrapLon(longitude) / cellDegrees);
  }

  /**
   * @param {number} latitude
   * @param {number} longitude
   * @returns {string}
   */
  function cellKey(latitude, longitude) {
    return `${latIndex(latitude)}:${lonIndex(longitude)}`;
  }

  function grow() {
    const next = capacity * 2;
    const nextLat = new Float64Array(next);
    const nextLon = new Float64Array(next);
    nextLat.set(lat);
    nextLon.set(lon);
    lat = nextLat;
    lon = nextLon;
    capacity = next;
  }

  function alloc() {
    if (free.length) return free.pop();
    if (high >= capacity) grow();
    return high++;
  }

  function addSlot(key, slot) {
    let cell = cells.get(key);
    if (!cell) {
      cell = { arr: new Int32Array(8), n: 0 };
      cells.set(key, cell);
    }
    if (cell.n === cell.arr.length) {
      const grown = new Int32Array(cell.arr.length * 2);
      grown.set(cell.arr);
      cell.arr = grown;
    }
    cell.arr[cell.n] = slot;
    cell.n += 1;
  }

  function removeSlot(key, slot) {
    const cell = cells.get(key);
    if (!cell) return;
    for (let i = 0; i < cell.n; i += 1) {
      if (cell.arr[i] !== slot) continue;
      cell.n -= 1;
      cell.arr[i] = cell.arr[cell.n];
      if (cell.n === 0) cells.delete(key);
      return;
    }
  }

  function place(slot, latitude, longitude) {
    const key = cellKey(latitude, longitude);
    const previous = cellOf[slot];
    lat[slot] = clampLat(latitude);
    lon[slot] = wrapLon(longitude);
    if (previous === key) return;
    if (previous) removeSlot(previous, slot);
    addSlot(key, slot);
    cellOf[slot] = key;
  }

  /**
   * @param {string|number} id
   * @param {number} latitude
   * @param {number} longitude
   * @returns {boolean} False when the coordinate is not finite.
   */
  function insert(id, latitude, longitude) {
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
    if (idToSlot.has(id)) {
      place(idToSlot.get(id), latitude, longitude);
      return true;
    }
    const slot = alloc();
    idToSlot.set(id, slot);
    ids[slot] = id;
    cellOf[slot] = undefined;
    place(slot, latitude, longitude);
    return true;
  }

  /**
   * @param {string|number} id
   * @param {number} latitude
   * @param {number} longitude
   * @returns {boolean} False when the id is absent or the coordinate is not finite.
   */
  function update(id, latitude, longitude) {
    if (!idToSlot.has(id)) return false;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
    place(idToSlot.get(id), latitude, longitude);
    return true;
  }

  /**
   * @param {string|number} id
   * @returns {boolean} False when the id is absent.
   */
  function remove(id) {
    if (!idToSlot.has(id)) return false;
    const slot = idToSlot.get(id);
    removeSlot(cellOf[slot], slot);
    idToSlot.delete(id);
    ids[slot] = undefined;
    cellOf[slot] = undefined;
    lat[slot] = NaN;
    lon[slot] = NaN;
    free.push(slot);
    return true;
  }

  function clear() {
    cells.clear();
    idToSlot.clear();
    free.length = 0;
    high = 0;
  }

  function visitCells(latCells, lonCells, visit) {
    for (const latCell of latCells) {
      for (const lonCell of lonCells) {
        const cell = cells.get(`${latCell}:${lonCell}`);
        if (!cell) continue;
        for (let i = 0; i < cell.n; i += 1) visit(cell.arr[i]);
      }
    }
  }

  function latCellsCovering(latitude, padDeg) {
    const south = latIndex(clampLat(latitude - padDeg));
    const north = latIndex(clampLat(latitude + padDeg));
    const cellsForLat = [];
    for (
      let index = Math.max(minLatIndex, south);
      index <= Math.min(maxLatIndex, north);
      index += 1
    ) {
      cellsForLat.push(index);
    }
    return cellsForLat;
  }

  function lonCellsCovering(longitude, padDeg) {
    if (padDeg >= 180) {
      const all = [];
      for (let index = minLonIndex; index <= maxLonIndex; index += 1) {
        all.push(index);
      }
      return all;
    }
    const west = lonIndex(wrapLon(longitude - padDeg));
    const east = lonIndex(wrapLon(longitude + padDeg));
    const covered = [];
    if (west <= east) {
      for (let index = west; index <= east; index += 1) covered.push(index);
      return covered;
    }
    for (let index = west; index <= maxLonIndex; index += 1)
      covered.push(index);
    for (let index = minLonIndex; index <= east; index += 1)
      covered.push(index);
    return covered;
  }

  function byDistanceThenId(a, b) {
    return (
      a.distanceKm - b.distanceKm || String(a.id).localeCompare(String(b.id))
    );
  }

  /**
   * @param {number} latitude
   * @param {number} longitude
   * @param {number} km
   * @returns {Array<{id: string|number, lat: number, lon: number, distanceKm: number}>}
   */
  function queryRadiusKm(latitude, longitude, km) {
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];
    if (!Number.isFinite(km) || km < 0) return [];
    const centerLat = clampLat(latitude);
    const centerLon = wrapLon(longitude);
    const latPad = km / 110.574 + cellDegrees;
    const poleward =
      centerLat >= 0
        ? Math.min(90, centerLat + km / 110.574)
        : Math.max(-90, centerLat - km / 110.574);
    const coversPole = Math.abs(poleward) >= 90 - 1e-8;
    const cosine = Math.cos((poleward * Math.PI) / 180);
    const lonPad = coversPole
      ? 180
      : Math.min(
          180,
          km / (111.32 * Math.max(Math.abs(cosine), 1e-6)) + cellDegrees,
        );
    const hits = [];
    visitCells(
      latCellsCovering(centerLat, latPad),
      lonCellsCovering(centerLon, lonPad),
      (slot) => {
        const distanceKm = haversineKm(
          centerLat,
          centerLon,
          lat[slot],
          lon[slot],
        );
        if (distanceKm <= km) {
          hits.push({
            id: ids[slot],
            lat: lat[slot],
            lon: lon[slot],
            distanceKm,
          });
        }
      },
    );
    hits.sort(byDistanceThenId);
    return hits;
  }

  /**
   * Inclusive bounding box. A box with west > east crosses the antimeridian.
   * @param {{west: number, south: number, east: number, north: number}} box
   * @returns {Array<{id: string|number, lat: number, lon: number}>}
   */
  function queryBbox(box) {
    if (!box) return [];
    const { west, south, east, north } = box;
    if (
      !Number.isFinite(west) ||
      !Number.isFinite(south) ||
      !Number.isFinite(east) ||
      !Number.isFinite(north)
    ) {
      return [];
    }
    const southClamped = clampLat(Math.min(south, north));
    const northClamped = clampLat(Math.max(south, north));
    const spansAllLongitudes = Math.abs(east - west) >= 360;
    const westWrapped = wrapLon(west);
    const eastWrapped = wrapLon(east);
    const wraps = !spansAllLongitudes && westWrapped > eastWrapped;
    const latCells = [];
    for (
      let index = latIndex(southClamped);
      index <= latIndex(northClamped);
      index += 1
    ) {
      latCells.push(index);
    }
    const lonCells = [];
    if (spansAllLongitudes) {
      for (let index = minLonIndex; index <= maxLonIndex; index += 1) {
        lonCells.push(index);
      }
    } else if (!wraps) {
      for (
        let index = lonIndex(westWrapped);
        index <= lonIndex(eastWrapped);
        index += 1
      ) {
        lonCells.push(index);
      }
    } else {
      for (
        let index = lonIndex(westWrapped);
        index <= maxLonIndex;
        index += 1
      ) {
        lonCells.push(index);
      }
      for (
        let index = minLonIndex;
        index <= lonIndex(eastWrapped);
        index += 1
      ) {
        lonCells.push(index);
      }
    }
    const hits = [];
    visitCells(latCells, lonCells, (slot) => {
      const pointLat = lat[slot];
      const pointLon = lon[slot];
      if (pointLat < southClamped || pointLat > northClamped) return;
      const inside = spansAllLongitudes
        ? true
        : wraps
          ? pointLon >= westWrapped || pointLon <= eastWrapped
          : pointLon >= westWrapped && pointLon <= eastWrapped;
      if (inside) hits.push({ id: ids[slot], lat: pointLat, lon: pointLon });
    });
    hits.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    return hits;
  }

  /**
   * @param {number} latitude
   * @param {number} longitude
   * @param {number} k
   * @returns {Array<{id: string|number, lat: number, lon: number, distanceKm: number}>}
   */
  function nearestK(latitude, longitude, k) {
    const count = Math.floor(Number(k));
    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      count < 1
    ) {
      return [];
    }
    let radius = Math.max(cellDegrees * 111, 1);
    let hits = [];
    while (radius <= 20020) {
      hits = queryRadiusKm(latitude, longitude, radius);
      if (hits.length >= count || radius >= 20020) break;
      radius *= 2;
    }
    return hits.slice(0, count);
  }

  return {
    insert,
    update,
    remove,
    clear,
    queryRadiusKm,
    queryBbox,
    nearestK,
    /** @returns {number} Live point count. */
    get size() {
      return idToSlot.size;
    },
    cellDegrees,
  };
}
