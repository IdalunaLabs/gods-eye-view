import assert from 'node:assert/strict';
import test from 'node:test';
import { configureApplicationViewer } from './viewer.js';

test('configureApplicationViewer disables FXAA and parks the globe', () => {
  const fxaa = { enabled: true };
  const viewer = {
    targetFrameRate: undefined,
    scene: {
      globe: { show: true },
      skyAtmosphere: {
        show: false,
        atmosphereLightIntensity: 0,
        saturationShift: 0,
        brightnessShift: 0,
      },
      postProcessStages: { fxaa },
    },
  };
  assert.equal(configureApplicationViewer(viewer), viewer);
  assert.equal(viewer.targetFrameRate, 60);
  assert.equal(viewer.scene.globe.show, false);
  assert.equal(viewer.scene.skyAtmosphere.show, true);
  assert.equal(fxaa.enabled, false);
});

test('configureApplicationViewer is a no-op on FXAA when the stage is missing', () => {
  const viewer = {
    scene: {
      globe: { show: true },
      skyAtmosphere: {},
      postProcessStages: {},
    },
  };
  configureApplicationViewer(viewer);
  assert.equal(viewer.scene.globe.show, false);
});

test('configureApplicationViewer rejects a missing scene', () => {
  assert.throws(
    () => configureApplicationViewer({}),
    /requires a Cesium viewer/,
  );
});
