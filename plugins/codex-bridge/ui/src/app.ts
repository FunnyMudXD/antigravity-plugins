import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';
import { z } from 'zod';

interface Preset {
  id: string;
  name: string;
  description: string;
  mode: 'exec' | 'review';
  sandbox: 'read-only' | 'workspace-write';
  worktree: boolean;
  model: string;
  timeoutSec: number;
  promptPrefix: string;
}

interface PluginConfig {
  defaultModel: string;
  defaultSandbox: 'read-only' | 'workspace-write';
  defaultWorktree: boolean;
  defaultTimeoutSec: number;
  defaultCwd: string;
  skipGitRepoCheck: boolean;
  presets: Preset[];
}

interface JobEvent {
  ts: string;
  type: string;
  title: string;
  detail: string;
}

interface JobItem {
  id: string;
  kind: 'exec' | 'resume' | 'review';
  source: 'model' | 'manual';
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  prompt: string;
  cwd: string;
  conversationId?: string;
  conversationTitle?: string;
  projectName?: string;
  presetId: string;
  model: string;
  sandbox: string;
  worktree: boolean;
  skills?: string[];
  checkpoint?: {
    isGitRepo?: boolean;
    headSha?: string;
    stashSha?: string;
  } | null;
  rolledBack?: boolean;
  rolledBackAt?: string;
  threadId: string;
  elapsedSec: number;
  lastMessage: string;
  error: string;
  changedFiles: string[];
  gitDiffStat?: string;
  commandsRun: string[];
  events: JobEvent[];
}

interface SkillSummary {
  name: string;
  description: string;
  scope: string;
}

interface ProjectOption {
  key: string;
  path: string;
  name: string;
  subNames: string[];
  cwds: string[];
  projectName?: string;
  count: number;
}

interface DoctorReport {
  installed: boolean;
  binary: string;
  version: string;
  healthy: boolean;
  doctorOutput: string;
}

interface RateWindow {
  usedPercent: number;
  windowMinutes: number;
  resetsAt: string;
  isExpired: boolean;
}

interface CodexProfile {
  defaultModel: string;
  reasoningEffort: string;
  serviceTier: string;
  availableModels: string[];
  account: {
    loggedIn: boolean;
    authMode: string;
    email: string;
    name: string;
    planType: string;
    subscriptionUntil: string;
  };
  usage: {
    source?: 'live' | 'local';
    updatedAt: string;
    limitId: string;
    planType: string;
    primary: RateWindow | null;
    secondary: RateWindow | null;
    resetCreditsCount?: number;
  } | null;
}

type TabKey = 'dispatch' | 'monitor' | 'settings';
type ScopeMode = 'conversation' | 'project' | 'all';

const state = {
  activeTab: 'dispatch' as TabKey,
  config: null as PluginConfig | null,
  codexProfile: null as CodexProfile | null,
  availableSkills: [] as SkillSummary[],
  jobs: [] as JobItem[],
  activeProjectCwd: '',
  activeConversationId: '',
  activeConversationTitle: '',
  boundJobIds: [] as string[],
  scopeMode: 'all' as ScopeMode,
  selectedProjectKey: 'ALL',
  selectedJobId: '',
  selectedPresetId: 'daily-coding',
  dispatchForm: {
    cwd: '',
    prompt: '',
    model: '',
    reasoningEffort: '' as '' | 'low' | 'medium' | 'high',
    sandbox: 'workspace-write' as 'read-only' | 'workspace-write',
    worktree: false,
    mode: 'exec' as 'exec' | 'review',
    reviewMode: 'uncommitted' as 'uncommitted' | 'base' | 'commit',
    baseBranch: '',
    commitSha: '',
    timeoutSec: 300,
    skipGitRepoCheck: false,
    skills: [] as string[],
    skillInput: '',
  },
  settingsForm: {
    defaultModel: '',
    defaultSandbox: 'workspace-write' as 'read-only' | 'workspace-write',
    defaultWorktree: false,
    defaultTimeoutSec: 300,
    defaultCwd: '',
    skipGitRepoCheck: false,
  },
  settingsDirty: false,
  resumeInput: '',
  confirmRollbackJobId: '',
  rollbackConflicts: [] as string[],
  rollingBackJobId: '',
  doctor: null as DoctorReport | null,
  doctorLoading: false,
  usageRefreshing: false,
  submitting: false,
  savingConfig: false,
  pollingInFlight: false,
  canSendMessage: false,
  lastDashboardSignature: '',
  lastRenderedTab: '' as TabKey | '',
  lastRenderedJobId: '',
  promptDetailsOpen: true,
  toast: '',
  toastTimer: 0 as number | undefined,
};

const app = new App({ name: 'Codex Bridge Console', version: '0.1.0' }, {});

/**
 * 显示底部轻提示消息
 * @param message 提示文案
 */
function showToast(message: string): void {
  state.toast = message;
  if (state.toastTimer) window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => {
    state.toast = '';
    render();
  }, 2600);
  render();
}

/**
 * 将本地绝对或相对路径转为 Antigravity 可打开的 file:// URI
 * @param filePath 文件路径
 * @param cwd 当前任务工作目录
 * @returns file:// URI 字符串
 */
function toFileUri(filePath: string, cwd: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const isAbs = /^[a-zA-Z]:\//.test(normalized) || normalized.startsWith('/');
  let fullPath = normalized;
  if (!isAbs && cwd) {
    const base = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
    fullPath = `${base}/${normalized.replace(/^\/+/, '')}`;
  }
  const encoded = fullPath
    .split('/')
    .map((seg, idx) => (idx === 0 && /^[a-zA-Z]:$/.test(seg) ? seg : encodeURIComponent(seg)))
    .join('/');
  return encoded.startsWith('/') ? `file://${encoded}` : `file:///${encoded}`;
}

/**
 * HTML 文本转义，防止任务输出或路径触发 XSS
 * @param value 原始文本
 * @returns 安全转义后的字符串
 */
function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 格式化时间线短时间（HH:MM:SS）
 * @param iso ISO 时间戳
 * @returns 时分秒字符串
 */
function formatShortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toTimeString().slice(0, 8);
}

/**
 * 应用某套任务预设到当前发单表单
 * @param presetId 预设 ID
 */
function applyPreset(presetId: string): void {
  const preset = state.config?.presets.find((p) => p.id === presetId);
  if (!preset) return;
  state.selectedPresetId = preset.id;
  state.dispatchForm.mode = preset.mode;
  state.dispatchForm.sandbox = preset.sandbox;
  state.dispatchForm.worktree = preset.worktree;
  state.dispatchForm.model = preset.model || state.config?.defaultModel || '';
  state.dispatchForm.timeoutSec = preset.timeoutSec || state.config?.defaultTimeoutSec || 300;
  render();
}

/**
 * 将已保存的配置同步到配置表单状态（避免覆盖用户正在编辑的未保存内容）
 * @param cfg 服务端配置对象
 * @param force 是否强制覆盖（如刚保存成功或首次加载）
 */
function syncSettingsForm(cfg: PluginConfig, force = false): void {
  if (!force && state.settingsDirty) return;
  state.settingsForm = {
    defaultModel: cfg.defaultModel || '',
    defaultSandbox: cfg.defaultSandbox === 'read-only' ? 'read-only' : 'workspace-write',
    defaultWorktree: Boolean(cfg.defaultWorktree),
    defaultTimeoutSec: cfg.defaultTimeoutSec || 300,
    defaultCwd: cfg.defaultCwd || '',
    skipGitRepoCheck: Boolean(cfg.skipGitRepoCheck),
  };
  state.settingsDirty = false;
}

/**
 * 归一化项目路径用于前端跨平台分组比对（兼容 Windows 大小写与斜杠差异）
 * @param cwd 原始项目路径
 * @returns 归一化键值
 */
function normalizeProjectKey(cwd: string): string {
  const raw = String(cwd || '').trim();
  if (!raw) return '';
  const unified = raw.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-zA-Z]:/.test(unified) ? unified.toLowerCase() : unified;
}

/**
 * 提取项目目录末级文件夹名称用于精简展示
 * @param cwd 项目绝对路径
 * @returns 文件夹短名
 */
function getProjectDisplayName(cwd: string): string {
  const unified = String(cwd || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!unified) return '未指定目录';
  const parts = unified.split('/');
  return parts[parts.length - 1] || unified;
}

/** 不参与多仓库自动归并的常见泛用父目录名称集合 */
const GENERIC_PARENT_DIR_NAMES = new Set([
  'project',
  'projects',
  'workspace',
  'workspaces',
  'idea',
  'code',
  'codes',
  'repo',
  'repos',
  'src',
  'work',
  'works',
  'dev',
  'develop',
  'git',
  'github',
  'gitlab',
  'users',
  'desktop',
  'documents',
  'downloads',
  'home',
  'aaa_wrok',
  'aaa_work',
]);

/**
 * 判断当前是否处于对话右侧边栏（含消息能力）而非左侧全屏全局视图
 * @returns 是否为对话右侧边栏
 */
function isConversationPane(): boolean {
  return state.canSendMessage;
}

/**
 * 将经由本面板显式打开且原无 conversationId 的任务纳入本面板绑定列表
 * @param jobId 任务 ID
 */
function addBoundJobId(jobId: string): void {
  const cleaned = String(jobId || '').trim();
  if (!cleaned) return;
  if (!state.boundJobIds.includes(cleaned)) {
    state.boundJobIds = [...state.boundJobIds, cleaned];
  }
}

/**
 * 提取目录路径的上一级父目录（盘符根或单层路径返回空字符串）
 * @param cwd 原始目录绝对路径
 * @returns 父目录路径
 */
