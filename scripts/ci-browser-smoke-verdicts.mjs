/**
 * Pure verdicts for the production browser smoke gate.
 *
 * The Puppeteer harness in `scripts/ci-browser-smoke.mjs` imports these helpers.
 * Unit tests import this module directly so a verdict change does not launch
 * Chromium.
 */

/** Preferred preview port for this gate. `0` from the CLI means "choose". */
export const DEFAULT_PREVIEW_PORT = 4301;

/** Feed states that mean the layer has left its in-flight lifecycle. */
export const STABLE_FEED_STATES = Object.freeze([
  'nominal',
  'degraded',
  'stale',
  'partial',
  'fallback',
  'unavailable',
]);

/** Feed states that are still in flight and must not pass the layer gate. */
export const TRANSIENT_FEED_STATES = Object.freeze([
  'off',
  'loading',
  'enabling',
  'disabling',
  'uncertain',
]);

/** Layers the smoke gate toggles from the data panel. */
export const SMOKE_LAYERS = Object.freeze([
  Object.freeze({ id: 'flights', label: 'Flights' }),
  Object.freeze({ id: 'satellites', label: 'Satellites' }),
]);

/**
 * Style keys `1`..`7` and the indicator text the shell paints for each.
 * Mirrors `STYLE_KEYS` in `src/ui/applicationShortcuts.js` and the display
 * names in `StyleManager.setStyle`.
 */
export const STYLE_KEY_SEQUENCE = Object.freeze([
  Object.freeze({ key: '1', style: 'normal', indicator: 'NORMAL' }),
  Object.freeze({ key: '2', style: 'retro', indicator: 'CRT' }),
  Object.freeze({ key: '3', style: 'surveillance', indicator: 'NVG' }),
  Object.freeze({ key: '4', style: 'thermal', indicator: 'FLIR' }),
  Object.freeze({ key: '5', style: 'anime', indicator: 'ANIME' }),
  Object.freeze({ key: '6', style: 'noir', indicator: 'NOIR' }),
  Object.freeze({ key: '7', style: 'snow', indicator: 'SNOW' }),
]);

/**
 * Server credentials cleared for the preview process.
 * An empty string blocks `loadEnv` from filling the same name out of `.env`,
 * so a local env file cannot turn a keyless smoke run into a keyed one.
 */
export const KEYLESS_ENV_NAMES = Object.freeze([
  'GOOGLE_MAPS_API_KEY',
  'GOOGLE_MAPS_SERVER_API_KEY',
  'CESIUM_ION_TOKEN',
  'OPENAI_API_KEY',
  'AISSTREAM_API_KEY',
  'FIRMS_MAP_KEY',
  'FIRMS_API_KEY',
  'TOMTOM_API_KEY',
  'OPENSKY_CLIENT_ID',
  'OPENSKY_CLIENT_SECRET',
  'LL2_API_TOKEN',
]);

/** Browser network-failure wording. A host match alone is not enough. */
export const NETWORK_FAILURE =
  /failed to load resource|net::err_|failed to obtain image tile|requesterror|request has failed|failed to fetch|status of (?:0|[45]\d\d)/i;

/**
 * Console-error allowlist. Every rule requires a failure shape and a named
 * host, API path, or the Cesium imagery-tile phrase. A bare
 * "Failed to load resource" does not match.
 * @type {readonly {id: string, failure: RegExp, scope: RegExp}[]}
 */
export const CONSOLE_ALLOWLIST = Object.freeze([
  Object.freeze({
    id: 'esri-osm-tiles',
    failure: NETWORK_FAILURE,
    scope: /arcgisonline\.com|arcgis\.com|openstreetmap\.org|cartocdn\.com/i,
  }),
  Object.freeze({
    id: 'keyless-terrain',
    failure: NETWORK_FAILURE,
    scope: /reearth\.land/i,
  }),
  Object.freeze({
    id: 'cesium-ion-assets',
    failure: NETWORK_FAILURE,
    scope: /cesium\.com/i,
  }),
  Object.freeze({
    id: 'google-fonts',
    failure: NETWORK_FAILURE,
    scope: /fonts\.googleapis\.com|fonts\.gstatic\.com/i,
  }),
  Object.freeze({
    id: 'keyless-provider-routes',
    failure: NETWORK_FAILURE,
    scope:
      /\/api\/(?:opensky(?:-track)?|adsblol|adsbdb|celestrak|terrain\/heights|openai\/hud-summary)\b|opensky-network\.org|adsb\.lol|adsbdb\.com|celestrak\.org/i,
  }),
  Object.freeze({
    id: 'cesium-imagery-tile',
    failure: /failed to obtain image tile/i,
    scope: /failed to obtain image tile/i,
  }),
  Object.freeze({
    id: 'preview-setup-status',
    failure: NETWORK_FAILURE,
    scope: /\/api\/setup\/status\b/i,
  }),
]);

