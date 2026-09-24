import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadEnv } from 'vite';
import { firmsProxy } from '../../server/providers/firms.js';
import { localProviderPlugins } from '../../server/providers/local.js';
import { ensureProviderCacheDir } from '../../server/standalone/cache-dir.js';
import {
  exposureWarning,
  isLoopbackHost,
  resolveListenAddress,
} from '../../server/standalone/listen-address.js';
import {
  loadRepoDotenv,
  parseDotenvText,
} from '../../server/standalone/load-dotenv.js';
import { createMiddleware } from '../../server/standalone/middleware.js';
import {
  mountProviderPlugins,
  productionPlugins,
} from '../../server/standalone/provider-adapter.js';
import {
  createProductionServer,
  listen,
} from '../../server/standalone/production.js';
import { SECURITY_HEADERS } from '../../server/standalone/security-headers.js';
import {
  classifyStaticPath,
  contentTypeFor,
  isApiPath,
  spaFallbackAllowed,
  staticCacheControl,
} from '../../server/standalone/static-files.js';

async function fixtureRoot(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'gev-production-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeDist(root) {
  const dist = path.join(root, 'dist');
  await mkdir(path.join(dist, 'assets'), { recursive: true });
  await mkdir(path.join(dist, 'cesium', 'Workers'), { recursive: true });
  await mkdir(path.join(dist, 'nested'), { recursive: true });
  const files = {
    'index.html': '<!doctype html><title>GEV</title><p>Built application</p>',
    'logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    'app.css': 'body{}',
    'data.json': '{"ok":true}',
    'data.geojson': '{"type":"FeatureCollection","features":[]}',
    'app.webmanifest': '{"name":"GEV"}',
    'app.wasm': 'wasm',
    'model.glb': 'glb',
    'model.gltf': '{"asset":{}}',
    'app.js.map': '{"version":3}',
    '.secret': 'hidden',
    'assets/app.hash.js': 'console.log(1)\n',
    'assets/.hidden.js': 'hidden-asset',
    'cesium/Workers/chunk.js': 'self.Cesium=1\n',
    'nested/index.html': 'nested',
  };
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(path.join(dist, name), contents);
  }
  await writeFile(path.join(root, 'secret.txt'), 'outside-dist');
  return dist;
}

async function startServer(t, options) {
  const app = createProductionServer(options);
  await listen(app.server, { host: '127.0.0.1', port: 0 });
  t.after(() => app.shutdown());
  const address = app.server.address();
  return { app, origin: `http://127.0.0.1:${address.port}` };
}

function rawGet(origin, urlPath) {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: urlPath,
        method: 'GET',
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function assertSecurityHeaders(headers) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS))
    assert.equal(headers.get(name.toLowerCase()), value, name);
}

test('static path rules reject traversal and dotfiles', () => {
  assert.equal(classifyStaticPath('/assets/app.hash.js').kind, 'ok');
  assert.equal(classifyStaticPath('/../secret.txt').kind, 'forbidden');
  assert.equal(classifyStaticPath('/foo/../../etc/passwd').kind, 'forbidden');
  assert.equal(
    classifyStaticPath('/%2e%2e/%2e%2e/secret.txt').kind,
    'forbidden',
  );
  assert.equal(classifyStaticPath('/.secret').kind, 'forbidden');
  assert.equal(classifyStaticPath('/assets/.hidden.js').kind, 'forbidden');
  assert.equal(classifyStaticPath('/%2eenv').kind, 'forbidden');
  assert.equal(classifyStaticPath('/%').kind, 'invalid');
  assert.equal(isApiPath('/api'), true);
  assert.equal(isApiPath('/api/setup/status'), true);
  assert.equal(isApiPath('/apiary'), false);
  assert.equal(
    spaFallbackAllowed({ method: 'GET', pathname: '/some/deep/link' }),
    true,
  );
  assert.equal(
    spaFallbackAllowed({ method: 'HEAD', pathname: '/application-route' }),
    true,
  );
  assert.equal(
    spaFallbackAllowed({ method: 'GET', pathname: '/api/nope' }),
    false,
  );
  assert.equal(
    spaFallbackAllowed({ method: 'GET', pathname: '/missing.js' }),
    false,
  );
  assert.equal(
    spaFallbackAllowed({ method: 'POST', pathname: '/some/deep/link' }),
    false,
  );
});

