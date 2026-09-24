import { stopAllTracking } from './shared.js';
/**
 * Execute the stop_tracking voice tool.
 * @param {{ args: object, context: object }} request Tool arguments and the runner context.
 * @returns {Promise<object>}
 */
export async function execute({ args, context }) {
  const name = 'stop_tracking';
  const { viewer, dataManager } = context;
  if (name === 'stop_tracking') {
    return stopAllTracking(viewer, dataManager);
  }
}

/** Voice tool handler for stop_tracking. */
export const action = {
  name: 'stop_tracking',
  execute,
};
