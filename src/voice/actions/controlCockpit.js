import { getSelectedEntityContext } from '../../data/contextStore.js';
import { TR3B_CLASS } from '../../data/tr3bRegistry.js';
import {
  withContextModeVocabulary,
  normalizeLayerId,
} from './shared.js';
const COCKPIT_ACTION_ALIASES = new Map([
  ['next', 'next'],
  ['previous', 'previous'],
  ['prev', 'previous'],
  ['enter', 'enter'],
  ['exit', 'exit'],
  ['status', 'status'],
  ['state', 'status'],
  ['next military', 'next'],
  ['next military aircraft', 'next'],
  ['next helicopter', 'next'],
  ['next closest', 'next'],
  ['next closest helicopter', 'next'],
  ['next closest military', 'next'],
  ['go to next', 'next'],
]);
const COCKPIT_TARGET_LAYERS = new Set([
  'flights',
  'military',
  'ais-live-vessels',
  'military-installations',
]);
function selectedCockpitTarget(dataManager) {
  const selected = getSelectedEntityContext({ dataManager });
  if (!selected || !['flights', 'military'].includes(selected.layerId))
    return null;
  const module = dataManager?.layers?.get(selected.layerId)?.module;
  if (!module?.trackById || typeof module.trackById !== 'function') return null;
  const id = String(selected.id || '').trim();
  return id ? { layerId: selected.layerId, id } : null;
}

function normalizeCockpitTargetLayer(value) {
  const layerId = normalizeLayerId(value);
  if (!layerId || !COCKPIT_TARGET_LAYERS.has(layerId)) return null;
  return layerId;
}

function normalizeCockpitNavigationHints(rawAction) {
  const raw = String(rawAction || '')
    .trim()
    .toLowerCase();
  if (!raw) return {};

  const targetLayer =
    raw.includes('vessel') || raw.includes('ship') || raw.includes('ais')
      ? 'ais-live-vessels'
      : raw.includes('installation') ||
          raw.includes('facility') ||
          raw.includes('base')
        ? 'military-installations'
        : raw.includes('military')
          ? 'military'
          : null;

  const aircraftClass =
    raw.includes('helicopter') ||
    raw.includes('helo') ||
    raw.includes('chopper')
      ? 'helicopter'
      : null;

  return {
    targetLayer,
    aircraftClass,
  };
}

/**
 * Normalize a spoken/typed aircraft-class filter to the class id the analyst
 * records carry.
 *
 * Every real `classifyAircraft()` id is a single unpunctuated word, so callers
 * already say them exactly and a plain lower-case is enough. The one exception
 * is the TR-3B Easter egg (`tr3b`): people write and say it hyphenated, so
 * "TR-3B" / "tr 3b" / "tr 3 b" would otherwise reach the analyst as a value no
 * record matches. Collapsing spaces and hyphens and comparing against THAT ONE
 * id keeps this surgical — no general alias table, and no other class id
 * collapses to `tr3b`, so nothing else can be caught by it.
 *
 * App-side only: the voice tool schema and the model instructions are
 * untouched, so this costs no prompt-cache churn.
 * @param {*} value Raw class filter from the tool call or an utterance hint.
 * @returns {string|null} Class id, or null when nothing was supplied.
 */
function normalizeAircraftClassFilter(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase();
  if (!raw) return null;
  return raw.replace(/[\s-]+/g, '') === TR3B_CLASS ? TR3B_CLASS : raw;
}

function normalizeCockpitAction(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase();
  if (!raw) return null;

  const direct = COCKPIT_ACTION_ALIASES.get(raw);
  if (direct) return direct;

  const normalized = raw
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  const directNormalized = COCKPIT_ACTION_ALIASES.get(normalized);
  if (directNormalized) return directNormalized;

  if (/\bprevious\b|\bprev\b/.test(normalized)) return 'previous';
  if (/\bstatus\b|\bstate\b/.test(normalized)) return 'status';
  if (/\bexit\b|\bleave\b|\bquit\b/.test(normalized)) return 'exit';
  if (/\benter\b|\bopen\b|\bstart\b/.test(normalized)) return 'enter';
  if (/\bnext\b|\bclosest\b|\bnearby\b|\bnearest\b/.test(normalized))
    return 'next';

  return null;
}
/**
 * Execute the control_cockpit voice tool.
 * @param {{ args: object, context: object }} request Tool arguments and the runner context.
 * @returns {Promise<object>}
 */
