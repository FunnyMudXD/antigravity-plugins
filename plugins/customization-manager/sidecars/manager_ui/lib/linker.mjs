/**
 * Multi-client link & sync engine.
 * Supports Windows Hard Links, Directory Junctions, Antigravity native mounts,
 * partial JSON merge (~/.claude.json), and partial TOML merge (~/.codex/config.toml).
 */

import {
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  backupAndWriteText,
  getConfigDir,
  getDataDir,
  getHomeDir,
  readJsonSafe,
  readTextIfExists,
  resolveUserPath,
  rollbackFromBackup,
} from './path-guard.mjs';
import { parseFrontmatter } from './scanner.mjs';
import { mergeTomlMcpServers, parseTomlMcpServers } from './toml-mcp.mjs';

const IS_WIN = process.platform === 'win32';

function normPath(p) {
  const r = resolve(p);
  return IS_WIN ? r.toLowerCase() : r;
}

export function loadSettings() {
  const settingsPath = join(getDataDir(), 'settings.json');
  const res = readJsonSafe(settingsPath, {});
  const data = res.ok && res.data && typeof res.data === 'object' ? res.data : {};
  return {
    masterDir: data.masterDir ? resolveUserPath(data.masterDir) : getConfigDir(),
    activeWorkspace: data.activeWorkspace ? resolveUserPath(data.activeWorkspace) : '',
  };
}

export function saveSettings(patch = {}) {
  const settingsPath = join(getDataDir(), 'settings.json');
  const current = loadSettings();
  const next = {
    masterDir: patch.masterDir !== undefined ? resolveUserPath(patch.masterDir || getConfigDir()) : current.masterDir,
    activeWorkspace: patch.activeWorkspace !== undefined
      ? (patch.activeWorkspace ? resolveUserPath(patch.activeWorkspace) : '')
      : current.activeWorkspace,
  };
  backupAndWriteText(settingsPath, `${JSON.stringify(next, null, 2)}\n`, [getDataDir()]);
  return next;
}

export function buildDefaultTargets() {
  const home = getHomeDir();
  const agyConfig = getConfigDir();

  return [
    {
      id: 'antigravity-global-rules',
      name: 'Antigravity 全局规则',
      client: 'antigravity',
      kind: 'rules',
      targetPath: join(agyConfig, 'GEMINI.md'),
      mode: 'sync-replace',
      enabled: true,
      builtin: true,
    },
    {
      id: 'antigravity-global-mcp',
      name: 'Antigravity 全局 MCP',
      client: 'antigravity',
      kind: 'mcp',
      targetPath: join(agyConfig, 'mcp_config.json'),
      mode: 'sync-replace',
      enabled: true,
      builtin: true,
    },
    {
      id: 'claude-global-rules',
      name: 'Claude Code 全局规则 (CLAUDE.md)',
      client: 'claude-code',
      kind: 'rules',
      targetPath: join(home, '.claude', 'CLAUDE.md'),
      mode: 'sync-replace',
      enabled: true,
      builtin: true,
    },
    {
      id: 'claude-global-mcp',
      name: 'Claude Code 全局 MCP (~/.claude.json 局部合并)',
      client: 'claude-code',
      kind: 'mcp',
      targetPath: join(home, '.claude.json'),
      mode: 'sync-merge-json',
      mergeKey: 'mcpServers',
      enabled: true,
      builtin: true,
    },
    {
      id: 'claude-global-skills',
      name: 'Claude Code 全局 Skills 目录联接',
      client: 'claude-code',
      kind: 'skills_dir',
      targetPath: join(home, '.claude', 'skills'),
      mode: 'junction',
      enabled: false,
      builtin: true,
    },
    {
      id: 'codex-global-rules',
      name: 'Codex 全局规则 (AGENTS.md)',
      client: 'codex',
      kind: 'rules',
      targetPath: join(home, '.codex', 'AGENTS.md'),
      mode: 'sync-replace',
      enabled: true,
      builtin: true,
    },
    {
      id: 'codex-global-mcp',
      name: 'Codex 全局 MCP (config.toml 局部合并)',
      client: 'codex',
      kind: 'mcp',
      targetPath: join(home, '.codex', 'config.toml'),
      mode: 'sync-merge-toml',
      enabled: true,
      builtin: true,
    },
    {
      id: 'codex-global-skills',
      name: 'Codex 全局 Skills 目录联接',
      client: 'codex',
      kind: 'skills_dir',
      targetPath: join(home, '.codex', 'skills'),
      mode: 'junction',
      enabled: false,
      builtin: true,
    },
    {
      id: 'cursor-global-mcp',
      name: 'Cursor 全局 MCP (~/.cursor/mcp.json)',
      client: 'cursor',
      kind: 'mcp',
      targetPath: join(home, '.cursor', 'mcp.json'),
      mode: 'sync-replace',
      enabled: true,
      builtin: true,
    },
    {
      id: 'qoder-global-rules',
      name: 'Qoder 全局规则 (可自定义路径)',
      client: 'qoder',
      kind: 'rules',
      targetPath: join(home, '.qoder', 'AGENTS.md'),
      mode: 'sync-replace',
      enabled: false,
      builtin: true,
    },
    {
      id: 'qoder-global-mcp',
      name: 'Qoder 全局 MCP (可自定义路径)',
      client: 'qoder',
      kind: 'mcp',
      targetPath: join(home, '.qoder', 'mcp.json'),
      mode: 'sync-replace',
      enabled: false,
      builtin: true,
    },
  ];
}

