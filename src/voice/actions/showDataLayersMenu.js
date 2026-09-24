import {
  normalizeLayerId,
  setPanelOpen,
} from './shared.js';
function focusDataLayerRow(layerId) {
  const row = document.querySelector(
    `#data-toggles [data-layer-id="${CSS.escape(layerId)}"]`,
  );
  if (!row) return null;
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  row.classList.remove('gev-voice-focus');
  void row.offsetWidth;
  row.classList.add('gev-voice-focus');
  window.setTimeout(() => row.classList.remove('gev-voice-focus'), 3000);
  const name = row.querySelector('.data-name')?.textContent?.trim() || layerId;
  return { id: layerId, name };
}
/**
 * Execute the show_data_layers_menu voice tool.
 * @param {{ args: object, context: object }} request Tool arguments and the runner context.
 * @returns {Promise<object>}
 */
export async function execute({ args, context }) {
  const name = 'show_data_layers_menu';
  const { styleManager, dataManager } = context;
    if (name === 'show_data_layers_menu') {
      const layerId = normalizeLayerId(args.layerId || args.layer);
      setPanelOpen(styleManager, 'data-panel', true);
      const focusedLayer =
        layerId && dataManager.layers.has(layerId)
          ? focusDataLayerRow(layerId)
          : null;
      return {
        ok: true,
        action: 'show_data_layers_menu',
        panelId: 'data-panel',
        focusedLayer,
        layers: dataManager
          .getAll()
          .filter((layer) => layer.showInTogglePanel !== false)
          .map((layer) => ({
            id: layer.id,
            name: layer.name,
            enabled: layer.enabled,
            count: layer.stats?.count || 0,
          })),
      };
    }
}

/** Voice tool handler for show_data_layers_menu. */
export const action = {
  name: 'show_data_layers_menu',
  execute,
};
