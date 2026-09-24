import * as Cesium from 'cesium';
import {
  runManagedVoiceNavigation,
  normalizeLayerId,
  clampNumber,
} from './shared.js';
import { getViewTargetCartesian } from './viewContext.js';
const FRAME_TARGETS = new Map([
  ['flights', 'flights'],
  ['planes', 'flights'],
  ['aircraft', 'flights'],
  ['military', 'military'],
  ['military flights', 'military'],
  ['satellites', 'satellites'],
  ['vessels', 'ais-live-vessels'],
  ['ships', 'ais-live-vessels'],
]);

/**
 * Frames entities near the current view target with a cinematic pull-back:
 * oblique high pitch for aircraft/ships, shallow wide pitch for satellites.
 * When entries are found and detection is OFF, auto-enables panoptic
 * detection so the framed entities are labeled, and reports
 * detectionEnabled so the voice agent can mention labels are on.
 */
async function frameOverhead(viewer, dataManager, styleManager, args = {}) {
  const targetRaw = String(args.target || 'flights').toLowerCase();
  const layerId =
    FRAME_TARGETS.get(targetRaw) || normalizeLayerId(targetRaw) || 'flights';
  if (!dataManager.layers.has(layerId)) {
    return {
      ok: false,
      action: 'frame_overhead',
      error: `Unknown target layer: ${args.target}`,
    };
  }
  if (!dataManager.isEnabled(layerId)) {
    return {
      ok: false,
      action: 'frame_overhead',
      layerId,
      error: `The ${layerId} layer is not enabled`,
    };
  }
  const module = dataManager.layers.get(layerId)?.module;
  const isSatellites = layerId === 'satellites';
  const defaultRadiusKm = isSatellites
    ? 3000
    : layerId === 'ais-live-vessels'
      ? 120
      : 150;
  const radiusKm = clampNumber(args.radiusKm, 10, 20000, defaultRadiusKm);
  const center = getViewTargetCartesian(viewer) || viewer.camera.positionWC;

  let entries = [];
  if (typeof module.getNearby === 'function') {
    entries = module.getNearby(center, radiusKm * 1000, 80) || [];
  } else if (typeof module.getAllPositions === 'function') {
    entries = (module.getAllPositions(800) || [])
      .filter((entry) => entry.position)
      .map((entry) => ({
        ...entry,
        distance: Cesium.Cartesian3.distance(center, entry.position),
      }))
      .filter((entry) => entry.distance <= radiusKm * 1000)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 80);
  }
  if (!entries.length) {
    return {
      ok: false,
      action: 'frame_overhead',
      layerId,
      radiusKm: Math.round(radiusKm),
      count: 0,
      error: `No ${targetRaw} within ${Math.round(radiusKm)} km of the current view`,
    };
  }

  const sphere = Cesium.BoundingSphere.fromPoints(
    entries.map((entry) => entry.position),
  );
  sphere.radius = Math.max(sphere.radius * 1.25, 8000);
  const pitch = Cesium.Math.toRadians(isSatellites ? -35 : -62);
  return runManagedVoiceNavigation(
    styleManager,
    'frame',
    'frame_overhead',
    () => {
      viewer.camera.flyToBoundingSphere(sphere, {
        duration: 2.0,
        offset: new Cesium.HeadingPitchRange(
          viewer.camera.heading,
          pitch,
          sphere.radius * 2.4,
        ),
      });

      let detectionEnabled = false;
      try {
        const detectionState = styleManager?.getDetectionState?.();
        if (detectionState?.detectionMode === 'OFF') {
          const detectionResult = styleManager.setDetection({ mode: 'dense' });
          detectionEnabled = detectionResult?.ok === true;
        } else if (detectionState) {
          detectionEnabled = true;
        }
      } catch {
        // detection facade unavailable; framing still succeeded
      }

      return {
        ok: true,
        action: 'frame_overhead',
        layerId,
        radiusKm: Math.round(radiusKm),
        count: entries.length,
        detectionEnabled,
        nearest: entries.slice(0, 5).map((entry) => ({
          id: entry.id || entry.icao24 || entry.mmsi || null,
          label: entry.label || entry.callsign || entry.name || null,
        })),
      };
    },
  );
}
/**
 * Execute the frame_overhead voice tool.
 * @param {{ args: object, context: object }} request Tool arguments and the runner context.
 * @returns {Promise<object>}
 */
export async function execute({ args, context }) {
  const name = 'frame_overhead';
  const { viewer, styleManager, dataManager } = context;
  if (name === 'frame_overhead') {
    return frameOverhead(viewer, dataManager, styleManager, args);
  }
}

/** Voice tool handler for frame_overhead. */
export const action = {
  name: 'frame_overhead',
  execute,
};
