import * as Cesium from 'cesium';
import { registerAnalystAlertSource } from '../data/analystEngine.js';
import { createFusionEngine } from '../fusion/fusionEngine.js';
import { governorRequestRender } from '../renderGovernor.js';
import { createAlertsPanel } from '../ui/alertsPanel.js';

const LAYER_KEYS = Object.freeze([
  'flights',
  'military',
  'ais-live-vessels',
  'local-firms',
  'earthquakes',
]);

/**
 * Read localStorage without throwing when the platform storage port is closed.
 * @param {Storage|null|undefined} storage
 * @returns {Storage|null}
 */
function usableStorage(storage) {
  if (storage && typeof storage.getItem === 'function') return storage;
  try {
    const candidate = globalThis.localStorage;
    if (!candidate || typeof candidate.getItem !== 'function') return null;
    candidate.getItem(FUSION_STORAGE_PROBE);
    return candidate;
  } catch {
    return null;
  }
}

const FUSION_STORAGE_PROBE = 'godsEyeView.v6.fusionDetectors';

function recordsFor(dataManager, layerKey) {
  if (!dataManager) return [];
  try {
    if (typeof dataManager.isEnabled === 'function' && !dataManager.isEnabled(layerKey)) {
      return [];
    }
    const layer = dataManager.layers?.get?.(layerKey);
    const read = layer?.module?.getAnalystRecords;
    if (typeof read !== 'function') return [];
    const rows = read.call(layer.module);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function maxSeverity(alerts) {
  if (alerts.some((alert) => alert.severity === 'warn')) return 'warn';
  if (alerts.some((alert) => alert.severity === 'watch')) return 'watch';
  return 'info';
}

/**
 * Fly to and track the alert's primary entity through the shell navigation owner.
 * @param {object} styleManager
 * @param {object} dataManager
 * @param {object} alert
 * @returns {void}
 */
function focusAlert(styleManager, dataManager, alert) {
  const entity = alert?.entities?.[0];
  const position = alert?.position;
  const navigate = (fly) => {
    if (typeof styleManager?._runExplicitNavigation === 'function') {
      styleManager._runExplicitNavigation('alert', fly);
      return;
    }
    fly();
  };
  navigate(() => {
    const module = entity
      ? dataManager?.layers?.get?.(entity.layer)?.module
      : null;
    if (entity?.layer === 'flights' || entity?.layer === 'military') {
      module?.trackById?.(entity.id, { origin: 'user' });
      return;
    }
    if (entity?.layer === 'ais-live-vessels') {
      module?.selectById?.(entity.id);
    }
    const viewer = styleManager?.viewer;
    if (
      !viewer?.camera?.flyTo ||
      !Number.isFinite(position?.lat) ||
      !Number.isFinite(position?.lon)
    ) {
      return;
    }
    const height = entity?.layer === 'ais-live-vessels' ? 8000 : 25000;
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        position.lon,
        position.lat,
        height,
      ),
      duration: 1.4,
    });
  });
}

/**
 * Start cross-layer fusion for one application data phase.
 * The engine stays off the render path. One render is requested only when the
 * published alert list changes. Missing panel or HUD markup is ignored.
 * @param {object} options
 * @param {object} options.dataManager
 * @param {object} options.styleManager
 * @param {Function} [options.requestRender]
 * @param {Storage|null} [options.storage]
 * @returns {{start: Function, stop: Function, engine: object}}
 */
export function startFusionAlerts({
  dataManager,
  styleManager,
  requestRender = governorRequestRender,
  storage = null,
} = {}) {
  const root =
    globalThis.document?.getElementById?.('alerts-panel') || null;
  const engine = createFusionEngine({
    getRecords: (layerKey) => recordsFor(dataManager, layerKey),
    storage: usableStorage(storage),
    requestRender,
    autostart: false,
  });
  const panel = createAlertsPanel({
    root,
    readFlags: () => engine.getDetectorFlags(),
    writeFlag: (name, enabled) => engine.setDetectorEnabled(name, enabled),
    onFocus: (alert) => focusAlert(styleManager, dataManager, alert),
  });
  const paint = (alerts) => {
    panel.render(alerts);
    const severity = maxSeverity(alerts);
    styleManager?.hud?.setFusionAlertCount?.(alerts.length, severity);
  };
  const unsubscribe = engine.subscribe(paint);
  const unregister = registerAnalystAlertSource(() => engine.getAlerts());
  paint(engine.getAlerts());
  let stopped = false;
  return {
    engine,
    start() {
      if (!stopped) engine.start();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      engine.stop();
      unsubscribe();
      unregister();
      panel.destroy();
      styleManager?.hud?.setFusionAlertCount?.(0, 'info');
    },
    layerKeys: LAYER_KEYS,
  };
}
