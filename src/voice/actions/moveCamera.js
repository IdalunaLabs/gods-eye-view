import { moveCamera } from '../../cameraVerbs.js';
import { runManagedVoiceNavigation } from './shared.js';
/**
 * Execute the move_camera voice tool.
 * @param {{ args: object, context: object }} request Tool arguments and the runner context.
 * @returns {Promise<object>}
 */
export async function execute({ args, context }) {
  const name = 'move_camera';
  const { styleManager } = context;
    if (name === 'move_camera') {
      return moveCamera(args, (navigate, releaseOptions) =>
        runManagedVoiceNavigation(
          styleManager,
          'camera',
          'move_camera',
          navigate,
          releaseOptions,
        ),
      );
    }
}

/** Voice tool handler for move_camera. */
export const action = {
  name: 'move_camera',
  execute,
};
