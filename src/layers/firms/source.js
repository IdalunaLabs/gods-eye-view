// @ts-check
/** Construct the existing live-fire endpoint without making a request. */
export function createFirmsSource({ fetchImpl = globalThis.fetch } = {}) {
  return {
    async getSnapshot(
      { signal } = /** @type {{ signal?: AbortSignal }} */ ({}),
    ) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/firms', {
        signal,
        cache: 'no-store',
      });
      let payload;
      try {
        payload = await response.json();
      } catch {
        /* status below remains authoritative */
      }
      signal?.throwIfAborted();
      if (!response.ok) {
        if (response.status === 503 && payload?.error === 'no_key')
          return { keyRequired: true };
        throw new Error(`FIRMS HTTP ${response.status}`);
      }
      if (!Array.isArray(payload?.fires))
        throw new Error('Malformed fire snapshot');
      return payload;
    },
  };
}
