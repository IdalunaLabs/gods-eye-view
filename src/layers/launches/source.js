// @ts-check
/** Read launch records and their optional active-orbit catalog with explicit cancellation. */
export function createLaunchSource({
  fetchImpl = (input, init) => globalThis.fetch(input, init),
} = {}) {
  return {
    async getLaunches(
      { signal } = /** @type {{ signal?: AbortSignal }} */ ({}),
    ) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/launches', { signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      signal?.throwIfAborted();
      if (!Array.isArray(payload) && !Array.isArray(payload?.results))
        throw new Error('Malformed launch snapshot');
      return payload;
    },
    async getActiveTle(
      { signal } = /** @type {{ signal?: AbortSignal }} */ ({}),
    ) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/celestrak/active', { signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      signal?.throwIfAborted();
      return text;
    },
  };
}
