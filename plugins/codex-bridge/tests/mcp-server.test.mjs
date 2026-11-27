import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildCodexArgs,
  captureGitCheckpoint,
  parseCodexJsonlLine,
  quoteCmdArg,
  rollbackCodexJob,
  validateSafeToken,
} from '../server/codex-runner.mjs';
import { readCodexProfile } from '../server/codex-account.mjs';
import { JobStore, normalizeProjectPath } from '../server/job-store.mjs';
import { listAvailableSkills, resolveSkillsPromptBlock } from '../server/skill-resolver.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const SERVER_ENTRY = path.join(PLUGIN_ROOT, 'server', 'index.mjs');

/**
 * 启动一个隔离数据目录的 MCP Server 测试客户端
 * @param {string} dataDir 临时数据目录
 * @returns {{ request: (method: string, params?: object) => Promise<any>, close: () => void }} 客户端句柄
 */
function createMcpTestClient(dataDir) {
  const child = spawn(process.execPath, [SERVER_ENTRY, `--data-dir=${dataDir}`], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const pending = new Map();
  let nextId = 1;

  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const msg = JSON.parse(trimmed);
    const handler = pending.get(msg.id);
    if (handler) {
      pending.delete(msg.id);
      handler(msg);
    }
  });

  const request = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP 请求超时: ${method}`));
      }, 25000);

      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  const close = () => {
    rl.close();
    child.kill();
  };

  return { request, close };
}

test('parseCodexJsonlLine 应准确提取 threadId、命令执行、改动文件与最终回复', () => {
  const started = parseCodexJsonlLine(
    JSON.stringify({ type: 'thread.started', thread_id: 'thr_abc123' }),
  );
  assert.equal(started.threadId, 'thr_abc123');
  assert.equal(started.event.type, 'lifecycle');

  const cmd = parseCodexJsonlLine(
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'command_execution', command: 'npm test' },
    }),
  );
  assert.deepEqual(cmd.commandsRun, ['npm test']);
  assert.equal(cmd.event.type, 'command');

  const fileChange = parseCodexJsonlLine(
    JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'file_change',
        changes: [{ path: 'src/app.ts' }, { path: 'src/utils.ts' }],
      },
    }),
  );
  assert.deepEqual(fileChange.changedFiles, ['src/app.ts', 'src/utils.ts']);

  const reply = parseCodexJsonlLine(
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: '全部测试已通过。' },
    }),
  );
  assert.equal(reply.lastMessage, '全部测试已通过。');
});

test('buildCodexArgs 应正确构造 exec / resume / review 参数并强制 stdin 传参', () => {
  const execArgs = buildCodexArgs({
    kind: 'exec',
    cwd: 'C:\\repo',
    model: 'gpt-5.3-codex',
    reasoningEffort: 'high',
    sandbox: 'workspace-write',
    worktree: true,
    skipGitRepoCheck: true,
    lastMsgFile: 'C:\\tmp\\last.txt',
    hasPrompt: true,
  });
  assert.deepEqual(execArgs, [
    'exec',
    '--json',
    '--sandbox',
    'workspace-write',
    '-C',
    'C:\\repo',
    '-m',
    'gpt-5.3-codex',
    '-c',
    'model_reasoning_effort="high"',
    '--worktree',
    '--skip-git-repo-check',
    '-o',
    'C:\\tmp\\last.txt',
    '-',
  ]);

  const resumeArgs = buildCodexArgs({
    kind: 'resume',
    cwd: 'C:\\repo',
    threadId: 'thr_999',
    lastMsgFile: 'C:\\tmp\\last.txt',
    hasPrompt: true,
  });
  assert.deepEqual(resumeArgs, ['exec', 'resume', '--json', '-o', 'C:\\tmp\\last.txt', 'thr_999', '-']);
});

test('MCP Server 协议握手、双入口元数据、UI 资源、配置持久化与安全护栏端到端验证', async () => {
  const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bridge-test-'));
  const client = createMcpTestClient(tmpDataDir);

  try {
    // 1. initialize
    const initRes = await client.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    });
    assert.equal(initRes.result.serverInfo.name, 'codex-bridge');
    assert.ok(initRes.result.capabilities.tools);
    assert.ok(initRes.result.capabilities.resources);

    // 2. tools/list 校验双入口与可见性分层
    const toolsRes = await client.request('tools/list');
    const tools = toolsRes.result.tools;
    assert.equal(tools.length, 12);
    assert.ok(tools.some((t) => t.name === 'codex_job_rollback'));

    const consoleTool = tools.find((t) => t.name === 'open_codex_console');
    assert.equal(consoleTool._meta.ui.resourceUri, 'ui://codex-bridge/app.html');
    const entryTypes = consoleTool._meta['com.google.antigravity/ui'].entrypoints.map((e) => e.type);
    assert.deepEqual(entryTypes, ['aux_pane', 'global']);

    const saveCfgTool = tools.find((t) => t.name === 'app_save_config');
    assert.deepEqual(saveCfgTool._meta.ui.visibility, ['app']);

    // 3. resources/list 与 resources/read 校验单文件 MCP App HTML
    const listRes = await client.request('resources/list');
    assert.equal(listRes.result.resources[0].uri, 'ui://codex-bridge/app.html');
    assert.equal(listRes.result.resources[0].mimeType, 'text/html;profile=mcp-app');

    const readRes = await client.request('resources/read', { uri: 'ui://codex-bridge/app.html' });
    const html = readRes.result.contents[0].text;
    assert.ok(html.includes('Codex 指挥台'));
    assert.ok(html.length > 1000, '构建后的单文件 HTML 不应为空占位页');

    // 4. 配置持久化读写
    const saveRes = await client.request('tools/call', {
      name: 'app_save_config',
      arguments: {
        config: {
          defaultModel: 'gpt-5.3-codex',
          defaultSandbox: 'read-only',
          defaultTimeoutSec: 420,
        },
      },
    });
    assert.equal(saveRes.result.structuredContent.config.defaultModel, 'gpt-5.3-codex');
    assert.equal(saveRes.result.structuredContent.config.defaultSandbox, 'read-only');

    // 5. 安全护栏：拒绝危险沙箱参数
    const dangerRes = await client.request('tools/call', {
      name: 'codex_exec',
      arguments: {
        cwd: tmpDataDir,
        prompt: 'test',
        sandbox: 'danger-full-access',
      },
    });
    assert.equal(dangerRes.result.isError, true);
    assert.match(dangerRes.result.content[0].text, /不允许的沙箱模式/);

    // 6. 真实调用 codex_doctor 冒烟测试
    const doctorRes = await client.request('tools/call', {
      name: 'codex_doctor',
      arguments: {},
    });
    assert.equal(doctorRes.result.structuredContent.installed, true);
    assert.match(doctorRes.result.structuredContent.version, /codex-cli/i);

    // 7. app_get_dashboard_state 应包含本机 codexProfile（默认模型、账号与用量结构）
    const dashRes = await client.request('tools/call', {
      name: 'app_get_dashboard_state',
      arguments: {},
    });
    assert.ok(dashRes.result.structuredContent.codexProfile);
    assert.equal(typeof dashRes.result.structuredContent.codexProfile.defaultModel, 'string');

    // 8. app_refresh_usage 真实向云端拉取最新 5h/周用量
    const liveRes = await client.request('tools/call', {
      name: 'app_refresh_usage',
      arguments: {},
    });
    assert.equal(liveRes.result.isError, undefined);
    assert.equal(liveRes.result.structuredContent.codexProfile.usage.source, 'live');
    assert.equal(typeof liveRes.result.structuredContent.codexProfile.usage.primary.usedPercent, 'number');
    assert.equal(typeof liveRes.result.structuredContent.codexProfile.usage.secondary.usedPercent, 'number');
  } finally {
    client.close();
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
  }
});

test('readCodexProfile 应安全解析默认模型、登录账号与 5h/周用量且不泄露敏感 token', () => {
  const tmpCodex = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-mock-'));
  try {
    fs.writeFileSync(
      path.join(tmpCodex, 'config.toml'),
      'model = "gpt-6.2-sol"\nmodel_reasoning_effort = "high"\n[desktop]\nmodel = "should-ignore"\n',
      'utf8',
    );
    const fakePayload = Buffer.from(
      JSON.stringify({
        email: 'dev@example.com',
        name: 'Dev User',
        'https://api.openai.com/auth': {
          chatgpt_plan_type: 'plus',
          chatgpt_subscription_active_until: '2026-12-31T00:00:00Z',
        },
      }),
    ).toString('base64url');
    fs.writeFileSync(
      path.join(tmpCodex, 'auth.json'),
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          access_token: 'SECRET_ACCESS_TOKEN_DO_NOT_LEAK',
          id_token: `hdr.${fakePayload}.sig`,
        },
      }),
      'utf8',
    );
    const sessDir = path.join(tmpCodex, 'sessions', '2026', '11');
    fs.mkdirSync(sessDir, { recursive: true });
    const futureSec = Math.floor(Date.now() / 1000) + 7200;
    fs.writeFileSync(
      path.join(sessDir, 'rollout-1.jsonl'),
      `${JSON.stringify({
        timestamp: '2026-11-27T01:00:00Z',
        payload: {
          rate_limits: {
            limit_id: 'codex',
            primary: { used_percent: 42, window_minutes: 300, resets_at: futureSec },
            secondary: { used_percent: 68, window_minutes: 10080, resets_at: futureSec + 86400 },
          },
        },
      })}\n`,
      'utf8',
    );

    const profile = readCodexProfile(tmpCodex);
    assert.equal(profile.defaultModel, 'gpt-6.2-sol');
    assert.equal(profile.reasoningEffort, 'high');
    assert.equal(profile.account.loggedIn, true);
    assert.equal(profile.account.email, 'dev@example.com');
    assert.equal(profile.account.planType, 'plus');
    assert.equal(profile.usage.primary.usedPercent, 42);
    assert.equal(profile.usage.primary.isExpired, false);
    assert.equal(profile.usage.secondary.usedPercent, 68);
    assert.ok(!JSON.stringify(profile).includes('SECRET_ACCESS_TOKEN_DO_NOT_LEAK'));
  } finally {
    fs.rmSync(tmpCodex, { recursive: true, force: true });
  }
});

test('JobStore.waitForJob 应在任务完成时立刻唤醒并返回 gitDiffStat', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-job-wait-'));
  try {
    const store = new JobStore(tmpDir);
    const job = store.createJob({ kind: 'exec', cwd: tmpDir, prompt: 'demo' });
    setTimeout(() => {
      store.finishJob(job.id, 'completed', {
        exitCode: 0,
        changedFiles: ['src/demo.ts'],
        gitDiffStat: ' src/demo.ts | 10 +++++++---\n 1 file changed, 7 insertions(+), 3 deletions(-)',
      });
    }, 80);

    const start = Date.now();
    const waited = await store.waitForJob(job.id, 10);
    const costMs = Date.now() - start;
    assert.equal(waited.status, 'completed');
    assert.deepEqual(waited.changedFiles, ['src/demo.ts']);
    assert.match(waited.gitDiffStat, /1 file changed/);
    assert.ok(costMs < 3000, `应在任务完成时立刻唤醒，实际耗时 ${costMs}ms`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('validateSafeToken 与 quoteCmdArg 应拦截命令注入并正确保护含空格路径', () => {
  assert.doesNotThrow(() => validateSafeToken('gpt-6.2-sol', 'model'));
  assert.doesNotThrow(() => validateSafeToken('feature/fix_123', 'base_branch'));
  assert.throws(() => validateSafeToken('gpt&whoami', 'model'), /非法字符/);
  assert.throws(() => validateSafeToken('main; rm -rf /', 'base_branch'), /非法字符/);

  assert.equal(quoteCmdArg('C:\\My Projects\\app'), '"C:\\My Projects\\app"');
  assert.equal(quoteCmdArg('model_reasoning_effort="high"'), '"model_reasoning_effort=\\"high\\""');
  assert.equal(quoteCmdArg('workspace-write'), 'workspace-write');
});

test('normalizeProjectPath 与 JobStore.deleteJob 应支持按项目筛选清空且兼容路径格式差异', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-proj-filter-'));
  try {
    const store = new JobStore(tmpDir);
    const j1 = store.createJob({ kind: 'exec', cwd: 'D:\\Projects\\AppA\\', prompt: 'a1' });
    const j2 = store.createJob({ kind: 'exec', cwd: 'd:/projects/appa', prompt: 'a2' });
    const j3 = store.createJob({ kind: 'exec', cwd: 'D:\\Projects\\AppB', prompt: 'b1' });
    store.finishJob(j1.id, 'completed', { exitCode: 0 });
    store.finishJob(j2.id, 'completed', { exitCode: 0 });
    store.finishJob(j3.id, 'completed', { exitCode: 0 });

    if (process.platform === 'win32') {
      assert.equal(normalizeProjectPath('D:\\Projects\\AppA\\'), normalizeProjectPath('d:/projects/appa'));
    }

    const delRes = store.deleteJob('ALL_FINISHED', 'D:\\Projects\\AppA');
    assert.equal(delRes.deletedCount, 2);
    const remaining = store.listJobs();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, j3.id);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('skill-resolver 应准确发现技能、注入只读绝对路径且不自动附加 --add-dir', () => {
  const skills = listAvailableSkills();
  const rpxSkill = skills.find((s) => s.name === 'rpx-to-ureport');
  assert.ok(rpxSkill, '应能在本机技能目录发现 rpx-to-ureport');
  assert.ok(rpxSkill.skillMdPath.endsWith('SKILL.md'));
  assert.ok(rpxSkill.scripts.some((p) => p.includes('extract_rpx.py')));

  const resolved = resolveSkillsPromptBlock(['/rpx-to-ureport']);
  assert.deepEqual(resolved.resolvedNames, ['rpx-to-ureport']);
  assert.match(resolved.promptBlock, /\$rpx-to-ureport/);
  assert.match(resolved.promptBlock, /只读/);
  assert.match(resolved.promptBlock, /extract_rpx\.py/);

  // 仅在显式传 addDirs 时才附带 --add-dir
  const argsWithoutAddDir = buildCodexArgs({
    kind: 'exec',
    cwd: 'C:\\repo',
    sandbox: 'workspace-write',
    hasPrompt: true,
  });
  assert.ok(!argsWithoutAddDir.includes('--add-dir'));

  const argsWithAddDir = buildCodexArgs({
    kind: 'exec',
    cwd: 'C:\\repo',
    sandbox: 'workspace-write',
    addDirs: ['C:\\shared-lib'],
    hasPrompt: true,
  });
  assert.ok(argsWithAddDir.includes('--add-dir'));
  assert.ok(argsWithAddDir.includes('C:\\shared-lib'));
});

test('captureGitCheckpoint 与 rollbackCodexJob 应精准回滚改动、保留用户原未提交修改并拦截二次手工修改冲突', async () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-rollback-repo-'));
  const execGit = (args) =>
    new Promise((resolve, reject) => {
      const child = spawn('git', args, { cwd: tmpRepo, windowsHide: true, stdio: 'pipe' });
      let err = '';
      child.stderr.on('data', (c) => (err += c.toString('utf8')));
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err || `git exit ${code}`))));
    });

  try {
    await execGit(['init']);
    await execGit(['config', 'user.email', 'test@example.com']);
    await execGit(['config', 'user.name', 'Test User']);

    const fileA = path.join(tmpRepo, 'a.txt');
    const fileNew = path.join(tmpRepo, 'new-by-gpt.txt');
    fs.writeFileSync(fileA, 'line1-orig\nline2-orig\n', 'utf8');
    await execGit(['add', '.']);
    await execGit(['commit', '-m', 'init']);

    // 模拟用户在任务启动前已经手工修改了 line1（未提交）
    fs.writeFileSync(fileA, 'line1-user-dirty\nline2-orig\n', 'utf8');

    // 1. 拍摄任务前无侵入 Git 快照
    const snap = await captureGitCheckpoint(tmpRepo);
    assert.equal(snap.isGitRepo, true);
    assert.ok(snap.headSha.length >= 7);
    assert.ok(snap.stashSha.length >= 7, '工作区存在未提交改动时应生成悬空 stashSha');

    // 2. 模拟 GPT 修改了 fileA 并新建了 fileNew
    fs.writeFileSync(fileA, 'line1-user-dirty\nline2-by-gpt\n', 'utf8');
    fs.writeFileSync(fileNew, 'created by gpt\n', 'utf8');
    const postMtimes = {
      'a.txt': Math.trunc(fs.statSync(fileA).mtimeMs),
      'new-by-gpt.txt': Math.trunc(fs.statSync(fileNew).mtimeMs),
    };

    const mockJob = {
      id: 'job_test_rb',
      status: 'completed',
      worktree: false,
      rolledBack: false,
      cwd: tmpRepo,
      changedFiles: ['a.txt', 'new-by-gpt.txt'],
      checkpoint: {
        isGitRepo: snap.isGitRepo,
        headSha: snap.headSha,
        stashSha: snap.stashSha,
        preUntrackedFiles: snap.preUntrackedFiles,
        postFileMtimes: postMtimes,
      },
    };

    // 3. 模拟用户在 GPT 完成后又二次修改了 fileA（等待时间戳差异）
    const futureTime = new Date(Date.now() + 5000);
    fs.writeFileSync(fileA, 'line1-user-dirty\nline2-by-gpt-plus-user\n', 'utf8');
    fs.utimesSync(fileA, futureTime, futureTime);

    // 默认非强制回滚必须拦截冲突
    const blocked = await rollbackCodexJob(mockJob, { force: false });
    assert.equal(blocked.rolledBack, false);
    assert.deepEqual(blocked.conflicts, ['a.txt']);

    // 4. 传入 force=true 后精准回滚：保留用户启动前的 line1-user-dirty，撤回 GPT 的 line2，并删除新建文件
    const forced = await rollbackCodexJob(mockJob, { force: true });
    assert.equal(forced.rolledBack, true);
    assert.deepEqual(forced.restoredFiles, ['a.txt']);
    assert.deepEqual(forced.deletedFiles, ['new-by-gpt.txt']);
    assert.equal(
      fs.readFileSync(fileA, 'utf8').replace(/\r\n/g, '\n'),
      'line1-user-dirty\nline2-orig\n',
    );
    assert.equal(fs.existsSync(fileNew), false);

    // 5. Monorepo 子目录作为 cwd 时的快照与精准回滚验证
    const subDir = path.join(tmpRepo, 'packages', 'sub-app');
    fs.mkdirSync(subDir, { recursive: true });
    const subFile = path.join(subDir, 'index.js');
    fs.writeFileSync(subFile, 'export const v = 1;\n', 'utf8');
    await execGit(['add', '.']);
    await execGit(['commit', '-m', 'add sub-app']);

    const subSnap = await captureGitCheckpoint(subDir);
    assert.equal(subSnap.isGitRepo, true);
    assert.ok(subSnap.gitRoot, '子目录快照应解析出仓库根路径 gitRoot');

    fs.writeFileSync(subFile, 'export const v = 2;\n', 'utf8');
    const subJob = {
      id: 'job_test_subdir',
      status: 'completed',
      worktree: false,
      rolledBack: false,
      cwd: subDir,
      changedFiles: ['packages/sub-app/index.js'],
      checkpoint: {
        isGitRepo: subSnap.isGitRepo,
        gitRoot: subSnap.gitRoot,
        headSha: subSnap.headSha,
        stashSha: subSnap.stashSha,
        preUntrackedFiles: subSnap.preUntrackedFiles,
        postFileMtimes: {
          'packages/sub-app/index.js': Math.trunc(fs.statSync(subFile).mtimeMs),
        },
      },
    };
    const subRollback = await rollbackCodexJob(subJob, { force: false });
    assert.equal(subRollback.rolledBack, true);
    assert.equal(
      fs.readFileSync(subFile, 'utf8').replace(/\r\n/g, '\n'),
      'export const v = 1;\n',
    );
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test('JobStore 与 open_codex_console 应支持按对话 ID 隔离清理、返工继承与透传', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-conv-iso-'));
  const client = createMcpTestClient(tmpDir);
  try {
    const store = new JobStore(tmpDir);
    const jA = store.createJob({
      kind: 'exec',
      cwd: 'D:\\Projects\\SameApp',
      conversationId: 'conv_alpha',
      conversationTitle: '修复登录 Bug',
      threadId: 'thr_alpha_1',
      prompt: 'a',
    });
    const jB = store.createJob({
      kind: 'exec',
      cwd: 'D:\\Projects\\SameApp',
      conversationId: 'conv_beta',
      conversationTitle: '报表改造',
      threadId: 'thr_beta_1',
      prompt: 'b',
    });
    store.finishJob(jA.id, 'completed', { exitCode: 0, threadId: 'thr_alpha_1' });
    store.finishJob(jB.id, 'completed', { exitCode: 0, threadId: 'thr_beta_1' });

    // 验证 findJobByThreadId 可准确找到原对话用于 codex_resume 继承
    const found = store.findJobByThreadId('thr_alpha_1');
    assert.equal(found?.conversationId, 'conv_alpha');
    assert.equal(found?.conversationTitle, '修复登录 Bug');

    // 同一个项目下仅清理 conv_alpha，不应影响 conv_beta
    const delRes = store.deleteJob('ALL_FINISHED', { conversationId: 'conv_alpha' });
    assert.equal(delRes.deletedCount, 1);
    const left = store.listJobs();
    assert.equal(left.length, 1);
    assert.equal(left[0].id, jB.id);

    // 验证 open_codex_console 正确透传 activeConversationId 与 activeConversationTitle
    const openRes = await client.request('tools/call', {
      name: 'open_codex_console',
      arguments: {
        focusTab: 'monitor',
        cwd: 'D:\\Projects\\SameApp',
        conversation_id: 'conv_beta',
        conversation_title: '报表改造',
      },
    });
    assert.equal(openRes.result.structuredContent.activeConversationId, 'conv_beta');
    assert.equal(openRes.result.structuredContent.activeConversationTitle, '报表改造');
  } finally {
    client.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('全局空参数打开不伪造当前项目，open_codex_console 可补绑无对话任务，且支持多目录分组清理', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-global-group-'));
  // 先预先在磁盘写入 3 条测试任务，再启动 MCP Server 检验读取、补绑与分组清理
  const seedStore = new JobStore(tmpDir);
  const jUnbound = seedStore.createJob({
    kind: 'exec',
    cwd: 'D:\\Work\\changjia\\applets',
    prompt: 'applets task',
  });
  const jSibling = seedStore.createJob({
    kind: 'exec',
    cwd: 'D:\\Work\\changjia\\CheYongRanQiServer',
    conversationId: 'conv_other',
    prompt: 'server task',
  });
  const jOtherProj = seedStore.createJob({
    kind: 'exec',
    cwd: 'D:\\Work\\game1',
    conversationId: 'conv_game',
    prompt: 'game task',
  });
  seedStore.finishJob(jUnbound.id, 'completed', { exitCode: 0 });
  seedStore.finishJob(jSibling.id, 'completed', { exitCode: 0 });
  seedStore.finishJob(jOtherProj.id, 'completed', { exitCode: 0 });

  const client = createMcpTestClient(tmpDir);
  try {
    // 1. 全局空参数打开：不应把最近任务目录伪造为 activeProjectCwd
    const globalOpen = await client.request('tools/call', {
      name: 'open_codex_console',
      arguments: {},
    });
    assert.equal(globalOpen.result.structuredContent.activeProjectCwd, '');

    // 2. open_codex_console 传入 jobId + conversation_id 时，自动为原无 conversationId 的任务补绑
    const bindOpen = await client.request('tools/call', {
      name: 'open_codex_console',
      arguments: {
        jobId: jUnbound.id,
        conversation_id: 'conv_bound',
        conversation_title: '补绑测试',
      },
    });
    const boundJob = bindOpen.result.structuredContent.jobs.find((j) => j.id === jUnbound.id);
    assert.equal(boundJob?.conversationId, 'conv_bound');
    assert.equal(boundJob?.conversationTitle, '补绑测试');

    // 已绑定 conversationId 的任务不应被二次误覆盖
    const retryOpen = await client.request('tools/call', {
      name: 'open_codex_console',
      arguments: {
        jobId: jSibling.id,
        conversation_id: 'conv_hijack',
      },
    });
    const untouchedJob = retryOpen.result.structuredContent.jobs.find((j) => j.id === jSibling.id);
    assert.equal(untouchedJob?.conversationId, 'conv_other');

    // 3. 多文件夹分组批量清理（cwds 数组）：一次性清空 changjia 下两个子目录，保留 game1
    const delRes = await client.request('tools/call', {
      name: 'app_delete_job',
      arguments: {
        job_id: 'ALL_FINISHED',
        cwds: ['D:\\Work\\changjia\\applets', 'D:\\Work\\changjia\\CheYongRanQiServer'],
      },
    });
    assert.equal(delRes.result.structuredContent.deletedCount, 2);
    assert.equal(delRes.result.structuredContent.jobs.length, 1);
    assert.equal(delRes.result.structuredContent.jobs[0].id, jOtherProj.id);

    // 4. 验证 conversation_id 与 job_ids 联合清理，以及 projectName 大小写不敏感清理
    const localStore = new JobStore(tmpDir);
    const jLoose = localStore.createJob({
      kind: 'exec',
      cwd: 'D:\\Work\\misc',
      prompt: 'unbound job',
    });
    const jNamed = localStore.createJob({
      kind: 'exec',
      cwd: 'D:\\Work\\other-dir',
      projectName: 'ChangJia',
      prompt: 'named project job',
    });
    localStore.finishJob(jLoose.id, 'completed', { exitCode: 0 });
    localStore.finishJob(jNamed.id, 'completed', { exitCode: 0 });

    const unionDel = localStore.deleteJob('ALL_FINISHED', {
      conversationId: 'pane_temp_1',
      jobIds: [jLoose.id],
    });
    assert.equal(unionDel.deletedCount, 1);
    assert.equal(localStore.getJob(jLoose.id), null);

    const caseInsensitiveDel = localStore.deleteJob('ALL_FINISHED', {
      projectName: 'changjia',
    });
    assert.equal(caseInsensitiveDel.deletedCount, 1);
    assert.equal(localStore.getJob(jNamed.id), null);

    // 5. 验证已结束任务的 codex_job_status 返回文本不应冗余附带 open_codex_console 同步提示
    const statusRes = await client.request('tools/call', {
      name: 'codex_job_status',
      arguments: { job_id: jOtherProj.id },
    });
    const statusText = statusRes.result.content?.[0]?.text || '';
    assert.equal(statusText.includes('下一步同步监控'), false);
  } finally {
    client.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
