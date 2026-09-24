import {
  admitOpenSkyCreditUse,
  getOpenSkyToken,
  recordOpenSkyCreditUse,
} from './opensky.js';
import { readCappedResponseText } from '../common/http.js';
import {
  enforceRateLimit,
  makeDefaultOnRateLimiter,
} from '../common/rate-limit.js';
/**
 * Vite plugin: aircraft track-history backfill proxies (PRD WS-F F1/F2).
 *
 * /api/opensky-track?icao24=<hex6> — OpenSky GET /tracks/all (experimental;
 *   4 credits per call on the free tier). Shares the OpenSky credit governor
 *   and the coalesced OAuth refresh. 60s per-icao cache of successful bodies
 *   only; 404/429 are forwarded unsanitized-of-status so the client can fall
 *   back, but they are not cached.
 * /api/adsblol/trace?hex=<hex> — adsb.lol tar1090 readsb trace
 *   (undocumented but live; no browser CORS, hence this proxy). Up to ~24h
 *   of real history per aircraft. Treat as best-effort; data is ODbL —
 *   credit "adsb.lol (ODbL)" in the UI. Rate-limited per IP.
 */

/** Per-IP cap for /api/adsblol/trace when the env var is unset. `0` disables. */
export const ADSBLOL_TRACE_DEFAULT_RATE_PER_MIN = 60;

/** Per-IP cap for /api/opensky-track when the env var is unset. `0` disables. */
export const OPENSKY_TRACK_DEFAULT_RATE_PER_MIN = 30;

/**
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => Promise<string|null>} [options.getToken]
 * @param {typeof admitOpenSkyCreditUse} [options.admitCredit]
 * @param {typeof recordOpenSkyCreditUse} [options.recordCredit]
 * @param {() => string|undefined} [options.resolveTracePerMin]
 * @param {() => string|undefined} [options.resolveTrackPerMin]
 * @returns {import('vite').Plugin}
 */
export function trackBackfillProxies(options = {}) {
  const fetchImpl = options.fetchImpl || ((...args) => fetch(...args));
  const getToken = options.getToken || getOpenSkyToken;
  const admitCredit = options.admitCredit || admitOpenSkyCreditUse;
  const recordCredit = options.recordCredit || recordOpenSkyCreditUse;
  const resolveTracePerMin =
    options.resolveTracePerMin ||
    (() => process.env.GEV_RATELIMIT_ADSBLOL_TRACE_PER_MIN);
  const resolveTrackPerMin =
    options.resolveTrackPerMin ||
    (() => process.env.GEV_RATELIMIT_OPENSKY_TRACK_PER_MIN);
  const TRACK_CACHE_MS = 60000;
  const TRACK_CACHE_MAX = 200;
  const RESPONSE_CAP_BYTES = 5 * 1024 * 1024;
  /** @type {Map<string, {at:number,status:number,body:string}>} */
  const cache = new Map();
  let traceLimiter;
  let trackLimiter;

  function cachePut(key, entry) {
    cache.set(key, entry);
    if (cache.size > TRACK_CACHE_MAX) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) cache.delete(oldest[0]);
    }
  }

  function sendJson(res, status, body) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(body);
  }

  async function proxyJson(res, key, upstreamUrl, headers, onResponse) {
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < TRACK_CACHE_MS) {
      sendJson(res, cached.status, cached.body);
      return;
    }
    const upstream = await fetchImpl(upstreamUrl, {
      headers,
      signal: AbortSignal.timeout(12000),
    });
    const { tooLarge, text } = await readCappedResponseText(
      upstream,
      RESPONSE_CAP_BYTES,
    );
    onResponse?.(upstream);
    if (tooLarge || !upstream.ok) {
      sendJson(
        res,
        tooLarge ? 502 : upstream.status,
        JSON.stringify({
          error: tooLarge
            ? 'Upstream track response too large'
            : `Track source HTTP ${upstream.status}`,
        }),
      );
      return;
    }
    cachePut(key, { at: Date.now(), status: upstream.status, body: text });
    sendJson(res, upstream.status, text);
  }

  function install(middlewares) {
    middlewares.use('/api/opensky-track', async (req, res) => {
      try {
        if (trackLimiter === undefined) {
          trackLimiter = makeDefaultOnRateLimiter(
            resolveTrackPerMin(),
            OPENSKY_TRACK_DEFAULT_RATE_PER_MIN,
          );
        }
        const incoming = new URL(req.url || '', 'http://localhost');
        const icao24 = String(incoming.searchParams.get('icao24') || '')
          .trim()
          .toLowerCase();
        if (!/^[0-9a-f]{6}$/.test(icao24)) {
          sendJson(
            res,
            400,
            JSON.stringify({ error: 'icao24 must be a 6-char hex string' }),
          );
          return;
        }
        if (!enforceRateLimit(trackLimiter, req, res)) return;
        const cached = cache.get(`osky:${icao24}`);
        if (cached && Date.now() - cached.at < TRACK_CACHE_MS) {
          sendJson(res, cached.status, cached.body);
          return;
        }
        const admission = admitCredit();
        if (!admission.ok) {
          res.statusCode = 429;
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('Retry-After', String(admission.retryAfterSeconds));
          res.end(
            JSON.stringify({
              error: 'OpenSky rate limited; proxy cooling down.',
            }),
          );
          return;
        }
        const token = await getToken();
        await proxyJson(
          res,
          `osky:${icao24}`,
          `https://opensky-network.org/api/tracks/all?icao24=${icao24}&time=0`,
          token ? { Authorization: `Bearer ${token}` } : {},
          (upstream) => recordCredit(upstream.status, upstream.headers),
        );
      } catch {
        sendJson(
          res,
          502,
          JSON.stringify({ error: 'OpenSky track fetch failed' }),
        );
      }
    });

    middlewares.use('/api/adsblol/trace', async (req, res) => {
      try {
        if (traceLimiter === undefined) {
          traceLimiter = makeDefaultOnRateLimiter(
            resolveTracePerMin(),
            ADSBLOL_TRACE_DEFAULT_RATE_PER_MIN,
          );
        }
        if (!enforceRateLimit(traceLimiter, req, res)) return;
        const incoming = new URL(req.url || '', 'http://localhost');
        const hex = String(incoming.searchParams.get('hex') || '')
          .trim()
          .toLowerCase();
        if (!/^[0-9a-f~]{6,7}$/.test(hex)) {
          sendJson(
            res,
            400,
            JSON.stringify({ error: 'hex must be a 6-7 char hex string' }),
          );
          return;
        }
        await proxyJson(
          res,
          `lol:${hex}`,
          `https://adsb.lol/data/traces/${hex.slice(-2)}/trace_full_${hex}.json`,
        );
      } catch {
        sendJson(
          res,
          502,
          JSON.stringify({ error: 'adsb.lol trace fetch failed' }),
        );
      }
    });
  }

  return {
    name: 'track-backfill-proxies',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
