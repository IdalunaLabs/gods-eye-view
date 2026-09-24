import { resolveGoogleServerKey } from '../../../scripts/google-server-key.mjs';
import { makeOptInRateLimiter } from '../common/rate-limit.js';

let _googleRateLimiter;
let _googleRateLimiterKey;

/**
 * Shared opt-in per-IP limiter for Google cost calls (Places and CCTV Street
 * View). Null when `GEV_RATELIMIT_GOOGLE_PER_MIN` is unset or `0`. Rebuilt
 * when that value changes so a later `.env` load is visible.
 * @returns {((key:string)=>boolean)|null}
 */
export function googleOptInRateLimiter() {
  const raw = process.env.GEV_RATELIMIT_GOOGLE_PER_MIN ?? '';
  if (_googleRateLimiterKey !== raw) {
    _googleRateLimiterKey = raw;
    _googleRateLimiter = makeOptInRateLimiter(raw);
  }
  return _googleRateLimiter;
}

/**
 * Optional Google place context is an empty capability when no key is present,
 * not a server outage. Returning 200 keeps a deliberately keyless session out
 * of the browser error console while preserving an explicit configured flag.
 */
export function keylessGooglePlacesResponse(apiKey) {
  if (String(apiKey ?? '').trim()) return null;
  return {
    statusCode: 200,
    payload: { configured: false, error: null, places: [] },
  };
}

/**
 * Google API key for the SERVER-SIDE calls (Places nearby/text search, the
 * CCTV Street View fallback). These never reach the browser, so this key can
 * be restricted by server IP and scoped to Places API + Street View Static
 * API — while GOOGLE_MAPS_API_KEY stays referrer-restricted to Map Tiles +
 * Geocoding for the browser (#33). Splitting them is opt-in: unset, this
 * falls back to the shared browser key and nothing changes.
 */
export function googleServerApiKey() {
  return resolveGoogleServerKey(process.env);
}
