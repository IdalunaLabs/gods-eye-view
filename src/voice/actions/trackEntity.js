import { flyToLandmark } from '../../locations.js';
import {
  TRACKABLE_FAMILIES,
  runManagedVoiceNavigation,
  normalizeLayerId,
} from './shared.js';
/**
 * Spoken name for a tracked entity descriptor.
 *
 * Aircraft follow the flight layers' label convention — callsign →
 * registration → icao24 — so the narrated name matches the readout and the
 * detection card instead of speaking a raw hex at a contact the UI is calling
 * `N123AB`. Vessels and satellites carry no `registration`, so that link
 * simply falls through to their own name/mmsi/noradId links.
 * @param {object} found - Layer descriptor from `findByQuery`.
 * @param {string} query - The spoken query, used as the last resort.
 * @returns {string} A non-empty display name.
 */
export function formatTrackedEntityLabel(found, query = '') {
  const text = (v) => String(v ?? '').trim();
  return (
    text(found?.callsign) ||
    text(found?.registration) ||
    text(found?.name) ||
    text(found?.icao24) ||
    text(found?.mmsi) ||
    text(found?.noradId) ||
    String(query)
  );
}

/** Finds and tracks/selects an entity by spoken query across layer families. */
export async function trackEntity(
  viewer,
  dataManager,
  styleManager,
  args = {},
) {
  const query = String(args.query || '').trim();
  if (!query) throw new Error('track_entity needs a query');

  // Fire queries route to the FIRMS layer's strongest detection
  if (/\bfires?\b/i.test(query)) {
    if (!dataManager.isEnabled('local-firms')) {
      return {
        ok: false,
        action: 'track_entity',
        query,
        error: 'The FIRMS fires layer is not enabled',
      };
    }
    const firms = dataManager.layers.get('local-firms')?.module;
    const strongest = firms?.getStrongestFire?.();
    if (!strongest) {
      return {
        ok: false,
        action: 'track_entity',
        query,
        error: 'No fire detections loaded yet',
      };
    }
    if (
      !Number.isFinite(strongest.latitude) ||
      !Number.isFinite(strongest.longitude)
    ) {
      return {
        ok: false,
        action: 'track_entity',
        query,
        error: 'The strongest fire has no usable position',
      };
    }
    return runManagedVoiceNavigation(
      styleManager,
      'fire',
      'track_entity',
      () => {
        flyToLandmark(viewer, strongest.latitude, strongest.longitude, {
          range: 14000,
          pitch: -50,
          heading: 0,
          buildingHeight: 0,
          duration: 2.2,
        });
        return {
          ok: true,
          action: 'track_entity',
          kind: 'fire',
          layerId: 'local-firms',
          label: strongest.label || 'Strongest fire',
          latitude: strongest.latitude,
          longitude: strongest.longitude,
          frp: strongest.frp ?? null,
        };
      },
    );
  }

  const requested = args.layerId ? normalizeLayerId(args.layerId) : null;
  const families = TRACKABLE_FAMILIES.filter(
    (family) => !requested || family.layerId === requested,
  );
  const skippedDisabled = [];

  for (const family of families) {
    if (!dataManager.isEnabled(family.layerId)) {
      skippedDisabled.push(family.layerId);
      continue;
    }
    const module = dataManager.layers.get(family.layerId)?.module;
    if (!module || typeof module.findByQuery !== 'function') continue;
    const found = module.findByQuery(query);
    if (!found) continue;

    if (
      family.kind === 'vessel' &&
      (!Number.isFinite(found.latitude) || !Number.isFinite(found.longitude))
    ) {
      return {
        ok: false,
        action: 'track_entity',
        layerId: family.layerId,
        kind: family.kind,
        error: 'The matched vessel has no usable position',
      };
    }

    return runManagedVoiceNavigation(
      styleManager,
      family.kind,
      'track_entity',
      () => {
        let trackedOk = false;
        if (family.kind === 'vessel') {
          trackedOk = !!module.selectById?.(found.mmsi);
          flyToLandmark(viewer, found.latitude, found.longitude, {
            range: 6000,
            pitch: -45,
            heading: 0,
            buildingHeight: 0,
            duration: 2.0,
          });
        } else if (family.kind === 'satellite') {
          trackedOk = !!module.trackById?.(found.noradId, { origin: 'voice' });
        } else {
          trackedOk = !!module.trackById?.(found.icao24, { origin: 'voice' });
        }

        return {
          ok: trackedOk,
          action: 'track_entity',
          layerId: family.layerId,
          kind: family.kind,
          // Aircraft follow the flight layers' label convention (callsign →
          // registration → icao24) so the spoken name matches what the UI shows;
          // `registration` is absent on vessels/satellites and simply falls
          // through to their own name/id links.
          label: formatTrackedEntityLabel(found, query),
          latitude: found.latitude ?? null,
          longitude: found.longitude ?? null,
          altitudeM: Number.isFinite(found.altitudeM)
            ? Math.round(found.altitudeM)
            : null,
          error: trackedOk ? null : 'Match found but tracking failed',
        };
      },
    );
  }

  const disabledNote = skippedDisabled.length
    ? ` (disabled layers skipped: ${skippedDisabled.join(', ')})`
    : '';
  return {
    ok: false,
    action: 'track_entity',
    query,
    error: `Nothing matched "${query}"${disabledNote}`,
  };
}
/**
 * Execute the track_entity voice tool.
 * @param {{ args: object, context: object }} request Tool arguments and the runner context.
 * @returns {Promise<object>}
 */
export async function execute({ args, context }) {
  const name = 'track_entity';
  const { viewer, styleManager, dataManager } = context;
  if (name === 'track_entity') {
    return trackEntity(viewer, dataManager, styleManager, args);
  }
}

/** Voice tool handler for track_entity. */
export const action = {
  name: 'track_entity',
  execute,
};