test('static MIME types and cache policies', () => {
  assert.equal(contentTypeFor('app.wasm'), 'application/wasm');
  assert.equal(contentTypeFor('model.glb'), 'model/gltf-binary');
  assert.equal(contentTypeFor('model.gltf'), 'model/gltf+json');
  assert.equal(contentTypeFor('data.geojson'), 'application/geo+json');
  assert.equal(contentTypeFor('data.json'), 'application/json');
  assert.equal(contentTypeFor('app.webmanifest'), 'application/manifest+json');
  assert.equal(contentTypeFor('logo.svg'), 'image/svg+xml');
  assert.equal(contentTypeFor('app.css'), 'text/css; charset=utf-8');
  assert.equal(contentTypeFor('app.js'), 'text/javascript; charset=utf-8');
  assert.equal(contentTypeFor('app.js.map'), 'application/json');
  assert.equal(staticCacheControl('index.html'), 'no-cache');
  assert.equal(
    staticCacheControl('assets/app.hash.js'),
    'public, max-age=31536000, immutable',
  );
  assert.equal(
    staticCacheControl('cesium/Workers/chunk.js'),
    'public, max-age=31536000, immutable',
  );
  assert.equal(staticCacheControl('logo.svg').includes('immutable'), false);
});

test('listen defaults stay on loopback unless the process is in a container', () => {
  assert.deepEqual(resolveListenAddress({}), {
    host: 'localhost',
    port: 4173,
    inContainer: false,
  });
  assert.deepEqual(resolveListenAddress({ GEV_IN_CONTAINER: '1' }), {
    host: '0.0.0.0',
    port: 4173,
    inContainer: true,
  });
  assert.equal(
    resolveListenAddress({
      GEV_IN_CONTAINER: '1',
      HOST: '127.0.0.1',
      PORT: '4305',
    }).host,
    '127.0.0.1',
  );
  assert.equal(resolveListenAddress({ PORT: '4305' }).port, 4305);
  assert.equal(resolveListenAddress({ PORT: 'nope' }).port, 4173);
  assert.equal(resolveListenAddress({ PORT: '0' }).port, 4173);
  assert.equal(
    resolveListenAddress({ GEV_IN_CONTAINER: 'true' }).host,
    'localhost',
  );
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
  assert.equal(exposureWarning({ HOST: 'localhost' }, 'localhost'), '');
  assert.equal(exposureWarning({}, '127.0.0.1'), '');
  const warning = exposureWarning({}, '0.0.0.0');
  assert.match(warning, /GEV_RATELIMIT_OPENAI_PER_MIN/);
  assert.match(warning, /GEV_RATELIMIT_GOOGLE_PER_MIN/);
  assert.match(warning, /SECURITY\.md/);
  assert.equal(
    exposureWarning(
      {
        GEV_RATELIMIT_OPENAI_PER_MIN: '30',
        GEV_RATELIMIT_GOOGLE_PER_MIN: '60',
      },
      '0.0.0.0',
    ),
    '',
  );
  assert.match(
    exposureWarning({ GEV_RATELIMIT_OPENAI_PER_MIN: '30' }, '0.0.0.0'),
    /GEV_RATELIMIT_GOOGLE_PER_MIN/,
  );
});

