import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  applyTarget,
  buildMasterBundle,
  inspectTarget,
  rollbackTarget,
} from '../sidecars/manager_ui/lib/linker.mjs';

test('linker handles dryRun, partial JSON/TOML merge, hardlink, junction, and rollback', () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-cm-link-'));
  const prevHome = process.env.AGY_CM_HOME_DIR;
  const prevCfg = process.env.AGY_CM_CONFIG_DIR;
  const prevData = process.env.AGY_CM_DATA_DIR;

  const masterDir = join(root, '.gemini', 'config');
  process.env.AGY_CM_HOME_DIR = root;
  process.env.AGY_CM_CONFIG_DIR = masterDir;
  process.env.AGY_CM_DATA_DIR = join(root, 'data');

  try {
    mkdirSync(join(masterDir, 'rules'), { recursive: true });
    mkdirSync(join(masterDir, 'skills', 'demo-skill'), { recursive: true });
    writeFileSync(join(masterDir, 'GEMINI.md'), '# Global Rule\nUse Chinese.\n', 'utf-8');
    writeFileSync(
      join(masterDir, 'rules', 'always.md'),
      '---\ntrigger: always_on\n---\nAlways check tests.\n',
      'utf-8',
    );
    writeFileSync(
      join(masterDir, 'mcp_config.json'),
      JSON.stringify({
        mcpServers: {
          sqlite: { command: 'npx', args: ['-y', 'sqlite-mcp'], env: { READONLY: '1' } },
        },
      }),
      'utf-8',
    );

    const claudeJson = join(root, '.claude.json');
    writeFileSync(claudeJson, JSON.stringify({ numStartups: 12, theme: 'dark' }), 'utf-8');

    const codexToml = join(root, '.codex', 'config.toml');
    mkdirSync(join(root, '.codex'), { recursive: true });
    writeFileSync(codexToml, 'model = "gpt-5-codex"\n', 'utf-8');

    const bundle = buildMasterBundle(masterDir);
    assert.ok(bundle.rulesText.includes('Use Chinese.'));
    assert.ok(bundle.rulesText.includes('Always check tests.'));

    const allowedRoots = [masterDir, root];

    // 1. Master self detection
    const selfIns = inspectTarget(
      { id: 'self', kind: 'rules', targetPath: join(masterDir, 'GEMINI.md'), mode: 'sync-replace' },
      bundle,
    );
    assert.equal(selfIns.status, 'master_self');

    // 2. Claude partial JSON merge (dryRun first, then apply + rollback)
    const claudeTarget = {
      id: 'claude-mcp',
      name: 'Claude MCP',
      kind: 'mcp',
      targetPath: claudeJson,
      mode: 'sync-merge-json',
      mergeKey: 'mcpServers',
    };
    const dry = applyTarget(claudeTarget, bundle, allowedRoots, { dryRun: true });
    assert.equal(dry.ok, true);
    assert.equal(dry.inspected.diff.changed, true);
    assert.equal(JSON.parse(readFileSync(claudeJson, 'utf-8')).mcpServers, undefined);

    const appliedClaude = applyTarget(claudeTarget, bundle, allowedRoots);
    assert.equal(appliedClaude.ok, true);
    const claudeParsed = JSON.parse(readFileSync(claudeJson, 'utf-8'));
    assert.equal(claudeParsed.numStartups, 12);
    assert.equal(claudeParsed.mcpServers.sqlite.command, 'npx');

    rollbackTarget(claudeTarget, allowedRoots);
    assert.equal(JSON.parse(readFileSync(claudeJson, 'utf-8')).mcpServers, undefined);

    // 3. Codex partial TOML merge
    const codexTarget = {
      id: 'codex-mcp',
      name: 'Codex MCP',
      kind: 'mcp',
      targetPath: codexToml,
      mode: 'sync-merge-toml',
    };
    applyTarget(codexTarget, bundle, allowedRoots);
    const codexAfter = readFileSync(codexToml, 'utf-8');
    assert.ok(codexAfter.includes('model = "gpt-5-codex"'));
    assert.ok(codexAfter.includes('[mcp_servers.sqlite]'));

    // 4. HardLink rules
    const hlPath = join(root, '.codex', 'AGENTS.md');
    const hlTarget = {
      id: 'codex-rules',
      name: 'Codex Rules',
      kind: 'rules',
      targetPath: hlPath,
      mode: 'hardlink',
    };
    const hlRes = applyTarget(hlTarget, bundle, allowedRoots);
    assert.equal(hlRes.ok, true);
    assert.equal(hlRes.inspected.status, 'linked');

    // 5. Directory Junction for skills
    const juncPath = join(root, '.codex', 'skills');
    const juncTarget = {
      id: 'codex-skills',
      name: 'Codex Skills',
      kind: 'skills_dir',
      targetPath: juncPath,
      mode: 'junction',
    };
    const jRes = applyTarget(juncTarget, bundle, allowedRoots);
    assert.equal(jRes.ok, true);
    assert.equal(jRes.inspected.status, 'linked');
    assert.equal(existsSync(join(juncPath, 'demo-skill')), true);
  } finally {
    process.env.AGY_CM_HOME_DIR = prevHome;
    process.env.AGY_CM_CONFIG_DIR = prevCfg;
    process.env.AGY_CM_DATA_DIR = prevData;
    rmSync(root, { recursive: true, force: true });
  }
});
