import { makeRateLimiter } from '../../../src/sources/rateLimit.js';
export { makeRateLimiter } from '../../../src/sources/rateLimit.js';

/**
 * Opt-in per-IP rate limiter for the cost-bearing API proxies (OpenAI / Google).
 * DEFAULT IS UNLIMITED: when the env var is unset, `0`, or non-numeric, this
 * returns `null` and the caller skips the check entirely — a runtime no-op that
 * preserves the original behavior. Only a positive integer N enables a fixed
 * 60s window of N requests/IP (built lazily once, then reused so its per-IP
 * window state persists across requests). The global backstop is set to a
 * generous multiple of the per-IP cap so a single host can't starve the rest.
 *
 * @param {string|undefined} envValue - Raw env value (requests/min/IP).
 * @returns {((key:string)=>boolean)|null} An `allow(key)` fn, or null when unlimited.
 */
export function makeOptInRateLimiter(envValue) {
  const max = Number(envValue);
  if (!Number.isFinite(max) || max <= 0) return null; // unset/0/garbage -> unlimited
  return makeRateLimiter({
    windowMs: 60_000,
    max: Math.floor(max),
    globalMax: Math.floor(max) * 20,
  });
}

/**
 * Per-IP limiter that stays on unless the operator explicitly disables it.
 * A blank value uses `defaultPerMin`. `0` disables. A positive number is that
 * cap. Any other value falls back to the default so a typo cannot turn the
 * guard off.
 *
 * @param {string|number|undefined|null} envValue - Raw env value.
 * @param {number} defaultPerMin - Requests/minute/IP when unset.
 * @returns {((key:string)=>boolean)|null} An `allow(key)` fn, or null when disabled.
 */
export function makeDefaultOnRateLimiter(envValue, defaultPerMin) {
  const raw =
    envValue === undefined || envValue === null ? '' : String(envValue).trim();
  if (raw === '') return makeOptInRateLimiter(String(defaultPerMin));
  if (raw === '0') return null;
  const configured = makeOptInRateLimiter(raw);
  return configured || makeOptInRateLimiter(String(defaultPerMin));
}

/**
 * Apply a per-IP limiter, writing a sanitized 429 when the cap is exceeded.
 * A null limiter allows the request.
 *
 * @param {((key:string)=>boolean)|null} limiter
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @returns {boolean} True when the request may proceed.
 */
export function enforceRateLimit(limiter, req, res) {
  if (!limiter || limiter(clientKey(req))) return true;
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Retry-After': '5',
  };
  const body = JSON.stringify({ error: 'Rate limit exceeded' });
  if (typeof res.writeHead === 'function') res.writeHead(429, headers);
  else {
    res.statusCode = 429;
    for (const [name, value] of Object.entries(headers)) {
      res.setHeader?.(name, value);
    }
  }
  res.end(body);
  return false;
}

/**
 * Client key for rate limiting. Uses the real socket peer address only — we do
 * NOT trust X-Forwarded-For (client-controlled; a rotating value would mint fresh
 * quota and grow the limiter map). This is a localhost dev proxy, so the socket
 * address is the real client.
 */
export function clientKey(req) {
  return String(req.socket?.remoteAddress || 'local');
}
