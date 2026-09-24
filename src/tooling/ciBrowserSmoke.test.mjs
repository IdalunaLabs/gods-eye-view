import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  CONSOLE_ALLOWLIST,
  DEFAULT_FRAME_BUDGET_MS,
  DEFAULT_PREVIEW_PORT,
  browserLaunchArgs,
  chromeCandidatePaths,
  classifyLayerSnapshot,
  consoleAllowlistRuleIsSpecific,
  distReadiness,
  frameVerdict,
  heapVerdict,
  keylessPreviewEnv,
  layerToggleVerdict,
  matchConsoleAllowlist,
  median,
  parseSmokeArgs,
  partitionConsoleMessages,
  shapeSmokeReport,
  smokeExitCode,
  styleSwitchVerdict,
  summarizeAllowlisted,
  summarizeFrameSamples,
} from '../../scripts/ci-browser-smoke-verdicts.mjs';

test('argument defaults match the CI gate and reject unknown or empty numbers', () => {
  assert.deepEqual(parseSmokeArgs([]), {
    heapCeilingMib: 600,
    frameBudgetMs: 1500,
    idleMs: 20_000,
    orbitMs: 5_000,
    teeth: false,
    enforceFrameBudget: false,
    port: null,
  });
  assert.equal(DEFAULT_PREVIEW_PORT, 4301);
  const custom = parseSmokeArgs([
    '--teeth',
    '--heap-ceiling-mib',
    '512',
    '--frame-budget-ms',
    '40',
    '--idle-ms',
    '0',
    '--orbit-ms',
    '1000',
    '--port',
    '0',
  ]);
  assert.equal(custom.teeth, true);
  assert.equal(custom.heapCeilingMib, 512);
  assert.equal(custom.frameBudgetMs, 40);
  assert.equal(custom.idleMs, 0);
  assert.equal(custom.orbitMs, 1000);
  assert.equal(custom.port, null);
  assert.equal(parseSmokeArgs(['--port', '4301']).port, 4301);
  assert.equal(
    parseSmokeArgs(['--enforce-frame-budget']).enforceFrameBudget,
    true,
  );
  assert.equal(
    parseSmokeArgs([], { GEV_SMOKE_ENFORCE_FRAMES: '1' }).enforceFrameBudget,
    true,
  );
  assert.equal(
    parseSmokeArgs([], { GEV_SMOKE_ENFORCE_FRAMES: 'true' }).enforceFrameBudget,
    false,
  );
  for (const argv of [
    ['--nope'],
    ['--heap-ceiling-mib'],
    ['--frame-budget-ms', 'fast'],
    ['--heap-ceiling-mib', '0'],
    ['--orbit-ms', '-5'],
  ]) {
    assert.throws(
      () => parseSmokeArgs(argv),
      /Unknown argument|requires|greater than 0/,
    );
  }
});

test('preview env blanks credentials without keeping a caller port', () => {
  const env = keylessPreviewEnv({
    PATH: '/usr/bin',
    GOOGLE_MAPS_API_KEY: 'secret',
    CESIUM_ION_TOKEN: 'ion',
    OPENAI_API_KEY: 'sk-test',
    PORT: '4173',
    HOST: '0.0.0.0',
  });
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.GOOGLE_MAPS_API_KEY, '');
  assert.equal(env.CESIUM_ION_TOKEN, '');
  assert.equal(env.OPENAI_API_KEY, '');
  assert.equal(env.PORT, undefined);
  assert.equal(env.HOST, undefined);
  assert.equal(keylessPreviewEnv({}).GOOGLE_MAPS_API_KEY, '');
});

test('chrome candidates prefer the pinned Puppeteer binary over system Chrome', () => {
  assert.deepEqual(
    chromeCandidatePaths({
      envPath: '/opt/chrome',
      puppeteerPath: '/cache/chrome',
    }),
    [
      '/opt/chrome',
      '/cache/chrome',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/usr/local/bin/google-chrome',
    ],
  );
  assert.deepEqual(
    chromeCandidatePaths({ puppeteerPath: '/cache/chrome' })[0],
    '/cache/chrome',
  );
});

test('launch flags request SwiftShader and do not blanket-disable security', () => {
  const args = browserLaunchArgs();
  assert.ok(args.includes('--use-gl=angle'));
  assert.ok(args.includes('--use-angle=swiftshader'));
  assert.ok(args.includes('--enable-precise-memory-info'));
  assert.equal(args.includes('--disable-web-security'), false);
  assert.equal(args.includes('--disable-gpu'), false);
});

test('a missing production bundle is a harness failure, not a pass', () => {
  assert.equal(distReadiness(true).ok, true);
  assert.match(distReadiness(false).reason, /npm run build/);
});

