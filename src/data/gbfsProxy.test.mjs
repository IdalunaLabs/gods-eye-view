import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GBFS_FEED_CACHE_MAX,
  GBFS_MAX_BODY_BYTES,
  fetchGbfsUpstream,
  gbfsProxy,
  readGbfsFeedCache,
  writeGbfsFeedCache,
} from '../../server/providers/gbfs.js';
import { makeDefaultOnRateLimiter } from '../../server/providers/common/rate-limit.js';

const STATION_URL = 'https://gbfs.lyft.com/gbfs/2.3/bay/en/station_status.json';
const STATION_BODY = '{"data":{"stations":[]}}';

/**
 * A Response whose body streams `chunk` forever until the reader cancels it.
 * A zero high-water mark keeps the stream from pulling eagerly at construction,
 * so `pulls()` counts only the chunks a reader actually asked for.
 */
function endlessResponse(chunk, onCancel) {
  let pulls = 0;
  const stream = new ReadableStream(
    {
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
      },
      cancel: onCancel,
    },
    { highWaterMark: 0 },
  );
  return {
    response: new Response(stream, { status: 200 }),
    pulls: () => pulls,
  };
}

test('GBFS upstream fetch passes a direct 200 through unchanged', async () => {
  let observedOptions = null;
  const result = await fetchGbfsUpstream(STATION_URL, {
    fetchImpl: async (_url, options) => {
      observedOptions = options;
      return new Response(STATION_BODY, {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    },
  });

  assert.equal(
    observedOptions.redirect,
    'manual',
    'fetch must not follow redirects on its own',
  );
  assert.ok(observedOptions.signal instanceof AbortSignal);
  assert.deepEqual(result, {
    status: 200,
    contentType: 'application/json; charset=utf-8',
    body: STATION_BODY,
  });
});

test('GBFS upstream fetch forwards a non-redirect error status for the middleware to relay', async () => {
  const result = await fetchGbfsUpstream(STATION_URL, {
    fetchImpl: async () => new Response(null, { status: 404 }),
  });
  assert.equal(result.status, 404);
  assert.equal(
    result.contentType,
    'application/json',
    'a missing upstream content type defaults to JSON',
  );
  assert.equal(result.body, '');
});

test('GBFS upstream fetch rejects every redirect status and never fetches the target', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    let calls = 0;
    await assert.rejects(
      fetchGbfsUpstream(STATION_URL, {
        fetchImpl: async () => {
          calls += 1;
          return new Response('moved', {
            status,
            headers: {
              Location: 'https://attacker.example/station_status.json',
            },
          });
        },
      }),
      (error) =>
        error?.code === 'GBFS_REDIRECT' &&
        error.redirectHost === 'attacker.example',
      `status ${status} must be refused`,
    );
    assert.equal(
      calls,
      1,
      `status ${status}: the redirect target must not be requested`,
    );
  }
});

test('GBFS upstream fetch names the host of a relative redirect', async () => {
  await assert.rejects(
    fetchGbfsUpstream(STATION_URL, {
      fetchImpl: async () =>
        new Response(null, {
          status: 302,
          headers: { Location: '/v2/station_status.json' },
        }),
    }),
    (error) =>
      error?.code === 'GBFS_REDIRECT' && error.redirectHost === 'gbfs.lyft.com',
  );
});

test('GBFS upstream fetch rejects an oversized Content-Length before reading the body', async () => {
  const { response, pulls } = endlessResponse(new Uint8Array(1024));
  response.headers.set('Content-Length', String(GBFS_MAX_BODY_BYTES + 1));
  await assert.rejects(
    fetchGbfsUpstream(STATION_URL, { fetchImpl: async () => response }),
    (error) => error?.code === 'RESPONSE_TOO_LARGE',
  );
  assert.equal(
    pulls(),
    0,
    'the body must not be read when the declared length already exceeds the cap',
  );
});

