import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createFusionEngine,
  FUSION_DETECTOR_STORAGE_KEY,
} from '../fusion/fusionEngine.js';
import { createAlertsPanel } from './alertsPanel.js';

function memoryStorage() {
  const values = new Map();
  return {
    values,
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
  };
}

function element(id) {
  const node = {
    id,
    parent: null,
    children: [],
    hidden: false,
    textContent: '',
    innerHTML: '',
    dataset: {},
    attributes: {},
    listeners: {},
    setAttribute(name, value) {
      node.attributes[name] = String(value);
      if (name.startsWith('data-')) {
        const key = name
          .slice(5)
          .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
        node.dataset[key] = String(value);
      }
    },
    getAttribute(name) {
      return Object.hasOwn(node.attributes, name) ? node.attributes[name] : null;
    },
    addEventListener(type, fn) {
      node.listeners[type] = fn;
    },
    removeEventListener(type, fn) {
      if (node.listeners[type] === fn) delete node.listeners[type];
    },
    appendChild(child) {
      child.parent = node;
      node.children.push(child);
      return child;
    },
    querySelector(selector) {
      return walk(node, selector)[0] || null;
    },
    querySelectorAll(selector) {
      return walk(node, selector);
    },
    closest(selector) {
      let current = node;
      while (current) {
        if (matches(current, selector)) return current;
        current = current.parent;
      }
      return null;
    },
  };
  if (id) node.setAttribute('id', id);
  return node;
}

function matches(node, selector) {
  if (selector.startsWith('#')) return node.id === selector.slice(1);
  if (selector.startsWith('[') && selector.endsWith(']')) {
    const name = selector.slice(1, -1);
    return node.getAttribute(name) != null;
  }
  return false;
}

function walk(node, selector) {
  const found = [];
  if (matches(node, selector)) found.push(node);
  for (const child of node.children) found.push(...walk(child, selector));
  return found;
}

function panelRoot() {
  const root = element('alerts-panel');
  const list = element('alerts-list');
  const count = element('alerts-panel-count');
  root.appendChild(list);
  root.appendChild(count);
  for (const name of ['convergence', 'darkPeriod', 'loiter', 'hotspot']) {
    const button = element('');
    button.setAttribute('data-detector', name);
    button.setAttribute('aria-pressed', 'false');
    root.appendChild(button);
  }
  return root;
}

const SAMPLE = {
  id: 'c1',
  kind: 'convergence',
  severity: 'warn',
  entities: [
    { layer: 'flights', id: 'abc', label: 'UAL1' },
    { layer: 'ais-live-vessels', id: '1', label: 'SHIP' },
  ],
  position: { lat: 30, lon: -97 },
  explanation: 'Dead-reckoned from heading/speed; not a prediction of intent.',
  confidence: 0.7,
  firstSeenMs: 1_000,
  lastSeenMs: 1_000,
};

test('alerts panel renders newest rows and flies the clicked alert', () => {
  const root = panelRoot();
  const focused = [];
  const panel = createAlertsPanel({
    root,
    now: () => 61_000,
    onFocus: (alert) => focused.push(alert.id),
  });
  panel.render([SAMPLE]);
  const list = root.querySelector('#alerts-list');
  const count = root.querySelector('#alerts-panel-count');
  assert.match(list.innerHTML, /UAL1/);
  assert.match(list.innerHTML, /SHIP/);
  assert.match(list.innerHTML, /not a prediction of intent/);
  assert.match(list.innerHTML, /1m/);
  assert.equal(count.textContent, '1');
  assert.equal(count.dataset.severity, 'warn');
  const row = { dataset: { alertId: 'c1' }, attributes: { 'data-alert-id': 'c1' } };
  row.getAttribute = (name) => row.attributes[name] || null;
  row.closest = (selector) => (selector === '[data-alert-id]' ? row : null);
  root.listeners.click({
    target: row,
    preventDefault() {},
  });
  assert.deepEqual(focused, ['c1']);
  panel.destroy();
});

test('alerts panel detector toggles persist through the fusion engine', () => {
  const root = panelRoot();
  const storage = memoryStorage();
  const engine = createFusionEngine({
    getRecords: () => [],
    storage,
    detect: () => [],
    schedule() {
      return 1;
    },
    clearSchedule() {},
  });
  const panel = createAlertsPanel({
    root,
    readFlags: () => engine.getDetectorFlags(),
    writeFlag: (name, enabled) => engine.setDetectorEnabled(name, enabled),
  });
  const loiter = root.querySelectorAll('[data-detector]')[2];
  assert.equal(loiter.getAttribute('aria-pressed'), 'false');
  root.listeners.click({
    target: loiter,
    preventDefault() {},
  });
  assert.equal(loiter.getAttribute('aria-pressed'), 'true');
  const saved = JSON.parse(storage.values.get(FUSION_DETECTOR_STORAGE_KEY));
  assert.equal(saved.loiter, true);
  assert.equal(saved.convergence, true);
  panel.destroy();
});
