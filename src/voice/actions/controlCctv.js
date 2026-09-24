import { CCTV_FOCUS_RESULT } from '../../layers/cctv/index.js';
/** Voice CCTV control over the cctv layer module's public surface. */
export async function controlCctv(dataManager, args = {}, styleManager = null) {
  const action = String(args.action || '').toLowerCase();
  const cctv = dataManager.layers.get('cctv')?.module;
  if (!cctv) {
    return {
      ok: false,
      action: 'control_cctv',
      error: 'CCTV layer unavailable',
    };
  }

  if (action === 'enable' || action === 'disable') {
    await dataManager.setEnabled('cctv', action === 'enable', {
      origin: 'voice',
    });
    return {
      ok: true,
      action: 'control_cctv',
      enabled: dataManager.isEnabled('cctv'),
    };
  }
  if (!dataManager.isEnabled('cctv')) {
    return {
      ok: false,
      action: 'control_cctv',
      error: 'CCTV layer is off — enable it first',
    };
  }

  const summarize = () => {
    const ui = cctv.getUIState?.() || {};
    return {
      activeCameraId: ui.activeCameraId || null,
      activeCamera: ui.activeCamera?.name || ui.activeCamera?.id || null,
      cameraCount: Array.isArray(ui.cameras)
        ? ui.cameras.length
        : ui.count || 0,
      showCoverage: !!ui.showCoverage,
      coverageMode: ui.coverageMode || (ui.showCoverage ? 'on' : 'off'),
      showProjection: !!ui.showProjection,
      calibrationMode: !!ui.calibrationMode,
      autoHop: !!ui.autoHop,
    };
  };

  if (action === 'select') {
    const query = String(args.cameraQuery || '')
      .trim()
      .toLowerCase();
    if (!query) throw new Error('control_cctv select needs cameraQuery');
    const cams = cctv.getUIState?.()?.cameras || [];
    const match =
      cams.find((cam) => String(cam.id || '').toLowerCase() === query) ||
      cams.find((cam) => String(cam.name || '').toLowerCase() === query) ||
      cams.find((cam) =>
        String(cam.name || '')
          .toLowerCase()
          .includes(query),
      );
    if (!match) {
      return {
        ok: false,
        action: 'control_cctv',
        error: `No camera matched "${args.cameraQuery}"`,
        ...summarize(),
      };
    }
    styleManager?.supersedeDeferredNavigation?.();
    const selected = cctv.selectCamera(match.id);
    const focusResult = selected
      ? cctv.focusCamera(match.id, 1.8)
      : CCTV_FOCUS_RESULT.NO_ACTIVE_CAMERA;
    return {
      action: 'control_cctv',
      selected: match.name || match.id,
      ...summarize(),
      ...cctvVoiceFocusOutcome(focusResult, { cameraSelected: !!selected }),
    };
  }
  if (action === 'next' || action === 'prev') {
    styleManager?.supersedeDeferredNavigation?.();
    const nextId = cctv.cycleCamera(action === 'next' ? 1 : -1);
    const focusResult = nextId
      ? cctv.focusCamera(nextId, 1.8)
      : CCTV_FOCUS_RESULT.NO_ACTIVE_CAMERA;
    return {
      action: 'control_cctv',
      ...summarize(),
      ...cctvVoiceFocusOutcome(focusResult, { cameraSelected: !!nextId }),
    };
  }
  if (action === 'nearest') {
    styleManager?.supersedeDeferredNavigation?.();
    const nearestId = cctv.focusNearest({ focus: false });
    const focusResult = nearestId
      ? cctv.focusCamera(nearestId, 1.8)
      : CCTV_FOCUS_RESULT.NO_ACTIVE_CAMERA;
    return {
      action: 'control_cctv',
      ...summarize(),
      ...cctvVoiceFocusOutcome(focusResult, { cameraSelected: !!nearestId }),
    };
  }
  if (action === 'focus') {
    const activeId = cctv.getUIState?.()?.activeCameraId;
    if (activeId) styleManager?.supersedeDeferredNavigation?.();
    const focusResult = activeId
      ? cctv.focusCamera(activeId)
      : CCTV_FOCUS_RESULT.NO_ACTIVE_CAMERA;
    return {
      action: 'control_cctv',
      ...summarize(),
      ...cctvVoiceFocusOutcome(focusResult),
    };
  }
  if (action === 'viewshed') {
    // Color-coded coverage volumes; enabled:false drops back to plain
    // coverage wireframes (not off — "hide coverage" is the coverage action).
    const next =
      typeof args.enabled === 'boolean' && !args.enabled ? 'on' : 'viewshed';
    dataManager.setLayerParams(
      'cctv',
      { coverageMode: next },
      { origin: 'voice' },
    );
    return { ok: true, action: 'control_cctv', ...summarize() };
  }
  if (action === 'adjust') {
    const current = summarize();
    const next =
      typeof args.enabled === 'boolean'
        ? args.enabled
        : !current.calibrationMode;
    dataManager.setLayerParams(
      'cctv',
      { calibrationMode: next },
      { origin: 'voice' },
    );
    return { ok: true, action: 'control_cctv', ...summarize() };
  }
  if (action === 'coverage') {
    const current = summarize();
    const next =
      typeof args.enabled === 'boolean' ? args.enabled : !current.showCoverage;
    dataManager.setLayerParams(
      'cctv',
      { coverageMode: next ? 'on' : 'off' },
      { origin: 'voice' },
    );
    return { ok: true, action: 'control_cctv', ...summarize() };
  }
  if (action === 'projection' || action === 'autohop') {
    const key = action === 'projection' ? 'showProjection' : 'autoHop';
    const current = summarize();
    const next =
      typeof args.enabled === 'boolean' ? args.enabled : !current[key];
    dataManager.setLayerParams('cctv', { [key]: next }, { origin: 'voice' });
    return { ok: true, action: 'control_cctv', ...summarize() };
  }
  throw new Error(`Unknown CCTV action: ${args.action || 'missing'}`);
}