test('console allowlist rules name a host, API, or imagery tile and reject bare failures', () => {
  for (const rule of CONSOLE_ALLOWLIST) {
    assert.equal(consoleAllowlistRuleIsSpecific(rule), true, rule.id);
  }
  const negatives = [
    'Failed to load resource: net::ERR_FAILED',
    'TypeError: Cannot read properties of null (reading "viewer")',
    'Failed to load resource: the server responded with a status of 500 ()\nhttp://127.0.0.1/api/not-a-provider',
    'arcgisonline.com',
    'Uncaught Error: WebGL context lost',
    '[unhandledrejection] TypeError: boom',
  ];
  for (const text of negatives) {
    assert.equal(matchConsoleAllowlist(text), null, text);
  }
  const positives = [
    [
      'esri-osm-tiles',
      'Failed to load resource: net::ERR_CONNECTION_RESET\nhttps://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/1/0/0',
    ],
    [
      'esri-osm-tiles',
      'Failed to load resource: the server responded with a status of 404 ()\nhttps://tile.openstreetmap.org/1/2/3.png',
    ],
    [
      'keyless-terrain',
      'Failed to load resource: net::ERR_NAME_NOT_RESOLVED\nhttps://terrain.reearth.land/cesium-mesh/ellipsoid/0/0/0.terrain',
    ],
    [
      'cesium-ion-assets',
      'Failed to load resource: the server responded with a status of 401 ()\nhttps://assets.ion.cesium.com/1',
    ],
    [
      'google-fonts',
      'Failed to load resource: net::ERR_INTERNET_DISCONNECTED\nhttps://fonts.googleapis.com/css2?family=Inter',
    ],
    [
      'keyless-provider-routes',
      'Failed to load resource: the server responded with a status of 502 ()\nhttp://127.0.0.1:4301/api/opensky?lamin=1',
    ],
    [
      'keyless-provider-routes',
      'Failed to fetch\nhttp://127.0.0.1:4301/api/celestrak/stations',
    ],
    [
      'keyless-provider-routes',
      'net::ERR_FAILED https://opensky-network.org/api/states/all',
    ],
    [
      'cesium-imagery-tile',
      'An error occurred in "requestImage": Failed to obtain image tile 0 : 0 : 0.',
    ],
    [
      'preview-setup-status',
      'Failed to load resource: the server responded with a status of 404 (Not Found)\nhttp://127.0.0.1:4301/api/setup/status',
    ],
  ];
  for (const [id, text] of positives) {
    assert.equal(matchConsoleAllowlist(text)?.id, id, text);
  }
});

test('page errors stay uncaught even when their text names an allowlisted host', () => {
  const partitioned = partitionConsoleMessages([
    {
      kind: 'console',
      text: 'Failed to load resource: net::ERR_FAILED\nhttps://tile.openstreetmap.org/0/0/0.png',
    },
    { kind: 'console', text: 'TypeError: render failed' },
    {
      kind: 'pageerror',
      text: 'Failed to load resource https://services.arcgisonline.com/tile',
    },
  ]);
  assert.equal(partitioned.ok, false);
  assert.equal(partitioned.allowlisted.length, 1);
  assert.equal(partitioned.allowlisted[0].ruleId, 'esri-osm-tiles');
  assert.deepEqual(
    partitioned.unexpected.map((entry) => entry.text),
    ['TypeError: render failed'],
  );
  assert.equal(partitioned.uncaught.length, 1);
  const summary = summarizeAllowlisted([
    ...partitioned.allowlisted,
    ...partitioned.allowlisted,
  ]);
  assert.equal(summary.total, 2);
  assert.equal(summary.unique, 1);
  assert.equal(summary.samples[0].count, 2);
});

test('layer chips pass on live data or an honest outage and wait through the pre-fetch nominal state', () => {
  assert.deepEqual(
    classifyLayerSnapshot({ feedState: 'enabling', meta: 'ENABLING' }).kind,
    'pending',
  );
  assert.equal(
    classifyLayerSnapshot({
      feedState: 'nominal',
      meta: 'Aircraft · never',
      countText: '—',
    }).settled,
    false,
  );
  const live = classifyLayerSnapshot({
    feedState: 'nominal',
    meta: 'OpenSky · just now',
    countText: '1.2K',
  });
  assert.equal(live.kind, 'live');
  assert.equal(live.settled, true);
  assert.equal(
    classifyLayerSnapshot({
      feedState: 'nominal',
      meta: 'OpenSky · 12s ago',
      countText: '—',
    }).kind,
    'live',
  );
  const outage = layerToggleVerdict({
    feedState: 'unavailable',
    meta: 'UNAVAILABLE · CelesTrak · CelesTrak unreachable',
    countText: '—',
  });
  assert.equal(outage.ok, true);
  assert.equal(outage.kind, 'unavailable');
  for (const feedState of ['degraded', 'stale', 'partial', 'fallback']) {
    assert.equal(
      classifyLayerSnapshot({ feedState, meta: feedState }).settled,
      true,
      feedState,
    );
  }
  assert.equal(classifyLayerSnapshot({ feedState: 'banana' }).kind, 'invalid');
  assert.equal(layerToggleVerdict({ missing: true }).ok, false);
  assert.equal(
    layerToggleVerdict({
      feedState: 'nominal',
      meta: 'Aircraft · never',
      countText: '—',
    }).ok,
    false,
  );
});