/**
 * Orbit frame budget used for the advisory warning. A healthy Chrome 152
 * SwiftShader orbit of this bundle measured about 620–740 ms median here, and
 * a loaded shared machine reached about 2.6 s. The number stays advisory until
 * it is calibrated on a GitHub-hosted runner.
 */
export const DEFAULT_FRAME_BUDGET_MS = 1500;

const SMOKE_DEFAULTS = Object.freeze({
  heapCeilingMib: 600,
  frameBudgetMs: DEFAULT_FRAME_BUDGET_MS,
  idleMs: 20_000,
  orbitMs: 5_000,
  teeth: false,
  enforceFrameBudget: false,
  port: null,
});

/**
 * Parse smoke-harness CLI flags.
 * @param {string[]} argv Arguments after the script path.
 * @param {NodeJS.ProcessEnv} [env] Process environment. `GEV_SMOKE_ENFORCE_FRAMES=1` enforces the frame budget.
 * @returns {{
 *   heapCeilingMib: number,
 *   frameBudgetMs: number,
 *   idleMs: number,
 *   orbitMs: number,
 *   teeth: boolean,
 *   enforceFrameBudget: boolean,
 *   port: number|null,
 * }}
 */
export function parseSmokeArgs(argv, env = {}) {
  const options = {
    ...SMOKE_DEFAULTS,
    enforceFrameBudget: env.GEV_SMOKE_ENFORCE_FRAMES === '1',
  };
  const numeric = new Map([
    ['--heap-ceiling-mib', 'heapCeilingMib'],
    ['--frame-budget-ms', 'frameBudgetMs'],
    ['--idle-ms', 'idleMs'],
    ['--orbit-ms', 'orbitMs'],
    ['--port', 'port'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--teeth') {
      options.teeth = true;
      continue;
    }
    if (flag === '--enforce-frame-budget') {
      options.enforceFrameBudget = true;
      continue;
    }
    const key = numeric.get(flag);
    if (!key) throw new Error(`Unknown argument ${flag}`);
    const raw = argv[index + 1];
    if (raw === undefined || raw.startsWith('--')) {
      throw new Error(`${flag} requires a number`);
    }
    index += 1;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${flag} requires a non-negative number`);
    }
    if (
      (key === 'heapCeilingMib' ||
        key === 'frameBudgetMs' ||
        key === 'orbitMs') &&
      value <= 0
    ) {
      throw new Error(`${flag} must be greater than 0`);
    }
    options[key] = key === 'port' && value === 0 ? null : value;
  }
  return options;
}

/**
 * Copy an environment and blank preview credentials.
 * @param {NodeJS.ProcessEnv} baseEnv
 * @returns {NodeJS.ProcessEnv}
 */
export function keylessPreviewEnv(baseEnv) {
  const env = { ...baseEnv };
  for (const name of KEYLESS_ENV_NAMES) env[name] = '';
  delete env.PORT;
  delete env.HOST;
  return env;
}

/**
 * Chrome executable preference: explicit path, then Puppeteer's pinned
 * Chrome-for-Testing, then platform installs. Mirrors `qa-firstrun.mjs`.
 * @param {{ puppeteerPath?: string|null, envPath?: string|null }} candidates
 * @returns {string[]}
 */
export function chromeCandidatePaths({
  puppeteerPath = null,
  envPath = null,
} = {}) {
  return [
    envPath,
    puppeteerPath,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/local/bin/google-chrome',
  ].filter(Boolean);
}

/** SwiftShader launch flags shared with the headless QA harnesses. */
export function browserLaunchArgs() {
  return [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--enable-precise-memory-info',
    '--window-size=1440,900',
  ];
}

/**
 * Whether `dist/index.html` is present. The harness does not build.
 * @param {boolean} hasIndexHtml
 * @returns {{ok: boolean, reason?: string}}
 */
export function distReadiness(hasIndexHtml) {
  if (hasIndexHtml) return { ok: true };
  return {
    ok: false,
    reason: 'dist/index.html is missing; run npm run build before qa:ci-smoke',
  };
}

/**
 * Match one console message against the allowlist.
 * @param {string} text Message text plus resource URL when the browser provides one.
 * @param {readonly {id: string, failure: RegExp, scope: RegExp}[]} [rules]
 * @returns {{id: string}|null}
 */
export function matchConsoleAllowlist(text, rules = CONSOLE_ALLOWLIST) {
  const value = String(text ?? '');
  for (const rule of rules) {
    if (rule.failure.test(value) && rule.scope.test(value))
      return { id: rule.id };
  }
  return null;
}

/**
 * A rule is specific when its scope names a host, an `/api/` path, or Cesium's
 * imagery-tile phrase, and it does not match an unqualified network failure.
 * @param {{id: string, failure: RegExp, scope: RegExp}} rule
 * @returns {boolean}
 */
export function consoleAllowlistRuleIsSpecific(rule) {
  const bare = 'Failed to load resource: net::ERR_FAILED';
  const unrelated = 'TypeError: viewer is null';
  const unnamedApi =
    'Failed to load resource: the server responded with a status of 500 ()\nhttp://127.0.0.1/api/not-a-provider';
  if (rule.failure.test(unrelated) && rule.scope.test(unrelated)) return false;
  if (rule.failure.test(bare) && rule.scope.test(bare)) return false;
  if (rule.failure.test(unnamedApi) && rule.scope.test(unnamedApi))
    return false;
  const scope = rule.scope.source;
  return (
    /[a-z0-9-]+\\.[a-z]{2,}/i.test(scope) ||
    /\\\/api\\\//.test(scope) ||
    /image tile/i.test(scope)
  );
}

/**
 * Split captured messages into allowlisted noise, unexpected console errors,
 * and uncaught exceptions. Page errors are never allowlisted.
 * @param {Array<{kind: string, text: string}>} messages
 * @param {readonly {id: string, failure: RegExp, scope: RegExp}[]} [rules]
 * @returns {{
 *   ok: boolean,
 *   allowlisted: Array<{kind: string, text: string, ruleId: string}>,
 *   unexpected: Array<{kind: string, text: string}>,
 *   uncaught: Array<{kind: string, text: string}>,
 * }}
 */
export function partitionConsoleMessages(messages, rules = CONSOLE_ALLOWLIST) {
  const allowlisted = [];
  const unexpected = [];
  const uncaught = [];
  for (const message of messages) {
    if (message?.kind === 'pageerror') {
      uncaught.push({ kind: 'pageerror', text: String(message.text || '') });
      continue;
    }
    const text = String(message?.text || '');
    const rule = matchConsoleAllowlist(text, rules);
    if (rule) allowlisted.push({ kind: 'console', text, ruleId: rule.id });
    else unexpected.push({ kind: 'console', text });
  }
  return {
    ok: uncaught.length === 0 && unexpected.length === 0,
    allowlisted,
    unexpected,
    uncaught,
  };
}

/**
 * Collapse repeated allowlisted lines for the report.
 * @param {Array<{ruleId?: string, text: string}>} messages
 * @param {number} [limit]
 * @returns {{total: number, unique: number, truncated: boolean, samples: Array<{ruleId: string, text: string, count: number}>}}
 */
export function summarizeAllowlisted(messages, limit = 40) {
  const counts = new Map();
  for (const message of messages) {
    const text = String(message.text || '').slice(0, 300);
    const ruleId = message.ruleId || '';
    const signature = `${ruleId}|${text}`;
    const row = counts.get(signature) || { ruleId, text, count: 0 };
    row.count += 1;
    counts.set(signature, row);
  }
  const rows = [...counts.values()].sort(
    (left, right) => right.count - left.count,
  );
  return {
    total: messages.length,
    unique: rows.length,
    truncated: rows.length > limit,
    samples: rows.slice(0, limit),
  };
}

/**
 * Classify one layer-row observation.
 * Nominal before the first snapshot stays pending so a later UNAVAILABLE chip
 * can still win. Unavailable, degraded, stale, partial, and fallback are
 * terminal honest states; a blocked network that surfaces one of them passes.
 * @param {{feedState?: string, meta?: string, countText?: string}} observation
 * @returns {{settled: boolean, kind: 'live'|'unavailable'|'pending'|'invalid', reason: string}}
 */
export function classifyLayerSnapshot(observation = {}) {
  const feedState = String(observation.feedState || '').trim();
  const meta = String(observation.meta || '').trim();
  const countText = String(observation.countText || '').trim();
  if (TRANSIENT_FEED_STATES.includes(feedState)) {
    return {
      settled: false,
      kind: 'pending',
      reason: `feed state ${feedState}`,
    };
  }
  if (!STABLE_FEED_STATES.includes(feedState)) {
    return {
      settled: false,
      kind: 'invalid',
      reason: `unrecognized feed state ${feedState || '(empty)'}`,
    };
  }
  if (feedState === 'unavailable') {
    return {
      settled: true,
      kind: 'unavailable',
      reason: meta || 'unavailable',
    };
  }
  if (feedState !== 'nominal') {
    return { settled: true, kind: 'live', reason: meta || feedState };
  }
  const recency = /\b(?:just now|\d+\s*[smh] ago)\b/i.test(meta);
  const records =
    /^\d+(?:\.\d+)?K?$/i.test(countText) && !/^0(?:\.0+)?$/i.test(countText);
  if (records || recency) {
    return {
      settled: true,
      kind: 'live',
      reason: `${countText || '—'} · ${meta}`,
    };
  }
  return {
    settled: false,
    kind: 'pending',
    reason: 'nominal before the first snapshot',
  };
}

/**
 * Pass a layer only when its row settled on live data or an honest outage.
 * @param {{feedState?: string, meta?: string, countText?: string, missing?: boolean}} observation
 * @returns {{ok: boolean, kind: string, reason: string}}
 */
export function layerToggleVerdict(observation = {}) {
  if (observation.missing) {
    return { ok: false, kind: 'invalid', reason: 'layer row is missing' };
  }
  const verdict = classifyLayerSnapshot(observation);
  const ok =
    verdict.settled &&
    (verdict.kind === 'live' || verdict.kind === 'unavailable');
  return { ok, kind: verdict.kind, reason: verdict.reason };
}

/**
 * Compare observed style-key results with the shell's display names.
 * @param {Array<{key?: string, activeStyle?: string, indicatorText?: string}>} observed
 * @returns {{ok: boolean, mismatches: string[]}}
 */
export function styleSwitchVerdict(observed) {
  const mismatches = [];
  if (!Array.isArray(observed)) {
    return { ok: false, mismatches: ['style observations are missing'] };
  }
  for (const expected of STYLE_KEY_SEQUENCE) {
    const row = observed.find((item) => item?.key === expected.key);
    if (!row) {
      mismatches.push(`${expected.key}: not exercised`);
      continue;
    }
    const activeStyle = String(row.activeStyle || '');
    const indicatorText = String(row.indicatorText || '').trim();
    if (
      activeStyle !== expected.style ||
      indicatorText !== expected.indicator
    ) {
      mismatches.push(
        `${expected.key}: active=${activeStyle || '(none)'} indicator=${indicatorText || '(none)'}`,
      );
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

/**
 * Heap ceiling. "Under" is strict. Missing `performance.memory` fails closed
 * so a browser that cannot measure the budget cannot pass it.
 * @param {{usedBytes?: number|null, ceilingMib: number, memoryPresent: boolean}} measurement
 * @returns {{ok: boolean, usedMib: number|null, ceilingMib: number, reason: string}}
 */
export function heapVerdict({ usedBytes = null, ceilingMib, memoryPresent }) {
  if (!memoryPresent) {
    return {
      ok: false,
      usedMib: null,
      ceilingMib,
      reason: 'performance.memory is absent; the heap ceiling was not measured',
    };
  }
  if (!Number.isFinite(usedBytes) || usedBytes < 0) {
    return {
      ok: false,
      usedMib: null,
      ceilingMib,
      reason: 'heap measurement is not a finite byte count',
    };
  }
  const usedMib = usedBytes / (1024 * 1024);
  const ok = usedMib < ceilingMib;
  return {
    ok,
    usedMib,
    ceilingMib,
    reason: ok
      ? 'under ceiling'
      : `heap ${usedMib.toFixed(1)} MiB is not under ${ceilingMib} MiB`,
  };
}

/**
 * Median frame interval compared with the budget. The first sample is the
 * gap before the orbit clock and is excluded by the caller.
 * Over budget is a warning unless `enforced` is set; missing samples follow
 * the same rule. Heap checks stay outside this helper.
 * @param {{medianMs?: number|null, budgetMs: number, sampleCount?: number, enforced?: boolean, reason?: string|null}} measurement
 * @returns {{
 *   ok: boolean,
 *   withinBudget: boolean,
 *   enforced: boolean,
 *   warning: string|null,
 *   medianMs: number|null,
 *   budgetMs: number,
 *   sampleCount: number,
 *   reason: string,
 * }}
 */
export function frameVerdict({
  medianMs = null,
  budgetMs,
  sampleCount = 0,
  enforced = false,
  reason = null,
}) {
  const enforcedFlag = enforced === true;
  const measured = Number.isFinite(medianMs) && sampleCount >= 2;
  if (!measured) {
    const detail = reason || 'frame samples were not measured';
    return {
      ok: !enforcedFlag,
      withinBudget: false,
      enforced: enforcedFlag,
      warning: enforcedFlag ? null : `WARNING: ${detail}`,
      medianMs: Number.isFinite(medianMs) ? medianMs : null,
      budgetMs,
      sampleCount,
      reason: detail,
    };
  }
  const withinBudget = medianMs < budgetMs;
  const detail = withinBudget
    ? 'under budget'
    : `median frame ${medianMs.toFixed(1)} ms is not under ${budgetMs} ms`;
  return {
    ok: enforcedFlag ? withinBudget : true,
    withinBudget,
    enforced: enforcedFlag,
    warning: withinBudget || enforcedFlag ? null : `WARNING: ${detail}`,
    medianMs,
    budgetMs,
    sampleCount,
    reason: detail,
  };
}

/**
 * Median of a finite numeric sample. Even counts average the two central values.
 * @param {number[]} values
 * @returns {number|null}
 */
export function median(values) {
  const nums = (values || [])
    .filter((value) => Number.isFinite(value))
    .slice()
    .sort((left, right) => left - right);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  if (nums.length % 2) return nums[mid];
  return (nums[mid - 1] + nums[mid]) / 2;
}

/**
 * Drop the leading interval and summarize an orbit's frame deltas.
 * @param {number[]} samples
 * @returns {{sampleCount: number, medianMs: number|null, maxMs: number|null}}
 */
export function summarizeFrameSamples(samples) {
  const measured = (samples || []).filter(
    (value) => Number.isFinite(value) && value >= 0,
  );
  const body = measured.slice(1);
  return {
    sampleCount: body.length,
    medianMs: median(body),
    maxMs: body.length ? Math.max(...body) : null,
  };
}

/**
 * Shape the on-disk smoke report. `ok` is the conjunction of hard assertion
 * results. Advisory frame warnings are counted separately and do not fail `ok`.
 * @param {object} input
 * @param {string} input.url
 * @param {string} input.startedAt
 * @param {string} input.finishedAt
 * @param {object} input.options
 * @param {Record<string, {ok?: boolean}>} input.assertions
 * @param {string[]} input.screenshots
 * @param {object} input.allowlisted
 * @param {string[]} [input.advisoryWarnings]
 * @param {string|null} [input.harnessError]
 * @returns {object}
 */
export function shapeSmokeReport({
  url,
  startedAt,
  finishedAt,
  options,
  assertions,
  screenshots,
  allowlisted,
  advisoryWarnings = [],
  harnessError = null,
}) {
  const entries = Object.entries(assertions || {});
  const failed = entries.filter(([, assertion]) => assertion?.ok !== true);
  const warnings = advisoryWarnings.filter(
    (warning) => typeof warning === 'string' && warning.length > 0,
  );
  const ok = !harnessError && failed.length === 0 && entries.length > 0;
  return {
    ok,
    url,
    startedAt,
    finishedAt,
    options,
    harnessError,
    assertions,
    allowlisted,
    advisoryWarnings: warnings,
    screenshots,
    summary: {
      passed: entries.length - failed.length,
      failed: failed.length,
      advisory: warnings.length,
      names: entries.map(([name, assertion]) => ({
        name,
        ok: assertion?.ok === true,
      })),
    },
  };
}

/**
 * Process exit code. `--teeth` is healthy only when the first-run assertion
 * itself failed and the harness still reached it. A healthy teeth run exits 1,
 * matching `qa-firstrun.mjs`; a toothless or crashed control exits 2.
 * @param {{ok: boolean, teeth: boolean, firstRunOk: boolean|null, harnessError: string|null}} result
 * @returns {0|1|2}
 */
export function smokeExitCode({ ok, teeth, firstRunOk, harnessError }) {
  if (teeth) {
    const healthy = firstRunOk === false && !harnessError;
    return healthy ? 1 : 2;
  }
  if (harnessError || !ok) return 1;
  return 0;
}
