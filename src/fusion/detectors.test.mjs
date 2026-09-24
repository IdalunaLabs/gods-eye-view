import assert from 'node:assert/strict';
import test from 'node:test';
import { detectConvergence } from './detectors/convergence.js';
import { detectDarkPeriod } from './detectors/darkPeriod.js';
import { detectHotspotProximity } from './detectors/hotspotProximity.js';
import { detectLoiter } from './detectors/loiter.js';

const NOW = 1_700_000_000_000;

function craft(overrides) {
  return {
    layer: 'flights',
    id: 'AAA',
    label: 'AAA',
    lat: 30,
    lon: -97,
    altitudeM: 10000,
    speedMps: 200,
    headingDeg: 0,
    onGround: false,
    ...overrides,
  };
}

test('convergence alerts a closing pair and skips parallel, diverging, ground, and terminal traffic', () => {
  const closing = detectConvergence({
    nowMs: NOW,
    aircraft: [
      craft({ id: 'N', label: 'NORTH', lat: 30, headingDeg: 0 }),
      craft({ id: 'S', label: 'SOUTH', lat: 30.09, headingDeg: 180 }),
    ],
    vessels: [],
  });
  assert.equal(closing.length, 1);
  assert.equal(closing[0].kind, 'convergence');
  assert.match(closing[0].explanation, /dead-reckoned/i);
  assert.match(closing[0].explanation, /not a prediction of intent/i);
  assert.ok(closing[0].confidence > 0 && closing[0].confidence <= 1);
  assert.deepEqual(
    closing[0].entities.map((entity) => entity.id).sort(),
    ['N', 'S'],
  );

  const parallel = detectConvergence({
    nowMs: NOW,
    aircraft: [
      craft({ id: 'A', headingDeg: 90 }),
      craft({ id: 'B', lat: 30.01, headingDeg: 90 }),
    ],
    vessels: [],
  });
  assert.equal(parallel.length, 0);

  const diverging = detectConvergence({
    nowMs: NOW,
    aircraft: [
      craft({ id: 'A', lat: 30, headingDeg: 180 }),
      craft({ id: 'B', lat: 30.05, headingDeg: 0 }),
    ],
    vessels: [],
  });
  assert.equal(diverging.length, 0);

  const grounded = detectConvergence({
    nowMs: NOW,
    aircraft: [
      craft({ id: 'N', onGround: true }),
      craft({ id: 'S', lat: 30.09, headingDeg: 180 }),
    ],
    vessels: [],
  });
  assert.equal(grounded.length, 0);

  const terminal = detectConvergence({
    nowMs: NOW,
    aircraft: [
      craft({ id: 'N', altitudeM: 400, lat: 30, headingDeg: 0, speedMps: 80 }),
      craft({
        id: 'S',
        altitudeM: 500,
        lat: 30.04,
        headingDeg: 180,
        speedMps: 80,
      }),
    ],
    vessels: [],
  });
  assert.equal(terminal.length, 0);

  const stacked = detectConvergence({
    nowMs: NOW,
    aircraft: [
      craft({ id: 'LOW', altitudeM: 1000, headingDeg: 0 }),
      craft({ id: 'HIGH', altitudeM: 8000, lat: 30.09, headingDeg: 180 }),
    ],
    vessels: [],
  });
  assert.equal(stacked.length, 0);
});

test('convergence includes a moving vessel and skips a moored one', () => {
  const hit = detectConvergence({
    nowMs: NOW,
    aircraft: [craft({ id: 'JET', lat: 30, headingDeg: 0, speedMps: 120 })],
    vessels: [
      {
        id: 'SHIP',
        label: 'SHIP',
        lat: 30.08,
        lon: -97,
        speedKts: 12,
        courseDeg: 180,
        navStatus: 'under way using engine',
        reporting: true,
      },
    ],
  });
  assert.equal(hit.length, 1);
  assert.equal(hit[0].entities[0].layer, 'flights');
  assert.equal(hit[0].entities[1].layer, 'ais-live-vessels');
  assert.match(hit[0].explanation, /heading and speed/i);

  const moored = detectConvergence({
    nowMs: NOW,
    aircraft: [craft({ id: 'JET', lat: 30, headingDeg: 0, speedMps: 120 })],
    vessels: [
      {
        id: 'SHIP',
        label: 'SHIP',
        lat: 30.02,
        lon: -97,
        speedKts: 12,
        courseDeg: 180,
        navStatus: 'moored',
        reporting: true,
      },
    ],
  });
  assert.equal(moored.length, 0);
});

test('loiter alerts a tight airborne track and skips a straight, slow, or grounded one', () => {
  const circle = [];
  for (let i = 0; i < 8; i += 1) {
    const angle = (i / 8) * Math.PI * 2;
    circle.push({
      lat: 30 + Math.cos(angle) * 0.008,
      lon: -97 + Math.sin(angle) * 0.008,
    });
  }
  const hit = detectLoiter({
    nowMs: NOW,
    aircraft: [
      craft({
        id: 'ORB',
        label: 'ORB',
        speedMps: 70,
        positions: circle,
        lat: circle[7].lat,
        lon: circle[7].lon,
      }),
    ],
  });
  assert.equal(hit.length, 1);
  assert.equal(hit[0].severity, 'info');
  assert.match(hit[0].explanation, /not a determination/i);
  assert.ok(hit[0].confidence > 0 && hit[0].confidence <= 1);

  const line = [];
  for (let i = 0; i < 8; i += 1) line.push({ lat: 30 + i * 0.05, lon: -97 });
  assert.equal(
    detectLoiter({
      nowMs: NOW,
      aircraft: [craft({ id: 'LINE', speedMps: 200, positions: line })],
    }).length,
    0,
  );
  assert.equal(
    detectLoiter({
      nowMs: NOW,
      aircraft: [craft({ id: 'SLOW', speedMps: 10, positions: circle })],
    }).length,
    0,
  );
  assert.equal(
    detectLoiter({
      nowMs: NOW,
      aircraft: [
        craft({ id: 'GND', onGround: true, speedMps: 80, positions: circle }),
      ],
    }).length,
    0,
  );
  assert.equal(
    detectLoiter({
      nowMs: NOW,
      aircraft: [craft({ id: 'SHORT', speedMps: 80, positions: circle.slice(0, 4) })],
    }).length,
    0,
  );
});