/**
 * Maps a CCTV focus code to an honest voice-tool result.
 * @param {string|boolean} focusResult CCTV focus result code.
 * @param {Object} [options]
 * @param {boolean} [options.cameraSelected=false] Whether this action first selected a camera.
 * @returns {{ok: boolean, error: string|null}} Voice-facing result fields.
 */
export function cctvVoiceFocusOutcome(
  focusResult,
  { cameraSelected = false } = {},
) {
  if (focusResult === CCTV_FOCUS_RESULT.FOCUSED || focusResult === true) {
    return { ok: true, error: null };
  }
  if (focusResult === CCTV_FOCUS_RESULT.TRACKING_HOLDS_VIEW) {
    return {
      ok: false,
      error: cameraSelected
        ? 'Camera selected; tracking holds the view — say untrack to fly'
        : 'Camera active; tracking holds the view — say untrack first',
    };
  }
  if (focusResult === CCTV_FOCUS_RESULT.COCKPIT_ACTIVE) {
    return {
      ok: false,
      error: cameraSelected
        ? 'Camera selected; in cockpit — exit cockpit to fly to it'
        : 'In cockpit — exit cockpit to fly to a camera',
    };
  }
  return { ok: false, error: 'No active camera to focus' };
}
/**
 * Execute the control_cctv voice tool.
 * @param {{ args: object, context: object }} request Tool arguments and the runner context.
 * @returns {Promise<object>}
 */
export async function execute({ args, context }) {
  const name = 'control_cctv';
  const { styleManager, dataManager } = context;
  if (name === 'control_cctv') {
    return controlCctv(dataManager, args, styleManager);
  }
}

/** Voice tool handler for control_cctv. */
export const action = {
  name: 'control_cctv',
  execute,
};
