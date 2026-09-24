import path from 'node:path';
import { promises as fsp } from 'node:fs';
import {
  enforceRateLimit,
  makeDefaultOnRateLimiter,
} from '../common/rate-limit.js';
/**
 * adsbdb.com enrichment proxy: callsign → route (airline + origin/destination
 * airports) and hex → aircraft type/registration. Free community API — cached
 * aggressively: ONE upstream request per new key ever (404s negative-cached),
 * persisted to disk so restarts don't re-hammer it. Adapted from skylight
 * (MIT) server/src/enrich/routes.ts.
 *
 * Keys are checked before any lookup or cache write. Memory and the flushed
 * disk file are both capped.
 */

/** In-memory entries retained per store (routes and aircraft). */
export const ADSBDB_CACHE_MAX_ENTRIES = 2048;

/** Serialized cache ceiling. Flush evicts oldest entries until this holds. */
export const ADSBDB_CACHE_MAX_BYTES = 1024 * 1024;

/** Per-IP cap when GEV_RATELIMIT_ADSBDB_PER_MIN is unset. `0` disables. */
export const ADSBDB_DEFAULT_RATE_PER_MIN = 60;

/**
 * @param {unknown} value
 * @returns {string} Uppercase callsign, or '' when the key is not `[A-Z0-9]{1,8}`.
 */
export function adsbdbCallsignKey(value) {
  const key = String(value || '').toUpperCase();
  return /^[A-Z0-9]{1,8}$/.test(key) ? key : '';
}

/**
 * @param {unknown} value
 * @returns {string} Lowercase ICAO hex, or '' when the key is not `[0-9a-f]{6}`.
 */
export function adsbdbHexKey(value) {
  const key = String(value || '').toLowerCase();
  return /^[0-9a-f]{6}$/.test(key) ? key : '';
}

/**
 * @param {unknown} value
 * @returns {string|null} Registration matching `[A-Z0-9-]{1,12}`, otherwise null.
 */
export function adsbdbRegistration(value) {
  const key = String(value || '')
    .trim()
    .toUpperCase();
  return /^[A-Z0-9-]{1,12}$/.test(key) ? key : null;
}

/**
 * Insert or refresh an entry and evict the least-recently-used keys past `maxEntries`.
 * @param {Map<string, {at:number, data:unknown}>} store
 * @param {string} key
 * @param {{at:number, data:unknown}} entry
 * @param {number} maxEntries
 */
