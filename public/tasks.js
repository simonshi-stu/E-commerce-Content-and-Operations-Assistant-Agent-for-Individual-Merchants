'use strict';
/**
 * Task center UI (T2.6): a small vanilla-JS operator console over /tasks-api/.
 * All untrusted strings are rendered via textContent / createElement only (no innerHTML).
 * The session token and project id live in localStorage and are sent as the x-tasks-session
 * header / path segment; the server authorizes every request (identity != authorization).
 */
(function () {
  const state = {
    token: localStorage.getItem('tasks.sessionToken') || '',
    projectId: localStorage.getItem('tasks.projectId') || ''
  };
  const $ = (id) => document.getElementById(id);

  function setText(element, text) {
    element.textContent = text === null || text === undefined ? '' : String(text);
  }
  function clear(element) {
    element.replaceChildren();
  }
  function show(element, text, kind) {
    clear(element);
    const span = document.createElement('span');
    setText(span, text);
    element.className = `tc-result${kind ? ` tc-${kind}` : ''}`;
    element.append(span);
  }
  function cell(row, text) {
    const td = document.createElement('td');
    setText(td, text);
    row.append(td);
    return td;
  }
  function actionsCell(row) {
    const td = document.createElement('td');
    td.className = 'tc-actions';
    row.append(td);
    return td;
  }
  function button(label, onClick) {
    const element = document.createElement('button');
    element.type = 'button';
    setText(element, label);
    element.addEventListener('click', onClick);
    return element;
  }
  function requireProject() {
    if (!state.projectId) throw new Error('请先在顶部填写项目 ID 并切换项目。');
    return state.projectId;
  }

  async function api(path, options = {}) {
    const headers = {};
    if (state.token) headers['x-tasks-session'] = state.token;
    let body;
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    const response = await fetch(`/tasks-api${path}`, { method: options.method || 'GET', headers, body });
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    if (!response.ok) {
      const message = payload && payload.error ? `${payload.error.code}: ${payload.error.message}` : `HTTP ${response.status}`;
      throw new Error(message);
    }
    return payload ? payload.data : null;
  }

  async function downloadArtifact(artifactId, fileName) {
    const headers = {};
    if (state.token) headers['x-tasks-session'] = state.token;
    const response = await fetch(`/tasks-api/artifacts/${encodeURIComponent(artifactId)}/download`, { headers });
    if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName || 'artifact';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  async function previewArtifact(artifactId, fileName) {
    const headers = {};
    if (state.token) headers['x-tasks-session'] = state.token;
    const response = await fetch(`/tasks-api/artifacts/${encodeURIComponent(artifactId)}/download`, { headers });
    if (!response.ok) throw new Error(`预览失败：HTTP ${response.status}`);
    const blob = await response.blob();
    if (!blob.type || !blob.type.startsWith('image/')) {
      alert('该素材类型不支持内联预览，请下载查看。');
      return;
    }
    const url = URL.createObjectURL(blob);
    const container = $('assets-pref-box');
    clear(container);
    const image = document.createElement('img');
    image.src = url;
    image.alt = fileName || 'preview';
    image.style.maxWidth = '360px';
    image.style.borderRadius = '8px';
    container.append(image);
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  async function refreshSession() {
    try {
      const data = await api('/session');
      setText($('session-state'), data.authenticated ? `已连接：${data.actor}` : '未连接（仅公开页面）');
    } catch (error) {
      setText($('session-state'), `未连接（${error.message}）`);
    }
  }

  function renderDocument(documentInfo) {
    const box = document.createElement('div');
    setText(box, `文档 ${documentInfo.documentId} · ${documentInfo.format} · sha256 ${String(documentInfo.rawSha256).slice(0, 12)}… · 状态 ${documentInfo.status}`);
    return box;
  }
  function renderCandidates(container, documentId, candidates) {
    clear(container);
    if (!candidates || candidates.length === 0) { setText(container, '没有候选字段。'); return; }
    const table = document.createElement('table');
    table.className = 'tc-table';
    const head = document.createElement('tr');
    for (const label of ['字段', '原始值', '规范化', '未解决条件', '状态', '主题', '上下文', '片段', '操作']) {
      const th = document.createElement('th');
      setText(th, label);
      head.append(th);
    }
    table.append(head);
    for (const candidate of candidates) {
      const row = document.createElement('tr');
      cell(row, candidate.fieldKey);
      cell(row, candidate.rawValue);
      cell(row, [candidate.numericValue !== null ? candidate.numericValue : '', candidate.currency || '', candidate.unit || '', candidate.incoterm || ''].filter(Boolean).join(' '));
      cell(row, candidate.reasons || '');
      cell(row, candidate.status);
      cell(row, candidate.subjectKey || '');
      cell(row, [candidate.sheet, candidate.rowNumber !== null && candidate.rowNumber !== undefined ? `行${candidate.rowNumber}` : '', candidate.columnRef].filter(Boolean).join(' / '));
      cell(row, candidate.snippet || '');
      const actions = actionsCell(row);
      actions.append(button('确认', async () => {
        try {
          await api(`/projects/${encodeURIComponent(requireProject())}/candidates/${candidate.candidateId}/confirm`, { method: 'POST', body: { observedAt: new Date().toISOString() } });
          await reloadDocument(container, documentId);
        } catch (error) { alert(error.message); }
      }));
      actions.append(button('纠错', async () => {
        const correctedValue = prompt('更正后的原始值（例如 13 / USD / red）', candidate.rawValue || '');
        if (correctedValue === null || correctedValue.trim() === '') return;
        const correctedCurrency = prompt('更正后的币种（USD/CNY/EUR，可留空）', candidate.currency || '') || undefined;
        const correctedUnit = prompt('更正后的单位（可留空）', candidate.unit || '') || undefined;
        try {
          await api(`/projects/${encodeURIComponent(requireProject())}/candidates/${candidate.candidateId}/correct`, { method: 'POST', body: { correctedValue, correctedCurrency, correctedUnit } });
          await reloadDocument(container, documentId);
        } catch (error) { alert(error.message); }
      }));
      table.append(row);
    }
    container.append(table);
  }
  async function reloadDocument(container, documentId) {
    const data = await api(`/projects/${encodeURIComponent(requireProject())}/imports/${documentId}`);
    renderCandidates(container, documentId, data.candidates);
    show($('upload-result'), `重开读回：${data.document.documentId} · 候选 ${data.candidates.length} · 扫描页 ${data.scanPages.length}`, 'ok');
  }

  async function uploadSelected() {
    try {
      const projectId = requireProject();
      const file = $('upload-file').files[0];
      if (!file) return show($('upload-result'), '请选择 csv / xlsx / pdf 文件。', 'err');
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 0x8000));
      }
      const contentBase64 = btoa(binary);
      const supplierKey = $('upload-supplier').value.trim() || 'ui-upload';
      const data = await api(`/projects/${encodeURIComponent(projectId)}/imports`, {
        method: 'POST',
        body: { fileName: file.name, supplierKey, contentBase64 }
      });
      if (data.status === 'blocked') {
        show($('upload-result'), `显式 blocked：${data.reason}（${data.note}）`, 'err');
        clear($('upload-candidates'));
        return;
      }
      show($('upload-result'), `导入 ${data.status} · 候选 ${data.candidates.length}`, 'ok');
      const header = document.createElement('div');
      header.append(renderDocument(data.document));
      const wrap = $('upload-candidates');
      clear(wrap);
      wrap.append(header);
      renderCandidates(wrap, data.document.documentId, data.candidates);
    } catch (error) {
      show($('upload-result'), error.message, 'err');
    }
  }

  async function refreshBudget() {
    try {
      const projectId = requireProject();
      const data = await api(`/projects/${encodeURIComponent(projectId)}/budget`);
      clear($('budget-box'));
      const line = document.createElement('div');
      setText(line, `费用（${data.currency}）：已花 ${data.spentMicros}µ / 预留 ${data.reservedMicros}µ / 超支 ${data.overrunMicros}µ · ${data.note}`);
      $('budget-box').append(line);
      if (data.reservations.length > 0) {
        const table = document.createElement('table');
        table.className = 'tc-table';
        const head = document.createElement('tr');
        for (const label of ['预留', '状态', '类别', 'hold', 'pending', 'settled', 'remote']) {
          const th = document.createElement('th');
          setText(th, label);
          head.append(th);
        }
        table.append(head);
        for (const reservation of data.reservations) {
          const row = document.createElement('tr');
          cell(row, reservation.reservationId.slice(0, 14));
          cell(row, reservation.status);
          cell(row, reservation.category);
          cell(row, reservation.holdMicros);
          cell(row, reservation.pendingMicros);
          cell(row, reservation.settledMicros === null ? '' : reservation.settledMicros);
          cell(row, reservation.remoteId || '');
          table.append(row);
        }
        $('budget-box').append(table);
      }
    } catch (error) {
      show($('budget-box'), error.message, 'err');
    }
  }

  async function refreshRuns() {
    try {
      const projectId = requireProject();
      const data = await api(`/projects/${encodeURIComponent(projectId)}/runs`);
      const container = $('runs-list');
      clear(container);
      const table = document.createElement('table');
      table.className = 'tc-table';
      const head = document.createElement('tr');
      for (const label of ['run', '状态', '任务', '完成步骤', '重做自', '操作']) {
        const th = document.createElement('th');
        setText(th, label);
        head.append(th);
      }
      table.append(head);
      for (const run of data.runs.slice().reverse()) {
        const row = document.createElement('tr');
        cell(row, run.runId);
        cell(row, run.status);
        cell(row, run.taskType);
        cell(row, run.completedSteps);
        cell(row, run.retryOf || '');
        const actions = actionsCell(row);
        actions.append(button('查看', () => showRunDetail(run.runId)));
        actions.append(button('取消', async () => {
          try {
            const outcome = await api(`/projects/${encodeURIComponent(requireProject())}/runs/${run.runId}/cancel`, { method: 'POST', body: { reason: '任务中心取消' } });
            alert(`${outcome.status} · ${outcome.note}`);
            await refreshRuns();
          } catch (error) { alert(error.message); }
        }));
        actions.append(button('重做', async () => {
          try {
            const outcome = await api(`/projects/${encodeURIComponent(requireProject())}/runs/${run.runId}/redo`, { method: 'POST', body: {} });
            alert(`新 run ${outcome.runId} · ${outcome.status}（原 run 不变）`);
            await refreshRuns();
          } catch (error) { alert(error.message); }
        }));
        table.append(row);
      }
      container.append(table);
    } catch (error) {
      show($('runs-list'), error.message, 'err');
    }
  }

  async function showRunDetail(runId) {
    try {
      const projectId = requireProject();
      const data = await api(`/projects/${encodeURIComponent(projectId)}/runs/${runId}`);
      const container = $('run-detail');
      clear(container);
      const lines = [
        `run ${data.runId} · ${data.status} · 任务 ${data.task ? data.task.name : '(未知)'} · 输入版本 ${data.task ? data.task.inputVersion : '-'}`,
        `完成步骤：${data.checkpoint.completedSteps.join(', ') || '(无)'} · finishedAt ${data.checkpoint.finishedAt || '-'}`
      ];
      for (const line of lines) {
        const div = document.createElement('div');
        setText(div, line);
        container.append(div);
      }
      if (data.artifacts.length > 0) {
        const row = document.createElement('div');
        row.append(document.createTextNode('产物：'));
        for (const artifact of data.artifacts) {
          row.append(button(`下载 ${artifact.stepId}`, async () => {
            try { await downloadArtifact(artifact.artifactId, `${runId}-${artifact.stepId}.json`); }
            catch (error) { alert(error.message); }
          }));
        }
        container.append(row);
      }
      if (data.reservations.length > 0) {
        const div = document.createElement('div');
        setText(div, `预留：${data.reservations.map((reservation) => `${reservation.status}(${reservation.holdMicros}µ)`).join(', ')}`);
        container.append(div);
      }
      const eventBox = document.createElement('div');
      setText(eventBox, `事件：${data.events.map((event) => event.eventType).join(' → ')}`);
      container.append(eventBox);
      const journalBox = document.createElement('div');
      setText(journalBox, `journal：${data.journal.map((entry) => entry.event).join(' → ') || '(空)'}`);
      container.append(journalBox);
    } catch (error) {
      show($('run-detail'), error.message, 'err');
    }
  }

  async function createRun() {
    try {
      const projectId = requireProject();
      const text = $('run-input').value.trim();
      if (!text) return alert('请输入 fixture 输入文本。');
      const data = await api(`/projects/${encodeURIComponent(projectId)}/runs`, { method: 'POST', body: { task: $('run-task').value, input: { text } } });
      alert(`run ${data.runId} · ${data.status}`);
      await refreshRuns();
      await showRunDetail(data.runId);
    } catch (error) {
      alert(error.message);
    }
  }

  async function refreshMemory() {
    try {
      const projectId = requireProject();
      const params = new URLSearchParams();
      const scope = $('memory-scope').value;
      const scopeKey = $('memory-scope-key').value.trim();
      if (scope) params.set('scope', scope);
      if (scopeKey) params.set('scopeKey', scopeKey);
      const data = await api(`/projects/${encodeURIComponent(projectId)}/memory?${params.toString()}`);
      const container = $('memory-list');
      clear(container);
      const table = document.createElement('table');
      table.className = 'tc-table';
      const head = document.createElement('tr');
      for (const label of ['scope', 'scopeKey', 'ruleKey', '值', '状态', '版本', '操作']) {
        const th = document.createElement('th');
        setText(th, label);
        head.append(th);
      }
      table.append(head);
      for (const rule of data.rules) {
        const row = document.createElement('tr');
        cell(row, rule.scope);
        cell(row, rule.scopeKey);
        cell(row, rule.ruleKey);
        cell(row, JSON.stringify(rule.value));
        cell(row, rule.status);
        cell(row, rule.version);
        const actions = actionsCell(row);
        if (rule.status === 'candidate') {
          actions.append(button('确认', async () => {
            try {
              await api(`/projects/${encodeURIComponent(requireProject())}/memory/${rule.id}/confirm`, { method: 'POST', body: {} });
              await refreshMemory();
            } catch (error) { alert(error.message); }
          }));
        }
        actions.append(button('纠错', async () => {
          const raw = prompt('新的规则值 JSON', JSON.stringify(rule.value));
          if (raw === null) return;
          let value;
          try { value = JSON.parse(raw); } catch { return alert('值必须是合法 JSON'); }
          try {
            await api(`/projects/${encodeURIComponent(requireProject())}/memory/${rule.id}/correct`, { method: 'POST', body: { value } });
            await refreshMemory();
          } catch (error) { alert(error.message); }
        }));
        actions.append(button('链', async () => {
          try {
            const chain = await api(`/projects/${encodeURIComponent(requireProject())}/memory/${rule.id}/chain`);
            show($('memory-chain'), `修订链：${chain.chain.map((item) => `v${item.version}:${item.status}`).join(' → ')}`, 'ok');
          } catch (error) { alert(error.message); }
        }));
        table.append(row);
      }
      container.append(table);
    } catch (error) {
      show($('memory-list'), error.message, 'err');
    }
  }

  async function createMemoryCandidate() {
    try {
      const projectId = requireProject();
      let value;
      try { value = JSON.parse($('memory-value').value || '{}'); } catch { return alert('值必须是合法 JSON'); }
      const rule = await api(`/projects/${encodeURIComponent(projectId)}/memory/candidates`, {
        method: 'POST',
        body: {
          scope: $('memory-scope').value,
          scopeKey: $('memory-scope-key').value.trim(),
          ruleKey: $('memory-rule-key').value.trim(),
          value,
          source: 'task-center'
        }
      });
      show($('memory-chain'), `candidate 已创建：${rule.rule.id}（v${rule.rule.version}）`, 'ok');
      await refreshMemory();
    } catch (error) {
      alert(error.message);
    }
  }

  async function refreshAssets() {
    try {
      const projectId = requireProject();
      const params = new URLSearchParams();
      const familyKey = $('assets-family').value.trim();
      const role = $('assets-role').value.trim();
      if (familyKey) params.set('familyKey', familyKey);
      if (role) params.set('role', role);
      const data = await api(`/projects/${encodeURIComponent(projectId)}/assets?${params.toString()}`);
      const container = $('assets-list');
      clear(container);
      if (!data.configured) { show(container, data.note || '未配置素材索引。'); return; }
      const note = document.createElement('div');
      setText(note, `索引 ${data.sourceRootId} · 匹配 ${data.total} 个文件 · ${data.note}`);
      container.append(note);
      const table = document.createElement('table');
      table.className = 'tc-table';
      const head = document.createElement('tr');
      for (const label of ['文件', 'family', '角色', '语言', 'SKU 候选', '设计集', '比例', '昵称 / 别名', 'sha256', '操作']) {
        const th = document.createElement('th');
        setText(th, label);
        head.append(th);
      }
      table.append(head);
      for (const file of data.files) {
        const row = document.createElement('tr');
        cell(row, file.relPath);
        cell(row, file.familyKey || '');
        cell(row, `${file.role || ''}${file.roleStatus ? ` (${file.roleStatus})` : ''}`);
        cell(row, file.language || '');
        cell(row, (file.skuCandidates || []).join(', ') || '待确认');
        cell(row, file.designSetId || 'unknown');
        cell(row, file.ratio === null || file.ratio === undefined ? '' : file.ratio);
        cell(row, [file.nickname, ...(Array.isArray(file.aliases) ? file.aliases : [])].filter(Boolean).join(' / '));
        cell(row, file.sha256 ? `${file.sha256.slice(0, 12)}…` : '');
        const actions = actionsCell(row);
        actions.append(button('预览', async () => {
          try { await previewArtifact(file.artifactId, file.relPath.split('/').pop()); }
          catch (error) { alert(error.message); }
        }));
        actions.append(button('下载', async () => {
          try { await downloadArtifact(file.artifactId, file.relPath.split('/').pop()); }
          catch (error) { alert(error.message); }
        }));
        actions.append(button('设为 MAIN', async () => {
          try {
            await api(`/projects/${encodeURIComponent(requireProject())}/assets/${file.artifactId}/preference`, { method: 'POST', body: { purpose: 'MAIN' } });
            await refreshPreferences();
          } catch (error) { alert(error.message); }
        }));
        actions.append(button('设为参考图', async () => {
          try {
            await api(`/projects/${encodeURIComponent(requireProject())}/assets/${file.artifactId}/preference`, { method: 'POST', body: { purpose: 'reference' } });
            await refreshPreferences();
          } catch (error) { alert(error.message); }
        }));
        table.append(row);
      }
      container.append(table);
    } catch (error) {
      show($('assets-list'), error.message, 'err');
    }
  }

  async function refreshPreferences() {
    try {
      const projectId = requireProject();
      const data = await api(`/projects/${encodeURIComponent(projectId)}/assets/preferences`);
      const entries = Object.entries(data.preferences || {});
      const container = $('assets-pref-box');
      clear(container);
      if (entries.length === 0) { show(container, '本项目的有效版本偏好为空（unknown 保持 unknown）。'); return; }
      for (const [artifactId, preference] of entries) {
        const div = document.createElement('div');
        setText(div, `${preference.purpose} · ${preference.relPath} · sha ${String(preference.sha256).slice(0, 12)}… · ${preference.updatedAt}`);
        container.append(div);
      }
    } catch (error) {
      show($('assets-pref-box'), error.message, 'err');
    }
  }

  function switchTab(panelId) {
    for (const tab of document.querySelectorAll('.tc-tab')) {
      const active = tab.getAttribute('data-panel') === panelId;
      tab.classList.toggle('is-active', active);
    }
    for (const panel of document.querySelectorAll('.tc-panel')) {
      panel.hidden = panel.id !== `panel-${panelId}`;
    }
  }

  function init() {
    $('session-token').value = state.token;
    $('project-id').value = state.projectId;
    $('session-save').addEventListener('click', () => {
      state.token = $('session-token').value.trim();
      localStorage.setItem('tasks.sessionToken', state.token);
      refreshSession();
    });
    $('project-save').addEventListener('click', () => {
      state.projectId = $('project-id').value.trim();
      localStorage.setItem('tasks.projectId', state.projectId);
      setText($('project-state'), state.projectId ? `当前项目：${state.projectId}` : '未选择项目');
    });
    for (const tab of document.querySelectorAll('.tc-tab')) {
      tab.addEventListener('click', () => switchTab(tab.getAttribute('data-panel')));
    }
    $('upload-send').addEventListener('click', uploadSelected);
    $('run-create').addEventListener('click', createRun);
    $('runs-refresh').addEventListener('click', refreshRuns);
    $('budget-refresh').addEventListener('click', refreshBudget);
    $('memory-create').addEventListener('click', createMemoryCandidate);
    $('memory-refresh').addEventListener('click', refreshMemory);
    $('assets-refresh').addEventListener('click', refreshAssets);
    $('assets-prefs').addEventListener('click', refreshPreferences);
    setText($('project-state'), state.projectId ? `当前项目：${state.projectId}` : '未选择项目');
    refreshSession();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
