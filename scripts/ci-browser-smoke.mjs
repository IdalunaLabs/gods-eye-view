#!/usr/bin/env node
/**
 * Production-bundle browser smoke gate.
 *
 * Expects `dist/` from `npm run build`. Starts `vite preview` (the standalone
 * config serves that bundle plus local provider middleware) on a free port
 * with credentials blanked, then drives headless Chromium with the SwiftShader
 * flags used by the other QA harnesses.
 *
 * Readiness is the loading screen leaving, not the DEV-only QA registration
 * hooks. `window.__godsEyeView` is the production session handle the app
 * already publishes; the orbit uses it. `--teeth` removes the first-run
 * launcher and must make that assertion fail (exit 1). Exit 2 means the
 * control itself did not run.
 *
 *   npm run build && npm run qa:ci-smoke
 *   node scripts/ci-browser-smoke.mjs --teeth
 *   node scripts/ci-browser-smoke.mjs --enforce-frame-budget
 *
 * The orbit frame budget is printed and recorded always. It fails the run
 * only with `--enforce-frame-budget` or `GEV_SMOKE_ENFORCE_FRAMES=1`.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer';
import {
  DEFAULT_PREVIEW_PORT,
  SMOKE_LAYERS,
  STYLE_KEY_SEQUENCE,
  browserLaunchArgs,
  chromeCandidatePaths,
  classifyLayerSnapshot,
  distReadiness,
  frameVerdict,
  heapVerdict,
  keylessPreviewEnv,
  parseSmokeArgs,
  partitionConsoleMessages,
  shapeSmokeReport,
  smokeExitCode,
  styleSwitchVerdict,
  summarizeAllowlisted,
  summarizeFrameSamples,
} from './ci-browser-smoke-verdicts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT_DIR = path.join(ROOT, 'qa-shots', 'ci-smoke');
const REPORT_PATH = path.join(SHOT_DIR, 'report.json');
const LAYER_SETTLE_MS = 70_000;
const READY_TIMEOUT_MS = 90_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Bind a TCP port, then release it. A later preview bind can still race.
 * @param {number} port
 * @returns {Promise<number>}
 */
function reservePort(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const reserved = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(reserved)));
    });
  });
}

/**
 * Pick an explicit port or the first free port at or above the default.
 * @param {number|null} requested
 * @returns {Promise<number>}
 */
async function choosePreviewPort(requested) {
  if (requested) {
    await reservePort(requested);
    return requested;
  }
  for (
    let port = DEFAULT_PREVIEW_PORT;
    port < DEFAULT_PREVIEW_PORT + 20;
    port += 1
  ) {
    try {
      return await reservePort(port);
    } catch {
      /* try the next port */
    }
  }
  throw new Error(`no free preview port from ${DEFAULT_PREVIEW_PORT}`);
}

/**
 * Start vite preview and resolve once the document responds.
 * @param {number} port
 * @returns {Promise<{child: import('node:child_process').ChildProcess, url: string, logs: () => string}>}
 */
