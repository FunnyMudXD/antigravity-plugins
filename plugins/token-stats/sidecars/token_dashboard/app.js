(() => {
  const POLL_MS = 1500;
  const $ = (id) => document.getElementById(id);

  const state = {
    conv: '',
    etag: '',
    data: null,
    newestFirst: true,
    scope: 'combined', // 'combined' | 'main'（仅在存在子智能体时生效）
    modalMode: null, // null | 'perf' | 'usage' | { type: 'turn', turnIndex: number } | { type: 'subagent', convId: string }
    modalHistory: [], // 弹窗下钻历史栈，用于支持返回上一级
  };

  const params = new URLSearchParams(location.search);
  const currentConv = () => window.sidecar?.conversationId || params.get('conversationId') || '';

  // ---------- 主题同步（跟随 Antigravity 宿主亮暗色） ----------
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
    const lum = 0.2126 * r + 0.7152 * g + 0.722 * b;
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

  // ---------- 格式化工具函数 ----------
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
    const r = Math.round(sec % 60);
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

  /**
   * 根据当前会话是否存在子智能体以及用户选择的范围，返回当前总览要展示的 session 数据。
   *
   * @param {object} data /api/stats 返回数据
   * @returns {{ activeSession: object, hasSubagents: boolean, isCombined: boolean }}
   */
  function getActiveScope(data) {
    const subagents = Array.isArray(data?.subagents) ? data.subagents : [];
    const hasSubagents = subagents.length > 0;
    const isCombined = hasSubagents && state.scope === 'combined' && Boolean(data.combinedSession);
    const activeSession = isCombined ? data.combinedSession : data.session;
    return { activeSession, hasSubagents, isCombined };
  }

  // ---------- 网络请求 ----------
  async function getJson(path) {
    const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    const res = await f(path, { method: 'GET' });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }

  // ---------- 详情弹窗 ----------
  /**
   * 打开详情弹窗；当从当前弹窗下钻到子视图时传入 pushHistory=true 以记录返回栈。
   *
   * @param {string | object} mode 弹窗模式
   * @param {{ pushHistory?: boolean }} [options] 打开选项
   */
  function openModal(mode, { pushHistory = false } = {}) {
    if (pushHistory && state.modalMode) {
      state.modalHistory.push(state.modalMode);
    } else if (!pushHistory) {
      state.modalHistory = [];
    }
    state.modalMode = mode;
    renderModal();
    $('modal-backdrop').classList.remove('hidden');
  }

  /**
   * 返回上一级弹窗视图。
   */
  function goBackModal() {
    if (state.modalHistory.length === 0) return;
    state.modalMode = state.modalHistory.pop();
    renderModal();
  }

  function closeModal() {
    state.modalMode = null;
    state.modalHistory = [];
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

  /**
   * 渲染步数明细折叠表格 HTML（主对话单轮弹窗和子智能体弹窗复用）。
   *
   * @param {Array<object>} steps 步骤列表
   * @param {boolean} defaultOpen 是否默认展开
   * @returns {string} HTML 字符串
   */
  function buildStepsTableHtml(steps, defaultOpen) {
    if (!steps || steps.length === 0) return '';
    const stepRows = steps
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

    return (
      `<details class="steps-details"${defaultOpen ? ' open' : ''}>` +
        `<summary>步数明细（${steps.length} 步）</summary>` +
        `<table class="steps-table">` +
        `<thead><tr><th>步</th><th>未缓存</th><th>缓存读</th><th>命中</th><th>输出</th><th>耗时</th></tr></thead>` +
        `<tbody>${stepRows}</tbody>` +
        `</table>` +
      `</details>`
    );
  }

  /**
   * 渲染弹窗内的关联子智能体快捷跳转列表。
   *
   * @param {string} title 标题文字
   * @param {Array<object>} nodes 子智能体节点列表
   * @returns {string} HTML 字符串
   */
  function buildLinkedSubagentsHtml(title, nodes) {
    if (!nodes || nodes.length === 0) return '';
    const items = nodes
      .map((sa) => {
        const hitCls = hitTone(sa.session.cacheHitRate);
        const dotCls = sa.isActive ? 'sub-dot active' : 'sub-dot';
        return (
          `<button type="button" class="pop-sub-btn" data-open-subagent="${esc(sa.conversationId)}">` +
            `<span class="pop-sub-left">` +
              `<span class="${dotCls}"></span>` +
              `<span class="pop-sub-name" title="${esc(sa.label)}">${esc(sa.label)}</span>` +
            `</span>` +
            `<span class="pop-sub-right mono">` +
              `<span>${esc(fmtShort(sa.session.totalTokens))}</span>` +
              `<span class="${hitCls}">${esc(fmtPct(sa.session.cacheHitRate))}</span>` +
            `</span>` +
          `</button>`
        );
      })
      .join('');

    return (
      `<div class="pop-sub-block">` +
        `<div class="pop-sub-title">${esc(title)}</div>` +
        `<div class="pop-sub-list">${items}</div>` +
      `</div>`
    );
  }

  function renderModal() {
    if (!state.modalMode || !state.data || state.data.empty) return;
    $('modal-back').classList.toggle('hidden', state.modalHistory.length === 0);
    const { session, turns, subagentSummary } = state.data;
    const subagents = Array.isArray(state.data.subagents) ? state.data.subagents : [];
    const { activeSession, hasSubagents, isCombined } = getActiveScope(state.data);

    const clockSvg =
      '<svg width="14" height="14" viewBox="0 0 16 16" fill="none">' +
      '<circle cx="8" cy="8.5" r="5.5" stroke="currentColor" stroke-width="1.5"/>' +
      '<path d="M8 5.5v3.2l2 1.2M6.2 2h3.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
    const docSvg =
      '<svg width="14" height="14" viewBox="0 0 16 16" fill="none">' +
      '<rect x="3" y="2" width="10" height="12" rx="1.6" stroke="currentColor" stroke-width="1.4"/>' +
      '<path d="M5.5 6h5M5.5 9h5M5.5 11.5h3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
    const subSvg =
      '<svg width="14" height="14" viewBox="0 0 16 16" fill="none">' +
      '<circle cx="5" cy="4.5" r="2" stroke="currentColor" stroke-width="1.4"/>' +
      '<circle cx="11.5" cy="11.5" r="2" stroke="currentColor" stroke-width="1.4"/>' +
      '<path d="M5 6.5V10a1.5 1.5 0 0 0 1.5 1.5h3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

    if (state.modalMode === 'perf') {
      $('modal-icon').innerHTML = clockSvg;
      $('modal-title').textContent = isCombined ? '会话统计（含子代理）' : '会话统计';
      $('modal-badge').textContent = isCombined
        ? `${session.turnsCount} 轮 ${activeSession.stepsCount} 步`
        : `${session.turnsCount} 轮 ${session.stepsCount} 步`;
      const tpsText = activeSession.tps !== null ? `${activeSession.tps} tok/s` : '--';
      const rows = [
        kvRow(isCombined ? '累计模型用时' : '模型用时', esc(fmtDuration(activeSession.modelMs))),
        kvRow(isCombined ? '累计工具用时' : '工具调用用时', esc(fmtDuration(activeSession.toolMs))),
        kvRow('平均输出速度', esc(tpsText)),
        '<div class="pop-sep"></div>',
        kvRow('主对话当前上下文', esc(fmtExact(session.latestContextTokens)), true),
        kvRow('主对话峰值上下文', esc(fmtExact(session.peakContextTokens)), true),
      ];
      if (hasSubagents && subagentSummary) {
        rows.push(
          '<div class="pop-sep"></div>',
          kvRow('主对话用时', esc(`${fmtDuration(session.modelMs)} / ${fmtDuration(session.toolMs)}`), true),
          kvRow(
            `子代理累计 (${subagentSummary.count}个)`,
            esc(`${fmtDuration(subagentSummary.modelMs)} / ${fmtDuration(subagentSummary.toolMs)}`),
            true
          )
        );
      } else {
        rows.push(kvRow('总计用时', esc(fmtDuration(session.modelMs + session.toolMs)), true));
      }
      $('modal-body').innerHTML = rows.join('');
      return;
    }

    if (state.modalMode === 'usage') {
      $('modal-icon').innerHTML = docSvg;
      $('modal-title').textContent = isCombined ? '会话总用量（含子代理）' : '会话用量';
      $('modal-badge').textContent = fmtExact(activeSession.totalTokens);
      const hitCls = hitTone(activeSession.cacheHitRate);
      const rows = [
        kvRow('模型', esc((activeSession.models || []).join(', ') || 'Unknown'), true),
        kvRow('缓存命中', `<span class="${hitCls} strong">${esc(fmtPct(activeSession.cacheHitRate))}</span>`, true),
        kvRow('未缓存输入', esc(fmtExact(activeSession.inputTokens)), true),
        kvRow('缓存读取', esc(fmtExact(activeSession.cacheReadTokens)), true),
        kvRow('输出', esc(fmtExact(activeSession.outputTokens)), true),
        '<div class="pop-sep"></div>',
        kvRow('主对话上下文', esc(fmtExact(session.latestContextTokens)), true),
        kvRow('轮次 / 步数', esc(`${session.turnsCount} 轮 ${activeSession.stepsCount} 步`), true),
      ];
      if (hasSubagents && subagentSummary) {
        rows.push(
          '<div class="pop-sep"></div>',
          kvRow('主对话用量', esc(`${fmtExact(session.totalTokens)} (${session.stepsCount}步)`), true),
          kvRow(
            `子代理汇总 (${subagentSummary.count}个)`,
            esc(`${fmtExact(subagentSummary.totalTokens)} (${subagentSummary.stepsCount}步)`),
            true
          )
        );
      }
      $('modal-body').innerHTML = rows.join('');
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

      // 展示本轮派发的子智能体入口，点击可直接下钻
      if (t.subagentIds && t.subagentIds.length > 0) {
        const linked = t.subagentIds
          .map((id) => subagents.find((s) => s.conversationId === id))
          .filter(Boolean);
        if (linked.length > 0) {
          rows.push(
            '<div class="pop-sep"></div>',
            kvRow('本轮子代理合计', esc(`${fmtExact(t.subagentTotalTokens)} (${linked.length}个)`), true),
            buildLinkedSubagentsHtml('点击查看子智能体详情', linked)
          );
        }
      }

      if (t.steps && t.steps.length > 0) {
        rows.push(buildStepsTableHtml(t.steps, Boolean(t.hasCacheMiss)));
      }

      $('modal-body').innerHTML = rows.join('');
      return;
    }

    if (state.modalMode && state.modalMode.type === 'subagent') {
      const sa = subagents.find((x) => x.conversationId === state.modalMode.convId);
      if (!sa) {
        closeModal();
        return;
      }
      const s = sa.session;
      $('modal-icon').innerHTML = subSvg;
      $('modal-title').textContent = sa.label;
      $('modal-badge').textContent = fmtExact(s.totalTokens);
      const hitCls = hitTone(s.cacheHitRate);
      const tpsText = s.tps !== null ? `${s.tps} tok/s` : '--';
      const metaParts = [];
      if (sa.typeName) metaParts.push(sa.typeName);
      if (sa.turnIndex) metaParts.push(`主对话 #${sa.turnIndex} 轮`);
      if (sa.depth > 1) metaParts.push(`第 ${sa.depth} 层嵌套`);
      if (sa.isActive) metaParts.push('运行中');

      const rows = [
        kvRow('模型', esc((s.models && s.models.length ? s.models.join(', ') : sa.model) || 'Unknown'), true),
        kvRow('来源 / 层级', esc(metaParts.join(' · ') || '子智能体'), true),
        kvRow('缓存命中', `<span class="${hitCls} strong">${esc(fmtPct(s.cacheHitRate))}</span>`, true),
        kvRow('未缓存输入', esc(fmtExact(s.inputTokens)), true),
        kvRow('缓存读取', esc(fmtExact(s.cacheReadTokens)), true),
        kvRow('输出', esc(fmtExact(s.outputTokens)), true),
        '<div class="pop-sep"></div>',
        kvRow('峰值上下文', esc(fmtExact(s.peakContextTokens)), true),
        kvRow('模型 / 工具用时', esc(`${fmtDuration(s.modelMs)} / ${fmtDuration(s.toolMs)}`), false),
        kvRow('平均输出速度', esc(tpsText), false),
        kvRow('会话 ID', esc(sa.conversationId.slice(0, 12) + '…'), true),
      ];

      // 如果该子智能体还派生了下一级子智能体，列出快捷入口
      if (sa.childIds && sa.childIds.length > 0) {
        const children = sa.childIds
          .map((id) => subagents.find((x) => x.conversationId === id))
          .filter(Boolean);
        if (children.length > 0) {
          rows.push('<div class="pop-sep"></div>', buildLinkedSubagentsHtml(`下级子智能体 (${children.length})`, children));
        }
      }

      // 合并子智能体全部轮次的步数明细，方便在弹窗中直接查看
      const flatSteps = (sa.turns || []).flatMap((t) => t.steps || []);
      if (flatSteps.length > 0) {
        const hasMiss = flatSteps.some((st) => st.isCacheMiss);
        rows.push(buildStepsTableHtml(flatSteps, hasMiss));
      } else {
        rows.push('<div class="pop-empty-note">该子智能体尚未产生模型 token 记录。</div>');
      }

      $('modal-body').innerHTML = rows.join('');
    }
  }

  // ---------- 主视图渲染 ----------
  function renderSubagents(subagents, subagentSummary) {
    const sec = $('subagents-section');
    if (!subagents || subagents.length === 0) {
      sec.classList.add('hidden');
      return;
    }
    sec.classList.remove('hidden');
    const activeNote = subagentSummary?.activeCount > 0 ? ` · ${subagentSummary.activeCount} 运行中` : '';
    $('subagents-count').textContent = `${subagents.length} 个${activeNote}`;

    $('subagents-list').innerHTML = subagents
      .map((sa) => {
        const s = sa.session;
        const hitCls = hitTone(s.cacheHitRate);
        const depthCls = sa.depth >= 3 ? ' depth-3' : sa.depth === 2 ? ' depth-2' : '';
        const dotCls = sa.isActive ? 'sub-dot active' : 'sub-dot';
        const turnTag = sa.turnIndex ? `#${sa.turnIndex}` : '';
        const typeTag = sa.typeName && sa.kind !== 'swarm' ? sa.typeName : sa.kind === 'swarm' ? 'swarm' : '';
        const dur = fmtDuration(s.modelMs + s.toolMs);
        const missDot = s.cacheMissSteps && s.cacheMissSteps.length > 0 ? ' ⚠' : '';

        return (
          `<button class="subagent-row${depthCls}" type="button" data-subagent="${esc(sa.conversationId)}">` +
            `<div class="sub-top">` +
              `<span class="${dotCls}" title="${sa.isActive ? '正在运行' : '已完成/空闲'}"></span>` +
              `<span class="sub-name" title="${esc(sa.label)}">${esc(sa.label)}</span>` +
              (typeTag ? `<span class="sub-tag mono">${esc(typeTag)}</span>` : '') +
              (turnTag ? `<span class="sub-turn mono" title="所属主对话轮次">${esc(turnTag)}</span>` : '') +
            `</div>` +
            `<div class="sub-bottom">` +
              `<span class="turn-usage-pill mono">${esc(fmtShort(s.totalTokens))} tok · ${s.stepsCount}步</span>` +
              `<span class="turn-metrics mono">` +
                `<span class="${hitCls}">命中 ${esc(fmtPct(s.cacheHitRate))}${missDot}</span>` +
                `<span>${esc(dur)}</span>` +
              `</span>` +
            `</div>` +
          `</button>`
        );
      })
      .join('');
  }

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

    const { session, turns, subagentSummary } = data;
    const subagents = Array.isArray(data.subagents) ? data.subagents : [];
    const { activeSession, hasSubagents, isCombined } = getActiveScope(data);

    $('empty-state').classList.add('hidden');
    $('pill-bar').classList.remove('hidden');
    $('content').classList.remove('hidden');
    $('live-dot').classList.remove('idle');

    // 顶部胶囊条
    const tpsPart = activeSession.tps !== null ? ` · ${activeSession.tps} tok/s` : '';
    const subCountPart = isCombined && subagents.length > 0 ? ` · +${subagents.length}子` : '';
    $('pill-perf-text').textContent = `${session.turnsCount} 轮 ${activeSession.stepsCount} 步${tpsPart}`;

    const hitCls = hitTone(activeSession.cacheHitRate);
    $('pill-usage-text').innerHTML =
      `${esc(fmtShort(activeSession.totalTokens))} tok${esc(subCountPart)} · ` +
      `<span class="${hitCls}">命中 ${esc(fmtPct(activeSession.cacheHitRate))}</span>`;

    // 总览卡片头部保持简洁标题，避免窄侧边栏与右侧切换按钮挤压换行
    $('sum-card-label').textContent = '本会话总览';

    const scopeToggle = $('scope-toggle');
    if (hasSubagents) {
      scopeToggle.classList.remove('hidden');
      scopeToggle.querySelectorAll('.scope-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.scope === state.scope);
      });
    } else {
      scopeToggle.classList.add('hidden');
    }

    $('ctx-badge').textContent = `上下文 ${fmtShort(session.latestContextTokens)}`;
    $('sum-hit').className = `mono strong ${hitCls}`;
    $('sum-hit').textContent = fmtPct(activeSession.cacheHitRate);
    $('sum-hit-fill').style.width = `${Math.max(0, Math.min(100, activeSession.cacheHitRate))}%`;
    $('sum-hit-fill').style.background = hitBarColor(activeSession.cacheHitRate);

    $('sum-in').textContent = fmtShort(activeSession.inputTokens);
    $('sum-cache').textContent = fmtShort(activeSession.cacheReadTokens);
    $('sum-out').textContent = fmtShort(activeSession.outputTokens);
    $('sum-time-label').textContent = isCombined ? '累计模型 / 工具耗时' : '模型 / 工具耗时';
    $('sum-time').textContent = `${fmtDuration(activeSession.modelMs)} / ${fmtDuration(activeSession.toolMs)}`;

    // 主对话 vs 子代理拆分条
    const splitBar = $('sub-split-bar');
    if (hasSubagents && subagentSummary) {
      splitBar.classList.remove('hidden');
      splitBar.innerHTML =
        `<span>主对话 <b class="mono">${esc(fmtShort(session.totalTokens))}</b></span>` +
        `<span class="split-sep">·</span>` +
        `<span>子代理(${subagentSummary.count}) <b class="mono tone-accent">${esc(fmtShort(subagentSummary.totalTokens))}</b></span>`;
    } else {
      splitBar.classList.add('hidden');
    }

    if (session.cacheMissSteps && session.cacheMissSteps.length > 0) {
      $('miss-banner').classList.remove('hidden');
      const listStr = session.cacheMissSteps.slice(0, 6).map((s) => `#${s}`).join(', ');
      const extra = session.cacheMissSteps.length > 6 ? '…' : '';
      $('miss-banner').textContent = `⚠ 主对话检测到 ${session.cacheMissSteps.length} 步缓存未命中（Step ${listStr}${extra}）`;
    } else {
      $('miss-banner').classList.add('hidden');
    }

    // 子智能体列表
    renderSubagents(subagents, subagentSummary);

    // 逐轮列表
    $('turns-count').textContent = `${turns.length} 轮`;
    const ordered = state.newestFirst ? [...turns].reverse() : turns;
    $('turns-list').innerHTML = ordered
      .map((t) => {
        const tHitCls = hitTone(t.cacheHitRate);
        const prompt = t.prompt || `第 ${t.turnIndex} 轮对话`;
        const missDot = t.hasCacheMiss ? ' ⚠' : '';
        const subBadge =
          t.subagentCount > 0
            ? `<span class="turn-sub-badge mono" title="本轮派发子智能体累计用量">+${t.subagentCount}子 ${esc(fmtShort(t.subagentTotalTokens))}</span>`
            : '';
        return (
          `<button class="turn-row" type="button" data-turn="${t.turnIndex}">` +
            `<div class="turn-top">` +
              `<span class="turn-idx mono">#${t.turnIndex}</span>` +
              `<span class="turn-prompt" title="${esc(prompt)}">${esc(prompt)}</span>` +
            `</div>` +
            `<div class="turn-bottom">` +
              `<span class="turn-pills-left">` +
                `<span class="turn-usage-pill mono">用量 ${esc(fmtShort(t.totalTokens))} tok</span>` +
                subBadge +
              `</span>` +
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

  // ---------- 事件绑定 ----------
  $('pill-perf').addEventListener('click', () => openModal('perf'));
  $('pill-usage').addEventListener('click', () => openModal('usage'));
  $('modal-back').addEventListener('click', goBackModal);
  $('modal-close').addEventListener('click', closeModal);
  $('modal-backdrop').addEventListener('click', (e) => {
    if (e.target === $('modal-backdrop')) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.modalMode) closeModal();
  });

  $('scope-toggle').addEventListener('click', (e) => {
    const btn = e.target.closest('.scope-btn');
    if (!btn) return;
    const nextScope = btn.dataset.scope;
    if (nextScope === 'combined' || nextScope === 'main') {
      state.scope = nextScope;
      render();
    }
  });

  $('subagents-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.subagent-row');
    if (!btn) return;
    const convId = btn.dataset.subagent;
    if (convId) openModal({ type: 'subagent', convId });
  });

  $('turns-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.turn-row');
    if (!btn) return;
    const idx = Number(btn.dataset.turn);
    if (Number.isFinite(idx)) openModal({ type: 'turn', turnIndex: idx });
  });

  // 弹窗内点击关联子智能体按钮直接下钻，并压入返回栈
  $('modal-body').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-open-subagent]');
    if (!btn) return;
    const convId = btn.dataset.openSubagent;
    if (convId) openModal({ type: 'subagent', convId }, { pushHistory: true });
  });

  $('btn-sort').addEventListener('click', () => {
    state.newestFirst = !state.newestFirst;
    $('btn-sort').textContent = state.newestFirst ? '最新在前' : '时间正序';
    render();
  });

  // ---------- 轮询同步 ----------
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
      // 偶发错误时保留上一帧快照，避免界面闪烁
    }
  }

  poll();
  setInterval(poll, POLL_MS);
})();
