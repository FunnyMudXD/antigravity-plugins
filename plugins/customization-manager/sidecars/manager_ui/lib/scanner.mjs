/**
 * Scanner and parser for Antigravity rules, MCP servers, hooks, and skills.
 */

import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { isInsideRoot, readJsonSafe, readTextIfExists, resolveUserPath } from './path-guard.mjs';

export const RULE_BYTE_LIMIT = 24_000;
export const RULE_TOKEN_BUDGET = 20_000;
export const VALID_TRIGGERS = ['always_on', 'model_decision', 'glob', 'manual'];

const INCLUDE_RE = /@\[[^\]]*\]\(([^)]+)\)/g;

/**
 * Estimate token count using a CJK-aware heuristic.
 */
export function estimateTokens(text = '') {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      cjk++;
    } else {
      other++;
    }
  }
  return Math.ceil(cjk * 1.4 + other / 3.8);
}

/**
 * Parse optional YAML frontmatter at the top of a Markdown file.
 */
export function parseFrontmatter(rawText = '') {
  const text = String(rawText || '');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { hasFrontmatter: false, frontmatter: {}, body: text };
  }

  const fmBlock = match[1];
  const body = match[2] ?? '';
  const fm = {};
  const lines = fmBlock.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let val = kv[2].trim();

    if (val === '>-' || val === '|-' || val === '>' || val === '|') {
      const folded = [];
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || lines[i + 1].trim() === '')) {
        i++;
        folded.push(lines[i].trim());
      }
      val = folded.filter(Boolean).join(' ');
    } else if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }

    fm[key] = val;
  }

  return { hasFrontmatter: true, frontmatter: fm, body };
}

