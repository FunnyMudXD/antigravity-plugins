/**
 * Rules & MCP Manager Sidecar Backend.
 * Serves the AUX_PANE web UI and REST APIs for managing Antigravity rules,
 * hooks, MCP servers, and multi-client config links/sync.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarApp, Response } from 'sidecar_sdk';
import {
  applyTarget,
  buildMasterBundle,
  getAllowedRootsForSettings,
  inspectTarget,
  loadSettings,
  loadTargetsRegistry,
  rollbackTarget,
  saveSettings,
  saveTargetsRegistry,
} from './lib/linker.mjs';
import { fetchInstalledPluginsInventory, refreshMcpServerRpc } from './lib/lsrpc.mjs';
import {
  backupAndDeleteFile,
  backupAndWriteText,
  getConfigDir,
  getDataDir,
  readJsonSafe,
  resolveUserPath,
  rollbackFromBackup,
} from './lib/path-guard.mjs';
import { scanHooks, scanMcp, scanRules, scanSkills, serializeRuleMarkdown } from './lib/scanner.mjs';
import { HOOK_TEMPLATES, MCP_TEMPLATES, RULE_TEMPLATES } from './lib/templates.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const STATIC_ASSETS = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

function getContext() {
  const settings = loadSettings();
  const targets = loadTargetsRegistry();
  const allowedRoots = getAllowedRootsForSettings(settings, targets);
  return { settings, targets, allowedRoots };
}

function safeHandler(fn) {
  return async (data) => {
    try {
      return await fn(data || {});
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };
}

const app = new SidecarApp();

app.page('/', () => readFileSync(join(__dirname, 'index.html'), 'utf-8'));

for (const [route, [file, contentType]] of Object.entries(STATIC_ASSETS)) {
  app.api(route, () => new Response(readFileSync(join(__dirname, file), 'utf-8'), { contentType }), 'GET');
}

app.api('/api/overview', safeHandler(async () => {
  const { settings, targets, allowedRoots } = getContext();
  const rules = scanRules(settings.masterDir, settings.activeWorkspace, allowedRoots);
  const mcp = scanMcp(settings.masterDir, settings.activeWorkspace);
  const hooks = scanHooks(settings.masterDir, settings.activeWorkspace);
  const skills = scanSkills(settings.masterDir, settings.activeWorkspace);
  const masterBundle = buildMasterBundle(settings.masterDir);
  const inspectedTargets = targets.map((t) => inspectTarget(t, masterBundle));

  return {
    ok: true,
    settings: {
      ...settings,
      defaultConfigDir: getConfigDir(),
      dataDir: getDataDir(),
    },
    rules,
    mcp,
    hooks,
    skills,
    targets: inspectedTargets,
    templates: {
      rules: RULE_TEMPLATES,
      hooks: HOOK_TEMPLATES,
      mcp: MCP_TEMPLATES,
    },
  };
}), 'GET');

app.api('/api/settings', safeHandler((data) => {
  const next = saveSettings({
    masterDir: data.masterDir,
    activeWorkspace: data.activeWorkspace,
  });
  return { ok: true, settings: next };
}));

app.api('/api/rules/save', safeHandler((data) => {
  const { settings, allowedRoots } = getContext();
  const scope = data.scope === 'workspace' && settings.activeWorkspace ? 'workspace' : 'master';
  const baseDir = scope === 'workspace' ? settings.activeWorkspace : settings.masterDir;

  let targetPath = '';
  const isStandalone = Boolean(data.isStandalone);
  if (data.path) {
    targetPath = resolveUserPath(data.path, baseDir);
  } else if (isStandalone) {
    const rawName = String(data.fileName || '').trim();
    const upper = rawName.toUpperCase();
    if (upper !== 'GEMINI.MD' && upper !== 'AGENTS.MD') {
      throw new Error('常驻根文件仅识别 GEMINI.md 或 AGENTS.md；如需自定义文件名（如中文规则名），请将「规则形态」选为「模块化规则 (rules/*.md)」并选择 always_on。');
    }
    const fileName = upper === 'AGENTS.MD' ? 'AGENTS.md' : 'GEMINI.md';
    targetPath = scope === 'workspace' && data.useDotAgents
      ? join(baseDir, '.agents', fileName)
      : join(baseDir, fileName);
  } else {
    const rawName = String(data.fileName || 'custom-rule.md').trim().replace(/[/\\:*?"<>|]/g, '-');
    const finalName = rawName.toLowerCase().endsWith('.md') ? rawName : `${rawName}.md`;
    targetPath = scope === 'workspace'
      ? join(baseDir, '.agents', 'rules', finalName)
      : join(baseDir, 'rules', finalName);
  }

  const markdown = serializeRuleMarkdown({
    isStandalone,
    trigger: data.trigger,
    description: data.description,
    globs: data.globs,
    body: data.body ?? data.content ?? '',
  });

  const result = backupAndWriteText(targetPath, markdown, allowedRoots);
  return { ok: true, ...result, rules: scanRules(settings.masterDir, settings.activeWorkspace, allowedRoots) };
}));

app.api('/api/rules/delete', safeHandler((data) => {
  const { settings, allowedRoots } = getContext();
  const targetPath = resolveUserPath(data.path || '');
  if (!targetPath) throw new Error('Missing rule path');
  const result = backupAndDeleteFile(targetPath, allowedRoots);
  return { ok: true, ...result, rules: scanRules(settings.masterDir, settings.activeWorkspace, allowedRoots) };
}));

app.api('/api/rules/rollback', safeHandler((data) => {
  const { settings, allowedRoots } = getContext();
  const targetPath = resolveUserPath(data.path || '');
  if (!targetPath) throw new Error('Missing rule path');
  const result = rollbackFromBackup(targetPath, allowedRoots);
  return { ok: true, ...result, rules: scanRules(settings.masterDir, settings.activeWorkspace, allowedRoots) };
}));

app.api('/api/mcp/save', safeHandler((data) => {
  const { settings, allowedRoots } = getContext();
  const scope = data.scope === 'workspace' && settings.activeWorkspace ? 'workspace' : 'master';
  const filePath = scope === 'workspace'
    ? join(settings.activeWorkspace, '.agents', 'mcp_config.json')
    : join(settings.masterDir, 'mcp_config.json');

  if (typeof data.rawJson === 'string') {
    const parsed = JSON.parse(data.rawJson);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.mcpServers !== 'object') {
      throw new Error('JSON 根对象必须包含 "mcpServers" 对象');
    }
    const writeRes = backupAndWriteText(filePath, `${JSON.stringify(parsed, null, 2)}\n`, allowedRoots);
    return { ok: true, ...writeRes, mcp: scanMcp(settings.masterDir, settings.activeWorkspace) };
  }

  const name = String(data.name || '').trim();
  if (!name) throw new Error('MCP Server 名称不能为空');

  const existing = readJsonSafe(filePath, { mcpServers: {} });
  if (!existing.ok) {
    throw new Error(`现有 mcp_config.json 解析失败: ${existing.error}`);
  }
  const doc = existing.data && typeof existing.data === 'object' ? { ...existing.data } : {};
  const servers = doc.mcpServers && typeof doc.mcpServers === 'object' ? { ...doc.mcpServers } : {};

  if (data.previousName && data.previousName !== name) {
    delete servers[data.previousName];
  }

  const entry = {};
  if (data.transport === 'http') {
    const url = String(data.url || '').trim();
    if (!url) throw new Error('远程 Streamable HTTP 模式必须填写 URL');
    entry.url = url;
    if (data.headers && typeof data.headers === 'object' && Object.keys(data.headers).length) {
      entry.headers = data.headers;
    }
  } else {
    const command = String(data.command || '').trim();
    if (!command) throw new Error('本地 Stdio 模式必须填写 command');
    entry.command = command;
    if (Array.isArray(data.args) && data.args.length) {
      entry.args = data.args.map(String);
    }
    if (data.env && typeof data.env === 'object' && Object.keys(data.env).length) {
      entry.env = data.env;
    }
  }
  if (data.disabled === true) entry.disabled = true;

  servers[name] = entry;
  doc.mcpServers = servers;

  const writeRes = backupAndWriteText(filePath, `${JSON.stringify(doc, null, 2)}\n`, allowedRoots);
  return { ok: true, ...writeRes, mcp: scanMcp(settings.masterDir, settings.activeWorkspace) };
}));

app.api('/api/mcp/delete', safeHandler((data) => {
  const { settings, allowedRoots } = getContext();
  const scope = data.scope === 'workspace' && settings.activeWorkspace ? 'workspace' : 'master';
  const filePath = scope === 'workspace'
    ? join(settings.activeWorkspace, '.agents', 'mcp_config.json')
    : join(settings.masterDir, 'mcp_config.json');

  const existing = readJsonSafe(filePath, { mcpServers: {} });
  if (!existing.ok) throw new Error(existing.error);
  const doc = existing.data && typeof existing.data === 'object' ? { ...existing.data } : {};
  const servers = doc.mcpServers && typeof doc.mcpServers === 'object' ? { ...doc.mcpServers } : {};
  delete servers[data.name];
  doc.mcpServers = servers;

  const writeRes = backupAndWriteText(filePath, `${JSON.stringify(doc, null, 2)}\n`, allowedRoots);
  return { ok: true, ...writeRes, mcp: scanMcp(settings.masterDir, settings.activeWorkspace) };
}));

app.api('/api/mcp/refresh', safeHandler(async (data) => {
  const res = await refreshMcpServerRpc(data.serverName || '');
  return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error };
}));

app.api('/api/hooks/save', safeHandler((data) => {
  const { settings, allowedRoots } = getContext();
  const scope = data.scope === 'workspace' && settings.activeWorkspace ? 'workspace' : 'master';
  const filePath = scope === 'workspace'
    ? join(settings.activeWorkspace, '.agents', 'hooks.json')
    : join(settings.masterDir, 'hooks.json');

  if (typeof data.rawJson === 'string') {
    const parsed = JSON.parse(data.rawJson);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('hooks.json 必须是 JSON 对象');
    }
    const writeRes = backupAndWriteText(filePath, `${JSON.stringify(parsed, null, 2)}\n`, allowedRoots);
    return { ok: true, ...writeRes, hooks: scanHooks(settings.masterDir, settings.activeWorkspace) };
  }

  const existing = readJsonSafe(filePath, {});
  if (!existing.ok) throw new Error(existing.error);
  const doc = existing.data && typeof existing.data === 'object' ? { ...existing.data } : {};

  const hookName = String(data.name || '').trim();
  if (!hookName) throw new Error('Hook 名称不能为空');

  if (data.action === 'toggle' && doc[hookName]) {
    doc[hookName] = { ...doc[hookName], enabled: Boolean(data.enabled) };
  } else if (data.action === 'delete') {
    delete doc[hookName];
  } else if (data.config && typeof data.config === 'object') {
    doc[hookName] = data.config;
  }

  const writeRes = backupAndWriteText(filePath, `${JSON.stringify(doc, null, 2)}\n`, allowedRoots);
  return { ok: true, ...writeRes, hooks: scanHooks(settings.masterDir, settings.activeWorkspace) };
}));

app.api('/api/targets/save', safeHandler((data) => {
  const { settings, targets } = getContext();
  const next = [...targets];
  const id = String(data.id || `custom-${Date.now()}`).trim();
  const targetPath = resolveUserPath(data.targetPath || '');
  if (!targetPath) throw new Error('目标路径不能为空');

  const item = {
    id,
    name: String(data.name || id).trim(),
    client: String(data.client || 'custom').trim(),
    kind: data.kind || 'rules',
    targetPath,
    sourcePath: data.sourcePath ? resolveUserPath(data.sourcePath) : '',
    mode: data.mode || 'sync-replace',
    mergeKey: data.mergeKey || 'mcpServers',
    enabled: data.enabled !== false,
    builtin: Boolean(data.builtin),
  };

  const idx = next.findIndex((t) => t.id === id);
  if (idx >= 0) next[idx] = { ...next[idx], ...item };
  else next.push(item);

  saveTargetsRegistry(next);
  const masterBundle = buildMasterBundle(settings.masterDir);
  return { ok: true, targets: next.map((t) => inspectTarget(t, masterBundle)) };
}));

app.api('/api/targets/delete', safeHandler((data) => {
  const { settings, targets } = getContext();
  const next = targets.filter((t) => t.id !== data.id);
  saveTargetsRegistry(next);
  const masterBundle = buildMasterBundle(settings.masterDir);
  return { ok: true, targets: next.map((t) => inspectTarget(t, masterBundle)) };
}));

app.api('/api/targets/preview', safeHandler((data) => {
  const { settings, targets, allowedRoots } = getContext();
  const masterBundle = buildMasterBundle(settings.masterDir);
  const selected = data.ids && Array.isArray(data.ids)
    ? targets.filter((t) => data.ids.includes(t.id))
    : targets.filter((t) => t.enabled);

  const previews = selected.map((t) => applyTarget(t, masterBundle, allowedRoots, { dryRun: true }));
  return { ok: true, previews };
}));

app.api('/api/targets/sync', safeHandler((data) => {
  const { settings, targets, allowedRoots } = getContext();
  const masterBundle = buildMasterBundle(settings.masterDir);
  const selected = data.ids && Array.isArray(data.ids)
    ? targets.filter((t) => data.ids.includes(t.id))
    : targets.filter((t) => t.enabled);

  const results = selected.map((t) => {
    try {
      return applyTarget(t, masterBundle, allowedRoots, { dryRun: false });
    } catch (err) {
      return { ok: false, id: t.id, error: err instanceof Error ? err.message : String(err) };
    }
  });

  const refreshed = targets.map((t) => inspectTarget(t, masterBundle));
  return { ok: results.every((r) => r.ok), results, targets: refreshed };
}));

app.api('/api/targets/rollback', safeHandler((data) => {
  const { settings, targets, allowedRoots } = getContext();
  const target = targets.find((t) => t.id === data.id);
  if (!target) throw new Error('未找到对应目标配置');
  const res = rollbackTarget(target, allowedRoots);
  const masterBundle = buildMasterBundle(settings.masterDir);
  return { ok: true, ...res, targets: targets.map((t) => inspectTarget(t, masterBundle)) };
}));

app.api('/api/inventory', safeHandler(async () => {
  const { settings } = getContext();
  const ls = await fetchInstalledPluginsInventory(settings.activeWorkspace);
  return { ok: true, ...ls };
}));

app.run();
