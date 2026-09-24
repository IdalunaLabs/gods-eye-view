const KIND_ICON = Object.freeze({
  convergence: '⋈',
  loiter: '↻',
  'dark-period': '◌',
  'hotspot-proximity': '☀',
});

const DETECTOR_TOGGLES = Object.freeze([
  ['convergence', 'CONVERGENCE'],
  ['darkPeriod', 'DARK PERIOD'],
  ['loiter', 'LOITER'],
  ['hotspot', 'HOTSPOT'],
]);

/**
 * Escape text that is interpolated into the alerts list.
 * @param {unknown} value
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>'"]/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char],
  );
}

/**
 * @param {number} ageMs
 * @returns {string}
 */
function formatAge(ageMs) {
  const seconds = Math.max(0, Math.round(ageMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

function alertIdFrom(target) {
  const row = target?.closest?.('[data-alert-id]');
  if (!row) return '';
  return row.getAttribute?.('data-alert-id') || row.dataset?.alertId || '';
}

function detectorFrom(target) {
  const button = target?.closest?.('[data-detector]');
  if (!button) return '';
  return button.getAttribute?.('data-detector') || button.dataset?.detector || '';
}

/**
 * Right-rail alerts list. The controller paints rows and forwards focus and
 * detector toggles; it does not read layers or run detectors.
 * @param {object} options
 * @param {HTMLElement|null} options.root Panel element, or null when markup is absent.
 * @param {Function} [options.onFocus] Called with the clicked alert.
 * @param {Function} [options.readFlags]
 * @param {Function} [options.writeFlag]
 * @param {Function} [options.now]
 * @returns {{render: Function, syncFlags: Function, destroy: Function}}
 */
export function createAlertsPanel({
  root = null,
  onFocus = () => {},
  readFlags = () => ({}),
  writeFlag = () => {},
  now = () => Date.now(),
} = {}) {
  const alertsById = new Map();
  if (!root) {
    return {
      render() {},
      syncFlags() {},
      destroy() {},
    };
  }
  const list =
    root.querySelector('#alerts-list') ||
    root.querySelector('[data-alerts-list]');
  const count =
    root.querySelector('#alerts-panel-count') ||
    root.querySelector('[data-alerts-count]');

  function syncFlags() {
    const flags = readFlags() || {};
    const buttons = root.querySelectorAll
      ? root.querySelectorAll('[data-detector]')
      : [];
    for (const button of buttons) {
      const name = detectorFrom(button) || button.dataset?.detector;
      const enabled = Boolean(flags[name]);
      button.setAttribute?.('aria-pressed', enabled ? 'true' : 'false');
    }
  }

  function render(alerts = []) {
    const rows = Array.isArray(alerts) ? alerts : [];
    alertsById.clear();
    for (const alert of rows) {
      if (alert?.id) alertsById.set(String(alert.id), alert);
    }
    const stamp = now();
    if (count) {
      count.hidden = false;
      count.textContent = String(rows.length);
      count.dataset.severity = rows.some((alert) => alert?.severity === 'warn')
        ? 'warn'
        : rows.some((alert) => alert?.severity === 'watch')
          ? 'watch'
          : 'info';
    }
    if (!list) return;
    if (!rows.length) {
      list.innerHTML =
        '<p class="alerts-empty">No active alerts. Convergence and dark-period checks run on a 5 s cadence; loiter and hotspot proximity stay off until enabled.</p>';
      return;
    }
    list.innerHTML = rows
      .map((alert) => {
        const age = formatAge(
          stamp - (Number(alert.lastSeenMs) || Number(alert.firstSeenMs) || stamp),
        );
        const entities = (alert.entities || [])
          .map((entity) => escapeHtml(entity.label || entity.id))
          .join(' · ');
        const icon = KIND_ICON[alert.kind] || '•';
        return `<button type="button" class="alerts-row" data-alert-id="${escapeHtml(alert.id)}" data-severity="${escapeHtml(alert.severity || 'info')}">
          <span class="alerts-kind" aria-hidden="true">${icon}</span>
          <span class="alerts-row-body">
            <strong>${escapeHtml(alert.kind)} · ${escapeHtml(alert.severity)}</strong>
            <span>${entities}</span>
            <small>${escapeHtml(alert.explanation)}</small>
          </span>
          <span class="alerts-age">${age}</span>
        </button>`;
      })
      .join('');
  }

  function onClick(event) {
    const detector = detectorFrom(event.target);
    if (detector && DETECTOR_TOGGLES.some(([name]) => name === detector)) {
      event.preventDefault?.();
      const flags = readFlags() || {};
      writeFlag(detector, !flags[detector]);
      syncFlags();
      return;
    }
    const id = alertIdFrom(event.target);
    if (!id || !alertsById.has(id)) return;
    event.preventDefault?.();
    onFocus(alertsById.get(id));
  }

  root.addEventListener('click', onClick);
  syncFlags();
  return {
    render,
    syncFlags,
    destroy() {
      root.removeEventListener?.('click', onClick);
      alertsById.clear();
    },
  };
}

export { DETECTOR_TOGGLES, KIND_ICON };
