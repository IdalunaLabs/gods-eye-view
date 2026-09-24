import * as Cesium from 'cesium';
import {
  withContextModeVocabulary,
  TRACKABLE_FAMILIES,
  activeContactsWindow,
} from './shared.js';
/** Gathers tracked/selected entities across layer families for read-back. */
function collectTrackedEntities(dataManager) {
  const tracked = [];
  for (const family of TRACKABLE_FAMILIES) {
    const module = dataManager.layers.get(family.layerId)?.module;
    if (!module) continue;
    try {
      const info =
        family.kind === 'vessel'
          ? module.getSelectedInfo?.()
          : module.getTrackedInfo?.();
      if (info)
        tracked.push({ kind: family.kind, layerId: family.layerId, ...info });
    } catch {
      // layer not ready
    }
  }
  return tracked;
}

function getCurrentViewState(
  viewer,
  styleManager,
  dataManager,
  sceneDirector = null,
) {
  const cartographic = Cesium.Cartographic.fromCartesian(
    viewer.camera.positionWC,
  );
  return {
    ok: true,
    action: 'get_current_view_state',
    camera: {
      latitude: Cesium.Math.toDegrees(cartographic.latitude),
      longitude: Cesium.Math.toDegrees(cartographic.longitude),
      heightM: cartographic.height,
    },
    style: styleManager.activeStyle || 'normal',
    context:
      typeof styleManager.getContextModeState === 'function'
        ? {
            ...withContextModeVocabulary(styleManager.getContextModeState()),
            // The numbers on the operator's Contacts panel, so a window/count
            // question can be answered from what they are looking at.
            ...(activeContactsWindow(dataManager)
              ? { contactsWindow: activeContactsWindow(dataManager) }
              : {}),
          }
        : null,
    cockpit:
      typeof styleManager.getCockpitState === 'function'
        ? styleManager.getCockpitState()
        : null,
    controls:
      typeof styleManager.getControlState === 'function'
        ? styleManager.getControlState()
        : null,
    scenePlayback: sceneDirector?.getPlaybackStatus?.() || null,
    tracked: collectTrackedEntities(dataManager),
    layers: dataManager.getAll().map((layer) => ({
      id: layer.id,
      name: layer.name,
      enabled: layer.enabled,
      count: layer.stats?.count || 0,
      error: layer.stats?.error || null,
    })),
  };
}
/**
 * Execute the get_current_view_state voice tool.
 * @param {{ args: object, context: object }} request Tool arguments and the runner context.
 * @returns {Promise<object>}
 */
export async function execute({ args, context }) {
  const name = 'get_current_view_state';
  const { viewer, styleManager, dataManager, sceneDirector } = context;
  if (name === 'get_current_view_state') {
    return getCurrentViewState(
      viewer,
      styleManager,
      dataManager,
      sceneDirector,
    );
  }
}

/** Voice tool handler for get_current_view_state. */
export const action = {
  name: 'get_current_view_state',
  execute,
};