export function loadTargetsRegistry() {
  const regPath = join(getDataDir(), 'targets-registry.json');
  if (!existsSync(regPath)) {
    const defaults = buildDefaultTargets();
    backupAndWriteText(regPath, `${JSON.stringify({ targets: defaults }, null, 2)}\n`, [getDataDir()]);
    return defaults;
  }
  const res = readJsonSafe(regPath, { targets: [] });
  if (!res.ok || !Array.isArray(res.data?.targets)) {
    return buildDefaultTargets();
  }
  return res.data.targets;
}

export function saveTargetsRegistry(targets) {
  const regPath = join(getDataDir(), 'targets-registry.json');
  backupAndWriteText(regPath, `${JSON.stringify({ targets }, null, 2)}\n`, [getDataDir()]);
  return targets;
}

export function getAllowedRootsForSettings(settings, targets) {
  const roots = [getConfigDir(), getDataDir(), settings.masterDir];
  if (settings.activeWorkspace) roots.push(settings.activeWorkspace);
  for (const t of targets) {
    if (t?.targetPath) {
      const resolved = resolveUserPath(t.targetPath);
      roots.push(t.kind?.endsWith('_dir') ? resolved : dirname(resolved));
    }
  }
  return [...new Set(roots.filter(Boolean).map((r) => resolve(r)))];
}

/**
 * Build unified Markdown rules and mcpServers object from the selected master profile.
 */
export function buildMasterBundle(masterDir) {
  const primaryCandidates = [join(masterDir, 'GEMINI.md'), join(masterDir, 'AGENTS.md')];
  const primaryRulePath = primaryCandidates.find((p) => existsSync(p)) || primaryCandidates[0];
  const primaryBody = readTextIfExists(primaryRulePath) || '';

  const chunks = [];
  if (primaryBody.trim()) {
    chunks.push(primaryBody.trim());
  }

  // Append always_on modular rules cleanly (stripped of frontmatter) so all clients receive unified rules.
  const rulesDir = join(masterDir, 'rules');
  if (existsSync(rulesDir)) {
    try {
      const files = readdirSync(rulesDir, { withFileTypes: true })
        .filter((e) => (e.isFile() || e.isSymbolicLink()) && e.name.toLowerCase().endsWith('.md'))
        .map((e) => e.name)
        .sort();
      for (const name of files) {
        const raw = readTextIfExists(join(rulesDir, name)) || '';
        const parsed = parseFrontmatter(raw);
        if (parsed.frontmatter.trigger === 'always_on' && parsed.body.trim()) {
          chunks.push(parsed.body.trim());
        }
      }
    } catch {
      // ignore
    }
  }

  const rulesText = chunks.length ? `${chunks.join('\n\n---\n\n')}\n` : '';
  const mcpPath = join(masterDir, 'mcp_config.json');
  const mcpRes = readJsonSafe(mcpPath, { mcpServers: {} });
  const mcpServers = mcpRes.ok && mcpRes.data?.mcpServers && typeof mcpRes.data.mcpServers === 'object'
    ? mcpRes.data.mcpServers
    : {};

  return {
    masterDir,
    primaryRulePath,
    rulesDir,
    skillsDir: join(masterDir, 'skills'),
    mcpPath,
    rulesText,
    mcpServers,
  };
}

