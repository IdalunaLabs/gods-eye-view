import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADSBDB_CACHE_MAX_BYTES,
  ADSBDB_CACHE_MAX_ENTRIES,
  adsbdbCallsignKey,
  adsbdbHexKey,
  adsbdbProxy,
  adsbdbRegistration,
  loadAdsbdbStore,
  rememberAdsbdbEntry,
  serializeAdsbdbCache,
} from '../../server/providers/aircraft/enrichment.js';

test('adsbdb keys accept hex, callsign, and registration and reject the rest', () => {
  assert.equal(adsbdbHexKey('ABC123'), 'abc123');
  assert.equal(adsbdbHexKey('abc123'), 'abc123');
  assert.equal(adsbdbHexKey('abc12'), '');
  assert.equal(adsbdbHexKey('abc1234'), '');
  assert.equal(adsbdbHexKey('../etc'), '');
  assert.equal(adsbdbCallsignKey('ual1'), 'UAL1');
  assert.equal(adsbdbCallsignKey('a'), 'A');
  assert.equal(adsbdbCallsignKey('TOO-LONG'), '');
  assert.equal(adsbdbCallsignKey('UA 1'), '');
  assert.equal(adsbdbRegistration('n123ab'), 'N123AB');
  assert.equal(adsbdbRegistration('G-ABCD'), 'G-ABCD');
  assert.equal(adsbdbRegistration('<script>'), null);
  assert.equal(adsbdbRegistration('has space'), null);
});

test('adsbdb memory cache evicts the least recently used entry', () => {
  const store = new Map();
  rememberAdsbdbEntry(store, 'a', { at: 1, data: 1 }, 2);
  rememberAdsbdbEntry(store, 'b', { at: 2, data: 2 }, 2);
  rememberAdsbdbEntry(store, 'a', { at: 3, data: 1 }, 2);
  rememberAdsbdbEntry(store, 'c', { at: 4, data: 3 }, 2);
  assert.deepEqual([...store.keys()], ['a', 'c']);
});

test('adsbdb disk load drops invalid keys and the flush evicts to the byte cap', () => {
  const loaded = loadAdsbdbStore(
    {
      abc123: { at: 1, data: { registration: 'N1' } },
      nope: { at: 2, data: { registration: 'N2' } },
      '../x': { at: 3, data: { registration: 'N3' } },
    },
    adsbdbHexKey,
    2,
  );
  assert.deepEqual([...loaded.keys()], ['abc123']);
  const routes = new Map();
  const aircraft = new Map();
  for (let i = 0; i < 40; i += 1) {
    aircraft.set(i.toString(16).padStart(6, '0'), {
      at: i,
      data: { typeName: 'x'.repeat(200) },
    });
  }
  const body = serializeAdsbdbCache(routes, aircraft, 800);
  assert.ok(new TextEncoder().encode(body).byteLength <= 800);
  assert.ok(aircraft.size < 40);
  assert.ok(aircraft.size > 0);
  assert.equal(ADSBDB_CACHE_MAX_ENTRIES, 2048);
  assert.equal(ADSBDB_CACHE_MAX_BYTES, 1024 * 1024);
});

function mount(plugin) {
  let handler;
  plugin.configureServer({
    middlewares: {
      use(_route, callback) {
        handler = callback;
      },
    },
  });
  return (url) =>
    new Promise((resolve, reject) => {
      const res = {
        writeHead(status, headers) {
          this.status = status;
          this.headers = headers;
        },
        end(body) {
          resolve({ status: this.status, body });
        },
      };
      Promise.resolve(
        handler(
          { url, method: 'GET', socket: { remoteAddress: '203.0.113.9' } },
          res,
        ),
      ).catch(reject);
    });
}

test('adsbdb middleware rejects bad keys, rate-limits, and does not cache them', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(String(url));
    return Response.json({
      response: {
        aircraft: {
          icao_type: 'B738',
          manufacturer: 'Boeing',
          type: '737',
          registration: '<script>',
        },
      },
    });
  });
  const request = mount(adsbdbProxy({ resolvePerMin: () => '4' }));
  const bad = await request('/route/!');
  assert.equal(bad.status, 400);
  assert.deepEqual(JSON.parse(bad.body), { error: 'invalid callsign' });
  assert.equal((await request('/type/zzzzzz')).status, 400);
  assert.equal(calls.length, 0);
  const hit = await request('/type/abc123');
  assert.equal(hit.status, 200);
  assert.equal(JSON.parse(hit.body).registration, null);
  assert.equal(JSON.parse(hit.body).typeCode, 'B738');
  const cached = await request('/type/abc123');
  assert.equal(cached.status, 200);
  assert.equal(calls.length, 1);
  const limited = await request('/type/abc124');
  assert.equal(limited.status, 429);
  assert.equal(JSON.parse(limited.body).error, 'Rate limit exceeded');
  assert.equal(calls.length, 1);
  const again = mount(adsbdbProxy({ resolvePerMin: () => '0' }));
  assert.equal((await again('/route/A')).status, 200);
  assert.equal((await again('/type/abc123')).status, 200);
});
