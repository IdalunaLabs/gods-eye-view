/**
 * Run capture work after the poll that produced it, off the render path.
 * @param {() => void} work
 * @returns {void}
 */
export function scheduleHistoryWork(work) {
  const idle = globalThis.requestIdleCallback;
  if (typeof idle === 'function') {
    idle(() => work());
    return;
  }
  setTimeout(work, 0);
}

/**
 * Copy a reconciled poll and append it on a later turn.
 * @param {object} store
 * @param {(work: () => void) => void} [schedule]
 */
export function createHistoryCapture(store, schedule = scheduleHistoryWork) {
  return {
    /**
     * @param {'flights'|'vessels'} layer
     * @param {Array<object>} records
     * @param {number} tMs
     * @returns {void}
     */
    noteRecords(layer, records, tMs) {
      if (!records || records.length === 0) return;
      const copy = new Array(records.length);
      for (let i = 0; i < records.length; i += 1) {
        const row = records[i];
        copy[i] = {
          id: row.id,
          lat: row.lat,
          lon: row.lon,
          alt: row.alt,
          heading: row.heading,
          speed: row.speed,
          callsign: row.callsign || '',
          name: row.name || '',
          type: row.type || '',
        };
      }
      schedule(() => store.append(layer, copy, tMs));
    },
  };
}
