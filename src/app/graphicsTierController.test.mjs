import assert from 'node:assert/strict';
import test from 'node:test';
import { installGraphicsTierController } from './graphicsTierController.js';
import { GRAPHICS_TIER_STORAGE_KEY } from '../graphicsTier.js';

function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
  };
}

function fakeBattery({ charging = true } = {}) {
  const listeners = new Set();
  return {
    charging,
    addEventListener(type, fn) {
      if (type === 'chargingchange') listeners.add(fn);
    },
    removeEventListener(type, fn) {
      if (type === 'chargingchange') listeners.delete(fn);
    },
    emit() {
      for (const fn of listeners) fn();
    },
  };
}

function makeHarness({
  height = 10_000,
  storage,
  documentHidden = false,
  getBattery,
  devicePixelRatio = 1,
  hdrSupported = true,
} = {}) {
  const calls = { requestRender: [] };
  const fxaa = { enabled: true };
  const ao = { enabled: false };
  const defaultLight = { kind: 'default' };
  const cameraListeners = new Set();
  const visibilityListeners = new Set();
  const tileset = {
    maximumScreenSpaceError: 16,
    isDestroyed: () => false,
  };
  const documentRef = {
    hidden: documentHidden,
    addEventListener(type, fn) {
      if (type === 'visibilitychange') visibilityListeners.add(fn);
    },
    removeEventListener(type, fn) {
      if (type === 'visibilitychange') visibilityListeners.delete(fn);
    },
    emit() {
      for (const fn of visibilityListeners) fn();
    },
  };
  const scene = {
    msaaSamples: 4,
    highDynamicRange: false,
    highDynamicRangeSupported: hdrSupported,
    light: defaultLight,
    postProcessStages: {
      fxaa,
      ambientOcclusion: ao,
    },
  };
  const viewer = {
    useBrowserRecommendedResolution: true,
    resolutionScale: 1,
    targetFrameRate: 60,
    scene,
    camera: {
      positionCartographic: { height },
      changed: {
        addEventListener(fn) {
          cameraListeners.add(fn);
          return () => cameraListeners.delete(fn);
        },
      },
    },
  };
  const lights = [];
  const controller = installGraphicsTierController({
    viewer,
    tileset,
    requestRender: (reason) => calls.requestRender.push(reason),
    storage: storage || fakeStorage(),
    documentRef,
    navigatorRef: {
      getBattery: getBattery || undefined,
    },
    getDevicePixelRatio: () => devicePixelRatio,
    createSunLight: () => {
      const light = { kind: 'sun', id: lights.length };
      lights.push(light);
      return light;
    },
    getCameraHeightMeters: () => viewer.camera.positionCartographic.height,
  });
  return {
    controller,
    viewer,
    scene,
    tileset,
    fxaa,
    ao,
    defaultLight,
    lights,
    calls,
    documentRef,
    cameraListeners,
    setHeight(value) {
      viewer.camera.positionCartographic.height = value;
      for (const fn of cameraListeners) fn();
    },
  };
}

test('install requires a Cesium viewer', () => {
  assert.throws(
    () => installGraphicsTierController({}),
    /requires a Cesium viewer/,
  );
});

test('balanced auto on power sets 60 fps, 4x MSAA, sun light, and kills FXAA', () => {
  const h = makeHarness();
  assert.equal(h.controller.getSelection(), 'auto');
  assert.equal(h.controller.getDiagnostics().resolved, 'balanced');
  assert.equal(h.viewer.useBrowserRecommendedResolution, false);
  assert.equal(h.viewer.resolutionScale, 1);
  assert.equal(h.scene.msaaSamples, 4);
  assert.equal(h.viewer.targetFrameRate, 60);
  assert.equal(h.fxaa.enabled, false);
  assert.equal(h.scene.highDynamicRange, false);
  assert.equal(h.scene.light.kind, 'sun');
  assert.equal(h.ao.enabled, false);
  assert.equal(h.tileset.maximumScreenSpaceError, 16);
  assert.equal(h.calls.requestRender.at(-1), 'graphics-tier');
  h.controller.destroy();
});

test('battery selection caps the frame rate, drops MSAA, and restores the default light', () => {
  const h = makeHarness();
  h.controller.setSelection('battery');
  assert.equal(h.controller.getDiagnostics().resolved, 'battery');
  assert.equal(h.viewer.targetFrameRate, 30);
  assert.equal(h.scene.msaaSamples, 1);
  assert.equal(h.scene.light, h.defaultLight);
  assert.equal(h.scene.highDynamicRange, false);
  assert.equal(h.tileset.maximumScreenSpaceError, 32);
  h.controller.destroy();
});

test('cinematic uses device pixels, uncapped fps, HDR, and near-range AO', () => {
  const h = makeHarness({ devicePixelRatio: 2, height: 500 });
  h.controller.setSelection('cinematic');
  assert.equal(h.viewer.resolutionScale, 2);
  assert.equal(h.viewer.targetFrameRate, undefined);
  assert.equal(h.scene.msaaSamples, 2);
  assert.equal(h.scene.highDynamicRange, true);
  assert.equal(h.ao.enabled, true);
  assert.equal(h.tileset.maximumScreenSpaceError, 8);
  h.setHeight(5000);
  assert.equal(h.ao.enabled, false);
  h.setHeight(1500);
  assert.equal(h.ao.enabled, true);
  h.controller.destroy();
});

test('HDR stays off when the scene reports it unsupported', () => {
  const h = makeHarness({ hdrSupported: false });
  h.controller.setSelection('cinematic');
  assert.equal(h.scene.highDynamicRange, false);
  h.controller.destroy();
});

test('auto tracks battery discharging and tab visibility', async () => {
  const battery = fakeBattery({ charging: true });
  const h = makeHarness({
    getBattery: async () => battery,
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(h.controller.getDiagnostics().resolved, 'balanced');
  battery.charging = false;
  battery.emit();
  assert.equal(h.controller.getDiagnostics().resolved, 'battery');
  assert.equal(h.controller.getDiagnostics().batteryDischarging, true);
  battery.charging = true;
  battery.emit();
  assert.equal(h.controller.getDiagnostics().resolved, 'balanced');
  h.documentRef.hidden = true;
  h.documentRef.emit();
  assert.equal(h.controller.getDiagnostics().resolved, 'battery');
  h.controller.destroy();
});

test('selection persists and subscribers hear the resolved preset', () => {
  const storage = fakeStorage();
  const seen = [];
  const h = makeHarness({ storage });
  const stop = h.controller.subscribe((state) => seen.push(state.resolved));
  h.controller.setSelection('cinematic');
  assert.equal(storage.getItem(GRAPHICS_TIER_STORAGE_KEY), 'cinematic');
  assert.equal(seen.includes('cinematic'), true);
  stop();
  const next = makeHarness({ storage, devicePixelRatio: 2 });
  assert.equal(next.controller.getSelection(), 'cinematic');
  assert.equal(next.viewer.resolutionScale, 2);
  h.controller.destroy();
  next.controller.destroy();
});

test('destroy drops listeners so a later visibility event cannot apply', () => {
  const h = makeHarness();
  h.controller.destroy();
  h.documentRef.hidden = true;
  h.documentRef.emit();
  assert.equal(h.viewer.targetFrameRate, 60);
});
