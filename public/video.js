(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const tools = window.VIDEO_TOOLS;
  const DRAFT_KEY = 'sourcing-workbench.video-draft.v1';
  const textFields = ['product', 'category', 'market', 'facts', 'prohibited', 'duration', 'aspect', 'note-rhythm', 'note-copy', 'note-flow', 'note-atmosphere', 'transcript'];
  const state = { route: 'replace', assets: [], reference: null, referenceSource: null, candidates: [], shots: [], cuts: [], plan: null, scanToken: 0, revision: 0, busy: false };
  function node(tag, value, cls) { const item = document.createElement(tag); if (value !== undefined) item.textContent = value; if (cls) item.className = cls; return item; }
  function message(value, error = false) { $('video-status').textContent = value; $('video-status').classList.toggle('error', error); }
  function invalidate() { state.revision += 1; state.plan = null; $('video-plan-result').hidden = true; }
  function resetRights() { $('video-rights').checked = false; $('video-avatar-consent').checked = false; }
  function route(value) {
    state.route = value === 'remix' ? 'remix' : 'replace';
    document.querySelectorAll('[data-route]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.route === state.route)));
  }
  function assetIndex(asset) { return `asset-${state.assets.indexOf(asset) + 1}`; }

  function formatCount(value) {
    const amount = Number(value) || 0;
    if (amount >= 100000000) return `${(amount / 100000000).toFixed(1)}亿`;
    if (amount >= 10000) return `${(amount / 10000).toFixed(1)}万`;
    return String(amount);
  }

  function renderCandidates(result) {
    state.candidates = result?.candidates || [];
    const box = $('video-candidate-list'); box.replaceChildren();
    if (!state.candidates.length) { $('video-candidate-status').textContent = result?.errors?.length ? result.errors.map((item) => item.message).join('；') : '没有有效候选。'; return; }
    $('video-candidate-status').textContent = `已在 ${state.candidates.length} 条用户输入候选中排序；第 1 名不等于全平台最高播放量。`;
    state.candidates.forEach((candidate) => {
      const card = node('article', undefined, `video-candidate${state.referenceSource?.url === candidate.url ? ' is-selected' : ''}`);
      const head = node('div', undefined, 'video-candidate-head'); head.append(node('strong', `#${candidate.rank}`), node('span', `${formatCount(candidate.plays)} 播放`)); card.append(head);
      card.append(node('span', candidate.title || '未填写标题'), node('small', `${candidate.creator || '作者未记录'} · ${candidate.duration ? `${candidate.duration}s` : '时长未记录'} · 点赞 ${formatCount(candidate.likes)}`));
      const link = node('a', candidate.url); link.href = candidate.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; card.append(link);
      const select = node('button', state.referenceSource?.url === candidate.url ? '已选为参考' : '选为参考', 'quiet-button small'); select.type = 'button'; select.addEventListener('click', () => {
        state.referenceSource = candidate; $('video-reference-source').value = candidate.url; renderCandidates(result); invalidate(); message('已记录参考来源；仍需上传有权使用的本地参考视频。');
      }); card.append(select); box.append(card);
    });
  }

  $('video-rank-candidates').addEventListener('click', async () => {
    const raw = $('video-candidates').value.trim();
    if (!raw) { $('video-candidate-status').textContent = '请先粘贴候选 JSON。'; return; }
    let candidates;
    try {
      const parsed = JSON.parse(raw);
      candidates = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      candidates = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
    }
    candidates = candidates.map((candidate) => ({ ...candidate, platform: candidate.platform || $('video-platform').value }));
    const button = $('video-rank-candidates'); button.disabled = true; $('video-candidate-status').textContent = '正在校验候选链接和播放量…';
    try {
      const response = await fetch('/api/video/rank-candidates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ candidates }) });
      const body = await response.json(); if (!response.ok) throw new Error(body?.error?.message || `HTTP ${response.status}`); renderCandidates(body.data);
    } catch (error) { $('video-candidate-status').textContent = error.message || '候选排序失败。'; }
    finally { button.disabled = false; }
  });
  function checkedFile(file, role) {
    const image = ['image/png', 'image/jpeg', 'image/webp'].includes(file.type);
    const video = ['video/mp4', 'video/webm', 'video/quicktime'].includes(file.type);
    if ((!image && !video) || (['product', 'avatar'].includes(role) && !image) || (role === 'reference' && !video)) throw new Error('素材格式不支持。图片须为 PNG/JPEG/WebP，视频须为 MP4/WebM/MOV（具体编码由浏览器决定能否播放）。');
    if (file.size === 0 || file.size > 250 * 1024 * 1024) throw new Error('文件为空或超过 250MB。');
    if ([...state.assets, state.reference].filter(Boolean).some((a) => a.file.name === file.name)) throw new Error(`文件名重复：${file.name}。请先移除或重命名。`);
  }
  function renderAssets() {
    const containers = { product: 'video-product-list', avatar: 'video-avatar-list', material: 'video-material-list' };
    for (const [roleName, containerId] of Object.entries(containers)) {
      const box = $(containerId); box.replaceChildren();
      for (const asset of state.assets.filter((a) => a.role === roleName)) {
        const card = node('div', undefined, 'video-asset');
        if (asset.file.type.startsWith('image/')) { const img = node('img'); img.src = asset.url; img.alt = asset.file.name; card.append(img); }
        else card.append(node('p', '▹ 视频素材'));
        card.append(node('small', asset.file.name));
        const remove = node('button', '×'); remove.type = 'button'; remove.setAttribute('aria-label', `移除 ${asset.file.name}`);
        remove.addEventListener('click', () => {
          URL.revokeObjectURL(asset.url); state.assets = state.assets.filter((a) => a !== asset);
          state.shots.forEach((shot) => { if (shot.assetId === asset.id) shot.assetId = ''; });
          invalidate(); resetRights(); renderAssets(); renderShots(); message('素材已移除，绑定该素材的分镜需重新选择，并重新确认权利。');
        });
        card.append(remove); box.append(card);
      }
    }
  }
  function renderShots() {
    const box = $('video-shots'); box.replaceChildren();
    if (!state.shots.length) { box.append(node('p', '还没有分镜。填入待编辑模板，或添加镜头。')); return; }
    state.shots.forEach((shot, index) => {
      const card = node('article', undefined, 'video-shot');
      const head = node('div', undefined, 'video-shot-head'); head.append(node('b', `镜头 ${String(index + 1).padStart(2, '0')}`));
      const remove = node('button', '移除', 'quiet-button small'); remove.type = 'button'; remove.addEventListener('click', () => { state.shots.splice(index, 1); invalidate(); renderShots(); }); head.append(remove); card.append(head);
      const times = node('div', undefined, 'video-shot-times');
      for (const [key, label] of [['start', '起点 / 秒'], ['end', '终点 / 秒']]) {
        const field = node('label', label); const input = node('input'); input.type = 'number'; input.min = '0'; input.step = '.1'; input.value = shot[key]; input.setAttribute('aria-label', `镜头 ${index + 1} ${label}`);
        input.addEventListener('input', () => { shot[key] = input.value === '' ? '' : Number(input.value); invalidate(); }); field.append(input); times.append(field);
      }
      card.append(times);
      const fields = node('div', undefined, 'video-shot-fields');
      for (const [key, label] of [['action', '画面与真实动作'], ['copy', '新文案 / 口播草稿'], ['edit', '切点 / 转场 / 氛围']]) {
        const field = node('label', label); const input = node('textarea'); input.maxLength = key === 'edit' ? 600 : 1000; input.value = shot[key] || ''; input.setAttribute('aria-label', `镜头 ${index + 1} ${label}`); input.addEventListener('input', () => { shot[key] = input.value; invalidate(); }); field.append(input); fields.append(field);
      }
      const source = node('label', '绑定创作素材'); const select = node('select'); select.setAttribute('aria-label', `镜头 ${index + 1} 素材`);
      const empty = node('option', '请选择（不默认使用参考原片）'); empty.value = ''; select.append(empty);
      for (const asset of state.assets) { const option = node('option', `${asset.role} · ${asset.file.name}`); option.value = asset.id; select.append(option); }
      select.value = shot.assetId || ''; select.addEventListener('change', () => { shot.assetId = select.value; invalidate(); }); source.append(select); fields.append(source); card.append(fields); box.append(card);
    });
  }
  for (const [id, roleName] of [['video-products', 'product'], ['video-avatars', 'avatar'], ['video-materials', 'material']]) {
    $(id).addEventListener('change', (event) => {
      for (const file of event.target.files) {
        try {
          if (state.assets.length >= 24) throw new Error('最多 24 个创作素材。');
          checkedFile(file, roleName);
          state.assets.push({ id: crypto.randomUUID(), role: roleName, file, url: URL.createObjectURL(file) });
          message('素材仅在当前浏览器内预览，没有上传。');
        } catch (error) { message(error.message, true); }
      }
      invalidate(); resetRights(); renderAssets(); renderShots(); event.target.value = '';
    });
  }
  function showCuts() {
    const duration = $('video-player').duration;
    state.cuts = tools.normalizeCuts(state.cuts, duration);
    $('video-cut-list').textContent = state.cuts.length ? `参考切点候选：${state.cuts.map((n) => `${n}s`).join(' / ')}（需人工确认，尚未迁移到目标时间线）` : '尚无切点记录。';
  }
  function stopScan() { state.scanToken += 1; $('video-scan').disabled = !$('video-player').duration; $('video-cancel-scan').hidden = true; }
  $('video-reference').addEventListener('change', (event) => {
    const file = event.target.files[0]; event.target.value = ''; if (!file) return;
    try {
      const previous = state.reference;
      // Temporarily exclude the old reference from duplicate-name validation when replacing it.
      state.reference = null;
      try { checkedFile(file, 'reference'); } catch (error) { state.reference = previous; throw error; }
      stopScan(); if (previous) URL.revokeObjectURL(previous.url);
      state.reference = { role: 'reference', file, url: URL.createObjectURL(file) };
      state.cuts = []; showCuts(); invalidate(); resetRights();
      const player = $('video-player'); player.src = state.reference.url; player.hidden = false; $('video-stage-empty').hidden = true;
      $('video-mark-cut').disabled = true; $('video-scan').disabled = true;
      $('video-reference-meta').textContent = `${file.name} · 本地加载中`;
      $('video-scan-status').textContent = '更换参考后，请复核原有四维笔记和分镜，旧笔记不会被自动当成新参考结论。';
      message('参考视频已选择；未上传、未转录、未做模型分析。');
    } catch (error) { message(error.message, true); }
  });
  $('video-player').addEventListener('loadedmetadata', () => {
    const p = $('video-player');
    const valid = Number.isFinite(p.duration) && p.duration > 0;
    $('video-mark-cut').disabled = !valid; $('video-scan').disabled = !valid;
    $('video-reference-meta').textContent = `${state.reference?.file.name || ''} · ${valid ? `${p.duration.toFixed(1)}s` : '时长无法识别'} · ${p.videoWidth} × ${p.videoHeight} · 参考原片预览`;
  });
  $('video-player').addEventListener('error', () => { $('video-mark-cut').disabled = true; $('video-scan').disabled = true; message('浏览器无法解码此视频，请转为 H.264 MP4 或更换文件。', true); });
  $('video-reference-source').addEventListener('input', () => { state.referenceSource = $('video-reference-source').value.trim() ? { url: $('video-reference-source').value.trim(), platform: $('video-platform').value, selectionBasis: 'user_supplied_reference' } : null; invalidate(); });
  $('video-mark-cut').addEventListener('click', () => { state.cuts.push($('video-player').currentTime); showCuts(); invalidate(); });
  function seek(video, time) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('视频解码超时')), 8000);
      const done = () => finish(); const failed = () => finish(new Error('无法解码视频'));
      function finish(error) { clearTimeout(timer); video.removeEventListener('seeked', done); video.removeEventListener('error', failed); error ? reject(error) : resolve(); }
      video.addEventListener('seeked', done, { once: true }); video.addEventListener('error', failed, { once: true }); video.currentTime = time;
    });
  }
  $('video-cancel-scan').addEventListener('click', () => { stopScan(); $('video-scan-status').textContent = '扫描已停止。'; });
  $('video-scan').addEventListener('click', async () => {
    if (!state.reference) return;
    const token = ++state.scanToken;
    $('video-scan').disabled = true; $('video-cancel-scan').hidden = false;
    const scanVideo = document.createElement('video'); scanVideo.muted = true; scanVideo.preload = 'auto'; scanVideo.src = state.reference.url;
    const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 36; const context = canvas.getContext('2d', { willReadFrequently: true });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('参考视频读取超时')), 8000);
        scanVideo.onloadeddata = () => { clearTimeout(timer); resolve(); };
        scanVideo.onerror = () => { clearTimeout(timer); reject(new Error('无法读取参考视频')); };
      });
      const end = Math.min(scanVideo.duration - .05, 60); let previous = null; let lastCut = -1; const candidates = [];
      for (let time = .05; time < end; time += .5) {
        if (token !== state.scanToken) return;
        await seek(scanVideo, time);
        if (token !== state.scanToken) return;
        context.drawImage(scanVideo, 0, 0, 64, 36); const pixels = context.getImageData(0, 0, 64, 36).data;
        if (previous && tools.frameDifference(previous, pixels) > .19 && time - lastCut >= 1) { candidates.push(time); lastCut = time; }
        previous = pixels;
        $('video-scan-status').textContent = `本地画面变化扫描 ${time.toFixed(1)} / ${end.toFixed(1)}s；不分析音频/语义。`;
      }
      if (token !== state.scanToken) return;
      state.cuts = tools.normalizeCuts([...state.cuts, ...candidates], scanVideo.duration); showCuts(); invalidate();
      $('video-scan-status').textContent = `扫描完成：前 ${Math.min(60, scanVideo.duration).toFixed(1)} 秒、约 0.5 秒采样，发现 ${candidates.length} 个画面变化候选。镜头运动/闪光可能误报，无法检测所有切点；请人工核验。`;
    } catch (error) { if (token === state.scanToken) $('video-scan-status').textContent = `扫描失败：${error.message}。可继续手动标记。`; }
    finally {
      scanVideo.pause(); scanVideo.removeAttribute('src'); scanVideo.load();
      if (token === state.scanToken) { $('video-scan').disabled = false; $('video-cancel-scan').hidden = true; }
    }
  });
  document.querySelectorAll('[data-route]').forEach((button) => button.addEventListener('click', () => { route(button.dataset.route); invalidate(); resetRights(); message('制作路线已切换；请复核分镜动作并重新确认使用权，旧分镜不会被自动改写。'); }));
  $('video-template').addEventListener('click', () => {
    const duration = Number($('video-duration').value);
    if (duration < 3 || duration > 180 || !Number.isFinite(duration)) return message('先设置 3–180 秒目标时长。', true);
    if (state.shots.length && !window.confirm('用待编辑模板替换当前分镜？已有分镜修改将丢失。')) return;
    state.shots = tools.templateShots(duration, state.assets.find((a) => a.role === 'product')?.id, state.route); invalidate(); renderShots(); message('已填入四镜头模板。这不是参考视频自动拆解，请逐镜编辑并绑定素材。');
  });
  $('video-add-shot').addEventListener('click', () => {
    if (state.shots.length >= 30) return message('最多 30 个分镜。', true);
    const start = Number(state.shots.at(-1)?.end || 0);
    state.shots.push({ start, end: Math.round((start + 3) * 10) / 10, action: '', copy: '', edit: '', assetId: '' }); invalidate(); renderShots();
  });
  textFields.forEach((key) => $(`video-${key}`).addEventListener('input', invalidate));
  ['video-rights', 'video-avatar-consent'].forEach((key) => $(key).addEventListener('change', invalidate));
  function payload() {
    const assets = [...state.assets, state.reference].filter(Boolean).map((a) => ({ name: a.file.name, role: a.role, type: a.file.type, size: a.file.size }));
    return {
      route: state.route, product: $('video-product').value, category: $('video-category').value, market: $('video-market').value,
      facts: $('video-facts').value, prohibited: $('video-prohibited').value, duration: Number($('video-duration').value), aspectRatio: $('video-aspect').value,
      rightsConfirmed: $('video-rights').checked, avatarConsent: $('video-avatar-consent').checked,
      referenceSource: state.referenceSource || ($('video-reference-source').value.trim() ? { url: $('video-reference-source').value.trim(), platform: $('video-platform').value } : null),
      referenceTranscript: $('video-transcript').value,
      referenceNotes: Object.fromEntries(['rhythm', 'copy', 'flow', 'atmosphere'].map((k) => [k, $(`video-note-${k}`).value])),
      referenceMeasurements: state.reference && Number.isFinite($('video-player').duration) && $('video-player').duration > 0 ? { duration: $('video-player').duration, cutCandidates: state.cuts } : null,
      assets, shots: state.shots.map((shot) => ({ ...shot, assetId: state.assets.find((a) => a.id === shot.assetId) ? assetIndex(state.assets.find((a) => a.id === shot.assetId)) : '' }))
    };
  }
  $('video-plan').addEventListener('click', async () => {
    if (state.busy) return;
    const revision = state.revision; state.busy = true; $('video-plan').disabled = true;
    message('正在校验本地简报；不上传媒体文件、不运行生成。');
    try {
      const response = await fetch('/api/video/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload()) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message || '交接包生成失败');
      if (revision !== state.revision) { message('校验期间输入已变化，请重新生成交接包。'); return; }
      state.plan = result.data;
      $('video-plan-summary').textContent = `${state.plan.product} · ${state.plan.duration}s · ${state.plan.aspectRatio}\n${state.plan.shots.length} 个分镜 / ${state.plan.assets.length} 个素材引用\n\n${state.plan.blockers.join('\n\n')}`;
      $('video-plan-result').hidden = false;
      message('已生成 Hypit 交接简报与任务元数据。视频未生成，原始素材需自行放入交接目录的 assets/。');
    } catch (error) { message(error.message, true); }
    finally { state.busy = false; $('video-plan').disabled = false; }
  });
  function download(value, name, type) { const url = URL.createObjectURL(new Blob([value], { type })); const a = node('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  $('video-download-json').addEventListener('click', () => { if (state.plan) download(JSON.stringify(state.plan, null, 2), 'hypit-task.json', 'application/json'); });
  $('video-download-brief').addEventListener('click', () => { if (state.plan) download(state.plan.agentBrief, 'hypit-brief.md', 'text/markdown;charset=utf-8'); });
  $('video-save').addEventListener('click', () => {
    // Never persist files, blob URLs, rights attestations or the generated package.
    const draft = { schemaVersion: 1, route: state.route, fields: Object.fromEntries(textFields.map((key) => [key, $(`video-${key}`).value])), referenceSource: state.referenceSource ? { platform: state.referenceSource.platform, url: state.referenceSource.url, title: state.referenceSource.title || '', creator: state.referenceSource.creator || '', plays: state.referenceSource.plays || null, likes: state.referenceSource.likes || null, selectionBasis: state.referenceSource.selectionBasis || 'user_supplied_reference' } : null, shots: state.shots.map((shot) => ({ ...shot, assetId: '' })) };
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); message('文字与分镜草稿已保存在本浏览器；素材/授权勾选不保存，重开后需重新选择。'); }
    catch { message('浏览器本地存储不可用，未保存。', true); }
  });
  $('video-clear').addEventListener('click', () => {
    if (!window.confirm('清除已保存的本地文字草稿？当前编辑内容与素材选择仍保留。')) return;
    try { localStorage.removeItem(DRAFT_KEY); message('已清除持久草稿。当前页面编辑内容保留，刷新后不会恢复。'); } catch { message('无法清除本地草稿。', true); }
  });
  try {
    const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
    if (draft?.schemaVersion === 1) {
      for (const key of textFields) if (typeof draft.fields?.[key] === 'string') $(`video-${key}`).value = draft.fields[key].slice(0, 4000);
      route(draft.route);
      if (Array.isArray(draft.shots)) state.shots = draft.shots.slice(0, 30).filter((s) => s && typeof s === 'object').map((s) => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, action: String(s.action || '').slice(0, 1000), copy: String(s.copy || '').slice(0, 1000), edit: String(s.edit || '').slice(0, 600), assetId: '' }));
      if (draft.referenceSource?.url) { state.referenceSource = draft.referenceSource; $('video-reference-source').value = draft.referenceSource.url; }
      message('已恢复文字草稿；素材需重新选择、分镜需重新绑定，权利需重新确认。');
    }
    const theme = localStorage.getItem('ecommerce-content-assistant-theme'); document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
  } catch { /* Storage is optional and untrusted. */ }
  const params = new URLSearchParams(location.search);
  for (const [param, key] of [['project', 'product'], ['category', 'category'], ['market', 'market']]) if (params.has(param)) $(`video-${key}`).value = params.get(param).slice(0, 100);
  renderShots();
  fetch('/api/video/capabilities').then((r) => { if (!r.ok) throw new Error(); return r.json(); }).then(({ data }) => { $('video-engine-status').textContent = data.mode === 'handoff_only' ? 'Hypit · 交接模式 / 未连接生成' : 'Hypit · 能力状态待核验'; }).catch(() => { $('video-engine-status').textContent = '服务未连接 · 可编辑本地草稿'; });
  window.addEventListener('beforeunload', () => { stopScan(); for (const asset of [...state.assets, state.reference].filter(Boolean)) URL.revokeObjectURL(asset.url); });
})();
