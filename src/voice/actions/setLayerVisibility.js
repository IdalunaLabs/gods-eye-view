import { readLayerLifecycleSummary } from '../layerSummary.js';
import { normalizeLayerId } from './shared.js';
/**
 * Execute the set_layer_visibility voice tool.
 * @param {{ args: object, context: object }} request Tool arguments and the runner context.
 * @returns {Promise<object>}
 */
export async function execute({ args, context }) {
  const name = 'set_layer_visibility';
  const { styleManager, dataManager, runOptions } = context;
  const _layerEnabledAt = context.layerEnabledAt;
  const current = context.current;
    if (name === 'set_layer_visibility') {
      const layerId = normalizeLayerId(args.layerId);
      if (!layerId) {
        throw new Error(`Unknown data layer: ${args.layerId || 'missing'}`);
      }
      if (!dataManager.layers.has(layerId)) {
        if (layerId === 'radio') {
          return {
            ok: false,
            action: 'set_layer_visibility',
            layerId,
            error: 'Radio layer unavailable',
            ...readLayerLifecycleSummary(dataManager, layerId),
          };
        }
        throw new Error(`Unknown data layer: ${args.layerId || 'missing'}`);
      }
      const enabled = Boolean(args.enabled);
      const changeOptions = { origin: 'voice' };
      if (runOptions.signal) changeOptions.signal = runOptions.signal;
      let changed = false;
      let changeError = null;
      let intentOutcome = null;
      try {
        if (typeof dataManager._setEnabledWithIntent === 'function') {
          const intent = dataManager._setEnabledWithIntent(
            layerId,
            enabled,
            changeOptions,
          );
          changed = await intent.promise;
          if (Number.isInteger(intent.intentEpoch)) {
            intentOutcome = await dataManager._waitForVisibilityIntent?.(
              layerId,
              intent.intentEpoch,
            );
          }
        } else {
          changed = await dataManager.setEnabled(
            layerId,
            enabled,
            changeOptions,
          );
        }
        if (layerId === 'rocket-launches' || layerId === 'satellites') {
          await styleManager?._waitForContextLayerSettlement?.();
        }
      } catch (error) {
        changeError = error;
      }
      const lifecycleSummary = readLayerLifecycleSummary(dataManager, layerId);
      if (
        intentOutcome?.succeeded === false &&
        intentOutcome.cancellationReason
      ) {
        return {
          ok: false,
          action: 'set_layer_visibility',
          layerId,
          cancelled: true,
          phase: intentOutcome.phase,
          cancellationReason: intentOutcome.cancellationReason,
          successorIntentEpoch: intentOutcome.successorIntentEpoch,
          successorEnabled: intentOutcome.successorEnabled,
          successorOrigin: intentOutcome.successorOrigin,
          ...lifecycleSummary,
        };
      }
      const intentCommitted = intentOutcome?.succeeded === true;
      const current =
        !runOptions.signal?.aborted &&
        (typeof runOptions.isCurrent !== 'function' || runOptions.isCurrent());
      if (!current && !intentCommitted) {
        return {
          ok: false,
          action: 'set_layer_visibility',
          layerId,
          cancelled: true,
          error: 'Layer request was superseded by a newer voice turn',
          ...lifecycleSummary,
        };
      }
      const settledEnabled = lifecycleSummary.enabled;
      const lifecycleSettled =
        lifecycleSummary.lifecycleState ===
          (enabled ? 'enabled' : 'disabled') &&
        !lifecycleSummary.lifecycleUncertain;
      if (changeError) {
        return {
          ok: false,
          action: 'set_layer_visibility',
          layerId,
          error:
            changeError?.message ||
            `Could not ${enabled ? 'enable' : 'disable'} the requested layer`,
          ...lifecycleSummary,
        };
      }
      if (
        changed === false ||
        settledEnabled !== enabled ||
        !lifecycleSettled
      ) {
        return {
          ok: false,
          action: 'set_layer_visibility',
          layerId,
          error: `Could not ${enabled ? 'enable' : 'disable'} the requested layer`,
          ...lifecycleSummary,
        };
      }
      if (enabled) _layerEnabledAt.set(layerId, Date.now());
      const layer = dataManager.getAll().find((item) => item.id === layerId);
      return {
        ok: true,
        action: 'set_layer_visibility',
        layerId,
        label: layer?.name || layerId,
        ...lifecycleSummary,
      };
    }
}

/** Voice tool handler for set_layer_visibility. */
export const action = {
  name: 'set_layer_visibility',
  execute,
};
