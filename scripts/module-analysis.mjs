import { parsers } from 'prettier/plugins/babel.mjs';

const browserGlobals = new Set([
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLCanvasElement',
  'Image',
  'Audio',
  'localStorage',
  'sessionStorage',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'getComputedStyle',
]);

/** Inspect literal module dependencies and browser-platform references without executing code. */
export function analyzeModule(source) {
  const imports = [];
  const browser = new Set();
  function walk(node, parent, field) {
    if (!node || typeof node !== 'object') return;
    if (
      [
        'ImportDeclaration',
        'ExportNamedDeclaration',
        'ExportAllDeclaration',
        'ImportExpression',
      ].includes(node.type) &&
      node.source
    ) {
      if (node.source.type !== 'StringLiteral')
        throw new Error(
          'Computed module imports are not allowed in runtime code',
        );
      imports.push(node.source.value);
    }
    if (node.type === 'CallExpression' && node.callee?.name === 'require')
      throw new Error('Runtime modules must use ES imports');
    if (isWorkerConstruction(node)) imports.push(workerModuleSpecifier(node));
    if (node.type === 'Identifier' && browserGlobals.has(node.name)) {
      const property =
        (parent?.type === 'MemberExpression' ||
          parent?.type === 'OptionalMemberExpression') &&
        field === 'property' &&
        !parent.computed;
      const key =
        ['ObjectProperty', 'ObjectMethod', 'ClassMethod'].includes(
          parent?.type,
        ) &&
        field === 'key' &&
        !parent.computed;
      const declaration =
        field === 'id' ||
        field === 'params' ||
        parent?.type?.startsWith('Import');
      if (!property && !key && !declaration) browser.add(node.name);
    }
    if (
      ['MemberExpression', 'OptionalMemberExpression'].includes(node.type) &&
      ['globalThis', 'self'].includes(node.object?.name)
    ) {
      const name = node.computed ? node.property?.value : node.property?.name;
      if (browserGlobals.has(name)) browser.add(name);
    }
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'comments', 'tokens', 'extra'].includes(key)) continue;
      if (Array.isArray(value))
        value.forEach((child) => walk(child, node, key));
      else if (value && typeof value === 'object') walk(value, node, key);
    }
  }
  walk(parsers.babel.parse(source));
  return { imports, browser: [...browser] };
}

/** True for `new Worker(...)` and `new SharedWorker(...)`. */
function isWorkerConstruction(node) {
  return (
    node?.type === 'NewExpression' &&
    node.callee?.type === 'Identifier' &&
    (node.callee.name === 'Worker' || node.callee.name === 'SharedWorker')
  );
}

/** True for the `import.meta.url` base used by Vite's module-worker pattern. */
function isImportMetaUrl(node) {
  return (
    node?.type === 'MemberExpression' &&
    !node.computed &&
    node.property?.type === 'Identifier' &&
    node.property.name === 'url' &&
    node.object?.type === 'MetaProperty' &&
    node.object.meta?.name === 'import' &&
    node.object.property?.name === 'meta'
  );
}

/**
 * Resolve a literal `new Worker(new URL('./file.js', import.meta.url))` edge.
 * Computed URLs are rejected the same way as computed `import()`.
 * @param {object} node
 * @returns {string}
 */
function workerModuleSpecifier(node) {
  const target = node.arguments?.[0];
  if (
    target?.type !== 'NewExpression' ||
    target.callee?.type !== 'Identifier' ||
    target.callee.name !== 'URL' ||
    !isImportMetaUrl(target.arguments?.[1])
  ) {
    throw new Error(
      'Worker construction must use a literal new URL(..., import.meta.url)',
    );
  }
  const specifier = target.arguments?.[0];
  if (specifier?.type !== 'StringLiteral') {
    throw new Error('Computed module imports are not allowed in runtime code');
  }
  return specifier.value;
}

/** Return static imports, literal dynamic imports and re-exports. */
export function moduleImports(source) {
  return analyzeModule(source).imports;
}
