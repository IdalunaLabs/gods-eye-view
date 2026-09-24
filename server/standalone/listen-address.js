const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Whether this bind address is reachable only on the local machine.
 * @param {string} host
 */
export function isLoopbackHost(host) {
  const bare = String(host || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return LOOPBACK_HOSTS.has(bare);
}

/**
 * Positive rate-limit env values match the opt-in limiter: unset, 0, and
 * non-numeric values leave the proxy unlimited.
 * @param {string|undefined} value
 */
export function rateLimitEnabled(value) {
  const max = Number(value);
  return Number.isFinite(max) && max > 0;
}

/**
 * Resolve HOST and PORT for the production server.
 * Inside a container the default bind is all interfaces; otherwise loopback.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveListenAddress(env = process.env) {
  const inContainer = env.GEV_IN_CONTAINER === '1';
  const configuredHost = String(env.HOST || '').trim();
  const host = configuredHost || (inContainer ? '0.0.0.0' : 'localhost');
  const parsed = Number.parseInt(String(env.PORT ?? ''), 10);
  const port =
    Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : 4173;
  return { host, port, inContainer };
}

/**
 * Warning when a non-loopback bind has no opt-in per-IP throttles.
 * Empty when the bind is loopback or both limiter variables are set.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} host
 * @returns {string}
 */
export function exposureWarning(env, host) {
  if (isLoopbackHost(host)) return '';
  const missing = [];
  if (!rateLimitEnabled(env.GEV_RATELIMIT_OPENAI_PER_MIN))
    missing.push('GEV_RATELIMIT_OPENAI_PER_MIN');
  if (!rateLimitEnabled(env.GEV_RATELIMIT_GOOGLE_PER_MIN))
    missing.push('GEV_RATELIMIT_GOOGLE_PER_MIN');
  if (!missing.length) return '';
  return (
    `WARNING: God's Eye View is listening on ${host}, which is not a loopback address. ` +
    'Anyone who can reach this server can call the key-brokering proxies and spend ' +
    'OpenAI, Google, OpenSky, AISStream, TomTom, and FIRMS quota. ' +
    `Set ${missing.join(' and ')} (per-IP, process-local, reset on restart; not billing caps) ` +
    'and configure provider-side budgets before exposing this process. See SECURITY.md.'
  );
}
