import { flyRoute } from '../../cameraVerbs.js';
import { runManagedVoiceNavigation } from './shared.js';
/**
 * Execute the fly_route voice tool.
 * @param {{ args: object, context: object }} request Tool arguments and the runner context.
 * @returns {Promise<object>}
 */
export async function execute({ args, context }) {
  const name = 'fly_route';
  const { styleManager, annotations, floorServices } = context;
    if (name === 'fly_route') {
      return flyRoute(
        annotations?.list?.() || [],
        args,
        (lat, lon) => floorServices.cachedGroundFloor(lat, lon),
        (navigate) =>
          runManagedVoiceNavigation(
            styleManager,
            'route',
            'fly_route',
            navigate,
          ),
        (cells) => floorServices.warmGroundFloor(cells),
      );
    }
}

/** Voice tool handler for fly_route. */
export const action = {
  name: 'fly_route',
  execute,
};
