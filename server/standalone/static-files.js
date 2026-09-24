import { createReadStream } from 'node:fs';
import { stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { requestPathname } from './middleware.js';

const MIME_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.geojson': 'application/geo+json',
  '.gif': 'image/gif',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.ktx2': 'image/ktx2',
  '.map': 'application/json',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml',
});

const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

/**
 * MIME type for a static file name.
 * @param {string} filePath
 */
export function contentTypeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return MIME_TYPES[extension] || 'application/octet-stream';
}

/**
 * Cache policy for a path relative to `dist/`.
 * Hashed Vite assets and copied Cesium static files are immutable.
 * `index.html` is revalidated. Other files may be cached briefly.
 * @param {string} relativePath
 */
export function staticCacheControl(relativePath) {
  const normalized = String(relativePath || '')
    .split(path.sep)
    .join('/');
  if (normalized === 'index.html') return 'no-cache';
  if (normalized.startsWith('assets/') || normalized.startsWith('cesium/'))
    return IMMUTABLE_CACHE;
  return 'public, max-age=3600';
}

/** True for `/api` and `/api/...`, not for `/apiary`. */
export function isApiPath(pathname) {
  const value = String(pathname || '').toLowerCase();
  return value === '/api' || value.startsWith('/api/');
}

/** True when the last URL segment looks like a file name. */
export function isFileLikePath(pathname) {
  const segments = String(pathname || '')
    .split('/')
    .filter(Boolean);
  const last = segments[segments.length - 1] || '';
  return last.includes('.');
}

/**
 * Whether a missing path should serve the application shell.
 * @param {{ method?: string, pathname?: string }} request
 */
export function spaFallbackAllowed({ method, pathname }) {
  if (method !== 'GET' && method !== 'HEAD') return false;
  if (isApiPath(pathname)) return false;
  if (isFileLikePath(pathname)) return false;
  return true;
}

/**
 * Classify a URL pathname before it is joined onto the static root.
 * Traversal, dotfiles, and undecodable paths never touch the filesystem.
 * @param {string} rawPathname
 * @returns {{ kind: 'invalid' | 'forbidden' } | { kind: 'ok', segments: string[], relative: string }}
 */
export function classifyStaticPath(rawPathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(rawPathname || '/'));
  } catch {
    return { kind: 'invalid' };
  }
  if (decoded.includes('\0') || decoded.includes('\\'))
    return { kind: 'invalid' };
  const segments = [];
  for (const segment of decoded.split('/')) {
    if (segment === '') continue;
    if (
      segment === '.' ||
      segment === '..' ||
      segment.startsWith('.') ||
      segment.includes(':')
    )
      return { kind: 'forbidden' };
    segments.push(segment);
  }
  return { kind: 'ok', segments, relative: segments.join('/') };
}

/**
 * Resolve a static file inside `root`, or explain why it must not be served.
 * @param {string} root
 * @param {string} rawPathname
 */
export function resolveStaticPath(root, rawPathname) {
  const classified = classifyStaticPath(rawPathname);
  if (classified.kind !== 'ok') return classified;
  const rootResolved = path.resolve(root);
  const candidate = path.resolve(rootResolved, ...classified.segments);
  const relativeToRoot = path.relative(rootResolved, candidate);
  if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
    return { kind: 'forbidden' };
  }
  return {
    kind: 'ok',
    segments: classified.segments,
    relative: classified.relative,
    file: candidate,
  };
}

function send(req, res, status, headers, body) {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

async function fileInsideRoot(rootReal, candidate) {
  let real;
  try {
    real = await realpath(candidate);
  } catch (error) {
    if (error?.code === 'ENOENT') return { kind: 'missing' };
    throw error;
  }
  const relative = path.relative(rootReal, real);
  if (relative.startsWith('..') || path.isAbsolute(relative))
    return { kind: 'forbidden' };
  return { kind: 'ok', file: real };
}

function pipeFile(req, res, file, headers) {
  res.writeHead(200, headers);
  if ((req.method || 'GET') === 'HEAD') {
    res.end();
    return;
  }
  const stream = createReadStream(file);
  stream.on('error', () => {
    if (!res.headersSent) {
      send(
        req,
        res,
        500,
        { 'Content-Type': 'text/plain; charset=utf-8' },
        'Internal server error',
      );
    } else res.destroy();
  });
  stream.pipe(res);
}

/**
 * Serve `dist/` and fall back to `index.html` for application routes.
 * @param {string} distDir
 */
export function createStaticMiddleware(distDir) {
  const root = path.resolve(distDir);
  return async function serveStatic(req, res) {
    if (res.writableEnded) return;
    const method = req.method || 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      send(
        req,
        res,
        405,
        {
          Allow: 'GET, HEAD',
          'Content-Type': 'text/plain; charset=utf-8',
        },
        'Method not allowed',
      );
      return;
    }
    const pathname = requestPathname(req.url);
    const resolved = resolveStaticPath(root, pathname);
    if (resolved.kind === 'invalid') {
      send(
        req,
        res,
        400,
        { 'Content-Type': 'text/plain; charset=utf-8' },
        'Bad request',
      );
      return;
    }
    if (resolved.kind === 'forbidden') {
      send(
        req,
        res,
        403,
        { 'Content-Type': 'text/plain; charset=utf-8' },
        'Forbidden',
      );
      return;
    }
    try {
      const rootReal = await realpath(root);
      const target =
        resolved.segments.length === 0
          ? path.join(rootReal, 'index.html')
          : resolved.file;
      const located = await fileInsideRoot(rootReal, target);
      if (located.kind === 'forbidden') {
        send(
          req,
          res,
          403,
          { 'Content-Type': 'text/plain; charset=utf-8' },
          'Forbidden',
        );
        return;
      }
      const info =
        located.kind === 'ok'
          ? await stat(located.file).catch(() => null)
          : null;
      if (info?.isFile()) {
        const relative =
          resolved.segments.length === 0
            ? 'index.html'
            : path.relative(rootReal, located.file);
        pipeFile(req, res, located.file, {
          'Content-Type': contentTypeFor(located.file),
          'Content-Length': info.size,
          'Cache-Control': staticCacheControl(relative),
        });
        return;
      }
      if (info?.isDirectory()) {
        send(
          req,
          res,
          404,
          { 'Content-Type': 'text/plain; charset=utf-8' },
          'Not found',
        );
        return;
      }
      if (!spaFallbackAllowed({ method, pathname })) {
        const api = isApiPath(pathname);
        send(
          req,
          res,
          404,
          {
            'Content-Type': api
              ? 'application/json'
              : 'text/plain; charset=utf-8',
          },
          api ? JSON.stringify({ error: 'Unknown API route' }) : 'Not found',
        );
        return;
      }
      const indexLocated = await fileInsideRoot(
        rootReal,
        path.join(rootReal, 'index.html'),
      );
      const indexStat =
        indexLocated.kind === 'ok'
          ? await stat(indexLocated.file).catch(() => null)
          : null;
      if (!indexStat?.isFile()) {
        send(
          req,
          res,
          500,
          { 'Content-Type': 'text/plain; charset=utf-8' },
          'index.html is missing. Run npm run build before npm start.',
        );
        return;
      }
      pipeFile(req, res, indexLocated.file, {
        'Content-Type': contentTypeFor(indexLocated.file),
        'Content-Length': indexStat.size,
        'Cache-Control': 'no-cache',
      });
    } catch {
      if (!res.headersSent) {
        send(
          req,
          res,
          500,
          { 'Content-Type': 'text/plain; charset=utf-8' },
          'Internal server error',
        );
      }
    }
  };
}
