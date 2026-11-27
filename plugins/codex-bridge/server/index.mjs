#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { ConfigStore } from './config-store.mjs';
import { JobStore } from './job-store.mjs';
import { executeCodexTask, rollbackCodexJob, runCodexDoctor } from './codex-runner.mjs';
import { fetchLiveCodexRateLimits, readCodexProfile } from './codex-account.mjs';
import { listAvailableSkills, resolveSkillsPromptBlock } from './skill-resolver.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, '..');

/** MCP App UI 资源 URI 与 MIME 类型（遵循 SEP-1865） */
export const UI_RESOURCE_URI = 'ui://codex-bridge/app.html';
export const UI_RESOURCE_MIME = 'text/html;profile=mcp-app';

/**
 * 解析命令行中的 --data-dir 参数，用于确定插件持久化数据目录
 * @param {string[]} argv 命令行参数数组
 * @returns {string} 数据目录绝对路径
 */
function resolveDataDir(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--data-dir=')) {
      return arg.slice('--data-dir='.length).trim();
    }
    if (arg === '--data-dir' && argv[i + 1]) {
      return argv[i + 1].trim();
    }
  }
  return path.join(os.homedir(), '.gemini', 'config', 'plugin-data', 'codex-bridge');
}

/**
 * 读取打包后的 MCP App 单文件 HTML，支持环境变量热覆盖以便开发调试
 * @returns {string} 完整 HTML 字符串
 */
function loadUiHtml() {
  const overridePath = process.env.CODEX_BRIDGE_UI_HTML;
  const htmlPath = overridePath
    ? path.resolve(overridePath)
    : path.join(PLUGIN_ROOT, 'ui', 'dist', 'index.html');

  if (!fs.existsSync(htmlPath)) {
    return `<!doctype html><html lang="zh-CN"><body><p style="font-family:sans-serif;padding:16px;">Codex 指挥台前端尚未构建，请在插件目录运行 <code>npm run build:ui</code>。</p></body></html>`;
  }
  return fs.readFileSync(htmlPath, 'utf8');
}

const DATA_DIR = resolveDataDir(process.argv.slice(2));
const configStore = new ConfigStore(DATA_DIR);
const jobStore = new JobStore(DATA_DIR);

/**
 * 定义全部暴露给 Antigravity 模型与 MCP App 的工具清单
 */
