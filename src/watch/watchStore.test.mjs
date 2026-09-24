import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WATCH_ENTRY_CAP,
  WATCH_STORAGE_KEY,
  WatchStoreError,
  createMemoryStorage,
  createWatchStore,
} from './watchStore.js';

function ids() {
  let n = 0;
  return () => `id-${(n += 1)}`;
}

function store(extra = {}) {
  const storage = extra.storage || createMemoryStorage();
  return {
    storage,
    watch: createWatchStore({
      storage,
      now: () => 1_700_000_000_000,
      id: ids(),
      ...extra,
    }),
  };
}

const CONTACT = {
  kind: 'entity',
  label: 'UAL123',
  entity: { layer: 'flights', id: 'abc123' },
};

test('add, rename, disable, and delete round-trip through storage', () => {
  const { storage, watch } = store();
  const created = watch.add(CONTACT);
  assert.equal(created.created, true);
  assert.equal(created.entry.id, 'id-1');
  assert.equal(created.entry.enabled, true);
  watch.rename('id-1', 'United 123');
  watch.setEnabled('id-1', false);
  const reloaded = createWatchStore({
    storage,
    now: () => 0,
    id: ids(),
  });
  assert.deepEqual(reloaded.list(), [
    {
      id: 'id-1',
      kind: 'entity',
      label: 'United 123',
      createdAt: 1_700_000_000_000,
      enabled: false,
      entity: { layer: 'flights', id: 'abc123' },
    },
  ]);
  assert.equal(watch.remove('id-1'), true);
  assert.deepEqual(JSON.parse(storage.getItem(WATCH_STORAGE_KEY)), {
    version: 1,
    entries: [],
  });
});

test('duplicate contacts and places are not stored twice', () => {
  const { watch } = store();
  const first = watch.add(CONTACT);
  const again = watch.add({
    ...CONTACT,
    label: 'other name',
    entity: { layer: 'flights', id: 'ABC123' },
  });
  assert.equal(again.created, false);
  assert.equal(again.entry.id, first.entry.id);
  assert.equal(watch.list().length, 1);
  watch.add({
    kind: 'place',
    label: 'Austin',
    place: { lat: 30.2672, lon: -97.7431, height: 1500, heading: 0, pitch: -35, roll: 0 },
  });
  watch.add({
    kind: 'place',
    label: 'Austin again',
    place: {
      lat: 30.26721,
      lon: -97.74314,
      height: 1500.4,
      heading: 10,
      pitch: -20,
      roll: 1,
    },
  });
  assert.equal(watch.list().filter((entry) => entry.kind === 'place').length, 1);
});

test('the entry cap fails with an explicit error and writes nothing further', () => {
  const { storage, watch } = store();
  for (let n = 0; n < WATCH_ENTRY_CAP; n += 1) {
    watch.add({
      kind: 'entity',
      label: `C${n}`,
      entity: { layer: 'vessels', id: String(100000000 + n) },
    });
  }
  const before = storage.getItem(WATCH_STORAGE_KEY);
  assert.throws(
    () =>
      watch.add({
        kind: 'entity',
        label: 'overflow',
        entity: { layer: 'vessels', id: '999' },
      }),
    (error) => {
      assert.ok(error instanceof WatchStoreError);
      assert.equal(error.code, 'capacity');
      assert.match(error.message, /200/);
      return true;
    },
  );
  assert.equal(storage.getItem(WATCH_STORAGE_KEY), before);
  assert.equal(watch.list().length, WATCH_ENTRY_CAP);
});

test('import validates, skips duplicates, and refuses a document that would pass the cap', () => {
  const { watch } = store();
  watch.add(CONTACT);
  const result = watch.importJson({
    version: 1,
    entries: [
      CONTACT,
      { kind: 'nope', label: 'bad' },
      {
        kind: 'geofence',
        label: 'Harbor',
        geofence: {
          polygon: [
            [30, -98],
            [30, -97],
            [31, -97],
          ],
          layers: ['vessels', 'vessels'],
          trigger: 'both',
        },
      },
    ],
  });
  assert.deepEqual(result, { added: 1, skipped: 1, invalid: 1 });
  assert.equal(watch.list()[1].geofence.layers.length, 1);
  assert.throws(
    () => watch.importJson('{'),
    (error) => error instanceof WatchStoreError && error.code === 'import',
  );
  const full = store();
  for (let n = 0; n < WATCH_ENTRY_CAP; n += 1) {
    full.watch.add({
      kind: 'entity',
      label: `S${n}`,
      entity: { layer: 'satellites', id: String(n + 1) },
    });
  }
  assert.throws(
    () =>
      full.watch.importJson([
        {
          kind: 'entity',
          label: 'extra',
          entity: { layer: 'military', id: 'ae1234' },
        },
      ]),
    (error) => error.code === 'capacity',
  );
  assert.equal(full.watch.list().length, WATCH_ENTRY_CAP);
});

test('a migration hook lifts an older document and a newer one is left untouched', () => {
  const older = createMemoryStorage(
    JSON.stringify({
      version: 0,
      entries: [
        {
          kind: 'entity',
          label: 'Old',
          entity: { layer: 'military', id: 'ae9999' },
        },
      ],
    }),
  );
  const migrated = createWatchStore({
    storage: older,
    now: () => 5,
    id: () => 'from-hook',
    migrations: {
      1(doc) {
        return {
          version: 1,
          entries: doc.entries.map((entry) => ({
            ...entry,
            id: 'migrated-1',
            createdAt: 5,
            enabled: true,
          })),
        };
      },
    },
  });
  assert.equal(migrated.list()[0].id, 'migrated-1');
  assert.equal(migrated.list()[0].label, 'Old');

  const raw = JSON.stringify({ version: 9, entries: [{ id: 'future' }] });
  const newer = createMemoryStorage(raw);
  const blocked = createWatchStore({ storage: newer, id: ids() });
  assert.equal(blocked.list().length, 0);
  assert.equal(blocked.getLoadError().code, 'version');
  assert.throws(() => blocked.add(CONTACT));
  assert.equal(newer.getItem(WATCH_STORAGE_KEY), raw);
});

test('subscribers hear committed lists', () => {
  const { watch } = store();
  const seen = [];
  const stop = watch.subscribe((entries) => seen.push(entries.length));
  watch.add(CONTACT);
  watch.remove('id-1');
  stop();
  watch.add(CONTACT);
  assert.deepEqual(seen, [1, 0]);
});
