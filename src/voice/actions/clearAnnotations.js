function clearAnnotations(annotations) {
  if (!annotations || typeof annotations.clear !== 'function') {
    return {
      ok: false,
      action: 'clear_annotations',
      error: 'Annotation engine unavailable',
    };
  }
  annotations.clear();
  return { ok: true, action: 'clear_annotations' };
}
/**
 * Execute the clear_annotations voice tool.
 * @param {{ args: object, context: object }} request Tool arguments and the runner context.
 * @returns {Promise<object>}
 */
export async function execute({ args, context }) {
  const name = 'clear_annotations';
  const { annotations } = context;
  if (name === 'clear_annotations') {
    return clearAnnotations(annotations);
  }
}

/** Voice tool handler for clear_annotations. */
export const action = {
  name: 'clear_annotations',
  execute,
};
