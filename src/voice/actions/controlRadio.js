import { readLayerLifecycleSummary } from '../layerSummary.js';
import { CITY_POIS } from '../../locations.js';
import { unavailablePlaceSearch } from '../../search/placeSearch.js';
import { normalizeRadioCountryInput } from '../../data/radioCountry.js';
import { normalizeLocationId } from './shared.js';
const RADIO_COUNTRY_CENTERS = new Map([
  ['us', { lat: 39.8, lon: -98.6, country: 'US', label: 'United States' }],
  ['usa', { lat: 39.8, lon: -98.6, country: 'US', label: 'United States' }],
  [
    'united states',
    { lat: 39.8, lon: -98.6, country: 'US', label: 'United States' },
  ],
  [
    'united states of america',
    { lat: 39.8, lon: -98.6, country: 'US', label: 'United States' },
  ],
]);

/** Resolve curated cities and common country requests without moving the camera. */
export function knownRadioLocation(query, locationId = '') {
  const requestedId =
    normalizeLocationId(locationId) || normalizeLocationId(query);
  const city = requestedId ? CITY_POIS[requestedId] : null;
  if (city) {
    const bounds = city.viewBounds;
    return {
      lat: bounds
        ? (bounds.southwest.lat + bounds.northeast.lat) / 2
        : city.pois[0]?.lat,
      lon: bounds
        ? (bounds.southwest.lng + bounds.northeast.lng) / 2
        : city.pois[0]?.lon,
      label: city.name,
      country: '',
    };
  }
  return (
    RADIO_COUNTRY_CENTERS.get(
      String(query || '')
        .trim()
        .toLowerCase(),
    ) || null
  );
}

function radioCoordinatePair(args = {}) {
  const latitudeProvided = Object.hasOwn(args, 'latitude');
  const longitudeProvided = Object.hasOwn(args, 'longitude');
  const provided = latitudeProvided || longitudeProvided;
  const latitude = args.latitude;
  const longitude = args.longitude;
  const valid =
    latitudeProvided &&
    longitudeProvided &&
    typeof latitude === 'number' &&
    typeof longitude === 'number' &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180;
  return { provided, valid, latitude, longitude };
}

function radioActionIsCurrent(options = {}) {
  return (
    !options.signal?.aborted &&
    (typeof options.isCurrent !== 'function' || options.isCurrent())
  );
}

function radioAbortError() {
  const error = new Error('Radio request was superseded by a newer voice turn');
  error.name = 'AbortError';
  return error;
}

async function resolveRadioLocation(
  args = {},
  coordinates = radioCoordinatePair(args),
  options = {},
) {
  if (!radioActionIsCurrent(options)) throw radioAbortError();
  if (coordinates.valid) {
    const { latitude, longitude } = coordinates;
    return {
      lat: latitude,
      lon: longitude,
      label: `${latitude.toFixed(3)}, ${longitude.toFixed(3)}`,
      country: '',
    };
  }
  const query = String(args.locationQuery || '').trim();
  const known = knownRadioLocation(query, args.locationId);
  if (known) return known;
  if (!query) return null;
  const { placeSearch = unavailablePlaceSearch, signal } = options;
  const { place } = await placeSearch.geocode(query, { signal });
  if (!radioActionIsCurrent(options)) throw radioAbortError();
  if (!place) return null;
  // Localized provider country labels must not become station country filters.
  return {
    lat: place.lat,
    lon: place.lng,
    label: place.label || query,
    country: '',
  };
}