/**
 * Compute a concise unified line diff between oldText and newText.
 */
export function computeLineDiff(oldText = '', newText = '', maxLines = 180) {
  if (oldText === newText) return { changed: false, lines: [] };
  const a = String(oldText || '').split(/\r?\n/);
  const b = String(newText || '').split(/\r?\n/);

  // Trim shared prefix and suffix for compact, clear output
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start++;
  }
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }

  const lines = [];
  const ctxBefore = Math.max(0, start - 2);
  for (let i = ctxBefore; i < start; i++) {
    lines.push({ type: 'ctx', text: a[i] });
  }
  for (let i = start; i <= endA; i++) {
    lines.push({ type: 'del', text: a[i] });
  }
  for (let i = start; i <= endB; i++) {
    lines.push({ type: 'add', text: b[i] });
  }
  const ctxAfter = Math.min(a.length - 1, endA + 2);
  for (let i = endA + 1; i <= ctxAfter; i++) {
    lines.push({ type: 'ctx', text: a[i] });
  }

  const truncated = lines.length > maxLines;
  return {
    changed: true,
    truncated,
    lines: truncated ? lines.slice(0, maxLines) : lines,
  };
}

function buildDesiredTargetContent(target, masterBundle) {
  const resolvedTarget = resolveUserPath(target.targetPath);
  const warnings = [];

  if (target.kind === 'rules') {
    return { desiredText: masterBundle.rulesText, warnings };
  }

  if (target.kind === 'mcp') {
    if (target.mode === 'sync-merge-toml') {
      const existing = readTextIfExists(resolvedTarget) || '';
      const merged = mergeTomlMcpServers(existing, masterBundle.mcpServers);
      return { desiredText: merged, warnings };
    }
    if (target.mode === 'sync-merge-json') {
      const mergeKey = target.mergeKey || 'mcpServers';
      const existingRes = readJsonSafe(resolvedTarget, {});
      if (!existingRes.ok) {
        warnings.push(`目标 JSON 解析失败（${existingRes.error}），同步前请先修复该文件`);
        return { desiredText: null, warnings, error: existingRes.error };
      }
      const nextObj = { ...(existingRes.data && typeof existingRes.data === 'object' ? existingRes.data : {}) };
      nextObj[mergeKey] = masterBundle.mcpServers;
      return { desiredText: `${JSON.stringify(nextObj, null, 2)}\n`, warnings };
    }
    // sync-replace / hardlink standalone mcp json
    return {
      desiredText: `${JSON.stringify({ mcpServers: masterBundle.mcpServers }, null, 2)}\n`,
      warnings,
    };
  }

  if (target.mode === 'native-plugin-mount') {
    const existingRes = readJsonSafe(resolvedTarget, { entries: [] });
    if (!existingRes.ok) {
      return { desiredText: null, warnings: [existingRes.error], error: existingRes.error };
    }
    const nextObj = { ...(existingRes.data && typeof existingRes.data === 'object' ? existingRes.data : {}) };
    const entries = Array.isArray(nextObj.entries) ? [...nextObj.entries] : [];
    const mountPath = target.sourcePath ? resolveUserPath(target.sourcePath) : masterBundle.masterDir;
    const already = entries.some((e) => e && normPath(resolveUserPath(e.path || '')) === normPath(mountPath));
    if (!already) {
      entries.push({ path: mountPath.replace(/\\/g, '/') });
    }
    nextObj.entries = entries;
    return { desiredText: `${JSON.stringify(nextObj, null, 2)}\n`, warnings };
  }

  return { desiredText: null, warnings };
}

