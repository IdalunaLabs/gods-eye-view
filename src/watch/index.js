export {
  WATCH_STORAGE_KEY,
  WATCH_VERSION,
  WATCH_ENTRY_CAP,
  WATCH_ENTITY_LAYERS,
  WatchStoreError,
  createMemoryStorage,
  migrateWatchDocument,
  createWatchStore,
} from './watchStore.js';
export { pointInPolygon, polygonBbox, distanceKm } from './geometry.js';
export {
  DEFAULT_EVALUATE_INTERVAL_MS,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_STALENESS_MS,
  DEFAULT_EVENT_LIMIT,
  createWatchEngine,
} from './watchEngine.js';
