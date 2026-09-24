import { flyToGlobeView, GLOBE_VIEW } from '../../locations.js';
import { interruptCameraMotion } from '../../cameraVerbs.js';
import { stopAllTracking } from './shared.js';
/**
 * Execute the zoom_to_globe voice tool.
 * @param {{ args: object, context: object }} request Tool arguments and the runner context.
 * @returns {Promise<object>}
 */
export async function execute({ args, context }) {
  const name = 'zoom_to_globe';
  const { viewer, styleManager, dataManager } = context;
  // Navigation tools interrupt any continuous camera motion (spec §1.1) —
  // checked FIRST because each handler returns.
  if (name === 'zoom_to_globe') {
    interruptCameraMotion(`nav:${name}`);
  }
  // Explicit navigation while TRACKING supersedes the follow camera —
  // otherwise the tracker drags the view back and "I flew there but can't
  // do anything" (field finding). track_entity manages its own handoff.
  if (name === 'zoom_to_globe' && viewer.trackedEntity) {
    stopAllTracking(viewer, dataManager);
  }
  if (name === 'zoom_to_globe') {
    if (typeof styleManager?.resetToGlobeView === 'function') {
      return styleManager.resetToGlobeView();
    }
    const result = flyToGlobeView(viewer);
    return {
      ok: true,
      action: 'zoom_to_globe',
      heightKm: Math.round(GLOBE_VIEW.heightM / 1000),
      centeredOn: {
        latitude: Number(result.latitude.toFixed(2)),
        longitude: Number(result.longitude.toFixed(2)),
      },
    };
  }
}

/** Voice tool handler for zoom_to_globe. */
export const action = {
  name: 'zoom_to_globe',
  execute,
};