export function rememberAdsbdbEntry(store, key, entry, maxEntries) {
  if (store.has(key)) store.delete(key);
  store.set(key, entry);
  while (store.size > maxEntries) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

/**
 * @param {unknown} raw
 * @param {(key:string)=>string} acceptKey
 * @param {number} maxEntries
 * @returns {Map<string, {at:number, data:unknown}>}
 */
export function loadAdsbdbStore(raw, acceptKey, maxEntries) {
  const store = new Map();
  if (!raw || typeof raw !== 'object') return store;
  for (const [key, entry] of Object.entries(raw)) {
    const accepted = acceptKey(key);
    if (!accepted || !entry || !Number.isFinite(entry.at)) continue;
    store.set(accepted, { at: entry.at, data: entry.data ?? null });
  }
  while (store.size > maxEntries) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
  return store;
}

/**
 * Serialize both stores, evicting oldest entries until the JSON is within `maxBytes`.
 * @param {Map<string, {at:number, data:unknown}>} routes
 * @param {Map<string, {at:number, data:unknown}>} aircraft
 * @param {number} maxBytes
 * @returns {string}
 */
export function serializeAdsbdbCache(routes, aircraft, maxBytes) {
  const payload = () =>
    JSON.stringify({
      routes: Object.fromEntries(routes),
      aircraft: Object.fromEntries(aircraft),
    });
  let body = payload();
  while (
    new TextEncoder().encode(body).byteLength > maxBytes &&
    (routes.size > 0 || aircraft.size > 0)
  ) {
    if (routes.size >= aircraft.size && routes.size > 0) {
      routes.delete(routes.keys().next().value);
    } else {
      aircraft.delete(aircraft.keys().next().value);
    }
    body = payload();
  }
  return body;
}

/**
 * @param {object} [options]
 * @param {() => string|undefined} [options.resolvePerMin]
 * @returns {import('vite').Plugin}
 */
export function adsbdbProxy(options = {}) {
  const resolvePerMin =
    options.resolvePerMin || (() => process.env.GEV_RATELIMIT_ADSBDB_PER_MIN);
  const TTL_MS = 24 * 3600_000;
  const CACHE_PATH = path.join(process.cwd(), '.gev-cache', 'adsbdb.json');
  let routes = new Map();
  let aircraft = new Map();
  let dirty = false;
  let loaded = false;
  let limiter;
  const inflight = new Map();

  function touch(store, key) {
    const entry = store.get(key);
    if (!entry) return null;
    store.delete(key);
    store.set(key, entry);
    return entry;
  }

  async function loadOnce() {
    if (loaded) return;
    loaded = true;
    try {
      const info = await fsp.stat(CACHE_PATH);
      if (info.size > ADSBDB_CACHE_MAX_BYTES * 4) throw new Error('cache');
      const parsed = JSON.parse(await fsp.readFile(CACHE_PATH, 'utf8'));
      routes = loadAdsbdbStore(
        parsed.routes,
        adsbdbCallsignKey,
        ADSBDB_CACHE_MAX_ENTRIES,
      );
      aircraft = loadAdsbdbStore(
        parsed.aircraft,
        adsbdbHexKey,
        ADSBDB_CACHE_MAX_ENTRIES,
      );
    } catch {
      /* first run or unreadable cache */
    }
    setInterval(async () => {
      if (!dirty) return;
      dirty = false;
      try {
        const body = serializeAdsbdbCache(
          routes,
          aircraft,
          ADSBDB_CACHE_MAX_BYTES,
        );
        await fsp.mkdir(path.dirname(CACHE_PATH), { recursive: true });
        await fsp.writeFile(CACHE_PATH, body, 'utf8');
      } catch {
        dirty = true;
      } // retry next tick
    }, 15_000).unref?.();
  }

  const fresh = (entry) => entry && Date.now() - entry.at < TTL_MS;

  function parseRoute(json) {
    const fr = json?.response?.flightroute;
    if (!fr?.origin || !fr?.destination) return null;
    const airport = (a) => ({
      code: a.iata_code || a.icao_code || '',
      name: a.municipality || a.name || '',
      lat: Number.isFinite(a.latitude) ? a.latitude : null,
      lon: Number.isFinite(a.longitude) ? a.longitude : null,
    });
    return {
      airline: fr.airline?.name || null,
      origin: airport(fr.origin),
      destination: airport(fr.destination),
    };
  }

  function parseAircraft(json) {
    const a = json?.response?.aircraft;
    if (!a) return null;
    return {
      typeCode: a.icao_type || null, // ICAO designator, e.g. "B738" — feeds classifyAircraft
      typeName:
        a.manufacturer && a.type
          ? `${a.manufacturer} ${a.type}`
          : a.type || null,
      registration: adsbdbRegistration(a.registration),
    };
  }

  function lookup(kind, key) {
    const store = kind === 'route' ? routes : aircraft;
    const accepted =
      kind === 'route' ? adsbdbCallsignKey(key) : adsbdbHexKey(key);
    if (!accepted) return Promise.resolve(null);
    const hit = touch(store, accepted);
    if (fresh(hit)) return Promise.resolve(hit.data);
    const ik = `${kind}:${accepted}`;
    if (!inflight.has(ik)) {
      inflight.set(
        ik,
        (async () => {
          try {
            const url =
              kind === 'route'
                ? `https://api.adsbdb.com/v0/callsign/${encodeURIComponent(accepted)}`
                : `https://api.adsbdb.com/v0/aircraft/${encodeURIComponent(accepted)}`;
            const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
            if (res.ok) {
              const data =
                kind === 'route'
                  ? parseRoute(await res.json())
                  : parseAircraft(await res.json());
              rememberAdsbdbEntry(
                store,
                accepted,
                { at: Date.now(), data },
                ADSBDB_CACHE_MAX_ENTRIES,
              );
              dirty = true;
              return data;
            }
            if (res.status === 404) {
              rememberAdsbdbEntry(
                store,
                accepted,
                { at: Date.now(), data: null },
                ADSBDB_CACHE_MAX_ENTRIES,
              );
              dirty = true;
            }
            // other statuses: leave uncached so we retry later
            const current = store.get(accepted);
            return fresh(current) ? current.data : null;
          } catch {
            const current = store.get(accepted);
            return fresh(current) ? current.data : null; // network error → stale if any
          } finally {
            inflight.delete(ik);
          }
        })(),
      );
    }
    return inflight.get(ik);
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/adsbdb', async (req, res) => {
      if (limiter === undefined) {
        limiter = makeDefaultOnRateLimiter(
          resolvePerMin(),
          ADSBDB_DEFAULT_RATE_PER_MIN,
        );
      }
      if (!enforceRateLimit(limiter, req, res)) return;
      await loadOnce();
      const send = (status, obj) => {
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(obj));
      };
      try {
        const [, kind, rawKey] = String(req.url || '')
          .split('?')[0]
          .split('/');
        if (kind === 'route') {
          const cs = adsbdbCallsignKey(rawKey);
          if (!cs) return send(400, { error: 'invalid callsign' });
          const data = await lookup('route', cs);
          return send(200, data ? { found: true, ...data } : { found: false });
        }
        if (kind === 'type') {
          const hex = adsbdbHexKey(rawKey);
          if (!hex) return send(400, { error: 'invalid hex' });
          const data = await lookup('aircraft', hex);
          return send(200, data ? { found: true, ...data } : { found: false });
        }
        return send(404, { error: 'unknown endpoint' });
      } catch {
        console.error('[adsbdb-proxy] request failed');
        return send(500, { error: 'adsbdb proxy error' });
      }
    });
  };
  return {
    name: 'adsbdb-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
