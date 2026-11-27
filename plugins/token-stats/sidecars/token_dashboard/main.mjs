/**
 * Token Stats Sidecar 后端入口。
 *
 * 只读分析当前对话及其所有子智能体（invoke_subagent 与 swarm）的 transcript.jsonl，
 * 通过 /api/stats 提供带联合 ETag 缓存的实时汇总与明细数据。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarApp, Response } from 'sidecar_sdk';
import { ID_RE, getConversationStats } from './analyzer.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const STATIC = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

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
