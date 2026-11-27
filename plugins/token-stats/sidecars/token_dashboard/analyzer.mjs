/**
 * Token Stats 对话日志解析与子智能体递归聚合模块。
 *
 * 零外部依赖（仅使用 Node 内置模块），负责：
 * 1. 定位 Antigravity brain 目录下的 transcript.jsonl 与 swarm/members.json；
 * 2. 解析单对话的轮次、步数、缓存命中率、耗时及派发出的子智能体引用；
 * 3. 递归追踪 invoke_subagent（含多层嵌套）与 swarm worker 子对话；
 * 4. 维护按 conversationId 粒度的增量缓存，并生成覆盖全部子孙对话的联合 ETag。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export const ID_RE = /^[0-9a-f-]{8,}$/i;
const CREATED_RE = /Created At:\s*([0-9T:\-.+Z]+)/;
const COMPLETED_RE = /Completed At:\s*([0-9T:\-.+Z]+)/;
const USER_REQ_RE = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i;
const SUBAGENT_CREATED_RE = /Created the following subagent:\s*(\{[\s\S]*?\n\})/;
const CONV_ID_FIELD_RE = /"conversation(?:Id|_id)"\s*:\s*"([0-9a-f-]{8,})"/i;
const LOG_URI_FIELD_RE = /"logAbsoluteUri"\s*:\s*"([^"]+)"/i;

const MAX_SUBAGENT_DEPTH = 6;
const MAX_SUBAGENT_COUNT = 64;
const ACTIVE_WINDOW_MS = 15_000;
const MAX_CACHE_ENTRIES = 128;

// 单对话解析缓存：convId -> { fileEtag, mtimeMs, size, parsed }
const transcriptCache = new Map();

/**
 * 定位所有可能存放 brain 对话目录的 Antigravity appData 根路径。
 *
 * @returns {string[]} 存在的 appData 目录路径列表
 */
export function findAppDataDirs() {
  const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (dataDir) {
    for (let d = dataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) !== 'sidecar_data') continue;
      const appData = dirname(d);
      if (existsSync(join(appData, 'brain'))) return [appData];
    }
  }
  const geminiRoot = join(homedir(), '.gemini');
  const dirs = [];
  const preferred = join(geminiRoot, 'antigravity');
  if (existsSync(join(preferred, 'brain'))) dirs.push(preferred);
  try {
    for (const ent of readdirSync(geminiRoot, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const full = join(geminiRoot, ent.name);
      if (full === preferred) continue;
      if (existsSync(join(full, 'brain'))) dirs.push(full);
    }
  } catch {
    // 忽略目录不可读异常
  }
  return dirs;
}

/**
 * 根据会话 ID 查找其 transcript.jsonl 的本地绝对路径。
 *
 * @param {string} convId 会话 UUID
 * @param {string[]} [appDataDirs] 可选的 appData 目录列表（用于测试注入或复用）
 * @returns {string | null} 找到的 transcript.jsonl 路径，不存在时返回 null
 */