test('GBFS upstream fetch cancels a length-less body the moment it passes the cap', async () => {
  let cancelled = false;
  const chunk = new Uint8Array(1024);
  const { response, pulls } = endlessResponse(chunk, () => {
    cancelled = true;
  });
  await assert.rejects(
    fetchGbfsUpstream(STATION_URL, {
      fetchImpl: async () => response,
      maxBytes: 4 * chunk.byteLength,
    }),
    (error) => error?.code === 'RESPONSE_TOO_LARGE',
  );
  assert.equal(
    cancelled,
    true,
    'the upstream stream must be cancelled, not drained',
  );
  assert.ok(
    pulls() <= 8,
    `only a few chunks may be read past the cap, saw ${pulls()}`,
  );
});

test('GBFS upstream fetch measures the cap in bytes and accepts a body exactly at it', async () => {
  const body = 'é'.repeat(64);
  const result = await fetchGbfsUpstream(STATION_URL, {
    fetchImpl: async () => new Response(body, { status: 200 }),
    maxBytes: Buffer.byteLength(body),
  });
  assert.equal(result.body, body);
  assert.equal(GBFS_MAX_BODY_BYTES, 5 * 1024 * 1024);
});

test('GBFS upstream fetch aborts a stalled connection with the timeout signal', async () => {
  const startedAt = Date.now();
  await assert.rejects(
    fetchGbfsUpstream(STATION_URL, {
      timeoutMs: 20,
      fetchImpl: (_url, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            'abort',
            () => reject(options.signal.reason),
            { once: true },
          );
        }),
    }),
    (error) => error?.name === 'AbortError',
  );
  assert.ok(Date.now() - startedAt < 500, 'the timeout must settle promptly');
});

test('GBFS cancels an oversized declared body without pulling it', async () => {
  let cancelled = false;
  const { response, pulls } = endlessResponse(new Uint8Array(1), () => {
    cancelled = true;
  });
  response.headers.set('Content-Length', '100');
  await assert.rejects(
    fetchGbfsUpstream(STATION_URL, {
      maxBytes: 10,
      fetchImpl: async () => response,
    }),
    { code: 'RESPONSE_TOO_LARGE' },
  );
  assert.equal(cancelled, true);
  assert.equal(pulls(), 0);
});

test('GBFS deadline includes a stalled body after successful headers', async () => {
  let cancelled = false;
  let signal;
  const response = new Response(
    new ReadableStream({
      pull() {},
      cancel() {
        cancelled = true;
      },
    }),
  );
  await assert.rejects(
    fetchGbfsUpstream(STATION_URL, {
      timeoutMs: 20,
      fetchImpl: async (_url, options) => {
        signal = options.signal;
        return response;
      },
    }),
    { name: 'AbortError' },
  );
  assert.equal(signal.aborted, true);
  assert.equal(cancelled, true);
  assert.equal(response.body.locked, false);
});

