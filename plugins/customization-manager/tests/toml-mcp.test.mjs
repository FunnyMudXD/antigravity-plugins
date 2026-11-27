import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mergeTomlMcpServers,
  parseTomlMcpServers,
} from '../sidecars/manager_ui/lib/toml-mcp.mjs';

test('mergeTomlMcpServers preserves existing non-MCP settings and comments', () => {
  const existing = `# Global Codex settings
model = "gpt-5-codex"
approval_policy = "on-request"

[mcp_servers.old_server]
command = "node"
args = ["old.js"]

[projects."D:\\\\work\\\\demo"]
trust_level = "trusted"
`;

  const updated = mergeTomlMcpServers(existing, {
    'my-sqlite': {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sqlite', 'D:\\data\\app.db'],
      env: { DB_READONLY: 'true' },
    },
    remote_api: {
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer abc' },
    },
  });

  assert.ok(updated.includes('model = "gpt-5-codex"'));
  assert.ok(updated.includes('approval_policy = "on-request"'));
  assert.ok(updated.includes('[projects."D:\\\\work\\\\demo"]'));
  assert.equal(updated.includes('old_server'), false);

  const parsed = parseTomlMcpServers(updated);
  assert.equal(parsed['my-sqlite'].command, 'npx');
  assert.deepEqual(parsed['my-sqlite'].args, [
    '-y',
    '@modelcontextprotocol/server-sqlite',
    'D:\\data\\app.db',
  ]);
  assert.equal(parsed['my-sqlite'].env.DB_READONLY, 'true');
  assert.equal(parsed.remote_api.url, 'https://mcp.example.com/mcp');
  assert.equal(parsed.remote_api.headers.Authorization, 'Bearer abc');
});
