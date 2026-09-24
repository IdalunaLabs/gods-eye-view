import { normalizeStackId } from './shared.js';
/**
 * Execute the set_map_stack voice tool.
 * @param {{ args: object, context: object }} request Tool arguments and the runner context.
 * @returns {Promise<object>}
 */
export async function execute({ args, context }) {
  const name = 'set_map_stack';
  const { styleManager } = context;
  if (name === 'set_map_stack') {
    const stackId = normalizeStackId(args.stack);
    if (!stackId)
      throw new Error(`Unknown map stack: ${args.stack || 'missing'}`);
    const result = await styleManager.setMapStack(stackId);
    return { action: 'set_map_stack', requested: stackId, ...result };
  }
}

/** Voice tool handler for set_map_stack. */
export const action = {
  name: 'set_map_stack',
  execute,
};