/** Voice Radio controls over the Radio layer's public player surface. */
export async function controlRadio(
  viewer,
  dataManager,
  args = {},
  options = {},
) {
  const requestedAction = String(args.action || '')
    .trim()
    .toLowerCase();
  const coordinates = radioCoordinatePair(args);
  const hasSelectionCriteria = Boolean(
    args.category ||
    args.locationId ||
    args.locationQuery ||
    coordinates.provided ||
    args.country ||
    args.stationQuery,
  );
  // Realtime models can reasonably interpret "play news near Austin" as Play
  // plus qualifiers. Play cannot honor those qualifiers, so normalize that
  // equivalent tool shape to Select instead of silently choosing the current
  // viewport's nearest station.
  const action =
    requestedAction === 'play' && hasSelectionCriteria
      ? 'select'
      : requestedAction;

  const readRadioLifecycle = () =>
    readLayerLifecycleSummary(dataManager, 'radio');

  const radio = dataManager.layers.get('radio')?.module;
  if (!radio) {
    return {
      ok: false,
      action: 'control_radio',
      error: 'Radio layer unavailable',
      ...readRadioLifecycle(),
    };
  }
  const normalizedCountry = normalizeRadioCountryInput(args.country);
  let lastIntentOutcome = null;
  let lastIntentError = null;

  const intentSummary = () =>
    lastIntentOutcome
      ? {
          phase: lastIntentOutcome.phase,
          cancellationReason: lastIntentOutcome.cancellationReason || null,
          successorIntentEpoch: lastIntentOutcome.successorIntentEpoch ?? null,
          successorEnabled: lastIntentOutcome.successorEnabled ?? null,
          successorOrigin: lastIntentOutcome.successorOrigin ?? null,
        }
      : {};

  const cancelled = (summarize) => ({
    ok: false,
    action: 'control_radio',
    cancelled: true,
    error: 'Radio request was superseded by a newer voice turn',
    ...intentSummary(),
    ...summarize(),
  });

  const radioLifecycleIsSettled = (shouldEnable) => {
    const lifecycle = readRadioLifecycle();
    return (
      lifecycle.enabled === shouldEnable &&
      lifecycle.lifecycleState === (shouldEnable ? 'enabled' : 'disabled') &&
      !lifecycle.lifecycleUncertain
    );
  };

  const setRadioEnabled = async (shouldEnable) => {
    lastIntentOutcome = null;
    lastIntentError = null;
    if (!radioActionIsCurrent(options)) return false;
    const enableOptions = { origin: 'voice' };
    // Both lifecycle directions can await module work. Let the manager own
    // the complete transaction so barge-in cancels it before a settled
    // visibility event can record explicit Context intent.
    if (options.signal) enableOptions.signal = options.signal;
    let result = false;
    try {
      if (typeof dataManager._setEnabledWithIntent === 'function') {
        const intent = dataManager._setEnabledWithIntent(
          'radio',
          shouldEnable,
          enableOptions,
        );
        result = await intent.promise;
        if (Number.isInteger(intent.intentEpoch)) {
          lastIntentOutcome = await dataManager._waitForVisibilityIntent?.(
            'radio',
            intent.intentEpoch,
          );
        }
      } else {
        result = await dataManager.setEnabled(
          'radio',
          shouldEnable,
          enableOptions,
        );
      }
    } catch (error) {
      lastIntentError = error;
      return false;
    }
    if (lastIntentOutcome?.succeeded === false) return false;
    if (!radioActionIsCurrent(options) && lastIntentOutcome?.succeeded !== true)
      return false;
    return result !== false && radioLifecycleIsSettled(shouldEnable);
  };

  const lifecycleFailure = (message, summarize) => ({
    ok: false,
    action: 'control_radio',
    cancelled: Boolean(lastIntentOutcome?.cancellationReason),
    error: lastIntentError?.message || message,
    ...intentSummary(),
    ...summarize(),
  });

  const authorizeRadioPlayerMutation = async ({ enableIfOff = false } = {}) => {
    const lifecycle = readRadioLifecycle();
    if (radioLifecycleIsSettled(true)) return true;
    if (
      !enableIfOff &&
      !lifecycle.enabled &&
      lifecycle.lifecycleState === 'disabled' &&
      !lifecycle.lifecycleUncertain
    )
      return false;
    const reconciled = await setRadioEnabled(true);
    return reconciled && radioLifecycleIsSettled(true);
  };

  const summarize = () => {
    const state = radio.getUIState?.() || {};
    return {
      radioAction: action,
      ...readRadioLifecycle(),
      stationId: state.selected?.id || null,
      category: state.filter || 'all',
      audioState: state.audioState || 'stopped',
      volumePct: Math.round((state.volume ?? 0.8) * 100),
      mutedForVoice: Boolean(state.voiceDucked),
    };
  };

  if (!normalizedCountry.valid) {
    return {
      ok: false,
      action: 'control_radio',
      error:
        'Radio country must be a recognized code or country name (80 characters maximum)',
      ...summarize(),
    };
  }

  if (coordinates.provided && !coordinates.valid) {
    return {
      ok: false,
      action: 'control_radio',
      error:
        'Radio coordinates require a complete numeric latitude/longitude pair in range',
      ...summarize(),
    };
  }

  if (!radioActionIsCurrent(options)) return cancelled(summarize);

  if (action === 'enable' || action === 'disable') {
    const shouldEnable = action === 'enable';
    const changed = await setRadioEnabled(shouldEnable);
    if (!radioActionIsCurrent(options) && lastIntentOutcome?.succeeded !== true)
      return cancelled(summarize);
    if (!changed) {
      return lifecycleFailure(
        `Radio could not be ${shouldEnable ? 'enabled' : 'disabled'}`,
        summarize,
      );
    }
    return { ok: true, action: 'control_radio', ...summarize() };
  }
  if (action === 'status')
    return { ok: true, action: 'control_radio', ...summarize() };
  if (action === 'volume') {
    const volumePct = Number(args.volumePct);
    if (!Number.isFinite(volumePct) || volumePct < 0 || volumePct > 100) {
      return {
        ok: false,
        action: 'control_radio',
        error: 'Radio volume must be from 0 to 100',
        ...summarize(),
      };
    }
    const authorized = await authorizeRadioPlayerMutation();
    if (!radioActionIsCurrent(options)) return cancelled(summarize);
    if (!authorized) {
      return lifecycleFailure(
        'Radio must be fully enabled before changing volume',
        summarize,
      );
    }
    if (!radioActionIsCurrent(options)) return cancelled(summarize);
    const volumeApplied =
      typeof dataManager.setLayerParams === 'function'
        ? dataManager.setLayerParams(
            'radio',
            { volume: volumePct / 100 },
            { origin: 'voice' },
          )
        : radio.setVolume(volumePct / 100);
    if (volumeApplied === false) {
      return {
        ok: false,
        action: 'control_radio',
        error: 'Radio must be fully enabled before changing volume',
        ...summarize(),
      };
    }
    return { ok: true, action: 'control_radio', ...summarize() };
  }
  if (action === 'stop') {
    if (!radioActionIsCurrent(options)) return cancelled(summarize);
    let stopped = false;
    try {
      stopped = await radio.stopPlayback({ origin: 'voice' });
    } catch (error) {
      return {
        ok: false,
        action: 'control_radio',
        error: error?.message || 'Radio could not be stopped',
        ...summarize(),
      };
    }
    if (!radioActionIsCurrent(options)) return cancelled(summarize);
    if (stopped === false) {
      return {
        ok: false,
        action: 'control_radio',
        error: 'Radio could not be stopped',
        ...summarize(),
      };
    }
    return { ok: true, action: 'control_radio', ...summarize() };
  }
  if (action === 'pause') {
    // Pause is a playback-only control. In particular, a Pause sibling must
    // never resurrect a layer that an explicit Disable just turned off. Keep
    // its established cancellation authority while an enable is in flight:
    // the controller commits a successful Pause by aborting that older work.
    const lifecycle = readRadioLifecycle();
    if (!lifecycle.enabled && lifecycle.lifecycleState !== 'enabling') {
      return {
        ok: true,
        action: 'control_radio',
        changed: false,
        ...summarize(),
      };
    }
    if (!radioActionIsCurrent(options)) return cancelled(summarize);
    const paused = radio.pause?.({ origin: 'voice' }) || false;
    if (!paused) {
      return {
        ok: false,
        action: 'control_radio',
        error: 'Radio could not be paused',
        ...summarize(),
      };
    }
    return { ok: true, action: 'control_radio', changed: true, ...summarize() };
  }
  let resolvedLocation = null;
  if (action === 'select') {
    try {
      // Resolve asynchronous user input before enabling Radio. That keeps an
      // interrupted lookup from mutating layer or station state after barge-in.
      resolvedLocation = await resolveRadioLocation(args, coordinates, options);
    } catch (error) {
      if (error?.name === 'AbortError' || !radioActionIsCurrent(options))
        return cancelled(summarize);
      throw error;
    }
    if (!radioActionIsCurrent(options)) return cancelled(summarize);
    if ((args.locationQuery || args.locationId) && !resolvedLocation) {
      return {
        ok: false,
        action: 'control_radio',
        error: `Could not resolve Radio location "${args.locationQuery || args.locationId}"`,
        ...summarize(),
      };
    }
  }
  const authorized = await authorizeRadioPlayerMutation({ enableIfOff: true });
  if (!radioActionIsCurrent(options)) return cancelled(summarize);
  if (!authorized) {
    return lifecycleFailure('Radio could not be enabled', summarize);
  }
  const state = radio.getUIState?.() || {};
  if (!radioActionIsCurrent(options)) return cancelled(summarize);
  if (!state.stationCount) {
    return {
      ok: false,
      action: 'control_radio',
      error: state.error || 'No healthy Radio stations are available',
      ...summarize(),
    };
  }
  if (action === 'play' || action === 'resume') {
    if (!radioActionIsCurrent(options)) return cancelled(summarize);
    const prepared = state.selected
      ? true
      : radio.cycleStation?.(1, { focus: false, autoplay: false });
    return {
      ok: Boolean(prepared),
      action: 'control_radio',
      radioPlaybackRequested: Boolean(prepared),
      ...summarize(),
    };
  }
  if (action === 'next' || action === 'previous') {
    if (!radioActionIsCurrent(options)) return cancelled(summarize);
    if (args.category) {
      if (typeof dataManager.setLayerParams === 'function') {
        dataManager.setLayerParams(
          'radio',
          { filter: String(args.category) },
          { origin: 'voice' },
        );
      } else {
        radio.setFilter(String(args.category));
      }
    }
    const selected = radio.cycleStation?.(action === 'next' ? 1 : -1, {
      focus: false,
      autoplay: false,
    });
    return {
      ok: Boolean(selected),
      action: 'control_radio',
      radioPlaybackRequested: Boolean(selected),
      ...summarize(),
    };
  }
  if (action === 'select') {
    const location = resolvedLocation;
    if (!radioActionIsCurrent(options)) return cancelled(summarize);
    const station = radio.selectRequestedStation?.(
      {
        categoryId: String(args.category || 'all'),
        anchor: location ? { lat: location.lat, lon: location.lon } : null,
        country: normalizedCountry.empty
          ? String(location?.country || '')
          : normalizedCountry.code,
        stationQuery: String(args.stationQuery || ''),
      },
      { autoplay: false },
    );
    if (!station) {
      return {
        ok: false,
        action: 'control_radio',
        error: 'No Radio station matched that location and category',
        ...summarize(),
      };
    }
    return {
      ok: true,
      action: 'control_radio',
      radioPlaybackRequested: true,
      requestedLocation: location?.label || null,
      ...summarize(),
    };
  }
  throw new Error(`Unknown Radio action: ${args.action || 'missing'}`);
}
/**
 * Execute the control_radio voice tool.
 * @param {{ args: object, context: object }} request Tool arguments and the runner context.
 * @returns {Promise<object>}
 */
export async function execute({ args, context }) {
  const name = 'control_radio';
  const { viewer, dataManager, placeSearch, runOptions } = context;
    if (name === 'control_radio') {
      return controlRadio(viewer, dataManager, args, {
        ...runOptions,
        placeSearch,
      });
    }
}

/** Voice tool handler for control_radio. */
export const action = {
  name: 'control_radio',
  execute,
};
