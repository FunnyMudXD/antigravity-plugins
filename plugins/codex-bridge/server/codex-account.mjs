import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { spawnCodex } from './codex-runner.mjs';

/**
 * 解析 ~/.codex 目录路径（支持 CODEX_HOME 环境变量或自定义路径覆盖）
 * @param {string|undefined} customHome 可选自定义路径
 * @returns {string} codex 配置根目录
 */
export function resolveCodexHome(customHome) {
  if (customHome && String(customHome).trim()) {
    return path.resolve(String(customHome).trim());
  }
  if (process.env.CODEX_HOME && process.env.CODEX_HOME.trim()) {
    return path.resolve(process.env.CODEX_HOME.trim());
  }
  return path.join(os.homedir(), '.codex');
}

/**
 * 从 ~/.codex/config.toml 顶层只读提取默认模型、推理强度与服务层级
 * @param {string} codexHome codex 配置根目录
 * @returns {{ defaultModel: string, reasoningEffort: string, serviceTier: string }} 默认模型配置
 */
function readCodexConfigToml(codexHome) {
  const result = {
    defaultModel: '',
    reasoningEffort: '',
    serviceTier: '',
  };
  const configPath = path.join(codexHome, 'config.toml');
  if (!fs.existsSync(configPath)) return result;

  try {
    const lines = fs.readFileSync(configPath, 'utf8').split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      // 仅读取顶层键值，遇到第一个 [section] 即停止，避免误读子配置段
      if (line.startsWith('[')) break;

      const match = line.match(/^([a-zA-Z0-9_-]+)\s*=\s*["']([^"']*)["']/);
      if (!match) continue;
      const [, key, value] = match;
      if (key === 'model') result.defaultModel = value;
      else if (key === 'model_reasoning_effort') result.reasoningEffort = value;
      else if (key === 'service_tier') result.serviceTier = value;
    }
  } catch {
    // 读取失败时返回空默认值，不影响面板打开
  }
  return result;
}

/**
 * 从 ~/.codex/models_cache.json 读取本机可用模型候选列表
 * @param {string} codexHome codex 配置根目录
 * @returns {string[]} 模型 slug 列表
 */
function readAvailableModels(codexHome) {
  const cachePath = path.join(codexHome, 'models_cache.json');
  if (!fs.existsSync(cachePath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (!Array.isArray(data?.models)) return [];
    return data.models
      .map((m) => (typeof m?.slug === 'string' ? m.slug.trim() : ''))
      .filter(Boolean)
      .slice(0, 30);
  } catch {
    return [];
  }
}

/**
 * 从 ~/.codex/auth.json 安全提取登录用户与套餐信息（绝不返回任何 token 或 api_key）
 * @param {string} codexHome codex 配置根目录
 * @returns {object} 安全的账号摘要对象
 */
function readCodexAccount(codexHome) {
  const empty = {
    loggedIn: false,
    authMode: '',
    email: '',
    name: '',
    planType: '',
    subscriptionUntil: '',
  };
  const authPath = path.join(codexHome, 'auth.json');
  if (!fs.existsSync(authPath)) return empty;

  try {
    const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    const authMode = String(auth?.auth_mode || (auth?.OPENAI_API_KEY ? 'api_key' : '')).trim();
    const idToken = auth?.tokens?.id_token;

    if (typeof idToken === 'string' && idToken.includes('.')) {
      const parts = idToken.split('.');
      if (parts.length >= 2) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        const oaiAuth = payload?.['https://api.openai.com/auth'] || {};
        return {
          loggedIn: true,
          authMode: authMode || 'chatgpt',
          email: String(payload?.email || ''),
          name: String(payload?.name || ''),
          planType: String(oaiAuth?.chatgpt_plan_type || ''),
          subscriptionUntil: String(oaiAuth?.chatgpt_subscription_active_until || ''),
        };
      }
    }

    if (auth?.OPENAI_API_KEY) {
      return {
        loggedIn: true,
        authMode: 'api_key',
        email: '',
        name: 'API Key 模式',
        planType: 'api',
        subscriptionUntil: '',
      };
    }
  } catch {
    // 忽略解析异常，返回未登录兜底
  }

  return empty;
}

