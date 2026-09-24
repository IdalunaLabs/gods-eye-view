import test from 'node:test';
import assert from 'node:assert/strict';
import { createTerrainHeights } from '../services/terrainHeights.js';
import {
  rememberTerrainHeight,
  touchTerrainHeight,
} from '../services/terrainHeights.js';

test('terrain height LRU evicts the oldest entry and a read refreshes recency', async () => {
  const cache = new Map();
  rememberTerrainHeight(cache, 'a', { ellipsoid: 1 }, 2);
  rememberTerrainHeight(cache, 'b', { ellipsoid: 2 }, 2);
  touchTerrainHeight(cache, 'a');
  rememberTerrainHeight(cache, 'c', { ellipsoid: 3 }, 2);
  assert.deepEqual([...cache.keys()], ['a', 'c']);

  const heights = [];
  const terrain = createTerrainHeights({
    cacheCapacity: 2,
    source: {
      async getHeights(chunk) {
        return chunk.map(() => ({ ellipsoid: 42 }));
      },
    },
  });
  const resolved = await terrain.resolveEllipsoidalGround([
    { lat: 10, lon: 20 },
    { lat: 11, lon: 21 },
    { lat: 12, lon: 22 },
  ]);
  assert.equal(resolved.length, 3);
  assert.equal(resolved[0].source, 'unresolved');
  assert.equal(resolved[2].ellipsoid, 42);
  terrain.cachedEllipsoidalGround(12, 22);
  await terrain.resolveEllipsoidalGround([{ lat: 13, lon: 23 }]);
  assert.equal(terrain.cachedEllipsoidalGround(12, 22), 42);
  assert.equal(terrain.cachedEllipsoidalGround(11, 21), null);
  assert.equal(heights.length, 0);
});
