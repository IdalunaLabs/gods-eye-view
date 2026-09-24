import * as Cesium from 'cesium';
import { CITY_POIS } from '../../locations.js';
import { contextModeWord } from '../../contextModePolicy.js';
const ALLOWED_STYLES = new Set([
  'normal',
  'retro',
  'surveillance',
  'thermal',
  'anime',
  'noir',
  'snow',
]);
const PANEL_ALIASES = new Map([
  ['data', 'data-panel'],
  ['data layers', 'data-panel'],
  ['layers', 'data-panel'],
  ['layer menu', 'data-panel'],
  ['data layer menu', 'data-panel'],
  ['locations', 'location-bar'],
  ['location', 'location-bar'],
  ['styles', 'control-panel'],
  ['filters', 'control-panel'],
  ['visual styles', 'control-panel'],
  ['cctv', 'cctv-panel'],
  ['cameras', 'cctv-panel'],
  ['radio', 'radio-panel'],
  ['internet radio', 'radio-panel'],
  ['radio stations', 'radio-panel'],
  ['context', 'global-context-panel'],
  ['context panel', 'global-context-panel'],
  ['global context', 'global-context-panel'],
  ['right context', 'global-context-panel'],
  ['context right panel', 'global-context-panel'],
  ['scenes', 'scene-panel'],
  ['scene', 'scene-panel'],
  ['post processing', 'pp-toggles'],
  ['hud controls', 'pp-toggles'],
  ['map stack', 'control-panel'],
  ['stack', 'control-panel'],
  ['basemap', 'control-panel'],
  ['map sources', 'control-panel'],
  ['sources', 'control-panel'],
]);

const PANEL_IDS = new Set([
  'data-panel',
  'location-bar',
  'control-panel',
  'cctv-panel',
  'radio-panel',
  'global-context-panel',
  'scene-panel',
  'pp-toggles',
]);
const CONTEXT_MODE_ALIASES = new Map([
  ['off', 'off'],
  ['none', 'off'],
  ['clear', 'off'],
  ['contacts', 'flights'],
  ['contact', 'flights'],
  ['flights', 'flights'],
  ['space missions', 'space-missions'],
  ['space-mission', 'space-missions'],
  ['space mission', 'space-missions'],
  ['space-missions', 'space-missions'],
  ['missions', 'space-missions'],
]);
/**
 * Every model-readable field that carries a context-mode id, and what an
 * absent value means for each.
 *
 * `mode` always names a mode, so nothing is 'off'. `entering` and `priorMode`
 * are absent when there is no such mode at all — calling those 'off' would
 * assert a state that does not exist.
 */
const CONTEXT_MODE_RESULT_FIELDS = Object.freeze([
  { field: 'mode', emptyAs: 'off' },
  { field: 'entering', emptyAs: null },
  { field: 'priorMode', emptyAs: null },
]);

/** Nested results that are themselves context-mode payloads the model reads. */
const NESTED_CONTEXT_RESULT_FIELDS = Object.freeze([
  'context',
  'contextRollback',
]);

/**
 * Report a context-mode payload in the tools' own vocabulary.
 *
 * `set_context_mode` accepts 'contacts' while the mode's internal id is
 * 'flights'. Reporting the internal id back made the model read
 * `mode:'flights'` as "Contacts is off" and refuse to answer from the Contacts
 * window counts sitting in the very same payload (owner field session
 * 2026-08-21). Secondary fields and nested transition/rollback results are
 * translated too — one leaked internal id is enough to recreate the confusion,
 * and a rollback result is exactly what the model reads when something went
 * wrong. Each internal id is kept alongside as `<field>Internal` for anything
 * reasoning about layers.
 * @param {object|null|undefined} state Any payload carrying context-mode fields.
 * @returns {object|null|undefined} The same payload, modes translated.
 */
export function withContextModeVocabulary(state) {
  if (!state || typeof state !== 'object') return state;
  let out = state;
  const mutable = () => {
    if (out === state) out = { ...state };
    return out;
  };
  for (const { field, emptyAs } of CONTEXT_MODE_RESULT_FIELDS) {
    if (!(field in state)) continue;
    const internal = state[field] ?? null;
    const target = mutable();
    target[field] = contextModeWord(internal, { emptyAs });
    target[`${field}Internal`] = internal;
  }
  for (const field of NESTED_CONTEXT_RESULT_FIELDS) {
    const nested = state[field];
    if (!nested || typeof nested !== 'object') continue;
    const translated = withContextModeVocabulary(nested);
    if (translated !== nested) mutable()[field] = translated;
  }
  return out;
}

