import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { twoline2satrec } from 'satellite.js';
import { createSatellitesLayer } from './index.js';
import { createPropagationClient } from './propagationClient.js';
import {
  prepareSatrecs,
  propagateBatch,
  propagateGeodetic,
  propagationBufferLength,
} from './propagation.js';

const L1 =
  '1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927';
const L2 =
  '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537';

class FakeWorker {
  constructor() {
    this.handlers = new Map();
    this.messages = [];
    this.terminated = false;
    FakeWorker.latest = this;
  }

  postMessage(data, transfer) {
    this.messages.push({ data, transfer });
  }

  addEventListener(type, handler) {
    const list = this.handlers.get(type) || [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  removeEventListener(type, handler) {
    const list = (this.handlers.get(type) || []).filter(
      (item) => item !== handler,
    );
    this.handlers.set(type, list);
  }

  terminate() {
    this.terminated = true;
  }

  emit(type, event) {
    for (const handler of [...(this.handlers.get(type) || [])]) handler(event);
  }
}

function warningsClient(extra = {}) {
  const warnings = [];
  const client = createPropagationClient({
    WorkerImpl: FakeWorker,
    logger: { warn: (...args) => warnings.push(args) },
    ...extra,
  });
  return { client, warnings };
}

function loadOne(client) {
  client.load([{ id: 25544, line1: L1, line2: L2 }], 1);
  const message = FakeWorker.latest.messages.at(-1);
  FakeWorker.latest.emit('message', {
    data: {
      type: 'loaded',
      generation: message.data.generation,
      count: 1,
    },
  });
  return message.data.generation;
}

test('the propagation client falls back when Worker is absent', () => {
  const client = createPropagationClient({ WorkerImpl: null });
  assert.equal(client.mode(), 'sync');
  client.load([{ id: 25544, line1: L1, line2: L2 }], 3);
  assert.equal(client.ready(), true);
  assert.equal(client.propagate(Date.UTC(2008, 8, 20, 12, 30)), true);
  const sample = client.latest();
  const expected = new Float64Array(propagationBufferLength(1));
  propagateBatch(
    prepareSatrecs([{ line1: L1, line2: L2 }]),
    Date.UTC(2008, 8, 20, 12, 30),
    expected,
  );
  assert.deepEqual([...sample.buffer], [...expected]);
  const firstSpare = sample.buffer;
  assert.equal(client.propagate(Date.UTC(2008, 8, 20, 12, 31)), true);
  assert.notEqual(client.latest().buffer, firstSpare);
  assert.equal(client.propagate(Date.UTC(2008, 8, 20, 12, 32)), true);
  assert.equal(client.latest().buffer, firstSpare);
});

test('worker propagation stays one sample behind a late tick and then falls back', () => {
  let clock = 1_000;
  const epoch = Date.UTC(2008, 8, 20, 12, 30);
  const { client, warnings } = warningsClient({
    now: () => clock,
    lostAfterMs: 1_000,
  });
  assert.equal(client.mode(), 'worker');
  client.load([{ id: 25544, line1: L1, line2: L2 }], 1);
  assert.equal(client.ready(), false);
  assert.equal(FakeWorker.latest.messages[0].data.type, 'load');
  assert.equal(client.propagate(epoch), false);
  loadOne(client);
  assert.equal(client.ready(), true);
  assert.equal(client.latest(), null);

  assert.equal(client.propagate(epoch), true);
  const first = FakeWorker.latest.messages.at(-1);
  assert.equal(first.data.type, 'propagate');
  assert.ok(first.transfer.includes(first.data.buffer));
  assert.equal(client.propagate(epoch + 10), false, 'late tick does not send');
  assert.equal(FakeWorker.latest.messages.at(-1), first);
  assert.equal(client.latest(), null);

  const satrecs = prepareSatrecs([{ line1: L1, line2: L2 }]);
  propagateBatch(
    satrecs,
    first.data.dateMs,
    new Float64Array(first.data.buffer),
  );
  FakeWorker.latest.emit('message', {
    data: {
      type: 'propagated',
      dateMs: first.data.dateMs,
      generation: first.data.generation,
      buffer: first.data.buffer,
    },
  });
  assert.equal(client.latest().dateMs, first.data.dateMs);
  assert.equal(client.latest().buffer[3], 1);

  assert.equal(client.propagate(epoch + 20), true);
  const second = FakeWorker.latest.messages.at(-1);
  assert.notEqual(second.data.buffer, first.data.buffer);
  propagateBatch(
    prepareSatrecs([{ line1: L1, line2: L2 }]),
    second.data.dateMs,
    new Float64Array(second.data.buffer),
  );
  FakeWorker.latest.emit('message', {
    data: {
      type: 'propagated',
      dateMs: second.data.dateMs,
      generation: second.data.generation,
      buffer: second.data.buffer,
    },
  });
  assert.equal(client.propagate(epoch + 30), true);
  assert.equal(
    FakeWorker.latest.messages.at(-1).data.buffer,
    first.data.buffer,
  );

  FakeWorker.latest.emit('error', { message: 'worker exploded' });
  assert.equal(client.mode(), 'sync');
  assert.equal(FakeWorker.latest.terminated, true);
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][1]), /worker exploded/);
  assert.equal(client.propagate(epoch + 40), true);
  assert.equal(client.latest().buffer[3], 1);
  client.load([{ id: 25544, line1: L1, line2: L2 }], 2);
  assert.equal(warnings.length, 1, 'fallback logs once');
});