/**
 * 递归收集指定目录下的 .jsonl 会话文件及其修改时间
 * @param {string} dir 目录路径
 * @param {Array<{ filePath: string, mtimeMs: number }>} acc 结果数组
 * @returns {Array<{ filePath: string, mtimeMs: number }>} 文件列表
 */
function collectSessionJsonlFiles(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        collectSessionJsonlFiles(fullPath, acc);
      } else if (entry.name.endsWith('.jsonl')) {
        const stat = fs.statSync(fullPath);
        acc.push({ filePath: fullPath, mtimeMs: stat.mtimeMs });
      }
    }
  } catch {
    // 忽略无权限子目录
  }
  return acc;
}

/**
 * 规范化单个用量窗口（兼容本地 JSONL 的 snake_case 与 app-server 的 camelCase 字段）
 * @param {object|null|undefined} win 原始窗口对象
 * @param {number} nowSec 当前 Unix 秒级时间戳
 * @returns {object|null} 规范化后的窗口信息
 */
function normalizeRateWindow(win, nowSec) {
  if (!win || typeof win !== 'object') return null;
  const usedPercent = Number(win.used_percent ?? win.usedPercent);
  const windowMinutes = Number(win.window_minutes ?? win.windowDurationMins);
  const resetsAtSec = Number(win.resets_at ?? win.resetsAt);
  if (!Number.isFinite(usedPercent)) return null;

  const isExpired = Number.isFinite(resetsAtSec) && resetsAtSec > 0 && resetsAtSec <= nowSec;
  return {
    usedPercent: Math.max(0, Math.min(100, Math.round(usedPercent))),
    windowMinutes: Number.isFinite(windowMinutes) ? windowMinutes : 0,
    resetsAt: Number.isFinite(resetsAtSec) && resetsAtSec > 0 ? new Date(resetsAtSec * 1000).toISOString() : '',
    isExpired,
  };
}

/**
 * 从最近会话日志中提取最新的 5 小时用量（primary）与 7 天周用量（secondary）快照
 * @param {string} codexHome codex 配置根目录
 * @returns {object|null} 用量快照，未找到时返回 null
 */
function readLatestRateLimits(codexHome) {
  const candidates = [
    ...collectSessionJsonlFiles(path.join(codexHome, 'sessions')),
    ...collectSessionJsonlFiles(path.join(codexHome, 'archived_sessions')),
  ]
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, 20);

  const nowSec = Math.floor(Date.now() / 1000);

  for (const item of candidates) {
    try {
      const lines = fs.readFileSync(item.filePath, 'utf8').split(/\r?\n/);
      // 从末尾倒序扫描，确保取到该会话里最新一条 rate_limits
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i];
        if (!line || !line.includes('rate_limits')) continue;
        const obj = JSON.parse(line);
        const rl = obj?.payload?.rate_limits || obj?.rate_limits;
        if (!rl || (!rl.primary && !rl.secondary)) continue;

        return {
          source: 'local',
          updatedAt: String(obj?.timestamp || new Date(item.mtimeMs).toISOString()),
          limitId: String(rl.limit_id || 'codex'),
          planType: String(rl.plan_type || ''),
          primary: normalizeRateWindow(rl.primary, nowSec),
          secondary: normalizeRateWindow(rl.secondary, nowSec),
          resetCreditsCount: 0,
        };
      }
    } catch {
      // 跳过损坏或正在写入的日志行
    }
  }

  return null;
}

/** 最近一次通过 app-server 拉取的云端实时用量缓存（避免高频轮询重复拉起子进程） */
let cachedLiveUsage = null;

/**
 * 彻底终止一次性探测用的子进程树，防止 Windows 下残留后台进程
 * @param {import('node:child_process').ChildProcess} child 子进程句柄
 */
