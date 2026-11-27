/**
 * Zero-dependency surgical parser & updater for Codex config.toml [mcp_servers.*] sections.
 * Preserves all non-MCP settings, sections, and comments untouched.
 */

const BARE_KEY_RE = /^[A-Za-z0-9_-]+$/;
const SECTION_HEADER_RE = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/;

function formatTomlKey(key) {
  if (BARE_KEY_RE.test(key)) return key;
  return `"${String(key).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function formatTomlString(val) {
  return `"${String(val)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')}"`;
}

function formatTomlValue(val) {
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'number' && Number.isFinite(val)) return String(val);
  if (Array.isArray(val)) {
    return `[${val.map((item) => formatTomlValue(item)).join(', ')}]`;
  }
  return formatTomlString(val == null ? '' : String(val));
}

function splitSectionPath(headerInner) {
  const parts = [];
  let cur = '';
  let quote = null;
  let escape = false;
  for (let i = 0; i < headerInner.length; i++) {
    const ch = headerInner[i];
    if (escape) {
      cur += ch;
      escape = false;
      continue;
    }
    if (quote === '"' && ch === '\\') {
      escape = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '.') {
      parts.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim() || parts.length) {
    parts.push(cur.trim());
  }
  return parts;
}

function stripInlineComment(line) {
  let quote = null;
  let escape = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (quote === '"' && ch === '\\') {
      escape = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#') {
      return line.slice(0, i).trim();
    }
  }
  return line.trim();
}

function parseTomlStringToken(raw) {
  const s = raw.trim();
  if (s.startsWith('"') && s.endsWith('"')) {
    const inner = s.slice(1, -1);
    let out = '';
    for (let i = 0; i < inner.length; i++) {
      if (inner[i] === '\\' && i + 1 < inner.length) {
        const next = inner[++i];
        if (next === 'n') out += '\n';
        else if (next === 'r') out += '\r';
        else if (next === 't') out += '\t';
        else if (next === '\\') out += '\\';
        else if (next === '"') out += '"';
        else out += next;
      } else {
        out += inner[i];
      }
    }
    return out;
  }
  if (s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1);
  }
  return s;
}

function parseTomlValue(raw) {
  const s = raw.trim();
  if (!s) return '';
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return parseTomlStringToken(s);
  }
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    const items = [];
    let cur = '';
    let quote = null;
    let escape = false;
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (escape) {
        cur += ch;
        escape = false;
        continue;
      }
      if (quote === '"' && ch === '\\') {
        cur += ch;
        escape = true;
        continue;
      }
      if (quote) {
        cur += ch;
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        cur += ch;
        continue;
      }
      if (ch === ',') {
        if (cur.trim()) items.push(parseTomlValue(cur));
        cur = '';
        continue;
      }
      cur += ch;
    }
    if (cur.trim()) items.push(parseTomlValue(cur));
    return items;
  }
  return s;
}

/**
 * Parse [mcp_servers.<name>] sections from a Codex config.toml string.
 */
export function parseTomlMcpServers(tomlText = '') {
  const servers = {};
  const lines = String(tomlText || '').split(/\r?\n/);
  let currentServer = null;
  let currentSubtable = null; // null | 'env' | 'http_headers'

  for (const rawLine of lines) {
    const clean = stripInlineComment(rawLine);
    if (!clean) continue;

    const secMatch = clean.match(SECTION_HEADER_RE);
    if (secMatch) {
      const parts = splitSectionPath(secMatch[1]);
      if (parts[0] === 'mcp_servers' && parts[1]) {
        currentServer = parts[1];
        currentSubtable = parts[2] || null;
        if (!servers[currentServer]) servers[currentServer] = {};
        if (currentSubtable === 'env' && !servers[currentServer].env) {
          servers[currentServer].env = {};
        }
        if (currentSubtable === 'http_headers' && !servers[currentServer].headers) {
          servers[currentServer].headers = {};
        }
      } else {
        currentServer = null;
        currentSubtable = null;
      }
      continue;
    }

    if (!currentServer) continue;
    const eqIdx = clean.indexOf('=');
    if (eqIdx === -1) continue;
    const rawKey = clean.slice(0, eqIdx).trim();
    const key = rawKey.startsWith('"') || rawKey.startsWith("'") ? parseTomlStringToken(rawKey) : rawKey;
    const val = parseTomlValue(clean.slice(eqIdx + 1));

    if (currentSubtable === 'env') {
      servers[currentServer].env[key] = String(val);
    } else if (currentSubtable === 'http_headers') {
      servers[currentServer].headers[key] = String(val);
    } else if (!currentSubtable) {
      if (key === 'command') servers[currentServer].command = String(val);
      else if (key === 'args') servers[currentServer].args = Array.isArray(val) ? val.map(String) : [];
      else if (key === 'url') servers[currentServer].url = String(val);
      else if (key === 'enabled') servers[currentServer].enabled = Boolean(val);
      else servers[currentServer][key] = val;
    }
  }

  return servers;
}

/**
 * Serialize a map of MCP servers to Codex TOML [mcp_servers.*] blocks.
 */
export function serializeTomlMcpServers(mcpServersMap = {}) {
  const entries = Object.entries(mcpServersMap || {});
  if (!entries.length) return '';

  const blocks = [];
  for (const [name, cfg] of entries) {
    if (!cfg || typeof cfg !== 'object') continue;
    const key = formatTomlKey(name);
    const lines = [`[mcp_servers.${key}]`];

    const url = cfg.url || cfg.serverUrl;
    if (cfg.command) {
      lines.push(`command = ${formatTomlValue(cfg.command)}`);
      if (Array.isArray(cfg.args) && cfg.args.length) {
        lines.push(`args = ${formatTomlValue(cfg.args.map(String))}`);
      }
    } else if (url) {
      lines.push(`url = ${formatTomlValue(url)}`);
    }

    if (cfg.disabled === true) {
      lines.push('enabled = false');
    }

    if (cfg.env && typeof cfg.env === 'object' && Object.keys(cfg.env).length) {
      lines.push('');
      lines.push(`[mcp_servers.${key}.env]`);
      for (const [ek, ev] of Object.entries(cfg.env)) {
        lines.push(`${formatTomlKey(ek)} = ${formatTomlValue(String(ev ?? ''))}`);
      }
    }

    if (cfg.headers && typeof cfg.headers === 'object' && Object.keys(cfg.headers).length) {
      lines.push('');
      lines.push(`[mcp_servers.${key}.http_headers]`);
      for (const [hk, hv] of Object.entries(cfg.headers)) {
        lines.push(`${formatTomlKey(hk)} = ${formatTomlValue(String(hv ?? ''))}`);
      }
    }

    blocks.push(lines.join('\n'));
  }

  return blocks.join('\n\n');
}

/**
 * Replace only [mcp_servers.*] sections in existingTomlText while keeping all other
 * sections, comments, and settings intact.
 */
export function mergeTomlMcpServers(existingTomlText = '', mcpServersMap = {}) {
  const lines = String(existingTomlText || '').split(/\r?\n/);
  const kept = [];
  let inMcpSection = false;

  for (const line of lines) {
    const clean = stripInlineComment(line);
    const secMatch = clean.match(SECTION_HEADER_RE);
    if (secMatch) {
      const parts = splitSectionPath(secMatch[1]);
      inMcpSection = parts[0] === 'mcp_servers';
    }
    if (!inMcpSection) {
      kept.push(line);
    }
  }

  while (kept.length && kept[kept.length - 1].trim() === '') {
    kept.pop();
  }

  const serializedMcp = serializeTomlMcpServers(mcpServersMap);
  if (!serializedMcp) {
    return kept.length ? `${kept.join('\n')}\n` : '';
  }
  if (!kept.length) {
    return `${serializedMcp}\n`;
  }
  return `${kept.join('\n')}\n\n${serializedMcp}\n`;
}
