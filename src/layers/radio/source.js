// @ts-check
import { DIRECTORY_ENDPOINT, RADIO_UUID_RE } from './policy.js';

/** Supply directory metadata and click reporting; audio stays with the broadcaster. */
export function createRadioSource({ fetchImpl = globalThis.fetch } = {}) {
  return {
    async getDirectory(
      { signal } = /** @type {{ signal?: AbortSignal }} */ ({}),
    ) {
      signal?.throwIfAborted();
      const response = await fetchImpl(DIRECTORY_ENDPOINT, { signal });
      if (!response.ok)
        throw new Error(`Radio directory returned ${response.status}`);
      const body = await response.json();
      signal?.throwIfAborted();
      return body;
    },
    async recordClick(
      id,
      { signal } = /** @type {{ signal?: AbortSignal }} */ ({}),
    ) {
      if (typeof id !== 'string' || !RADIO_UUID_RE.test(id))
        throw new Error('Invalid radio station id');
      signal?.throwIfAborted();
      const response = await fetchImpl(
        `/api/radio/click/${encodeURIComponent(id)}`,
        {
          method: 'POST',
          signal,
        },
      );
      signal?.throwIfAborted();
      if (!response.ok)
        throw new Error(`Radio click returned ${response.status}`);
    },
  };
}