export function findTranscriptPath(convId, appDataDirs = null) {
  if (!convId || !ID_RE.test(convId)) return null;
  const dirs = appDataDirs || findAppDataDirs();
  for (const appData of dirs) {
    const p = join(appData, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * 查找指定会话下的 swarm/members.json 路径（如果该会话启用过 swarm）。
 *
 * @param {string} convId 会话 UUID
 * @param {string[]} [appDataDirs] 可选的 appData 目录列表
 * @returns {string | null} members.json 路径，不存在时返回 null
 */
export function findSwarmMembersPath(convId, appDataDirs = null) {
  if (!convId || !ID_RE.test(convId)) return null;
  const dirs = appDataDirs || findAppDataDirs();
  for (const appData of dirs) {
    const p = join(appData, 'brain', convId, '.system_generated', 'swarm', 'members.json');
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * 解析 ISO 时间戳为毫秒数。
 *
 * @param {string | null | undefined} ts ISO 时间字符串
 * @returns {number | null} 毫秒时间戳，非法输入返回 null
 */
function parseIsoMs(ts) {
  if (!ts || typeof ts !== 'string') return null;
  const ms = Date.parse(ts.trim());
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 合并重叠的工具执行时间区间，返回去重后的总耗时（毫秒）。
 *
 * @param {Array<[number, number]>} intervals 时间区间列表
 * @returns {number} 合并后的总毫秒数
 */
function mergeIntervalsMs(intervals) {
  const valid = intervals
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s && e - s < 3_600_000)
    .sort((a, b) => a[0] - b[0]);
  if (!valid.length) return 0;
  const merged = [valid[0]];
  for (let i = 1; i < valid.length; i++) {
    const [s, e] = valid[i];
    const last = merged[merged.length - 1];
    if (s <= last[1]) {
      if (e > last[1]) last[1] = e;
    } else {
      merged.push([s, e]);
    }
  }
  let sum = 0;
  for (const [s, e] of merged) sum += e - s;
  return sum;
}

/**
 * 将底层模型标识格式化为易读名称（例如 gemini-4-neon-medium -> Gemini 4 Neon (Medium)）。
 *
 * @param {string | null | undefined} raw 原始模型名
 * @returns {string} 格式化后的模型展示名
 */
export function formatModelName(raw) {
  if (!raw || typeof raw !== 'string') return 'Unknown';
  const cleaned = raw.trim();
  if (!cleaned) return 'Unknown';
  // 如果本身已经是带空格的展示名（如 swarm 的 model_display_name），直接返回
  if (cleaned.includes(' ')) return cleaned;
  const parts = cleaned.split('-').filter(Boolean);
  if (!parts.length) return 'Unknown';
  const tiers = new Set(['high', 'medium', 'low', 'fast', 'thinking', 'xhigh']);
  const cap = (w) => (/^\d+$/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1));
  if (parts.length >= 2 && tiers.has(parts[parts.length - 1].toLowerCase())) {
    const base = parts.slice(0, -1).map(cap).join(' ');
    return `${base} (${cap(parts[parts.length - 1])})`;
  }
  return parts.map(cap).join(' ');
}

/**
 * 清洗 transcript 中 tool_calls.args 被 JSON 序列化包裹了一层双引号的字符串字段。
 *
 * @param {unknown} val 原始参数值
 * @returns {string} 清洗后的纯文本
 */
function unquoteArg(val) {
  if (val === null || val === undefined) return '';
  if (typeof val !== 'string') return String(val);
  const trimmed = val.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') return parsed.trim();
    } catch {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

/**
 * 提取用户请求摘要，用于逐轮列表展示。
 *
 * @param {string | null | undefined} content USER_INPUT 原始内容
 * @returns {string} 截断后的可读摘要
 */
function extractPromptSnippet(content) {
  if (!content || typeof content !== 'string') return '';
  const m = USER_REQ_RE.exec(content);
  const text = (m ? m[1] : content).replace(/\s+/g, ' ').trim();
  return text.length > 72 ? `${text.slice(0, 72)}…` : text;
}

/**
 * 剥离 GENERIC 步骤内容顶部连续的 Created At / Completed At 时间戳头，返回实际工具输出正文。
 *
 * @param {string} content GENERIC 步骤原始文本
 * @returns {string} 去掉时间戳头后的正文（已 trimStart）
 */
function stripGenericTimestampHeaders(content) {
  const lines = content.split(/\r?\n/);
  let idx = 0;
  while (idx < lines.length) {
    const trimmed = lines[idx].trim();
    if (!trimmed || trimmed.startsWith('Created At:') || trimmed.startsWith('Completed At:')) {
      idx += 1;
      continue;
    }
    break;
  }
  return lines.slice(idx).join('\n').trimStart();
}

/**
 * 从单步 PLANNER_RESPONSE 及其紧随的 GENERIC 工具输出中提取子智能体派发信息。
 * 支持并行调用多个 invoke_subagent 以及 swarm add。
 *
 * @param {Array<object>} toolCalls 当前步骤发起的 tool_calls
 * @param {Array<object>} genericSteps 紧随其后的 GENERIC 步骤列表
 * @param {number} turnIndex 所属主对话轮次编号（从 1 开始）
 * @returns {Array<object>} 提取到的子智能体引用列表
 */
function extractSubagentRefsFromStep(toolCalls, genericSteps, turnIndex) {
  const refs = [];
  const invokeCalls = [];
  let swarmAddCount = 0;

  for (const tc of toolCalls) {
    if (tc?.name === 'invoke_subagent') {
      const args = tc.args || tc.arguments || {};
      invokeCalls.push({
        typeName: unquoteArg(args.TypeName),
        role: unquoteArg(args.Role),
        requestedModel: unquoteArg(args.Model),
      });
    } else if (tc?.name === 'swarm') {
      const args = tc.args || tc.arguments || {};
      if (unquoteArg(args.action).toLowerCase() === 'add') {
        swarmAddCount += 1;
      }
    }
  }

  // 当前步骤未调用 invoke_subagent 或 swarm add，直接跳过，避免把 run_command/read_file 输出误判为子代理
  if (invokeCalls.length === 0 && swarmAddCount === 0) {
    return refs;
  }

  let invokeCursor = 0;

  for (const gStep of genericSteps) {
    const content = typeof gStep.content === 'string' ? gStep.content : '';
    if (!content) continue;
    const body = stripGenericTimestampHeaders(content);
    if (!body) continue;

    // 1. 严格匹配以 "Created the following subagent:" 开头的 invoke_subagent 返回
    if (invokeCursor < invokeCalls.length && body.startsWith('Created the following subagent:')) {
      let convId = '';
      let logAbsoluteUri = '';
      const blockMatch = SUBAGENT_CREATED_RE.exec(body);
      if (blockMatch) {
        try {
          const parsed = JSON.parse(blockMatch[1]);
          if (typeof parsed.conversationId === 'string') convId = parsed.conversationId.trim();
          if (typeof parsed.logAbsoluteUri === 'string') logAbsoluteUri = parsed.logAbsoluteUri.trim();
        } catch {
          // JSON 截断时降级走正则提取
        }
      }
      if (!convId) {
        const idm = CONV_ID_FIELD_RE.exec(body);
        if (idm) convId = idm[1];
      }
      if (!logAbsoluteUri) {
        const um = LOG_URI_FIELD_RE.exec(body);
        if (um) logAbsoluteUri = um[1];
      }
      if (convId && ID_RE.test(convId)) {
        const meta = invokeCalls[invokeCursor] || {};
        invokeCursor += 1;
        refs.push({
          conversationId: convId,
          kind: 'subagent',
          typeName: meta.typeName || '',
          role: meta.role || '',
          requestedModel: meta.requestedModel || '',
          logAbsoluteUri,
          turnIndex,
          spawnedAt: gStep.created_at || null,
        });
      }
      continue;
    }

    // 2. 严格匹配以 JSON 对象开头的 swarm add 返回（含 "status":"added" 与 "conversation_id"）
    if (
      swarmAddCount > 0 &&
      body.startsWith('{') &&
      body.includes('"status"') &&
      body.includes('"added"') &&
      body.includes('conversation_id')
    ) {
      const candidate = body.trim();
      let parsed = null;
      try {
        parsed = JSON.parse(candidate);
      } catch {
        // 可能是多行或末尾带文本，降级用正则兜底
      }
      const items = [];
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.conversation_id === 'string') {
          items.push(parsed);
        } else if (Array.isArray(parsed.added)) {
          items.push(...parsed.added);
        } else if (Array.isArray(parsed.members)) {
          items.push(...parsed.members);
        }
      }
      if (items.length > 0) {
        for (const item of items) {
          const cid = typeof item?.conversation_id === 'string' ? item.conversation_id.trim() : '';
          if (!cid || !ID_RE.test(cid)) continue;
          refs.push({
            conversationId: cid,
            kind: 'swarm',
            typeName: 'swarm',
            role: String(item.name || '').trim(),
            requestedModel: String(item.model_display_name || item.model || '').trim(),
            logAbsoluteUri: '',
            turnIndex,
            spawnedAt: gStep.created_at || null,
          });
        }
      } else {
        const idm = CONV_ID_FIELD_RE.exec(candidate);
        if (idm && ID_RE.test(idm[1])) {
          refs.push({
            conversationId: idm[1],
            kind: 'swarm',
            typeName: 'swarm',
            role: '',
            requestedModel: '',
            logAbsoluteUri: '',
            turnIndex,
            spawnedAt: gStep.created_at || null,
          });
        }
      }
    }
  }

  return refs;
}

/**
 * 读取会话目录下可选的 swarm/members.json，兜底补全可能漏掉的 swarm worker。
 *
 * @param {string} convId 父会话 UUID
 * @param {string[]} [appDataDirs] 可选的 appData 目录列表
 * @returns {{ refs: Array<object>, fileSig: string }} 补全的子引用列表与文件签名
 */
function readSwarmMembersFallback(convId, appDataDirs = null) {
  const membersPath = findSwarmMembersPath(convId, appDataDirs);
  if (!membersPath) return { refs: [], fileSig: '' };
  try {
    const st = statSync(membersPath);
    const fileSig = `m:${Math.floor(st.mtimeMs)}:${st.size}`;
    const raw = JSON.parse(readFileSync(membersPath, 'utf-8'));
    const membersObj = raw && typeof raw.members === 'object' ? raw.members : null;
    if (!membersObj) return { refs: [], fileSig };
    const refs = [];
    for (const [name, info] of Object.entries(membersObj)) {
      const cid = typeof info?.conversation_id === 'string' ? info.conversation_id.trim() : '';
      if (!cid || !ID_RE.test(cid) || cid === convId) continue;
      refs.push({
        conversationId: cid,
        kind: 'swarm',
        typeName: 'swarm',
        role: name,
        requestedModel: String(info.applied_model || info.model || info.desired_model || '').trim(),
        logAbsoluteUri: '',
        turnIndex: null,
        spawnedAt: null,
      });
    }
    return { refs, fileSig };
  } catch {
    return { refs: [], fileSig: '' };
  }
}

/**
 * 解析单个 transcript.jsonl 文本，产出该对话自身的 session、turns 以及派发的子智能体引用列表。
 *
 * @param {string} rawText transcript.jsonl 原始文本
 * @param {number | null} fileMtimeMs 文件修改时间戳（毫秒）
 * @returns {{ session: object, turns: Array<object>, subagentRefs: Array<object> }} 单对话解析结果
 */
export function analyzeTranscript(rawText, fileMtimeMs) {
  const steps = [];
  for (const line of rawText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object') steps.push(obj);
    } catch {
      // 忽略正在写入中的半行或损坏行
    }
  }

  const turns = [];
  const subagentRefs = [];
  const seenSubIds = new Set();
  let curTurn = null;
  let seq = 0;

  const ensureTurn = (prompt, createdAt) => {
    curTurn = {
      turnIndex: turns.length + 1,
      prompt: prompt || '',
      startedAt: createdAt || null,
      steps: [],
      subagentIds: [],
    };
    turns.push(curTurn);
  };

  let i = 0;
  const n = steps.length;
  while (i < n) {
    const st = steps[i];
    if (st.type === 'USER_INPUT') {
      ensureTurn(extractPromptSnippet(st.content), st.created_at || null);
      i += 1;
      continue;
    }

    if (
      st.type === 'PLANNER_RESPONSE' &&
      ('input_tokens' in st || 'output_tokens' in st || 'cache_read_tokens' in st)
    ) {
      if (!curTurn) ensureTurn('', st.created_at || null);
      seq += 1;

      const inputTokens = Number(st.input_tokens) || 0;
      const cacheReadTokens = Number(st.cache_read_tokens) || 0;
      const outputTokens = Number(st.output_tokens) || 0;
      const contextTokens = inputTokens + cacheReadTokens;
      const totalTokens = contextTokens + outputTokens;
      const toolCalls = Array.isArray(st.tool_calls) ? st.tool_calls : [];
      const startMs = parseIsoMs(st.created_at);

      const toolIntervals = [];
      const followingGenerics = [];
      let firstToolMs = null;
      let firstSysMs = null;
      let j = i + 1;
      while (j < n && steps[j].type !== 'PLANNER_RESPONSE' && steps[j].type !== 'USER_INPUT') {
        const nxt = steps[j];
        const nts = parseIsoMs(nxt.created_at);
        if (nxt.type === 'GENERIC') {
          followingGenerics.push(nxt);
          const head = typeof nxt.content === 'string' ? nxt.content.slice(0, 300) : '';
          const cm = CREATED_RE.exec(head);
          const dm = COMPLETED_RE.exec(head);
          const tC = cm ? parseIsoMs(cm[1]) : nts;
          const tD = dm ? parseIsoMs(dm[1]) : null;
          if (tC !== null && (firstToolMs === null || tC < firstToolMs)) firstToolMs = tC;
          if (tC !== null && tD !== null && tD >= tC) toolIntervals.push([tC, tD]);
        } else if (nxt.type === 'SYSTEM_MESSAGE' && firstSysMs === null && nts !== null) {
          firstSysMs = nts;
        }
        j += 1;
      }

      // 提取当前步骤派发出的子智能体（按轮次归属，便于前端按轮展示）
      const stepSubRefs = extractSubagentRefsFromStep(toolCalls, followingGenerics, curTurn.turnIndex);
      for (const ref of stepSubRefs) {
        if (!seenSubIds.has(ref.conversationId)) {
          seenSubIds.add(ref.conversationId);
          subagentRefs.push(ref);
          curTurn.subagentIds.push(ref.conversationId);
        }
      }

      const toolMs = mergeIntervalsMs(toolIntervals);
      let modelMs = 0;
      if (startMs !== null) {
        let endMs = null;
        if (firstToolMs !== null) {
          endMs = firstToolMs;
        } else if (firstSysMs !== null) {
          endMs = firstSysMs;
        } else if (j === n && fileMtimeMs && fileMtimeMs >= startMs && fileMtimeMs - startMs <= 180_000) {
          endMs = fileMtimeMs;
        }
        if (endMs !== null && endMs >= startMs && endMs - startMs <= 600_000) {
          modelMs = endMs - startMs;
        }
      }

      const cacheHitRate = contextTokens > 0 ? (cacheReadTokens / contextTokens) * 100 : 0;
      const isCacheMiss = seq > 1 && cacheReadTokens === 0 && inputTokens >= 5000;

      curTurn.steps.push({
        seq,
        stepIndex: st.step_index ?? null,
        createdAt: st.created_at || null,
        model: formatModelName(st.model),
        inputTokens,
        cacheReadTokens,
        outputTokens,
        contextTokens,
        totalTokens,
        cacheHitRate,
        isCacheMiss,
        hasTools: toolCalls.length > 0,
        toolNames: toolCalls.map((tc) => tc?.name || 'tool'),
        modelMs,
        toolMs,
      });

      i = j;
      continue;
    }

    i += 1;
  }

  // 过滤尚未产生模型回复的空轮次，同时修正轮次号映射
  const nonEmptyTurns = turns.filter((t) => t.steps.length > 0);
  const rawTurnIndexMap = new Map();
  nonEmptyTurns.forEach((t, idx) => rawTurnIndexMap.set(t.turnIndex, idx + 1));
  for (const ref of subagentRefs) {
    if (ref.turnIndex !== null && rawTurnIndexMap.has(ref.turnIndex)) {
      ref.turnIndex = rawTurnIndexMap.get(ref.turnIndex);
    }
  }

  const allSteps = nonEmptyTurns.flatMap((t) => t.steps);

  let sessIn = 0;
  let sessCache = 0;
  let sessOut = 0;
  let sessModelMs = 0;
  let sessToolMs = 0;
  let peakContextTokens = 0;
  const cacheMissSteps = [];
  const modelSet = new Set();

  const turnSummaries = nonEmptyTurns.map((t, idx) => {
    let tIn = 0;
    let tCache = 0;
    let tOut = 0;
    let tModelMs = 0;
    let tToolMs = 0;
    let tPeakCtx = 0;
    let tHasMiss = false;
    let lastModel = 'Unknown';

    for (const s of t.steps) {
      tIn += s.inputTokens;
      tCache += s.cacheReadTokens;
      tOut += s.outputTokens;
      tModelMs += s.modelMs;
      tToolMs += s.toolMs;
      if (s.contextTokens > tPeakCtx) tPeakCtx = s.contextTokens;
      if (s.isCacheMiss) {
        tHasMiss = true;
        cacheMissSteps.push(s.seq);
      }
      if (s.model) {
        lastModel = s.model;
        modelSet.add(s.model);
      }
    }

    sessIn += tIn;
    sessCache += tCache;
    sessOut += tOut;
    sessModelMs += tModelMs;
    sessToolMs += tToolMs;
    if (tPeakCtx > peakContextTokens) peakContextTokens = tPeakCtx;

    const tCtxSum = tIn + tCache;
    const tTotal = tCtxSum + tOut;
    const tHit = tCtxSum > 0 ? (tCache / tCtxSum) * 100 : 0;
    const tTps = tModelMs >= 1000 && tOut > 0 ? Math.round(tOut / (tModelMs / 1000)) : null;

    return {
      turnIndex: idx + 1,
      prompt: t.prompt,
      startedAt: t.startedAt,
      model: lastModel,
      stepsCount: t.steps.length,
      inputTokens: tIn,
      cacheReadTokens: tCache,
      outputTokens: tOut,
      totalTokens: tTotal,
      cacheHitRate: tHit,
      peakContextTokens: tPeakCtx,
      modelMs: tModelMs,
      toolMs: tToolMs,
      tps: tTps,
      hasCacheMiss: tHasMiss,
      subagentIds: t.subagentIds,
      steps: t.steps,
    };
  });

  const sessCtxSum = sessIn + sessCache;
  const sessTotal = sessCtxSum + sessOut;
  const sessHit = sessCtxSum > 0 ? (sessCache / sessCtxSum) * 100 : 0;
  const sessTps = sessModelMs >= 1000 && sessOut > 0 ? Math.round(sessOut / (sessModelMs / 1000)) : null;
  const latestContextTokens = allSteps.length ? allSteps[allSteps.length - 1].contextTokens : 0;

  return {
    session: {
      turnsCount: turnSummaries.length,
      stepsCount: allSteps.length,
      inputTokens: sessIn,
      cacheReadTokens: sessCache,
      outputTokens: sessOut,
      totalTokens: sessTotal,
      cacheHitRate: sessHit,
      latestContextTokens,
      peakContextTokens,
      modelMs: sessModelMs,
      toolMs: sessToolMs,
      tps: sessTps,
      cacheMissSteps,
      models: [...modelSet],
    },
    turns: turnSummaries,
    subagentRefs,
  };
}

/**
 * 读取并增量缓存单个对话的解析结果。
 * 只有当该对话的 transcript.jsonl 的 mtimeMs 或 size 发生变化时才重新读取解析。
 *
 * @param {string} convId 会话 UUID
 * @param {string[]} [appDataDirs] 可选的 appData 目录列表
 * @returns {{ fileEtag: string, mtimeMs: number, parsed: object } | null} 缓存条目或 null
 */
function getParsedTranscript(convId, appDataDirs = null) {
  const path = findTranscriptPath(convId, appDataDirs);
  if (!path) return null;

  let st;
  try {
    st = statSync(path);
  } catch {
    return null;
  }

  const fileEtag = `${Math.floor(st.mtimeMs)}:${st.size}`;
  const cacheKey = `${path}`;
  const prev = transcriptCache.get(cacheKey);
  if (prev && prev.fileEtag === fileEtag) {
    return prev;
  }

  let rawText;
  try {
    rawText = readFileSync(path, 'utf-8');
  } catch {
    return null;
  }

  const parsed = analyzeTranscript(rawText, st.mtimeMs);
  const entry = {
    fileEtag,
    mtimeMs: st.mtimeMs,
    parsed,
  };
  transcriptCache.set(cacheKey, entry);
  if (transcriptCache.size > MAX_CACHE_ENTRIES) {
    const firstKey = transcriptCache.keys().next().value;
    if (firstKey) transcriptCache.delete(firstKey);
  }
  return entry;
}

/**
 * 为子智能体生成简洁易读的展示名称。
 *
 * @param {object} ref 子智能体派发元数据
 * @returns {string} 展示名称
 */
function buildSubagentLabel(ref) {
  const role = (ref.role || '').trim();
  const typeName = (ref.typeName || '').trim();
  if (ref.kind === 'swarm') {
    return role ? `swarm: ${role}` : `swarm-${ref.conversationId.slice(0, 6)}`;
  }
  if (role && typeName && role.toLowerCase() !== typeName.toLowerCase()) {
    return `${role}`;
  }
  return role || typeName || `子代理 ${ref.conversationId.slice(0, 6)}`;
}

/**
 * 简单快速的 FNV-1a 32 位哈希，用于将多个文件的 mtime:size 签名压缩成短 ETag。
 *
 * @param {string} str 输入字符串
 * @returns {string} 8 位十六进制哈希
 */
function hashSignature(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * 获取主对话及其所有子孙智能体的完整聚合统计，并计算联合 ETag。
 *
 * @param {string} rootConvId 主对话 UUID
 * @param {{ appDataDirs?: string[], nowMs?: number }} [options] 可选配置（便于测试）
 * @returns {{ etag: string, payload: object }} 联合 ETag 与完整 API 响应体
 */
export function getConversationStats(rootConvId, options = {}) {
  const appDataDirs = options.appDataDirs || findAppDataDirs();
  const nowMs = options.nowMs ?? Date.now();

  const rootEntry = getParsedTranscript(rootConvId, appDataDirs);
  if (!rootEntry) {
    return {
      etag: 'empty',
      payload: { conversationId: rootConvId || null, empty: true },
    };
  }

  const rootParsed = rootEntry.parsed;
  const sigParts = [`${rootConvId}:${rootEntry.fileEtag}`];
  let latestMtimeMs = rootEntry.mtimeMs;

  // 递归遍历所有派发出的子孙智能体（深度优先，保证列表中子项紧跟父项）
  const visited = new Set([rootConvId]);
  const subagents = [];
  const subagentById = new Map();

  /**
   * 递归收集某个父对话下的子智能体列表。
   *
   * @param {string} parentConvId 父对话 ID
   * @param {Array<object>} directRefs 从父对话日志提取的直接子引用
   * @param {number} depth 当前深度（主对话直接子节点为 1）
   * @param {number | null} rootTurnIndex 归属的主对话轮次编号
   * @returns {string[]} 本层及所有后代的 conversationId 列表
   */
  function collectChildren(parentConvId, directRefs, depth, rootTurnIndex) {
    if (depth > MAX_SUBAGENT_DEPTH || subagents.length >= MAX_SUBAGENT_COUNT) return [];

    // 合并 swarm/members.json 兜底记录，去重
    const swarmFallback = readSwarmMembersFallback(parentConvId, appDataDirs);
    if (swarmFallback.fileSig) {
      sigParts.push(`${parentConvId}:${swarmFallback.fileSig}`);
    }
    const mergedRefs = [...directRefs];
    const existingIds = new Set(directRefs.map((r) => r.conversationId));
    for (const fb of swarmFallback.refs) {
      if (!existingIds.has(fb.conversationId)) {
        existingIds.add(fb.conversationId);
        mergedRefs.push(fb);
      }
    }

    const subtreeIds = [];

    for (const ref of mergedRefs) {
      if (subagents.length >= MAX_SUBAGENT_COUNT) break;
      const cid = ref.conversationId;
      if (!cid || visited.has(cid)) continue;
      visited.add(cid);

      const childEntry = getParsedTranscript(cid, appDataDirs);
      const childTurnIndex = depth === 1 ? ref.turnIndex : rootTurnIndex;
      const childParsed = childEntry ? childEntry.parsed : null;

      if (childEntry) {
        sigParts.push(`${cid}:${childEntry.fileEtag}`);
        if (childEntry.mtimeMs > latestMtimeMs) latestMtimeMs = childEntry.mtimeMs;
      } else {
        sigParts.push(`${cid}:missing`);
      }

      const emptySession = {
        turnsCount: 0,
        stepsCount: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cacheHitRate: 0,
        latestContextTokens: 0,
        peakContextTokens: 0,
        modelMs: 0,
        toolMs: 0,
        tps: null,
        cacheMissSteps: [],
        models: ref.requestedModel ? [formatModelName(ref.requestedModel)] : [],
      };

      const sess = childParsed ? childParsed.session : emptySession;
      const isActive = Boolean(childEntry && nowMs - childEntry.mtimeMs <= ACTIVE_WINDOW_MS);

      const node = {
        conversationId: cid,
        parentId: parentConvId,
        depth,
        turnIndex: childTurnIndex,
        kind: ref.kind,
        typeName: ref.typeName || '',
        role: ref.role || '',
        label: buildSubagentLabel(ref),
        model: sess.models[0] || (ref.requestedModel ? formatModelName(ref.requestedModel) : 'Unknown'),
        spawnedAt: ref.spawnedAt || null,
        updatedAt: childEntry ? new Date(childEntry.mtimeMs).toISOString() : null,
        isActive,
        childIds: [],
        descendantIds: [],
        session: sess,
        turns: childParsed ? childParsed.turns : [],
      };

      subagents.push(node);
      subagentById.set(cid, node);
      subtreeIds.push(cid);

      if (childParsed) {
        const descendants = collectChildren(cid, childParsed.subagentRefs, depth + 1, childTurnIndex);
        node.descendantIds = descendants;
        node.childIds = descendants.filter((id) => subagentById.get(id)?.parentId === cid);
        subtreeIds.push(...descendants);
      }
    }

    return subtreeIds;
  }

  collectChildren(rootConvId, rootParsed.subagentRefs, 1, null);

  // 汇总全部子孙智能体指标
  let subIn = 0;
  let subCache = 0;
  let subOut = 0;
  let subSteps = 0;
  let subModelMs = 0;
  let subToolMs = 0;
  let activeSubCount = 0;
  const subModels = new Set();

  for (const sa of subagents) {
    subIn += sa.session.inputTokens;
    subCache += sa.session.cacheReadTokens;
    subOut += sa.session.outputTokens;
    subSteps += sa.session.stepsCount;
    subModelMs += sa.session.modelMs;
    subToolMs += sa.session.toolMs;
    if (sa.isActive) activeSubCount += 1;
    for (const m of sa.session.models) subModels.add(m);
  }

  const subCtxSum = subIn + subCache;
  const subTotal = subCtxSum + subOut;
  const subHit = subCtxSum > 0 ? (subCache / subCtxSum) * 100 : 0;

  const subagentSummary = {
    count: subagents.length,
    activeCount: activeSubCount,
    stepsCount: subSteps,
    inputTokens: subIn,
    cacheReadTokens: subCache,
    outputTokens: subOut,
    totalTokens: subTotal,
    cacheHitRate: subHit,
    modelMs: subModelMs,
    toolMs: subToolMs,
    models: [...subModels],
  };

  // 计算主对话 + 全部子孙智能体的合并总览
  const mainSess = rootParsed.session;
  const combIn = mainSess.inputTokens + subIn;
  const combCache = mainSess.cacheReadTokens + subCache;
  const combOut = mainSess.outputTokens + subOut;
  const combCtxSum = combIn + combCache;
  const combTotal = combCtxSum + combOut;
  const combHit = combCtxSum > 0 ? (combCache / combCtxSum) * 100 : 0;
  const combModelMs = mainSess.modelMs + subModelMs;
  const combToolMs = mainSess.toolMs + subToolMs;
  const combTps = combModelMs >= 1000 && combOut > 0 ? Math.round(combOut / (combModelMs / 1000)) : null;
  const combModels = [...new Set([...mainSess.models, ...subModels])];

  const combinedSession = {
    turnsCount: mainSess.turnsCount,
    stepsCount: mainSess.stepsCount + subSteps,
    mainStepsCount: mainSess.stepsCount,
    subagentStepsCount: subSteps,
    subagentCount: subagents.length,
    inputTokens: combIn,
    cacheReadTokens: combCache,
    outputTokens: combOut,
    totalTokens: combTotal,
    cacheHitRate: combHit,
    latestContextTokens: mainSess.latestContextTokens,
    peakContextTokens: mainSess.peakContextTokens,
    modelMs: combModelMs,
    toolMs: combToolMs,
    mainModelMs: mainSess.modelMs,
    mainToolMs: mainSess.toolMs,
    subagentModelMs: subModelMs,
    subagentToolMs: subToolMs,
    tps: combTps,
    cacheMissSteps: mainSess.cacheMissSteps,
    models: combModels,
  };

  // 为主对话的每一轮补充该轮派发的子智能体（含其后代）的汇总统计
  const turnsWithSubagents = rootParsed.turns.map((turn) => {
    const turnSubIds = new Set();
    for (const directId of turn.subagentIds || []) {
      const node = subagentById.get(directId);
      if (!node) continue;
      turnSubIds.add(directId);
      for (const did of node.descendantIds || []) turnSubIds.add(did);
    }
    if (turnSubIds.size === 0) {
      return { ...turn, subagentCount: 0, subagentTotalTokens: 0, subagentIds: [] };
    }
    let tSubTotal = 0;
    const orderedIds = [];
    for (const sa of subagents) {
      if (turnSubIds.has(sa.conversationId)) {
        tSubTotal += sa.session.totalTokens;
        orderedIds.push(sa.conversationId);
      }
    }
    return {
      ...turn,
      subagentCount: orderedIds.length,
      subagentTotalTokens: tSubTotal,
      subagentIds: orderedIds,
    };
  });

  // 联合 ETag：主对话 + 全部子孙对话 + swarm/members.json 的文件签名哈希，附带活跃数以便状态变化时及时刷新
  const rawSig = `${sigParts.join('|')}|active:${activeSubCount}`;
  const etag = `${rootEntry.fileEtag}:${subagents.length}:${hashSignature(rawSig)}`;

  const isEmpty = mainSess.stepsCount === 0 && subSteps === 0;

  return {
    etag,
    payload: {
      conversationId: rootConvId,
      empty: isEmpty,
      etag,
      updatedAt: new Date(latestMtimeMs).toISOString(),
      session: mainSess,
      combinedSession,
      subagentSummary,
      subagents,
      turns: turnsWithSubagents,
    },
  };
}
