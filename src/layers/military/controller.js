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
  return { _abortActiveUpdates };
}