test('dotenv parsing does not execute shell and lets existing env win', async (t) => {
  const root = await fixtureRoot(t);
  const marker = path.join(root, 'must-not-exist');
  await writeFile(
    path.join(root, '.env'),
    [
      'PLAIN_KEY=plain-value',
      'QUOTED_KEY="quoted value"',
      `SHELL_PAYLOAD=$(touch ${marker})`,
      'BACKTICK_PAYLOAD=`printf owned`',
      'EMPTY_KEY=from-file',
      'NEW_KEY=from-file',
    ].join('\n'),
  );
  await writeFile(path.join(root, '.env.local'), 'NEW_KEY=from-local\n');
  await writeFile(path.join(root, '.env.production'), 'MODE_KEY=production\n');
  const parsed = parseDotenvText(
    await readFile(path.join(root, '.env'), 'utf8'),
  );
  assert.equal(parsed.PLAIN_KEY, 'plain-value');
  assert.equal(parsed.QUOTED_KEY, 'quoted value');
  assert.equal(parsed.SHELL_PAYLOAD, `$(touch ${marker})`);
  assert.equal(parsed.BACKTICK_PAYLOAD, 'printf owned');
  const env = { PLAIN_KEY: 'from-env', EMPTY_KEY: '' };
  loadRepoDotenv(root, env, 'development');
  assert.equal(env.PLAIN_KEY, 'from-env');
  assert.equal(env.EMPTY_KEY, '');
  assert.equal(env.NEW_KEY, 'from-local');
  assert.equal(env.QUOTED_KEY, 'quoted value');
  assert.equal(Object.hasOwn(env, 'MODE_KEY'), false);
  loadRepoDotenv(root, env, 'production');
  assert.equal(env.MODE_KEY, 'production');
  await assert.rejects(readFile(marker, 'utf8'));
});

test('dotenv expansion matches Vite for the same files', async (t) => {
  const root = await fixtureRoot(t);
  const body = [
    'OTHER=from-file',
    'DOUBLE="${OTHER}"',
    'PLAIN=$OTHER',
    'DEFAULT=${MISSING:-fallback}',
    'UNSET=${MISSING-fallback2}',
    'ESC=prefix\\$OTHER',
    'EMPTY_DEFAULT=${MISSING:+set}',
    "SINGLE='${NOT_EXPANDED}'",
  ].join('\n');
  await writeFile(path.join(root, '.env'), `${body}\n`);
  const keys = [
    'OTHER',
    'DOUBLE',
    'PLAIN',
    'DEFAULT',
    'UNSET',
    'ESC',
    'EMPTY_DEFAULT',
    'SINGLE',
    'MISSING',
    'NOT_EXPANDED',
  ];
  const saved = new Map();
  for (const key of keys) {
    if (Object.hasOwn(process.env, key)) saved.set(key, process.env[key]);
    delete process.env[key];
  }
  t.after(() => {
    for (const key of keys) {
      if (saved.has(key)) process.env[key] = saved.get(key);
      else delete process.env[key];
    }
  });
  const env = {};
  loadRepoDotenv(root, env, 'development');
  const viteEnv = loadEnv('development', root, '');
  for (const key of [
    'OTHER',
    'DOUBLE',
    'PLAIN',
    'DEFAULT',
    'UNSET',
    'ESC',
    'EMPTY_DEFAULT',
    'SINGLE',
  ])
    assert.equal(env[key], viteEnv[key], key);
});

test('provider cache directory follows GEV_CACHE_DIR through .gev-cache', async (t) => {
  const cwd = await fixtureRoot(t);
  const target = path.join(cwd, 'volume');
  const used = ensureProviderCacheDir({ cwd, cacheDir: target });
  assert.equal(realpathSync(used), realpathSync(target));
  assert.equal(lstatSync(path.join(cwd, '.gev-cache')).isSymbolicLink(), true);
  writeFileSync(path.join(cwd, '.gev-cache', 'celestrak-stations.json'), '{}');
  assert.equal(
    readFileSync(path.join(target, 'celestrak-stations.json'), 'utf8'),
    '{}',
  );
  const plain = path.join(cwd, 'plain');
  mkdirSync(plain);
  const local = ensureProviderCacheDir({ cwd: plain });
  assert.equal(lstatSync(local).isSymbolicLink(), false);
  assert.equal(local, path.join(plain, '.gev-cache'));
});

test('the adapter mounts preview hooks in order and skips Provider Settings', async (t) => {
  const order = [];
  const plugins = [
    {
      name: 'first',
      configureServer() {
        order.push('dev-first');
      },
      configurePreviewServer(server) {
        order.push('mount-first');
        server.middlewares.use((req, res, next) => {
          order.push('run-first');
          next();
        });
      },
    },
    {
      name: 'gev-key-setup',
      configureServer() {
        order.push('setup');
      },
    },
    {
      name: 'second',
      configureServer(server) {
        order.push('mount-second');
        server.middlewares.use('/api/item', (req, res) => {
          order.push(`run-second:${req.url}`);
          res.end(req.url);
        });
      },
    },
  ];
  assert.deepEqual(
    productionPlugins(plugins).map((plugin) => plugin.name),
    ['first', 'second'],
  );
  const root = await fixtureRoot(t);
  const dist = await writeDist(root);
  const { origin } = await startServer(t, {
    root,
    distDir: dist,
    plugins,
    version: '9.9.9',
  });
  assert.deepEqual(order, ['mount-first', 'mount-second']);
  const response = await fetch(`${origin}/api/item/stations?x=1`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '/stations?x=1');
  assert.deepEqual(order.slice(2), ['run-first', 'run-second:/stations?x=1']);
});

