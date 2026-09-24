import { normalizeStyle } from './shared.js';
/**
 * Execute the set_visual_style voice tool.
 * @param {{ args: object, context: object }} request Tool arguments and the runner context.
 * @returns {Promise<object>}
 */
export async function execute({ args, context }) {
  const name = 'set_visual_style';
  const { styleManager } = context;
    if (name === 'set_visual_style') {
      const style = normalizeStyle(args.style);
      if (!style)
        throw new Error(`Unknown visual style: ${args.style || 'missing'}`);
      styleManager.setStyle(style);
      return { ok: true, action: 'set_visual_style', style };
    }
}

/** Voice tool handler for set_visual_style. */
export const action = {
  name: 'set_visual_style',
  execute,
};