const TOOLS = [
  {
    name: 'open_codex_console',
    title: 'Codex 指挥台',
    description:
      '打开 Codex Bridge 可视化配置与任务指挥台（支持右侧边栏与左侧全屏），查看当前配置、任务队列与本机 codex-cli 状态。',
    inputSchema: {
      type: 'object',
      properties: {
        focusTab: {
          type: 'string',
          enum: ['dispatch', 'monitor', 'settings'],
          description: '打开面板时默认聚焦的标签页',
        },
        jobId: {
          type: 'string',
          description: '需要高亮查看的任务 ID（可选）',
        },
        cwd: {
          type: 'string',
          description: '当前项目工作区根目录绝对路径（可选，用于在任务监工中自动定位到当前项目）',
        },
        conversation_id: {
          type: 'string',
          description: '当前 Antigravity 对话 ID（可选，传入后右侧边栏默认按当前对话隔离展示任务）',
        },
        conversation_title: {
          type: 'string',
          description: '当前对话的简短标题或摘要（可选，便于展示）',
        },
      },
    },
    _meta: {
      ui: {
        resourceUri: UI_RESOURCE_URI,
      },
      'com.google.antigravity/ui': {
        entrypoints: [
          { type: 'aux_pane', title: 'Codex 指挥台' },
          { type: 'global', title: 'Codex 指挥台' },
        ],
      },
    },
  },
  {
    name: 'codex_doctor',
    title: '检查 Codex CLI 状态',
    description: '检测本机 codex-cli 的安装路径、版本号以及 codex doctor 登录与运行环境诊断结果。',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    _meta: {
      ui: { visibility: ['model', 'app'] },
    },
  },
  {
    name: 'codex_exec',
    title: '派发 Codex 执行任务',
    description:
      '调用本地 codex-cli 非交互执行编码、重构或只读调研任务。提示词通过 stdin 传入，返回 thread_id、最终总结、改动文件列表或后台 job_id。',
    inputSchema: {
      type: 'object',
      required: ['prompt', 'cwd'],
      properties: {
        prompt: { type: 'string', description: '发给 GPT（Codex）的清晰任务指令' },
        cwd: { type: 'string', description: '目标工作区根目录绝对路径' },
        preset_id: { type: 'string', description: '可选：引用插件配置中的任务预设 ID' },
        model: { type: 'string', description: '可选：覆盖默认 GPT 模型名称，留空则继承本地配置' },
        reasoning_effort: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: '可选：动态指定推理强度（简单改动用 low/medium，复杂排障用 high）',
        },
        sandbox: {
          type: 'string',
          enum: ['read-only', 'workspace-write'],
          description: '沙箱权限级别：read-only（只读）或 workspace-write（允许修改工作区）',
        },
        worktree: { type: 'boolean', description: '是否在独立 Git worktree 中执行任务' },
        background: {
          type: 'boolean',
          description: '是否后台异步执行（true 时立即返回 job_id，通过 codex_job_status 轮询）',
        },
        timeout_sec: { type: 'number', description: '超时秒数（30-1800）' },
        skip_git_repo_check: { type: 'boolean', description: '允许在非 Git 仓库目录中运行' },
        skills: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：需要透传给 GPT 的技能名称列表（如 ["rpx-to-ureport"]），服务端会自动解析并注入 SKILL.md 与 scripts/references 只读绝对路径',
        },
        add_dirs: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：额外允许 GPT 写入的目录绝对路径列表（透传 --add-dir，仅在确需跨目录写入时显式使用）',
        },
        conversation_id: {
          type: 'string',
          description: '可选：所属 Antigravity 对话 ID，用于按对话隔离任务监工视图',
        },
        conversation_title: {
          type: 'string',
          description: '可选：所属对话简短标题',
        },
        source: {
          type: 'string',
          enum: ['model', 'manual'],
          description: '任务来源标识（主模型派发或面板手动直发）',
        },
      },
    },
    _meta: {
      ui: { visibility: ['model', 'app'] },
    },
  },
  {
    name: 'codex_resume',
    title: '继续已有 Codex 会话',
    description: '基于已有 thread_id（或最近一次会话）向 Codex 追问或要求针对验收意见进行返工修改。',
    inputSchema: {
      type: 'object',
      required: ['prompt', 'cwd'],
      properties: {
        prompt: { type: 'string', description: '追问或返工修改指令' },
        cwd: { type: 'string', description: '目标工作区根目录绝对路径' },
        thread_id: { type: 'string', description: '要继续的 Codex 会话 thread_id' },
        use_last: { type: 'boolean', description: '若未指定 thread_id，是否继续最近一次会话' },
        model: { type: 'string', description: '可选：覆盖模型名称' },
        reasoning_effort: { type: 'string', enum: ['low', 'medium', 'high'] },
        background: { type: 'boolean', description: '是否后台异步执行' },
        timeout_sec: { type: 'number', description: '超时秒数（30-1800）' },
        conversation_id: { type: 'string', description: '可选：所属 Antigravity 对话 ID（留空时自动从原 thread_id 任务继承）' },
        conversation_title: { type: 'string', description: '可选：所属对话简短标题' },
        source: { type: 'string', enum: ['model', 'manual'] },
      },
    },
    _meta: {
      ui: { visibility: ['model', 'app'] },
    },
  },
  {
    name: 'codex_review',
    title: '调用 Codex 代码审查',
    description: '调用本地 codex review 对未提交改动、分支差异或指定提交执行只读代码审查。',
    inputSchema: {
      type: 'object',
      required: ['cwd'],
      properties: {
        cwd: { type: 'string', description: '目标 Git 仓库目录绝对路径' },
        mode: {
          type: 'string',
          enum: ['uncommitted', 'base', 'commit'],
          description: '审查范围：uncommitted（未提交改动）、base（对比分支）或 commit（指定提交）',
        },
        base_branch: { type: 'string', description: '当 mode=base 时指定基准分支名' },
        commit_sha: { type: 'string', description: '当 mode=commit 时指定提交哈希' },
        preset_id: { type: 'string', description: '可选：引用插件配置中的审查预设 ID（如 adversarial-review）' },
        prompt: { type: 'string', description: '可选：自定义审查重点或对抗性审查指令' },
        model: { type: 'string', description: '可选：覆盖模型名称' },
        reasoning_effort: { type: 'string', enum: ['low', 'medium', 'high'] },
        background: { type: 'boolean', description: '是否后台异步执行' },
        timeout_sec: { type: 'number', description: '超时秒数（30-1800）' },
        skills: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：需要作为审查参考挂载的技能名称列表',
        },
        conversation_id: { type: 'string', description: '可选：所属 Antigravity 对话 ID' },
        conversation_title: { type: 'string', description: '可选：所属对话简短标题' },
        source: { type: 'string', enum: ['model', 'manual'] },
      },
    },
    _meta: {
      ui: { visibility: ['model', 'app'] },
    },
  },
  {
    name: 'codex_job_status',
    title: '查询 Codex 任务状态',
    description:
      '查询指定 job_id 或最近任务队列的实时进度、结构化时间线、改动文件列表与最终结果。传入 wait_sec 时服务端会挂起等待直到任务完成或超时，避免频繁轮询。',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: '要查询的任务 ID；留空则返回最近任务列表' },
        wait_sec: {
          type: 'number',
          description: '可选：服务端最大阻塞等待秒数（0-180），任务完成时立即返回',
        },
      },
    },
    _meta: {
      ui: { visibility: ['model', 'app'] },
    },
  },
  {
    name: 'codex_job_cancel',
    title: '终止运行中的 Codex 任务',
    description: '强制终止指定 job_id 对应的正在运行的 codex-cli 子进程树。',
    inputSchema: {
      type: 'object',
      required: ['job_id'],
      properties: {
        job_id: { type: 'string', description: '要终止的任务 ID' },
      },
    },
    _meta: {
      ui: { visibility: ['model', 'app'] },
    },
  },
  {
    name: 'codex_job_rollback',
    title: '安全回滚 Codex 任务改动',
    description:
      '依据任务启动前自动拍摄的无侵入 Git 快照，精准还原指定 job_id 触碰的文件并删除本次新建文件，保留用户原有未提交修改；默认检测二次手工修改冲突防误覆盖。',
    inputSchema: {
      type: 'object',
      required: ['job_id'],
      properties: {
        job_id: { type: 'string', description: '要回滚的任务 ID' },
        force: {
          type: 'boolean',
          description: '可选：当检测到文件在任务结束后被用户二次手工修改时，是否仍强制覆盖回滚（默认 false）',
        },
      },
    },
    _meta: {
      ui: { visibility: ['model', 'app'] },
    },
  },
  {
    name: 'app_get_dashboard_state',
    title: '拉取指挥台状态（仅 UI）',
    description: '供 MCP App 前端拉取当前配置、预设列表与全部任务状态。',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    _meta: {
      ui: { visibility: ['app'] },
    },
  },
  {
    name: 'app_save_config',
    title: '保存插件配置（仅 UI）',
    description: '保存插件独立默认参数与任务预设到插件数据目录。',
    inputSchema: {
      type: 'object',
      properties: {
        config: { type: 'object', description: '待保存的配置补丁对象' },
      },
      required: ['config'],
    },
    _meta: {
      ui: { visibility: ['app'] },
    },
  },
  {
    name: 'app_delete_job',
    title: '清理历史任务（仅 UI）',
    description: '删除单条或全部非运行中的历史任务记录（支持按对话 ID 或项目目录筛选清理）。',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: '任务 ID，或传 ALL_FINISHED 清空所有已结束任务' },
        cwd: { type: 'string', description: '可选：仅清空指定项目目录下的已结束任务' },
        conversation_id: { type: 'string', description: '可选：仅清空指定对话下的已结束任务' },
      },
      required: ['job_id'],
    },
    _meta: {
      ui: { visibility: ['app'] },
    },
  },
  {
    name: 'app_refresh_usage',
    title: '云端实时刷新用量（仅 UI）',
    description: '通过本地 codex app-server 向云端实时查询最新的 5 小时与 7 天周用量，不消耗对话配额。',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    _meta: {
      ui: { visibility: ['app'] },
    },
  },
];

