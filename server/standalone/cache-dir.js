import {
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import path from 'node:path';

/**
 * Providers persist disk caches under `path.join(process.cwd(), '.gev-cache')`.
 * When `cacheDir` is a different directory, point `.gev-cache` at it with a
 * symlink so those hardcoded paths share one writable volume.
 * @param {{ cwd?: string, cacheDir?: string }} [options]
 * @returns {string} Directory that will receive cache files.
 */
export function ensureProviderCacheDir({ cwd = process.cwd(), cacheDir } = {}) {
  const linkPath = path.resolve(cwd, '.gev-cache');
  const target = cacheDir ? path.resolve(cacheDir) : linkPath;
  if (target === linkPath || target.startsWith(`${linkPath}${path.sep}`)) {
    mkdirSync(linkPath, { recursive: true });
    return linkPath;
  }
  mkdirSync(target, { recursive: true });
  let existing;
  try {
    existing = lstatSync(linkPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (!existing) {
    symlinkSync(target, linkPath, 'dir');
    return target;
  }
  if (existing.isSymbolicLink()) {
    rmSync(linkPath);
    symlinkSync(target, linkPath, 'dir');
    return target;
  }
  if (existing.isDirectory() && readdirSync(linkPath).length === 0) {
    rmSync(linkPath, { recursive: true });
    symlinkSync(target, linkPath, 'dir');
    return target;
  }
  console.warn(
    `[gev] GEV_CACHE_DIR=${target} was not applied because ${linkPath} already exists. ` +
      'Move or remove that directory so provider caches can share one volume.',
  );
  return linkPath;
}
