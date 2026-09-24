import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('gevActions.js stays a thin facade', () => {
  const source = fs.readFileSync(
    new URL('./gevActions.js', import.meta.url),
    'utf8',
  );
  const lineCount = source.endsWith('\n')
    ? source.split('\n').length - 1
    : source.split('\n').length;
  assert.ok(
    lineCount < 200,
    `gevActions.js has ${lineCount} lines and must stay under 200`,
  );
  assert.match(source, /actionHandlers/);
  assert.doesNotMatch(source, /async function trackEntity/);
  assert.doesNotMatch(source, /async function flyToRequestedLocation/);
});
