/**
 * Token Stats Sidecar Backend.
 *
 * Read-only analyzer for the current conversation's transcript.jsonl:
 *   <appData>/brain/<conversationId>/.system_generated/logs/transcript.jsonl
 *
 * Serves a compact summary + per-turn & per-step cache/uncached token and
 * model/tool latency breakdown over /api/stats with ETag caching.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarApp, Response } from 'sidecar_sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ID_RE = /^[0-9a-f-]{8,}$/i;
const CREATED_RE = /Created At:\s*([0-9T:\-.+Z]+)/;
const COMPLETED_RE = /Completed At:\s*([0-9T:\-.+Z]+)/;
const USER_REQ_RE = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i;

const STATIC = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

// ---------------------------------------------------------------------------
// Locate Antigravity appData/brain directories
// ---------------------------------------------------------------------------

function findAppDataDirs() {
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
    // ignore
  }
  return dirs;
}

function findTranscriptPath(convId) {
  if (!convId || !ID_RE.test(convId)) return null;
  for (const appData of findAppDataDirs()) {
    const p = join(appData, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
    if (existsSync(p)) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Parsing & analytics
// ---------------------------------------------------------------------------

function parseIsoMs(ts) {
  if (!ts || typeof ts !== 'string') return null;
  const ms = Date.parse(ts.trim());
  return Number.isFinite(ms) ? ms : null;
}

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

function formatModelName(raw) {
  if (!raw || typeof raw !== 'string') return 'Unknown';
  const parts = raw.trim().split('-').filter(Boolean);
  if (!parts.length) return 'Unknown';
  const tiers = new Set(['high', 'medium', 'low', 'fast', 'thinking']);
  const cap = (w) => (/^\d+$/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1));
  if (parts.length >= 2 && tiers.has(parts[parts.length - 1].toLowerCase())) {
    const base = parts.slice(0, -1).map(cap).join(' ');
    return `${base} (${cap(parts[parts.length - 1])})`;
  }
  return parts.map(cap).join(' ');
}

function extractPromptSnippet(content) {
  if (!content || typeof content !== 'string') return '';
  const m = USER_REQ_RE.exec(content);
  const text = (m ? m[1] : content).replace(/\s+/g, ' ').trim();
  return text.length > 72 ? `${text.slice(0, 72)}…` : text;
}

function analyzeTranscript(rawText, fileMtimeMs) {
  const steps = [];
  for (const line of rawText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object') steps.push(obj);
    } catch {
      // ignore partial/malformed lines
    }
  }

  const turns = [];
  let curTurn = null;
  let seq = 0;

  const ensureTurn = (prompt, createdAt) => {
    curTurn = {
      turnIndex: turns.length + 1,
      prompt: prompt || '',
      startedAt: createdAt || null,
      steps: [],
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
      let firstToolMs = null;
      let firstSysMs = null;
      let j = i + 1;
      while (j < n && steps[j].type !== 'PLANNER_RESPONSE' && steps[j].type !== 'USER_INPUT') {
        const nxt = steps[j];
        const nts = parseIsoMs(nxt.created_at);
        if (nxt.type === 'GENERIC') {
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

  // Filter out turns with no model steps yet (e.g., pending user input)
  const nonEmptyTurns = turns.filter((t) => t.steps.length > 0);
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
  };
}

// Per-conversation parsed snapshot cache keyed by convId -> { etag, payload }
const cache = new Map();

function getConversationStats(convId) {
  const path = findTranscriptPath(convId);
  if (!path) {
    return { etag: 'empty', payload: { conversationId: convId || null, empty: true } };
  }
  let st;
  try {
    st = statSync(path);
  } catch {
    return { etag: 'empty', payload: { conversationId: convId, empty: true } };
  }
  const etag = `${Math.floor(st.mtimeMs)}:${st.size}`;
  const prev = cache.get(convId);
  if (prev && prev.etag === etag) return prev;

  const rawText = readFileSync(path, 'utf-8');
  const analyzed = analyzeTranscript(rawText, st.mtimeMs);
  const entry = {
    etag,
    payload: {
      conversationId: convId,
      empty: analyzed.session.stepsCount === 0,
      etag,
      updatedAt: new Date(st.mtimeMs).toISOString(),
      ...analyzed,
    },
  };
  cache.set(convId, entry);
  if (cache.size > 32) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
  return entry;
}

// ---------------------------------------------------------------------------
// HTTP routes
// ---------------------------------------------------------------------------

const app = new SidecarApp();

app.page('/', () => readFileSync(join(__dirname, 'index.html'), 'utf-8'));

for (const [route, [file, type]] of Object.entries(STATIC)) {
  app.api(route, () => new Response(readFileSync(join(__dirname, file), 'utf-8'), { contentType: type }), 'GET');
}

app.api('/api/stats', (data) => {
  const conv = data.conversationId || app.config.conversationId || '';
  if (!conv || !ID_RE.test(conv)) {
    return { conversationId: conv || null, empty: true, etag: 'none' };
  }
  const { etag, payload } = getConversationStats(conv);
  if (data.etag && data.etag === etag) {
    return { conversationId: conv, unchanged: true, etag };
  }
  return payload;
}, 'GET');

app.run();