test('style keys 1 through 7 must land on the shell indicator names', () => {
  const observed = [
    { key: '1', activeStyle: 'normal', indicatorText: 'NORMAL' },
    { key: '2', activeStyle: 'retro', indicatorText: 'CRT' },
    { key: '3', activeStyle: 'surveillance', indicatorText: 'NVG' },
    { key: '4', activeStyle: 'thermal', indicatorText: 'FLIR' },
    { key: '5', activeStyle: 'anime', indicatorText: 'ANIME' },
    { key: '6', activeStyle: 'noir', indicatorText: 'NOIR' },
    { key: '7', activeStyle: 'snow', indicatorText: 'SNOW' },
  ];
  assert.equal(styleSwitchVerdict(observed).ok, true);
  const missed = styleSwitchVerdict(
    observed.map((row) =>
      row.key === '4' ? { ...row, indicatorText: 'THERMAL' } : row,
    ),
  );
  assert.equal(missed.ok, false);
  assert.match(missed.mismatches[0], /4:/);
  assert.equal(styleSwitchVerdict([]).ok, false);
});

test('heap and frame budgets are strict upper bounds and fail closed without samples', () => {
  const under = heapVerdict({
    usedBytes: 100 * 1024 * 1024,
    ceilingMib: 600,
    memoryPresent: true,
  });
  assert.equal(under.ok, true);
  assert.ok(under.usedMib > 99 && under.usedMib < 101);
  assert.equal(
    heapVerdict({
      usedBytes: 600 * 1024 * 1024,
      ceilingMib: 600,
      memoryPresent: true,
    }).ok,
    false,
  );
  assert.match(
    heapVerdict({ memoryPresent: false, ceilingMib: 600 }).reason,
    /absent/,
  );
  assert.equal(
    heapVerdict({ usedBytes: Number.NaN, ceilingMib: 600, memoryPresent: true })
      .ok,
    false,
  );

  assert.equal(
    frameVerdict({ medianMs: 249.9, budgetMs: 250, sampleCount: 30 }).ok,
    true,
  );
  assert.equal(
    frameVerdict({
      medianMs: 250,
      budgetMs: 250,
      sampleCount: 30,
      enforced: true,
    }).ok,
    false,
  );
  assert.equal(DEFAULT_FRAME_BUDGET_MS, 1500);
  const advisoryFrames = frameVerdict({
    medianMs: 716.6,
    budgetMs: 250,
    sampleCount: 7,
  });
  assert.equal(advisoryFrames.ok, true);
  assert.equal(advisoryFrames.enforced, false);
  assert.equal(advisoryFrames.withinBudget, false);
  assert.match(advisoryFrames.warning, /^WARNING: median frame 716\.6 ms/);
  const enforcedFrames = frameVerdict({
    medianMs: 716.6,
    budgetMs: 250,
    sampleCount: 7,
    enforced: true,
  });
  assert.equal(enforcedFrames.ok, false);
  assert.equal(enforcedFrames.enforced, true);
  assert.equal(enforcedFrames.withinBudget, false);
  assert.equal(enforcedFrames.warning, null);
  assert.equal(
    frameVerdict({
      medianMs: 716.6,
      budgetMs: DEFAULT_FRAME_BUDGET_MS,
      sampleCount: 7,
    }).ok,
    true,
  );
  assert.equal(
    frameVerdict({
      medianMs: null,
      budgetMs: 250,
      sampleCount: 0,
      enforced: true,
    }).ok,
    false,
  );
  assert.equal(median([4, 1, 3]), 3);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), null);
  const summary = summarizeFrameSamples([0, 10, 30, 20]);
  assert.equal(summary.sampleCount, 3);
  assert.equal(summary.medianMs, 20);
  assert.equal(summary.maxMs, 30);
});

