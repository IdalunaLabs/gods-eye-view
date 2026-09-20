import * as Cesium from 'cesium';
import {
  graphicsTierPreset,
  readStoredGraphicsTierSelection,
  resolveGraphicsTier,
  writeStoredGraphicsTierSelection,
  NEAR_AMBIENT_OCCLUSION_HEIGHT_M,
} from '../graphicsTier.js';

/**
 * Apply a graphics-tier preset to a live Cesium viewer.
 * All knobs are runtime-settable on Cesium 1.124; the viewer is not recreated.
 */
export class GraphicsTierController {
  /**
   * @param {object} options
   * @param {Cesium.Viewer} options.viewer
   * @param {object|null} [options.tileset]
   * @param {(reason: string) => void} [options.requestRender]
   * @param {Pick<Storage, 'getItem'|'setItem'>|null} [options.storage]
   * @param {Pick<Document, 'hidden'|'addEventListener'|'removeEventListener'>} [options.documentRef]
   * @param {{getBattery?: () => Promise<{charging: boolean, addEventListener: Function, removeEventListener: Function}>}} [options.navigatorRef]
   * @param {() => number} [options.getDevicePixelRatio]
   * @param {() => object} [options.createSunLight]
   * @param {() => number} [options.getCameraHeightMeters]
   */
  constructor({
    viewer,
    tileset = null,
    requestRender = () => {},
    storage = globalThis.localStorage,
    documentRef = globalThis.document,
    navigatorRef = globalThis.navigator,
    getDevicePixelRatio = () =>
      Number(globalThis.window?.devicePixelRatio) || 1,
    createSunLight = () => new Cesium.SunLight(),
    getCameraHeightMeters = () => viewer?.camera?.positionCartographic?.height,
  }) {
    if (!viewer?.scene)
      throw new TypeError('GraphicsTierController requires a Cesium viewer');
    this.viewer = viewer;
    this.tileset = tileset;
    this.requestRender = requestRender;
    this.storage = storage;
    this.documentRef = documentRef;
    this.navigatorRef = navigatorRef;
    this.getDevicePixelRatio = getDevicePixelRatio;
    this.createSunLight = createSunLight;
    this.getCameraHeightMeters = getCameraHeightMeters;
    this._listeners = new Set();
    this._destroyed = false;
    this._started = false;
    this._battery = null;
    this._batteryDischarging = false;
    this._defaultLight = undefined;
    this._removeCameraListener = null;
    this._onVisibility = () => this._apply();
    this._onChargingChange = () => {
      this._batteryDischarging = this._battery?.charging === false;
      this._apply();
    };
    this._onCameraChanged = () => this._syncAmbientOcclusion();
    this._selection = readStoredGraphicsTierSelection(storage);
    this._resolved = resolveGraphicsTier({
      selection: this._selection,
      batteryDischarging: false,
      documentHidden: documentRef?.hidden === true,
    });
    this._preset = graphicsTierPreset(this._resolved, {
      devicePixelRatio: this.getDevicePixelRatio(),
    });
  }