const LAYER_ALIASES = new Map([
  ['flights', 'flights'],
  ['planes', 'flights'],
  ['aircraft', 'flights'],
  ['military', 'military'],
  ['military flights', 'military'],
  ['earthquakes', 'earthquakes'],
  ['quakes', 'earthquakes'],
  ['satellites', 'satellites'],
  ['space mission', 'rocket-launches'],
  ['space missions', 'rocket-launches'],
  ['missions', 'rocket-launches'],
  ['traffic', 'traffic'],
  ['street traffic', 'traffic'],
  ['cctv', 'cctv'],
  ['cameras', 'cctv'],
  ['radio', 'radio'],
  ['internet radio', 'radio'],
  ['radio stations', 'radio'],
  ['bikeshare', 'bikeshare'],
  ['bikes', 'bikeshare'],
  ['ais', 'ais-live-vessels'],
  ['ships', 'ais-live-vessels'],
  ['vessels', 'ais-live-vessels'],
  ['live vessels', 'ais-live-vessels'],
  ['datacenters', 'local-datacenters'],
  ['data centers', 'local-datacenters'],
  ['data centres', 'local-datacenters'],
  ['dams', 'local-dams'],
  ['submarine cables', 'telegeography-submarine-cables'],
  ['cables', 'telegeography-submarine-cables'],
  ['telegeography', 'telegeography-submarine-cables'],
  ['firms', 'local-firms'],
  ['fires', 'local-firms'],
  ['active fires', 'local-firms'],
  ['alpr', 'alpr-cameras'],
  ['alpr cameras', 'alpr-cameras'],
  ['flock cameras', 'alpr-cameras'],
  ['license plate readers', 'alpr-cameras'],
  ['license plate cameras', 'alpr-cameras'],
  ['plate readers', 'alpr-cameras'],
]);

const CITY_ALIASES = new Map([
  ['new york', 'nyc'],
  ['new york city', 'nyc'],
  ['san francisco', 'sf'],
  ['washington', 'dc'],
  ['washington dc', 'dc'],
  ['washington d.c.', 'dc'],
]);

// Basemap stack vocabulary. Switching requires an explicit stack name
// ("Bing aerial", "road map", "OSM", "Google 3D") — any "satellite(s)"
// phrasing ALWAYS means the satellites DATA LAYER, never a basemap; the
// session instructions carry the decision table.
//
// Road phrasings resolve to OSM, the one shipped road basemap. Every alias
// must name a live `MAP_STACKS` id: an alias for a retired stack would resolve
// cleanly and then fail at the controller with "Unknown map stack", which reads
// to the operator as a broken command rather than a retired source.
const STACK_ALIASES = new Map([
  ['photoreal', 'photoreal'],
  ['google 3d', 'photoreal'],
  ['google', 'photoreal'],
  ['3d', 'photoreal'],
  ['photorealistic', 'photoreal'],
  ['bing-aerial', 'bing-aerial'],
  ['bing aerial', 'bing-aerial'],
  ['bing-labels', 'bing-labels'],
  ['bing labels', 'bing-labels'],
  ['labels', 'bing-labels'],
  ['aerial with labels', 'bing-labels'],
  ['esri-imagery', 'esri-imagery'],
  ['esri', 'esri-imagery'],
  ['esri imagery', 'esri-imagery'],
  ['esri satellite', 'esri-imagery'],
  ['osm', 'osm'],
  ['openstreetmap', 'osm'],
  ['open street map', 'osm'],
  ['road', 'osm'],
  ['roads', 'osm'],
  ['road map', 'osm'],
]);

/** Search order for track_entity across entity layer families. */
export const TRACKABLE_FAMILIES = [
  { layerId: 'flights', kind: 'aircraft' },
  { layerId: 'military', kind: 'aircraft' },
  { layerId: 'ais-live-vessels', kind: 'vessel' },
  { layerId: 'satellites', kind: 'satellite' },
];

export function normalizeStackId(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase();
  if (!raw) return null;
  return STACK_ALIASES.get(raw) || null;
}

