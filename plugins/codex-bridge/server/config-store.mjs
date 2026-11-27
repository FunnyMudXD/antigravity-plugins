import fs from 'node:fs';
import path from 'node:path';

/** 允许的沙箱安全模式白名单，禁止透传 danger-full-access */
export const ALLOWED_SANDBOX_MODES = ['read-only', 'workspace-write'];

/** 内置默认任务预设列表 */
export const DEFAULT_PRESETS = [
  {
    id: 'readonly-research',
    name: '只读调研',
    description: '只读分析代码结构、定位问题根因或给出改造方案，不修改任何文件。',
    mode: 'exec',
    sandbox: 'read-only',
    worktree: false,
    model: '',
    timeoutSec: 240,
    promptPrefix: '请仅做只读分析，不要修改工作区文件。请给出清晰的结论、涉及的关键文件路径及原因说明。\n\n',
  },
  {
    id: 'daily-coding',
    name: '日常写码',
    description: '在当前工作区直接实现需求或修复 Bug，完成后由主模型进行 diff 验收。',
    mode: 'exec',
    sandbox: 'workspace-write',
    worktree: false,
    model: '',
    timeoutSec: 360,
    promptPrefix: '',
  },
  {
    id: 'worktree-refactor',
    name: 'Worktree 隔离大改',
    description: '在独立 Git worktree 中执行高风险重构或实验性改造，避免污染当前分支。',
    mode: 'exec',
    sandbox: 'workspace-write',
    worktree: true,
    model: '',
    timeoutSec: 480,
    promptPrefix: '',
  },
  {
    id: 'adversarial-review',
    name: '对抗性代码审查',
    description: '以严格挑刺视角审查未提交改动，重点挖掘边界条件、并发风险与安全隐患。',
    mode: 'review',
    sandbox: 'read-only',
    worktree: false,
    model: '',
    timeoutSec: 240,
    promptPrefix:
      '请以严格、审慎的对抗性视角审查当前改动，重点排查逻辑漏洞、边界条件、并发竞态、异常处理遗漏以及安全风险，按严重程度分级列出问题并给出修复建议。',
  },
];

/**
 * 构造插件默认配置对象
 * @returns {object} 默认配置
 */
export function createDefaultConfig() {
  return {
    version: 1,
    defaultModel: '',
    defaultSandbox: 'workspace-write',
    defaultWorktree: false,
    defaultTimeoutSec: 300,
    defaultCwd: '',
    skipGitRepoCheck: false,
    presets: structuredClone(DEFAULT_PRESETS),
  };
}

/**
 * 校验并清洗单条预设对象，确保字段类型和沙箱权限符合安全约束
 * @param {object} raw 原始预设输入
 * @param {number} index 数组下标（用于兜底生成 ID）
 * @returns {object} 清洗后的预设对象
 */
function sanitizePreset(raw, index) {
  const id = String(raw?.id || `preset-${index + 1}`).trim();
  const name = String(raw?.name || id).trim();
  const mode = raw?.mode === 'review' ? 'review' : 'exec';
  const sandbox = ALLOWED_SANDBOX_MODES.includes(raw?.sandbox)
    ? raw.sandbox
    : mode === 'review'
      ? 'read-only'
      : 'workspace-write';
  const timeoutSec = clampTimeout(raw?.timeoutSec, 300);

  return {
    id,
    name,
    description: String(raw?.description || '').trim(),
    mode,
    sandbox,
    worktree: mode === 'exec' ? Boolean(raw?.worktree) : false,
    model: String(raw?.model || '').trim(),
    timeoutSec,
    promptPrefix: String(raw?.promptPrefix || ''),
  };
}

/**
 * 限制超时秒数在安全区间内（30 秒至 1800 秒）
 * @param {number|string|undefined} value 输入值
 * @param {number} fallback 兜底值
 * @returns {number} 合法超时秒数
 */
export function clampTimeout(value, fallback = 300) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(30, Math.min(1800, Math.round(parsed)));
}

/**
 * 插件独立配置持久化存储（读写 ${PLUGIN_DATA}/config.json，不修改 ~/.codex/config.toml）
 */
export class ConfigStore {
  /**
   * @param {string} dataDir 插件持久化数据目录
   */
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, 'config.json');
    this.config = this.#loadFromDisk();
  }

  /**
   * 从磁盘加载配置；若不存在或损坏则回退为默认配置
   * @returns {object} 当前生效配置
   */
  #loadFromDisk() {
    try {
      if (!fs.existsSync(this.filePath)) {
        return createDefaultConfig();
      }
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return this.#mergeAndSanitize(raw);
    } catch {
      return createDefaultConfig();
    }
  }

  /**
   * 合并外部输入并执行严格字段校验
   * @param {object} input 待合并的配置对象
   * @returns {object} 合法的完整配置对象
   */
  #mergeAndSanitize(input) {
    const base = createDefaultConfig();
    const merged = { ...base, ...(input && typeof input === 'object' ? input : {}) };

    // 强制校验默认沙箱白名单，防止危险权限写入配置
    if (!ALLOWED_SANDBOX_MODES.includes(merged.defaultSandbox)) {
      merged.defaultSandbox = base.defaultSandbox;
    }

    merged.defaultModel = String(merged.defaultModel || '').trim();
    merged.defaultWorktree = Boolean(merged.defaultWorktree);
    merged.defaultTimeoutSec = clampTimeout(merged.defaultTimeoutSec, base.defaultTimeoutSec);
    merged.defaultCwd = String(merged.defaultCwd || '').trim();
    merged.skipGitRepoCheck = Boolean(merged.skipGitRepoCheck);

    if (Array.isArray(merged.presets) && merged.presets.length > 0) {
      merged.presets = merged.presets.map((item, idx) => sanitizePreset(item, idx));
    } else {
      merged.presets = structuredClone(DEFAULT_PRESETS);
    }

    return merged;
  }

  /**
   * 获取当前配置的深拷贝
   * @returns {object} 配置对象
   */
  getConfig() {
    return structuredClone(this.config);
  }

  /**
   * 根据预设 ID 查找对应任务预设
   * @param {string|undefined} presetId 预设标识
   * @returns {object|null} 命中的预设对象或 null
   */
  getPreset(presetId) {
    if (!presetId) return null;
    return this.config.presets.find((item) => item.id === presetId) || null;
  }

  /**
   * 更新配置并原子写入磁盘
   * @param {object} patch 需要更新的配置字段
   * @returns {object} 保存后的完整配置
   */
  saveConfig(patch) {
    this.config = this.#mergeAndSanitize({
      ...this.config,
      ...(patch && typeof patch === 'object' ? patch : {}),
    });
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(this.config, null, 2), 'utf8');
    fs.renameSync(tempPath, this.filePath);
    return this.getConfig();
  }
}