export async function execute({ args, context }) {
  const name = 'control_cockpit';
  const { styleManager, dataManager, runOptions } = context;
  const current = context.current;
    if (name === 'control_cockpit') {
      if (!styleManager?.controlCockpit) {
        return {
          ok: false,
          action: 'control_cockpit',
          error: 'Cockpit control unavailable',
        };
      }
      const rawAction = args.action || args.command;
      const action = normalizeCockpitAction(rawAction);
      const notificationToken = args.notificationToken || null;
      if (!action) {
        return {
          ok: false,
          action: 'control_cockpit',
          error: `Unknown cockpit action: ${args.action || args.command || 'missing'}`,
        };
      }
      const inferred = normalizeCockpitNavigationHints(rawAction);
      const targetLayer = normalizeCockpitTargetLayer(
        args.targetLayer || inferred.targetLayer || args.layer || args.layerId,
      );
      const aircraftClass = normalizeAircraftClassFilter(
        args.aircraftClass ||
          inferred.aircraftClass ||
          args.type ||
          args.filterType,
      );
      let contextChangedForEntry = false;
      let priorContextMode = null;
      let rollbackTarget = null;
      if (
        action === 'enter' &&
        typeof styleManager.setContextMode === 'function'
      ) {
        if (!current()) {
          return {
            ok: false,
            action: 'control_cockpit',
            cancelled: true,
            error: 'Cockpit entry was cancelled before it could run',
            state: styleManager.getCockpitState?.() || null,
          };
        }
        rollbackTarget = styleManager.getAircraftTrackingTarget?.() || null;
        const contextState =
          typeof styleManager.getContextModeState === 'function'
            ? styleManager.getContextModeState()
            : {};
        priorContextMode = contextState?.mode || null;
        const contactsReady =
          contextState?.mode === 'flights' &&
          contextState?.active !== false &&
          contextState?.changing !== true;
        if (!contactsReady) {
          const contextResult = await styleManager.setContextMode('flights', {
            signal: runOptions.signal,
            isCurrent: runOptions.isCurrent,
            // Cockpit entry establishes Contacts as its own precondition. That
            // is internal choreography, not an operator Context request, so it
            // must stay inert: claiming here would cancel a pending shared
            // style/detection restore the operator never overrode.
            claimVisualAuthority: false,
          });
          contextChangedForEntry = contextResult?.ok === true;
          if (contextResult?.ok !== true || !current()) {
            const contextRollback = contextChangedForEntry
              ? await styleManager.setContextMode(priorContextMode, {
                  claimVisualAuthority: false,
                })
              : null;
            return {
              ok: false,
              action: 'control_cockpit',
              cancelled: !current() || Boolean(contextResult?.cancelled),
              error:
                contextResult?.error ||
                'Contacts context could not be established for Cockpit entry',
              context: contextResult
                ? withContextModeVocabulary(contextResult)
                : null,
              contextRollback: withContextModeVocabulary(contextRollback),
              state: styleManager.getCockpitState?.() || null,
            };
          }
        }
      }
      // Contacts activation can adopt a newer explicit aircraft selection.
      // Sample only after that transaction settles so an older voice snapshot
      // cannot overwrite the operator's newer choice.
      const selectedTarget =
        action === 'enter' ? selectedCockpitTarget(dataManager) : null;
      let cockpitResult;
      try {
        cockpitResult = await styleManager.controlCockpit(action, {
          notificationToken,
          targetLayer,
          aircraftClass,
          selectedTarget,
          rollbackTarget,
        });
      } catch (error) {
        cockpitResult = {
          ok: false,
          action: 'control_cockpit',
          error: error instanceof Error ? error.message : String(error),
          state: styleManager.getCockpitState?.() || null,
        };
      }
      if (
        action === 'enter' &&
        cockpitResult?.ok !== true &&
        contextChangedForEntry
      ) {
        const contextRollback = await styleManager.setContextMode(
          priorContextMode,
          {
            // Undoing this action's own precondition — still choreography.
            claimVisualAuthority: false,
            ...(current()
              ? {
                  signal: runOptions.signal,
                  isCurrent: runOptions.isCurrent,
                }
              : {}),
          },
        );
        return {
          ...cockpitResult,
          contextRollback: withContextModeVocabulary(contextRollback),
        };
      }
      return cockpitResult;
    }
}

/** Voice tool handler for control_cockpit. */
export const action = {
  name: 'control_cockpit',
  execute,
};