function quoteYamlValue(val = '') {
  const s = String(val ?? '').replace(/\r?\n/g, ' ').trim();
  if (!s) return '""';
  if (/[:#[\]{}&*!|>'"%@`]/.test(s) || /^\s|\s$/.test(s)) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return s;
}

export function serializeRuleMarkdown({ isStandalone, trigger, description, globs, body }) {
  const cleanBody = String(body ?? '').replace(/^\r?\n+/, '');
  if (isStandalone) {
    return cleanBody.endsWith('\n') || !cleanBody ? cleanBody : `${cleanBody}\n`;
  }

  const safeTrigger = VALID_TRIGGERS.includes(trigger) ? trigger : 'manual';
  const lines = ['---', `trigger: ${safeTrigger}`];
  if (description && String(description).trim()) {
    lines.push(`description: ${quoteYamlValue(description)}`);
  }
  if (safeTrigger === 'glob' || (globs && String(globs).trim())) {
    lines.push(`globs: ${quoteYamlValue(globs || '*')}`);
  }
  lines.push('---', '');
  const combined = `${lines.join('\n')}${cleanBody}`;
  return combined.endsWith('\n') ? combined : `${combined}\n`;
}

/**
 * Expand @[label](path) includes within allowed roots to compute effective byte size.
 */
export function expandRuleIncludes(text, baseDir, allowedRoots = [], depth = 0, seen = new Set()) {
  const includes = [];
  if (depth > 5) {
    return { expandedText: text, expandedBytes: Buffer.byteLength(text, 'utf-8'), includes };
  }

  const expandedText = String(text || '').replace(INCLUDE_RE, (full, rawRef) => {
    const ref = String(rawRef || '').trim();
    if (!ref || /^https?:\/\//i.test(ref)) return full;
    const candidate = resolveUserPath(ref, baseDir);
    if (!candidate) return full;
    const allowed = allowedRoots.some((r) => r && isInsideRoot(candidate, r));
    if (!allowed || !existsSync(candidate)) {
      includes.push({ ref, path: candidate, status: allowed ? 'missing' : 'blocked' });
      return full;
    }
    const normKey = candidate.toLowerCase();
    if (seen.has(normKey)) {
      includes.push({ ref, path: candidate, status: 'cycle' });
      return full;
    }
    try {
      const st = statSync(candidate);
      if (st.isDirectory()) return full;
      const childRaw = readFileSync(candidate, 'utf-8');
      const nextSeen = new Set(seen);
      nextSeen.add(normKey);
      const child = expandRuleIncludes(childRaw, dirname(candidate), allowedRoots, depth + 1, nextSeen);
      includes.push({ ref, path: candidate, status: 'ok', bytes: child.expandedBytes });
      return child.expandedText;
    } catch {
      includes.push({ ref, path: candidate, status: 'error' });
      return full;
    }
  });

  return {
    expandedText,
    expandedBytes: Buffer.byteLength(expandedText, 'utf-8'),
    includes,
  };
}

function readRuleEntry(filePath, scope, isStandalone, allowedRoots) {
  const raw = readTextIfExists(filePath) ?? '';
  const parsed = parseFrontmatter(raw);
  const trigger = isStandalone
    ? 'always_on'
    : VALID_TRIGGERS.includes(parsed.frontmatter.trigger)
      ? parsed.frontmatter.trigger
      : 'manual';

  const inc = expandRuleIncludes(parsed.body, dirname(filePath), allowedRoots);
  const rawBytes = Buffer.byteLength(raw, 'utf-8');
  const tokens = estimateTokens(inc.expandedText);
  let isSymlink = false;
  let linkCount = 1;
  try {
    const lst = lstatSync(filePath);
    isSymlink = lst.isSymbolicLink();
    linkCount = lst.nlink || 1;
  } catch {
    // ignore
  }

  return {
    id: `${scope}:${filePath}`,
    scope,
    fileName: filePath.split(/[/\\]/).pop(),
    path: filePath,
    isStandalone,
    trigger,
    description: parsed.frontmatter.description || '',
    globs: parsed.frontmatter.globs || '',
    body: parsed.body,
    raw,
    rawBytes,
    expandedBytes: inc.expandedBytes,
    overByteLimit: inc.expandedBytes > RULE_BYTE_LIMIT,
    tokens,
    includes: inc.includes,
    isSymlink,
    isHardLinked: linkCount > 1,
    hasBackup: existsSync(`${filePath}.bak`),
  };
}

function listMarkdownFiles(dirPath) {
  if (!dirPath || !existsSync(dirPath)) return [];
  try {
    return readdirSync(dirPath, { withFileTypes: true })
      .filter((ent) => (ent.isFile() || ent.isSymbolicLink()) && ent.name.toLowerCase().endsWith('.md'))
      .map((ent) => join(dirPath, ent.name))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export function scanRules(masterDir, workspaceDir = '', allowedRoots = []) {
  const items = [];
  const roots = [...new Set([masterDir, workspaceDir, ...allowedRoots].filter(Boolean))];

  // Master / global rules
  for (const name of ['GEMINI.md', 'AGENTS.md']) {
    const p = join(masterDir, name);
    if (existsSync(p)) {
      items.push(readRuleEntry(p, 'master', true, roots));
    }
  }
  for (const p of listMarkdownFiles(join(masterDir, 'rules'))) {
    items.push(readRuleEntry(p, 'master', false, roots));
  }

  // Optional workspace rules when workspace is distinct from masterDir
  if (workspaceDir && resolve(workspaceDir).toLowerCase() !== resolve(masterDir).toLowerCase()) {
    for (const p of [
      join(workspaceDir, 'GEMINI.md'),
      join(workspaceDir, 'AGENTS.md'),
      join(workspaceDir, '.agents', 'GEMINI.md'),
      join(workspaceDir, '.agents', 'AGENTS.md'),
    ]) {
      if (existsSync(p)) {
        items.push(readRuleEntry(p, 'workspace', true, roots));
      }
    }
    for (const p of listMarkdownFiles(join(workspaceDir, '.agents', 'rules'))) {
      items.push(readRuleEntry(p, 'workspace', false, roots));
    }
  }

  const alwaysOnTokens = items
    .filter((r) => r.trigger === 'always_on')
    .reduce((acc, r) => acc + r.tokens, 0);

  return {
    items,
    budget: {
      perFileByteLimit: RULE_BYTE_LIMIT,
      alwaysOnTokens,
      tokenBudget: RULE_TOKEN_BUDGET,
      overBudget: alwaysOnTokens > RULE_TOKEN_BUDGET,
    },
  };
}

function normalizeMcpMap(mcpServers = {}, scope, sourcePath) {
  const list = [];
  for (const [name, cfg] of Object.entries(mcpServers || {})) {
    if (!cfg || typeof cfg !== 'object') continue;
    const url = cfg.url || cfg.serverUrl || '';
    const isStdio = Boolean(cfg.command);
    const transport = isStdio ? 'stdio' : 'http';
    const warnings = [];
    if (!isStdio && !url) warnings.push('missing_endpoint');
    if (url && /\/sse(\?.*)?$/i.test(url)) warnings.push('legacy_sse_unsupported');

    list.push({
      id: `${scope}:${name}`,
      scope,
      sourcePath,
      name,
      transport,
      command: cfg.command || '',
      args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
      env: cfg.env && typeof cfg.env === 'object' ? cfg.env : {},
      url,
      legacyUrlKey: Boolean(cfg.serverUrl && !cfg.url),
      headers: cfg.headers && typeof cfg.headers === 'object' ? cfg.headers : {},
      disabled: Boolean(cfg.disabled),
      rawConfig: cfg,
      warnings,
    });
  }
  return list;
}

export function scanMcp(masterDir, workspaceDir = '') {
  const masterPath = join(masterDir, 'mcp_config.json');
  const masterRes = readJsonSafe(masterPath, { mcpServers: {} });
  const masterServers = masterRes.ok ? masterRes.data?.mcpServers || {} : {};
  const items = normalizeMcpMap(masterServers, 'master', masterPath);

  const scopes = {
    master: {
      path: masterPath,
      exists: masterRes.exists,
      ok: masterRes.ok,
      error: masterRes.error,
      raw: masterRes.raw,
      hasBackup: existsSync(`${masterPath}.bak`),
    },
  };

  if (workspaceDir && resolve(workspaceDir).toLowerCase() !== resolve(masterDir).toLowerCase()) {
    const wsPath = join(workspaceDir, '.agents', 'mcp_config.json');
    const wsRes = readJsonSafe(wsPath, { mcpServers: {} });
    const wsServers = wsRes.ok ? wsRes.data?.mcpServers || {} : {};
    items.push(...normalizeMcpMap(wsServers, 'workspace', wsPath));
    scopes.workspace = {
      path: wsPath,
      exists: wsRes.exists,
      ok: wsRes.ok,
      error: wsRes.error,
      raw: wsRes.raw,
      hasBackup: existsSync(`${wsPath}.bak`),
    };
  }

  return { items, scopes };
}

function parseHooksObject(hooksObj = {}, scope, sourcePath) {
  const list = [];
  for (const [hookName, cfg] of Object.entries(hooksObj || {})) {
    if (!cfg || typeof cfg !== 'object') continue;
    const events = [];
    for (const [k, v] of Object.entries(cfg)) {
      if (k === 'enabled' || !Array.isArray(v)) continue;
      for (const rule of v) {
        events.push({
          event: k,
          matcher: rule?.matcher || '*',
          commands: Array.isArray(rule?.hooks) ? rule.hooks.map((h) => h?.command || '').filter(Boolean) : [],
        });
      }
    }
    list.push({
      id: `${scope}:${hookName}`,
      scope,
      sourcePath,
      name: hookName,
      enabled: cfg.enabled !== false,
      events,
      rawConfig: cfg,
    });
  }
  return list;
}

export function scanHooks(masterDir, workspaceDir = '') {
  const masterPath = join(masterDir, 'hooks.json');
  const masterRes = readJsonSafe(masterPath, {});
  const items = masterRes.ok ? parseHooksObject(masterRes.data || {}, 'master', masterPath) : [];
  const scopes = {
    master: {
      path: masterPath,
      exists: masterRes.exists,
      ok: masterRes.ok,
      error: masterRes.error,
      raw: masterRes.raw,
      hasBackup: existsSync(`${masterPath}.bak`),
    },
  };

  if (workspaceDir && resolve(workspaceDir).toLowerCase() !== resolve(masterDir).toLowerCase()) {
    const wsPath = join(workspaceDir, '.agents', 'hooks.json');
    const wsRes = readJsonSafe(wsPath, {});
    if (wsRes.ok) {
      items.push(...parseHooksObject(wsRes.data || {}, 'workspace', wsPath));
    }
    scopes.workspace = {
      path: wsPath,
      exists: wsRes.exists,
      ok: wsRes.ok,
      error: wsRes.error,
      raw: wsRes.raw,
      hasBackup: existsSync(`${wsPath}.bak`),
    };
  }

  return { items, scopes };
}

function scanSkillsDir(skillsDir, scope) {
  if (!skillsDir || !existsSync(skillsDir)) return [];
  const list = [];
  try {
    for (const ent of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
      const skillFile = join(skillsDir, ent.name, 'SKILL.md');
      if (!existsSync(skillFile)) continue;
      const raw = readTextIfExists(skillFile) || '';
      const parsed = parseFrontmatter(raw);
      list.push({
        scope,
        dir: ent.name,
        name: parsed.frontmatter.name || ent.name,
        description: parsed.frontmatter.description || '',
        path: relative(dirname(skillsDir), skillFile).replace(/\\/g, '/'),
        fullPath: skillFile,
      });
    }
  } catch {
    // ignore
  }
  return list.sort((a, b) => a.name.localeCompare(b.name));
}

export function scanSkills(masterDir, workspaceDir = '') {
  const list = [...scanSkillsDir(join(masterDir, 'skills'), 'master')];
  if (workspaceDir && resolve(workspaceDir).toLowerCase() !== resolve(masterDir).toLowerCase()) {
    list.push(...scanSkillsDir(join(workspaceDir, '.agents', 'skills'), 'workspace'));
  }
  return list;
}
