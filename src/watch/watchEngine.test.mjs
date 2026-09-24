import assert from 'node:assert/strict';
import test from 'node:test';
import { createWatchEngine } from './watchEngine.js';

const SQUARE = [
  [0, 0],
  [0, 2],
  [2, 2],
  [2, 0],
];

function harness(entries, options = {}) {
  const layers = {
    flights: [],
    military: [],
    vessels: [],
    satellites: [],
    ...options.layers,
  };
  const engine = createWatchEngine({
    readEntries: () => entries,
    getRecords: (layer) => layers[layer],
    cooldownMs: options.cooldownMs ?? 0,
    stalenessMs: {
      flights: 10,
      military: 10,
      vessels: 10,
      satellites: 10,
      ...options.stalenessMs,
    },
    ...options.engine,
  });
  return { engine, layers };
}

test('a watched contact reports once, stays quiet through a short gap, then says no report arrived', () => {
  const entries = [
    {
      id: 'w1',
      kind: 'entity',
      label: 'UAL123',
      enabled: true,
      entity: { layer: 'flights', id: 'abc123' },
    },
  ];
  const { engine, layers } = harness(entries, { cooldownMs: 60_000 });
  layers.flights = [{ icao24: 'abc123', callsign: 'UAL123', lat: 30, lon: -97 }];
  const seen = engine.evaluate(0);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, 'entity-seen');
  assert.deepEqual(seen[0].position, { lat: 30, lon: -97 });
  assert.match(seen[0].message, /reported/);

  layers.flights = [];
  assert.equal(engine.evaluate(9).length, 0);
  layers.flights = [{ icao24: 'ABC123', lat: 30.1, lon: -97 }];
  assert.equal(engine.evaluate(9).length, 0);

  layers.flights = [];
  const lost = engine.evaluate(20);
  assert.equal(lost.length, 1);
  assert.equal(lost[0].type, 'entity-lost');
  assert.match(lost[0].message, /no report for 1 min/);
  assert.equal(engine.evaluate(40).length, 0);
});

test('a disabled layer is not treated as a lost contact', () => {
  const entries = [
    {
      id: 'w1',
      kind: 'entity',
      enabled: true,
      label: 'Ship',
      entity: { layer: 'vessels', id: '123456789' },
    },
  ];
  const layers = { flights: [], military: [], vessels: [], satellites: null };
  const engine = createWatchEngine({
    readEntries: () => entries,
    getRecords: (layer) => layers[layer],
    cooldownMs: 0,
    stalenessMs: { vessels: 5 },
  });
  layers.vessels = [{ mmsi: '123456789', name: 'Ever Given', lat: 1, lon: 2 }];
  engine.evaluate(0);
  layers.vessels = null;
  assert.equal(engine.evaluate(100).length, 0);
  assert.equal(engine.getRecentEvents().at(-1).type, 'entity-seen');
});

test('geofence enter and exit fire once per transition and honor the trigger', () => {
  const entries = [
    {
      id: 'g1',
      kind: 'geofence',
      label: 'Harbor',
      enabled: true,
      geofence: { polygon: SQUARE, layers: ['flights'], trigger: 'both' },
    },
  ];
  const { engine, layers } = harness(entries);
  layers.flights = [{ id: 'abc', lat: 1, lon: 1 }];
  const entered = engine.evaluate(0);
  assert.equal(entered[0].type, 'geofence-enter');
  assert.match(entered[0].message, /entered Harbor/);
  assert.equal(engine.evaluate(1).length, 0);
  layers.flights = [{ id: 'abc', lat: 5, lon: 5 }];
  const left = engine.evaluate(2);
  assert.equal(left[0].type, 'geofence-exit');
  assert.match(left[0].message, /left Harbor/);
  assert.equal(engine.evaluate(3).length, 0);

  entries[0] = {
    ...entries[0],
    id: 'g2',
    geofence: { polygon: SQUARE, layers: ['flights'], trigger: 'exit' },
  };
  layers.flights = [{ id: 'abc', lat: 1, lon: 1 }];
  assert.equal(engine.evaluate(4).length, 0);
  layers.flights = [{ id: 'abc', lat: 5, lon: 5 }];
  assert.equal(engine.evaluate(5)[0].type, 'geofence-exit');
});

test('cooldown holds a repeat alert until the window passes', () => {
  const entries = [
    {
      id: 'w1',
      kind: 'entity',
      label: 'UAL123',
      enabled: true,
      entity: { layer: 'flights', id: 'abc' },
    },
  ];
  const { engine, layers } = harness(entries, {
    cooldownMs: 1000,
    stalenessMs: { flights: 10 },
  });
  layers.flights = [{ id: 'abc', lat: 1, lon: 1 }];
  assert.equal(engine.evaluate(0)[0].type, 'entity-seen');
  layers.flights = [];
  assert.equal(engine.evaluate(10)[0].type, 'entity-lost');
  layers.flights = [{ id: 'abc', lat: 1, lon: 2 }];
  assert.equal(engine.evaluate(20).length, 0);
  layers.flights = [{ id: 'abc', lat: 1, lon: 2 }];
  const flushed = engine.evaluate(1000);
  assert.equal(flushed[0].type, 'entity-seen');
  assert.equal(flushed[0].at, 1000);
  assert.equal(
    engine.getRecentEvents().filter((event) => event.type === 'entity-seen')
      .length,
    2,
  );
});

test('place proximity is optional and recent events stay bounded', () => {
  const entries = [
    {
      id: 'p1',
      kind: 'place',
      label: 'Austin',
      enabled: true,
      place: {
        lat: 30,
        lon: -97,
        height: 1000,
        heading: 0,
        pitch: -30,
        roll: 0,
      },
    },
  ];
  const { engine, layers } = harness(entries, { engine: { eventLimit: 2 } });
  layers.flights = [{ id: 'near', lat: 30.01, lon: -97 }];
  assert.equal(engine.evaluate(0).length, 0);
  entries[0] = {
    ...entries[0],
    place: { ...entries[0].place, radiusKm: 50 },
  };
  const hit = engine.evaluate(1);
  assert.equal(hit[0].type, 'place-proximity');
  assert.match(hit[0].message, /within/);
  assert.equal(engine.evaluate(2).length, 0);
  layers.flights = [{ id: 'near', lat: 0, lon: 0 }];
  engine.evaluate(3);
  layers.flights = [{ id: 'near', lat: 30.01, lon: -97 }];
  engine.evaluate(4);
  assert.ok(engine.getRecentEvents().length <= 2);
});

test('start schedules the throttle and stop cancels it', () => {
  let scheduled = null;
  const engine = createWatchEngine({
    readEntries: () => [],
    getRecords: () => [],
    now: () => 5,
    intervalMs: 5000,
    setTimer(fn, ms) {
      scheduled = { fn, ms };
      return 7;
    },
    clearTimer(handle) {
      scheduled = handle;
    },
  });
  engine.start();
  assert.equal(scheduled.ms, 5000);
  scheduled.fn();
  engine.stop();
  assert.equal(scheduled, 7);
});