/**
 * 格式化任务摘要文本，供 Antigravity 主模型直接阅读
 * @param {object} job 任务快照
 * @returns {string} 可读摘要
 */
function formatJobTextSummary(job) {
  const lines = [
    `任务 ID: ${job.id}`,
    `状态: ${job.status}（耗时 ${job.elapsedSec ?? 0} 秒）`,
    `模式: ${job.kind} | 沙箱: ${job.sandbox}${job.worktree ? ' | Worktree 隔离' : ''}`,
    `工作目录: ${job.cwd}`,
  ];
  if (job.threadId) lines.push(`Thread ID: ${job.threadId}`);
  if (job.skills?.length) {
    lines.push(`挂载技能: ${job.skills.join(', ')}`);
  }
  if (job.missingSkills?.length) {
    lines.push(`警告 - 未找到技能（已忽略）: ${job.missingSkills.join(', ')}`);
  }
  if (job.rolledBack) {
    lines.push(`回滚状态: 已回滚（${job.rolledBackAt || ''}）`);
  }
  if (job.changedFiles?.length) {
    lines.push(`改动文件 (${job.changedFiles.length}): ${job.changedFiles.join(', ')}`);
  }
  if (job.gitDiffStat) {
    lines.push('', '--- Git Diff 统计 ---', job.gitDiffStat);
  }
  if (job.error) lines.push(`错误信息: ${job.error}`);
  if (job.lastMessage) {
    lines.push('', '--- Codex 最终回复 ---', job.lastMessage);
  }
  return lines.join('\n');
}

