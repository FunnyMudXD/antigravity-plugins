import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** 持久化保留的历史任务最大条数 */
const MAX_STORED_JOBS = 50;

/** 单个任务保留的结构化时间线事件最大条数 */
const MAX_EVENTS_PER_JOB = 80;

/**
 * 归一化项目工作区路径，用于跨平台（特别是 Windows 大小写与斜杠差异）的可靠比对
 * @param {string} cwd 原始目录路径
 * @returns {string} 归一化后的比对键
 */
export function normalizeProjectPath(cwd) {
  const raw = String(cwd || '').trim();
  if (!raw) return '';
  const unified = raw.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? unified.toLowerCase() : unified;
}

/**
 * 任务状态与历史记录仓库（内存保存活跃子进程引用，磁盘持久化历史摘要）
 */
export class JobStore {
  /**
   * @param {string} dataDir 插件持久化数据目录
   */
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, 'jobs.json');
    /** @type {Map<string, object>} 任务数据表 */
    this.jobs = new Map();
    /** @type {Map<string, import('node:child_process').ChildProcess>} 运行中子进程句柄 */
    this.processes = new Map();
    /** @type {Map<string, Set<() => void>>} 等待任务结束的长连接唤醒回调集合 */
    this.waiters = new Map();
    this.#loadFromDisk();
  }

  /**
   * 从磁盘恢复历史任务；若上次进程异常退出仍有残留 running 状态，自动标记为 interrupted
   */
  #loadFromDisk() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const list = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (!Array.isArray(list)) return;
      for (const item of list) {
        if (!item || !item.id) continue;
        if (item.status === 'running') {
          item.status = 'failed';
          item.error = item.error || 'MCP Server 重启导致该任务中断';
          item.finishedAt = item.finishedAt || new Date().toISOString();
        }
        this.jobs.set(item.id, item);
      }
    } catch {
      // 历史文件损坏时静默忽略，避免阻塞服务启动
    }
  }

  /**
   * 将当前任务列表持久化到磁盘，按创建时间倒序裁剪至上限
   */
  #persist() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const sorted = this.listJobs().slice(0, MAX_STORED_JOBS);
      // 同步清理内存中超出保留上限且已结束的旧任务
      const keepIds = new Set(sorted.map((item) => item.id));
      for (const [id, job] of this.jobs.entries()) {
        if (!keepIds.has(id) && job.status !== 'running') {
          this.jobs.delete(id);
        }
      }
      const tempPath = `${this.filePath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(sorted, null, 2), 'utf8');
      fs.renameSync(tempPath, this.filePath);
    } catch {
      // 磁盘写入失败不应中断主任务执行
    }
  }

  /**
   * 创建一条新任务记录
   * @param {object} params 任务初始信息
   * @returns {object} 新创建的任务对象
   */
  createJob(params) {
    const id = `job_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
    const now = new Date().toISOString();
    const job = {
      id,
      kind: params.kind || 'exec',
      source: params.source || 'model',
      status: 'running',
      prompt: params.prompt || '',
      cwd: params.cwd || '',
      presetId: params.presetId || '',
      model: params.model || '',
      sandbox: params.sandbox || 'workspace-write',
      worktree: Boolean(params.worktree),
      conversationId: String(params.conversationId || '').trim(),
      conversationTitle: String(params.conversationTitle || '').trim().slice(0, 80),
      skills: Array.isArray(params.skills) ? params.skills.filter(Boolean) : [],
      missingSkills: Array.isArray(params.missingSkills) ? params.missingSkills.filter(Boolean) : [],
      addDirs: Array.isArray(params.addDirs) ? params.addDirs.filter(Boolean) : [],
      checkpoint: params.checkpoint || null,
      rolledBack: false,
      rolledBackAt: '',
      threadId: params.threadId || '',
      createdAt: now,
      updatedAt: now,
      finishedAt: '',
      exitCode: null,
      lastMessage: '',
      error: '',
      changedFiles: [],
      gitDiffStat: '',
      commandsRun: [],
      events: [
        {
          ts: now,
          type: 'lifecycle',
          title: '任务已启动',
          detail: `模式: ${params.kind || 'exec'} | 沙箱: ${params.sandbox || 'workspace-write'}`,
        },
        ...(Array.isArray(params.missingSkills) && params.missingSkills.length > 0
          ? [
              {
                ts: now,
                type: 'error',
                title: '部分指定技能未找到（已忽略）',
                detail: params.missingSkills.join(', '),
              },
            ]
          : []),
      ],
    };
    this.jobs.set(id, job);
    this.#persist();
    return this.getJob(id);
  }

  /**
   * 绑定任务对应的运行中子进程，用于后续取消操作
   * @param {string} jobId 任务 ID
   * @param {import('node:child_process').ChildProcess} child 子进程对象
   */
  attachProcess(jobId, child) {
    this.processes.set(jobId, child);
  }

  /**
   * 解除任务与子进程的绑定
   * @param {string} jobId 任务 ID
   */
  detachProcess(jobId) {
    this.processes.delete(jobId);
  }

  /**
   * 向任务追加一条结构化时间线事件，并更新时间戳
   * @param {string} jobId 任务 ID
   * @param {object} event 事件对象 { type, title, detail }
   */
  appendEvent(jobId, event) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    const now = new Date().toISOString();
    job.events.push({
      ts: now,
      type: event.type || 'info',
      title: String(event.title || '').slice(0, 120),
      detail: String(event.detail || '').slice(0, 400),
    });
    if (job.events.length > MAX_EVENTS_PER_JOB) {
      job.events = job.events.slice(-MAX_EVENTS_PER_JOB);
    }
    job.updatedAt = now;
  }

  /**
   * 更新任务的可变字段（如 threadId、changedFiles、commandsRun、lastMessage）
   * @param {string} jobId 任务 ID
   * @param {object} patch 更新内容
   */
  updateJob(jobId, patch) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    if (patch.threadId) job.threadId = patch.threadId;
    if (patch.lastMessage !== undefined) job.lastMessage = patch.lastMessage;
    if (patch.error !== undefined) job.error = patch.error;
    if (Array.isArray(patch.changedFiles)) {
      const merged = new Set([...job.changedFiles, ...patch.changedFiles]);
      job.changedFiles = Array.from(merged);
    }
    if (Array.isArray(patch.commandsRun)) {
      const merged = new Set([...job.commandsRun, ...patch.commandsRun]);
      job.commandsRun = Array.from(merged);
    }
    job.updatedAt = new Date().toISOString();
  }

  /**
   * 将任务标记为终态（completed / failed / cancelled）并落盘
   * @param {string} jobId 任务 ID
   * @param {'completed'|'failed'|'cancelled'} status 终态
   * @param {object} details 附加结果信息
   * @returns {object|null} 更新后的任务快照
   */
  finishJob(jobId, status, details = {}) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    // 若任务已被用户取消，不覆盖为 failed
    if (job.status === 'cancelled' && status === 'failed') {
      return this.getJob(jobId);
    }
    const now = new Date().toISOString();
    job.status = status;
    job.finishedAt = now;
    job.updatedAt = now;
    if (details.exitCode !== undefined) job.exitCode = details.exitCode;
    if (details.threadId) job.threadId = details.threadId;
    if (details.lastMessage !== undefined) job.lastMessage = details.lastMessage;
    if (details.error !== undefined) job.error = details.error;
    if (Array.isArray(details.changedFiles)) {
      job.changedFiles = Array.from(new Set([...job.changedFiles, ...details.changedFiles]));
    }
    if (details.gitDiffStat !== undefined) {
      job.gitDiffStat = details.gitDiffStat;
    }
    if (details.postFileMtimes && job.checkpoint) {
      job.checkpoint.postFileMtimes = details.postFileMtimes;
    }
    this.appendEvent(jobId, {
      type: 'lifecycle',
      title:
        status === 'completed'
          ? '任务执行完成'
          : status === 'cancelled'
            ? '任务已被取消'
            : '任务执行失败',
      detail: details.error || `退出码: ${job.exitCode ?? '-'}`,
    });
    this.detachProcess(jobId);
    this.#persist();
    this.#notifyWaiters(jobId);
    return this.getJob(jobId);
  }

  /**
   * 唤醒所有正在长等待指定任务结束的调用方
   * @param {string} jobId 任务 ID
   */
  #notifyWaiters(jobId) {
    const set = this.waiters.get(jobId);
    if (!set) return;
    for (const wake of set) {
      try {
        wake();
      } catch {
        // 忽略单个回调异常
      }
    }
    this.waiters.delete(jobId);
  }

  /**
   * 阻塞等待指定任务结束或达到最大等待秒数（避免主模型高频空轮询消耗 Token）
   * @param {string} jobId 任务 ID
   * @param {number} waitSec 最大等待秒数（0 表示立即返回）
   * @returns {Promise<object|null>} 任务快照
   */
  waitForJob(jobId, waitSec = 0) {
    const current = this.getJob(jobId);
    const clampedSec = Math.max(0, Math.min(180, Math.round(Number(waitSec) || 0)));
    if (!current || current.status !== 'running' || clampedSec <= 0) {
      return Promise.resolve(current);
    }

    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const set = this.waiters.get(jobId);
        if (set) {
          set.delete(finish);
          if (set.size === 0) this.waiters.delete(jobId);
        }
        resolve(this.getJob(jobId));
      };

      const timer = setTimeout(finish, clampedSec * 1000);
      if (!this.waiters.has(jobId)) {
        this.waiters.set(jobId, new Set());
      }
      this.waiters.get(jobId).add(finish);
    });
  }

  /**
   * 强制取消一个正在运行的任务，并在 Windows 下清理整棵子进程树
   * @param {string} jobId 任务 ID
   * @returns {{ cancelled: boolean, job: object|null, message: string }} 取消结果
   */
  cancelJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) {
      return { cancelled: false, job: null, message: `未找到任务 ${jobId}` };
    }
    if (job.status !== 'running') {
      return {
        cancelled: false,
        job: this.getJob(jobId),
        message: `任务当前状态为 ${job.status}，无需取消`,
      };
    }

    const child = this.processes.get(jobId);
    if (child && child.pid) {
      if (process.platform === 'win32') {
        // Windows 下使用 taskkill /T /F 确保 cmd 包装器与其拉起的 codex 子进程一并终止
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

    const updated = this.finishJob(jobId, 'cancelled', { error: '用户主动取消任务' });
    return { cancelled: true, job: updated, message: `已终止任务 ${jobId}` };
  }

  /**
   * 标记任务已完成代码回滚，记录回滚时间并在时间线追加审计事件
   * @param {string} jobId 任务 ID
   * @param {string} detail 回滚摘要说明
   * @returns {object|null} 更新后的任务快照
   */
  markJobRolledBack(jobId, detail) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    const now = new Date().toISOString();
    job.rolledBack = true;
    job.rolledBackAt = now;
    job.updatedAt = now;
    this.appendEvent(jobId, {
      type: 'lifecycle',
      title: '已回滚本次任务改动',
      detail: detail || '已按任务前 Git 快照还原磁盘文件',
    });
    this.#persist();
    return this.getJob(jobId);
  }

  /**
   * 根据 Codex 会话 threadId 查找最近一条匹配的任务，用于返工时自动继承原对话 ID
   * @param {string} threadId Codex 会话线程 ID
   * @returns {object|null} 匹配的任务快照
   */
  findJobByThreadId(threadId) {
    const tid = String(threadId || '').trim();
    if (!tid) return null;
    const matched = this.listJobs().find((j) => j.threadId === tid);
    return matched || null;
  }

  /**
   * 查找指定工作目录下最近一条带 conversationId 的任务，供 use_last 返工兜底继承原对话
   * @param {string} cwd 目标工作区路径
   * @returns {object|null} 匹配的任务快照
   */
  findLatestJobByCwd(cwd) {
    const key = normalizeProjectPath(cwd);
    if (!key) return null;
    const matched = this.listJobs().find(
      (j) => normalizeProjectPath(j.cwd) === key && Boolean(j.conversationId),
    );
    return matched || null;
  }

  /**
   * 删除单条或全部已完成的历史任务（支持按对话 ID 或项目目录筛选）
   * @param {string|undefined} jobId 指定任务 ID；若传 "ALL_FINISHED" 则清空所有非运行中任务
   * @param {string|{ cwd?: string, conversationId?: string }} [filter] 可选过滤条件（兼容旧版纯 cwd 字符串）
   * @returns {{ deletedCount: number }} 删除条数
   */
  deleteJob(jobId, filter = '') {
    if (jobId === 'ALL_FINISHED') {
      const cwdFilter = typeof filter === 'string' ? filter : filter?.cwd || '';
      const convFilter = typeof filter === 'object' && filter ? String(filter.conversationId || '').trim() : '';
      const targetKey = normalizeProjectPath(cwdFilter);
      let deletedCount = 0;
      for (const [id, job] of this.jobs.entries()) {
        if (job.status !== 'running') {
          if (convFilter && String(job.conversationId || '').trim() !== convFilter) {
            continue;
          }
          if (targetKey && normalizeProjectPath(job.cwd) !== targetKey) {
            continue;
          }
          this.jobs.delete(id);
          deletedCount += 1;
        }
      }
      this.#persist();
      return { deletedCount };
    }

    const job = this.jobs.get(jobId);
    if (!job || job.status === 'running') {
      return { deletedCount: 0 };
    }
    this.jobs.delete(jobId);
    this.#persist();
    return { deletedCount: 1 };
  }

  /**
   * 获取单个任务快照（附带实时已耗时秒数）
   * @param {string} jobId 任务 ID
   * @returns {object|null} 任务副本
   */
  getJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    const endMs = job.finishedAt ? Date.parse(job.finishedAt) : Date.now();
    const startMs = Date.parse(job.createdAt);
    const elapsedSec = Number.isFinite(startMs) ? Math.max(0, Math.round((endMs - startMs) / 1000)) : 0;
    return {
      ...structuredClone(job),
      elapsedSec,
    };
  }

  /**
   * 按创建时间倒序返回任务列表
   * @param {number} limit 返回条数上限
   * @returns {object[]} 任务数组
   */
  listJobs(limit = MAX_STORED_JOBS) {
    return Array.from(this.jobs.values())
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, limit)
      .map((item) => this.getJob(item.id));
  }
}
