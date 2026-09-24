import { createServer } from 'node:http';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { apiNotFoundPlugin } from './api-not-found.js';
import { ensureProviderCacheDir } from './cache-dir.js';
import { exposureWarning, resolveListenAddress } from './listen-address.js';
import { loadRepoDotenv } from './load-dotenv.js';
import { createMiddleware, requestPathname } from './middleware.js';
import {
  mountProviderPlugins,
  shutdownProviderPlugin,
} from './provider-adapter.js';
import { applySecurityHeaders } from './security-headers.js';
import { createStaticMiddleware, isApiPath } from './static-files.js';

/** Repository root that contains `package.json`, `dist/`, and `.env`. */
export function productionRepoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
}

/**
 * Read the package version shipped beside this module.
 * @param {string} root
 */
export function readPackageVersion(root) {
  try {
    const manifest = JSON.parse(
      readFileSync(path.join(root, 'package.json'), 'utf8'),
    );
    return String(manifest.version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}

function unknownApi(req, res) {
  res.writeHead(404, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(
    req.method === 'HEAD'
      ? undefined
      : JSON.stringify({ error: 'Unknown API route' }),
  );
}

function sendHealth(req, res, version) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, {
      Allow: 'GET, HEAD',
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : 'Method not allowed');
    return;
  }
  const body = JSON.stringify({
    ok: true,
    version,
    uptimeSeconds: Math.floor(process.uptime()),
  });
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function finish(req, res, err) {
  if (res.writableEnded) return;
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (err) console.error('[gev] request failed');
  const api = isApiPath(requestPathname(req.originalUrl || req.url || '/'));
  res.writeHead(err ? 500 : 404, {
    'Content-Type': api ? 'application/json' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  const message = err ? 'Internal server error' : 'Not found';
  res.end(
    req.method === 'HEAD'
      ? undefined
      : api
        ? JSON.stringify({ error: message })
        : message,
  );
}

/**
 * Build the production HTTP server without listening.
 * Provider plugins receive a Vite-shaped server and are mounted in order.
 * @param {{
 *   root?: string,
 *   distDir?: string,
 *   plugins?: object[],
 *   version?: string,
 *   config?: object,
 * }} [options]
 */
export function createProductionServer({
  root = productionRepoRoot(),
  distDir = path.join(root, 'dist'),
  plugins = [],
  version = readPackageVersion(root),
  config = { root, mode: 'production', command: 'serve', isPreview: true },
} = {}) {
  const middlewares = createMiddleware();
  const sockets = new Set();
  const server = createServer((req, res) => {
    applySecurityHeaders(res);
    middlewares.handle(req, res, (err) => finish(req, res, err));
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('clientError', (_error, socket) => {
    if (socket.writable)
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  const viteServer = { middlewares, config, httpServer: server };
  middlewares.use((req, res, next) => {
    if (requestPathname(req.url) !== '/healthz') {
      next();
      return;
    }
    sendHealth(req, res, version);
  });
  middlewares.use('/api/setup', unknownApi);
  const mounted = mountProviderPlugins(viteServer, plugins);
  apiNotFoundPlugin().configurePreviewServer(viteServer);
  middlewares.use(createStaticMiddleware(distDir));
  let closing = false;
  return {
    server,
    plugins: mounted,
    /**
     * Stop accepting connections, close sockets, and run provider cleanup.
     * @returns {Promise<void>}
     */
    async shutdown() {
      if (closing) return;
      closing = true;
      const pending = [];
      for (const plugin of mounted) {
        try {
          const result = shutdownProviderPlugin(plugin);
          if (result && typeof result.then === 'function') pending.push(result);
        } catch {
          console.error('[gev] provider shutdown failed');
        }
      }
      await Promise.allSettled(pending);
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          for (const socket of sockets) socket.destroy();
          resolve();
        }, 2000);
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
        for (const socket of sockets) socket.destroy();
      });
    },
  };
}

/**
 * Listen on the resolved host and port.
 * @param {import('node:http').Server} server
 * @param {{ host: string, port: number }} address
 */
export function listen(server, { host, port }) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server.address());
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  }
}

/**
 * Load `.env`, mount local providers, and listen until SIGTERM or SIGINT.
 * @param {{ root?: string, env?: NodeJS.ProcessEnv }} [options]
 */
export async function main({
  root = productionRepoRoot(),
  env = process.env,
} = {}) {
  const canonicalRoot = realpathSync(root);
  loadRepoDotenv(canonicalRoot, env);
  process.chdir(canonicalRoot);
  ensureProviderCacheDir({
    cwd: canonicalRoot,
    cacheDir: env.GEV_CACHE_DIR,
  });
  const { localProviderPlugins } = await import('../providers/local.js');
  const address = resolveListenAddress(env);
  const app = createProductionServer({
    root: canonicalRoot,
    plugins: localProviderPlugins(),
    version: readPackageVersion(canonicalRoot),
  });
  let bound;
  try {
    bound = await listen(app.server, address);
  } catch (error) {
    console.error(
      `Could not listen on ${address.host}:${address.port}: ${error?.message || error}`,
    );
    process.exitCode = 1;
    return app;
  }
  const warning = exposureWarning(env, address.host);
  if (warning) console.warn(warning);
  const shown =
    bound && typeof bound === 'object'
      ? `${address.host}:${bound.port}`
      : `${address.host}:${address.port}`;
  console.log(`God's Eye View production server listening at http://${shown}/`);
  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`Received ${signal}, shutting down`);
    app.shutdown().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
  return app;
}

if (invokedDirectly()) {
  main().catch((error) => {
    console.error('[gev] production server failed to start');
    console.error(error?.message || error);
    process.exitCode = 1;
  });
}
