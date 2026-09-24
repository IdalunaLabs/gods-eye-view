export function createIngestion({
  state: _layerState,
  services: _services,
  parts,
  source: _source,
}) {
  const methods = {
    update() {
      parts.subject.refreshSelectedSubject();
      return Promise.resolve();
    },
  };

  return { methods };
}