/** Releases tracking/selection on every entity layer family. */
export function stopAllTracking(viewer, dataManager) {
  const released = [];
  const failed = new Set();
  for (const family of TRACKABLE_FAMILIES) {
    const module = dataManager.layers.get(family.layerId)?.module;
    if (!module) continue;
    try {
      if (family.kind === 'vessel') {
        if (module.getSelectedInfo?.()) {
          if (
            typeof module.clearSelection !== 'function' ||
            module.clearSelection() === false
          ) {
            failed.add(family.layerId);
          } else {
            released.push(family.layerId);
          }
        }
      } else if (module.getTrackedInfo?.()) {
        if (
          typeof module.stopTracking !== 'function' ||
          module.stopTracking({ origin: 'voice' }) === false
        ) {
          failed.add(family.layerId);
        } else {
          released.push(family.layerId);
        }
      }
    } catch {
      failed.add(family.layerId);
    }
  }
  for (const [layerId, key] of [
    ['flights', 'selectedFlightsTrackingId'],
    ['military', 'selectedMilitaryTrackingId'],
    ['satellites', 'selectedSatTrackingId'],
  ]) {
    try {
      if (
        dataManager.setLayerParams(
          layerId,
          { [key]: null },
          { origin: 'voice' },
        ) === false
      ) {
        failed.add(layerId);
      }
    } catch {
      failed.add(layerId);
    }
  }
  if (viewer) viewer.trackedEntity = undefined;
  if (failed.size) {
    const failedLayerIds = [...failed];
    return {
      ok: false,
      action: 'stop_tracking',
      released,
      failedLayerIds,
      error: `Tracking could not be cleared for: ${failedLayerIds.join(', ')}`,
    };
  }
  return { ok: true, action: 'stop_tracking', released };
}

/** Run one validated voice camera mutation through the UI-owned authority seam. */
export function runManagedVoiceNavigation(
  styleManager,
  noun,
  action,
  navigate,
  releaseOptions = undefined,
) {
  if (typeof styleManager?.runImmediateNavigation !== 'function') {
    return { ok: false, action, error: 'Camera navigation policy unavailable' };
  }
  const result = styleManager.runImmediateNavigation(
    noun,
    navigate,
    releaseOptions,
  );
  if (result !== false) return result;
  return {
    ok: false,
    action,
    error: 'Camera navigation is unavailable in the current view',
  };
}

export function normalizePanelId(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (PANEL_IDS.has(raw)) return raw;
  return PANEL_ALIASES.get(raw.toLowerCase()) || null;
}

export function normalizeLayerId(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (LAYER_ALIASES.has(raw.toLowerCase()))
    return LAYER_ALIASES.get(raw.toLowerCase());
  return raw;
}

export function setPanelOpen(styleManager, panelId, open) {
  if (styleManager && typeof styleManager.setPanelCollapsed === 'function') {
    styleManager.setPanelCollapsed(panelId, !open, { explicit: true });
  } else {
    const panel = document.getElementById(panelId);
    if (panel) panel.classList.toggle('collapsed', !open);
  }
}

export function normalizeContextMode(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase();
  if (!raw) return null;
  return CONTEXT_MODE_ALIASES.get(raw) || null;
}

export function normalizeStyle(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase();
  if (raw === 'filter off' || raw === 'off' || raw === 'default')
    return 'normal';
  if (raw === 'night vision' || raw === 'nvg') return 'surveillance';
  if (raw === 'flir') return 'thermal';
  if (ALLOWED_STYLES.has(raw)) return raw;
  return null;
}

export function normalizeLocationId(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase();
  if (!raw) return null;
  if (CITY_POIS[raw]) return raw;
  if (CITY_ALIASES.has(raw)) return CITY_ALIASES.get(raw);
  return null;
}

export function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (value) => Cesium.Math.toRadians(value);
  const radiusKm = 6371.0088;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  return 2 * radiusKm * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

/**
 * The Contacts panel's own counts, or null when Contacts has no subject.
 * Read through the awareness snapshot the panel renders, so the two cannot
 * diverge no matter which surface asks.
 * @returns {object|null} Panel-equivalent window counts.
 */
export function activeContactsWindow(dataManager) {
  try {
    const layer = dataManager?.layers?.get('military-awareness')?.module;
    return (
      layer?.contactsWindowFromSnapshot?.(layer.getContextSnapshot?.()) ?? null
    );
  } catch {
    return null;
  }
}
