/**
 * Voice scene playback control. Playback is fire-and-forget: startScene
 * sequences shots for minutes and must not block the realtime tool loop.
 */
function controlScene(sceneDirector, args = {}) {
  if (!sceneDirector) {
    return {
      ok: false,
      action: 'control_scene',
      error: 'Scene director unavailable',
    };
  }
  const sceneAction = String(args.action || '').toLowerCase();

  if (sceneAction === 'list') {
    return {
      ok: true,
      action: 'control_scene',
      scenes: sceneDirector.listScenes(),
      ...sceneDirector.getPlaybackStatus(),
    };
  }
  if (sceneAction === 'status') {
    return {
      ok: true,
      action: 'control_scene',
      ...sceneDirector.getPlaybackStatus(),
    };
  }
  if (sceneAction === 'stop') {
    sceneDirector.stopScene('Stopped by voice');
    return { ok: true, action: 'control_scene', running: false };
  }
  if (sceneAction === 'next') {
    sceneDirector.runNextScene();
    return { ok: true, action: 'control_scene', advanced: true };
  }
  if (sceneAction === 'play') {
    if (sceneDirector.running) {
      return {
        ok: false,
        action: 'control_scene',
        error: 'A scene is already running — stop it first',
      };
    }
    const scene = args.sceneId
      ? sceneDirector.findSceneByQuery(args.sceneId)
      : sceneDirector.listScenes()[0] || null;
    if (!scene) {
      return {
        ok: false,
        action: 'control_scene',
        error: `No scene matched "${args.sceneId || ''}"`,
        scenes: sceneDirector.listScenes(),
      };
    }
    void sceneDirector.startScene(scene.id, { single: true });
    return {
      ok: true,
      action: 'control_scene',
      playing: scene.title,
      shots: scene.shots,
    };
  }
  throw new Error(`Unknown scene action: ${args.action || 'missing'}`);
}
/**
 * Execute the control_scene voice tool.
 * @param {{ args: object, context: object }} request Tool arguments and the runner context.
 * @returns {Promise<object>}
 */
export async function execute({ args, context }) {
  const name = 'control_scene';
  const { sceneDirector } = context;
    if (name === 'control_scene') {
      return controlScene(sceneDirector, args);
    }
}

/** Voice tool handler for control_scene. */
export const action = {
  name: 'control_scene',
  execute,
};