function getSourceForTarget(target, masterBundle) {
  if (target.sourcePath) return resolveUserPath(target.sourcePath);
  if (target.kind === 'rules') return masterBundle.primaryRulePath;
  if (target.kind === 'mcp') return masterBundle.mcpPath;
  if (target.kind === 'skills_dir') return masterBundle.skillsDir;
  if (target.kind === 'rules_dir') return masterBundle.rulesDir;
  return masterBundle.masterDir;
}

/**
 * Inspect current sync/link status and preview diff for one target.
 */
export function inspectTarget(target, masterBundle) {
  const resolvedTarget = resolveUserPath(target.targetPath);
  const sourcePath = getSourceForTarget(target, masterBundle);
  const isMasterSelf = normPath(resolvedTarget) === normPath(sourcePath);

  const clientDir = target.kind?.endsWith('_dir') ? dirname(resolvedTarget) : dirname(resolvedTarget);
  const clientDirExists = existsSync(clientDir);
  const hasBackup = existsSync(`${resolvedTarget}.bak`);

  let linkKind = 'none'; // none | file | dir | symlink | junction | hardlink | broken
  let exists = false;
  try {
    const lst = lstatSync(resolvedTarget);
    exists = true;
    if (lst.isSymbolicLink()) {
      try {
        const realT = realpathSync(resolvedTarget);
        const realS = existsSync(sourcePath) ? realpathSync(sourcePath) : '';
        linkKind = realS && normPath(realT) === normPath(realS) ? 'symlink_linked' : 'symlink_other';
      } catch {
        linkKind = 'broken';
      }
    } else if (lst.isDirectory()) {
      linkKind = 'dir';
    } else {
      linkKind = 'file';
      if (existsSync(sourcePath)) {
        const stT = statSync(resolvedTarget);
        const stS = statSync(sourcePath);
        if (stT.dev === stS.dev && stT.ino === stS.ino) {
          linkKind = 'hardlink';
        }
      }
    }
  } catch {
    exists = false;
  }

  if (isMasterSelf) {
    return {
      ...target,
      resolvedTarget,
      sourcePath,
      isMasterSelf: true,
      clientDirExists,
      exists,
      linkKind,
      hasBackup,
      status: 'master_self',
      statusLabel: '当前主源',
      diff: { changed: false, lines: [] },
      warnings: [],
    };
  }

  if (target.mode === 'junction') {
    let status = 'missing';
    let statusLabel = '未联接';
    if (linkKind === 'symlink_linked') {
      status = 'linked';
      statusLabel = '已联接 (Junction)';
    } else if (linkKind === 'broken') {
      status = 'broken_link';
      statusLabel = '链接失效';
    } else if (linkKind === 'dir') {
      status = 'drifted';
      statusLabel = '已存在独立目录';
    } else if (linkKind === 'symlink_other') {
      status = 'drifted';
      statusLabel = '指向其他目录';
    }
    return {
      ...target,
      resolvedTarget,
      sourcePath,
      isMasterSelf: false,
      clientDirExists,
      exists,
      linkKind,
      hasBackup,
      status,
      statusLabel,
      diff: { changed: status !== 'linked', lines: [] },
      warnings: existsSync(sourcePath) ? [] : [`源目录不存在: ${sourcePath}`],
    };
  }

  if (target.mode === 'hardlink' && linkKind === 'hardlink') {
    return {
      ...target,
      resolvedTarget,
      sourcePath,
      isMasterSelf: false,
      clientDirExists,
      exists,
      linkKind,
      hasBackup,
      status: 'linked',
      statusLabel: '已硬链接 (实时共享)',
      diff: { changed: false, lines: [] },
      warnings: [],
    };
  }

  const { desiredText, warnings, error } = buildDesiredTargetContent(target, masterBundle);
  if (error || desiredText === null) {
    return {
      ...target,
      resolvedTarget,
      sourcePath,
      isMasterSelf: false,
      clientDirExists,
      exists,
      linkKind,
      hasBackup,
      status: 'error',
      statusLabel: '解析异常',
      error,
      diff: { changed: false, lines: [] },
      warnings,
    };
  }

  const currentText = exists ? (readTextIfExists(resolvedTarget) ?? '') : '';
  const diff = computeLineDiff(currentText, desiredText);
  let status = 'synced';
  let statusLabel = '已同步';
  if (!exists) {
    status = 'missing';
    statusLabel = '未写入';
  } else if (diff.changed) {
    status = 'drifted';
    statusLabel = '待同步 (有差异)';
  }

  // Extra preview summary for Codex TOML to show preserved top-level keys
  let currentParsedSummary = null;
  if (target.mode === 'sync-merge-toml' && exists) {
    currentParsedSummary = Object.keys(parseTomlMcpServers(currentText));
  }

  return {
    ...target,
    resolvedTarget,
    sourcePath,
    isMasterSelf: false,
    clientDirExists,
    exists,
    linkKind,
    hasBackup,
    status,
    statusLabel,
    diff,
    warnings,
    currentParsedSummary,
    desiredPreview: desiredText,
  };
}