test('dark period alerts a silent moving vessel and skips anchored, fresh, and still ones', () => {
  const base = {
    id: '366',
    label: 'MOVER',
    lat: 29,
    lon: -94,
    speedKts: 12,
    navStatus: 'under way using engine',
    reporting: false,
    lastSeenMs: NOW - 25 * 60 * 1000,
    samples: [
      { lat: 29, lon: -94.2, speedKts: 12, tMs: NOW - 40 * 60 * 1000 },
      { lat: 29, lon: -94, speedKts: 12, tMs: NOW - 25 * 60 * 1000 },
    ],
  };
  const hit = detectDarkPeriod({ nowMs: NOW, vessels: [base] });
  assert.equal(hit.length, 1);
  assert.match(hit[0].explanation, /reporting gap/i);
  assert.match(hit[0].explanation, /not confirmation/i);
  assert.equal(hit[0].entities[0].layer, 'ais-live-vessels');

  assert.equal(
    detectDarkPeriod({
      nowMs: NOW,
      vessels: [{ ...base, navStatus: 'at anchor' }],
    }).length,
    0,
  );
  assert.equal(
    detectDarkPeriod({
      nowMs: NOW,
      vessels: [{ ...base, reporting: true }],
    }).length,
    0,
  );
  assert.equal(
    detectDarkPeriod({
      nowMs: NOW,
      vessels: [{ ...base, lastSeenMs: NOW - 5 * 60 * 1000 }],
    }).length,
    0,
  );
  assert.equal(
    detectDarkPeriod({
      nowMs: NOW,
      vessels: [
        {
          ...base,
          speedKts: 0,
          navStatus: null,
          samples: [
            { lat: 29, lon: -94, speedKts: 0, tMs: NOW - 40 * 60 * 1000 },
            { lat: 29, lon: -94, speedKts: 0, tMs: NOW - 25 * 60 * 1000 },
          ],
        },
      ],
    }).length,
    0,
  );
});

test('hotspot proximity alerts near a cluster or a recent quake and skips far, small, old, and grounded cases', () => {
  const firms = [
    { id: 'F1', lat: 34, lon: -118 },
    { id: 'F2', lat: 34.01, lon: -118 },
    { id: 'F3', lat: 34.02, lon: -118.01 },
  ];
  const near = detectHotspotProximity({
    nowMs: NOW,
    aircraft: [craft({ id: 'NEAR', lat: 34.08, lon: -118, altitudeM: 3000 })],
    firms,
    earthquakes: [],
  });
  assert.equal(near.length, 1);
  assert.equal(near[0].kind, 'hotspot-proximity');
  assert.match(near[0].explanation, /not a fire-behavior/i);
  assert.equal(near[0].entities[0].id, 'NEAR');

  assert.equal(
    detectHotspotProximity({
      nowMs: NOW,
      aircraft: [craft({ id: 'FAR', lat: 35.2, lon: -118 })],
      firms,
      earthquakes: [],
    }).length,
    0,
  );
  assert.equal(
    detectHotspotProximity({
      nowMs: NOW,
      aircraft: [craft({ id: 'NEAR', lat: 34.08, lon: -118 })],
      firms: firms.slice(0, 2),
      earthquakes: [],
    }).length,
    0,
  );

  const quake = detectHotspotProximity({
    nowMs: NOW,
    aircraft: [craft({ id: 'Q', lat: 35, lon: -120 })],
    firms: [],
    earthquakes: [
      {
        id: 'us100',
        label: 'near the coast',
        lat: 35.05,
        lon: -120,
        magnitude: 5.6,
        timeMs: NOW - 20 * 60 * 1000,
      },
    ],
  });
  assert.equal(quake.length, 1);
  assert.match(quake[0].explanation, /not a damage/i);
  assert.equal(quake[0].entities[1].layer, 'earthquakes');

  assert.equal(
    detectHotspotProximity({
      nowMs: NOW,
      aircraft: [craft({ id: 'Q', lat: 35, lon: -120 })],
      firms: [],
      earthquakes: [
        {
          id: 'small',
          lat: 35.05,
          lon: -120,
          magnitude: 4.2,
          timeMs: NOW - 10 * 60 * 1000,
        },
      ],
    }).length,
    0,
  );
  assert.equal(
    detectHotspotProximity({
      nowMs: NOW,
      aircraft: [craft({ id: 'Q', lat: 35, lon: -120 })],
      firms: [],
      earthquakes: [
        {
          id: 'old',
          lat: 35.05,
          lon: -120,
          magnitude: 6.1,
          timeMs: NOW - 2 * 60 * 60 * 1000,
        },
      ],
    }).length,
    0,
  );
  assert.equal(
    detectHotspotProximity({
      nowMs: NOW,
      aircraft: [craft({ id: 'GND', lat: 34.08, lon: -118, onGround: true })],
      firms,
      earthquakes: [],
    }).length,
    0,
  );
});
