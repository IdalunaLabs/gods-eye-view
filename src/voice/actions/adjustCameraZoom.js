import * as Cesium from 'cesium';
import { adjustOrbitRange } from '../../cameraVerbs.js';
import { getViewTargetCartesian } from './viewContext.js';
function adjustCameraZoom(viewer, args) {
  const direction = String(args.direction || '').toLowerCase();
  if (direction !== 'in' && direction !== 'out') {
    throw new Error('adjust_camera_zoom direction must be "in" or "out"');
  }

  const amount = String(args.amount || 'little').toLowerCase();
  const fraction = {
    little: 0.25,
    medium: 0.55,
    lot: 1.0,
  }[amount];
  if (!fraction) throw new Error(`Unknown zoom amount: ${args.amount}`);

  const camera = viewer.camera;
  const beforePosition = Cesium.Cartesian3.clone(camera.positionWC);
  const beforeHeightM = camera.positionCartographic.height;
  const target = getViewTargetCartesian(viewer);
  const targetDistanceM = target
    ? Cesium.Cartesian3.distance(beforePosition, target)
    : Math.max(100, beforeHeightM);
  const minimumDistanceM = direction === 'in' ? 20 : 50;
  const movementM = Math.max(minimumDistanceM, targetDistanceM * fraction);

  camera.cancelFlight();
  if (direction === 'out') {
    camera.zoomOut(movementM);
  } else {
    const safeMovementM = Math.min(
      movementM,
      Math.max(0, targetDistanceM - 25),
    );
    if (safeMovementM <= 0) {
      return {
        ok: false,
        action: 'adjust_camera_zoom',
        direction,
        amount,
        error: 'Camera is already at the minimum target distance',
      };
    }
    camera.zoomIn(safeMovementM);
  }
  viewer.scene.requestRender();

  const afterPosition = camera.positionWC;
  const movedM = Cesium.Cartesian3.distance(beforePosition, afterPosition);
  const afterHeightM = camera.positionCartographic.height;
  const moved = movedM >= 0.5;
  return {
    ok: moved,
    action: 'adjust_camera_zoom',
    direction,
    amount,
    movementRequestedM: Math.round(movementM),
    movementActualM: Math.round(movedM),
    beforeHeightM: Math.round(beforeHeightM),
    afterHeightM: Math.round(afterHeightM),
    error: moved ? null : 'Cesium camera position did not change',
  };
}
/**
 * Execute the adjust_camera_zoom voice tool.
 * @param {{ args: object, context: object }} request Tool arguments and the runner context.
 * @returns {Promise<object>}
 */
export async function execute({ args, context }) {
  const name = 'adjust_camera_zoom';
  const { viewer } = context;
  // Zoom during an active orbit adjusts the orbit RADIUS (spiral in/out) —
  // a straight camera move would be snapped back by the per-frame lookAt.
  if (name === 'adjust_camera_zoom') {
    const zoomOut = String(args.direction || '').toLowerCase() === 'out';
    const amt = String(args.amount || 'medium').toLowerCase();
    const factor = { little: 1.25, medium: 1.6, lot: 2.4 }[amt] || 1.6;
    if (adjustOrbitRange(zoomOut ? factor : 1 / factor)) {
      return {
        ok: true,
        action: 'adjust_camera_zoom',
        direction: zoomOut ? 'out' : 'in',
        amount: amt,
        orbitRadiusAdjusted: true,
      };
    }
  }
  if (name === 'adjust_camera_zoom') {
    return adjustCameraZoom(viewer, args);
  }
}

/** Voice tool handler for adjust_camera_zoom. */
export const action = {
  name: 'adjust_camera_zoom',
  execute,
};
