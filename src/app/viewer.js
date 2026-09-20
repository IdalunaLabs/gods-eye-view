import * as Cesium from 'cesium';

/**
 * Park the globe, keep the tuned atmosphere, and drop FXAA. MSAA already
 * resolves edges; FXAA is a full-screen pass that fights the sharpen filter.
 * @param {Cesium.Viewer} viewer
 * @returns {Cesium.Viewer}
 */
export function configureApplicationViewer(viewer) {
  if (!viewer?.scene)
    throw new TypeError('configureApplicationViewer requires a Cesium viewer');
  viewer.targetFrameRate = 60;
  viewer.scene.globe.show = false;
  viewer.scene.skyAtmosphere.show = true;
  viewer.scene.skyAtmosphere.atmosphereLightIntensity = 18;
  viewer.scene.skyAtmosphere.saturationShift = -0.12;
  viewer.scene.skyAtmosphere.brightnessShift = -0.08;
  if (viewer.scene.postProcessStages?.fxaa)
    viewer.scene.postProcessStages.fxaa.enabled = false;
  return viewer;
}

/** Create the standard globe viewer in caller-owned, visible containers. */
export function createApplicationViewer({ container, creditContainer }) {
  if (!container || !creditContainer)
    throw new TypeError('Viewer and credit containers are required');
  const viewer = new Cesium.Viewer(container, {
    timeline: false,
    animation: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    vrButton: false,
    selectionIndicator: false,
    infoBox: false,
    baseLayer: false,
    creditContainer,
    msaaSamples: 4,
    // Capture happens inside scene.postRender (see realtimeViewport.js), so
    // the compositor can discard the back buffer after swap.
    contextOptions: { webgl: { preserveDrawingBuffer: false } },
  });
  try {
    return configureApplicationViewer(viewer);
  } catch (error) {
    viewer.destroy();
    throw error;
  }
}
