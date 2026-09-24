import { GEV_ACTION_SCHEMAS } from '../actionSchemas.js';
import { actionHandlers, buildActionHandlers } from './registry.js';
import assert from 'node:assert/strict';
import test from 'node:test';

const schemaNames = GEV_ACTION_SCHEMAS.map((schema) => schema.name);

test('every action schema has exactly one handler', () => {
  assert.equal(new Set(schemaNames).size, schemaNames.length);
  assert.equal(actionHandlers.size, schemaNames.length);
  for (const name of schemaNames) {
    const handler = actionHandlers.get(name);
    assert.equal(handler?.name, name);
    assert.equal(typeof handler.execute, 'function');
  }
});

test('every handler has an action schema', () => {
  const expected = new Set(schemaNames);
  for (const name of actionHandlers.keys()) {
    assert.equal(expected.has(name), true, `${name} has no action schema`);
  }
});

test('the registry rejects a duplicate tool name', () => {
  const execute = () => ({});
  assert.throws(
    () =>
      buildActionHandlers([
        { name: 'fly_to_location', execute },
        { name: 'fly_to_location', execute },
      ]),
    /Duplicate voice action handler: fly_to_location/,
  );
});
