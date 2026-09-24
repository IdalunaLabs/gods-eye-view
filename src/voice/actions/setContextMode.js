import {
  withContextModeVocabulary,
  setPanelOpen,
  normalizeContextMode,
  activeContactsWindow,
} from './shared.js';
/**
 * Execute the set_context_mode voice tool.
 * @param {{ args: object, context: object }} request Tool arguments and the runner context.
 * @returns {Promise<object>}
 */
export async function execute({ args, context }) {
  const name = 'set_context_mode';
  const { styleManager, dataManager, runOptions } = context;
  const current = context.current;
  if (name === 'set_context_mode') {
    if (!styleManager?.setContextMode) {
      return {
        ok: false,
        action: 'set_context_mode',
        error: 'Context mode control unavailable',
      };
    }
    const mode = normalizeContextMode(args.mode || args.contextMode);
    if (
      mode === null &&
      args.mode != null &&
      String(args.mode || '').trim() !== 'off'
    ) {
      return {
        ok: false,
        action: 'set_context_mode',
        error: `Unknown context mode: ${args.mode || 'missing'}`,
      };
    }
    const cancellationState = () =>
      withContextModeVocabulary(
        typeof styleManager.getContextModeState === 'function'
          ? styleManager.getContextModeState()
          : {},
      );
    if (!current()) {
      return {
        ok: false,
        action: 'set_context_mode',
        cancelled: true,
        error: 'Context request was cancelled before it could run',
        ...cancellationState(),
      };
    }
    if (mode && mode !== 'off') {
      setPanelOpen(styleManager, 'global-context-panel', true);
    }
    const result = await styleManager.setContextMode(
      mode === 'off' ? null : mode,
      {
        signal: runOptions.signal,
        isCurrent: runOptions.isCurrent,
      },
    );
    if (!current() && result?.ok !== true) {
      return {
        ...withContextModeVocabulary(result),
        ok: false,
        action: 'set_context_mode',
        cancelled: true,
        error:
          result?.error || 'Context request was cancelled before it completed',
        ...cancellationState(),
      };
    }
    const contactsWindow = ['contacts', 'flights'].includes(mode)
      ? activeContactsWindow(dataManager)
      : null;
    return {
      ...withContextModeVocabulary(result),
      ...(contactsWindow ? { contactsWindow } : {}),
    };
  }
}

/** Voice tool handler for set_context_mode. */
export const action = {
  name: 'set_context_mode',
  execute,
};
