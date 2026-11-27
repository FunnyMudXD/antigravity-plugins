(() => {
  const $ = (id) => document.getElementById(id);

  const state = {
    activeTab: 'rules',
    overview: null,
    inventory: null,
    toastTimer: null,
  };

  // ---------- Host theme sync ----------
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

  // ---------- HTTP helpers ----------
  async function apiGet(path) {
    const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    const res = await f(path, { method: 'GET' });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }

  async function apiPost(path, body = {}) {
    const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    const res = await f(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));

  function showToast(msg, type = 'ok') {
    const el = $('toast');
    el.textContent = msg;
    el.className = `toast ${type}`;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      el.classList.add('hidden');
    }, 3400);
  }

  // ---------- Modal helpers ----------
  function openModal(title, bodyHtml, footButtons = []) {
    $('modal-title').textContent = title;
    $('modal-body').innerHTML = bodyHtml;
    const foot = $('modal-foot');
    foot.innerHTML = '';
    for (const btnCfg of footButtons) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = btnCfg.className || 'btn';
      btn.textContent = btnCfg.label;
      btn.addEventListener('click', btnCfg.onClick);
      foot.appendChild(btn);
    }
    $('modal-backdrop').classList.remove('hidden');
  }

  function closeModal() {
    $('modal-backdrop').classList.add('hidden');
    $('modal-body').innerHTML = '';
    $('modal-foot').innerHTML = '';
  }

  $('modal-close').addEventListener('click', closeModal);
  $('modal-backdrop').addEventListener('click', (e) => {
    if (e.target === $('modal-backdrop')) closeModal();
  });

  // ---------- Load & render ----------
  async function refreshAll() {
    try {
      const ov = await apiGet('/api/overview');
      if (!ov.ok) throw new Error(ov.error || '加载失败');
      state.overview = ov;
      renderHeaderAndSelectors();
      renderRules();
      renderMcp();
      renderClients();
      renderHooks();
      renderSkillsAndInventory();
    } catch (err) {
      showToast(err.message || '刷新失败', 'err');
    }
  }

  async function loadInventory() {
    try {
      const inv = await apiGet('/api/inventory');
      state.inventory = inv;
      renderSkillsAndInventory();
    } catch {
      // ignore
    }
  }

  function renderHeaderAndSelectors() {
    const ov = state.overview;
    if (!ov) return;
    $('input-master-dir').value = ov.settings.masterDir || '';
    $('input-workspace-dir').value = ov.settings.activeWorkspace || '';

    $('badge-rules').textContent = String(ov.rules.items.length);
    $('badge-mcp').textContent = String(ov.mcp.items.length);
    const drifted = ov.targets.filter(
      (t) => t.enabled && !t.isMasterSelf && (t.status === 'drifted' || t.status === 'missing' || t.status === 'broken_link'),
    ).length;
    $('badge-clients').textContent = drifted > 0 ? `${drifted} 待同步` : String(ov.targets.filter((t) => t.enabled).length);

    const ruleTplSel = $('select-rule-template');
    ruleTplSel.innerHTML = '<option value="">套用预设模板…</option>' +
      ov.templates.rules.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');

    const mcpTplSel = $('select-mcp-template');
    mcpTplSel.innerHTML = '<option value="">套用 MCP 示例…</option>' +
      ov.templates.mcp.map((t) => `<option value="${esc(t.id)}">${esc(t.name)} — ${esc(t.description)}</option>`).join('');
  }

  // ---------- RULES TAB ----------
  function renderRules() {
    const { items, budget } = state.overview.rules;
    const pct = Math.min(100, Math.round((budget.alwaysOnTokens / budget.tokenBudget) * 100));
    $('budget-text').textContent = `${budget.alwaysOnTokens.toLocaleString()} / ${budget.tokenBudget.toLocaleString()} tok (${pct}%)`;
    const fill = $('budget-fill');
    fill.style.width = `${pct}%`;
    fill.className = `progress-fill ${pct > 100 ? 'bad' : pct > 80 ? 'warn' : ''}`;

    const container = $('rules-list');
    if (!items.length) {
      container.innerHTML = '<div class="empty-box">当前还没有规则文件，点击上方「+ 新建规则」或选择预设模板开始。</div>';
      return;
    }

    container.innerHTML = items.map((r) => {
      const trigTone = r.trigger === 'always_on' ? 'accent' : r.trigger === 'glob' ? 'good' : 'pill';
      const bytesPill = r.overByteLimit
        ? `<span class="pill bad">超限 ${(r.expandedBytes / 1024).toFixed(1)} KB / 24 KB</span>`
        : `<span class="pill">${(r.expandedBytes / 1024).toFixed(1)} KB · ~${r.tokens} tok</span>`;
      const scopePill = r.scope === 'workspace' ? '<span class="pill warn">工作区</span>' : '<span class="pill">全局主源</span>';
      const linkPill = r.isHardLinked ? '<span class="pill good">HardLink</span>' : r.isSymlink ? '<span class="pill good">Symlink</span>' : '';
      return `
        <article class="card">
          <div class="card-head">
            <div class="card-title-wrap">
              <div class="card-title">${esc(r.fileName)}</div>
              <div class="card-sub mono">${esc(r.path)}</div>
            </div>
            <div class="badges">
              ${scopePill}
              <span class="pill ${trigTone}">${esc(r.trigger)}</span>
            </div>
          </div>
          <div class="badges">
            ${bytesPill}
            ${linkPill}
            ${r.globs ? `<span class="pill mono">${esc(r.globs)}</span>` : ''}
            ${r.hasBackup ? '<span class="pill">有 .bak 备份</span>' : ''}
          </div>
          ${r.description ? `<div class="muted" style="font-size:11px">${esc(r.description)}</div>` : ''}
          <div class="card-actions">
            <button class="btn btn-xs btn-edit-rule" data-id="${esc(r.id)}" type="button">编辑</button>
            ${r.hasBackup ? `<button class="btn btn-xs btn-rollback-rule" data-path="${esc(r.path)}" type="button">回滚 .bak</button>` : ''}
            <button class="btn btn-xs btn-danger btn-del-rule" data-path="${esc(r.path)}" data-name="${esc(r.fileName)}" type="button">删除</button>
          </div>
        </article>`;
    }).join('');

    container.querySelectorAll('.btn-edit-rule').forEach((btn) => {
      btn.addEventListener('click', () => {
        const rule = items.find((x) => x.id === btn.dataset.id);
        if (rule) openRuleEditor(rule);
      });
    });
    container.querySelectorAll('.btn-rollback-rule').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const res = await apiPost('/api/rules/rollback', { path: btn.dataset.path });
        if (res.ok) {
          showToast('已从 .bak 恢复规则文件');
          refreshAll();
        } else {
          showToast(res.error || '回滚失败', 'err');
        }
      });
    });
    container.querySelectorAll('.btn-del-rule').forEach((btn) => {
      btn.addEventListener('click', () => {
        openModal('确认删除规则', `<p>确定要删除 <code class="mono">${esc(btn.dataset.name)}</code> 吗？系统会先保留 <code>.bak</code> 备份。</p>`, [
          { label: '取消', className: 'btn', onClick: closeModal },
          {
            label: '确认删除',
            className: 'btn btn-danger',
            onClick: async () => {
              const res = await apiPost('/api/rules/delete', { path: btn.dataset.path });
              closeModal();
              if (res.ok) {
                showToast('规则已删除（已留存 .bak）');
                refreshAll();
              } else {
                showToast(res.error || '删除失败', 'err');
              }
            },
          },
        ]);
      });
    });
  }

  function openRuleEditor(rule = null, tpl = null) {
    const isNew = !rule;
    const hasWs = Boolean(state.overview?.settings?.activeWorkspace);
    const initial = tpl || rule || {
      scope: 'master',
      isStandalone: false,
      fileName: 'custom-rule.md',
      trigger: 'always_on',
      description: '',
      globs: '',
      body: '',
      path: '',
    };

    const html = `
      ${isNew ? `
        <div class="field">
          <label>作用域</label>
          <select id="f-rule-scope" class="select">
            <option value="master" ${initial.scope !== 'workspace' ? 'selected' : ''}>全局主源 (${esc(state.overview.settings.masterDir)})</option>
            ${hasWs ? `<option value="workspace" ${initial.scope === 'workspace' ? 'selected' : ''}>项目工作区 (${esc(state.overview.settings.activeWorkspace)})</option>` : ''}
          </select>
        </div>
        <div class="field">
          <label>规则形态</label>
          <select id="f-rule-kind" class="select">
            <option value="modular" ${!initial.isStandalone ? 'selected' : ''}>模块化规则（rules/*.md，支持自定义文件名与 4 种触发方式）</option>
            <option value="standalone" ${initial.isStandalone ? 'selected' : ''}>常驻根文件（仅限 GEMINI.md / AGENTS.md，无 frontmatter）</option>
          </select>
        </div>
        <div id="wrap-rule-filename-text" class="field ${initial.isStandalone ? 'hidden' : ''}">
          <label>文件名（保存至 rules/ 目录，支持中文）</label>
          <input id="f-rule-filename" class="input mono" type="text" value="${esc(initial.isStandalone ? 'custom-rule.md' : (initial.fileName || 'custom-rule.md'))}" placeholder="例如 中文代码注释规范.md">
        </div>
        <div id="wrap-rule-filename-root" class="field ${initial.isStandalone ? '' : 'hidden'}">
          <label>根文件名（Antigravity 仅自动识别这两个固定文件名）</label>
          <select id="f-rule-rootname" class="select mono">
            <option value="GEMINI.md" ${initial.fileName !== 'AGENTS.md' ? 'selected' : ''}>GEMINI.md</option>
            <option value="AGENTS.md" ${initial.fileName === 'AGENTS.md' ? 'selected' : ''}>AGENTS.md</option>
          </select>
        </div>
      ` : `<div class="field"><label>文件路径</label><div class="mono muted" style="font-size:11px">${esc(initial.path)}</div></div>`}
      <div id="modular-fields" class="${initial.isStandalone ? 'hidden' : ''}">
        <div class="field">
          <label>触发方式 (trigger)</label>
          <select id="f-rule-trigger" class="select">
            <option value="always_on" ${initial.trigger === 'always_on' ? 'selected' : ''}>always_on（每轮无条件注入）</option>
            <option value="model_decision" ${initial.trigger === 'model_decision' ? 'selected' : ''}>model_decision（模型按需读取）</option>
            <option value="glob" ${initial.trigger === 'glob' ? 'selected' : ''}>glob（读写匹配文件时注入）</option>
            <option value="manual" ${initial.trigger === 'manual' ? 'selected' : ''}>manual（仅 @提及时注入）</option>
          </select>
        </div>
        <div class="field">
          <label>描述 (description)</label>
          <input id="f-rule-desc" class="input" type="text" value="${esc(initial.description || '')}" placeholder="model_decision 必填：说明何时适用此规则">
        </div>
        <div class="field">
          <label>匹配路径 (globs)</label>
          <input id="f-rule-globs" class="input mono" type="text" value="${esc(initial.globs || '')}" placeholder="例如 *.ts, *.tsx, *.vue">
        </div>
      </div>
      <div class="field">
        <label>规则正文 (Markdown，支持 @[label](path) 引入外部文件)</label>
        <textarea id="f-rule-body" class="textarea">${esc(initial.body ?? initial.content ?? '')}</textarea>
      </div>
    `;

    openModal(isNew ? '新建规则' : `编辑 ${initial.fileName}`, html, [
      { label: '取消', className: 'btn', onClick: closeModal },
      {
        label: '保存规则',
        className: 'btn btn-primary',
        onClick: async () => {
          const isStandalone = isNew
            ? $('f-rule-kind').value === 'standalone'
            : initial.isStandalone;
          const chosenFileName = isNew
            ? (isStandalone ? $('f-rule-rootname').value : $('f-rule-filename').value.trim())
            : initial.fileName;
          const payload = {
            path: initial.path || '',
            scope: isNew ? $('f-rule-scope').value : initial.scope,
            isStandalone,
            fileName: chosenFileName,
            trigger: $('f-rule-trigger')?.value || 'always_on',
            description: $('f-rule-desc')?.value || '',
            globs: $('f-rule-globs')?.value || '',
            body: $('f-rule-body').value,
          };
          const res = await apiPost('/api/rules/save', payload);
          if (res.ok) {
            closeModal();
            showToast('规则已保存（已自动生成 .bak 备份）');
            refreshAll();
          } else {
            showToast(res.error || '保存失败', 'err');
          }
        },
      },
    ]);

    if (isNew) {
      $('f-rule-kind').addEventListener('change', (e) => {
        const standalone = e.target.value === 'standalone';
        $('modular-fields').classList.toggle('hidden', standalone);
        $('wrap-rule-filename-text').classList.toggle('hidden', standalone);
        $('wrap-rule-filename-root').classList.toggle('hidden', !standalone);
      });
    }
  }

  // ---------- MCP TAB ----------
  function renderMcp() {
    const { items } = state.overview.mcp;
    const container = $('mcp-list');
    if (!items.length) {
      container.innerHTML = '<div class="empty-box">暂无 MCP 服务配置，点击「+ 添加 MCP」或选择示例模板。</div>';
      return;
    }

    container.innerHTML = items.map((m) => {
      const endpoint = m.transport === 'stdio'
        ? `${m.command} ${(m.args || []).join(' ')}`
        : m.url;
      const warnHtml = (m.warnings || []).includes('legacy_sse_unsupported')
        ? '<span class="pill bad">检测到 /sse：Antigravity 仅支持 Streamable HTTP (/mcp)</span>'
        : (m.warnings || []).includes('missing_endpoint')
          ? '<span class="pill warn">缺少端点配置</span>'
          : '';
      return `
        <article class="card">
          <div class="card-head">
            <div class="card-title-wrap">
              <div class="card-title">${esc(m.name)}</div>
              <div class="card-sub mono">${esc(endpoint)}</div>
            </div>
            <div class="badges">
              <span class="pill">${m.scope === 'workspace' ? '工作区' : '全局主源'}</span>
              <span class="pill accent">${m.transport === 'stdio' ? 'Stdio' : 'HTTP'}</span>
            </div>
          </div>
          ${warnHtml ? `<div class="badges">${warnHtml}</div>` : ''}
          <div class="card-actions">
            <button class="btn btn-xs btn-edit-mcp" data-id="${esc(m.id)}" type="button">编辑</button>
            <button class="btn btn-xs btn-danger btn-del-mcp" data-scope="${esc(m.scope)}" data-name="${esc(m.name)}" type="button">删除</button>
          </div>
        </article>`;
    }).join('');

    container.querySelectorAll('.btn-edit-mcp').forEach((btn) => {
      btn.addEventListener('click', () => {
        const item = items.find((x) => x.id === btn.dataset.id);
        if (item) openMcpEditor(item);
      });
    });
    container.querySelectorAll('.btn-del-mcp').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const res = await apiPost('/api/mcp/delete', { scope: btn.dataset.scope, name: btn.dataset.name });
        if (res.ok) {
          showToast(`已移除 MCP: ${btn.dataset.name}`);
          refreshAll();
        } else {
          showToast(res.error || '删除失败', 'err');
        }
      });
    });
  }

  function kvToLines(obj = {}) {
    return Object.entries(obj || {}).map(([k, v]) => `${k}=${v}`).join('\n');
  }

  function linesToKv(text = '') {
    const out = {};
    for (const raw of String(text || '').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const idx = line.indexOf('=');
      if (idx === -1) continue;
      const k = line.slice(0, idx).trim();
      const v = line.slice(idx + 1).trim();
      if (k) out[k] = v;
    }
    return out;
  }

  function openMcpEditor(item = null, tpl = null) {
    const isNew = !item;
    const hasWs = Boolean(state.overview?.settings?.activeWorkspace);
    const data = tpl
      ? {
          scope: 'master',
          name: tpl.name,
          transport: tpl.config.command ? 'stdio' : 'http',
          command: tpl.config.command || '',
          args: tpl.config.args || [],
          env: tpl.config.env || {},
          url: tpl.config.url || '',
          headers: tpl.config.headers || {},
        }
      : item || {
          scope: 'master',
          name: '',
          transport: 'stdio',
          command: 'npx',
          args: [],
          env: {},
          url: '',
          headers: {},
        };

    const html = `
      ${isNew && hasWs ? `
        <div class="field">
          <label>作用域</label>
          <select id="f-mcp-scope" class="select">
            <option value="master" selected>全局主源</option>
            <option value="workspace">项目工作区 (.agents/mcp_config.json)</option>
          </select>
        </div>` : ''}
      <div class="field">
        <label>服务名称</label>
        <input id="f-mcp-name" class="input mono" type="text" value="${esc(data.name)}" placeholder="例如 sqlite-helper">
      </div>
      <div class="field">
        <label>传输模式</label>
        <select id="f-mcp-transport" class="select">
          <option value="stdio" ${data.transport === 'stdio' ? 'selected' : ''}>本地命令行 (Stdio)</option>
          <option value="http" ${data.transport === 'http' ? 'selected' : ''}>远程服务 (Streamable HTTP)</option>
        </select>
      </div>
      <div id="mcp-stdio-fields" class="${data.transport === 'http' ? 'hidden' : ''}">
        <div class="field">
          <label>命令 (command)</label>
          <input id="f-mcp-cmd" class="input mono" type="text" value="${esc(data.command || '')}" placeholder="npx / node / python / uvx">
        </div>
        <div class="field">
          <label>参数 (args，每行一个)</label>
          <textarea id="f-mcp-args" class="textarea" style="min-height:80px">${esc((data.args || []).join('\n'))}</textarea>
        </div>
        <div class="field">
          <label>环境变量 (env，每行 KEY=VALUE)</label>
          <textarea id="f-mcp-env" class="textarea" style="min-height:70px">${esc(kvToLines(data.env))}</textarea>
        </div>
      </div>
      <div id="mcp-http-fields" class="${data.transport === 'stdio' ? 'hidden' : ''}">
        <div class="field">
          <label>端点 URL (Streamable HTTP，通常以 /mcp 结尾)</label>
          <input id="f-mcp-url" class="input mono" type="text" value="${esc(data.url || '')}" placeholder="https://mcp.example.com/mcp">
        </div>
        <div class="field">
          <label>请求头 (headers，每行 KEY=VALUE)</label>
          <textarea id="f-mcp-headers" class="textarea" style="min-height:70px">${esc(kvToLines(data.headers))}</textarea>
        </div>
      </div>
    `;

    openModal(isNew ? '添加 MCP Server' : `编辑 MCP: ${data.name}`, html, [
      { label: '取消', className: 'btn', onClick: closeModal },
      {
        label: '保存配置',
        className: 'btn btn-primary',
        onClick: async () => {
          const transport = $('f-mcp-transport').value;
          const payload = {
            scope: isNew ? ($('f-mcp-scope')?.value || 'master') : data.scope,
            previousName: isNew ? '' : data.name,
            name: $('f-mcp-name').value.trim(),
            transport,
            command: $('f-mcp-cmd').value.trim(),
            args: $('f-mcp-args').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
            env: linesToKv($('f-mcp-env').value),
            url: $('f-mcp-url').value.trim(),
            headers: linesToKv($('f-mcp-headers').value),
          };
          const res = await apiPost('/api/mcp/save', payload);
          if (res.ok) {
            closeModal();
            showToast('MCP 配置已保存（可点击「重载 MCP」或「跨端同步」）');
            refreshAll();
          } else {
            showToast(res.error || '保存失败', 'err');
          }
        },
      },
    ]);

    $('f-mcp-transport').addEventListener('change', (e) => {
      const isHttp = e.target.value === 'http';
      $('mcp-stdio-fields').classList.toggle('hidden', isHttp);
      $('mcp-http-fields').classList.toggle('hidden', !isHttp);
    });
  }

  function openRawJsonEditor(title, initialRaw, saveEndpoint, scope = 'master') {
    const html = `
      <div class="field">
        <label>原始 JSON 内容</label>
        <textarea id="f-raw-json" class="textarea" style="min-height:280px">${esc(initialRaw || '{}')}</textarea>
      </div>
    `;
    openModal(title, html, [
      { label: '取消', className: 'btn', onClick: closeModal },
      {
        label: '保存 JSON',
        className: 'btn btn-primary',
        onClick: async () => {
          const res = await apiPost(saveEndpoint, { scope, rawJson: $('f-raw-json').value });
          if (res.ok) {
            closeModal();
            showToast('JSON 已保存');
            refreshAll();
          } else {
            showToast(res.error || 'JSON 格式或写入错误', 'err');
          }
        },
      },
    ]);
  }

  // ---------- CLIENTS & LINKS TAB ----------
  function statusPillHtml(t) {
    const map = {
      master_self: 'accent',
      synced: 'good',
      linked: 'good',
      drifted: 'warn',
      missing: 'pill',
      broken_link: 'bad',
      error: 'bad',
    };
    return `<span class="pill ${map[t.status] || ''}">${esc(t.statusLabel || t.status)}</span>`;
  }

  function renderClients() {
    const targets = state.overview.targets || [];
    const enabledCount = targets.filter((t) => t.enabled).length;
    const syncedCount = targets.filter(
      (t) => t.enabled && (t.status === 'synced' || t.status === 'linked' || t.status === 'master_self'),
    ).length;
    $('clients-summary').textContent = `已启用 ${enabledCount} 个目标 · ${syncedCount}/${enabledCount} 处于最新同步/链接状态`;

    const container = $('clients-list');
    container.innerHTML = targets.map((t) => {
      const modeNames = {
        'sync-replace': '覆盖同步',
        'sync-merge-json': 'JSON局部合并',
        'sync-merge-toml': 'TOML局部合并',
        hardlink: 'Hard Link',
        junction: 'Junction联接',
        'native-plugin-mount': 'plugins.json挂载',
      };
      return `
        <article class="card">
          <div class="card-head">
            <div class="card-title-wrap">
              <div class="card-title">${esc(t.name)}</div>
              <div class="card-sub mono">${esc(t.resolvedTarget)}</div>
            </div>
            <div class="badges">
              ${statusPillHtml(t)}
            </div>
          </div>
          <div class="badges">
            <label class="toggle-switch">
              <input type="checkbox" class="chk-target-enable" data-id="${esc(t.id)}" ${t.enabled ? 'checked' : ''}>
              <span>启用</span>
            </label>
            <span class="pill">${esc(t.client)}</span>
            <span class="pill">${esc(t.kind)}</span>
            <span class="pill accent">${esc(modeNames[t.mode] || t.mode)}</span>
            ${t.clientDirExists ? '<span class="pill good">目录存在</span>' : '<span class="pill">目录未创建</span>'}
            ${t.hasBackup ? '<span class="pill">有 .bak</span>' : ''}
          </div>
          ${t.warnings?.length ? `<div class="muted" style="font-size:11px;color:var(--warn)">${esc(t.warnings.join('; '))}</div>` : ''}
          <div class="card-actions">
            ${!t.isMasterSelf ? `
              <button class="btn btn-xs btn-preview-target" data-id="${esc(t.id)}" type="button">预览差异</button>
              <button class="btn btn-xs btn-primary btn-sync-target" data-id="${esc(t.id)}" type="button">${t.mode === 'junction' || t.mode === 'hardlink' ? '建立链接' : '立即同步'}</button>
            ` : ''}
            <button class="btn btn-xs btn-edit-target" data-id="${esc(t.id)}" type="button">配置</button>
            ${t.hasBackup ? `<button class="btn btn-xs btn-rollback-target" data-id="${esc(t.id)}" type="button">回滚</button>` : ''}
            ${!t.builtin ? `<button class="btn btn-xs btn-danger btn-del-target" data-id="${esc(t.id)}" type="button">移除</button>` : ''}
          </div>
        </article>`;
    }).join('');

    container.querySelectorAll('.chk-target-enable').forEach((chk) => {
      chk.addEventListener('change', async () => {
        const target = targets.find((x) => x.id === chk.dataset.id);
        if (!target) return;
        const res = await apiPost('/api/targets/save', { ...target, enabled: chk.checked });
        if (res.ok) refreshAll();
      });
    });

    container.querySelectorAll('.btn-preview-target').forEach((btn) => {
      btn.addEventListener('click', () => previewAndConfirmSync([btn.dataset.id]));
    });

    container.querySelectorAll('.btn-sync-target').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const res = await apiPost('/api/targets/sync', { ids: [btn.dataset.id] });
        if (res.ok) {
          showToast('同步/链接完成');
        } else {
          const errMsg = res.results?.find((r) => !r.ok)?.error || res.error || '操作失败';
          showToast(errMsg, 'err');
        }
        refreshAll();
      });
    });

    container.querySelectorAll('.btn-edit-target').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = targets.find((x) => x.id === btn.dataset.id);
        if (target) openTargetEditor(target);
      });
    });

    container.querySelectorAll('.btn-rollback-target').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const res = await apiPost('/api/targets/rollback', { id: btn.dataset.id });
        if (res.ok) {
          showToast('已从 .bak 备份回滚');
          refreshAll();
        } else {
          showToast(res.error || '回滚失败', 'err');
        }
      });
    });

    container.querySelectorAll('.btn-del-target').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const res = await apiPost('/api/targets/delete', { id: btn.dataset.id });
        if (res.ok) {
          showToast('已移除自定义目标');
          refreshAll();
        }
      });
    });
  }

  async function previewAndConfirmSync(ids = null) {
    const res = await apiPost('/api/targets/preview', ids ? { ids } : {});
    if (!res.ok) {
      showToast(res.error || '预览失败', 'err');
      return;
    }

    const previews = res.previews || [];
    const html = previews.map((p) => {
      const ins = p.inspected;
      if (ins.isMasterSelf) {
        return `<div class="card"><div class="card-title">${esc(ins.name)}</div><div class="muted">当前为主源本身，跳过。</div></div>`;
      }
      if (!p.ok) {
        return `<div class="card"><div class="card-title">${esc(ins.name)}</div><div style="color:var(--bad)">${esc(p.error)}</div></div>`;
      }
      let diffHtml = '';
      if (ins.mode === 'junction') {
        diffHtml = `<div class="muted">将建立 Directory Junction：<br><code class="mono">${esc(ins.resolvedTarget)}</code> → <code class="mono">${esc(ins.sourcePath)}</code></div>`;
      } else if (!ins.diff?.changed) {
        diffHtml = '<div class="muted">与主源一致，无需更改。</div>';
      } else {
        const linesHtml = (ins.diff.lines || []).map((l) => {
          const cls = l.type === 'add' ? 'diff-line-add' : l.type === 'del' ? 'diff-line-del' : 'diff-line-ctx';
          const prefix = l.type === 'add' ? '+ ' : l.type === 'del' ? '- ' : '  ';
          return `<div class="${cls}">${esc(prefix + l.text)}</div>`;
        }).join('');
        diffHtml = `<div class="diff-box">${linesHtml}${ins.diff.truncated ? '\n... (已截断)' : ''}</div>`;
      }
      return `
        <div style="margin-bottom:10px">
          <div style="font-weight:600;margin-bottom:4px">${esc(ins.name)} <span class="pill">${esc(ins.statusLabel)}</span></div>
          ${diffHtml}
        </div>`;
    }).join('');

    openModal('变更预览（Dry-Run Diff）', html || '<div class="empty-box">没有已启用的目标</div>', [
      { label: '取消', className: 'btn', onClick: closeModal },
      {
        label: '确认执行同步/链接',
        className: 'btn btn-primary',
        onClick: async () => {
          const applyRes = await apiPost('/api/targets/sync', ids ? { ids } : {});
          closeModal();
          if (applyRes.ok) {
            showToast('全部目标已同步完成（已自动保留 .bak 备份）');
          } else {
            const firstErr = applyRes.results?.find((r) => !r.ok)?.error || applyRes.error || '部分同步失败';
            showToast(firstErr, 'err');
          }
          refreshAll();
        },
      },
    ]);
  }

  function openTargetEditor(target = null) {
    const isNew = !target;
    const data = target || {
      id: '',
      name: '',
      client: 'custom',
      kind: 'rules',
      targetPath: '',
      sourcePath: '',
      mode: 'sync-replace',
      mergeKey: 'mcpServers',
      enabled: true,
      builtin: false,
    };

    const html = `
      <div class="field">
        <label>显示名称</label>
        <input id="f-tgt-name" class="input" type="text" value="${esc(data.name)}" placeholder="例如 某项目规范 / Qoder MCP">
      </div>
      <div class="field">
        <label>客户端标识</label>
        <input id="f-tgt-client" class="input mono" type="text" value="${esc(data.client)}" placeholder="cursor / claude-code / codex / qoder / custom">
      </div>
      <div class="field">
        <label>配置类型 (kind)</label>
        <select id="f-tgt-kind" class="select">
          <option value="rules" ${data.kind === 'rules' ? 'selected' : ''}>全局规则 (Markdown)</option>
          <option value="mcp" ${data.kind === 'mcp' ? 'selected' : ''}>MCP 服务配置</option>
          <option value="skills_dir" ${data.kind === 'skills_dir' ? 'selected' : ''}>Skills 目录</option>
          <option value="rules_dir" ${data.kind === 'rules_dir' ? 'selected' : ''}>Rules 目录</option>
        </select>
      </div>
      <div class="field">
        <label>目标文件路径（支持 ~/）</label>
        <input id="f-tgt-path" class="input mono" type="text" value="${esc(data.targetPath)}" placeholder="例如 D:\\projects\\app\\.agents\\AGENTS.md 或 ~/.qoder/mcp.json">
      </div>
      <div class="field">
        <label>链接/同步模式</label>
        <select id="f-tgt-mode" class="select">
          <option value="sync-replace" ${data.mode === 'sync-replace' ? 'selected' : ''}>覆盖同步 (sync-replace，自动 .bak)</option>
          <option value="sync-merge-json" ${data.mode === 'sync-merge-json' ? 'selected' : ''}>JSON 局部键合并 (仅合并 mcpServers)</option>
          <option value="sync-merge-toml" ${data.mode === 'sync-merge-toml' ? 'selected' : ''}>Codex TOML 局部节合并 ([mcp_servers])</option>
          <option value="hardlink" ${data.mode === 'hardlink' ? 'selected' : ''}>Windows Hard Link (同盘符实时共享)</option>
          <option value="junction" ${data.mode === 'junction' ? 'selected' : ''}>Windows Junction (目录联接)</option>
          <option value="native-plugin-mount" ${data.mode === 'native-plugin-mount' ? 'selected' : ''}>Antigravity plugins.json 原生挂载</option>
        </select>
      </div>
      <div class="field">
        <label>自定义源路径（留空则使用当前主配置源对应文件/目录）</label>
        <input id="f-tgt-source" class="input mono" type="text" value="${esc(data.sourcePath || '')}" placeholder="可选">
      </div>
    `;

    openModal(isNew ? '添加自定义目标地址' : `配置目标: ${data.name}`, html, [
      { label: '取消', className: 'btn', onClick: closeModal },
      {
        label: '保存目标',
        className: 'btn btn-primary',
        onClick: async () => {
          const res = await apiPost('/api/targets/save', {
            ...data,
            name: $('f-tgt-name').value.trim(),
            client: $('f-tgt-client').value.trim() || 'custom',
            kind: $('f-tgt-kind').value,
            targetPath: $('f-tgt-path').value.trim(),
            mode: $('f-tgt-mode').value,
            sourcePath: $('f-tgt-source').value.trim(),
          });
          if (res.ok) {
            closeModal();
            showToast('目标配置已保存');
            refreshAll();
          } else {
            showToast(res.error || '保存失败', 'err');
          }
        },
      },
    ]);
  }

  // ---------- HOOKS & INVENTORY TAB ----------
  function renderHooks() {
    const items = state.overview.hooks?.items || [];
    const container = $('hooks-list');
    if (!items.length) {
      container.innerHTML = '<div class="empty-box">当前无 hooks.json 配置，可点击「+ 安全示例」快速体验生命周期拦截。</div>';
      return;
    }

    container.innerHTML = items.map((h) => `
      <article class="card">
        <div class="card-head">
          <div class="card-title-wrap">
            <div class="card-title">${esc(h.name)}</div>
            <div class="card-sub mono">${esc(h.sourcePath)}</div>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" class="chk-hook-enable" data-scope="${esc(h.scope)}" data-name="${esc(h.name)}" ${h.enabled ? 'checked' : ''}>
            <span>${h.enabled ? '启用' : '停用'}</span>
          </label>
        </div>
        <div class="badges">
          ${(h.events || []).map((ev) => `<span class="pill accent">${esc(ev.event)} · ${esc(ev.matcher)}</span>`).join('')}
        </div>
        <div class="card-actions">
          <button class="btn btn-xs btn-danger btn-del-hook" data-scope="${esc(h.scope)}" data-name="${esc(h.name)}" type="button">删除</button>
        </div>
      </article>`).join('');

    container.querySelectorAll('.chk-hook-enable').forEach((chk) => {
      chk.addEventListener('change', async () => {
        const res = await apiPost('/api/hooks/save', {
          scope: chk.dataset.scope,
          name: chk.dataset.name,
          action: 'toggle',
          enabled: chk.checked,
        });
        if (res.ok) {
          showToast(`Hook ${chk.dataset.name} 已${chk.checked ? '启用' : '停用'}`);
          refreshAll();
        }
      });
    });

    container.querySelectorAll('.btn-del-hook').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const res = await apiPost('/api/hooks/save', {
          scope: btn.dataset.scope,
          name: btn.dataset.name,
          action: 'delete',
        });
        if (res.ok) {
          showToast(`已移除 Hook ${btn.dataset.name}`);
          refreshAll();
        }
      });
    });
  }

  function renderSkillsAndInventory() {
    const container = $('inventory-list');
    const localSkills = state.overview?.skills || [];
    const plugins = state.inventory?.plugins || [];

    const parts = [];
    if (localSkills.length) {
      parts.push(`
        <article class="card">
          <div class="card-title">独立 Skills (${localSkills.length})</div>
          <div class="badges">${localSkills.map((s) => `<span class="pill">${esc(s.name)}</span>`).join('')}</div>
        </article>`);
    }

    if (state.inventory && !state.inventory.available) {
      parts.push(`<div class="muted" style="font-size:11px">Language Server 暂不可达（${esc(state.inventory.error || 'offline')}），仅显示本地文件扫描结果。</div>`);
    } else if (plugins.length) {
      parts.push(...plugins.map((p) => `
        <article class="card">
          <div class="card-head">
            <div class="card-title-wrap">
              <div class="card-title">${esc(p.displayName)} <span class="muted mono" style="font-weight:400">(${esc(p.dir)})</span></div>
              <div class="card-sub mono">${esc(p.path)}</div>
            </div>
            <span class="pill ${p.disabled ? 'warn' : 'good'}">${p.disabled ? '已停用' : '已启用'}</span>
          </div>
          <div class="badges">
            ${p.isBuiltin ? '<span class="pill">内置</span>' : '<span class="pill">用户插件</span>'}
            <span class="pill">Skills ${p.skills.length}</span>
            <span class="pill">Rules ${p.rules.length}</span>
            <span class="pill">MCP ${p.mcpServers.length}</span>
            ${p.hasHooks ? '<span class="pill accent">Hooks</span>' : ''}
          </div>
        </article>`));
    }

    container.innerHTML = parts.join('') || '<div class="empty-box">点击「重新扫描」获取 Antigravity 已安装插件清单。</div>';
  }

  // ---------- Wire top-level buttons & tabs ----------
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      state.activeTab = tab.dataset.tab;
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('hidden', p.id !== `panel-${state.activeTab}`));
      if (state.activeTab === 'more' && !state.inventory) {
        loadInventory();
      }
    });
  });

  $('btn-paths').addEventListener('click', () => {
    $('paths-drawer').classList.toggle('hidden');
  });
  $('btn-refresh').addEventListener('click', () => {
    refreshAll();
    if (state.activeTab === 'more') loadInventory();
  });
  $('btn-reset-master').addEventListener('click', async () => {
    const res = await apiPost('/api/settings', { masterDir: '' });
    if (res.ok) {
      showToast('已恢复默认全局配置目录');
      refreshAll();
    }
  });
  $('btn-save-paths').addEventListener('click', async () => {
    const res = await apiPost('/api/settings', {
      masterDir: $('input-master-dir').value.trim(),
      activeWorkspace: $('input-workspace-dir').value.trim(),
    });
    if (res.ok) {
      $('paths-drawer').classList.add('hidden');
      showToast('路径配置已更新');
      refreshAll();
    } else {
      showToast(res.error || '更新失败', 'err');
    }
  });

  $('btn-new-rule').addEventListener('click', () => openRuleEditor());
  $('select-rule-template').addEventListener('change', (e) => {
    const tpl = state.overview?.templates?.rules?.find((t) => t.id === e.target.value);
    e.target.value = '';
    if (tpl) openRuleEditor(null, tpl);
  });

  $('btn-new-mcp').addEventListener('click', () => openMcpEditor());
  $('select-mcp-template').addEventListener('change', (e) => {
    const tpl = state.overview?.templates?.mcp?.find((t) => t.id === e.target.value);
    e.target.value = '';
    if (tpl) openMcpEditor(null, tpl);
  });
  $('btn-mcp-raw').addEventListener('click', () => {
    const raw = state.overview?.mcp?.scopes?.master?.raw || '{\n  "mcpServers": {}\n}';
    openRawJsonEditor('编辑主 mcp_config.json', raw, '/api/mcp/save', 'master');
  });
  $('btn-mcp-reload').addEventListener('click', async () => {
    const res = await apiPost('/api/mcp/refresh', {});
    if (res.ok) showToast('已发送 MCP 热重载请求');
    else showToast(`重载失败（可前往 ... > MCP Servers 手动刷新）: ${res.error}`, 'err');
  });

  $('btn-preview-all').addEventListener('click', () => previewAndConfirmSync(null));
  $('btn-sync-all').addEventListener('click', async () => {
    const res = await apiPost('/api/targets/sync', {});
    if (res.ok) showToast('已同步全部启用目标（已自动生成 .bak 备份）');
    else showToast(res.results?.find((r) => !r.ok)?.error || res.error || '部分同步失败', 'err');
    refreshAll();
  });
  $('btn-new-target').addEventListener('click', () => openTargetEditor());

  $('btn-hook-template').addEventListener('click', async () => {
    const tpl = state.overview?.templates?.hooks?.[0];
    if (!tpl) return;
    const res = await apiPost('/api/hooks/save', {
      scope: 'master',
      name: tpl.hookName,
      config: tpl.config,
    });
    if (res.ok) {
      showToast('已导入安全 Hook 示例（默认停用状态）');
      refreshAll();
    } else {
      showToast(res.error || '导入失败', 'err');
    }
  });
  $('btn-hooks-raw').addEventListener('click', () => {
    const raw = state.overview?.hooks?.scopes?.master?.raw || '{}';
    openRawJsonEditor('编辑主 hooks.json', raw, '/api/hooks/save', 'master');
  });
  $('btn-reload-inventory').addEventListener('click', loadInventory);

  refreshAll();
})();
