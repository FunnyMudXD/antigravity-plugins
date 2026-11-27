import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  parseFrontmatter,
  scanMcp,
  scanRules,
  serializeRuleMarkdown,
} from '../sidecars/manager_ui/lib/scanner.mjs';

test('serializeRuleMarkdown and parseFrontmatter round-trip triggers cleanly', () => {
  const md = serializeRuleMarkdown({
    isStandalone: false,
    trigger: 'glob',
    description: 'TypeScript rules',
    globs: '*.ts, *.tsx',
    body: '# TS\nUse strict mode.',
  });
  const parsed = parseFrontmatter(md);
  assert.equal(parsed.hasFrontmatter, true);
  assert.equal(parsed.frontmatter.trigger, 'glob');
  assert.equal(parsed.frontmatter.globs, '*.ts, *.tsx');
  assert.ok(parsed.body.includes('Use strict mode.'));

  const standalone = serializeRuleMarkdown({
    isStandalone: true,
    trigger: 'always_on',
    body: '# Global',
  });
  assert.equal(standalone.startsWith('---'), false);
});

test('scanRules expands includes safely and flags >24KB, scanMcp flags /sse', () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-cm-scan-'));
  try {
    mkdirSync(join(root, 'rules'), { recursive: true });
    writeFileSync(join(root, 'shared.md'), 'A'.repeat(25_000), 'utf-8');
    writeFileSync(join(root, 'GEMINI.md'), '# Main\n@[shared](shared.md)\n', 'utf-8');
    writeFileSync(
      join(root, 'rules', 'api.md'),
      '---\ntrigger: manual\n---\n# API\n',
      'utf-8',
    );
    writeFileSync(
      join(root, 'mcp_config.json'),
      JSON.stringify({ mcpServers: { legacy: { url: 'https://x.com/sse' } } }),
      'utf-8',
    );

    const rulesRes = scanRules(root, '', [root]);
    const main = rulesRes.items.find((r) => r.fileName === 'GEMINI.md');
    assert.ok(main);
    assert.equal(main.overByteLimit, true);
    assert.ok(rulesRes.budget.alwaysOnTokens > 0);

    const mcpRes = scanMcp(root);
    assert.equal(mcpRes.items.length, 1);
    assert.ok(mcpRes.items[0].warnings.includes('legacy_sse_unsupported'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
