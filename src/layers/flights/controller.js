import * as Cesium from 'cesium';

export function createController({
  flightState,
  services: _services,
  parts: _parts,
  layer: _layer,
  resolveAsset: _resolveAsset,
}) {
  function _abortActiveUpdates() {
    for (const controller of flightState.feed._activeUpdateControllers)
      controller.abort();
    flightState.feed._activeUpdateControllers.clear();
  }

  function _flightQuery(viewer) {
    const cartographic = viewer?.camera?.positionCartographic;
    return cartographic
      ? {
          latitude: Cesium.Math.toDegrees(cartographic.latitude),
          longitude: Cesium.Math.toDegrees(cartographic.longitude),
        }
      : {};
  }
  return { _abortActiveUpdates, _flightQuery };
}