function getParentDirPath(cwd: string): string {
  const unified = String(cwd || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = unified.lastIndexOf('/');
  if (idx <= 0) return '';
  const parent = unified.slice(0, idx);
  // 排除仅剩盘符根目录（如 "D:"）的情况
  if (/^[a-zA-Z]:$/.test(parent)) return '';
  return parent;
}

/**
 * 判断父目录是否为常见泛用容器目录（避免把不相关项目误合并）
 * @param parentPath 父目录路径
 * @returns 是否为泛用父目录
 */
function isGenericParentDir(parentPath: string): boolean {
  if (!parentPath) return true;
  const leaf = getProjectDisplayName(parentPath).toLowerCase();
  if (!leaf || GENERIC_PARENT_DIR_NAMES.has(leaf)) return true;
  // 排除直接位于盘符根下的一级用户目录（如 C:/Users/xxx）
  const parts = parentPath.split('/').filter(Boolean);
  if (parts.length <= 2) return true;
  return false;
}

/**
 * 扫描任务列表，找出包含 2 个及以上不同子目录的非泛用公共父目录键集合（用于多文件夹项目自动归并）
 * @param jobs 任务列表
 * @returns 可自动归并的父目录归一化键集合
 */
function getSharedParentKeys(jobs: JobItem[]): Set<string> {
  const parentChildrenMap = new Map<string, Set<string>>();
  for (const job of jobs) {
    if (job.projectName && job.projectName.trim()) continue;
    const cwdKey = normalizeProjectKey(job.cwd);
    if (!cwdKey) continue;
    const parentPath = getParentDirPath(job.cwd);
    if (!parentPath || isGenericParentDir(parentPath)) continue;
    const parentKey = normalizeProjectKey(parentPath);
    if (!parentKey) continue;
    let children = parentChildrenMap.get(parentKey);
    if (!children) {
      children = new Set<string>();
      parentChildrenMap.set(parentKey, children);
    }
    children.add(cwdKey);
  }
  const shared = new Set<string>();
  for (const [parentKey, children] of parentChildrenMap.entries()) {
    if (children.size >= 2) {
      shared.add(parentKey);
    }
  }
  return shared;
}

/**
 * 解析单条任务在全局视图中的归属项目分组（优先显式 projectName，其次自动归并同父目录多仓库，最后按单目录）
 * @param job 任务记录
 * @param sharedParentKeys 公共父目录键集合
 * @returns 分组元信息
 */
function resolveJobGroupMeta(
  job: JobItem,
  sharedParentKeys: Set<string>,
): {
  key: string;
  name: string;
  path: string;
  subName: string;
  projectName?: string;
} {
  const explicitProject = String(job.projectName || '').trim();
  const subName = getProjectDisplayName(job.cwd);
  if (explicitProject) {
    return {
      key: `proj:${explicitProject.toLowerCase()}`,
      name: explicitProject,
      path: job.cwd,
      subName,
      projectName: explicitProject,
    };
  }
  const parentPath = getParentDirPath(job.cwd);
  const parentKey = normalizeProjectKey(parentPath);
  if (parentKey && sharedParentKeys.has(parentKey)) {
    return {
      key: `parent:${parentKey}`,
      name: getProjectDisplayName(parentPath),
      path: parentPath,
      subName,
    };
  }
  const cwdKey = normalizeProjectKey(job.cwd);
  return {
    key: cwdKey ? `dir:${cwdKey}` : 'dir:unknown',
    name: subName,
    path: job.cwd,
    subName: '',
  };
}

/**
 * 汇总全局任务队列中的项目分组选项（支持多文件夹项目自动归并，不再伪造「当前项目」）
 * @returns 去重且按任务数降序排列的项目分组列表
 */
function getProjectOptions(): ProjectOption[] {
  const sharedParentKeys = getSharedParentKeys(state.jobs);
  const map = new Map<string, ProjectOption>();

  for (const job of state.jobs) {
    const meta = resolveJobGroupMeta(job, sharedParentKeys);
    const existing = map.get(meta.key);
    if (existing) {
      existing.count += 1;
      if (meta.subName && !existing.subNames.includes(meta.subName)) {
        existing.subNames.push(meta.subName);
      }
      if (job.cwd && !existing.cwds.includes(job.cwd)) {
        existing.cwds.push(job.cwd);
      }
    } else {
      map.set(meta.key, {
        key: meta.key,
        path: meta.path,
        name: meta.name,
        subNames: meta.subName ? [meta.subName] : [],
        cwds: job.cwd ? [job.cwd] : [],
        projectName: meta.projectName,
        count: 1,
      });
    }
  }

  return Array.from(map.values()).sort((a, b) => b.count - a.count);
}

/**
 * 为尚未绑定宿主 conversationId 的侧边栏生成临时面板会话 ID，保证新对话打开即隔离且不与其他窗口串单
 * @returns 当前侧边栏对应的会话 ID
 */
function ensurePaneConversationId(): string {
  if (state.activeConversationId) return state.activeConversationId;
  if (!state.canSendMessage) return '';
  const generated = `pane_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  state.activeConversationId = generated;
  state.activeConversationTitle = '当前侧边栏会话';
  state.scopeMode = 'conversation';
  return generated;
}

/**
 * 绑定当前 Antigravity 对话 ID，并在右侧边栏中锁定为「当前对话」隔离模式
 * @param convId 对话 ID
 * @param convTitle 对话简短标题（可选）
 */
function bindConversationScope(convId: string, convTitle = ''): void {
  const cleaned = String(convId || '').trim();
  if (!cleaned) return;
  state.activeConversationId = cleaned;
  if (convTitle && convTitle.trim()) {
    state.activeConversationTitle = convTitle.trim();
  }
  state.scopeMode = 'conversation';
}

/**
 * 返回当前视角下的任务列表：右侧边栏严格仅返回当前对话任务（绝不穿透泄露全局），左侧全屏按项目分组筛选
 * @returns 过滤后的任务数组
 */
function getFilteredJobs(): JobItem[] {
  if (isConversationPane() || state.scopeMode === 'conversation') {
    return state.jobs.filter((j) => {
      const matchConv =
        Boolean(state.activeConversationId) && (j.conversationId || '') === state.activeConversationId;
      const matchBound = state.boundJobIds.includes(j.id);
      return matchConv || matchBound;
    });
  }
  if (state.selectedProjectKey !== 'ALL') {
    const sharedParentKeys = getSharedParentKeys(state.jobs);
    return state.jobs.filter(
      (j) => resolveJobGroupMeta(j, sharedParentKeys).key === state.selectedProjectKey,
    );
  }
  return state.jobs;
}

/**
 * 记录显式传入的项目目录（仅用于发单表单默认路径，不再强行锁定左侧全局视图筛选器）
 * @param projectCwd 服务端显式传入的项目目录
 */
function syncDefaultProjectFilter(projectCwd: string): void {
  if (projectCwd && projectCwd.trim()) {
    state.activeProjectCwd = projectCwd.trim();
  }
}

/**
 * 向手动发单表单添加一个挂载技能
 * @param rawName 技能名
 */
function addSkillToForm(rawName: string): void {
  const cleaned = rawName.trim().replace(/^[/\$]+/, '');
  if (!cleaned) return;
  if (!state.dispatchForm.skills.includes(cleaned)) {
    state.dispatchForm.skills = [...state.dispatchForm.skills, cleaned];
  }
  state.dispatchForm.skillInput = '';
  render();
}

/**
 * 从手动发单表单移除一个已挂载技能
 * @param name 技能名
 */
function removeSkillFromForm(name: string): void {
  state.dispatchForm.skills = state.dispatchForm.skills.filter((s) => s !== name);
  render();
}

/**
 * 从 MCP Server 拉取最新配置与任务队列状态
 */
async function refreshDashboardState(forceRender = false): Promise<void> {
  if (state.pollingInFlight) return;
  state.pollingInFlight = true;
  try {
    const res = await app.callServerTool({
      name: 'app_get_dashboard_state',
      arguments: {},
    });
    const sc = (
      res as {
        structuredContent?: {
          config?: PluginConfig;
          jobs?: JobItem[];
          codexProfile?: CodexProfile;
          activeProjectCwd?: string;
          availableSkills?: SkillSummary[];
        };
      }
    ).structuredContent;

    // 计算数据指纹：内容完全未变时跳过重绘，彻底避免空闲轮询导致页面抖动与滚动条跳顶
    const nextSignature = JSON.stringify({
      config: sc?.config || null,
      jobs: sc?.jobs || [],
      codexProfile: sc?.codexProfile || null,
      activeProjectCwd: sc?.activeProjectCwd || '',
      availableSkills: sc?.availableSkills || [],
    });
    if (!forceRender && nextSignature === state.lastDashboardSignature) {
      return;
    }
    state.lastDashboardSignature = nextSignature;

    if (sc?.codexProfile) {
      state.codexProfile = sc.codexProfile;
    }
    if (Array.isArray(sc?.availableSkills)) {
      state.availableSkills = sc.availableSkills;
    }
    if (sc?.activeProjectCwd && !state.activeProjectCwd) {
      syncDefaultProjectFilter(sc.activeProjectCwd);
    }
    if (sc?.config) {
      const firstLoad = !state.config;
      state.config = sc.config;
      syncSettingsForm(sc.config, firstLoad);
      if (firstLoad) {
        state.dispatchForm.cwd = state.activeProjectCwd || sc.config.defaultCwd || '';
        state.dispatchForm.model = sc.config.defaultModel || '';
        state.dispatchForm.sandbox = sc.config.defaultSandbox;
        state.dispatchForm.worktree = sc.config.defaultWorktree;
        state.dispatchForm.timeoutSec = sc.config.defaultTimeoutSec;
        state.dispatchForm.skipGitRepoCheck = sc.config.skipGitRepoCheck;
      }
    }
    if (Array.isArray(sc?.jobs)) {
      const prevIds = new Set(state.jobs.map((j) => j.id));
      state.jobs = sc.jobs;
      // 直接在当前视角子集中检测新启动任务，避免其他对话同窗口启动的新任务遮挡本对话任务
      const visible = getFilteredJobs();
      const newlyStarted = visible.find((j) => j.status === 'running' && !prevIds.has(j.id));
      if (newlyStarted) {
        // 智能切单：仅当当前未选中任务或所选旧任务已结束时才自动切到新任务，避免打断正在盯盘的另一个运行中并行任务
        const currentSelected = visible.find((j) => j.id === state.selectedJobId);
        if (!currentSelected || currentSelected.status !== 'running') {
          state.selectedJobId = newlyStarted.id;
        }
        if (state.activeTab === 'dispatch' && newlyStarted.source === 'model') {
          state.activeTab = 'monitor';
        }
      } else if (visible.length > 0 && !visible.some((j) => j.id === state.selectedJobId)) {
        state.selectedJobId = visible[0].id;
      }
    }
    render();
  } catch (err) {
    showToast(`刷新状态失败: ${(err as Error).message}`);
  } finally {
    state.pollingInFlight = false;
  }
}

/**
 * 从面板手动提交任务给本地 codex-cli（异步后台启动，立即切到监工视图）
 */
async function submitManualTask(): Promise<void> {
  const form = state.dispatchForm;
  if (!form.cwd.trim()) {
    showToast('请先填写目标工作目录（绝对路径）');
    return;
  }
  if (form.mode === 'exec' && !form.prompt.trim()) {
    showToast('请先输入发给 GPT（Codex）的任务指令');
    return;
  }

  state.submitting = true;
  render();
  try {
    const isReview = form.mode === 'review';
    const convId = ensurePaneConversationId();
    const convTitle = state.activeConversationTitle || undefined;
    const res = await app.callServerTool({
      name: isReview ? 'codex_review' : 'codex_exec',
      arguments: isReview
        ? {
            cwd: form.cwd.trim(),
            preset_id: state.selectedPresetId || undefined,
            mode: form.reviewMode,
            base_branch: form.baseBranch.trim() || undefined,
            commit_sha: form.commitSha.trim() || undefined,
            prompt: form.prompt.trim() || undefined,
            model: form.model.trim() || undefined,
            reasoning_effort: form.reasoningEffort || undefined,
            skills: form.skills.length > 0 ? form.skills : undefined,
            conversation_id: convId || undefined,
            conversation_title: convTitle,
            timeout_sec: Number(form.timeoutSec) || 300,
            background: true,
            source: 'manual',
          }
        : {
            cwd: form.cwd.trim(),
            prompt: form.prompt.trim(),
            preset_id: state.selectedPresetId || undefined,
            model: form.model.trim() || undefined,
            reasoning_effort: form.reasoningEffort || undefined,
            sandbox: form.sandbox,
            worktree: form.worktree,
            skills: form.skills.length > 0 ? form.skills : undefined,
            conversation_id: convId || undefined,
            conversation_title: convTitle,
            timeout_sec: Number(form.timeoutSec) || 300,
            skip_git_repo_check: form.skipGitRepoCheck,
            background: true,
            source: 'manual',
          },
    });

    const sc = (res as { structuredContent?: { job?: JobItem; error?: string } }).structuredContent;
    if (sc?.job) {
      if (isConversationPane()) {
        // 右侧边栏始终保持当前对话隔离，绝不回退到项目/全局视图
        state.scopeMode = 'conversation';
        if (!sc.job.conversationId) {
          addBoundJobId(sc.job.id);
        }
      } else {
        // 左侧全屏视图下若当前筛选分组不包含新任务，则切回全部确保立即可见
        if (state.selectedProjectKey !== 'ALL') {
          const groupKey = resolveJobGroupMeta(sc.job, getSharedParentKeys([...state.jobs, sc.job])).key;
          if (groupKey !== state.selectedProjectKey) {
            state.selectedProjectKey = 'ALL';
          }
        }
      }
      state.selectedJobId = sc.job.id;
      state.activeTab = 'monitor';
      state.dispatchForm.prompt = '';
      showToast(`已派发任务 ${sc.job.id}`);
      await refreshDashboardState(true);
    } else {
      showToast(sc?.error || '派发任务失败，请检查工作目录与参数');
    }
  } catch (err) {
    showToast(`派发失败: ${(err as Error).message}`);
  } finally {
    state.submitting = false;
    render();
  }
}

/**
 * 在面板内直接对已选任务发起 codex_resume 返工
 * @param job 目标任务
 */
async function submitResumeTask(job: JobItem): Promise<void> {
  const feedback = state.resumeInput.trim();
  if (!feedback) {
    showToast('请先输入返工或追问说明');
    return;
  }
  state.submitting = true;
  render();
  try {
    const res = await app.callServerTool({
      name: 'codex_resume',
      arguments: {
        cwd: job.cwd,
        prompt: feedback,
        thread_id: job.threadId || undefined,
        use_last: !job.threadId,
        model: job.model || undefined,
        conversation_id: job.conversationId || state.activeConversationId || undefined,
        conversation_title: job.conversationTitle || state.activeConversationTitle || undefined,
        background: true,
        source: 'manual',
      },
    });
    const sc = (res as { structuredContent?: { job?: JobItem; error?: string } }).structuredContent;
    if (sc?.job) {
      state.selectedJobId = sc.job.id;
      state.resumeInput = '';
      showToast(`已发起返工任务 ${sc.job.id}`);
      await refreshDashboardState();
    } else {
      showToast(sc?.error || '发起返工失败');
    }
  } catch (err) {
    showToast(`返工失败: ${(err as Error).message}`);
  } finally {
    state.submitting = false;
    render();
  }
}

/**
 * 一键把任务结果发回 Antigravity 主对话，请主模型执行 git diff 验收
 * @param job 已完成的任务
 */
async function sendToMainAgentForReview(job: JobItem): Promise<void> {
  if (!state.canSendMessage) {
    showToast('当前视图不支持直接发送对话消息，请在对话右侧边栏中使用此按钮');
    return;
  }
  const filesPart =
    job.changedFiles.length > 0 ? `\n改动文件：${job.changedFiles.join(', ')}` : '';
  const message = [
    `请帮我验收 Codex 刚完成的任务（任务 ID：${job.id}，Thread ID：${job.threadId || '无'}）。`,
    `工作目录：${job.cwd}${filesPart}`,
    `请检查实际 git status / git diff 以及必要的测试，告诉我改动是否靠谱、有没有遗漏。`,
  ].join('\n');

  try {
    await app.sendMessage({
      role: 'user',
      content: [{ type: 'text', text: message }],
    });
    showToast('已发送验收请求到当前主对话');
  } catch (err) {
    showToast(`发送失败: ${(err as Error).message}`);
  }
}

/**
 * 调用 Antigravity 扩展接口在侧边栏直接打开改动文件；不支持时回退复制路径
 * @param filePath 改动文件路径
 * @param cwd 工作目录
 */
async function openChangedFile(filePath: string, cwd: string): Promise<void> {
  const uri = toFileUri(filePath, cwd);
  try {
    const res = await app.request(
      {
        method: 'com.google.antigravity/toggle-aux-pane',
        params: { tabType: 'fileView', uri },
      },
      z.object({ isError: z.boolean().optional() }).passthrough(),
    );
    if (res?.isError) {
      throw new Error('当前视图无侧边栏');
    }
  } catch {
    try {
      await navigator.clipboard.writeText(filePath);
      showToast(`已复制路径：${filePath}`);
    } catch {
      showToast(`文件路径：${filePath}`);
    }
  }
}

/**
 * 取消运行中的任务
 * @param jobId 任务 ID
 */
async function cancelRunningJob(jobId: string): Promise<void> {
  try {
    await app.callServerTool({
      name: 'codex_job_cancel',
      arguments: { job_id: jobId },
    });
    showToast(`已终止任务 ${jobId}`);
    await refreshDashboardState();
  } catch (err) {
    showToast(`终止失败: ${(err as Error).message}`);
  }
}

/**
 * 按任务前无侵入 Git 快照安全回滚指定任务的磁盘改动
 * @param job 目标任务
 * @param force 是否忽略二次手工修改冲突强行覆盖
 */
async function rollbackJobAction(job: JobItem, force = false): Promise<void> {
  if (state.rollingBackJobId) return;
  state.rollingBackJobId = job.id;
  render();
  try {
    const res = await app.callServerTool({
      name: 'codex_job_rollback',
      arguments: {
        job_id: job.id,
        force,
      },
    });
    const sc = (
      res as {
        structuredContent?: {
          rolledBack?: boolean;
          conflicts?: string[];
          message?: string;
          error?: string;
        };
      }
    ).structuredContent;

    if (sc?.conflicts && sc.conflicts.length > 0) {
      state.confirmRollbackJobId = job.id;
      state.rollbackConflicts = sc.conflicts;
      showToast(`检测到 ${sc.conflicts.length} 个文件被二次修改，请确认是否强制覆盖`);
    } else if (sc?.rolledBack) {
      state.confirmRollbackJobId = '';
      state.rollbackConflicts = [];
      showToast(sc.message || '已成功回滚本次任务改动');
      await refreshDashboardState(true);
    } else {
      state.confirmRollbackJobId = '';
      state.rollbackConflicts = [];
      showToast(sc?.message || sc?.error || '未能执行回滚');
    }
  } catch (err) {
    showToast(`回滚失败: ${(err as Error).message}`);
  } finally {
    state.rollingBackJobId = '';
    render();
  }
}

/**
 * 清理已完成的历史任务（右侧边栏仅清理本对话及本面板绑定任务，左侧全局视图按所选分组或全部清理）
 */
async function clearFinishedJobs(): Promise<void> {
  const options = getProjectOptions();
  const activeOption = options.find((o) => o.key === state.selectedProjectKey);
  const inConvPane = isConversationPane() || state.scopeMode === 'conversation';
  const convFilter = inConvPane ? state.activeConversationId : '';
  const boundIds = inConvPane ? [...state.boundJobIds] : [];
  if (inConvPane && !convFilter && boundIds.length === 0) {
    showToast('当前对话暂无可清理的历史记录');
    return;
  }
  const projectNameFilter =
    !inConvPane && state.selectedProjectKey !== 'ALL' ? activeOption?.projectName || '' : '';
  const cwdsFilter =
    !inConvPane && state.selectedProjectKey !== 'ALL' && !projectNameFilter
      ? activeOption?.cwds || []
      : [];
  try {
    await app.callServerTool({
      name: 'app_delete_job',
      arguments: {
        job_id: 'ALL_FINISHED',
        conversation_id: convFilter || undefined,
        job_ids: boundIds.length > 0 ? boundIds : undefined,
        project_name: projectNameFilter || undefined,
        cwds: cwdsFilter.length > 0 ? cwdsFilter : undefined,
      },
    });
    if (inConvPane && state.boundJobIds.length > 0) {
      // 同步剔除已结束的本地绑定任务 ID，仅保留仍在运行中的任务
      const runningIds = new Set(
        state.jobs.filter((j) => j.status === 'running').map((j) => j.id),
      );
      state.boundJobIds = state.boundJobIds.filter((id) => runningIds.has(id));
    }
    state.selectedJobId = '';
    showToast(
      inConvPane
        ? '已清空当前对话的历史记录'
        : activeOption
          ? `已清空分组 ${activeOption.name} 的历史记录`
          : '已清空全部已完成的历史记录',
    );
    await refreshDashboardState(true);
  } catch (err) {
    showToast(`清理失败: ${(err as Error).message}`);
  }
}

/**
 * 手动向云端实时拉取最新 5 小时与 7 天周用量（适合多人共享账号场景）
 * @param silent 是否静默执行（首屏自动同步时为 true，不弹 toast）
 */
async function refreshLiveUsage(silent = false): Promise<void> {
  if (state.usageRefreshing) return;
  state.usageRefreshing = true;
  render();
  try {
    const res = await app.callServerTool({
      name: 'app_refresh_usage',
      arguments: {},
    });
    const sc = (res as { structuredContent?: { codexProfile?: CodexProfile; error?: string } })
      .structuredContent;
    if (sc?.codexProfile) {
      state.codexProfile = sc.codexProfile;
      if (!silent) showToast('已从云端同步最新 5h / 周用量');
    } else if (!silent) {
      showToast(sc?.error || '实时刷新用量失败，当前显示本地快照');
    }
  } catch (err) {
    if (!silent) showToast(`实时刷新用量失败: ${(err as Error).message}`);
  } finally {
    state.usageRefreshing = false;
    render();
  }
}

/**
 * 运行本机 codex doctor 只读环境诊断
 */
async function runDoctorCheck(): Promise<void> {
  state.doctorLoading = true;
  render();
  try {
    const res = await app.callServerTool({
      name: 'codex_doctor',
      arguments: {},
    });
    const sc = (res as { structuredContent?: DoctorReport }).structuredContent;
    if (sc) {
      state.doctor = sc;
    }
  } catch (err) {
    showToast(`诊断失败: ${(err as Error).message}`);
  } finally {
    state.doctorLoading = false;
    render();
  }
}

/**
 * 保存配置页修改到插件持久化目录
 */
async function saveSettingsFromDom(): Promise<void> {
  if (!state.config) return;
  // 先从当前双向绑定状态采集待保存数据，再切换 savingConfig 状态重绘按钮
  const f = state.settingsForm;
  const patch = {
    defaultModel: f.defaultModel.trim(),
    defaultSandbox: f.defaultSandbox === 'read-only' ? 'read-only' : 'workspace-write',
    defaultWorktree: Boolean(f.defaultWorktree),
    defaultTimeoutSec: Number(f.defaultTimeoutSec) || 300,
    defaultCwd: f.defaultCwd.trim(),
    skipGitRepoCheck: Boolean(f.skipGitRepoCheck),
  };

  state.savingConfig = true;
  render();
  try {
    const res = await app.callServerTool({
      name: 'app_save_config',
      arguments: { config: patch },
    });
    const sc = (res as { structuredContent?: { config?: PluginConfig; error?: string } })
      .structuredContent;
    if (sc?.config) {
      state.config = sc.config;
      syncSettingsForm(sc.config, true);
      if (!state.dispatchForm.cwd && sc.config.defaultCwd) {
        state.dispatchForm.cwd = sc.config.defaultCwd;
      }
      showToast('插件独立配置已保存（未修改 ~/.codex/config.toml）');
    } else {
      showToast(sc?.error || '保存失败：服务端未返回更新后的配置');
    }
  } catch (err) {
    showToast(`保存失败: ${(err as Error).message}`);
  } finally {
    state.savingConfig = false;
    render();
  }
}

/**
 * 渲染指挥发单标签页
 */
function renderDispatchView(): string {
  const presets = state.config?.presets || [];
  const f = state.dispatchForm;

  const presetsHtml = presets
    .map(
      (p) => `
      <button type="button" class="preset-btn ${state.selectedPresetId === p.id ? 'active' : ''}" data-preset="${esc(p.id)}">
        <div class="preset-name">${esc(p.name)}</div>
        <div class="preset-desc">${esc(p.description)}</div>
      </button>
    `,
    )
    .join('');

  const reviewExtra =
    f.mode === 'review'
      ? `
      <div class="field-row">
        <div class="field">
          <label for="in-review-mode">审查范围</label>
          <select id="in-review-mode">
            <option value="uncommitted" ${f.reviewMode === 'uncommitted' ? 'selected' : ''}>未提交改动 (--uncommitted)</option>
            <option value="base" ${f.reviewMode === 'base' ? 'selected' : ''}>对比基准分支 (--base)</option>
            <option value="commit" ${f.reviewMode === 'commit' ? 'selected' : ''}>指定提交 (--commit)</option>
          </select>
        </div>
        ${
          f.reviewMode === 'base'
            ? `<div class="field"><label for="in-base-branch">基准分支名</label><input id="in-base-branch" type="text" value="${esc(f.baseBranch)}" placeholder="例如 main" /></div>`
            : ''
        }
        ${
          f.reviewMode === 'commit'
            ? `<div class="field"><label for="in-commit-sha">Commit SHA</label><input id="in-commit-sha" type="text" value="${esc(f.commitSha)}" placeholder="例如 HEAD~1" /></div>`
            : ''
        }
      </div>
    `
      : '';

  return `
    <div class="card">
      <div class="card-title">
        <span>1. 选择任务预设</span>
        <span class="badge badge-muted">${f.mode === 'review' ? '代码审查模式' : '执行模式'}</span>
      </div>
      <div class="preset-grid">${presetsHtml}</div>

      <div class="field">
        <label for="in-cwd">目标工作目录（绝对路径）</label>
        <input id="in-cwd" type="text" value="${esc(f.cwd)}" placeholder="例如 D:\\projects\\my-app" />
      </div>

      ${reviewExtra}

      <div class="field">
        <label for="in-prompt">${f.mode === 'review' ? '附加审查重点（可选）' : '发给 GPT（Codex）的任务指令'}</label>
        <textarea id="in-prompt" placeholder="描述清楚目标文件、需求边界和需要运行的测试命令...">${esc(f.prompt)}</textarea>
      </div>

      <div class="field-row">
        <div class="field">
          <label for="in-model">模型覆盖（留空继承本机默认：${esc(state.codexProfile?.defaultModel || '未配置')}）</label>
          <input id="in-model" type="text" list="codex-models-list" value="${esc(f.model)}" placeholder="${esc(state.codexProfile?.defaultModel || '例如 gpt-5.3-codex')}" />
        </div>
        <div class="field">
          <label for="in-effort">推理强度（可选）</label>
          <select id="in-effort">
            <option value="" ${f.reasoningEffort === '' ? 'selected' : ''}>继承本机 (${esc(state.codexProfile?.reasoningEffort || '默认')})</option>
            <option value="low" ${f.reasoningEffort === 'low' ? 'selected' : ''}>low（快速）</option>
            <option value="medium" ${f.reasoningEffort === 'medium' ? 'selected' : ''}>medium（均衡）</option>
            <option value="high" ${f.reasoningEffort === 'high' ? 'selected' : ''}>high（深度）</option>
          </select>
        </div>
        <div class="field">
          <label for="in-sandbox">沙箱权限</label>
          <select id="in-sandbox" ${f.mode === 'review' ? 'disabled' : ''}>
            <option value="workspace-write" ${f.sandbox === 'workspace-write' ? 'selected' : ''}>workspace-write（允许修改工作区）</option>
            <option value="read-only" ${f.sandbox === 'read-only' ? 'selected' : ''}>read-only（只读分析）</option>
          </select>
        </div>
        <div class="field">
          <label for="in-timeout">超时秒数</label>
          <input id="in-timeout" type="number" min="30" max="1800" value="${esc(f.timeoutSec)}" />
        </div>
      </div>

      <div class="field">
        <label for="in-skill-picker">挂载领域技能（可选，自动注入只读规范与脚本绝对路径）</label>
        <div class="skill-picker-row">
          <input id="in-skill-picker" type="text" list="codex-skills-list" value="${esc(f.skillInput)}" placeholder="输入或选择技能名，例如 rpx-to-ureport" />
          <button id="btn-add-skill" type="button" class="btn">添加技能</button>
        </div>
        ${
          f.skills.length > 0
            ? `<div class="skill-chip-row">
                ${f.skills
                  .map(
                    (s) =>
                      `<span class="skill-chip">$${esc(s)} <button type="button" class="skill-chip-remove" data-remove-skill="${esc(s)}" title="移除该技能">×</button></span>`,
                  )
                  .join('')}
              </div>`
            : ''
        }
      </div>

      <div class="checkbox-row">
        ${
          f.mode === 'exec'
            ? `<label class="checkbox-label"><input id="in-worktree" type="checkbox" ${f.worktree ? 'checked' : ''} /> 使用独立 Git Worktree 隔离改动</label>
               <label class="checkbox-label"><input id="in-skip-git" type="checkbox" ${f.skipGitRepoCheck ? 'checked' : ''} /> 允许在非 Git 目录运行</label>`
            : ''
        }
      </div>

      <div class="btn-row">
        <button id="btn-submit-task" type="button" class="btn btn-primary" ${state.submitting ? 'disabled' : ''}>
          ${state.submitting ? '正在派发...' : f.mode === 'review' ? '启动 Codex 审查' : '派发给 Codex 执行'}
        </button>
      </div>
    </div>
  `;
}

/**
 * 渲染任务监工与验收标签页（右侧边栏严格按当前对话隔离；左侧全局视图默认展示全部并支持多文件夹项目分组筛选）
 */
function renderMonitorView(): string {
  const inConvPane = isConversationPane();
  const projectOptions = getProjectOptions();
  // 先校验当前选中的分组是否仍存在，再计算 filteredJobs，避免清空分组后当次渲染闪现空列表
  if (!inConvPane && state.selectedProjectKey !== 'ALL' && !projectOptions.some((o) => o.key === state.selectedProjectKey)) {
    state.selectedProjectKey = 'ALL';
  }
  const filteredJobs = getFilteredJobs();
  const activeOption = projectOptions.find((o) => o.key === state.selectedProjectKey);

  const clearBtnLabel = inConvPane
    ? '清空本对话'
    : state.selectedProjectKey !== 'ALL'
      ? '清空所选分组'
      : '清空全部';

  const shortConvLabel =
    state.activeConversationTitle ||
    (state.activeConversationId ? `对话 ${state.activeConversationId.slice(0, 8)}` : '当前对话');

  const formatOptionLabel = (opt: ProjectOption): string => {
    const subHint =
      opt.subNames.length >= 2
        ? `（含 ${opt.subNames.slice(0, 3).join('、')}${opt.subNames.length > 3 ? ' 等' : ''}）`
        : '';
    return `${opt.name}${subHint}（${opt.count}）`;
  };

  const projectFilterHtml = inConvPane
    ? `
      <div class="project-filter-bar">
        <div class="project-path-hint" title="右侧边栏严格按当前对话隔离：${esc(state.activeConversationId || '当前面板')}">
          仅显示当前对话：${esc(shortConvLabel)}
        </div>
      </div>
    `
    : `
      <div class="project-filter-bar">
        <select id="in-project-filter" title="按项目分组筛选任务队列">
          <option value="ALL" ${state.selectedProjectKey === 'ALL' ? 'selected' : ''}>全部任务（${state.jobs.length}）</option>
          ${projectOptions
            .map(
              (opt) =>
                `<option value="${esc(opt.key)}" ${state.selectedProjectKey === opt.key ? 'selected' : ''}>${esc(formatOptionLabel(opt))}</option>`,
            )
            .join('')}
        </select>
        <div class="project-path-hint" title="${esc(activeOption ? activeOption.cwds.join(' | ') : '显示所有对话与项目的全部任务记录')}">
          ${
            activeOption
              ? activeOption.subNames.length >= 2
                ? `已归并 ${activeOption.subNames.length} 个目录：${esc(activeOption.subNames.join('、'))}`
                : `目录：${esc(activeOption.path)}`
              : `全局视角 · 共 ${projectOptions.length} 个项目分组，${state.jobs.length} 条记录`
          }
        </div>
      </div>
    `;

  if (inConvPane && filteredJobs.length === 0) {
    const isTempPane = state.activeConversationId.startsWith('pane_');
    return `
      <div class="card empty-state">
        ${
          isTempPane
            ? '当前侧边栏为未绑定主对话的临时会话（例如刚手动重开面板），暂无任务记录。待主模型下次派单或返工调用 <code>open_codex_console</code> 时会自动绑定并同步；如需立即查看跨对话或运行中任务，请前往左侧全屏「Codex 指挥台」。'
            : '当前对话暂无 Codex 任务记录。你可以在「指挥发单」发起任务，或在对话中让主模型派发；跨对话历史请前往左侧全屏「Codex 指挥台」查看。'
        }
      </div>
    `;
  }

  if (state.jobs.length === 0) {
    return `
      <div class="card empty-state">
        暂无 Codex 任务记录。你可以在「指挥发单」里手动发起任务，或在对话中让 Antigravity 主模型派发任务。
      </div>
    `;
  }

  const selected =
    filteredJobs.find((j) => j.id === state.selectedJobId) || filteredJobs[0] || null;

  const emptyScopeListHint = inConvPane
    ? '当前对话下暂无任务记录。'
    : '该分组下暂无任务记录，可在上方切换至「全部任务」。';
  const emptyScopeDetailHint = inConvPane
    ? '当前对话还没有派发过 Codex 任务。你可以直接让主模型派单，或切到左侧全屏查看跨对话历史记录。'
    : '当前筛选的项目分组下还没有任务记录。你可以切换上方下拉框查看全部任务，或在「指挥发单」发起新任务。';

  const listHtml =
    filteredJobs.length > 0
      ? filteredJobs
          .map(
            (j) => `
      <button type="button" class="job-item ${selected && j.id === selected.id ? 'active' : ''}" data-job-id="${esc(j.id)}">
        <div class="job-item-head">
          <div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;">
            <span class="badge badge-${esc(j.status)}">${esc(j.status)}</span>
            ${j.rolledBack ? `<span class="badge badge-rolledback">已回滚</span>` : ''}
          </div>
          <span class="badge badge-muted">${j.source === 'manual' ? '手动发单' : '主模型派发'} · ${esc(j.kind)}</span>
        </div>
        <div class="job-prompt-preview">${esc(j.prompt || '(代码审查)')}</div>
        ${
          j.skills && j.skills.length > 0
            ? `<div class="skill-chip-row" style="margin-top:4px;">${j.skills.map((s) => `<span class="badge badge-muted">skill: ${esc(s)}</span>`).join('')}</div>`
            : ''
        }
        <div class="job-meta" title="${esc(j.cwd)}">${esc(j.elapsedSec)}s · ${esc(j.cwd)}</div>
      </button>
    `,
          )
          .join('')
      : `<div class="empty-state">${emptyScopeListHint}</div>`;

  if (!selected) {
    return `
      <div class="monitor-layout">
        <div class="card">
          <div class="card-title">
            <span>任务队列（0/${state.jobs.length}）</span>
            <div class="btn-row">
              <button id="btn-refresh-jobs" type="button" class="btn">刷新</button>
              <button id="btn-clear-jobs" type="button" class="btn">${clearBtnLabel}</button>
            </div>
          </div>
          ${projectFilterHtml}
          <div class="job-list" data-scroll-key="job-list">${listHtml}</div>
        </div>
        <div class="card empty-state">
          ${emptyScopeDetailHint}
        </div>
      </div>
    `;
  }

  const timelineHtml = (selected.events || [])
    .slice()
    .reverse()
    .map(
      (ev) => `
      <div class="timeline-item type-${esc(ev.type)}">
        <div class="timeline-head">
          <span>${esc(ev.title)}</span>
          <span class="timeline-time">${esc(formatShortTime(ev.ts))}</span>
        </div>
        ${ev.detail ? `<div class="timeline-detail">${esc(ev.detail)}</div>` : ''}
      </div>
    `,
    )
    .join('');

  const filesHtml =
    selected.changedFiles.length > 0
      ? `
      <div style="margin-top:10px;">
        <div style="font-size:12px;font-weight:600;color:var(--fg-2);">改动文件（点击在 Antigravity 打开）</div>
        <div class="file-chips">
          ${selected.changedFiles
            .map(
              (fp) =>
                `<button type="button" class="file-chip" data-open-file="${esc(fp)}">${esc(fp)}</button>`,
            )
            .join('')}
        </div>
      </div>
    `
      : '';

  const canRollback =
    selected.status !== 'running' &&
    !selected.rolledBack &&
    !selected.worktree &&
    selected.changedFiles.length > 0 &&
    Boolean(selected.checkpoint?.isGitRepo);

  const showRollbackConfirm = state.confirmRollbackJobId === selected.id;
  const hasConflicts = showRollbackConfirm && state.rollbackConflicts.length > 0;

  const rollbackConfirmHtml = showRollbackConfirm
    ? `
      <div class="rollback-confirm-bar">
        <div>
          ${
            hasConflicts
              ? `<strong>检测到二次手工修改冲突：</strong>以下文件在 GPT 完成后被再次修改，直接回滚会覆盖这些新改动：<code>${esc(state.rollbackConflicts.join(', '))}</code>`
              : `<strong>确认回滚本次 GPT 改动？</strong>将按任务前无侵入 Git 快照精准还原本次触碰的 ${selected.changedFiles.length} 个文件（保留你任务前原本未提交的修改），并删除本次新建文件。`
          }
        </div>
        <div class="btn-row">
          <button id="btn-confirm-rollback" type="button" class="btn btn-danger" ${state.rollingBackJobId === selected.id ? 'disabled' : ''}>
            ${state.rollingBackJobId === selected.id ? '正在回滚...' : hasConflicts ? '仍要强制覆盖回滚' : '确认回滚'}
          </button>
          <button id="btn-cancel-rollback" type="button" class="btn">取消</button>
        </div>
      </div>
    `
    : '';

  return `
    <div class="monitor-layout">
      <div class="card">
        <div class="card-title">
          <span>任务队列（${filteredJobs.length}${!inConvPane && state.selectedProjectKey !== 'ALL' && filteredJobs.length !== state.jobs.length ? `/${state.jobs.length}` : ''}）</span>
          <div class="btn-row">
            <button id="btn-refresh-jobs" type="button" class="btn">刷新</button>
            <button id="btn-clear-jobs" type="button" class="btn">${clearBtnLabel}</button>
          </div>
        </div>
        ${projectFilterHtml}
        <div class="job-list" data-scroll-key="job-list">${listHtml}</div>
      </div>

      <div class="card">
        <div class="card-title">
          <span>任务详情 · ${esc(selected.id)}</span>
          <div class="btn-row">
            <span class="badge badge-${esc(selected.status)}">${esc(selected.status)} (${esc(selected.elapsedSec)}s)</span>
            ${selected.rolledBack ? `<span class="badge badge-rolledback">已回滚</span>` : ''}
            ${
              selected.status === 'running'
                ? `<button id="btn-cancel-job" type="button" class="btn btn-danger">终止任务</button>`
                : ''
            }
            ${
              canRollback
                ? `<button id="btn-rollback-job" type="button" class="btn btn-danger" ${state.rollingBackJobId === selected.id ? 'disabled' : ''}>回滚本次改动</button>`
                : ''
            }
          </div>
        </div>

        ${rollbackConfirmHtml}

        <div class="job-meta" style="margin-bottom:8px;">
          目录：${esc(selected.cwd)} | 沙箱：${esc(selected.sandbox)}${selected.worktree ? ' | Worktree' : ''}${selected.threadId ? ` | Thread: ${esc(selected.threadId)}` : ''}
        </div>

        ${
          selected.skills && selected.skills.length > 0
            ? `<div class="skill-chip-row" style="margin-bottom:8px;">${selected.skills.map((s) => `<span class="skill-chip">$${esc(s)}</span>`).join('')}</div>`
            : ''
        }

        ${
          selected.prompt
            ? `<details id="details-prompt" ${state.promptDetailsOpen ? 'open' : ''} style="margin-bottom:8px;">
                <summary style="font-size:12px;font-weight:600;color:var(--fg-2);cursor:pointer;">${selected.source === 'model' ? 'Antigravity 主模型下达的指令' : '手动下达的指令'}</summary>
                <div class="result-box" data-scroll-key="box-prompt" style="margin-top:4px;max-height:140px;">${esc(selected.prompt)}</div>
              </details>`
            : ''
        }

        <div style="font-size:12px;font-weight:600;color:var(--fg-2);margin-top:8px;">执行步骤时间线</div>
        <div class="timeline" data-scroll-key="timeline">${timelineHtml || '<div class="empty-state">等待事件流...</div>'}</div>

        ${filesHtml}

        ${
          selected.gitDiffStat
            ? `<div style="margin-top:10px;"><div style="font-size:12px;font-weight:600;color:var(--fg-2);margin-bottom:4px;">真实 Git Diff 统计</div><div class="doctor-box" data-scroll-key="box-diff-stat">${esc(selected.gitDiffStat)}</div></div>`
            : ''
        }

        ${
          selected.error
            ? `<div style="margin-top:10px;"><div style="font-size:12px;font-weight:600;color:var(--err-fg);">错误信息</div><div class="result-box" data-scroll-key="box-error">${esc(selected.error)}</div></div>`
            : ''
        }

        ${
          selected.lastMessage
            ? `<div style="margin-top:10px;"><div style="font-size:12px;font-weight:600;color:var(--fg-2);margin-bottom:4px;">Codex 最终汇报</div><div class="result-box" data-scroll-key="box-last-message">${esc(selected.lastMessage)}</div></div>`
            : ''
        }

        ${
          selected.status !== 'running'
            ? `
          <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--bd-2);">
            <div class="field">
              <label for="in-resume">直接向该会话下达返工 / 追问指令（codex resume）</label>
              <textarea id="in-resume" style="min-height:64px;" placeholder="例如：补上边界条件的单元测试，并修复空指针风险...">${esc(state.resumeInput)}</textarea>
            </div>
            <div class="btn-row">
              <button id="btn-resume-job" type="button" class="btn btn-primary" ${state.submitting ? 'disabled' : ''}>继续返工</button>
              ${
                state.canSendMessage
                  ? `<button id="btn-send-main-review" type="button" class="btn">一键交给主模型验收</button>`
                  : `<span class="brand-sub">（全屏视图无对话上下文，验收按钮在右侧边栏可用）</span>`
              }
            </div>
          </div>
        `
            : ''
        }
      </div>
    </div>
  `;
}

/**
 * 渲染插件独立配置与环境诊断标签页
 */
function renderSettingsView(): string {
  if (!state.config) {
    return `<div class="card empty-state">正在加载配置...</div>`;
  }
  const cfg = state.settingsForm;

  return `
    <div class="card" style="margin-bottom:12px;">
      <div class="card-title">
        <span>插件独立默认配置</span>
        <span class="badge badge-muted">不修改 ~/.codex/config.toml</span>
      </div>

      <div class="field-row">
        <div class="field">
          <label for="cfg-model">默认 GPT 模型（留空继承本机：${esc(state.codexProfile?.defaultModel || '未配置')}）</label>
          <input id="cfg-model" type="text" list="codex-models-list" value="${esc(cfg.defaultModel)}" placeholder="${esc(state.codexProfile?.defaultModel || '例如 gpt-5.3-codex')}" />
        </div>
        <div class="field">
          <label for="cfg-sandbox">默认沙箱级别</label>
          <select id="cfg-sandbox">
            <option value="workspace-write" ${cfg.defaultSandbox === 'workspace-write' ? 'selected' : ''}>workspace-write</option>
            <option value="read-only" ${cfg.defaultSandbox === 'read-only' ? 'selected' : ''}>read-only</option>
          </select>
        </div>
        <div class="field">
          <label for="cfg-timeout">默认超时秒数（30-1800）</label>
          <input id="cfg-timeout" type="number" min="30" max="1800" value="${esc(cfg.defaultTimeoutSec)}" />
        </div>
      </div>

      <div class="field">
        <label for="cfg-cwd">默认工作目录（可选，用于面板快捷填充）</label>
        <input id="cfg-cwd" type="text" value="${esc(cfg.defaultCwd)}" placeholder="例如 D:\\projects\\workspace" />
      </div>

      <div class="checkbox-row">
        <label class="checkbox-label"><input id="cfg-worktree" type="checkbox" ${cfg.defaultWorktree ? 'checked' : ''} /> 默认开启 Git Worktree 隔离</label>
        <label class="checkbox-label"><input id="cfg-skip-git" type="checkbox" ${cfg.skipGitRepoCheck ? 'checked' : ''} /> 默认允许非 Git 目录运行</label>
      </div>

      <div class="btn-row">
        <button id="btn-save-config" type="button" class="btn btn-primary" ${state.savingConfig ? 'disabled' : ''}>
          ${state.savingConfig ? '保存中...' : '保存插件配置'}
        </button>
      </div>
    </div>

    <div class="card">
      <div class="card-title">
        <span>本机 codex-cli 只读诊断</span>
        <button id="btn-run-doctor" type="button" class="btn" ${state.doctorLoading ? 'disabled' : ''}>
          ${state.doctorLoading ? '诊断中...' : '运行 codex doctor'}
        </button>
      </div>
      ${
        state.doctor
          ? `
        <div class="job-meta" style="margin-bottom:8px;">
          安装状态：<strong>${state.doctor.installed ? '已安装' : '未检测到'}</strong> ·
          版本：${esc(state.doctor.version || '-')} ·
          健康：<strong>${state.doctor.healthy ? '正常' : '需排查'}</strong>
        </div>
        <div class="doctor-box">${esc(state.doctor.doctorOutput)}</div>
      `
          : `<div class="brand-sub">点击右上角按钮检查本机 codex-cli 版本、登录状态与运行健康度。</div>`
      }
    </div>
  `;
}

/**
 * 格式化用量窗口的重置倒计时文本
 * @param win 单个用量窗口
 * @returns 可读重置时间说明
 */
function formatResetHint(win: RateWindow | null): string {
  if (!win) return '暂无用量快照';
  if (win.isExpired) return '窗口已重置（待下次调用更新）';
  if (!win.resetsAt) return '重置时间未知';
  const diffMs = Date.parse(win.resetsAt) - Date.now();
  if (!Number.isFinite(diffMs) || diffMs <= 0) return '窗口即将重置';
  const totalMin = Math.ceil(diffMs / 60000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  const resetDate = new Date(win.resetsAt);
  const clock = `${String(resetDate.getMonth() + 1).padStart(2, '0')}-${String(resetDate.getDate()).padStart(2, '0')} ${resetDate.toTimeString().slice(0, 5)}`;
  if (days > 0) return `${days}天${hours}小时后重置 (${clock})`;
  if (hours > 0) return `${hours}小时${mins}分后重置 (${clock})`;
  return `${mins}分钟后重置 (${clock})`;
}

/**
 * 渲染单个用量窗口进度卡片（5 小时或 7 天周用量）
 * @param title 卡片标题
 * @param win 窗口数据
 * @returns HTML 字符串
 */
function renderUsageStatCard(title: string, win: RateWindow | null): string {
  if (!win) {
    return `
      <div class="stat-card">
        <div class="stat-head"><span>${esc(title)}</span><span class="badge badge-muted">无数据</span></div>
        <div class="stat-value">--</div>
        <div class="stat-sub">完成一次 Codex 调用后自动更新</div>
      </div>
    `;
  }
  const displayPct = win.isExpired ? 0 : win.usedPercent;
  const levelClass = win.isExpired
    ? 'level-expired'
    : win.usedPercent >= 90
      ? 'level-danger'
      : win.usedPercent >= 75
        ? 'level-warn'
        : '';
  const badgeClass = win.isExpired
    ? 'badge-muted'
    : win.usedPercent >= 90
      ? 'badge-failed'
      : win.usedPercent >= 75
        ? 'badge-cancelled'
        : 'badge-completed';

  const sourceTag =
    state.codexProfile?.usage?.source === 'live'
      ? `云端实时 · ${formatShortTime(state.codexProfile.usage.updatedAt)}`
      : '本地快照';

  return `
    <div class="stat-card">
      <div class="stat-head">
        <span>${esc(title)}</span>
        <span class="badge ${badgeClass}">${win.isExpired ? '已重置' : `已用 ${esc(win.usedPercent)}%`}</span>
      </div>
      <div class="usage-bar-track">
        <div class="usage-bar-fill ${levelClass}" style="width:${esc(displayPct)}%"></div>
      </div>
      <div class="stat-sub" title="${esc(formatResetHint(win))} · ${esc(sourceTag)}">${esc(formatResetHint(win))} · ${esc(sourceTag)}</div>
    </div>
  `;
}

/**
 * 渲染顶部 Codex 状态概览条（登录用户、默认模型、5h 用量、周用量）
 */
function renderStatusStrip(): string {
  const profile = state.codexProfile;
  const pluginModel = state.config?.defaultModel || '';
  const cliModel = profile?.defaultModel || '';
  const effectiveModel = pluginModel || cliModel || '未配置';
  const modelOrigin = pluginModel ? '插件覆盖' : cliModel ? 'config.toml' : '默认';
  const effort = profile?.reasoningEffort ? ` · 推理 ${profile.reasoningEffort}` : '';

  const account = profile?.account;
  const userLabel = account?.loggedIn
    ? account.email || account.name || '已登录'
    : '未登录';
  const planBadge = account?.planType ? account.planType.toUpperCase() : account?.loggedIn ? '已登录' : '未登录';
  const accountSub = account?.loggedIn
    ? `方式：${account.authMode || 'chatgpt'}${account.subscriptionUntil ? ` · 至 ${account.subscriptionUntil.slice(0, 10)}` : ''}`
    : '请在终端运行 codex login';

  return `
    <section class="status-strip">
      <div class="stat-card">
        <div class="stat-head">
          <span>Codex 账号</span>
          <span class="badge ${account?.loggedIn ? 'badge-completed' : 'badge-failed'}">${esc(planBadge)}</span>
        </div>
        <div class="stat-value" title="${esc(userLabel)}">${esc(userLabel)}</div>
        <div class="stat-sub" title="${esc(accountSub)}">${esc(accountSub)}</div>
      </div>

      <div class="stat-card">
        <div class="stat-head">
          <span>默认模型</span>
          <span class="badge badge-muted">${esc(modelOrigin)}</span>
        </div>
        <div class="stat-value" title="${esc(effectiveModel)}">${esc(effectiveModel)}</div>
        <div class="stat-sub">本机配置：${esc(cliModel || '未设置')}${esc(effort)}</div>
      </div>

      ${renderUsageStatCard('5 小时用量', profile?.usage?.primary || null)}
      ${renderUsageStatCard('7 天周用量', profile?.usage?.secondary || null)}
    </section>
  `;
}

/**
 * 全量渲染应用界面并绑定事件监听（渲染前后自动保存并恢复滚动位置与折叠状态，避免轮询导致日志跳回顶部）
 */
function render(): void {
  const root = document.getElementById('root');
  if (!root) return;

  // 渲染前快照当前所有可滚动容器位置与指令折叠状态
  const prevWindowScrollY = window.scrollY;
  const scrollSnapshot = new Map<string, number>();
  root.querySelectorAll<HTMLElement>('[data-scroll-key]').forEach((el) => {
    const key = el.dataset.scrollKey;
    if (key) scrollSnapshot.set(key, el.scrollTop);
  });
  const prevDetails = document.getElementById('details-prompt') as HTMLDetailsElement | null;
  if (prevDetails) {
    state.promptDetailsOpen = prevDetails.open;
  }

  const sameTab = state.lastRenderedTab === state.activeTab;
  // 计算当前监工页实际展示的任务 ID，避免首次 selectedJobId 为空时被误判为切换任务导致滚动条重置
  const visibleJobs = state.activeTab === 'monitor' ? getFilteredJobs() : [];
  const effectiveJobId =
    state.activeTab === 'monitor'
      ? visibleJobs.find((j) => j.id === state.selectedJobId)?.id || visibleJobs[0]?.id || ''
      : state.selectedJobId;
  const sameJob = sameTab && state.lastRenderedJobId === effectiveJobId;

  const runningCount = getFilteredJobs().filter((j) => j.status === 'running').length;
  const contentHtml =
    state.activeTab === 'dispatch'
      ? renderDispatchView()
      : state.activeTab === 'monitor'
        ? renderMonitorView()
        : renderSettingsView();

  const modelsDatalist = (state.codexProfile?.availableModels || [])
    .map((m) => `<option value="${esc(m)}"></option>`)
    .join('');

  const skillsDatalist = (state.availableSkills || [])
    .map((s) => `<option value="${esc(s.name)}">${esc(s.description)}</option>`)
    .join('');

  root.innerHTML = `
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <span class="brand-dot"></span>
          <div>
            <div class="brand-title">Codex 指挥台</div>
            <div class="brand-sub">Antigravity × 本地 codex-cli 协同工作台</div>
          </div>
        </div>
        <div class="btn-row">
          <button id="btn-refresh-usage" type="button" class="icon-btn" ${state.usageRefreshing ? 'disabled' : ''} title="向云端实时拉取最新 5h 与 7 天周用量（多人共用账号推荐）">
            ${state.usageRefreshing ? '同步用量中...' : '刷新用量'}
          </button>
          <nav class="nav-tabs">
            <button type="button" class="nav-tab ${state.activeTab === 'dispatch' ? 'active' : ''}" data-tab="dispatch">指挥发单</button>
            <button type="button" class="nav-tab ${state.activeTab === 'monitor' ? 'active' : ''}" data-tab="monitor">
              任务监工 ${runningCount > 0 ? `<span class="pill-count">${runningCount}</span>` : ''}
            </button>
            <button type="button" class="nav-tab ${state.activeTab === 'settings' ? 'active' : ''}" data-tab="settings">配置与诊断</button>
          </nav>
        </div>
      </header>
      ${renderStatusStrip()}
      <main>${contentHtml}</main>
      <datalist id="codex-models-list">${modelsDatalist}</datalist>
      <datalist id="codex-skills-list">${skillsDatalist}</datalist>
      ${state.toast ? `<div class="toast">${esc(state.toast)}</div>` : ''}
    </div>
  `;

  bindEvents();

  // 渲染后恢复滚动条位置：同一任务仅数据更新时恢复全部容器，切换任务时仅保留队列列表滚动位置
  if (sameTab) {
    root.querySelectorAll<HTMLElement>('[data-scroll-key]').forEach((el) => {
      const key = el.dataset.scrollKey;
      if (!key || !scrollSnapshot.has(key)) return;
      if (sameJob || key === 'job-list') {
        el.scrollTop = scrollSnapshot.get(key) || 0;
      }
    });
    if (sameJob) {
      window.scrollTo(0, prevWindowScrollY);
    }
  }

  state.lastRenderedTab = state.activeTab;
  state.lastRenderedJobId = effectiveJobId;
}

/**
 * 绑定当前 DOM 中的交互事件与表单双向状态同步
 */
function bindEvents(): void {
  const refreshUsageBtn = document.getElementById('btn-refresh-usage');
  if (refreshUsageBtn) {
    refreshUsageBtn.onclick = () => void refreshLiveUsage(false);
  }

  document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((btn) => {
    btn.onclick = () => {
      state.activeTab = (btn.dataset.tab as TabKey) || 'dispatch';
      render();
    };
  });

  document.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((btn) => {
    btn.onclick = () => applyPreset(btn.dataset.preset || '');
  });

  const bindInput = (id: string, onChange: (val: string) => void) => {
    const el = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
    if (el) {
      el.oninput = () => onChange(el.value);
      el.onchange = () => onChange(el.value);
    }
  };
  const bindCheckbox = (id: string, onChange: (checked: boolean) => void) => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) el.onchange = () => onChange(el.checked);
  };

  bindInput('in-cwd', (v) => (state.dispatchForm.cwd = v));
  bindInput('in-prompt', (v) => (state.dispatchForm.prompt = v));
  bindInput('in-model', (v) => (state.dispatchForm.model = v));
  bindInput('in-effort', (v) => {
    state.dispatchForm.reasoningEffort = (v as '' | 'low' | 'medium' | 'high') || '';
  });
  bindInput('in-sandbox', (v) => {
    state.dispatchForm.sandbox = v === 'read-only' ? 'read-only' : 'workspace-write';
  });
  bindInput('in-timeout', (v) => (state.dispatchForm.timeoutSec = Number(v) || 300));
  bindInput('in-review-mode', (v) => {
    state.dispatchForm.reviewMode = (v as 'uncommitted' | 'base' | 'commit') || 'uncommitted';
    render();
  });
  bindInput('in-base-branch', (v) => (state.dispatchForm.baseBranch = v));
  bindInput('in-commit-sha', (v) => (state.dispatchForm.commitSha = v));
  bindInput('in-skill-picker', (v) => (state.dispatchForm.skillInput = v));
  bindCheckbox('in-worktree', (c) => (state.dispatchForm.worktree = c));
  bindCheckbox('in-skip-git', (c) => (state.dispatchForm.skipGitRepoCheck = c));

  const skillInputEl = document.getElementById('in-skill-picker') as HTMLInputElement | null;
  if (skillInputEl) {
    skillInputEl.onkeydown = (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        addSkillToForm(skillInputEl.value);
      }
    };
  }
  const addSkillBtn = document.getElementById('btn-add-skill');
  if (addSkillBtn) {
    addSkillBtn.onclick = () => addSkillToForm(state.dispatchForm.skillInput);
  }
  document.querySelectorAll<HTMLButtonElement>('[data-remove-skill]').forEach((btn) => {
    btn.onclick = () => removeSkillFromForm(btn.dataset.removeSkill || '');
  });

  const submitBtn = document.getElementById('btn-submit-task');
  if (submitBtn) submitBtn.onclick = () => void submitManualTask();

  const projectFilterEl = document.getElementById('in-project-filter') as HTMLSelectElement | null;
  if (projectFilterEl) {
    projectFilterEl.onchange = () => {
      state.selectedProjectKey = projectFilterEl.value || 'ALL';
      state.scopeMode = state.selectedProjectKey === 'ALL' ? 'all' : 'project';
      state.confirmRollbackJobId = '';
      state.rollbackConflicts = [];
      const visible = getFilteredJobs();
      state.selectedJobId = visible[0]?.id || '';
      render();
    };
  }

  document.querySelectorAll<HTMLButtonElement>('[data-job-id]').forEach((btn) => {
    btn.onclick = () => {
      state.selectedJobId = btn.dataset.jobId || '';
      state.confirmRollbackJobId = '';
      state.rollbackConflicts = [];
      render();
    };
  });

  const refreshBtn = document.getElementById('btn-refresh-jobs');
  if (refreshBtn) refreshBtn.onclick = () => void refreshDashboardState(true);

  const clearBtn = document.getElementById('btn-clear-jobs');
  if (clearBtn) clearBtn.onclick = () => void clearFinishedJobs();

  const filteredJobs = getFilteredJobs();
  const selectedJob = filteredJobs.find((j) => j.id === state.selectedJobId) || filteredJobs[0];
  if (selectedJob) {
    const cancelBtn = document.getElementById('btn-cancel-job');
    if (cancelBtn) cancelBtn.onclick = () => void cancelRunningJob(selectedJob.id);

    const rollbackBtn = document.getElementById('btn-rollback-job');
    if (rollbackBtn) {
      rollbackBtn.onclick = () => {
        state.confirmRollbackJobId = selectedJob.id;
        state.rollbackConflicts = [];
        render();
      };
    }

    const confirmRollbackBtn = document.getElementById('btn-confirm-rollback');
    if (confirmRollbackBtn) {
      confirmRollbackBtn.onclick = () => {
        const force = state.rollbackConflicts.length > 0;
        void rollbackJobAction(selectedJob, force);
      };
    }

    const cancelRollbackBtn = document.getElementById('btn-cancel-rollback');
    if (cancelRollbackBtn) {
      cancelRollbackBtn.onclick = () => {
        state.confirmRollbackJobId = '';
        state.rollbackConflicts = [];
        render();
      };
    }

    const promptDetailsEl = document.getElementById('details-prompt') as HTMLDetailsElement | null;
    if (promptDetailsEl) {
      promptDetailsEl.ontoggle = () => {
        state.promptDetailsOpen = promptDetailsEl.open;
      };
    }

    bindInput('in-resume', (v) => (state.resumeInput = v));
    const resumeBtn = document.getElementById('btn-resume-job');
    if (resumeBtn) resumeBtn.onclick = () => void submitResumeTask(selectedJob);

    const sendReviewBtn = document.getElementById('btn-send-main-review');
    if (sendReviewBtn) sendReviewBtn.onclick = () => void sendToMainAgentForReview(selectedJob);

    document.querySelectorAll<HTMLButtonElement>('[data-open-file]').forEach((btn) => {
      btn.onclick = () => void openChangedFile(btn.dataset.openFile || '', selectedJob.cwd);
    });
  }

  bindInput('cfg-model', (v) => {
    state.settingsForm.defaultModel = v;
    state.settingsDirty = true;
  });
  bindInput('cfg-sandbox', (v) => {
    state.settingsForm.defaultSandbox = v === 'read-only' ? 'read-only' : 'workspace-write';
    state.settingsDirty = true;
  });
  bindInput('cfg-timeout', (v) => {
    state.settingsForm.defaultTimeoutSec = Number(v) || 300;
    state.settingsDirty = true;
  });
  bindInput('cfg-cwd', (v) => {
    state.settingsForm.defaultCwd = v;
    state.settingsDirty = true;
  });
  bindCheckbox('cfg-worktree', (c) => {
    state.settingsForm.defaultWorktree = c;
    state.settingsDirty = true;
  });
  bindCheckbox('cfg-skip-git', (c) => {
    state.settingsForm.skipGitRepoCheck = c;
    state.settingsDirty = true;
  });

  const saveCfgBtn = document.getElementById('btn-save-config');
  if (saveCfgBtn) saveCfgBtn.onclick = () => void saveSettingsFromDom();

  const doctorBtn = document.getElementById('btn-run-doctor');
  if (doctorBtn) doctorBtn.onclick = () => void runDoctorCheck();
}

/**
 * 同步宿主主题与 CSS 变量
 */
function syncHostTheme(ctx: ReturnType<App['getHostContext']>): void {
  if (ctx?.theme) applyDocumentTheme(ctx.theme);
  if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
}

/**
 * 初始化 MCP App 连接、生命周期回调与后台轮询器
 */
async function bootstrap(): Promise<void> {
  // 在 connect 之前注册所有处理器，确保不错过初始工具结果与主题推送
  app.ontoolresult = (result) => {
    const sc = (
      result as {
        structuredContent?: {
          focusTab?: TabKey;
          selectedJobId?: string;
          activeProjectCwd?: string;
          activeConversationId?: string;
          activeConversationTitle?: string;
          availableSkills?: SkillSummary[];
          config?: PluginConfig;
          jobs?: JobItem[];
          codexProfile?: CodexProfile;
        };
      }
    ).structuredContent;
    if (sc?.codexProfile) state.codexProfile = sc.codexProfile;
    if (Array.isArray(sc?.availableSkills)) state.availableSkills = sc.availableSkills;
    if (sc?.activeProjectCwd) {
      syncDefaultProjectFilter(sc.activeProjectCwd);
    }
    if (sc?.activeConversationId) {
      bindConversationScope(sc.activeConversationId, sc.activeConversationTitle || '');
    } else if (sc?.selectedJobId && isConversationPane()) {
      // 主模型仅传 jobId 而漏传 conversation_id 时，将该任务绑定到当前侧边栏，避免泄露其他对话记录
      addBoundJobId(sc.selectedJobId);
      state.scopeMode = 'conversation';
    }
    if (sc?.config) {
      state.config = sc.config;
      syncSettingsForm(sc.config, false);
      if (!state.dispatchForm.cwd) {
        state.dispatchForm.cwd = state.activeProjectCwd || sc.config.defaultCwd || '';
      }
    }
    if (Array.isArray(sc?.jobs)) state.jobs = sc.jobs;
    if (sc?.selectedJobId) {
      state.selectedJobId = sc.selectedJobId;
      state.confirmRollbackJobId = '';
      state.rollbackConflicts = [];
    }
    if (sc?.focusTab) state.activeTab = sc.focusTab;
    // 清空旧数据指纹，确保显式推送新任务后下一轮轮询不被误判为未变化
    state.lastDashboardSignature = '';
    render();
  };

  app.onhostcontextchanged = (ctx) => {
    syncHostTheme(ctx);
  };

  render();

  await app.connect();
  syncHostTheme(app.getHostContext());
  const caps = app.getHostCapabilities();
  state.canSendMessage = Boolean((caps as { message?: unknown } | undefined)?.message);
  if (state.canSendMessage) {
    // 对话右侧边栏默认即刻锁定当前对话隔离，空参数打开时绝不暴露其他对话历史
    state.scopeMode = 'conversation';
    // 若 connect 之前 ontoolresult 已带入无 conversationId 的 selectedJobId，此处补绑避免时序漏绑
    if (!state.activeConversationId && state.selectedJobId) {
      addBoundJobId(state.selectedJobId);
    }
    if (!state.activeConversationId) {
      ensurePaneConversationId();
    }
  } else {
    // 左侧全屏全局视图不属于任何项目，默认展示全部任务
    state.scopeMode = 'all';
    state.selectedProjectKey = 'ALL';
  }

  await refreshDashboardState();
  // 首屏加载完成后后台静默向云端同步一次实时用量，不阻塞界面渲染
  void refreshLiveUsage(true);

  // 动态轮询：有运行中任务时每 2 秒刷新时间线，空闲时每 6 秒检测是否有主模型新派发的任务
  let idleTick = 0;
  window.setInterval(() => {
    // 用户正在输入表单控件时跳过后台轮询，防止重建 DOM 抢焦点
    const activeTag = document.activeElement?.tagName || '';
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(activeTag)) {
      return;
    }
    const hasRunning = state.jobs.some((j) => j.status === 'running');
    if (hasRunning) {
      idleTick = 0;
      void refreshDashboardState();
    } else {
      idleTick += 1;
      if (idleTick >= 3) {
        idleTick = 0;
        void refreshDashboardState();
      }
    }
  }, 2000);
}

void bootstrap();
