/**
 * Antigravity Language Server Connect RPC client (read-only inventory + RefreshMcpServers).
 */

function getLsAddress() {
  return process.env.ANTIGRAVITY_LS_ADDRESS || 'localhost:5387';
}

function getCsrfToken() {
  return process.env.ANTIGRAVITY_CSRF_TOKEN || '';
}

async function callLsRpc(method, body = {}) {
  const addr = getLsAddress();
  const csrf = getCsrfToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);

  try {
    const res = await fetch(
      `http://${addr}/exa.language_server_pb.LanguageServerService/${method}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(csrf ? { 'x-codeium-csrf-token': csrf } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `HTTP ${res.status}: ${text || res.statusText}` };
    }
    const json = await res.json().catch(() => ({}));
    return { ok: true, data: json };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchInstalledPluginsInventory(workspacePath = '') {
  const workspaceUris = workspacePath
    ? [`file:///${workspacePath.replace(/\\/g, '/').replace(/^\/+/, '')}`]
    : [];
  const res = await callLsRpc('GetAllPlugins', workspaceUris.length ? { workspaceUris } : {});
  if (!res.ok) {
    return { available: false, error: res.error, plugins: [] };
  }

  const rawPlugins = Array.isArray(res.data?.plugins) ? res.data.plugins : [];
  const plugins = rawPlugins.map((p) => {
    const rawPath = String(p.path || '');
    const cleanPath = rawPath.replace(/^file:\/\//i, '');
    const parts = cleanPath.split(/[/\\]/).filter(Boolean);
    const dir = parts.length ? parts[parts.length - 1] : p.name || '';
    return {
      name: p.name || dir,
      displayName: p.displayName || p.name || dir,
      dir,
      path: cleanPath,
      disabled: Boolean(p.disabled),
      isGlobal: Boolean(p.isGlobal),
      isBuiltin: cleanPath.toLowerCase().includes('/builtin/plugins/') || cleanPath.toLowerCase().includes('\\builtin\\plugins\\'),
      skills: (p.skills || []).map((s) => s.name).filter(Boolean),
      agents: (p.agents || []).map((a) => a.agent?.name).filter(Boolean),
      rules: (p.rules || []).map((r) => r.absolutePath).filter(Boolean),
      hasHooks: Boolean(p.hooksJson && String(p.hooksJson).trim().length > 0),
      mcpServers: (p.mcpServers || []).map((m) => m.name).filter(Boolean),
    };
  });

  return { available: true, error: null, plugins };
}

export async function refreshMcpServerRpc(serverName = '') {
  const payload = serverName ? { serverName } : {};
  return callLsRpc('RefreshMcpServers', payload);
}