test('the production server serves the built app, health, and API fallbacks', async (t) => {
  const root = await fixtureRoot(t);
  const dist = await writeDist(root);
  const events = [];
  const previousFirms = process.env.FIRMS_MAP_KEY;
  delete process.env.FIRMS_MAP_KEY;
  t.after(() => {
    if (previousFirms === undefined) delete process.env.FIRMS_MAP_KEY;
    else process.env.FIRMS_MAP_KEY = previousFirms;
  });
  const { app, origin } = await startServer(t, {
    root,
    distDir: dist,
    version: '9.9.9',
    plugins: [
      firmsProxy(),
      {
        name: 'gev-key-setup',
        configureServer(server) {
          server.middlewares.use('/api/setup/status', (_req, res) => {
            res.end('should-not-mount');
          });
        },
      },
      {
        name: 'widget',
        configurePreviewServer(server) {
          server.httpServer.on('close', () => events.push('http-close'));
          server.middlewares.use('/api/widget', (_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"ok":true}');
          });
        },
        shutdown() {
          events.push('shutdown');
        },
        closeBundle() {
          events.push('close-bundle');
        },
      },
    ],
  });

  const health = await fetch(`${origin}/healthz`);
  assert.equal(health.status, 200);
  assert.match(health.headers.get('content-type'), /application\/json/);
  assert.equal(health.headers.get('cache-control'), 'no-store');
  assertSecurityHeaders(health.headers);
  const healthBody = await health.json();
  assert.equal(healthBody.ok, true);
  assert.equal(healthBody.version, '9.9.9');
  assert.equal(typeof healthBody.uptimeSeconds, 'number');
  assert.ok(healthBody.uptimeSeconds >= 0);

  const home = await fetch(`${origin}/`);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /text\/html/);
  assert.equal(home.headers.get('cache-control'), 'no-cache');
  assertSecurityHeaders(home.headers);
  assert.match(await home.text(), /Built application/);

  const head = await fetch(`${origin}/`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.match(head.headers.get('content-type'), /text\/html/);
  assert.equal(await head.text(), '');

  const deep = await fetch(`${origin}/some/deep/link`);
  assert.equal(deep.status, 200);
  assert.match(deep.headers.get('content-type'), /text\/html/);
  assert.equal(deep.headers.get('cache-control'), 'no-cache');
  assert.match(await deep.text(), /Built application/);

  const apiary = await fetch(`${origin}/apiary`);
  assert.equal(apiary.status, 200);
  assert.match(await apiary.text(), /Built application/);

  const missing = await fetch(`${origin}/missing.js`);
  assert.equal(missing.status, 404);
  assert.equal(await missing.text(), 'Not found');

  const directory = await fetch(`${origin}/cesium/Workers`);
  assert.equal(directory.status, 404);
  assert.equal(await directory.text(), 'Not found');

  const unknown = await fetch(`${origin}/api/nope`);
  assert.equal(unknown.status, 404);
  assert.match(unknown.headers.get('content-type'), /application\/json/);
  assert.equal(unknown.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await unknown.json(), { error: 'Unknown API route' });
  assertSecurityHeaders(unknown.headers);

  const setup = await fetch(`${origin}/api/setup/status`);
  assert.equal(setup.status, 404);
  assert.deepEqual(await setup.json(), { error: 'Unknown API route' });
  const setupWrite = await fetch(`${origin}/api/setup/keys`, {
    method: 'POST',
  });
  assert.equal(setupWrite.status, 404);
  assert.deepEqual(await setupWrite.json(), { error: 'Unknown API route' });

  const widget = await fetch(`${origin}/api/widget`);
  assert.equal(widget.status, 200);
  assert.deepEqual(await widget.json(), { ok: true });
  assertSecurityHeaders(widget.headers);

  const firms = await fetch(`${origin}/api/firms/status`);
  assert.equal(firms.status, 200);
  assert.match(firms.headers.get('content-type'), /application\/json/);
  assert.equal((await firms.json()).hasKey, false);

  const hashed = await fetch(`${origin}/assets/app.hash.js`);
  assert.equal(hashed.status, 200);
  assert.match(hashed.headers.get('content-type'), /javascript/);
  assert.equal(
    hashed.headers.get('cache-control'),
    'public, max-age=31536000, immutable',
  );
  assert.equal(await hashed.text(), 'console.log(1)\n');

  const cesium = await fetch(`${origin}/cesium/Workers/chunk.js`);
  assert.equal(
    cesium.headers.get('cache-control'),
    'public, max-age=31536000, immutable',
  );

  const logo = await fetch(`${origin}/logo.svg`);
  assert.match(logo.headers.get('content-type'), /image\/svg\+xml/);
  assert.equal(logo.headers.get('cache-control'), 'public, max-age=3600');

  for (const [route, type] of [
    ['/app.css', 'text/css'],
    ['/data.json', 'application/json'],
    ['/data.geojson', 'application/geo+json'],
    ['/app.webmanifest', 'application/manifest+json'],
    ['/app.wasm', 'application/wasm'],
    ['/model.glb', 'model/gltf-binary'],
    ['/model.gltf', 'model/gltf+json'],
    ['/app.js.map', 'application/json'],
  ]) {
    const response = await fetch(origin + route);
    assert.equal(response.status, 200, route);
    assert.equal(
      response.headers.get('content-type').split(';')[0],
      type,
      route,
    );
  }

  for (const route of [
    '/../secret.txt',
    '/%2e%2e/secret.txt',
    '/.secret',
    '/assets/.hidden.js',
    '/%2eenv',
    '/%',
  ]) {
    const response = await rawGet(origin, route);
    assert.equal(response.status, route === '/%' ? 400 : 403, route);
    assert.equal(response.body.includes('outside-dist'), false);
    assert.equal(response.body.includes('hidden'), false);
  }

  const posted = await fetch(`${origin}/some/deep/link`, { method: 'POST' });
  assert.equal(posted.status, 405);

  await app.shutdown();
  assert.deepEqual(events, ['shutdown', 'http-close']);
  await assert.rejects(fetch(`${origin}/healthz`));
});

