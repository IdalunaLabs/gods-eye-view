import { action as analystQuery } from './analystQuery.js';
import { action as annotateMap } from './annotateMap.js';
import { action as controlCctv } from './controlCctv.js';
import { action as controlRadio } from './controlRadio.js';
import { action as flyRoute } from './flyRoute.js';
import { createGevActionRunner } from '../gevActions.js';
import {
  getActiveCameraMotion,
  interruptCameraMotion,
} from '../../cameraVerbs.js';
import { runExplicitNavigation } from '../../navigationPolicy.js';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import test from 'node:test';

function voiceViewer() {
  const position = Cesium.Cartesian3.fromDegrees(-97.74, 30.26, 500);
  return {
    clock: { onTick: { addEventListener: () => () => {} } },
    scene: {
      canvas: {
        clientWidth: 1200,
        clientHeight: 800,
        addEventListener() {},
        removeEventListener() {},
      },
      globe: { getHeight: () => 0 },
      tweens: [],
    },
    camera: {
      moveEnd: { addEventListener() {} },
      positionWC: position,
      positionCartographic: Cesium.Cartographic.fromCartesian(position),
      heading: Cesium.Math.toRadians(28),
      pitch: Cesium.Math.toRadians(-45),
      cancelFlight() {},
      flyToBoundingSphere() {},
      lookAtTransform() {},
    },
    trackedEntity: undefined,
  };
}

test('annotate_map draws without clearing earlier marks', async () => {
  assert.equal(annotateMap.name, 'annotate_map');
  globalThis.window = globalThis.window || {
    clearTimeout,
    setTimeout,
    requestIdleCallback: null,
  };
  const seen = [];
  const runner = createGevActionRunner({
    viewer: voiceViewer(),
    styleManager: {},
    dataManager: { layers: new Map(), getAll: () => [] },
    annotations: {
      async annotate(requests, options) {
        seen.push({ requests, options });
        return {
          drawn: 1,
          failed: 0,
          capped: false,
          results: [{ ok: true, target: 'Austin' }],
        };
      },
    },
  });

  const result = await runner('annotate_map', {
    annotations: [{ target: '  Austin  ', label: 'Here' }],
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, 'annotate_map');
  assert.equal(result.drawn, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.error, null);
  assert.equal(seen[0].options.clearPrevious, false);
  assert.equal(seen[0].requests[0].target, 'Austin');
});

test('analyst_query compacts one loaded flight for the voice payload', async () => {
  assert.equal(analystQuery.name, 'analyst_query');
  globalThis.window = globalThis.window || {
    clearTimeout,
    setTimeout,
    requestIdleCallback: null,
  };
  const runner = createGevActionRunner({
    viewer: {
      clock: { onTick: { addEventListener: () => () => {} } },
      scene: { canvas: { addEventListener() {}, removeEventListener() {} } },
      camera: {
        moveEnd: { addEventListener() {} },
        positionCartographic: {
          height: 300000,
          latitude: 0.52,
          longitude: -1.71,
        },
      },
    },
    styleManager: {},
    dataManager: {
      layers: new Map([
        [
          'flights',
          {
            module: {
              getAnalystRecords: () => [
                {
                  id: 'SWA1',
                  icao24: 'abc123',
                  callsign: 'SWA1',
                  lat: 30.2,
                  lon: -97.7,
                  onGround: false,
                  altitudeM: 1000,
                },
              ],
            },
          },
        ],
      ]),
      isEnabled: () => true,
      getAll: () => [],
    },
  });

  const result = await runner('analyst_query', {
    layers: ['flights'],
    scope: { kind: 'view' },
    limit: 1,
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, 'analyst_query');
  assert.equal(result.count, 1);
  assert.equal(result.items[0].callsign, 'SWA1');
  assert.equal(result.items[0].icao24, 'abc123');
});

test('control_cctv coverage writes the durable coverage mode', async () => {
  assert.equal(controlCctv.name, 'control_cctv');
  globalThis.window = globalThis.window || {
    clearTimeout,
    setTimeout,
    requestIdleCallback: null,
  };
  let coverageMode = 'viewshed';
  const calls = [];
  const runner = createGevActionRunner({
    viewer: voiceViewer(),
    styleManager: {},
    dataManager: {
      layers: new Map([
        [
          'cctv',
          {
            module: {
              getUIState: () => ({
                coverageMode,
                showCoverage: coverageMode !== 'off',
              }),
            },
          },
        ],
      ]),
      isEnabled: () => true,
      setLayerParams(layerId, params, options) {
        calls.push([layerId, params, options]);
        coverageMode = params.coverageMode;
      },
    },
  });

  const result = await runner('control_cctv', { action: 'coverage' });

  assert.equal(result.ok, true);
  assert.equal(result.coverageMode, 'off');
  assert.deepEqual(calls, [
    ['cctv', { coverageMode: 'off' }, { origin: 'voice' }],
  ]);
});

test('control_radio status reads the player without changing it', async () => {
  assert.equal(controlRadio.name, 'control_radio');
  globalThis.window = globalThis.window || {
    clearTimeout,
    setTimeout,
    requestIdleCallback: null,
  };
  const calls = [];
  const runner = createGevActionRunner({
    viewer: voiceViewer(),
    styleManager: {},
    dataManager: {
      layers: new Map([
        [
          'radio',
          {
            module: {
              getUIState: () => ({
                stationCount: 4,
                filter: 'news',
                selected: { id: 'aus-news', name: 'Austin News' },
                audioState: 'playing',
                volume: 0.8,
                voiceDucked: true,
              }),
              setVolume() {
                calls.push('volume');
              },
            },
          },
        ],
      ]),
      isEnabled: () => true,
    },
  });

  const result = await runner('control_radio', { action: 'status' });

  assert.equal(result.ok, true);
  assert.equal(result.action, 'control_radio');
  assert.equal(result.stationId, 'aus-news');
  assert.equal(result.audioState, 'playing');
  assert.equal(result.volumePct, 80);
  assert.deepEqual(calls, []);
});

test('fly_route validates the named route before the camera authority seam', async () => {
  assert.equal(flyRoute.name, 'fly_route');
  globalThis.window = globalThis.window || {
    clearTimeout,
    setTimeout,
    requestIdleCallback: null,
  };
  const order = [];
  const viewer = voiceViewer();
  viewer.trackedEntity = { id: 'prior-aircraft' };
  const runner = createGevActionRunner({
    viewer,
    styleManager: {
      runImmediateNavigation(noun, navigate) {
        return runExplicitNavigation({
          cockpitActive: false,
          noun,
          stamp: () => {
            order.push(`stamp:${noun}`);
            return 1;
          },
          release: () => {
            order.push('release');
            viewer.trackedEntity = undefined;
            interruptCameraMotion('test-release');
            viewer.camera.cancelFlight();
          },
          navigate,
        });
      },
    },
    dataManager: { layers: new Map(), getAll: () => [] },
    annotations: {
      list: () => [
        {
          type: 'route',
          label: 'harbor route',
          path: [
            { lat: 29.75, lon: -95.36 },
            { lat: 29.76, lon: -95.34 },
          ],
        },
      ],
    },
    floorServices: {
      cachedGroundFloor: () => 0,
      warmGroundFloor: () => {},
    },
  });

  const result = await runner('fly_route', { label: 'harbor' });

  assert.equal(result.ok, true);
  assert.deepEqual(order, ['stamp:route', 'release']);
  assert.equal(getActiveCameraMotion()?.kind, 'route');
  interruptCameraMotion('test-cleanup');
});
