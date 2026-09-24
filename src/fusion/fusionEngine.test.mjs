import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createFusionEngine,
  DEFAULT_DETECTOR_FLAGS,
  FUSION_DETECTOR_STORAGE_KEY,
} from './fusionEngine.js';

function memoryStorage(initial) {
  const values = new Map(initial || []);
  return {
    values,
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
  };
}

function alert(id, kind = 'convergence') {
  return {
    id,
    kind,
    severity: 'watch',
    entities: [{ layer: 'flights', id: 'ABC', label: 'ABC' }],
    position: { lat: 30, lon: -97 },
    explanation: 'Dead-reckoned from heading/speed; not a prediction of intent.',
    confidence: 0.6,
    firstSeenMs: 0,
    lastSeenMs: 0,
  };
}

function harness(detected, storage = memoryStorage()) {
  const queued = [];
  let nextTimer = 1;
  let clock = 1_000;
  const renders = [];
  const engine = createFusionEngine({
    getRecords: () => [],
    storage,
    now: () => clock,
    intervalMs: 5000,
    schedule(fn) {
      const id = nextTimer;
      nextTimer += 1;
      queued.push({ id, fn });
      return id;
    },
    clearSchedule(id) {
      const index = queued.findIndex((item) => item.id === id);
      if (index >= 0) queued.splice(index, 1);
    },
    requestRender(reason) {
      renders.push(reason);
    },
    detect: () => detected.slice(),
  });
  return {
    engine,
    renders,
    storage,
    queued,
    setClock(value) {
      clock = value;
    },
    fire() {
      const job = queued.shift();
      assert.ok(job, 'expected a scheduled pass');
      job.fn();
    },
  };
}

test('fusion engine publishes after two consecutive hits and drops after three misses', () => {
  const detected = [alert('c1')];
  const { engine, renders, fire } = harness(detected);
  engine.start();
  fire();
  assert.equal(engine.getAlerts().length, 0);
  assert.equal(renders.length, 0);
  fire();
  assert.equal(engine.getAlerts().length, 1);
  assert.deepEqual(renders, ['fusion-alerts']);
  const firstSeen = engine.getAlerts()[0].firstSeenMs;
  detected.length = 0;
  fire();
  fire();
  assert.equal(engine.getAlerts().length, 1);
  assert.equal(engine.getAlerts()[0].firstSeenMs, firstSeen);
  fire();
  assert.equal(engine.getAlerts().length, 0);
  assert.equal(renders.length, 2);
});

test('fusion engine enable flags persist and an all-off panel does not schedule work', () => {
  const storage = memoryStorage();
  const { engine, queued } = harness([], storage);
  assert.deepEqual(engine.getDetectorFlags(), { ...DEFAULT_DETECTOR_FLAGS });
  engine.setDetectorEnabled('loiter', true);
  engine.setDetectorEnabled('hotspot', true);
  const saved = JSON.parse(storage.values.get(FUSION_DETECTOR_STORAGE_KEY));
  assert.equal(saved.loiter, true);
  assert.equal(saved.hotspot, true);
  assert.equal(saved.convergence, true);
  assert.equal(saved.darkPeriod, true);

  const restored = createFusionEngine({
    getRecords: () => [],
    storage,
    schedule() {
      throw new Error('should not schedule before start');
    },
    detect: () => [],
  });
  assert.equal(restored.getDetectorFlags().loiter, true);

  engine.setDetectorEnabled('convergence', false);
  engine.setDetectorEnabled('darkPeriod', false);
  engine.setDetectorEnabled('loiter', false);
  engine.setDetectorEnabled('hotspot', false);
  engine.start();
  assert.equal(queued.length, 0);
  engine.runOnce();
  assert.equal(engine.getAlerts().length, 0);
});

test('disabling a detector drops its alerts without waiting for expiry', () => {
  const detected = [alert('c1', 'convergence'), alert('l1', 'loiter')];
  const { engine, fire } = harness(detected);
  engine.setDetectorEnabled('loiter', true);
  engine.start();
  fire();
  fire();
  assert.equal(engine.getAlerts().length, 2);
  engine.setDetectorEnabled('loiter', false);
  assert.deepEqual(
    engine.getAlerts().map((item) => item.id),
    ['c1'],
  );
});

test('engine samples keep a loiter ring when the layer record has no track', () => {
  let calls = 0;
  const positions = [];
  const engine = createFusionEngine({
    getRecords(layer) {
      if (layer !== 'flights') return [];
      calls += 1;
      return [
        {
          icao24: 'abc123',
          callsign: 'ORB',
          lat: 30 + calls * 0.001,
          lon: -97,
          altitudeM: 4000,
          speedMps: 60,
          heading: 90,
          onGround: false,
        },
      ];
    },
    now: () => 5_000,
    detect(view, flags) {
      assert.equal(flags.convergence, true);
      assert.equal(flags.loiter, true);
      const craft = view.aircraft[0];
      positions.push(craft.track.length);
      return [];
    },
    schedule() {
      return 1;
    },
    clearSchedule() {},
  });
  engine.setDetectorEnabled('loiter', true);
  engine.runOnce();
  engine.runOnce();
  engine.runOnce();
  assert.deepEqual(positions, [1, 2, 3]);
});
