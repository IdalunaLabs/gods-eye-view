// @ts-check
import { fetchTransitHistory } from '../../sources/transitHistory.js';

/** Request transit snapshots through caller-owned transport. */
export function createTransitSource({
  fetchImpl = (input, init) => globalThis.fetch(input, init),
} = {}) {
  return {
    getHistory(
      feedId,
      vehicleId,
      { signal } = /** @type {{ signal?: AbortSignal }} */ ({}),
    ) {
      signal?.throwIfAborted();
      return fetchTransitHistory(feedId, vehicleId, signal, fetchImpl);
    },
    requestSnapshot(
      feedId,
      { signal } = /** @type {{ signal?: AbortSignal }} */ ({}),
    ) {
      signal?.throwIfAborted();
      if (typeof feedId !== 'string' || !feedId || feedId.length > 160)
        throw new TypeError('A transit feed identifier is required');
      return Promise.resolve(
        fetchImpl(`/api/transit/vehicles/${encodeURIComponent(feedId)}`, {
          signal,
          headers: { Accept: 'application/json' },
        }),
      ).then((response) => {
        signal?.throwIfAborted();
        return {
          ok: response.ok,
          status: response.status,
          headers: response.headers,
          async json() {
            const body = await response.json();
            signal?.throwIfAborted();
            return body;
          },
        };
      });
    },
  };
}
