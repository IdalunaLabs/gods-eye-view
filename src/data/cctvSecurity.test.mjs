import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'node:stream';
import { cctvProxy } from '../../server/providers/cctv.js';
import {
  fetchCctvImageFromUpstream,
  fetchCctvMediaUpstream,
  proxyMediaResponse,
} from '../../server/providers/cctv/media.js';
import { normalizeSourceItem } from '../../server/providers/cctv/normalize.js';
import { publicCctvUrl } from '../../server/providers/common/public-address.js';

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const privateLookup = async () => [{ address: '10.1.2.3', family: 4 }];

test('CCTV registration keeps public http(s) URLs and drops private or non-http targets', () => {
  assert.equal(
    publicCctvUrl('https://camera.example/a.jpg'),
    'https://camera.example/a.jpg',
  );
  assert.equal(publicCctvUrl('http://127.0.0.1/a.jpg'), '');
  assert.equal(publicCctvUrl('https://[::1]/a.jpg'), '');
  assert.equal(publicCctvUrl('https://10.0.0.8/a.jpg'), '');
  assert.equal(publicCctvUrl('file:///etc/passwd'), '');
  assert.equal(publicCctvUrl('https://user:pass@camera.example/a.jpg'), '');
  const source = normalizeSourceItem({
    id: 'cam',
    lat: 30,
    lon: -97,
    url: 'http://127.0.0.1/secret',
    snapshotUrl: 'https://camera.example/frame.jpg',
  });
  assert.equal(source.url, '');
  assert.equal(source.snapshotUrl, 'https://camera.example/frame.jpg');
});

test('CCTV fetches reject literal and resolved private addresses before connect', async () => {
  let fetches = 0;
  const fetchImpl = async () => {
    fetches += 1;
    return new Response(Uint8Array.from([1]), {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    });
  };
  assert.equal(
    await fetchCctvImageFromUpstream('http://127.0.0.1/a.jpg', { fetchImpl }),
    null,
  );
  assert.equal(
    await fetchCctvImageFromUpstream('https://camera.example/a.jpg', {
      fetchImpl,
      lookupImpl: privateLookup,
    }),
    null,
  );
  assert.equal(fetches, 0);
  await assert.rejects(
    fetchCctvMediaUpstream('https://camera.example/live', {
      fetchImpl,
      lookupImpl: privateLookup,
    }),
    (error) => error?.code === 'CCTV_DESTINATION_REJECTED',
  );
  const ok = await fetchCctvImageFromUpstream('https://camera.example/a.jpg', {
    fetchImpl,
    lookupImpl: publicLookup,
  });
  assert.equal(ok?.ok, true);
  assert.equal(fetches, 1);
});

test('CCTV media aborts the upstream when the byte cap or idle deadline is hit', async () => {
  const source = new Readable({
    read() {
      this.push(Buffer.alloc(8));
    },
  });
  let destroyed = false;
  source.on('close', () => {
    destroyed = true;
  });
  const res = recordingResponse();
  await proxyMediaResponse(
    res.res,
    {
      status: 200,
      headers: new Headers({ 'content-type': 'video/mp4' }),
      body: source,
    },
    { maxBytes: 8, idleMs: 5_000 },
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(destroyed, true);

  const stalled = new Readable({ read() {} });
  let idleDestroyed = false;
  stalled.on('close', () => {
    idleDestroyed = true;
  });
  await proxyMediaResponse(
    recordingResponse().res,
    {
      status: 200,
      headers: new Headers({ 'content-type': 'video/mp4' }),
      body: stalled,
    },
    { idleMs: 30 },
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(idleDestroyed, true);
});

function recordingResponse() {
  const res = new PassThrough();
  res.headers = {};
  res.writeHead = (status, headers) => {
    res.statusCode = status;
    res.headers = headers || {};
  };
  return { res };
}

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
        statusCode: 200,
        headers: {},
        writableEnded: false,
        writeHead(status, headers) {
          this.statusCode = status;
          this.headers = headers || {};
        },
        setHeader() {},
        end(body) {
          this.writableEnded = true;
          resolve({
            status: this.statusCode,
            headers: this.headers,
            body: Buffer.isBuffer(body) ? body : String(body ?? ''),
          });
        },
        write() {
          return true;
        },
        once() {},
        on() {},
        destroy() {},
      };
      Promise.resolve(
        handler(
          {
            url,
            method: 'GET',
            headers: {},
            socket: { remoteAddress: '203.0.113.77' },
          },
          res,
        ),
      ).catch(reject);
    });
}

test('Street View uses only registered coordinates and the Google limiter', async (t) => {
  const previousLimit = process.env.GEV_RATELIMIT_GOOGLE_PER_MIN;
  const previousKey = process.env.GOOGLE_MAPS_SERVER_API_KEY;
  process.env.GEV_RATELIMIT_GOOGLE_PER_MIN = '1';
  process.env.GOOGLE_MAPS_SERVER_API_KEY = 'server-key';
  t.after(() => {
    if (previousLimit === undefined)
      delete process.env.GEV_RATELIMIT_GOOGLE_PER_MIN;
    else process.env.GEV_RATELIMIT_GOOGLE_PER_MIN = previousLimit;
    if (previousKey === undefined)
      delete process.env.GOOGLE_MAPS_SERVER_API_KEY;
    else process.env.GOOGLE_MAPS_SERVER_API_KEY = previousKey;
  });
  const calls = [];
  process.env.CCTV_SOURCES_JSON = JSON.stringify([
    {
      id: 'known',
      name: 'Known',
      lat: 30.27,
      lon: -97.74,
      headingDeg: 90,
      feedType: 'image',
      url: 'https://camera.example/missing.jpg',
    },
  ]);
  process.env.CCTV_SOURCES_FILE = 'absent-source-file.json';
  process.env.CCTV_FORCE_AUSTIN = '0';
  t.after(() => {
    delete process.env.CCTV_SOURCES_JSON;
    delete process.env.CCTV_SOURCES_FILE;
    delete process.env.CCTV_FORCE_AUSTIN;
  });
  const missFetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('streetview')) {
      return new Response(Uint8Array.from([9]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      });
    }
    return new Response('no', {
      status: 404,
      headers: { 'content-type': 'text/plain' },
    });
  };
  const limited = mount(
    cctvProxy({
      lookupImpl: publicLookup,
      fetchImpl: missFetch,
    }),
  );
  const first = await limited('/frame/known?lat=0&lon=0&heading=1');
  assert.equal(
    first.headers['X-CCTV-Source'] || first.headers['x-cctv-source'],
    'streetview',
  );
  const street = new URL(calls.find((url) => url.includes('streetview')));
  assert.equal(street.searchParams.get('location'), '30.27,-97.74');
  assert.equal(street.searchParams.get('heading'), '90');
  assert.equal(street.searchParams.get('key'), 'server-key');
  const second = await limited('/frame/known');
  assert.equal(calls.filter((url) => url.includes('streetview')).length, 1);
  assert.notEqual(
    second.headers['X-CCTV-Source'] || second.headers['x-cctv-source'],
    'streetview',
  );
  const unknown = await limited('/frame/missing?lat=1&lon=2');
  assert.equal(calls.filter((url) => url.includes('streetview')).length, 1);
  assert.match(String(unknown.body), /<svg/i);
});
