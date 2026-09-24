import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

function sliceFunction(source, name, nextName) {
  const start = source.indexOf(`function ${name}`);
  const end = nextName
    ? source.indexOf(`function ${nextName}`, start)
    : source.length;
  assert.ok(start >= 0, name);
  return source.slice(start, end === -1 ? source.length : end);
}

test('live flight rendering still dead-reckons when replay is off', () => {
  const rendering = readFileSync(
    new URL('../layers/flights/rendering.js', import.meta.url),
    'utf8',
  );
  const tick = sliceFunction(rendering, '_fleetTick', '_fleetBillboardColor');
  const gate = tick.indexOf('_historyReplayActive()');
  const reckon = tick.indexOf('_deadReckon(');
  assert.ok(gate >= 0 && reckon > gate);
  assert.match(tick.slice(gate, reckon), /return;/);
  const motion = readFileSync(
    new URL('../layers/flights/motion.js', import.meta.url),
    'utf8',
  );
  const tracked = sliceFunction(
    motion,
    '_trackedDisplayPosition',
    '_trackedDisplayCached',
  );
  assert.match(
    tracked,
    /if \(replayPos \|\| _historyReplayActive\(\)\) return replayPos;/,
  );
  assert.ok(
    tracked.indexOf('return replayPos') < tracked.indexOf('_deadReckon('),
  );
  const vessels = readFileSync(
    new URL('../layers/vessels/rendering.js', import.meta.url),
    'utf8',
  );
  const visibility = sliceFunction(vessels, 'updateVisibility(');
  assert.match(
    visibility,
    /if \(replaying\) \{\s*state\._replayWasActive = true;\s*syncReplayVessels\(\);/,
  );
  assert.match(visibility, /for \(const record of state\.records\.all\)/);
});