/**
 * 构造标准 MCP CallToolResult（同时提供文本 content 与结构化 structuredContent）
 * @param {string} text 给模型阅读的文本
 * @param {object} structuredContent 给 MCP App 渲染的结构化数据
 * @param {boolean} isError 是否为错误结果
 * @returns {object} MCP 工具返回体
 */
function toolResult(text, structuredContent, isError = false) {
  return {
    content: [{ type: 'text', text }],
    structuredContent,
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * 根据调用参数、配置与任务队列按优先级推断当前项目目录
 * @param {{ cwd?: string, jobId?: string }} args 工具调用参数
 * @param {object} config 插件配置
 * @param {object[]} jobs 任务列表
 * @returns {string} 推断出的当前项目绝对路径（无匹配时为空字符串）
 */
function inferActiveProjectCwd(args, config, jobs) {
  if (args?.cwd && String(args.cwd).trim()) {
    return String(args.cwd).trim();
  }
  if (args?.jobId) {
    const matched = jobs.find((j) => j.id === args.jobId);
    if (matched?.cwd) return matched.cwd;
  }
  if (config?.defaultCwd && String(config.defaultCwd).trim()) {
    return String(config.defaultCwd).trim();
  }
  if (jobs.length > 0 && jobs[0]?.cwd) {
    return jobs[0].cwd;
  }
  return '';
}

/**
 * 构建返回给前端的轻量可用技能列表
 * @param {string} cwd 当前项目目录（可选）
 * @returns {Array<{ name: string, description: string, scope: string }>} 轻量技能清单
 */
function getDashboardSkills(cwd = '') {
  return listAvailableSkills(cwd).map((s) => ({
    name: s.name,
    description: s.description,
    scope: s.scope,
  }));
}

/**
 * 执行具体 MCP 工具调用并分发到后端模块
 * @param {string} name 工具名
 * @param {object} args 调用参数
 * @returns {Promise<object>} MCP CallToolResult
 */
async function handleToolCall(name, args = {}) {
  try {
    switch (name) {
      case 'open_codex_console': {
        const config = configStore.getConfig();
        const jobs = jobStore.listJobs(50);
        const codexProfile = readCodexProfile();
        const runningCount = jobs.filter((j) => j.status === 'running').length;
        const activeProjectCwd = inferActiveProjectCwd(args, config, jobs);
        const availableSkills = getDashboardSkills(activeProjectCwd);
        const targetJob = args.jobId ? jobs.find((j) => j.id === args.jobId) : null;
        const activeConversationId =
          String(args.conversation_id || '').trim() || targetJob?.conversationId || '';
        const activeConversationTitle =
          String(args.conversation_title || '').trim() || targetJob?.conversationTitle || '';
        // 当已明确当前对话时，仅按本对话子集决定默认聚焦标签与选中任务，避免被其他对话干扰
        const scopedJobs = activeConversationId
          ? jobs.filter((j) => (j.conversationId || '') === activeConversationId)
          : jobs;
        const scopedRunningCount = scopedJobs.filter((j) => j.status === 'running').length;
        const payload = {
          focusTab: args.focusTab || (scopedRunningCount > 0 ? 'monitor' : 'dispatch'),
          selectedJobId: args.jobId || scopedJobs[0]?.id || '',
          activeProjectCwd,
          activeConversationId,
          activeConversationTitle,
          availableSkills,
          config,
          jobs,
          codexProfile,
        };
        return toolResult(
          `Codex 指挥台已就绪：当前默认模型 ${config.defaultModel || codexProfile.defaultModel || '未配置'}，登录账号 ${codexProfile.account.email || codexProfile.account.name || '未登录'}，运行中任务 ${runningCount} 个。`,
          payload,
        );
      }

      case 'codex_doctor': {
        const report = await runCodexDoctor();
        const summary = report.installed
          ? `检测到 ${report.version}（路径: ${report.binary}），健康状态: ${report.healthy ? '正常' : '需排查'}。\n\n${report.doctorOutput}`
          : `未检测到可用的 codex-cli（${report.binary}）：${report.doctorOutput}`;
        return toolResult(summary, report, !report.installed);
      }

      case 'codex_exec': {
        const cfg = configStore.getConfig();
        const preset = configStore.getPreset(args.preset_id);
        const targetCwd = args.cwd || cfg.defaultCwd;
        const skillRes = resolveSkillsPromptBlock(args.skills, targetCwd);
        const rawPrompt = String(args.prompt || '');
        const prefixedPrompt = preset?.promptPrefix ? `${preset.promptPrefix}${rawPrompt}` : rawPrompt;
        const finalPrompt = `${skillRes.promptBlock}${prefixedPrompt}`;
        const job = await executeCodexTask(
          {
            kind: 'exec',
            source: args.source || 'model',
            prompt: finalPrompt,
            cwd: targetCwd,
            conversationId: String(args.conversation_id || '').trim(),
            conversationTitle: String(args.conversation_title || '').trim(),
            presetId: preset?.id || '',
            model: args.model !== undefined ? args.model : preset?.model || cfg.defaultModel,
            reasoningEffort: args.reasoning_effort || '',
            sandbox: args.sandbox || preset?.sandbox || cfg.defaultSandbox,
            worktree:
              args.worktree !== undefined
                ? Boolean(args.worktree)
                : preset
                  ? Boolean(preset.worktree)
                  : cfg.defaultWorktree,
            skills: skillRes.resolvedNames,
            missingSkills: skillRes.missingNames,
            addDirs: Array.isArray(args.add_dirs) ? args.add_dirs : [],
            timeoutSec: args.timeout_sec || preset?.timeoutSec || cfg.defaultTimeoutSec,
            background: Boolean(args.background),
            skipGitRepoCheck:
              args.skip_git_repo_check !== undefined
                ? Boolean(args.skip_git_repo_check)
                : cfg.skipGitRepoCheck,
          },
          jobStore,
        );
        return toolResult(formatJobTextSummary(job), { job }, job.status === 'failed');
      }

      case 'codex_resume': {
        const cfg = configStore.getConfig();
        const targetCwd = args.cwd || cfg.defaultCwd;
        const prevJob = args.thread_id
          ? jobStore.findJobByThreadId(args.thread_id)
          : args.use_last
            ? jobStore.findLatestJobByCwd(targetCwd)
            : null;
        const conversationId =
          String(args.conversation_id || '').trim() || prevJob?.conversationId || '';
        const conversationTitle =
          String(args.conversation_title || '').trim() || prevJob?.conversationTitle || '';
        const job = await executeCodexTask(
          {
            kind: 'resume',
            source: args.source || 'model',
            prompt: args.prompt,
            cwd: targetCwd,
            conversationId,
            conversationTitle,
            threadId: args.thread_id || '',
            useLast: Boolean(args.use_last),
            model: args.model !== undefined ? args.model : cfg.defaultModel,
            reasoningEffort: args.reasoning_effort || '',
            sandbox: 'workspace-write',
            timeoutSec: args.timeout_sec || cfg.defaultTimeoutSec,
            background: Boolean(args.background),
          },
          jobStore,
        );
        return toolResult(formatJobTextSummary(job), { job }, job.status === 'failed');
      }

      case 'codex_review': {
        const cfg = configStore.getConfig();
        const preset = configStore.getPreset(args.preset_id);
        const targetCwd = args.cwd || cfg.defaultCwd;
        const skillRes = resolveSkillsPromptBlock(args.skills, targetCwd);
        const userPrompt = String(args.prompt || '').trim();
        const presetPrefix = String(preset?.promptPrefix || '').trim();
        const baseReviewPrompt =
          presetPrefix && userPrompt
            ? `${presetPrefix}\n\n补充重点：\n${userPrompt}`
            : presetPrefix || userPrompt;
        const finalPrompt = `${skillRes.promptBlock}${baseReviewPrompt}`.trim();
        const job = await executeCodexTask(
          {
            kind: 'review',
            source: args.source || 'model',
            prompt: finalPrompt,
            cwd: targetCwd,
            conversationId: String(args.conversation_id || '').trim(),
            conversationTitle: String(args.conversation_title || '').trim(),
            presetId: preset?.id || '',
            model: args.model !== undefined ? args.model : preset?.model || cfg.defaultModel,
            reasoningEffort: args.reasoning_effort || '',
            sandbox: 'read-only',
            skills: skillRes.resolvedNames,
            missingSkills: skillRes.missingNames,
            reviewMode: args.mode || 'uncommitted',
            baseBranch: args.base_branch || '',
            commitSha: args.commit_sha || '',
            timeoutSec: args.timeout_sec || preset?.timeoutSec || cfg.defaultTimeoutSec,
            background: Boolean(args.background),
          },
          jobStore,
        );
        return toolResult(formatJobTextSummary(job), { job }, job.status === 'failed');
      }

      case 'codex_job_status': {
        if (args.job_id) {
          const job =
            Number(args.wait_sec) > 0
              ? await jobStore.waitForJob(args.job_id, Number(args.wait_sec))
              : jobStore.getJob(args.job_id);
          if (!job) {
            return toolResult(`未找到任务 ${args.job_id}`, { error: 'NOT_FOUND' }, true);
          }
          return toolResult(formatJobTextSummary(job), { job });
        }
        const jobs = jobStore.listJobs(50);
        const text =
          jobs.length === 0
            ? '当前没有任何 Codex 任务记录。'
            : jobs
                .map((j) => `- [${j.status}] ${j.id} (${j.kind}, ${j.elapsedSec}s) ${j.cwd}`)
                .join('\n');
        return toolResult(text, { jobs });
      }

      case 'codex_job_cancel': {
        const res = jobStore.cancelJob(args.job_id);
        return toolResult(res.message, res, !res.cancelled && !res.job);
      }

      case 'codex_job_rollback': {
        const job = jobStore.getJob(args.job_id);
        if (!job) {
          return toolResult(`未找到任务 ${args.job_id}`, { error: 'NOT_FOUND', rolledBack: false }, true);
        }
        const res = await rollbackCodexJob(job, { force: Boolean(args.force) });
        let updatedJob = job;
        if (res.rolledBack) {
          updatedJob = jobStore.markJobRolledBack(job.id, res.message) || job;
        }
        return toolResult(res.message, { ...res, job: updatedJob }, !res.rolledBack && res.conflicts.length === 0);
      }

      case 'app_get_dashboard_state': {
        const config = configStore.getConfig();
        const jobs = jobStore.listJobs(50);
        const activeProjectCwd = inferActiveProjectCwd({}, config, jobs);
        const state = {
          config,
          jobs,
          activeProjectCwd,
          availableSkills: getDashboardSkills(activeProjectCwd),
          codexProfile: readCodexProfile(),
          serverTime: new Date().toISOString(),
        };
        return toolResult('ok', state);
      }

      case 'app_save_config': {
        const saved = configStore.saveConfig(args.config);
        return toolResult('配置已保存', { config: saved });
      }

      case 'app_delete_job': {
        const res = jobStore.deleteJob(args.job_id, {
          cwd: args.cwd || '',
          conversationId: args.conversation_id || '',
        });
        return toolResult(`已清理 ${res.deletedCount} 条历史任务`, {
          ...res,
          jobs: jobStore.listJobs(50),
        });
      }

      case 'app_refresh_usage': {
        const liveUsage = await fetchLiveCodexRateLimits();
        const codexProfile = readCodexProfile();
        return toolResult(
          `已从云端刷新实时用量：5 小时已用 ${liveUsage.primary?.usedPercent ?? '-'}%，7 天周已用 ${liveUsage.secondary?.usedPercent ?? '-'}%。`,
          { codexProfile },
        );
      }

      default:
        return toolResult(`未知工具: ${name}`, { error: 'UNKNOWN_TOOL' }, true);
    }
  } catch (err) {
    return toolResult(`调用失败: ${err.message}`, { error: err.message }, true);
  }
}

/**
 * 向 stdout 发送一条 JSON-RPC 2.0 响应消息
 * @param {object} payload 响应体
 */
function sendJsonRpc(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

/**
 * 处理单条 MCP JSON-RPC 请求
 * @param {object} msg 解析后的请求对象
 */
async function handleJsonRpcMessage(msg) {
  const { id, method, params } = msg;

  // 通知类消息无需回复
  if (id === undefined || id === null) {
    return;
  }

  try {
    switch (method) {
      case 'initialize': {
        const protocolVersion = params?.protocolVersion || '2025-03-26';
        sendJsonRpc({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion,
            capabilities: {
              tools: { listChanged: false },
              resources: { subscribe: false, listChanged: false },
            },
            serverInfo: {
              name: 'codex-bridge',
              version: '0.1.0',
            },
          },
        });
        return;
      }

      case 'ping': {
        sendJsonRpc({ jsonrpc: '2.0', id, result: {} });
        return;
      }

      case 'tools/list': {
        sendJsonRpc({
          jsonrpc: '2.0',
          id,
          result: { tools: TOOLS },
        });
        return;
      }

      case 'tools/call': {
        const result = await handleToolCall(params?.name, params?.arguments || {});
        sendJsonRpc({
          jsonrpc: '2.0',
          id,
          result,
        });
        return;
      }

      case 'resources/list': {
        sendJsonRpc({
          jsonrpc: '2.0',
          id,
          result: {
            resources: [
              {
                uri: UI_RESOURCE_URI,
                name: 'Codex 指挥台',
                description: 'Codex Bridge 可视化配置与任务指挥台界面',
                mimeType: UI_RESOURCE_MIME,
                _meta: {
                  ui: {
                    prefersBorder: false,
                  },
                },
              },
            ],
          },
        });
        return;
      }

      case 'resources/read': {
        if (params?.uri !== UI_RESOURCE_URI) {
          sendJsonRpc({
            jsonrpc: '2.0',
            id,
            error: { code: -32602, message: `未知资源 URI: ${params?.uri}` },
          });
          return;
        }
        sendJsonRpc({
          jsonrpc: '2.0',
          id,
          result: {
            contents: [
              {
                uri: UI_RESOURCE_URI,
                mimeType: UI_RESOURCE_MIME,
                text: loadUiHtml(),
                _meta: {
                  ui: {
                    prefersBorder: false,
                  },
                },
              },
            ],
          },
        });
        return;
      }

      default: {
        sendJsonRpc({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `不支持的方法: ${method}` },
        });
      }
    }
  } catch (err) {
    sendJsonRpc({
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: err.message || '服务器内部错误' },
    });
  }
}

/**
 * 启动 stdio JSON-RPC 监听循环
 */
function startServer() {
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const msg = JSON.parse(trimmed);
      void handleJsonRpcMessage(msg);
    } catch (err) {
      process.stderr.write(`[codex-bridge] JSON 解析失败: ${err.message}\n`);
    }
  });
}

startServer();