test('a lost worker response switches the client to synchronous propagation', () => {
  let clock = 0;
  const { client, warnings } = warningsClient({
    now: () => clock,
    lostAfterMs: 1_000,
  });
  loadOne(client);
  assert.equal(client.propagate(clock), true);
  clock = 1_001;
  assert.equal(client.propagate(clock), true);
  assert.equal(client.mode(), 'sync');
  assert.match(String(warnings[0][1]), /lost/);
  assert.equal(client.latest().dateMs, clock);
});

test('a worker that cannot start uses the synchronous batch', () => {
  const warnings = [];
  const client = createPropagationClient({
    WorkerImpl: class {
      constructor() {
        throw new Error('blocked');
      }
    },
    logger: { warn: (...args) => warnings.push(args) },
  });
  client.load([{ id: 25544, line1: L1, line2: L2 }], 1);
  assert.equal(client.mode(), 'sync');
  assert.equal(warnings.length, 1);
  assert.equal(client.propagate(Date.UTC(2008, 8, 20, 12, 30)), true);
  assert.equal(client.latest().ids[0], 25544);
});

test('preRender applies a synchronous fleet sample to untracked points', () => {
  const epoch = Date.UTC(2008, 8, 20, 12, 30);
  const services = {
    picking: {},
    focus: {
      focusNowMs: () => epoch,
      getFocusTarget: () => null,
      focusPassIsNeeded: () => false,
      nearFarScalarValueAtDistance: () => 1,
      advanceSpriteFocus: () => ({ factor: 1 }),
      focusAlphaNeedsWrite: () => false,
      clearFocusTarget() {},
      publishFocusTargetFromCachedPosition() {},
    },
    readout: { refreshTrackedReadout() {} },
    overlays: {
      setOverlayEntries() {},
      setOverlaySourceVisible() {},
      clearOverlaySource() {},
    },
    context: {
      clearTrackedSubjectContext() {},
      getContextStore: () => ({ entities: new Map(), selectedEntityId: null }),
      refreshTrackedSubjectContext() {},
      selectTrackedSubjectContext() {},
    },
    render: {
      holdContinuousRender() {},
      releaseContinuousRender() {},
    },
    layerState: { isExplicitLayerStateOrigin: () => false },
  };
  const layer = createSatellitesLayer({
    source: { readGroup() {} },
    services,
  });
  const tracked = { position: new Cesium.Cartesian3() };
  const neighbour = { position: new Cesium.Cartesian3() };
  layer._setTrackedSatelliteRefreshStateForTest({
    noradId: 25544,
    name: 'ISS (ZARYA)',
    satrec: twoline2satrec(L1, L2),
    line1: L1,
    line2: L2,
    entity: { gevLabelModel: { title: '', details: [] } },
    point: tracked,
    viewer: { camera: null, scene: { frameState: { frameNumber: 1 } } },
    now: () => epoch,
    neighbours: [
      {
        noradId: 99999,
        name: 'NEIGHBOUR',
        line1: L1,
        line2: L2,
        point: neighbour,
      },
    ],
  });
  layer.setParams({ showPoints: true, showOrbits: false });
  layer._runSatellitePreRenderForTest();
  const geo = propagateGeodetic(twoline2satrec(L1, L2), new Date(epoch));
  const expected = Cesium.Cartesian3.fromDegrees(
    geo.longitude,
    geo.latitude,
    geo.altitude,
  );
  assert.equal(neighbour.position.x, expected.x);
  assert.equal(neighbour.position.y, expected.y);
  assert.equal(neighbour.position.z, expected.z);
});
