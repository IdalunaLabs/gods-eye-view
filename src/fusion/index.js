export { clampConfidence, haversineKm, wrapLon } from './geo.js';
export { createSpatialIndex } from './spatialIndex.js';
export {
  createFusionEngine,
  DEFAULT_DETECTOR_FLAGS,
  FUSION_DETECTOR_STORAGE_KEY,
  readDetectorFlags,
} from './fusionEngine.js';
export {
  CONVERGENCE_DEFAULTS,
  detectConvergence,
  horizontalCpa,
} from './detectors/convergence.js';
export { detectLoiter, LOITER_DEFAULTS } from './detectors/loiter.js';
export {
  DARK_PERIOD_DEFAULTS,
  detectDarkPeriod,
} from './detectors/darkPeriod.js';
export {
  detectHotspotProximity,
  HOTSPOT_DEFAULTS,
} from './detectors/hotspotProximity.js';
