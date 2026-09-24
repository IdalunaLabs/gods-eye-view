/**
 * Execute the set_hud voice tool.
 * @param {{ args: object, context: object }} request Tool arguments and the runner context.
 * @returns {Promise<object>}
 */
export async function execute({ args, context }) {
  const name = 'set_hud';
  const { styleManager } = context;
  if (name === 'set_hud') {
    const out = { ok: true, action: 'set_hud' };
    if (args.layout != null) {
      const result = styleManager.setHudLayout(args.layout);
      if (!result.ok) return { ...result, action: 'set_hud' };
      Object.assign(out, result);
    }
    if (args.visible != null) {
      const result = styleManager.setHudVisible(args.visible);
      if (!result.ok) return { ...result, action: 'set_hud' };
      Object.assign(out, result);
    }
    return { ...out, hud: styleManager.getControlState().hud };
  }
}

/** Voice tool handler for set_hud. */
export const action = {
  name: 'set_hud',
  execute,
};
