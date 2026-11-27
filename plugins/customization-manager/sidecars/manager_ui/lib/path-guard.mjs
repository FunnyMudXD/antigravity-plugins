/**
 * Path guard, safe atomic write with .bak backups, and environment root helpers.
 */

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

const IS_WIN = process.platform === 'win32';

export function getHomeDir() {
  return resolve(process.env.AGY_CM_HOME_DIR || homedir());
}

export function getGeminiRoot() {
  return resolve(process.env.AGY_CM_GEMINI_ROOT || join(getHomeDir(), '.gemini'));
}

export function getConfigDir() {
  return resolve(process.env.AGY_CM_CONFIG_DIR || join(getGeminiRoot(), 'config'));
}

export function getDataDir() {
  if (process.env.AGY_CM_DATA_DIR) {
    return resolve(process.env.AGY_CM_DATA_DIR);
  }
  if (process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR) {
    return resolve(join(process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR, 'customization-manager'));
  }
  return resolve(join(getConfigDir(), 'plugins', 'customization-manager', '.data'));
}

/**
 * Expand leading ~/ or ~\ to the resolved home directory.
 */
export function expandHome(inputPath) {
  if (!inputPath || typeof inputPath !== 'string') return '';
  const trimmed = inputPath.trim();
  if (trimmed === '~') return getHomeDir();
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return join(getHomeDir(), trimmed.slice(2));
  }
  return trimmed;
}

export function resolveUserPath(inputPath, baseDir = getHomeDir()) {
  const expanded = expandHome(inputPath);
  if (!expanded) return '';
  return isAbsolute(expanded) ? resolve(expanded) : resolve(baseDir, expanded);
}

function normCase(p) {
  const resolved = resolve(p);
  return IS_WIN ? resolved.toLowerCase() : resolved;
}

export function isInsideRoot(targetPath, rootPath) {
  if (!targetPath || !rootPath) return false;
  const target = normCase(targetPath);
  const root = normCase(rootPath);
  if (target === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return target.startsWith(prefix);
}

export function isProtectedHostConfig(targetPath) {
  const hostConfig = resolve(join(getConfigDir(), 'config.json'));
  return normCase(targetPath) === normCase(hostConfig);
}

/**
 * Ensure targetPath is strictly inside one of allowedRoots and is not Antigravity's config.json.
 */
export function assertAllowedPath(targetPath, allowedRoots = []) {
  const resolved = resolve(targetPath);
  if (isProtectedHostConfig(resolved)) {
    throw new Error('Refusing to modify protected Antigravity config.json directly.');
  }
  const ok = allowedRoots.some((root) => root && isInsideRoot(resolved, root));
  if (!ok) {
    throw new Error(`Path "${resolved}" is outside allowed customization roots.`);
  }
  return resolved;
}

export function ensureParentDir(filePath) {
  const parent = dirname(filePath);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
}

export function readTextIfExists(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

export function readJsonSafe(filePath, fallback = null) {
  if (!existsSync(filePath)) {
    return { exists: false, ok: true, data: fallback, raw: '', error: null };
  }
  let raw = '';
  try {
    raw = readFileSync(filePath, 'utf-8');
    if (!raw.trim()) {
      return { exists: true, ok: true, data: fallback, raw, error: null };
    }
    return { exists: true, ok: true, data: JSON.parse(raw), raw, error: null };
  } catch (err) {
    return {
      exists: true,
      ok: false,
      data: fallback,
      raw,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Atomically write text to filePath after creating a .bak backup if content changed.
 */
export function backupAndWriteText(filePath, content, allowedRoots) {
  const safePath = assertAllowedPath(filePath, allowedRoots);
  ensureParentDir(safePath);

  let backupCreated = false;
  if (existsSync(safePath)) {
    const stat = lstatSync(safePath);
    if (!stat.isDirectory()) {
      const prev = readFileSync(safePath, 'utf-8');
      if (prev === content) {
        return { path: safePath, changed: false, backupCreated: false };
      }
      copyFileSync(safePath, `${safePath}.bak`);
      backupCreated = true;
    }
  }

  const tmpPath = `${safePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmpPath, content, 'utf-8');
    renameSync(tmpPath, safePath);
  } catch (err) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      // ignore cleanup error
    }
    writeFileSync(safePath, content, 'utf-8');
    if (err && err.code !== 'EXDEV' && err.code !== 'EPERM') {
      // fallback succeeded; only rethrow if writeFileSync above didn't run
    }
  }

  return { path: safePath, changed: true, backupCreated };
}

export function backupAndDeleteFile(filePath, allowedRoots) {
  const safePath = assertAllowedPath(filePath, allowedRoots);
  if (!existsSync(safePath)) {
    return { path: safePath, deleted: false, backupCreated: false };
  }
  copyFileSync(safePath, `${safePath}.bak`);
  unlinkSync(safePath);
  return { path: safePath, deleted: true, backupCreated: true };
}

export function rollbackFromBackup(filePath, allowedRoots) {
  const safePath = assertAllowedPath(filePath, allowedRoots);
  const bakPath = `${safePath}.bak`;
  if (!existsSync(bakPath)) {
    throw new Error(`No backup file found at ${bakPath}`);
  }
  const bakContent = readFileSync(bakPath, 'utf-8');
  if (existsSync(safePath)) {
    const stat = lstatSync(safePath);
    if (stat.isSymbolicLink()) {
      unlinkSync(safePath);
    }
  }
  writeFileSync(safePath, bakContent, 'utf-8');
  return { path: safePath, restoredFrom: bakPath };
}
