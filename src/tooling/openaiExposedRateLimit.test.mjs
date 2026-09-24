import test from 'node:test';
import assert from 'node:assert/strict';
import { createRealtimeTokenHandler } from '../../server/providers/openai/realtime.js';
import {
  isLoopbackBindHost,
  openAiRateLimitPerMin,
} from '../../server/providers/openai/rate-limit.js';

function invoke(handler, address) {
  return new Promise((resolve, reject) => {
    const req = {
      method: 'GET',
      url: '/',
      socket: { remoteAddress: address },
    };
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(name, value) {
        this.headers[name.toLowerCase()] = value;
      },
      end(body) {
        resolve({ status: this.statusCode, body: String(body) });
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

test('loopback hosts stay unlimited and other binds default to 10/min', () => {
  for (const host of [
    undefined,
    '',
    'localhost',
    '127.0.0.1',
    '::1',
    '[::1]',
  ]) {
    assert.equal(isLoopbackBindHost(host), true, String(host));
    assert.equal(openAiRateLimitPerMin(undefined, host), '');
  }
  for (const host of ['0.0.0.0', '::', '192.168.1.20', 'example.test']) {
    assert.equal(isLoopbackBindHost(host), false, host);
    assert.equal(openAiRateLimitPerMin('', host), '10');
  }
  assert.equal(openAiRateLimitPerMin('0', '0.0.0.0'), '0');
  assert.equal(openAiRateLimitPerMin('30', '0.0.0.0'), '30');
});

test('a non-loopback bind rate-limits realtime token minting when the env cap is unset', async (t) => {
  const previousHost = process.env.HOST;
  const previousLimit = process.env.GEV_RATELIMIT_OPENAI_PER_MIN;
  process.env.HOST = '0.0.0.0';
  delete process.env.GEV_RATELIMIT_OPENAI_PER_MIN;
  t.after(() => {
    if (previousHost === undefined) delete process.env.HOST;
    else process.env.HOST = previousHost;
    if (previousLimit === undefined)
      delete process.env.GEV_RATELIMIT_OPENAI_PER_MIN;
    else process.env.GEV_RATELIMIT_OPENAI_PER_MIN = previousLimit;
  });
  const handler = createRealtimeTokenHandler({
    resolveApiKey: () => 'server-side-key',
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers.Authorization, 'Bearer server-side-key');
      return Response.json({ value: 'ephemeral-not-the-key' });
    },
  });
  for (let i = 0; i < 10; i += 1) {
    const response = await invoke(handler, '203.0.113.50');
    assert.equal(response.status, 200);
    assert.equal(response.body.includes('server-side-key'), false);
  }
  const blocked = await invoke(handler, '203.0.113.50');
  assert.equal(blocked.status, 429);
  assert.deepEqual(JSON.parse(blocked.body), { error: 'Rate limit exceeded' });
  const other = await invoke(handler, '203.0.113.51');
  assert.equal(other.status, 200);

  process.env.HOST = '127.0.0.1';
  for (let i = 0; i < 12; i += 1) {
    assert.equal((await invoke(handler, '203.0.113.52')).status, 200);
  }
});
