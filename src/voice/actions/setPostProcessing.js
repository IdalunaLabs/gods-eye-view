/**
 * Execute the set_post_processing voice tool.
 * @param {{ args: object, context: object }} request Tool arguments and the runner context.
 * @returns {Promise<object>}
 */
export async function execute({ args, context }) {
  const name = 'set_post_processing';
  const { styleManager } = context;
  if (name === 'set_post_processing') {
    const out = { ok: true, action: 'set_post_processing' };
    if (args.bloom && typeof args.bloom === 'object') {
      Object.assign(
        out,
        styleManager.setBloom({
          enabled:
            typeof args.bloom.enabled === 'boolean'
              ? args.bloom.enabled
              : undefined,
          intensityPct: Number.isFinite(Number(args.bloom.intensityPct))
            ? Number(args.bloom.intensityPct)
            : undefined,
        }),
      );
    }
    if (args.sharpen && typeof args.sharpen === 'object') {
      Object.assign(
        out,
        styleManager.setSharpen({
          enabled:
            typeof args.sharpen.enabled === 'boolean'
              ? args.sharpen.enabled
              : undefined,
          intensityPct: Number.isFinite(Number(args.sharpen.intensityPct))
            ? Number(args.sharpen.intensityPct)
            : undefined,
        }),
      );
    }
    return out;
  }
}

/** Voice tool handler for set_post_processing. */
export const action = {
  name: 'set_post_processing',
  execute,
};
