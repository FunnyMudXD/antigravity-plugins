import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ALLOWED_SANDBOX_MODES, clampTimeout } from './config-store.mjs';

/** 允许透传的推理强度枚举 */
export const ALLOWED_REASONING_EFFORTS = ['low', 'medium', 'high'];

/** 允许出现在模型名、分支名、Commit SHA、Thread ID 中的安全字符白名单 */
const SAFE_TOKEN_PATTERN = /^[a-zA-Z0-9._:/@~^-]+$/;

/**
 * 校验 CLI 标识符参数是否仅包含安全字符，防止命令注入或参数截断
 * @param {string|undefined} value 待校验参数值
 * @param {string} fieldName 字段名（用于错误提示）
 */
export function validateSafeToken(value, fieldName) {
  if (!value) return;
  const trimmed = String(value).trim();
  if (!trimmed) return;
  if (!SAFE_TOKEN_PATTERN.test(trimmed)) {
    throw new Error(`参数 ${fieldName} 包含非法字符: "${trimmed}"`);
  }
}

/**
 * 对传入 Windows cmd.exe 的单个参数进行安全引用与转义，保护含空格路径与嵌套双引号
 * @param {string} arg 原始参数
 * @returns {string} 转义后的参数字符串
 */
export function quoteCmdArg(arg) {
  const str = String(arg);
  if (!str) return '""';
  // 仅包含安全字符且无空格时直接返回
  if (/^[a-zA-Z0-9._:/\\@~^=-]+$/.test(str)) {
    return str;
  }
  // 用双引号包裹，并将内部双引号转为 \"，同时转义 cmd 环境变量百分号
  const escaped = str.replace(/"/g, '\\"').replace(/%/g, '%%');
  return `"${escaped}"`;
}

/**
 * 解析本机 codex 可执行命令名称或路径
 * @returns {string} 可执行命令字符串
 */
export function resolveCodexBinary() {
  if (process.env.CODEX_CLI_PATH && process.env.CODEX_CLI_PATH.trim()) {
    return process.env.CODEX_CLI_PATH.trim();
  }
  return process.platform === 'win32' ? 'codex.cmd' : 'codex';
}

/**
 * 跨平台启动 codex 子进程（Windows 下通过 cmd.exe /d /s /c + 安全转义，规避含空格路径截断与 DEP0190 警告）
 * @param {string[]} args 传给 codex 的参数数组
 * @param {object} options spawn 选项（如 cwd）
 * @returns {import('node:child_process').ChildProcess} 子进程实例
 */
export function spawnCodex(args, options = {}) {
  const binary = resolveCodexBinary();
  const isWinCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(binary);

  if (isWinCmd) {
    const cmdLine = `"${[quoteCmdArg(binary), ...args.map(quoteCmdArg)].join(' ')}"`;
    return spawn('cmd.exe', ['/d', '/s', '/c', cmdLine], {
      ...options,
      shell: false,
      windowsVerbatimArguments: true,
      windowsHide: true,
    });
  }

  return spawn(binary, args, {
    ...options,
    shell: false,
    windowsHide: true,
  });
}

/**
 * 收集一次性短命令的 stdout/stderr 输出
 * @param {string[]} args 参数数组
 * @param {number} timeoutMs 超时毫秒数
 * @returns {Promise<{ exitCode: number|null, stdout: string, stderr: string, error?: string }>} 执行结果
 */
function runQuickCodexCommand(args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const child = spawnCodex(args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (child.pid && process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } else {
        try {
          child.kill('SIGTERM');
        } catch {
          // 忽略退出异常
        }
      }
      resolve({ exitCode: null, stdout, stderr, error: `命令超时（>${timeoutMs}ms）` });
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr, error: err.message });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr });
    });
  });
}

/**
 * 检查本机 codex-cli 安装状态、版本号与 doctor 诊断信息
 * @returns {Promise<object>} 诊断报告对象
 */