function killChildTree(child) {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } else {
    try {
      child.kill('SIGTERM');
    } catch {
      // 忽略已退出进程的错误
    }
  }
}

/**
 * 通过一次性 `codex app-server` 调用 `account/rateLimits/read` 向云端拉取实时 5h/周用量
 * 该调用不发起任何模型推理、不消耗对话配额，且复用本机 Codex 登录态
 * @param {number} timeoutMs 超时毫秒数
 * @returns {Promise<object>} 云端实时用量对象
 */
export function fetchLiveCodexRateLimits(timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawnCodex(['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let settled = false;
    let stderrText = '';
    const rl = readline.createInterface({ input: child.stdout });

    const finish = (err, data) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      killChildTree(child);
      if (err) reject(err);
      else resolve(data);
    };

    const timer = setTimeout(() => {
      finish(new Error(`拉取云端实时用量超时（>${timeoutMs}ms）`));
    }, timeoutMs);

    child.stdin?.on('error', () => {});

    const send = (msg) => {
      try {
        child.stdin.write(`${JSON.stringify(msg)}\n`);
      } catch {
        // 忽略进程已关闭时的写入异常
      }
    };

    child.stderr?.on('data', (chunk) => {
      stderrText += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      finish(new Error(`启动 codex app-server 失败: ${err.message}`));
    });

    child.on('close', (code) => {
      if (!settled) {
        finish(new Error(stderrText.trim() || `codex app-server 异常退出（code=${code}）`));
      }
    });

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) return;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return;
      }

      if (msg.id === 1) {
        if (msg.error) {
          finish(new Error(msg.error.message || 'app-server initialize 失败'));
          return;
        }
        send({ jsonrpc: '2.0', method: 'initialized', params: {} });
        send({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: {} });
      } else if (msg.id === 2) {
        if (msg.error) {
          finish(new Error(msg.error.message || '查询实时用量失败'));
          return;
        }
        const raw = msg.result?.rateLimits || msg.result?.rateLimitsByLimitId?.codex;
        if (!raw) {
          finish(new Error('云端未返回 rateLimits 数据'));
          return;
        }
        const nowSec = Math.floor(Date.now() / 1000);
        const liveUsage = {
          source: 'live',
          updatedAt: new Date().toISOString(),
          limitId: String(raw.limitId || raw.limit_id || 'codex'),
          planType: String(raw.planType || raw.plan_type || ''),
          primary: normalizeRateWindow(raw.primary, nowSec),
          secondary: normalizeRateWindow(raw.secondary, nowSec),
          resetCreditsCount: Number(msg.result?.rateLimitResetCredits?.availableCount || 0),
        };
        cachedLiveUsage = liveUsage;
        finish(null, liveUsage);
      }
    });

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'codex-bridge', version: '0.1.0' } },
    });
  });
}

/**
 * 汇总读取本机 Codex 默认模型、登录账号以及 5 小时/周用量（优先使用内存中的云端实时缓存，其次回退本地快照）
 * @param {string|undefined} customCodexHome 可选自定义 CODEX_HOME（用于测试）
 * @returns {object} codexProfile 结构化对象
 */
export function readCodexProfile(customCodexHome) {
  const codexHome = resolveCodexHome(customCodexHome);
  const toml = readCodexConfigToml(codexHome);
  const account = readCodexAccount(codexHome);
  const localUsage = readLatestRateLimits(codexHome);
  // 单元测试传入自定义目录时不使用全局 live 缓存，确保测试隔离
  const usage = !customCodexHome && cachedLiveUsage ? structuredClone(cachedLiveUsage) : localUsage;
  const availableModels = readAvailableModels(codexHome);

  // 若 auth.json 未给出套餐类型但 rate_limits 里有，则补全
  if (!account.planType && usage?.planType) {
    account.planType = usage.planType;
  }

  return {
    defaultModel: toml.defaultModel,
    reasoningEffort: toml.reasoningEffort,
    serviceTier: toml.serviceTier,
    availableModels,
    account,
    usage,
  };
}
