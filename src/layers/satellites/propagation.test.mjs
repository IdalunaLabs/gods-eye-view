import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import {
  degreesLat,
  degreesLong,
  eciToGeodetic,
  gstime,
  propagate,
  twoline2satrec,
} from 'satellite.js';
import { orbitFrameModelMatrix } from '../../data/satellites.js';
import {
  createPropagationWorkerState,
  handlePropagationMessage,
} from './propagationWorker.js';
import {
  prepareSatrecs,
  propagateBatch,
  propagateGeodetic,
  propagationBufferLength,
  propagationGmstIndex,
  PROPAGATION_STRIDE,
} from './propagation.js';

const ISS_L1 =
  '1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927';
const ISS_L2 =
  '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537';
const GEO_L1 =
  '1 69728U 26148A   26208.65166678  .00000015  00000+0  00000+0 0  9990';
const GEO_L2 =
  '2 69728   0.0784 264.9826 0001797 240.4588 273.9506  1.00271527   440';

const FIXTURES = [
  { line1: ISS_L1, line2: ISS_L2 },
  { line1: GEO_L1, line2: GEO_L2 },
  { line1: '1 not-a-tle', line2: '2 not-a-tle' },
];

const EPOCHS = [
  Date.UTC(2008, 8, 20, 12, 30),
  Date.UTC(2008, 8, 20, 13, 0),
  Date.UTC(2008, 8, 20, 18, 30),
  Date.UTC(2026, 6, 27, 15, 0),
  Date.UTC(2026, 6, 28, 15, 0),
];

/** The pre-worker synchronous sample: SGP4, geodetic, then Cesium ECEF. */
function legacySample(line1, line2, dateMs) {
  const satrec = twoline2satrec(line1, line2);
  const date = new Date(dateMs);
  const posVel = propagate(satrec, date);
  if (!posVel?.position || typeof posVel.position === 'boolean') return null;
  const gmst = gstime(date);
  const geo = eciToGeodetic(posVel.position, gmst);
  const longitude = degreesLong(geo.longitude);
  const latitude = degreesLat(geo.latitude);
  const altitude = geo.height * 1000;
  const velocity =
    posVel.velocity && typeof posVel.velocity !== 'boolean'
      ? posVel.velocity
      : null;
  const speedMps = velocity
    ? Math.hypot(velocity.x, velocity.y, velocity.z) * 1000
    : null;
  return {
    longitude,
    latitude,
    altitude,
    speedMps: Number.isFinite(speedMps) ? speedMps : null,
    gmst,
    cartesian: Cesium.Cartesian3.fromDegrees(longitude, latitude, altitude),
  };
}

test('propagation buffers store ECEF metres, validity, and GMST', () => {
  const satrecs = prepareSatrecs(FIXTURES);
  assert.equal(satrecs[0]?.error, 0);
  assert.equal(satrecs[1]?.error, 0);
  const out = new Float64Array(propagationBufferLength(satrecs.length));
  assert.throws(
    () => propagateBatch(satrecs, EPOCHS[0], new Float64Array(3)),
    /shorter than the catalog/,
  );
  const gmst = propagateBatch(satrecs, EPOCHS[0], out);
  assert.equal(out.length, satrecs.length * PROPAGATION_STRIDE + 1);
  assert.equal(out[3], 1);
  assert.equal(out[7], 1);
  assert.equal(out[8], 0);
  assert.equal(out[9], 0);
  assert.equal(out[10], 0);
  assert.equal(out[11], 0);
  assert.equal(gmst, out[propagationGmstIndex(satrecs.length)]);
  assert.equal(gmst, gstime(new Date(EPOCHS[0])));
});

test('worker propagation matches the previous synchronous ECEF math', () => {
  for (const dateMs of EPOCHS) {
    const legacy = FIXTURES.map((tle, index) =>
      index < 2 ? legacySample(tle.line1, tle.line2, dateMs) : null,
    );
    const batchSatrecs = prepareSatrecs(FIXTURES);
    const direct = new Float64Array(propagationBufferLength(FIXTURES.length));
    propagateBatch(batchSatrecs, dateMs, direct);
    const workerOut = new Float64Array(
      propagationBufferLength(FIXTURES.length),
    );
    const handled = handlePropagationMessage(
      { satrecs: prepareSatrecs(FIXTURES) },
      {
        type: 'propagate',
        dateMs,
        generation: 4,
        buffer: workerOut.buffer,
      },
    );
    assert.equal(handled.reply.type, 'propagated');
    assert.deepEqual(handled.transfer, [workerOut.buffer]);
    assert.deepEqual([...new Float64Array(handled.reply.buffer)], [...direct]);
    for (let i = 0; i < FIXTURES.length; i += 1) {
      const base = i * PROPAGATION_STRIDE;
      const previous = legacy[i];
      if (!previous) {
        assert.equal(direct[base + 3], 0);
        continue;
      }
      const geodetic = propagateGeodetic(
        twoline2satrec(FIXTURES[i].line1, FIXTURES[i].line2),
        new Date(dateMs),
      );
      assert.deepEqual(geodetic, {
        longitude: previous.longitude,
        latitude: previous.latitude,
        altitude: previous.altitude,
        speedMps: previous.speedMps,
      });
      assert.equal(direct[base], previous.cartesian.x);
      assert.equal(direct[base + 1], previous.cartesian.y);
      assert.equal(direct[base + 2], previous.cartesian.z);
      assert.equal(direct[base + 3], 1);
    }
    assert.equal(direct[propagationGmstIndex(FIXTURES.length)], legacy[0].gmst);
  }
});

test('an explicit GMST locks an orbit ring to that propagation epoch', () => {
  const bakeDate = new Date(Date.UTC(2008, 8, 20, 12, 0));
  const nowDate = new Date(Date.UTC(2008, 8, 20, 12, 10));
  const baked = gstime(bakeDate);
  const fromDate = orbitFrameModelMatrix(baked, nowDate);
  const fromGmst = orbitFrameModelMatrix(
    baked,
    new Date(0),
    new Cesium.Matrix4(),
    gstime(nowDate),
  );
  for (let i = 0; i < 16; i += 1) {
    assert.equal(fromGmst[i], fromDate[i]);
  }
});

test('worker load replaces the catalog before the next propagation', () => {
  const state = createPropagationWorkerState();
  const loaded = handlePropagationMessage(state, {
    type: 'load',
    generation: 2,
    tles: [{ line1: ISS_L1, line2: ISS_L2 }],
  });
  assert.equal(loaded.reply.count, 1);
  const out = new Float64Array(propagationBufferLength(1));
  handlePropagationMessage(state, {
    type: 'propagate',
    dateMs: EPOCHS[0],
    generation: 2,
    buffer: out.buffer,
  });
  assert.equal(out[3], 1);
  assert.equal(
    handlePropagationMessage(state, { type: 'nope' }).reply.type,
    'error',
  );
});