test('the report fails closed and teeth only exits 1 when the launcher assertion went red', () => {
  const report = shapeSmokeReport({
    url: 'http://127.0.0.1:4301/',
    startedAt: 't0',
    finishedAt: 't1',
    options: { heapCeilingMib: 600 },
    assertions: {
      firstRun: { ok: true },
      layers: { ok: false },
    },
    screenshots: ['qa-shots/ci-smoke/01-first-run.png'],
    allowlisted: { total: 2, samples: [] },
    harnessError: null,
  });
  assert.equal(report.ok, false);
  assert.equal(report.summary.passed, 1);
  assert.equal(report.summary.failed, 1);
  assert.equal(report.summary.advisory, 0);
  assert.deepEqual(report.advisoryWarnings, []);
  assert.deepEqual(report.summary.names, [
    { name: 'firstRun', ok: true },
    { name: 'layers', ok: false },
  ]);
  assert.equal(
    shapeSmokeReport({
      url: null,
      startedAt: 't0',
      finishedAt: 't1',
      options: {},
      assertions: { readiness: { ok: true } },
      screenshots: [],
      allowlisted: {},
      harnessError: 'vite preview exited',
    }).ok,
    false,
  );
  assert.equal(
    smokeExitCode({
      ok: true,
      teeth: false,
      firstRunOk: true,
      harnessError: null,
    }),
    0,
  );
  assert.equal(
    smokeExitCode({
      ok: false,
      teeth: false,
      firstRunOk: true,
      harnessError: null,
    }),
    1,
  );
  assert.equal(
    smokeExitCode({
      ok: false,
      teeth: true,
      firstRunOk: false,
      harnessError: null,
    }),
    1,
  );
  assert.equal(
    smokeExitCode({
      ok: true,
      teeth: true,
      firstRunOk: true,
      harnessError: null,
    }),
    2,
  );
  assert.equal(
    smokeExitCode({
      ok: false,
      teeth: true,
      firstRunOk: false,
      harnessError: 'crashed',
    }),
    2,
  );
});

test('an over-budget orbit warns without failing unless frame enforcement is on', () => {
  const frames = frameVerdict({
    medianMs: 2583.2,
    budgetMs: 1500,
    sampleCount: 2,
  });
  assert.equal(frames.ok, true);
  assert.equal(frames.enforced, false);
  const report = shapeSmokeReport({
    url: 'http://127.0.0.1:4301/',
    startedAt: 't0',
    finishedAt: 't1',
    options: { enforceFrameBudget: false, frameBudgetMs: 1500 },
    assertions: {
      console: { ok: true },
      firstRun: { ok: true },
      layers: { ok: true },
      styles: { ok: true },
      performance: { ok: true, frames },
    },
    screenshots: [],
    allowlisted: { total: 0, samples: [] },
    advisoryWarnings: [frames.warning],
    harnessError: null,
  });
  assert.equal(report.ok, true);
  assert.equal(report.summary.failed, 0);
  assert.equal(report.summary.advisory, 1);
  assert.equal(report.assertions.performance.frames.enforced, false);
  assert.match(report.advisoryWarnings[0], /^WARNING:/);
  assert.equal(
    smokeExitCode({
      ok: report.ok,
      teeth: false,
      firstRunOk: true,
      harnessError: null,
    }),
    0,
  );

  const enforced = frameVerdict({
    medianMs: 2583.2,
    budgetMs: 1500,
    sampleCount: 2,
    enforced: true,
  });
  assert.equal(enforced.ok, false);
  assert.equal(enforced.enforced, true);
  const failed = shapeSmokeReport({
    url: 'http://127.0.0.1:4301/',
    startedAt: 't0',
    finishedAt: 't1',
    options: { enforceFrameBudget: true },
    assertions: {
      performance: { ok: false, frames: enforced },
    },
    screenshots: [],
    allowlisted: {},
    advisoryWarnings: [],
    harnessError: null,
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.summary.failed, 1);
  assert.equal(failed.summary.advisory, 0);
  assert.equal(failed.assertions.performance.frames.enforced, true);

  assert.equal(
    smokeExitCode({
      ok: false,
      teeth: true,
      firstRunOk: false,
      harnessError: null,
    }),
    1,
  );
});

test('the harness serves dist, writes the smoke report, and does not build', () => {
  const source = readFileSync(
    new URL('../../scripts/ci-browser-smoke.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /vite\.js/);
  assert.match(source, /'preview'/);
  assert.match(source, /'dist', 'index.html'/);
  assert.match(source, /'qa-shots', 'ci-smoke'/);
  assert.match(source, /report\.json/);
  assert.match(source, /browserLaunchArgs/);
  assert.match(source, /--teeth/);
  assert.doesNotMatch(source, /\[\s*viteBin,\s*'build'/);
});