export async function runCodexDoctor() {
  const binary = resolveCodexBinary();
  const versionRes = await runQuickCodexCommand(['--version'], 12000);
  const versionLine = `${versionRes.stdout}\n${versionRes.stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /codex-cli\s+\d+/i.test(line));

  if (versionRes.error || (versionRes.exitCode !== 0 && !versionLine)) {
    return {
      installed: false,
      binary,
      version: '',
      healthy: false,
      doctorOutput: versionRes.error || versionRes.stderr || versionRes.stdout || '无法执行 codex 命令',
    };
  }

  const doctorRes = await runQuickCodexCommand(['doctor'], 20000);
  const combinedDoctor = [doctorRes.stdout, doctorRes.stderr].filter(Boolean).join('\n').trim();

  return {
    installed: true,
    binary,
    version: versionLine || versionRes.stdout.trim(),
    healthy: doctorRes.exitCode === 0,
    doctorOutput: combinedDoctor || 'codex doctor 执行完成，无额外输出',
  };
}

/**
 * 解析单行 `codex exec --json` 的 JSONL 事件，提取 threadId、步骤摘要、命令与改动文件
 * @param {string} line 单行 stdout 文本
 * @returns {object|null} 解析出的结构化信息，非 JSON 行返回 null
 */
export function parseCodexJsonlLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed.startsWith('{')) return null;

  let data;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const result = {
    threadId: '',
    lastMessage: '',
    changedFiles: [],
    commandsRun: [],
    event: null,
  };

  // 提取会话线程 ID（兼容不同版本 codex-cli 的字段命名）
  const candidateThreadId =
    data.thread_id || data.session_id || data.thread?.id || data.conversation_id || '';
  if (typeof candidateThreadId === 'string' && candidateThreadId.trim()) {
    result.threadId = candidateThreadId.trim();
  }

  const eventType = String(data.type || '');
  const item = data.item || data.payload || {};
  const itemType = String(item.type || '');

  // 提取文件变更路径
  const collectPaths = (changes) => {
    if (!Array.isArray(changes)) return;
    for (const change of changes) {
      const p = change?.path || change?.file || change?.file_path;
      if (typeof p === 'string' && p.trim()) {
        result.changedFiles.push(p.trim());
      }
    }
  };
  collectPaths(item.changes);
  collectPaths(data.changes);
  if (typeof item.path === 'string' && item.path.trim() && /file|patch|edit/i.test(itemType)) {
    result.changedFiles.push(item.path.trim());
  }

  // 识别命令执行事件
  if (itemType === 'command_execution' || itemType === 'local_shell_call' || item.command) {
    const cmd = Array.isArray(item.command) ? item.command.join(' ') : String(item.command || '');
    if (cmd.trim()) {
      result.commandsRun.push(cmd.trim());
      result.event = {
        type: 'command',
        title: eventType.includes('completed') ? '命令执行完成' : '执行终端命令',
        detail: cmd.trim(),
      };
    }
  } else if (itemType === 'file_change' || result.changedFiles.length > 0) {
    result.event = {
      type: 'file',
      title: '修改工作区文件',
      detail: result.changedFiles.join(', ') || '文件变更已应用',
    };
  } else if (
    itemType === 'agent_message' ||
    itemType === 'message' ||
    eventType === 'agent_message'
  ) {
    const text = extractTextFromItem(item) || extractTextFromItem(data);
    if (text) {
      result.lastMessage = text;
      result.event = {
        type: 'message',
        title: 'Codex 输出回复',
        detail: text.slice(0, 200),
      };
    }
  } else if (itemType === 'reasoning' || eventType.includes('reasoning')) {
    const text = extractTextFromItem(item) || String(item.summary || '');
    if (text) {
      result.event = {
        type: 'reasoning',
        title: 'Codex 分析中',
        detail: text.slice(0, 200),
      };
    }
  } else if (eventType === 'thread.started' && result.threadId) {
    result.event = {
      type: 'lifecycle',
      title: '已建立 Codex 会话',
      detail: `thread_id: ${result.threadId}`,
    };
  } else if (eventType === 'turn.completed') {
    const usage = data.usage
      ? `输入 ${data.usage.input_tokens ?? '-'} / 输出 ${data.usage.output_tokens ?? '-'}`
      : '本轮推理结束';
    result.event = {
      type: 'lifecycle',
      title: '本轮执行完成',
      detail: usage,
    };
  } else if (eventType === 'error' || eventType === 'turn.failed') {
    result.event = {
      type: 'error',
      title: '执行出现异常',
      detail: String(data.message || data.error?.message || trimmed).slice(0, 240),
    };
  }

  return result;
}

/**
 * 从嵌套消息对象中提取纯文本内容
 * @param {object} obj 事件或消息节点
 * @returns {string} 提取的文本
 */
function extractTextFromItem(obj) {
  if (!obj || typeof obj !== 'object') return '';
  if (typeof obj.text === 'string') return obj.text.trim();
  if (typeof obj.content === 'string') return obj.content.trim();
  if (Array.isArray(obj.content)) {
    return obj.content
      .map((part) => (typeof part === 'string' ? part : part?.text || part?.output_text || ''))
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  return '';
}

/**
 * 校验工作目录和沙箱参数是否合法，防止越权调用
 * @param {object} params 校验参数
 */
export function validateExecutionParams({ cwd, sandbox }) {
  if (!cwd || typeof cwd !== 'string' || !cwd.trim()) {
    throw new Error('必须提供有效的工作目录 cwd');
  }
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error(`工作目录不存在或不是文件夹: ${cwd}`);
  }
  if (sandbox !== undefined && !ALLOWED_SANDBOX_MODES.includes(sandbox)) {
    throw new Error(
      `不允许的沙箱模式 "${sandbox}"。出于安全限制，仅允许: ${ALLOWED_SANDBOX_MODES.join(', ')}`,
    );
  }
}

/**
 * 记录工作区当前未提交文件的修改时间指纹，用于与任务结束后的状态做差集，避免把历史脏文件算作本次改动
 * @param {string} cwd 目标工作目录
 * @param {string[]} files 相对文件路径列表
 * @returns {Map<string, number>} 文件路径到 mtimeMs 的映射
 */
function snapshotFileMtimes(cwd, files) {
  const map = new Map();
  for (const rel of files) {
    try {
      const stat = fs.statSync(path.join(cwd, rel));
      map.set(rel, stat.mtimeMs);
    } catch {
      map.set(rel, -1);
    }
  }
  return map;
}

/**
 * 在指定目录执行短时 git 命令并返回退出码与输出
 * @param {string} cwd 目标工作目录
 * @param {string[]} args git 参数数组
 * @param {number} [timeoutMs=4000] 超时毫秒数
 * @returns {Promise<{ ok: boolean, code: number|null, stdout: string, stderr: string }>} 执行结果
 */
function runGitCommand(cwd, args, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn('git', args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // 忽略超时清理异常
      }
      resolve({ ok: false, code: null, stdout, stderr: 'git 命令超时' });
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr: err.message });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

/**
 * 在任务启动前拍摄无侵入 Git 快照（不污染 git log 与 git stash list）
 * @param {string} cwd 目标工作目录
 * @returns {Promise<object>} 快照对象（含 isGitRepo、headSha、stashSha、preUntrackedFiles、baselineMtimes）
 */
export async function captureGitCheckpoint(cwd) {
  const topRes = await runGitCommand(cwd, ['rev-parse', '--show-toplevel']);
  const gitRoot = topRes.ok ? topRes.stdout.trim() : '';
  if (!gitRoot) {
    return {
      isGitRepo: false,
      gitRoot: '',
      headSha: '',
      stashSha: '',
      preUntrackedFiles: [],
      postFileMtimes: {},
      baselineMtimes: null,
    };
  }

  const [headRes, stashRes, untrackedRes, diffSummary] = await Promise.all([
    runGitCommand(gitRoot, ['rev-parse', 'HEAD']),
    runGitCommand(gitRoot, ['stash', 'create']),
    runGitCommand(gitRoot, ['ls-files', '--others', '--exclude-standard']),
    collectGitDiffSummary(gitRoot),
  ]);

  const preUntrackedFiles = untrackedRes.ok
    ? untrackedRes.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    : [];

  return {
    isGitRepo: true,
    gitRoot,
    headSha: headRes.ok ? headRes.stdout.trim() : '',
    stashSha: stashRes.ok ? stashRes.stdout.trim() : '',
    preUntrackedFiles,
    postFileMtimes: {},
    baselineMtimes: diffSummary.fileMtimes,
  };
}

/**
 * 将相对文件路径列表转为可 JSON 持久化的 mtimeMs 字典
 * @param {string} cwd 工作区目录
 * @param {string[]} files 相对路径列表
 * @returns {Record<string, number>} 文件路径到 mtimeMs 的映射对象
 */
function snapshotFileMtimesObject(cwd, files) {
  const obj = {};
  for (const rel of files) {
    try {
      const stat = fs.statSync(path.join(cwd, rel));
      obj[rel] = Math.trunc(stat.mtimeMs);
    } catch {
      obj[rel] = -1;
    }
  }
  return obj;
}

/**
 * 按任务前 Git 快照安全回滚单次 Codex 任务触碰的文件（绝不粗暴 git reset --hard）
 * @param {object} job 任务快照对象
 * @param {{ force?: boolean }} [options] 回滚选项（force=true 时忽略二次手工修改冲突）
 * @returns {Promise<{ rolledBack: boolean, restoredFiles: string[], deletedFiles: string[], skippedFiles: string[], conflicts: string[], message: string }>} 回滚结果
 */
export async function rollbackCodexJob(job, { force = false } = {}) {
  const empty = {
    rolledBack: false,
    restoredFiles: [],
    deletedFiles: [],
    skippedFiles: [],
    conflicts: [],
    message: '',
  };

  if (!job) {
    return { ...empty, message: '未找到指定任务记录' };
  }
  if (job.status === 'running') {
    return { ...empty, message: '任务正在运行中，请先终止任务后再执行回滚' };
  }
  if (job.rolledBack) {
    return { ...empty, message: '该任务已经执行过回滚，无需重复操作' };
  }
  if (job.worktree) {
    return { ...empty, message: '该任务运行在独立 Git Worktree 中，主工作区未被修改，无需回滚' };
  }

  const checkpoint = job.checkpoint;
  if (!checkpoint || !checkpoint.isGitRepo || !checkpoint.headSha) {
    return { ...empty, message: '该任务缺少任务前 Git 快照（可能为旧任务、只读任务或非 Git 目录），无法自动回滚' };
  }

  const targetFiles = Array.isArray(job.changedFiles) ? job.changedFiles.filter(Boolean) : [];
  if (targetFiles.length === 0) {
    return { ...empty, message: '该任务没有记录到改动文件，无需回滚' };
  }

  const repoRoot = checkpoint.gitRoot && fs.existsSync(checkpoint.gitRoot) ? checkpoint.gitRoot : job.cwd;
  if (!repoRoot || !fs.existsSync(repoRoot)) {
    return { ...empty, message: `目标工作目录不存在: ${repoRoot || job.cwd}` };
  }

  // 1. 校验 HEAD 未发生移动，避免用户已提交新 commit 后误覆写
  const currentHeadRes = await runGitCommand(repoRoot, ['rev-parse', 'HEAD']);
  const currentHead = currentHeadRes.ok ? currentHeadRes.stdout.trim() : '';
  if (!currentHead || currentHead !== checkpoint.headSha) {
    return {
      ...empty,
      message: `当前仓库 HEAD（${currentHead.slice(0, 8) || '未知'}）已与任务启动前（${checkpoint.headSha.slice(0, 8)}）不一致，说明期间已有新提交，建议改用 git revert 手动处理`,
    };
  }

  // 2. 二次修改冲突检测：若文件在任务结束后又被用户手工编辑，默认拦截保护
  const postMtimes = checkpoint.postFileMtimes || {};
  const conflicts = [];
  if (!force && Object.keys(postMtimes).length > 0) {
    for (const rel of targetFiles) {
      if (postMtimes[rel] === undefined) continue;
      let curMtime = -1;
      try {
        curMtime = Math.trunc(fs.statSync(path.join(repoRoot, rel)).mtimeMs);
      } catch {
        curMtime = -1;
      }
      if (Math.abs(curMtime - postMtimes[rel]) > 2) {
        conflicts.push(rel);
      }
    }
    if (conflicts.length > 0) {
      return {
        ...empty,
        conflicts,
        message: `检测到 ${conflicts.length} 个文件在任务结束后被再次修改，已暂停回滚以防覆盖你的新改动：${conflicts.join(', ')}`,
      };
    }
  }

  // 3. 逐文件精准恢复或删除（统一基于 Git 仓库根目录，兼容 Monorepo 子目录 cwd）
  const restoreRef = checkpoint.stashSha || checkpoint.headSha;
  const preUntrackedSet = new Set(Array.isArray(checkpoint.preUntrackedFiles) ? checkpoint.preUntrackedFiles : []);
  const resolvedRoot = path.resolve(repoRoot);

  const restoredFiles = [];
  const deletedFiles = [];
  const skippedFiles = [];

  for (const rel of targetFiles) {
    const absPath = path.resolve(repoRoot, rel);
    // 防路径穿越校验：确保目标文件严格位于仓库根目录内部
    const relativeCheck = path.relative(resolvedRoot, absPath);
    if (relativeCheck.startsWith('..') || path.isAbsolute(relativeCheck)) {
      skippedFiles.push(`${rel}（超出工作区边界）`);
      continue;
    }

    // 检查该文件在快照 ref 中是否为已跟踪文件
    const treeCheck = await runGitCommand(repoRoot, ['ls-tree', '--name-only', restoreRef, '--', rel]);
    const existedInSnapshot = treeCheck.ok && treeCheck.stdout.trim().length > 0;

    if (existedInSnapshot) {
      const checkoutRes = await runGitCommand(repoRoot, ['checkout', restoreRef, '--', rel]);
      if (checkoutRes.ok) {
        // 若使用了 stashSha 还原，同时把暂存区同步回 HEAD 状态避免残留意外 staged 差异
        if (checkpoint.stashSha) {
          await runGitCommand(repoRoot, ['reset', '-q', 'HEAD', '--', rel]);
        }
        restoredFiles.push(rel);
      } else {
        skippedFiles.push(`${rel}（git checkout 失败: ${checkoutRes.stderr.trim() || '未知错误'}）`);
      }
    } else if (!preUntrackedSet.has(rel)) {
      // 本次任务新建的文件：先解除可能的 git add 暂存，再安全删除
      await runGitCommand(repoRoot, ['reset', '-q', 'HEAD', '--', rel]);
      try {
        if (fs.existsSync(absPath)) {
          fs.rmSync(absPath, { force: true });
        }
        deletedFiles.push(rel);
      } catch (err) {
        skippedFiles.push(`${rel}（删除失败: ${err.message}）`);
      }
    } else {
      // 任务启动前就已存在的 untracked 文件无法通过 git stash create 还原，明确跳过提醒
      skippedFiles.push(`${rel}（任务前已存在的未追踪文件，已保留请手动核对）`);
    }
  }

  const summaryParts = [];
  if (restoredFiles.length > 0) summaryParts.push(`已还原 ${restoredFiles.length} 个文件`);
  if (deletedFiles.length > 0) summaryParts.push(`已删除 ${deletedFiles.length} 个新建文件`);
  if (skippedFiles.length > 0) summaryParts.push(`跳过 ${skippedFiles.length} 个文件`);

  return {
    rolledBack: restoredFiles.length > 0 || deletedFiles.length > 0,
    restoredFiles,
    deletedFiles,
    skippedFiles,
    conflicts: [],
    message: summaryParts.length > 0 ? `回滚完成：${summaryParts.join('，')}。` : '未有文件需要回滚。',
  };
}

/**
 * 在目标目录执行轻量只读 git status 与 git diff --stat，补全真实改动文件列表与增删统计
 * @param {string} cwd 目标工作目录
 * @param {Map<string, number>|null} baselineMtimes 任务启动前的脏文件 mtime 基线（传入时仅返回本次新增或实际变动的 file）
 * @returns {Promise<{ changedFiles: string[], gitDiffStat: string, fileMtimes: Map<string, number> }>} 改动摘要
 */
export function collectGitDiffSummary(cwd, baselineMtimes = null) {
  return Promise.all([
    runGitCommand(cwd, ['rev-parse', '--show-toplevel'], 3000),
    runGitCommand(cwd, ['status', '--porcelain'], 3000),
    runGitCommand(cwd, ['diff', '--stat'], 3000),
  ]).then(([topRes, statusRes, diffRes]) => {
    const gitRoot = topRes.ok && topRes.stdout.trim() ? topRes.stdout.trim() : cwd;
    const statusOut = statusRes.ok ? statusRes.stdout : '';
    const diffStat = diffRes.ok ? diffRes.stdout : '';
    const allDirtyFiles = statusOut
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.length >= 4)
      .map((line) => {
        const rawPath = line.slice(3).trim();
        // 处理重命名格式 "old -> new"
        const arrowIdx = rawPath.lastIndexOf(' -> ');
        return (arrowIdx >= 0 ? rawPath.slice(arrowIdx + 4) : rawPath).replace(/^"|"$/g, '');
      })
      .filter(Boolean);

    const fileMtimes = snapshotFileMtimes(gitRoot, allDirtyFiles);
    const changedFiles = baselineMtimes
      ? allDirtyFiles.filter((rel) => {
          if (!baselineMtimes.has(rel)) return true;
          return baselineMtimes.get(rel) !== fileMtimes.get(rel);
        })
      : allDirtyFiles;

    return {
      changedFiles,
      gitDiffStat: diffStat.trim(),
      fileMtimes,
    };
  });
}

/**
 * 校验并拼接 `codex exec` / `codex exec resume` / `codex review` 命令参数并启动执行
 * @param {object} options 执行选项
 * @param {import('./job-store.mjs').JobStore} jobStore 任务存储实例
 * @returns {Promise<object>} 同步模式下返回完整任务快照；后台模式下立即返回初始任务快照
 */
export async function executeCodexTask(options, jobStore) {
  const {
    kind = 'exec',
    source = 'model',
    prompt = '',
    cwd,
    conversationId = '',
    conversationTitle = '',
    presetId = '',
    model = '',
    reasoningEffort = '',
    sandbox = 'workspace-write',
    worktree = false,
    timeoutSec = 300,
    background = false,
    skipGitRepoCheck = false,
    skills = [],
    missingSkills = [],
    addDirs = [],
    threadId = '',
    useLast = false,
    reviewMode = 'uncommitted',
    baseBranch = '',
    commitSha = '',
  } = options;

  validateExecutionParams({
    cwd,
    sandbox: kind === 'review' ? 'read-only' : sandbox,
  });
  validateSafeToken(model, 'model');
  validateSafeToken(baseBranch, 'base_branch');
  validateSafeToken(commitSha, 'commit_sha');
  validateSafeToken(threadId, 'thread_id');

  // 校验显式传入的额外可写目录，确保全部存在且为文件夹
  const validatedAddDirs = Array.isArray(addDirs)
    ? Array.from(new Set(addDirs.map((d) => String(d || '').trim()).filter(Boolean)))
    : [];
  for (const dir of validatedAddDirs) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      throw new Error(`add_dirs 中的目录不存在或不是文件夹: ${dir}`);
    }
  }

  if ((kind === 'exec' || kind === 'resume') && !String(prompt).trim()) {
    throw new Error('prompt 不能为空');
  }

  const effectiveSandbox = kind === 'review' ? 'read-only' : sandbox;
  const effectiveTimeoutSec = clampTimeout(timeoutSec, 300);

  // 写码类非 worktree 任务启动前拍摄无侵入 Git 快照，同时拿到脏文件基线用于精准差集与安全回滚
  let baselineMtimes = null;
  let persistedCheckpoint = null;
  if (effectiveSandbox === 'workspace-write' && !worktree) {
    const snap = await captureGitCheckpoint(cwd);
    baselineMtimes = snap.baselineMtimes;
    if (snap.isGitRepo) {
      persistedCheckpoint = {
        isGitRepo: true,
        gitRoot: snap.gitRoot,
        headSha: snap.headSha,
        stashSha: snap.stashSha,
        preUntrackedFiles: snap.preUntrackedFiles,
        postFileMtimes: {},
      };
    }
  }

  // 为 exec / resume 创建临时文件，用 -o 稳定捕获最终回复，避免 JSONL 截断丢失
  const lastMsgFile =
    kind === 'exec' || kind === 'resume'
      ? path.join(os.tmpdir(), `codex-bridge-last-${crypto.randomBytes(6).toString('hex')}.txt`)
      : '';

  const args = buildCodexArgs({
    kind,
    cwd,
    model,
    reasoningEffort,
    sandbox: effectiveSandbox,
    worktree,
    addDirs: validatedAddDirs,
    skipGitRepoCheck,
    threadId,
    useLast,
    reviewMode,
    baseBranch,
    commitSha,
    lastMsgFile,
    hasPrompt: Boolean(String(prompt).trim()),
  });

  const job = jobStore.createJob({
    kind,
    source,
    prompt,
    cwd,
    conversationId,
    conversationTitle,
    presetId,
    model,
    sandbox: effectiveSandbox,
    worktree: kind === 'exec' ? Boolean(worktree) : false,
    skills: Array.isArray(skills) ? skills : [],
    missingSkills: Array.isArray(missingSkills) ? missingSkills : [],
    addDirs: validatedAddDirs,
    checkpoint: persistedCheckpoint,
    threadId,
  });

  const completionPromise = new Promise((resolve) => {
    const child = spawnCodex(args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    jobStore.attachProcess(job.id, child);

    let stdoutBuffer = '';
    let rawStdout = '';
    let rawStderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      jobStore.appendEvent(job.id, {
        type: 'error',
        title: '任务执行超时',
        detail: `已超过 ${effectiveTimeoutSec} 秒上限，正在终止进程`,
      });
      if (child.pid && process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } else {
        try {
          child.kill('SIGTERM');
        } catch {
          // 忽略已退出进程错误
        }
      }
    }, effectiveTimeoutSec * 1000);

    // 通过 stdin 传递提示词，彻底规避 Windows 命令行长度上限和引号转义问题
    if (child.stdin) {
      // 防止子进程提前退出导致 EPIPE 未捕获异常打崩 MCP Server
      child.stdin.on('error', () => {});
      if (String(prompt).trim()) {
        child.stdin.write(String(prompt), 'utf8');
      }
      child.stdin.end();
    }

    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      rawStdout += text;
      stdoutBuffer += text;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        handleStdoutLine(job.id, line, jobStore);
      }
    });

    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      rawStderr += text;
      // 过滤掉 Windows 常见的无害 PATH alias 警告
      const cleaned = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.includes('could not create PATH aliases'));
      if (cleaned.length > 0) {
        jobStore.appendEvent(job.id, {
          type: 'stderr',
          title: 'CLI 状态日志',
          detail: cleaned.join(' | ').slice(0, 260),
        });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      cleanupTempFile(lastMsgFile);
      const finished = jobStore.finishJob(job.id, 'failed', {
        error: `启动 codex 进程失败: ${err.message}`,
      });
      resolve(finished);
    });

    child.on('close', async (code) => {
      clearTimeout(timer);
      if (stdoutBuffer.trim()) {
        handleStdoutLine(job.id, stdoutBuffer, jobStore);
      }

      // 优先读取 -o 输出的最终消息，其次使用 JSONL 提取结果，最后兜底 stdout
      let finalMessage = '';
      if (lastMsgFile && fs.existsSync(lastMsgFile)) {
        try {
          finalMessage = fs.readFileSync(lastMsgFile, 'utf8').trim();
        } catch {
          finalMessage = '';
        }
      }
      cleanupTempFile(lastMsgFile);

      const current = jobStore.getJob(job.id);
      if (!finalMessage) {
        finalMessage = current?.lastMessage || (kind === 'review' ? rawStdout.trim() : '');
      }

      if (current?.status === 'cancelled') {
        resolve(current);
        return;
      }

      // 对写码类任务自动采集真实 git status / diff --stat，与启动前基线做差集精准提取本次改动
      let gitSummary = { changedFiles: [], gitDiffStat: '' };
      let postFileMtimes = null;
      if (effectiveSandbox === 'workspace-write' && !worktree) {
        const diffBaseDir = persistedCheckpoint?.gitRoot || cwd;
        gitSummary = await collectGitDiffSummary(diffBaseDir, baselineMtimes);
        const allTouched = Array.from(new Set([...(current?.changedFiles || []), ...gitSummary.changedFiles]));
        postFileMtimes = snapshotFileMtimesObject(diffBaseDir, allTouched);
      }

      if (timedOut) {
        const finished = jobStore.finishJob(job.id, 'failed', {
          exitCode: code,
          lastMessage: finalMessage,
          changedFiles: gitSummary.changedFiles,
          gitDiffStat: gitSummary.gitDiffStat,
          postFileMtimes,
          error: `任务执行超过 ${effectiveTimeoutSec} 秒超时终止`,
        });
        resolve(finished);
        return;
      }

      if (code === 0) {
        const finished = jobStore.finishJob(job.id, 'completed', {
          exitCode: code,
          lastMessage: finalMessage || 'Codex 已完成任务，未返回额外文本摘要。',
          changedFiles: gitSummary.changedFiles,
          gitDiffStat: gitSummary.gitDiffStat,
          postFileMtimes,
        });
        resolve(finished);
      } else {
        const errSnippet = rawStderr
          .split(/\r?\n/)
          .filter((l) => l.trim() && !l.includes('could not create PATH aliases'))
          .slice(-6)
          .join('\n')
          .trim();
        const finished = jobStore.finishJob(job.id, 'failed', {
          exitCode: code,
          lastMessage: finalMessage,
          changedFiles: gitSummary.changedFiles,
          gitDiffStat: gitSummary.gitDiffStat,
          postFileMtimes,
          error: errSnippet || `codex 退出码为 ${code}`,
        });
        resolve(finished);
      }
    });
  });

  if (background) {
    // 后台模式下立即返回任务快照，由调用方或 UI 通过 codex_job_status 轮询进度
    return job;
  }

  return completionPromise;
}

/**
 * 组装传给 codex-cli 的安全命令行参数
 * @param {object} params 参数集合
 * @returns {string[]} CLI 参数列表
 */
export function buildCodexArgs(params) {
  const {
    kind,
    cwd,
    model,
    reasoningEffort,
    sandbox,
    worktree,
    addDirs = [],
    skipGitRepoCheck,
    threadId,
    useLast,
    reviewMode,
    baseBranch,
    commitSha,
    lastMsgFile,
    hasPrompt,
  } = params;

  const safeEffort = ALLOWED_REASONING_EFFORTS.includes(reasoningEffort) ? reasoningEffort : '';

  if (kind === 'review') {
    const args = ['review'];
    if (model) {
      args.push('-c', `model="${model}"`);
    }
    if (safeEffort) {
      args.push('-c', `model_reasoning_effort="${safeEffort}"`);
    }
    if (reviewMode === 'base' && baseBranch) {
      args.push('--base', baseBranch);
    } else if (reviewMode === 'commit' && commitSha) {
      args.push('--commit', commitSha);
    } else {
      args.push('--uncommitted');
    }
    if (hasPrompt) {
      args.push('-');
    }
    return args;
  }

  if (kind === 'resume') {
    const args = ['exec', 'resume', '--json'];
    if (model) args.push('-m', model);
    if (safeEffort) args.push('-c', `model_reasoning_effort="${safeEffort}"`);
    if (lastMsgFile) args.push('-o', lastMsgFile);
    if (useLast || !threadId) {
      args.push('--last');
    } else {
      args.push(threadId);
    }
    args.push('-');
    return args;
  }

  // 默认 exec 模式
  const args = ['exec', '--json', '--sandbox', sandbox, '-C', cwd];
  if (model) args.push('-m', model);
  if (safeEffort) args.push('-c', `model_reasoning_effort="${safeEffort}"`);
  if (worktree) args.push('--worktree');
  if (Array.isArray(addDirs)) {
    for (const dir of addDirs) {
      if (dir && String(dir).trim()) {
        args.push('--add-dir', String(dir).trim());
      }
    }
  }
  if (skipGitRepoCheck) args.push('--skip-git-repo-check');
  if (lastMsgFile) args.push('-o', lastMsgFile);
  args.push('-');
  return args;
}

/**
 * 处理单行 stdout 并同步更新 JobStore
 * @param {string} jobId 任务 ID
 * @param {string} line 单行输出
 * @param {import('./job-store.mjs').JobStore} jobStore 任务仓库
 */
function handleStdoutLine(jobId, line, jobStore) {
  const parsed = parseCodexJsonlLine(line);
  if (!parsed) return;

  jobStore.updateJob(jobId, {
    threadId: parsed.threadId || undefined,
    lastMessage: parsed.lastMessage || undefined,
    changedFiles: parsed.changedFiles.length > 0 ? parsed.changedFiles : undefined,
    commandsRun: parsed.commandsRun.length > 0 ? parsed.commandsRun : undefined,
  });

  if (parsed.event) {
    jobStore.appendEvent(jobId, parsed.event);
  }
}

/**
 * 清理临时文件
 * @param {string} filePath 文件路径
 */
function cleanupTempFile(filePath) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // 忽略临时文件清理异常
  }
}