  /** Subscribe to resolved-tier changes. Fires immediately with current state. */
  subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    this._listeners.add(listener);
    listener(this.getDiagnostics());
    return () => this._listeners.delete(listener);
  }

  getSelection() {
    return this._selection;
  }

  getDiagnostics() {
    return {
      selection: this._selection,
      resolved: this._resolved,
      preset: this._preset,
      batteryDischarging: this._batteryDischarging,
    };
  }

  setSelection(selection) {
    this._selection = writeStoredGraphicsTierSelection(selection, this.storage);
    this._apply();
    return this._selection;
  }

  start() {
    if (this._started || this._destroyed) return this;
    this._started = true;
    this.documentRef?.addEventListener?.(
      'visibilitychange',
      this._onVisibility,
    );
    const changed = this.viewer.camera?.changed;
    if (changed?.addEventListener)
      this._removeCameraListener = changed.addEventListener(
        this._onCameraChanged,
      );
    this._watchBattery();
    this._apply();
    return this;
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this.documentRef?.removeEventListener?.(
      'visibilitychange',
      this._onVisibility,
    );
    this._removeCameraListener?.();
    this._removeCameraListener = null;
    if (this._battery && this._onChargingChange) {
      this._battery.removeEventListener?.(
        'chargingchange',
        this._onChargingChange,
      );
    }
    this._listeners.clear();
    this.viewer = null;
    this.tileset = null;
  }

  async _watchBattery() {
    const getBattery = this.navigatorRef?.getBattery;
    if (typeof getBattery !== 'function') return;
    try {
      const battery = await getBattery.call(this.navigatorRef);
      if (this._destroyed || !battery) return;
      this._battery = battery;
      battery.addEventListener?.('chargingchange', this._onChargingChange);
      this._onChargingChange();
    } catch {
      /* Battery API can reject; Auto then behaves as balanced. */
    }
  }

  _apply() {
    if (this._destroyed || !this.viewer?.scene) return;
    this._resolved = resolveGraphicsTier({
      selection: this._selection,
      batteryDischarging: this._batteryDischarging,
      documentHidden: this.documentRef?.hidden === true,
    });
    this._preset = graphicsTierPreset(this._resolved, {
      devicePixelRatio: this.getDevicePixelRatio(),
    });
    this._applyPreset(this._preset);
    const snapshot = this.getDiagnostics();
    for (const listener of this._listeners) listener(snapshot);
    this.requestRender('graphics-tier');
  }

  _applyPreset(preset) {
    const { viewer } = this;
    const scene = viewer.scene;
    viewer.useBrowserRecommendedResolution = false;
    viewer.resolutionScale = preset.resolutionScale;
    try {
      scene.msaaSamples = preset.msaaSamples;
    } catch {
      /* some contexts reject MSAA changes after creation */
    }
    viewer.targetFrameRate =
      preset.targetFrameRate == null ? undefined : preset.targetFrameRate;
    if (scene.postProcessStages?.fxaa)
      scene.postProcessStages.fxaa.enabled = false;
    const tileset = this.tileset;
    if (tileset && tileset.isDestroyed?.() !== true) {
      tileset.maximumScreenSpaceError = preset.tilesetMaximumScreenSpaceError;
    }
    if (preset.hdr && scene.highDynamicRangeSupported !== false)
      scene.highDynamicRange = true;
    else scene.highDynamicRange = false;
    this._syncSunLight(preset.sunLight);
    this._syncAmbientOcclusion();
  }

  _syncSunLight(enabled) {
    const scene = this.viewer?.scene;
    if (!scene) return;
    if (this._defaultLight === undefined) this._defaultLight = scene.light;
    if (!enabled) {
      if (this._defaultLight !== undefined) scene.light = this._defaultLight;
      return;
    }
    try {
      scene.light = this.createSunLight();
    } catch {
      if (this._defaultLight !== undefined) scene.light = this._defaultLight;
    }
  }

  _syncAmbientOcclusion() {
    if (this._destroyed || !this.viewer?.scene) return;
    const ao = this.viewer.scene.postProcessStages?.ambientOcclusion;
    if (!ao) return;
    const height = Number(this.getCameraHeightMeters());
    const near =
      Number.isFinite(height) && height < NEAR_AMBIENT_OCCLUSION_HEIGHT_M;
    const enabled = this._preset?.nearAmbientOcclusion === true && near;
    if (ao.enabled === enabled) return;
    ao.enabled = enabled;
    this.requestRender('graphics-tier-ao');
  }
}

/**
 * Install the controller and start listening. Idempotent per caller: each
 * install returns a fresh instance the application owns.
 * @param {object} options
 * @returns {GraphicsTierController}
 */
export function installGraphicsTierController(options) {
  return new GraphicsTierController(options).start();
}
