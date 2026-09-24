import { normalizePanelId, setPanelOpen } from './shared.js';
/**
 * Execute the set_panel_open voice tool.
 * @param {{ args: object, context: object }} request Tool arguments and the runner context.
 * @returns {Promise<object>}
 */
export async function execute({ args, context }) {
  const name = 'set_panel_open';
  const { styleManager } = context;
  if (name === 'set_panel_open') {
    const panelId = normalizePanelId(args.panelId || args.panel);
    if (!panelId)
      throw new Error(
        `Unknown panel: ${args.panelId || args.panel || 'missing'}`,
      );
    const open = args.open !== false;
    setPanelOpen(styleManager, panelId, open);
    return { ok: true, action: 'set_panel_open', panelId, open };
  }
}

/** Voice tool handler for set_panel_open. */
export const action = {
  name: 'set_panel_open',
  execute,
};
