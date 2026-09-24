/**
 * Static voice-tool registry. Importing this module loads every handler and
 * rejects two modules that claim the same tool name.
 */
import { action as flyToLocation } from './flyToLocation.js';
import { action as selectNearestAircraft } from './selectNearestAircraft.js';
import { action as adjustCameraZoom } from './adjustCameraZoom.js';
import { action as zoomToGlobe } from './zoomToGlobe.js';
import { action as setLayerVisibility } from './setLayerVisibility.js';
import { action as showDataLayersMenu } from './showDataLayersMenu.js';
import { action as setPanelOpen } from './setPanelOpen.js';
import { action as setContextMode } from './setContextMode.js';
import { action as controlCockpit } from './controlCockpit.js';
import { action as setVisualStyle } from './setVisualStyle.js';
import { action as getEntityContext } from './getEntityContext.js';
import { action as getCurrentViewState } from './getCurrentViewState.js';
import { action as setHud } from './setHud.js';
import { action as setDetection } from './setDetection.js';
import { action as setMapStack } from './setMapStack.js';
import { action as setPostProcessing } from './setPostProcessing.js';
import { action as controlScene } from './controlScene.js';
import { action as controlCctv } from './controlCctv.js';
import { action as controlRadio } from './controlRadio.js';
import { action as trackEntity } from './trackEntity.js';
import { action as stopTracking } from './stopTracking.js';
import { action as frameOverhead } from './frameOverhead.js';
import { action as annotateMap } from './annotateMap.js';
import { action as clearAnnotations } from './clearAnnotations.js';
import { action as moveCamera } from './moveCamera.js';
import { action as flyRoute } from './flyRoute.js';
import { action as analystQuery } from './analystQuery.js';
import { action as nextIssPass } from './nextIssPass.js';

const HANDLERS = [
  flyToLocation,
  selectNearestAircraft,
  adjustCameraZoom,
  zoomToGlobe,
  setLayerVisibility,
  showDataLayersMenu,
  setPanelOpen,
  setContextMode,
  controlCockpit,
  setVisualStyle,
  getEntityContext,
  getCurrentViewState,
  setHud,
  setDetection,
  setMapStack,
  setPostProcessing,
  controlScene,
  controlCctv,
  controlRadio,
  trackEntity,
  stopTracking,
  frameOverhead,
  annotateMap,
  clearAnnotations,
  moveCamera,
  flyRoute,
  analystQuery,
  nextIssPass,
];

/** @type {Map<string, { name: string, execute: Function }>} */
export const actionHandlers = new Map();

for (const handler of HANDLERS) {
  if (actionHandlers.has(handler.name)) {
    throw new Error(`Duplicate voice action handler: ${handler.name}`);
  }
  actionHandlers.set(handler.name, handler);
}
