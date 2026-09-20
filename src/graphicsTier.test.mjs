import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  GRAPHICS_TIER_DEFAULT_SELECTION,
  GRAPHICS_TIER_IDS,
  GRAPHICS_TIER_SELECTIONS,
  GRAPHICS_TIER_STORAGE_KEY,
  MAX_CINEMATIC_RESOLUTION_SCALE,
  NEAR_AMBIENT_OCCLUSION_HEIGHT_M,
  cinematicResolutionScale,
  clampDetectionDensity,
  graphicsTierPreset,
  normalizeGraphicsTierSelection,
  readStoredGraphicsTierSelection,
  resolveGraphicsTier,
  writeStoredGraphicsTierSelection,
} from './graphicsTier.js';

function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    dump: () => Object.fromEntries(map),
  };
}

test('auto resolves to battery while hidden or discharging, else balanced', () => {
  assert.equal(resolveGraphicsTier({}), 'balanced');
  assert.equal(
    resolveGraphicsTier({ selection: 'auto', batteryDischarging: true }),
    'battery',
  );
  assert.equal(
    resolveGraphicsTier({ selection: 'auto', documentHidden: true }),
    'battery',
  );
  assert.equal(
    resolveGraphicsTier({
      selection: 'auto',
      batteryDischarging: true,
      documentHidden: true,
    }),
    'battery',
  );
});

test('an explicit selection always wins over power and visibility', () => {
  assert.equal(
    resolveGraphicsTier({
      selection: 'cinematic',
      batteryDischarging: true,
      documentHidden: true,
    }),
    'cinematic',
  );
  assert.equal(
    resolveGraphicsTier({ selection: 'battery', batteryDischarging: false }),
    'battery',
  );
  assert.equal(
    resolveGraphicsTier({ selection: 'BALANCED', documentHidden: true }),
    'balanced',
  );
});

test('unknown or empty selections fall back to auto, then balanced', () => {
  assert.equal(
    normalizeGraphicsTierSelection(''),
    GRAPHICS_TIER_DEFAULT_SELECTION,
  );
  assert.equal(
    normalizeGraphicsTierSelection('ultra'),
    GRAPHICS_TIER_DEFAULT_SELECTION,
  );
  assert.equal(
    normalizeGraphicsTierSelection(null),
    GRAPHICS_TIER_DEFAULT_SELECTION,
  );
  assert.equal(resolveGraphicsTier({ selection: 'nope' }), 'balanced');
  assert.deepEqual(
    [...GRAPHICS_TIER_SELECTIONS],
    ['auto', 'battery', 'balanced', 'cinematic'],
  );
  assert.deepEqual(
    [...GRAPHICS_TIER_IDS],
    ['battery', 'balanced', 'cinematic'],
  );
});

test('battery, balanced and cinematic knobs stay distinct and frozen', () => {
  const battery = graphicsTierPreset('battery');
  const balanced = graphicsTierPreset('balanced');
  const cinematic = graphicsTierPreset('cinematic', { devicePixelRatio: 2 });
  assert.equal(battery.msaaSamples, 1);
  assert.equal(battery.targetFrameRate, 30);
  assert.equal(battery.styleTickHz, 15);
  assert.equal(battery.tilesetMaximumScreenSpaceError, 32);
  assert.equal(battery.hdr, false);
  assert.equal(battery.sunLight, false);
  assert.equal(battery.nearAmbientOcclusion, false);
  assert.equal(battery.detectionDensityCap, 25);
  assert.equal(battery.resolutionScale, 1);

  assert.equal(balanced.msaaSamples, 4);
  assert.equal(balanced.targetFrameRate, 60);
  assert.equal(balanced.styleTickHz, 30);
  assert.equal(balanced.tilesetMaximumScreenSpaceError, 16);
  assert.equal(balanced.sunLight, true);
  assert.equal(balanced.detectionDensityCap, null);

  assert.equal(cinematic.msaaSamples, 2);
  assert.equal(cinematic.targetFrameRate, null);
  assert.equal(cinematic.styleTickHz, 60);
  assert.equal(cinematic.tilesetMaximumScreenSpaceError, 8);
  assert.equal(cinematic.hdr, true);
  assert.equal(cinematic.nearAmbientOcclusion, true);
  assert.equal(cinematic.resolutionScale, 2);
  assert.throws(() => {
    cinematic.hdr = false;
  });
});

test('cinematic resolution scale uses devicePixelRatio and caps at 2', () => {
  assert.equal(cinematicResolutionScale(1), 1);
  assert.equal(cinematicResolutionScale(1.5), 1.5);
  assert.equal(cinematicResolutionScale(3), MAX_CINEMATIC_RESOLUTION_SCALE);
  assert.equal(cinematicResolutionScale(0), 1);
  assert.equal(cinematicResolutionScale(Number.NaN), 1);
  assert.equal(
    graphicsTierPreset('cinematic', { devicePixelRatio: 3 }).resolutionScale,
    2,
  );
  assert.equal(NEAR_AMBIENT_OCCLUSION_HEIGHT_M, 2000);
});

test('detection density cap clamps without inventing a slider value', () => {
  assert.equal(clampDetectionDensity(75, 25), 25);
  assert.equal(clampDetectionDensity(0, 25), 0);
  assert.equal(clampDetectionDensity(75, null), 75);
  assert.equal(clampDetectionDensity(75, undefined), 75);
  assert.equal(Number.isNaN(clampDetectionDensity(Number.NaN, 25)), true);
});

test('graphics tier selection round-trips through storage and survives junk', () => {
  const storage = fakeStorage();
  assert.equal(readStoredGraphicsTierSelection(storage), 'auto');
  assert.equal(
    writeStoredGraphicsTierSelection('cinematic', storage),
    'cinematic',
  );
  assert.equal(readStoredGraphicsTierSelection(storage), 'cinematic');
  assert.equal(storage.dump()[GRAPHICS_TIER_STORAGE_KEY], 'cinematic');
  assert.equal(
    readStoredGraphicsTierSelection(
      fakeStorage({ [GRAPHICS_TIER_STORAGE_KEY]: 'nope' }),
    ),
    'auto',
  );
  const exploding = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
  };
  assert.equal(readStoredGraphicsTierSelection(exploding), 'auto');
  assert.equal(
    writeStoredGraphicsTierSelection('battery', exploding),
    'battery',
  );
});

test('DISPLAY markup ships the four graphics-tier buttons', () => {
  const html = readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'ui/templates/display-controls.html',
    ),
    'utf8',
  );
  for (const id of GRAPHICS_TIER_SELECTIONS) {
    assert.match(html, new RegExp(`data-tier="${id}"`));
  }
  assert.match(html, /id="graphics-tier-row"/);
});