async function startPreview(port) {
  const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const env = keylessPreviewEnv(process.env);
  env.PORT = String(port);
  env.HOST = '127.0.0.1';
  const child = spawn(
    process.execPath,
    [
      viteBin,
      'preview',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
    ],
    { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let logs = '';
  const capture = (chunk) => {
    logs = (logs + chunk.toString()).slice(-12_000);
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  const url = `http://127.0.0.1:${port}/`;
  const deadline = Date.now() + 30_000;
  let lastError = 'preview did not listen';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`vite preview exited ${child.exitCode}\n${logs}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return { child, url, logs: () => logs };
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error?.message || String(error);
    }
    await sleep(250);
  }
  child.kill('SIGTERM');
  throw new Error(`vite preview was not ready (${lastError})\n${logs}`);
}

/**
 * Stop a preview process by its own PID.
 * @param {import('node:child_process').ChildProcess|null} child
 */
async function stopPreview(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const pid = child.pid;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    sleep(5_000).then(() => false),
  ]);
  if (!exited) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      sleep(2_000),
    ]);
  }
}

/**
 * @param {import('puppeteer').Page} page
 * @param {string} name
 * @returns {Promise<string|null>}
 */
async function shoot(page, name) {
  const file = path.join(SHOT_DIR, `${name}.png`);
  await page.screenshot({ path: file, type: 'png' });
  return path.relative(ROOT, file);
}

/**
 * @param {import('puppeteer').Page} page
 * @param {string} layerId
 */
async function readLayer(page, layerId) {
  return page.evaluate((id) => {
    const row = document.querySelector(`[data-layer-id="${id}"]`);
    if (!row)
      return {
        missing: true,
        feedState: '',
        label: '',
        meta: '',
        countText: '',
      };
    const button = row.querySelector('.data-toggle-btn');
    return {
      missing: false,
      feedState: button?.dataset.feedState || '',
      label: button?.textContent?.trim() || '',
      meta: row.querySelector('.data-toggle-meta')?.textContent?.trim() || '',
      countText: row.querySelector('.data-count')?.textContent?.trim() || '',
    };
  }, layerId);
}

/**
 * Expand the layers panel, enable one layer, and wait until its chip settles.
 * @param {import('puppeteer').Page} page
 * @param {string} layerId
 */
async function enableAndSettle(page, layerId) {
  const clicked = await page.evaluate((id) => {
    const row = document.querySelector(`[data-layer-id="${id}"]`);
    const button = row?.querySelector('.data-toggle-btn');
    if (!button) return { ok: false, reason: 'toggle missing' };
    button.scrollIntoView({ block: 'center' });
    button.click();
    return { ok: true };
  }, layerId);
  if (!clicked.ok) {
    return {
      ok: false,
      kind: 'invalid',
      reason: clicked.reason,
      missing: true,
    };
  }
  const deadline = Date.now() + LAYER_SETTLE_MS;
  let last = null;
  while (Date.now() < deadline) {
    last = await readLayer(page, layerId);
    const verdict = classifyLayerSnapshot(last);
    if (verdict.kind === 'invalid') return { ...last, ...verdict, ok: false };
    if (verdict.settled) return { ...last, ...verdict, ok: true };
    await sleep(500);
  }
  const verdict = classifyLayerSnapshot(last || {});
  return {
    ...(last || {}),
    ...verdict,
    ok: false,
    reason: `timed out: ${verdict.reason}`,
  };
}

/**
 * @param {import('puppeteer').Page} page
 * @param {number} durationMs
 */
async function measureOrbit(page, durationMs) {
  return page.evaluate(async (ms) => {
    const viewer = window.__godsEyeView?.viewer;
    if (!viewer?.camera || typeof viewer.camera.rotateRight !== 'function') {
      return {
        ok: false,
        reason: 'production viewer handle is missing',
        samples: [],
      };
    }
    try {
      viewer.camera.cancelFlight();
    } catch {
      /* a parked camera has nothing to cancel */
    }
    const samples = [];
    const started = performance.now();
    let previous = started;
    let failure = null;
    await new Promise((resolve) => {
      const tick = (now) => {
        samples.push(now - previous);
        previous = now;
        try {
          viewer.camera.rotateRight(0.004);
        } catch (error) {
          failure = error?.message || String(error);
          resolve();
          return;
        }
        if (now - started >= ms) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    return { ok: !failure, reason: failure, samples };
  }, durationMs);
}

/**
 * @param {import('puppeteer').Page} page
 */
async function readHeap(page) {
  return page.evaluate(() => {
    const memory = performance.memory;
    if (!memory)
      return {
        memoryPresent: false,
        usedBytes: null,
        totalBytes: null,
        limitBytes: null,
      };
    return {
      memoryPresent: true,
      usedBytes: memory.usedJSHeapSize,
      totalBytes: memory.totalJSHeapSize,
      limitBytes: memory.jsHeapSizeLimit,
    };
  });
}

/**
 * @param {import('puppeteer').Page} page
 */
async function readRenderer(page) {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl');
    if (!gl) return null;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext
      ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);
  });
}

/**
 * @param {object} options
 * @returns {Promise<number>}
 */
async function run(options) {
  mkdirSync(SHOT_DIR, { recursive: true });
  const startedAt = new Date().toISOString();
  const screenshots = [];
  const consoleMessages = [];
  const assertions = {};
  let harnessError = null;
  let url = null;
  const advisoryWarnings = [];
  let preview = null;
  let browser = null;
  let firstRunOk = null;

  const recordShot = async (page, name) => {
    try {
      const relative = await shoot(page, name);
      if (relative) screenshots.push(relative);
    } catch (error) {
      screenshots.push(`${name}.png (failed: ${error.message})`);
    }
  };

  try {
    const dist = distReadiness(
      existsSync(path.join(ROOT, 'dist', 'index.html')),
    );
    if (!dist.ok) throw new Error(dist.reason);

    const port = await choosePreviewPort(options.port);
    preview = await startPreview(port);
    url = preview.url;
    console.log(`preview ${url} pid ${preview.child.pid}`);

    const executablePath = chromeCandidatePaths({
      envPath: process.env.PUPPETEER_EXECUTABLE_PATH,
      puppeteerPath: await puppeteer.executablePath().catch(() => null),
    }).find((candidate) => {
      try {
        return existsSync(candidate);
      } catch {
        return false;
      }
    });
    if (!executablePath) throw new Error('headless Chromium was not found');
    console.log(`chromium ${executablePath}`);

    browser = await puppeteer.launch({
      headless: 'new',
      executablePath,
      protocolTimeout: 120_000,
      args: browserLaunchArgs(),
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const location = message.location();
      const resource = location?.url ? `\n${location.url}` : '';
      consoleMessages.push({
        kind: 'console',
        text: `${message.text()}${resource}`,
      });
    });
    page.on('pageerror', (error) => {
      consoleMessages.push({
        kind: 'pageerror',
        text: error?.message || String(error),
      });
    });
    await page.evaluateOnNewDocument(() => {
      window.addEventListener('unhandledrejection', (event) => {
        const reason = event.reason;
        const text = reason?.stack || reason?.message || String(reason);
        console.error(`[unhandledrejection] ${text}`);
      });
    });
    if (options.teeth) {
      await page.evaluateOnNewDocument(() => {
        document.addEventListener('DOMContentLoaded', () => {
          document.getElementById('first-run-launcher')?.remove();
        });
      });
    }

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const ready = await page
      .waitForFunction(
        () =>
          document
            .getElementById('loading-screen')
            ?.classList.contains('hidden'),
        { timeout: READY_TIMEOUT_MS },
      )
      .then(() => true)
      .catch(() => false);
    const loaderStatus = await page
      .$eval(
        '#loading-screen .loader-status',
        (node) => node.textContent?.trim() || '',
      )
      .catch(() => '');
    assertions.readiness = {
      ok: ready,
      loaderStatus,
      reason: ready
        ? 'loading screen hidden'
        : `loading screen stayed up (${loaderStatus || 'no status'})`,
    };
    if (!ready) {
      await recordShot(page, '00-not-ready');
      throw new Error(assertions.readiness.reason);
    }

    // The launcher is revealed on the frame after the loading cover yields.
    // Waiting here is what makes `--teeth` meaningful: a removed card stays
    // absent for the whole window, and a card that merely appears late cannot
    // be scored as "did not render".
    const launcherVisible = await page
      .waitForFunction(
        () => {
          const root = document.getElementById('first-run-launcher');
          const explore = root?.querySelector(
            '[data-first-run-choice="explore"]',
          );
          return Boolean(
            root &&
            root.classList.contains('visible') &&
            root.getClientRects().length > 0 &&
            /explore manually/i.test(explore?.textContent || ''),
          );
        },
        { timeout: 15_000 },
      )
      .then(() => true)
      .catch(() => false);
    const firstRun = { rendered: launcherVisible };
    if (firstRun.rendered) await recordShot(page, '01-first-run');
    let dismissed = false;
    if (firstRun.rendered) {
      await page.click('[data-first-run-choice="explore"]');
      dismissed = await page
        .waitForFunction(
          () => {
            const root = document.getElementById('first-run-launcher');
            return !root || !root.classList.contains('visible');
          },
          { timeout: 10_000 },
        )
        .then(() => true)
        .catch(() => false);
    }
    assertions.firstRun = {
      ok: firstRun.rendered && dismissed,
      rendered: firstRun.rendered,
      dismissed,
      reason:
        firstRun.rendered && dismissed
          ? 'Explore Manually dismissed the launcher'
          : firstRun.rendered
            ? 'Explore Manually did not dismiss the launcher'
            : 'first-run launcher did not render',
    };
    firstRunOk = assertions.firstRun.ok;
    if (dismissed) await recordShot(page, '02-explore-dismissed');

    const collapsed = await page
      .$eval('#data-panel', (panel) => panel.classList.contains('collapsed'))
      .catch(() => null);
    if (collapsed === null) {
      assertions.layers = { ok: false, reason: 'layers panel is missing' };
    } else {
      if (collapsed) {
        await page.click('#data-panel .panel-collapse-btn');
        await page.waitForFunction(
          () =>
            !document
              .getElementById('data-panel')
              ?.classList.contains('collapsed'),
          { timeout: 5_000 },
        );
      }
      const layers = {};
      for (const layer of SMOKE_LAYERS) {
        console.log(`layer ${layer.id}`);
        layers[layer.id] = await enableAndSettle(page, layer.id);
      }
      assertions.layers = {
        ok: SMOKE_LAYERS.every((layer) => layers[layer.id]?.ok === true),
        ...layers,
      };
      await recordShot(page, '03-layers');
    }

    const styleObservations = [];
    for (const step of STYLE_KEY_SEQUENCE) {
      await page.keyboard.press(step.key);
      const observed = await page
        .waitForFunction(
          (style) =>
            document.querySelector('.style-btn.active')?.dataset.style ===
            style,
          { timeout: 5_000 },
          step.style,
        )
        .then(() => true)
        .catch(() => false);
      const reading = await page.evaluate(() => ({
        activeStyle:
          document.querySelector('.style-btn.active')?.dataset.style || '',
        indicatorText:
          document.getElementById('active-style-name')?.textContent?.trim() ||
          '',
      }));
      styleObservations.push({
        key: step.key,
        ...reading,
        waited: observed,
      });
    }
    const styles = styleSwitchVerdict(styleObservations);
    assertions.styles = { ...styles, observed: styleObservations };
    await recordShot(page, '04-styles');

    console.log(`idle ${options.idleMs} ms`);
    await sleep(options.idleMs);
    const heapReading = await readHeap(page);
    const heap = heapVerdict({
      usedBytes: heapReading.usedBytes,
      ceilingMib: options.heapCeilingMib,
      memoryPresent: heapReading.memoryPresent,
    });

    console.log(`orbit ${options.orbitMs} ms`);
    const orbit = await measureOrbit(page, options.orbitMs);
    const frames = summarizeFrameSamples(orbit.samples || []);
    const frame = frameVerdict({
      medianMs: orbit.ok ? frames.medianMs : null,
      budgetMs: options.frameBudgetMs,
      sampleCount: orbit.ok ? frames.sampleCount : 0,
      enforced: options.enforceFrameBudget,
      reason: orbit.ok ? null : orbit.reason || 'orbit failed',
    });
    if (!frame.withinBudget) {
      console.warn(frame.warning || `WARNING: ${frame.reason} (enforced)`);
    }
    if (frame.warning) advisoryWarnings.push(frame.warning);
    const renderer = await readRenderer(page);
    assertions.performance = {
      ok: heap.ok && frame.ok,
      heap: { ...heap, ...heapReading },
      frames: { ...frame, maxMs: frames.maxMs, renderer },
    };
    await recordShot(page, '05-orbit');
  } catch (error) {
    harnessError = error?.message || String(error);
    console.error(harnessError);
    if (assertions.firstRun) firstRunOk = assertions.firstRun.ok;
  } finally {
    const partitioned = partitionConsoleMessages(consoleMessages);
    assertions.console = {
      ok: partitioned.ok,
      unexpected: partitioned.unexpected.slice(0, 100),
      uncaught: partitioned.uncaught.slice(0, 100),
      allowlisted: summarizeAllowlisted(partitioned.allowlisted),
    };
    if (!assertions.readiness) {
      assertions.readiness = {
        ok: false,
        reason: harnessError || 'not reached',
      };
    }
    const report = shapeSmokeReport({
      url,
      startedAt,
      finishedAt: new Date().toISOString(),
      options,
      assertions,
      screenshots,
      allowlisted: assertions.console.allowlisted,
      advisoryWarnings,
      harnessError,
    });
    writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
    console.log(
      JSON.stringify(
        {
          ok: report.ok,
          exit: smokeExitCode({
            ok: report.ok,
            teeth: options.teeth,
            firstRunOk,
            harnessError,
          }),
          summary: report.summary,
          firstRun: assertions.firstRun || null,
          layers: assertions.layers
            ? Object.fromEntries(
                SMOKE_LAYERS.map((layer) => [
                  layer.id,
                  assertions.layers[layer.id]
                    ? {
                        ok: assertions.layers[layer.id].ok,
                        kind: assertions.layers[layer.id].kind,
                        feedState: assertions.layers[layer.id].feedState,
                        label: assertions.layers[layer.id].label,
                        meta: assertions.layers[layer.id].meta,
                        countText: assertions.layers[layer.id].countText,
                      }
                    : null,
                ]),
              )
            : assertions.layers,
          performance: assertions.performance || null,
          advisoryWarnings: report.advisoryWarnings,
          console: {
            ok: assertions.console.ok,
            unexpected: assertions.console.unexpected.length,
            uncaught: assertions.console.uncaught.length,
            allowlisted: assertions.console.allowlisted.total,
          },
          harnessError,
          report: path.relative(ROOT, REPORT_PATH),
        },
        null,
        2,
      ),
    );
    await browser?.close().catch(() => {});
    await stopPreview(preview?.child);
  }

  return smokeExitCode({
    ok:
      !harnessError &&
      Object.values(assertions).every((assertion) => assertion?.ok === true),
    teeth: options.teeth,
    firstRunOk,
    harnessError,
  });
}

async function main() {
  const options = parseSmokeArgs(process.argv.slice(2), process.env);
  const code = await run(options);
  process.exit(code);
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