test('mountProviderPlugins prefers the preview hook on a bare stack', () => {
  const seen = [];
  const middlewares = createMiddleware();
  mountProviderPlugins(
    { middlewares, config: { mode: 'production' }, httpServer: { on() {} } },
    [
      {
        name: 'both',
        configureServer() {
          seen.push('server');
        },
        configurePreviewServer() {
          seen.push('preview');
        },
      },
    ],
  );
  assert.deepEqual(seen, ['preview']);
});

test('shipped local providers are mounted without Provider Settings', () => {
  const plugins = productionPlugins(localProviderPlugins());
  assert.equal(
    plugins.some((plugin) => plugin.name === 'gev-key-setup'),
    false,
  );
  assert.ok(plugins.some((plugin) => plugin.name === 'firms-proxy'));
  assert.ok(plugins.some((plugin) => plugin.name === 'celestrak-proxy'));
  for (const plugin of plugins) {
    assert.equal(
      typeof (plugin.configurePreviewServer || plugin.configureServer),
      'function',
      plugin.name,
    );
  }
});

test('an existing cache directory is not replaced by a symlink', async (t) => {
  const cwd = await fixtureRoot(t);
  mkdirSync(path.join(cwd, '.gev-cache'), { recursive: true });
  writeFileSync(path.join(cwd, '.gev-cache', 'keep.json'), 'kept');
  const used = ensureProviderCacheDir({
    cwd,
    cacheDir: path.join(cwd, 'other'),
  });
  assert.equal(used, path.resolve(cwd, '.gev-cache'));
  assert.equal(lstatSync(used).isSymbolicLink(), false);
  assert.equal(readFileSync(path.join(used, 'keep.json'), 'utf8'), 'kept');
});
