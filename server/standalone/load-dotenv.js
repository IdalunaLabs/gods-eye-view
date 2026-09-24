import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';

/**
 * Vite mode used to choose dotenv files. An already-set NODE_ENV wins.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function dotenvMode(env = process.env) {
  const mode = String(env.NODE_ENV || '').trim();
  if (!mode || mode === 'local') return 'development';
  return mode;
}

/**
 * Dotenv files in Vite's load order. Later files override earlier ones.
 * @param {string} mode
 */
export function dotenvFileNames(mode) {
  return ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`];
}

/** Parse one dotenv document without executing it. */
export function parseDotenvText(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  return parseEnv(source);
}

function resolveEscapeSequences(value) {
  return value.replace(/\\\$/g, '$');
}

/**
 * Expand `$VAR` and `${VAR}` the way Vite's dotenv-expand pass does.
 * Missing names become empty. Single-quoted source is already unquoted by the parser.
 * @param {string} value
 * @param {Record<string, string|undefined>} processEnv
 * @param {Record<string, string|undefined>} runningParsed
 */
export function expandDotenvValue(value, processEnv, runningParsed) {
  const env = { ...runningParsed, ...processEnv };
  const regex = /(?<!\\)\${([^{}]+)}|(?<!\\)\$([A-Za-z_][A-Za-z0-9_]*)/g;
  let result = String(value);
  let match;
  const seen = new Set();
  let guard = 0;
  while ((match = regex.exec(result)) !== null) {
    if (++guard > 50) break;
    seen.add(result);
    const [template, bracedExpression, unbracedExpression] = match;
    const expression = bracedExpression || unbracedExpression;
    const opMatch = expression.match(/(:\+|\+|:-|-)/);
    const splitter = opMatch ? opMatch[0] : null;
    const parts = expression.split(splitter);
    const key = parts.shift();
    let defaultValue;
    let lookup;
    if (splitter === ':+' || splitter === '+') {
      defaultValue = env[key] ? parts.join(splitter) : '';
      lookup = null;
    } else {
      defaultValue = parts.join(splitter);
      lookup = env[key];
    }
    if (lookup) {
      result = result.replace(
        template,
        seen.has(lookup) ? defaultValue : lookup,
      );
    } else {
      result = result.replace(template, defaultValue);
    }
    if (result === runningParsed[key]) break;
    regex.lastIndex = 0;
  }
  return resolveEscapeSequences(result);
}

/**
 * Expand a parsed dotenv object. Existing non-empty process values win per key.
 * @param {Record<string, string>} parsed
 * @param {NodeJS.ProcessEnv} processEnv
 */
export function expandDotenvValues(parsed, processEnv) {
  const result = { ...parsed };
  const scratch = { ...processEnv };
  for (const key of Object.keys(result)) {
    let value = result[key];
    if (scratch[key] && scratch[key] !== value) value = scratch[key];
    else value = expandDotenvValue(value, scratch, result);
    result[key] = value;
    scratch[key] = value;
  }
  return result;
}

/**
 * Read the Vite dotenv ladder from a directory.
 * @param {string} root
 * @param {string} mode
 */
export function readDotenvFiles(root, mode) {
  const parsed = {};
  for (const name of dotenvFileNames(mode)) {
    const filepath = path.join(root, name);
    let text;
    try {
      if (!statSync(filepath).isFile()) continue;
      text = readFileSync(filepath, 'utf8');
    } catch {
      continue;
    }
    try {
      Object.assign(parsed, parseDotenvText(text));
    } catch {
      continue;
    }
  }
  return parsed;
}

/**
 * Load repo-root dotenv into `env`. Variables already set are left unchanged,
 * including empty strings. Returns the expanded file values.
 * @param {string} root
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [mode]
 */
export function loadRepoDotenv(
  root,
  env = process.env,
  mode = dotenvMode(env),
) {
  const expanded = expandDotenvValues(readDotenvFiles(root, mode), env);
  for (const [key, value] of Object.entries(expanded)) {
    if (!Object.prototype.hasOwnProperty.call(env, key)) env[key] = value;
  }
  return expanded;
}
