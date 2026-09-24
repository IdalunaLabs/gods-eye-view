import { makeOptInRateLimiter, clientKey } from '../common/rate-limit.js';

/** Requests/minute/IP when a non-loopback bind leaves the OpenAI limit unset. */
export const OPENAI_EXPOSED_DEFAULT_PER_MIN = 10;

/**
 * True when HOST is unset or bound to a loopback name. `0.0.0.0` and `::`
 * are not loopback: they accept non-local clients.
 * @param {string|undefined|null} value
 * @returns {boolean}
 */
export function isLoopbackBindHost(value) {
  const host = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return (
    host === '' ||
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1'
  );
}

// Built on first request, and rebuilt when HOST or the env cap changes, so a
// limit loaded from `.env` after import is visible. The window persists while
// that pair stays the same. `null` means unlimited.
let _openAiRateLimiter;
let _openAiRateLimiterKey;

/**
 * Effective OpenAI per-IP cap. Blank on loopback stays unlimited. Blank on any
 * other bind uses the conservative default. `0` disables. A positive integer
 * is that cap.
 * @param {string|undefined|null} [configured]
 * @param {string|undefined|null} [host]
 * @returns {string} Empty when unlimited.
 */
export function openAiRateLimitPerMin(
  configured = process.env.GEV_RATELIMIT_OPENAI_PER_MIN,
  host = process.env.HOST,
) {
  const raw = configured == null ? '' : String(configured).trim();
  if (raw === '' && !isLoopbackBindHost(host)) {
    return String(OPENAI_EXPOSED_DEFAULT_PER_MIN);
  }
  return raw;
}

/** OpenAI cost endpoints (realtime/token + hud-summary). Null = unlimited. */
function openAiRateLimiter() {
  const effective = openAiRateLimitPerMin();
  const key = `${isLoopbackBindHost(process.env.HOST) ? 'loop' : 'exposed'}\0${effective}`;
  if (_openAiRateLimiterKey !== key) {
    _openAiRateLimiterKey = key;
    _openAiRateLimiter = makeOptInRateLimiter(
      effective === '' ? undefined : effective,
    );
  }
  return _openAiRateLimiter;
}

/**
 * Apply an opt-in limiter to a request, writing a 429 when over the cap.
 * When `limiter` is null (unlimited, the default) this is a no-op returning
 * `true`, so the handler proceeds exactly as before.
 *
 * @param {((key:string)=>boolean)|null} limiter
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @returns {boolean} True if the request may proceed; false if a 429 was sent.
 */
function enforceOptInRateLimit(limiter, req, res) {
  if (!limiter) return true; // unlimited (default) — no behavior change
  if (limiter(clientKey(req))) return true;
  res.statusCode = 429;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Retry-After', '5');
  res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
  return false;
}

export { enforceOptInRateLimit, openAiRateLimiter };
