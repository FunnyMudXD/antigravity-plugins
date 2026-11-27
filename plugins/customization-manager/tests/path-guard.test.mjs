import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  assertAllowedPath,
  backupAndDeleteFile,
  backupAndWriteText,
  rollbackFromBackup,
} from '../sidecars/manager_ui/lib/path-guard.mjs';

test('path-guard blocks outside paths, traversal, and host config.json', () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-cm-pg-'));
  const prevCfg = process.env.AGY_CM_CONFIG_DIR;
  process.env.AGY_CM_CONFIG_DIR = join(root, 'config');
  try {
    const allowed = [join(root, 'config')];
    assert.throws(() => assertAllowedPath(join(root, 'outside.txt'), allowed));
    assert.throws(() => assertAllowedPath(join(root, 'config', '..', 'outside.txt'), allowed));
    assert.throws(() => assertAllowedPath(join(root, 'config', 'config.json'), allowed));
    const okPath = assertAllowedPath(join(root, 'config', 'rules', 'test.md'), allowed);
    assert.ok(okPath.endsWith('test.md'));
  } finally {
    process.env.AGY_CM_CONFIG_DIR = prevCfg;
    rmSync(root, { recursive: true, force: true });
  }
});

test('backupAndWriteText creates .bak on overwrite and rollbackFromBackup restores it', () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-cm-bak-'));
  try {
    const file = join(root, 'GEMINI.md');
    const first = backupAndWriteText(file, 'v1\n', [root]);
    assert.equal(first.changed, true);
    assert.equal(first.backupCreated, false);

    const same = backupAndWriteText(file, 'v1\n', [root]);
    assert.equal(same.changed, false);

    const second = backupAndWriteText(file, 'v2\n', [root]);
    assert.equal(second.changed, true);
    assert.equal(second.backupCreated, true);
    assert.equal(readFileSync(`${file}.bak`, 'utf-8'), 'v1\n');

    rollbackFromBackup(file, [root]);
    assert.equal(readFileSync(file, 'utf-8'), 'v1\n');

    const del = backupAndDeleteFile(file, [root]);
    assert.equal(del.deleted, true);
    assert.equal(existsSync(file), false);
    assert.equal(readFileSync(`${file}.bak`, 'utf-8'), 'v1\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
