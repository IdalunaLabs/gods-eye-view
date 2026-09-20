/**
 * Graphics quality tiers — cooler by default, sharper on demand.
 *
 * Pure policy: no Cesium, no DOM. The controller applies the resolved preset
 * to the scene; the display controls persist a selection. `auto` resolves from
 * power and visibility without those owners having to share a clock.
 *
 * Cesium encodes "MSAA off" as `msaaSamples = 1`, not 0. Battery therefore
 * stores 1 so the controller can write the value through unchanged.
 */

export const GRAPHICS_TIER_STORAGE_KEY = 'gev:graphics-tier:v1';
export const GRAPHICS_TIER_DEFAULT_SELECTION = 'auto';
export const GRAPHICS_TIER_IDS = Object.freeze([
  'battery',
  'balanced',
  'cinematic',
]);
export const GRAPHICS_TIER_SELECTIONS = Object.freeze([
  'auto',
  ...GRAPHICS_TIER_IDS,
]);

/** Enable ambient occlusion only when the camera is closer than this, in meters. */
export const NEAR_AMBIENT_OCCLUSION_HEIGHT_M = 2000;
/** Cap Retina cinematic scale so a 3x display does not 9x the pixel fill. */
export const MAX_CINEMATIC_RESOLUTION_SCALE = 2;
/** Balanced/default animation clock for style `time` uniforms, in Hz. */
export const DEFAULT_STYLE_TICK_HZ = 30;

const TIER_BASE = Object.freeze({
  battery: Object.freeze({
    resolutionScale: 1,
    msaaSamples: 1,
    targetFrameRate: 30,
    styleTickHz: 15,
    tilesetMaximumScreenSpaceError: 32,
    hdr: false,
    sunLight: false,
    nearAmbientOcclusion: false,
    detectionDensityCap: 25,
  }),
  balanced: Object.freeze({
    resolutionScale: 1,
    msaaSamples: 4,
    targetFrameRate: 60,
    styleTickHz: DEFAULT_STYLE_TICK_HZ,
    tilesetMaximumScreenSpaceError: 16,
    hdr: false,
    sunLight: true,
    nearAmbientOcclusion: false,
    detectionDensityCap: null,
  }),
  cinematic: Object.freeze({
    msaaSamples: 2,
    targetFrameRate: null,
    styleTickHz: 60,
    tilesetMaximumScreenSpaceError: 8,
    hdr: true,
    sunLight: true,
    nearAmbientOcclusion: true,
    detectionDensityCap: null,
  }),
});

/**
 * @param {unknown} value
 * @returns {'auto'|'battery'|'balanced'|'cinematic'}
 */
export function normalizeGraphicsTierSelection(value) {
  const id = String(value || '')
    .trim()
    .toLowerCase();
  return GRAPHICS_TIER_SELECTIONS.includes(id)
    ? id
    : GRAPHICS_TIER_DEFAULT_SELECTION;
}

/**
 * Resolve the operator selection into a concrete tier.
 * Auto prefers battery while the tab is hidden or the machine is discharging,
 * and balanced otherwise. An explicit selection always wins.
 *
 * @param {object} [input]
 * @param {unknown} [input.selection]
 * @param {boolean} [input.batteryDischarging]
 * @param {boolean} [input.documentHidden]
 * @returns {'battery'|'balanced'|'cinematic'}
 */
export function resolveGraphicsTier({
  selection = GRAPHICS_TIER_DEFAULT_SELECTION,
  batteryDischarging = false,
  documentHidden = false,
} = {}) {
  const normalized = normalizeGraphicsTierSelection(selection);
  if (normalized !== 'auto') return normalized;
  if (documentHidden || batteryDischarging === true) return 'battery';
  return 'balanced';
}

/**
 * Cinematic framebuffer scale: native device pixels, capped at 2.
 * @param {number} [devicePixelRatio]
 * @returns {number}
 */
export function cinematicResolutionScale(devicePixelRatio = 1) {
  const raw = Number(devicePixelRatio);
  const dpr = Number.isFinite(raw) ? raw : 1;
  return Math.min(MAX_CINEMATIC_RESOLUTION_SCALE, Math.max(1, dpr));
}

/**
 * Frozen knobs for a concrete tier. `targetFrameRate` is `null` when uncapped.
 * @param {string} tierId
 * @param {{devicePixelRatio?: number}} [options]
 * @returns {Readonly<{
 *   id: string,
 *   resolutionScale: number,
 *   msaaSamples: number,
 *   targetFrameRate: number|null,
 *   styleTickHz: number,
 *   tilesetMaximumScreenSpaceError: number,
 *   hdr: boolean,
 *   sunLight: boolean,
 *   nearAmbientOcclusion: boolean,
 *   detectionDensityCap: number|null,
 * }>}
 */
export function graphicsTierPreset(tierId, { devicePixelRatio = 1 } = {}) {
  const id = GRAPHICS_TIER_IDS.includes(tierId) ? tierId : 'balanced';
  const base = TIER_BASE[id];
  const resolutionScale =
    id === 'cinematic'
      ? cinematicResolutionScale(devicePixelRatio)
      : base.resolutionScale;
  return Object.freeze({
    id,
    ...base,
    resolutionScale,
  });
}

/**
 * Clamp overlay density for a tier cap without rewriting the operator's slider.
 * A missing cap is a no-op. Non-finite density is returned unchanged.
 * @param {number} densityPct
 * @param {number|null|undefined} cap
 * @returns {number}
 */
export function clampDetectionDensity(densityPct, cap) {
  const density = Number(densityPct);
  if (!Number.isFinite(density)) return densityPct;
  if (cap == null || !Number.isFinite(Number(cap))) return density;
  return Math.min(density, Number(cap));
}

/**
 * @param {Pick<Storage, 'getItem'>|null|undefined} storage
 * @returns {'auto'|'battery'|'balanced'|'cinematic'}
 */
export function readStoredGraphicsTierSelection(storage) {
  try {
    return normalizeGraphicsTierSelection(
      storage?.getItem?.(GRAPHICS_TIER_STORAGE_KEY),
    );
  } catch {
    return GRAPHICS_TIER_DEFAULT_SELECTION;
  }
}

/**
 * @param {unknown} selection
 * @param {Pick<Storage, 'setItem'>|null|undefined} storage
 * @returns {'auto'|'battery'|'balanced'|'cinematic'}
 */
export function writeStoredGraphicsTierSelection(selection, storage) {
  const normalized = normalizeGraphicsTierSelection(selection);
  try {
    storage?.setItem?.(GRAPHICS_TIER_STORAGE_KEY, normalized);
  } catch {
    /* quota / private mode */
  }
  return normalized;
}
