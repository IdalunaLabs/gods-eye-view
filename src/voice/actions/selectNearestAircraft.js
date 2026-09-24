import { createAnalystEngine } from '../../data/analystEngine.js';
import { layerFeedState } from '../../data/feedState.js';
import { analystProviders } from './analystQuery.js';
import { normalizeLayerId } from './shared.js';
import { trackEntity } from './trackEntity.js';
/**
 * Execute the select_nearest_aircraft voice tool.
 * @param {{ args: object, context: object }} request Tool arguments and the runner context.
 * @returns {Promise<object>}
 */
export async function execute({ args, context }) {
  const name = 'select_nearest_aircraft';
  const {
    viewer,
    styleManager,
    dataManager,
    placeSearch,
    runOptions,
    resolveRegionRing,
  } = context;
  const current = context.current;
  const runGevAction = context.dispatch;
  if (name === 'select_nearest_aircraft') {
    const layerId = normalizeLayerId(args.layerId || 'flights');
    if (!['flights', 'military'].includes(layerId)) {
      return {
        ok: false,
        action: 'select_nearest_aircraft',
        error:
          'Nearest-aircraft selection supports Flights or Military Flights only',
      };
    }
    const hasLocationId = Boolean(String(args.locationId || '').trim());
    const hasLocationQuery = Boolean(String(args.locationQuery || '').trim());
    const hasCoordinates =
      args.latitude != null &&
      args.longitude != null &&
      Number.isFinite(Number(args.latitude)) &&
      Number.isFinite(Number(args.longitude));
    if (!hasLocationId && !hasLocationQuery && !hasCoordinates) {
      return {
        ok: false,
        action: 'select_nearest_aircraft',
        stage: 'location',
        error:
          'Nearest-aircraft selection needs a preset, place name, or latitude and longitude',
      };
    }
    const locationArgs = {
      waitForArrival: true,
      ...(args.locationId ? { locationId: args.locationId } : {}),
      ...(args.locationQuery ? { query: args.locationQuery } : {}),
      ...(hasCoordinates
        ? {
            latitude: Number(args.latitude),
            longitude: Number(args.longitude),
          }
        : {}),
    };
    const layer = await runGevAction(
      'set_layer_visibility',
      {
        layerId,
        enabled: true,
      },
      runOptions,
    );
    if (layer?.ok !== true || !current()) {
      return {
        ok: false,
        action: 'select_nearest_aircraft',
        stage: 'layer',
        cancelled: !current() || Boolean(layer?.cancelled),
        error: layer?.error || `${layerId} could not be enabled`,
        layer,
      };
    }

    const location = await runGevAction(
      'fly_to_location',
      locationArgs,
      runOptions,
    );
    if (location?.ok !== true || !current()) {
      return {
        ok: false,
        action: 'select_nearest_aircraft',
        stage: 'location',
        cancelled: !current() || Boolean(location?.cancelled),
        error:
          location?.error ||
          `Could not arrive at ${location?.label || args.locationQuery || args.locationId || 'the requested place'}`,
        location,
        layer,
      };
    }

    const layerModule = dataManager.layers.get(layerId)?.module || null;
    let refreshed = false;
    try {
      if (typeof dataManager.refreshLayer === 'function') {
        refreshed = await dataManager.refreshLayer(layerId, {
          signal: runOptions.signal,
        });
      } else if (typeof layerModule?.update === 'function') {
        refreshed =
          (await layerModule.update(viewer, {
            signal: runOptions.signal,
          })) !== false;
      }
    } catch {
      refreshed = false;
    }
    if (!refreshed || !current()) {
      return {
        ok: false,
        action: 'select_nearest_aircraft',
        stage: 'refresh',
        cancelled: !current(),
        error: !current()
          ? 'Nearest-aircraft refresh was cancelled'
          : `${layer.label || layerId} is enabled, but its destination refresh did not complete`,
        location,
        layer,
      };
    }
    const stats = layerModule?.getStats?.() || {};
    const source =
      String(stats.source || layerModule?.source || '').trim() || null;
    const feed = {
      state: layerFeedState({ ...stats, source }),
      source,
      count: Number.isFinite(Number(stats.count)) ? Number(stats.count) : null,
    };

    const nearest = await createAnalystEngine(
      analystProviders(viewer, dataManager, {
        recordLimitByLayer: { [layerId]: Number.MAX_SAFE_INTEGER },
        placeSearch,
        resolveRegionRing,
      }),
    ).query({
      layers: [layerId],
      scope: { kind: 'view' },
      filters: [{ field: 'onGround', op: 'eq', value: false }],
      sortBy: 'distance',
      sortDir: 'asc',
      limit: 1,
    });
    const aircraft = nearest?.items?.[0] || null;
    if (!aircraft || !current()) {
      return {
        ok: false,
        action: 'select_nearest_aircraft',
        stage: 'nearest',
        cancelled: !current(),
        error: !current()
          ? 'Nearest-aircraft selection was cancelled'
          : feed.state === 'unavailable'
            ? `${layer.label || layerId} is enabled, but ${feed.source || 'its aircraft feed'} is unavailable`
            : `${layer.label || layerId} is enabled${feed.state === 'fallback' ? ` on the ${feed.source || 'fallback'} feed` : ''}, but no airborne aircraft is loaded in the ${location.label || 'destination'} view yet`,
        location,
        layer,
        feed,
        count: nearest?.count || 0,
      };
    }

    const stableAircraftId = aircraft.icao24 || aircraft.id;
    const selection = await trackEntity(viewer, dataManager, styleManager, {
      query: stableAircraftId,
      layerId,
    });
    if (selection?.ok !== true) {
      return {
        ok: false,
        action: 'select_nearest_aircraft',
        stage: 'selection',
        error:
          selection?.error ||
          'The nearest airborne aircraft could not be selected',
        location,
        layer,
        feed,
        selection,
      };
    }
    return {
      ok: true,
      action: 'select_nearest_aircraft',
      location: location.label,
      layerId,
      label: selection.label,
      feed,
      aircraft: {
        id: stableAircraftId,
        callsign: aircraft.callsign || null,
        altitudeM: aircraft.altitudeM ?? null,
        distanceKm: aircraft.distanceKm ?? null,
        onGround: false,
      },
    };
  }
}

/** Voice tool handler for select_nearest_aircraft. */
export const action = {
  name: 'select_nearest_aircraft',
  execute,
};
