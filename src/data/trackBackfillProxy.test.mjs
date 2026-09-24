import test from 'node:test';
import assert from 'node:assert/strict';
import { trackBackfillProxies } from '../../server/providers/aircraft/tracks.js';
import {
  admitOpenSkyCreditUse,
  recordOpenSkyCreditUse,
  resetOpenSkyCreditGovernorForTests,
} from '../../server/providers/aircraft/opensky.js';

function mount(plugin) {
  const routes = new Map();
  plugin.configureServer({
    middlewares: {
      use(route, handler) {
        routes.set(route, handler);
      },
    },
  });
  return (route, url) =>
    new Promise((resolve, reject) => {
      const res = {
        statusCode: 200,
        headers: {},
        setHeader(name, value) {
          this.headers[name.toLowerCase()] = value;
        },
        writeHead(status, headers = {}) {
          this.statusCode = status;
          for (const [name, value] of Object.entries(headers)) {
            this.setHeader(name, value);
          }
        },
        end(body) {
          resolve({
            status: this.statusCode,
            headers: this.headers,
            body: String(body),
          });
        },
      };
      Promise.resolve(
        routes.get(route)(
          { url, method: 'GET', socket: { remoteAddress: '203.0.113.40' } },
          res,
        ),
      ).catch(reject);
    });
}

test('OpenSky credit governor cooldown is shared and a success clears it', () => {
  resetOpenSkyCreditGovernorForTests();
  assert.equal(admitOpenSkyCreditUse().ok, true);
  const cooled = recordOpenSkyCreditUse(429, {
    get: (name) => (name === 'x-rate-limit-retry-after-seconds' ? '45' : null),
  });
  assert.equal(cooled.cooldownMs, 45_000);
  assert.equal(admitOpenSkyCreditUse().ok, false);
  recordOpenSkyCreditUse(200, {
    get: (name) => (name === 'x-rate-limit-remaining' ? '100' : null),
  });
  assert.equal(admitOpenSkyCreditUse().ok, true);
  resetOpenSkyCreditGovernorForTests();
});

test('OpenSky track backfill spends the governor, caches only success, and 502s oversized bodies', async () => {
  const calls = [];
  const credits = [];
  let body = JSON.stringify({ path: [1] });
  let status = 200;
  let length = '';
  const request = mount(
    trackBackfillProxies({
      resolveTrackPerMin: () => '0',
      getToken: async () => 'fixture-token',
      admitCredit: () => ({ ok: true }),
      recordCredit: (code, headers) => credits.push({ code, headers }),
      fetchImpl: async (url, options) => {
        calls.push({ url: String(url), auth: options.headers.Authorization });
        return new Response(body, {
          status,
          headers: length ? { 'content-length': length } : {},
        });
      },
    }),
  );
  const ok = await request('/api/opensky-track', '?icao24=abc123');
  assert.equal(ok.status, 200);
  assert.equal(ok.body, body);
  assert.equal(calls[0].auth, 'Bearer fixture-token');
  assert.equal(credits[0].code, 200);
  const cached = await request('/api/opensky-track', '?icao24=abc123');
  assert.equal(cached.body, body);
  assert.equal(calls.length, 1);

  status = 404;
  body = 'upstream-secret-body';
  const missing = await request('/api/opensky-track', '?icao24=abc124');
  assert.equal(missing.status, 404);
  assert.equal(JSON.parse(missing.body).error, 'Track source HTTP 404');
  assert.equal(missing.body.includes('upstream-secret'), false);
  const missingAgain = await request('/api/opensky-track', '?icao24=abc124');
  assert.equal(missingAgain.status, 404);
  assert.equal(calls.length, 3);

  status = 200;
  body = 'x';
  length = String(5 * 1024 * 1024 + 1);
  const huge = await request('/api/opensky-track', '?icao24=abc125');
  assert.equal(huge.status, 502);
  assert.equal(
    JSON.parse(huge.body).error,
    'Upstream track response too large',
  );
  const hugeAgain = await request('/api/opensky-track', '?icao24=abc125');
  assert.equal(hugeAgain.status, 502);
  assert.equal(calls.length, 5);
});

test('OpenSky track honours cooldown without calling upstream', async () => {
  let fetches = 0;
  const request = mount(
    trackBackfillProxies({
      resolveTrackPerMin: () => '0',
      getToken: async () => 'token',
      admitCredit: () => ({ ok: false, retryAfterSeconds: 12 }),
      fetchImpl: async () => {
        fetches += 1;
        return Response.json({ path: [] });
      },
    }),
  );
  const cooled = await request('/api/opensky-track', '?icao24=abcdef');
  assert.equal(cooled.status, 429);
  assert.equal(cooled.headers['retry-after'], '12');
  assert.equal(
    JSON.parse(cooled.body).error,
    'OpenSky rate limited; proxy cooling down.',
  );
  assert.equal(fetches, 0);
});

test('adsb.lol trace is rate-limited and does not cache failures', async () => {
  let calls = 0;
  const request = mount(
    trackBackfillProxies({
      resolveTracePerMin: () => '2',
      fetchImpl: async () => {
        calls += 1;
        return calls === 1
          ? Response.json({ trace: [] })
          : new Response('nope', { status: 503 });
      },
    }),
  );
  assert.equal((await request('/api/adsblol/trace', '?hex=bad')).status, 400);
  const ok = await request('/api/adsblol/trace', '?hex=abc123');
  assert.equal(ok.status, 200);
  const limited = await request('/api/adsblol/trace', '?hex=abc124');
  assert.equal(limited.status, 429);
  assert.equal(calls, 1);
  const again = mount(
    trackBackfillProxies({
      resolveTracePerMin: () => '0',
      fetchImpl: async () => {
        calls += 1;
        return new Response('secret', { status: 500 });
      },
    }),
  );
  const failed = await again('/api/adsblol/trace', '?hex=def456');
  assert.equal(failed.status, 500);
  assert.equal(failed.body.includes('secret'), false);
  await again('/api/adsblol/trace', '?hex=def456');
  assert.equal(calls, 3);
});