/**
 * Apply link or sync for a single target (or dryRun preview).
 */
export function applyTarget(target, masterBundle, allowedRoots, { dryRun = false } = {}) {
  const inspected = inspectTarget(target, masterBundle);
  if (inspected.isMasterSelf) {
    return { ok: true, id: target.id, skipped: true, reason: 'master_self', inspected };
  }
  if (inspected.status === 'error') {
    return { ok: false, id: target.id, error: inspected.error || 'Target inspection error', inspected };
  }
  if (dryRun) {
    return { ok: true, id: target.id, dryRun: true, inspected };
  }

  const resolvedTarget = inspected.resolvedTarget;
  const sourcePath = inspected.sourcePath;

  if (target.mode === 'junction') {
    if (!existsSync(sourcePath)) {
      mkdirSync(sourcePath, { recursive: true });
    }
    const parent = dirname(resolvedTarget);
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true });

    if (existsSync(resolvedTarget)) {
      const lst = lstatSync(resolvedTarget);
      if (lst.isSymbolicLink()) {
        unlinkSync(resolvedTarget);
      } else if (lst.isDirectory()) {
        throw new Error(`目标目录 ${resolvedTarget} 已存在且为普通目录，请先手动备份或移走后再建立 Junction 联接。`);
      }
    }
    symlinkSync(sourcePath, resolvedTarget, IS_WIN ? 'junction' : 'dir');
    return { ok: true, id: target.id, mode: 'junction', inspected: inspectTarget(target, masterBundle) };
  }

  if (target.mode === 'hardlink') {
    if (!existsSync(sourcePath)) {
      throw new Error(`源文件不存在: ${sourcePath}`);
    }
    const parent = dirname(resolvedTarget);
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true });

    // Verify same volume before linkSync
    const srcStat = statSync(sourcePath);
    const parentStat = statSync(parent);
    if (srcStat.dev !== parentStat.dev) {
      throw new Error(`源与目标不在同一盘符，Windows Hard Link 无法跨盘符创建，请改用 sync-replace 模式。`);
    }
    if (existsSync(resolvedTarget)) {
      const lst = lstatSync(resolvedTarget);
      if (!lst.isSymbolicLink()) {
        const tStat = statSync(resolvedTarget);
        if (tStat.dev === srcStat.dev && tStat.ino === srcStat.ino) {
          return { ok: true, id: target.id, mode: 'hardlink', changed: false, inspected };
        }
        copyFileSync(resolvedTarget, `${resolvedTarget}.bak`);
      }
      unlinkSync(resolvedTarget);
    }
    linkSync(sourcePath, resolvedTarget);
    return { ok: true, id: target.id, mode: 'hardlink', changed: true, inspected: inspectTarget(target, masterBundle) };
  }

  // sync-replace, sync-merge-json, sync-merge-toml, native-plugin-mount
  const writeRes = backupAndWriteText(resolvedTarget, inspected.desiredPreview || '', allowedRoots);
  return {
    ok: true,
    id: target.id,
    mode: target.mode,
    ...writeRes,
    inspected: inspectTarget(target, masterBundle),
  };
}

export function rollbackTarget(target, allowedRoots) {
  const resolvedTarget = resolveUserPath(target.targetPath);
  return rollbackFromBackup(resolvedTarget, allowedRoots);
}
