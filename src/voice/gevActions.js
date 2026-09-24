import { searchAndFlyTo } from '../locations.js';
import { initCameraVerbs } from '../cameraVerbs.js';
import * as defaultFloorServices from '../data/groundFloor.js';
import { unavailablePlaceSearch } from '../search/placeSearch.js';
import * as defaultAnnotationResolver from '../annotations/annotationResolver.js';
import { actionHandlers } from './actions/registry.js';
import {
  getViewTargetCartesian,
  installViewTargetPrewarm,
} from './actions/viewContext.js';

export { readLayerLifecycleSummary } from './layerSummary.js';
export { normalizeStackId } from './actions/shared.js';
export { controlCctv, cctvVoiceFocusOutcome } from './actions/controlCctv.js';
export { controlRadio, knownRadioLocation } from './actions/controlRadio.js';
export { formatTrackedEntityLabel } from './actions/trackEntity.js';
export { getBasemapLabelContext } from './actions/viewContext.js';

/**
 * Shared state every voice-tool handler closes over.
 *
 * One context lives for the runner. `dispatch`, `runOptions` and `current`
 * are swapped for the active call and restored afterwards, so a tool that
 * calls another tool sees that call's cancellation state and then its own.
 * `layerEnabledAt` and `analystEngine` stay on the runner across calls.
 *
 * @typedef {object} GevActionContext
 * @property {object} viewer Cesium viewer.
 * @property {object} styleManager UI facade.
 * @property {object} dataManager Layer lifecycle facade.
 * @property {object|null} sceneDirector Scene playback owner.
 * @property {object|null} annotations Annotation engine.
 * @property {object} placeSearch Forward geocoder.
 * @property {object} floorServices Ground-floor sampler.
 * @property {object} annotationResolver Footprint resolver.
 * @property {Function} searchNavigation Place-search flight.
 * @property {Function} resolveRegionRing Analyst region rings.
 * @property {Map<string, number>} layerEnabledAt Voice enable timestamps.
 * @property {object|undefined} analystEngine Lazy per-runner analyst engine.
 * @property {Function} dispatch Nested `runGevAction` for the same runner.
 * @property {object} runOptions Active call's signal and currency check.
 * @property {Function} current Whether the active call is still current.
 */

/**
 * Create application actions over the supplied scene and services.
 * @param {object} options Runner dependencies.
 * @param {object} options.viewer
 * @param {object} options.styleManager
 * @param {object} options.dataManager
 * @param {object|null} [options.sceneDirector]
 * @param {object|null} [options.annotations]
 * @param {object} [options.placeSearch]
 * @param {object} [options.floorServices]
 * @param {object} [options.annotationResolver]
 * @param {Function} [options.searchNavigation]
 * @returns {(name: string, rawArgs?: object, runOptions?: object) => Promise<object>}
 */
export function createGevActionRunner({
  viewer,
  styleManager,
  dataManager,
  sceneDirector = null,
  annotations = null,
  placeSearch = unavailablePlaceSearch,
  floorServices = defaultFloorServices,
  annotationResolver = defaultAnnotationResolver,
  searchNavigation = searchAndFlyTo,
}) {
  const context = {
    viewer,
    styleManager,
    dataManager,
    sceneDirector,
    annotations,
    placeSearch,
    floorServices,
    annotationResolver,
    searchNavigation,
    resolveRegionRing: (regionName) =>
      annotationResolver.resolveRegionRingForQuery(
        regionName,
        undefined,
        placeSearch,
      ),
    layerEnabledAt: new Map(),
    analystEngine: undefined,
  };
  installViewTargetPrewarm(viewer);
  initCameraVerbs(viewer, getViewTargetCartesian);
  context.dispatch = (name, rawArgs, runOptions) =>
    runAction(context, name, rawArgs, runOptions);
  return context.dispatch;
}

/**
 * Dispatch one tool call, restoring the caller's currency state afterwards.
 * @param {GevActionContext} context
 * @param {string} name
 * @param {object} [rawArgs]
 * @param {object} [runOptions]
 * @returns {Promise<object>}
 */
async function runAction(context, name, rawArgs = {}, runOptions = {}) {
  const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
  const previous = {
    runOptions: context.runOptions,
    current: context.current,
  };
  context.runOptions = runOptions;
  context.current = () =>
    !runOptions.signal?.aborted &&
    (typeof runOptions.isCurrent !== 'function' || runOptions.isCurrent());
  try {
    const handler = actionHandlers.get(name);
    if (!handler) throw new Error(`Unknown GEV tool: ${name}`);
    return await handler.execute({ args, context });
  } finally {
    context.runOptions = previous.runOptions;
    context.current = previous.current;
  }
}
