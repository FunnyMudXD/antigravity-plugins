(() => {
  const POLL_MS = 1500;
  const $ = (id) => document.getElementById(id);

  const state = {
    conv: '',
    etag: '',
    data: null,
    newestFirst: true,
    modalMode: null, // null | 'perf' | 'usage' | { type: 'turn', turnIndex: number }
  };

  const params = new URLSearchParams(location.search);
  const currentConv = () => window.sidecar?.conversationId || params.get('conversationId') || '';

  // ---------- Theme sync with Antigravity host ----------
  function syncScheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #14171d)';
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const nums = (c.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return;
    const scale = c.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const theme = lum < 0.5 ? 'dark' : 'light';
    if (document.documentElement.dataset.theme !== theme) {
      document.documentElement.dataset.theme = theme;
    }
  }
  syncScheme();
  new MutationObserver(syncScheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style', 'class'],
  });

  // ---------- Formatters ----------
  function fmtShort(n) {
    const v = Math.round(Number(n) || 0);
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
    if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
    return String(v);
  }

  function fmtExact(n) {
    return `${Math.round(Number(n) || 0).toLocaleString('en-US')} tok`;
  }

  function fmtPct(pct) {
    const v = Number(pct) || 0;
    return `${v.toFixed(1)}%`;
  }

  function fmtDuration(ms) {
    const sec = Math.max(0, (Number(ms) || 0) / 1000);
    if (sec < 0.05) return '0秒';
    if (sec < 60) return sec < 10 ? `${sec.toFixed(1)}秒` : `${Math.round(sec)}秒`;
    const m = Math.floor(sec / 60);
    let r = Math.round(sec % 60);
    if (r === 60) return `${m + 1}分0秒`;
    return `${m}分${r}秒`;
  }

  function hitTone(pct) {
    if (pct >= 85) return 'tone-good';
    if (pct >= 60) return 'tone-warn';
    return 'tone-bad';
  }

  function hitBarColor(pct) {
    if (pct >= 85) return 'var(--good)';
    if (pct >= 60) return 'var(--warn)';
    return 'var(--bad)';
  }

  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ---------- Networking ----------
  async function getJson(path) {
    const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    const res = await f(path, { method: 'GET' });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }

  // ---------- Modal ----------
  function openModal(mode) {
    state.modalMode = mode;
    renderModal();
    $('modal-backdrop').classList.remove('hidden');
  }

  function closeModal() {
    state.modalMode = null;
    $('modal-backdrop').classList.add('hidden');
  }

  function kvRow(label, valueHtml, subtle = false) {
    return (
      `<div class="pop-row">` +
      `<span class="pop-k${subtle ? ' subtle' : ''}">${esc(label)}</span>` +
      `<span class="pop-v mono">${valueHtml}</span>` +
      `</div>`
    );
  }

  function renderModal() {
    if (!state.modalMode || !state.data || state.data.empty) return;
    const { session, turns } = state.data;

    const clockSvg =
      '<svg width="14" height="14" viewBox="0 0 16 16" fill="none">' +
      '<circle cx="8" cy="8.5" r="5.5" stroke="currentColor" stroke-width="1.5"/>' +
      '<path d="M8 5.5v3.2l2 1.2M6.2 2h3.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
    const docSvg =
      '<svg width="14" height="14" viewBox="0 0 16 16" fill="none">' +
      '<rect x="3" y="2" width="10" height="12" rx="1.6" stroke="currentColor" stroke-width="1.4"/>' +
      '<path d="M5.5 6h5M5.5 9h5M5.5 11.5h3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';

    if (state.modalMode === 'perf') {
      $('modal-icon').innerHTML = clockSvg;
      $('modal-title').textContent = '会话统计';
      $('modal-badge').textContent = `${session.turnsCount} 轮 ${session.stepsCount} 步`;
      const tpsText = session.tps !== null ? `${session.tps} tok/s` : '--';
      $('modal-body').innerHTML = [
        kvRow('模型用时', esc(fmtDuration(session.modelMs))),
        kvRow('工具调用用时', esc(fmtDuration(session.toolMs))),
        kvRow('平均输出速度', esc(tpsText)),
        '<div class="pop-sep"></div>',
        kvRow('当前上下文', esc(fmtExact(session.latestContextTokens)), true),
        kvRow('峰值上下文', esc(fmtExact(session.peakContextTokens)), true),
        kvRow('总计用时', esc(fmtDuration(session.modelMs + session.toolMs)), true),
      ].join('');
      return;
    }

    if (state.modalMode === 'usage') {
      $('modal-icon').innerHTML = docSvg;
      $('modal-title').textContent = '会话用量';
      $('modal-badge').textContent = fmtExact(session.totalTokens);
      const hitCls = hitTone(session.cacheHitRate);
      $('modal-body').innerHTML = [
        kvRow('模型', esc(session.models.join(', ') || 'Unknown'), true),
        kvRow('缓存命中', `<span class="${hitCls} strong">${esc(fmtPct(session.cacheHitRate))}</span>`, true),
        kvRow('未缓存输入', esc(fmtExact(session.inputTokens)), true),
        kvRow('缓存读取', esc(fmtExact(session.cacheReadTokens)), true),
        kvRow('输出', esc(fmtExact(session.outputTokens)), true),
        '<div class="pop-sep"></div>',
        kvRow('当前上下文', esc(fmtExact(session.latestContextTokens)), true),
        kvRow('轮次 / 步数', esc(`${session.turnsCount} 轮 ${session.stepsCount} 步`), true),
      ].join('');
      return;
    }

    if (state.modalMode && state.modalMode.type === 'turn') {
      const t = turns.find((x) => x.turnIndex === state.modalMode.turnIndex);
      if (!t) {
        closeModal();
        return;
      }
      $('modal-icon').innerHTML = docSvg;
      $('modal-title').textContent = `第 ${t.turnIndex} 轮用量`;
      $('modal-badge').textContent = fmtExact(t.totalTokens);
      const hitCls = hitTone(t.cacheHitRate);
      const tpsText = t.tps !== null ? `${t.tps} tok/s` : '--';

      const rows = [
        kvRow('模型', esc(t.model), true),
        kvRow('缓存命中', `<span class="${hitCls} strong">${esc(fmtPct(t.cacheHitRate))}</span>`, true),
        kvRow('未缓存输入', esc(fmtExact(t.inputTokens)), true),
        kvRow('缓存读取', esc(fmtExact(t.cacheReadTokens)), true),
        kvRow('输出', esc(fmtExact(t.outputTokens)), true),
        '<div class="pop-sep"></div>',
        kvRow('峰值上下文', esc(fmtExact(t.peakContextTokens)), true),
        kvRow('模型用时', esc(fmtDuration(t.modelMs)), false),
        kvRow('工具调用用时', esc(fmtDuration(t.toolMs)), false),
        kvRow('平均输出速度', esc(tpsText), false),
      ];

      if (t.steps && t.steps.length > 0) {
        const stepRows = t.steps
          .map((s) => {
            const sHitCls = hitTone(s.cacheHitRate);
            const dur = fmtDuration(s.modelMs + s.toolMs);
            return (
              `<tr class="${s.isCacheMiss ? 'miss-row' : ''}">` +
              `<td class="mono">#${s.seq}${s.isCacheMiss ? ' ⚠' : ''}</td>` +
              `<td class="mono">${fmtShort(s.inputTokens)}</td>` +
              `<td class="mono">${fmtShort(s.cacheReadTokens)}</td>` +
              `<td class="mono ${sHitCls}">${fmtPct(s.cacheHitRate)}</td>` +
              `<td class="mono">${fmtShort(s.outputTokens)}</td>` +
              `<td class="mono">${dur}</td>` +
              `</tr>`
            );
          })
          .join('');

        rows.push(
          `<details class="steps-details"${t.hasCacheMiss ? ' open' : ''}>` +
            `<summary>步数明细（${t.steps.length} 步）</summary>` +
            `<table class="steps-table">` +
            `<thead><tr><th>步</th><th>未缓存</th><th>缓存读</th><th>命中</th><th>输出</th><th>耗时</th></tr></thead>` +
            `<tbody>${stepRows}</tbody>` +
            `</table>` +
          `</details>`
        );
      }

      $('modal-body').innerHTML = rows.join('');
    }
  }

  // ---------- Main render ----------
  function render() {
    const data = state.data;
    if (!data || data.empty) {
      $('pill-bar').classList.add('hidden');
      $('content').classList.add('hidden');
      $('empty-state').classList.remove('hidden');
      $('live-dot').classList.add('idle');
      if (state.conv) {
        $('empty-title').textContent = '当前对话暂无用量记录';
        $('empty-sub').textContent = '发送消息并等待模型回复后，这里会实时显示缓存读写与耗时统计。';
      } else {
        $('empty-title').textContent = '未检测到活跃对话';
        $('empty-sub').textContent = '在任意对话中打开此侧边栏即可自动绑定当前会话。';
      }
      return;
    }

    const { session, turns } = data;
    $('empty-state').classList.add('hidden');
    $('pill-bar').classList.remove('hidden');
    $('content').classList.remove('hidden');
    $('live-dot').classList.remove('idle');

    // Top pills (like screenshot 2 bottom status bar)
    const tpsPart = session.tps !== null ? ` · ${session.tps} tok/s` : '';
    $('pill-perf-text').textContent = `${session.turnsCount} 轮 ${session.stepsCount} 步${tpsPart}`;

    const hitCls = hitTone(session.cacheHitRate);
    $('pill-usage-text').innerHTML =
      `${esc(fmtShort(session.totalTokens))} tok · <span class="${hitCls}">命中 ${esc(fmtPct(session.cacheHitRate))}</span>`;

    // Summary card
    $('ctx-badge').textContent = `上下文 ${fmtShort(session.latestContextTokens)}`;
    $('sum-hit').className = `mono strong ${hitCls}`;
    $('sum-hit').textContent = fmtPct(session.cacheHitRate);
    $('sum-hit-fill').style.width = `${Math.max(0, Math.min(100, session.cacheHitRate))}%`;
    $('sum-hit-fill').style.background = hitBarColor(session.cacheHitRate);

    $('sum-in').textContent = fmtShort(session.inputTokens);
    $('sum-cache').textContent = fmtShort(session.cacheReadTokens);
    $('sum-out').textContent = fmtShort(session.outputTokens);
    $('sum-time').textContent = `${fmtDuration(session.modelMs)} / ${fmtDuration(session.toolMs)}`;

    if (session.cacheMissSteps && session.cacheMissSteps.length > 0) {
      $('miss-banner').classList.remove('hidden');
      const listStr = session.cacheMissSteps.slice(0, 6).map((s) => `#${s}`).join(', ');
      const extra = session.cacheMissSteps.length > 6 ? '…' : '';
      $('miss-banner').textContent = `⚠ 检测到 ${session.cacheMissSteps.length} 步缓存未命中（Step ${listStr}${extra}）`;
    } else {
      $('miss-banner').classList.add('hidden');
    }

    // Per-turn list
    $('turns-count').textContent = `${turns.length} 轮`;
    const ordered = state.newestFirst ? [...turns].reverse() : turns;
    $('turns-list').innerHTML = ordered
      .map((t) => {
        const tHitCls = hitTone(t.cacheHitRate);
        const prompt = t.prompt || `第 ${t.turnIndex} 轮对话`;
        const missDot = t.hasCacheMiss ? ' ⚠' : '';
        return (
          `<button class="turn-row" type="button" data-turn="${t.turnIndex}">` +
            `<div class="turn-top">` +
              `<span class="turn-idx mono">#${t.turnIndex}</span>` +
              `<span class="turn-prompt" title="${esc(prompt)}">${esc(prompt)}</span>` +
            `</div>` +
            `<div class="turn-bottom">` +
              `<span class="turn-usage-pill mono">用量 ${esc(fmtShort(t.totalTokens))} tok</span>` +
              `<span class="turn-metrics mono">` +
                `<span class="${tHitCls}">命中 ${esc(fmtPct(t.cacheHitRate))}${missDot}</span>` +
                `<span>${esc(fmtDuration(t.modelMs + t.toolMs))}</span>` +
              `</span>` +
            `</div>` +
          `</button>`
        );
      })
      .join('');

    if (state.modalMode) renderModal();
  }

  // ---------- Events ----------
  $('pill-perf').addEventListener('click', () => openModal('perf'));
  $('pill-usage').addEventListener('click', () => openModal('usage'));
  $('modal-close').addEventListener('click', closeModal);
  $('modal-backdrop').addEventListener('click', (e) => {
    if (e.target === $('modal-backdrop')) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.modalMode) closeModal();
  });

  $('turns-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.turn-row');
    if (!btn) return;
    const idx = Number(btn.dataset.turn);
    if (Number.isFinite(idx)) openModal({ type: 'turn', turnIndex: idx });
  });

  $('btn-sort').addEventListener('click', () => {
    state.newestFirst = !state.newestFirst;
    $('btn-sort').textContent = state.newestFirst ? '最新在前' : '时间正序';
    render();
  });

  // ---------- Polling ----------
  async function poll() {
    const conv = currentConv();
    if (conv !== state.conv) {
      state.conv = conv;
      state.etag = '';
      state.data = null;
      closeModal();
    }
    if (!conv) {
      render();
      return;
    }
    try {
      const qs = new URLSearchParams({ conversationId: conv });
      if (state.etag) qs.set('etag', state.etag);
      const res = await getJson(`/api/stats?${qs.toString()}`);
      if (res && !res.unchanged) {
        state.etag = res.etag || '';
        state.data = res;
        render();
      }
    } catch {
      // keep previous snapshot on transient errors
    }
  }

  poll();
  setInterval(poll, POLL_MS);
})();
