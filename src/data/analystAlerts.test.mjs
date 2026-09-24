import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAnalystEngine,
  registerAnalystAlertSource,
} from './analystEngine.js';

const TEXLAND = {
  name: 'Texland',
  ring: [
    [-100, 28],
    [-94, 28],
    [-94, 33],
    [-100, 33],
  ],
};

function alert(overrides) {
  return {
    id: 'c1',
    kind: 'convergence',
    severity: 'watch',
    entities: [
      { layer: 'flights', id: 'abc', label: 'UAL1' },
      { layer: 'ais-live-vessels', id: '9', label: 'SHIP' },
    ],
    position: { lat: 30.2, lon: -97.7 },
    explanation:
      'Dead-reckoned from heading/speed; not a prediction of intent.',
    confidence: 0.64,
    firstSeenMs: 10,
    lastSeenMs: 20,
    ...overrides,
  };
}

function engine(alerts) {
  const stop = registerAnalystAlertSource(() => alerts);
  const created = createAnalystEngine({
    getRecords: () => [],
    resolveRegionRing: async (name) => (/texland/i.test(name) ? TEXLAND : null),
    getViewContext: () => ({ lat: 30.27, lon: -97.74, viewRadiusKm: 150 }),
  });
  return { engine: created, stop };
}

test('analyst answers active alerts, convergences, and circling near a place', async () => {
  const alerts = [
    alert({}),
    alert({
      id: 'orbit',
      kind: 'loiter',
      severity: 'info',
      position: { lat: 30.4, lon: -97.5 },
      explanation: 'Geometric cluster of reported fixes, not a holding clearance.',
      entities: [{ layer: 'flights', id: 'orb', label: 'ORB1' }],
    }),
    alert({
      id: 'far',
      kind: 'loiter',
      position: { lat: 45, lon: -122 },
      explanation: 'Geometric cluster outside the region.',
      entities: [{ layer: 'flights', id: 'far', label: 'FAR1' }],
    }),
  ];
  const { engine, stop } = engine(alerts);
  try {
    const active = await engine.query({ question: 'what alerts are active?' });
    assert.equal(active.ok, true);
    assert.equal(active.count, 3);
    assert.match(active.coverage.note, /not a prediction of intent/);
    assert.equal(active.items[0].explanation.includes('Dead-reckoned'), true);

    const convergences = await engine.query({
      question: 'any convergences right now?',
    });
    assert.equal(convergences.count, 1);
    assert.equal(convergences.items[0].id, 'c1');
    assert.equal(convergences.items[0].confidence, 0.64);

    const circling = await engine.query({
      question: 'is anything circling near Texland?',
    });
    assert.equal(circling.ok, true);
    assert.equal(circling.count, 1);
    assert.equal(circling.items[0].id, 'orbit');
    assert.equal(circling.scopeLabel, 'over Texland');

    const filtered = await engine.query({
      filters: [{ field: 'alertKind', op: 'eq', value: 'convergence' }],
    });
    assert.deepEqual(
      filtered.items.map((item) => item.id),
      ['c1'],
    );
  } finally {
    stop();
  }
});

test('analyst alert questions fail honestly when fusion is not running or the place is unknown', async () => {
  const quiet = createAnalystEngine({
    getRecords: () => [],
    resolveRegionRing: async () => null,
    getViewContext: () => ({ lat: 0, lon: 0, viewRadiusKm: 10 }),
  });
  const missing = await quiet.query({ question: 'what alerts are active?' });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /not running/);

  const { engine, stop } = engine([alert({})]);
  try {
    const unresolved = await engine.query({
      question: 'is anything circling near Atlantis?',
    });
    assert.equal(unresolved.ok, false);
    assert.match(unresolved.error, /Atlantis/);
  } finally {
    stop();
  }
});

test('an ordinary flight question is not captured as an alert intent', async () => {
  const { engine, stop } = engine([alert({})]);
  try {
    const result = await engine.query({
      layers: ['flights'],
      scope: { kind: 'anywhere' },
      filters: [{ field: 'altitudeM', op: 'gt', value: 1 }],
    });
    assert.equal(result.ok, true);
    assert.equal(result.count, 0);
    assert.equal(result.coverage.layersQueried[0].layerKey, 'flights');
  } finally {
    stop();
  }
});