test('GBFS rejects redirects and caps bodies through both server hooks', async () => {
  const { gbfsProxy } = await import('../../server/providers/gbfs.js');
  const originalFetch = globalThis.fetch;
  try {
    for (const hook of ['configureServer', 'configurePreviewServer']) {
      let handler;
      gbfsProxy()[hook]({
        middlewares: {
          use(path, callback) {
            assert.equal(path, '/api/gbfs');
            handler = callback;
          },
        },
      });
      for (const response of [
        new Response(null, { status: 302 }),
        new Response('x', {
          headers: { 'Content-Length': String(GBFS_MAX_BODY_BYTES + 1) },
        }),
        new Response(STATION_BODY),
      ]) {
        const expectedStatus =
          response.status === 302 || response.headers.has('content-length')
            ? 502
            : 200;
        globalThis.fetch = async () => response;
        let status, body;
        await handler(
          { method: 'GET', url: '/' + encodeURIComponent(STATION_URL) },
          {
            writeHead(code) {
              status = code;
            },
            end(value) {
              body = value;
            },
          },
        );
        assert.equal(status, expectedStatus);
        if (status === 200) assert.equal(body, STATION_BODY);
        else assert.equal(typeof JSON.parse(body).error, 'string');
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GBFS per-IP limit defaults to 120/min and zero disables it', () => {
  const limited = makeDefaultOnRateLimiter(undefined, 120);
  for (let i = 0; i < 120; i += 1) assert.equal(limited('client'), true);
  assert.equal(limited('client'), false);
  assert.equal(limited('other'), true);
  assert.equal(makeDefaultOnRateLimiter('0', 120), null);
  assert.equal(makeDefaultOnRateLimiter('nope', 120)?.('client'), true);
});

test('GBFS feed cache is a bounded LRU of successful information feeds', () => {
  const cache = new Map();
  for (let i = 0; i < GBFS_FEED_CACHE_MAX + 2; i += 1) {
    writeGbfsFeedCache(cache, `feed-${i}`, {
      at: 1_000,
      ttlMs: 300_000,
      contentType: 'application/json',
      body: String(i),
    });
  }
  assert.equal(cache.size, GBFS_FEED_CACHE_MAX);
  assert.equal(readGbfsFeedCache(cache, 'feed-0', 1_000), null);
  assert.equal(readGbfsFeedCache(cache, 'feed-2', 1_000)?.body, '2');
  assert.equal(cache.keys().next().value === 'feed-2', false);
  const newest = [...cache.keys()].at(-1);
  assert.equal(newest, 'feed-2');
  writeGbfsFeedCache(cache, 'status', {
    at: 1_000,
    ttlMs: 1,
    contentType: 'application/json',
    body: 'stale',
  });
  assert.equal(readGbfsFeedCache(cache, 'status', 1_001), null);
});

function mountGbfs(plugin) {
  let handler;
  plugin.configureServer({
    middlewares: {
      use(_path, callback) {
        handler = callback;
      },
    },
  });
  return (target) =>
    new Promise((resolve) => {
      const res = {
        writeHead(code, headers) {
          this.status = code;
          this.headers = headers || {};
        },
        end(body) {
          resolve({ status: this.status, headers: this.headers, body });
        },
      };
      Promise.resolve(
        handler(
          {
            method: 'GET',
            url: '/' + encodeURIComponent(target),
            socket: { remoteAddress: '203.0.113.8' },
          },
          res,
        ),
      ).catch((error) => {
        resolve({ status: 500, headers: {}, body: error?.message || 'fail' });
      });
    });
}

test('GBFS middleware rate-limits one client and evicts the oldest cached feed', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(`{"url":${JSON.stringify(String(url))}}`, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const limited = mountGbfs(
      gbfsProxy({ resolvePerMin: () => '1', feedCacheMax: 2 }),
    );
    const target = (name) =>
      `https://${name}.publicbikesystem.net/en/station_information.json`;
    const first = await limited(target('a'));
    const second = await limited(target('b'));
    assert.equal(first.status, 200);
    assert.equal(first.headers['X-GBFS-Cache'], 'MISS');
    assert.equal(second.status, 429);
    assert.equal(JSON.parse(second.body).error, 'Rate limit exceeded');
    assert.equal(calls.length, 1);

    const cached = mountGbfs(gbfsProxy({ feedCacheMax: 2 }));
    await cached(target('a'));
    await cached(target('b'));
    await cached(target('c'));
    const before = calls.length;
    const evicted = await cached(target('a'));
    assert.equal(evicted.headers['X-GBFS-Cache'], 'MISS');
    assert.equal(calls.length, before + 1);
    const warm = await cached(target('c'));
    assert.equal(warm.headers['X-GBFS-Cache'], 'HIT');
    assert.equal(calls.length, before + 1);
    const status = await cached(
      'https://a.publicbikesystem.net/en/station_status.json',
    );
    assert.equal(status.headers['X-GBFS-Cache'], 'MISS');
    assert.equal(status.headers['Cache-Control'], 'no-store');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
