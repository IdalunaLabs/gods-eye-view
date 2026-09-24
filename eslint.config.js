import js from '@eslint/js';
import globals from 'globals';

/**
 * Conservative ESLint 10 flat config.
 * Runtime browser modules use browser globals; Node entrypoints and tests use
 * Node globals. Off-limits trees owned by parallel work are ignored until they
 * can be lint-clean without colliding with those edits (see CONTRIBUTING.md).
 */
const conservativeRules = {
  'no-unused-vars': [
    'error',
    {
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      caughtErrorsIgnorePattern: '^_',
    },
  ],
  'no-undef': 'error',
  // `== null` / `!= null` is the codebase's null-or-undefined test. Forcing
  // `=== null` would treat undefined as present.
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'no-var': 'error',
  'prefer-const': 'error',
  'no-implicit-globals': 'error',
  // ESLint 10 added these to recommended. Keep the previous gate until they
  // are adopted; server still reports the recommended set as warnings.
  'no-useless-assignment': 'off',
  'preserve-caught-error': 'off',
};

const recommendedWarn = Object.fromEntries(
  Object.entries(js.configs.recommended.rules).map(([rule, setting]) => [
    rule,
    setting === 'off' ? 'off' : 'warn',
  ]),
);

export default [
  {
    linterOptions: {
      // Existing disables target rules this config does not enable.
      reportUnusedDisableDirectives: 'off',
    },
  },
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'coverage/**',
      'output/**',
      'screenshots/**',
      'qa-shots/**',
      '3d-models/**',
      'src/data/local_data/**',
      '**/*.min.js',
      // Outside the adopted runtime roots (scripts/format-runtime.json) and
      // the explicit format scope. Follow-up: lint tools/ and pinokio/.
      'tools/**',
      'pinokio/**',
      // Parallel agents own these files. They are excluded rather than edited.
      // Follow-up: remove each ignore once that owner lands lint-clean code.
      'src/voice/gevActions.js',
      'src/data/bhoteKoshiEvent.js',
      'src/overlays/**',
      'src/layers/satellites/**',
      'src/data/satellites.js',
      'src/sharelink.js',
      'src/standalone/catalog.js',
      'build/**',
      // server/ is warn-only below, not ignored.
    ],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.{js,mjs,cjs}'],
    ignores: ['src/**/*.test.mjs'],
    languageOptions: {
      ecmaVersion: 2025,
      sourceType: 'module',
      globals: globals.browser,
    },
    rules: conservativeRules,
  },
  {
    files: ['server/**/*.{js,mjs,cjs}', 'vite.config.js'],
    languageOptions: {
      ecmaVersion: 2025,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: conservativeRules,
  },
  {
    // QA scripts and unit tests are Node programs, but many name browser
    // globals inside functions that Puppeteer evaluates in the page. Both
    // environments are real for no-undef; Node still covers process/Buffer.
    files: ['scripts/**/*.{js,mjs,cjs}', '**/*.test.mjs'],
    languageOptions: {
      ecmaVersion: 2025,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: conservativeRules,
  },
  {
    // Server sources are owned by another workstream. Report problems without
    // failing the gate; do not edit those files from this branch.
    files: ['server/**/*.{js,mjs,cjs}'],
    rules: {
      ...recommendedWarn,
      'no-unused-vars': 'warn',
      'no-undef': 'warn',
      eqeqeq: 'warn',
      'no-var': 'warn',
      'prefer-const': 'warn',
      'no-implicit-globals': 'warn',
    },
  },
];
