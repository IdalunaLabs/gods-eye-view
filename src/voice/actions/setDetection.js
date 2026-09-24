/**
 * Execute the set_detection voice tool.
 * @param {{ args: object, context: object }} request Tool arguments and the runner context.
 * @returns {Promise<object>}
 */
export async function execute({ args, context }) {
  const name = 'set_detection';
  const { styleManager } = context;
  if (name === 'set_detection') {
    const result = styleManager.setDetection({
      enabled: typeof args.enabled === 'boolean' ? args.enabled : undefined,
      mode: typeof args.mode === 'string' ? args.mode : undefined,
      densityPct: Number.isFinite(Number(args.densityPct))
        ? Number(args.densityPct)
        : undefined,
      allocationStrategy:
        typeof args.allocationStrategy === 'string'
          ? args.allocationStrategy
          : undefined,
    });
    return { action: 'set_detection', ...result };
  }
}

/** Voice tool handler for set_detection. */
export const action = {
  name: 'set_detection',
  execute,
};
