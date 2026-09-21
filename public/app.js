(() => {
  'use strict';

  const PLATFORM_LABELS = Object.freeze({
    Xiaohongshu: '小红书',
    Douyin: '抖音',
    Tmall: '天猫',
    Pinduoduo: '拼多多'
  });
  const PLATFORM_CODES = Object.freeze({
    Xiaohongshu: 'XIAOHONGSHU',
    Douyin: 'DOUYIN',
    Tmall: 'TMALL',
    Pinduoduo: 'PINDUODUO'
  });
  const HISTORY_KEY = 'ecommerce-content-assistant-history-v2';
  const LEGACY_HISTORY_KEY = 'ecommerce-content-demo-history-v1';
  const THEME_KEY = 'ecommerce-content-assistant-theme';
  const ALLOWED_IMAGE_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp']);
  const MAX_IMAGES = 4;
  const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

  const form = document.querySelector('#generator-form');
  const status = document.querySelector('#status');
  const submitButton = document.querySelector('#submit-button');
  const reviewSection = document.querySelector('#review-section');
  const reviewContent = document.querySelector('#review-content');
  const reviewEmpty = document.querySelector('#review-empty');
  const resultSection = document.querySelector('#result-section');
  const results = document.querySelector('#results');
  const draftSummary = document.querySelector('#draft-summary');
  const copyAll = document.querySelector('#copy-all');
  const saveEdits = document.querySelector('#save-edits');
  const downloadMarkdown = document.querySelector('#download-markdown');
  const downloadJson = document.querySelector('#download-json');
  const historySection = document.querySelector('#history-section');
  const historyList = document.querySelector('#history-list');
  const clearHistory = document.querySelector('#clear-history');
  const imageInput = document.querySelector('#image-input');
  const imagePreview = document.querySelector('#image-preview');
  const dropzone = document.querySelector('#dropzone');
  const themeToggle = document.querySelector('#theme-toggle');
  const healthChip = document.querySelector('#health-chip');
  const healthText = document.querySelector('#health-text');
  const stepper = document.querySelector('#stepper');

  let images = [];
  let currentDrafts = [];
  let currentReview = null;
  let currentSessionId = null;
  let currentSessionCreatedAt = null;
  let currentImageCount = 0;

  function platformLabel(platform) {
    return PLATFORM_LABELS[platform] || platform || '未知平台';
  }

  function platformCode(platform) {
    return PLATFORM_CODES[platform] || 'PLATFORM';
  }

  function platformDotClass(platform) {
    return `dot-${String(platform || 'unknown').toLowerCase()}`;
  }

  function createId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function setStatus(message, isError = false) {
    status.textContent = message;
    status.classList.toggle('error', isError);
  }

  function setStep(active) {
    for (const step of stepper.querySelectorAll('.step')) {
      const value = Number(step.dataset.step);
      step.classList.toggle('is-active', value === active);
      step.classList.toggle('is-done', value < active);
    }
  }

  function appendText(element, text) {
    element.textContent = typeof text === 'string' ? text : '';
  }

  function linesToList(value) {
    return String(value || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function parseSpecifications(value) {
    const specifications = [];
    for (const line of linesToList(value)) {
      const separator = line.search(/[:：]/);
      if (separator <= 0) continue;
      const name = line.slice(0, separator).trim().slice(0, 40);
      const specValue = line.slice(separator + 1).trim().slice(0, 120);
      if (!name || !specValue) continue;
      specifications.push({ name, value: specValue });
      if (specifications.length >= 20) break;
    }
    return specifications;
  }

  function formatTime(value) {
    const time = typeof value === 'string' ? new Date(value) : null;
    return time && !Number.isNaN(time.valueOf()) ? time.toLocaleString() : '未知时间';
  }

  function collectPayload() {
    return {
      productName: form.productName.value.trim(),
      productDescription: form.productDescription.value.trim(),
      category: form.category.value.trim(),
      brand: form.brand.value.trim(),
      targetAudience: form.targetAudience.value.trim(),
      priceInfo: form.priceInfo.value.trim(),
      promotionInfo: form.promotionInfo.value.trim(),
      afterSales: form.afterSales.value.trim(),
      tone: form.tone.value.trim(),
      sellingPoints: linesToList(form.sellingPoints.value),
      specifications: parseSpecifications(form.specifications.value),
      platforms: [...form.querySelectorAll('input[name="platform"]:checked')].map((item) => item.value),
      images: images.map((image) => ({ name: image.name, mimeType: image.mimeType, dataBase64: image.dataBase64 }))
    };
  }

  function setPlatforms(platforms) {
    const selected = new Set(Array.isArray(platforms) ? platforms : []);
    for (const checkbox of form.querySelectorAll('input[name="platform"]')) {
      checkbox.checked = selected.has(checkbox.value);
    }
    syncPlatformCards();
  }

  function syncPlatformCards() {
    for (const card of document.querySelectorAll('.platform-card')) {
      const input = card.querySelector('input[name="platform"]');
      card.classList.toggle('is-checked', Boolean(input && input.checked));
    }
  }

  /* ---------- Theme ---------- */

  function applyTheme(theme) {
    const next = theme === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    themeToggle.setAttribute('aria-label', next === 'dark' ? '切换到明亮主题' : '切换到暗色主题');
  }

  function initTheme() {
    let saved = null;
    try {
      saved = localStorage.getItem(THEME_KEY);
    } catch {
      saved = null;
    }
    applyTheme(saved || 'dark');
    themeToggle.addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch {
        // Theme preference is optional.
      }
    });
  }

  /* ---------- Health ---------- */

  async function loadHealth() {
    try {
      const response = await fetch('/api/health');
      const health = await response.json();
      healthChip.classList.remove('is-ok', 'is-warn');
      if (health && health.configured) {
        const vision = health.visionConfigured ? ' · 视觉模型已配置' : '';
        healthChip.classList.add('is-ok');
        healthText.textContent = `模型已连接 · ${health.model}${vision}`;
      } else {
        healthChip.classList.add('is-warn');
        healthText.textContent = '未配置 API Key';
      }
    } catch {
      healthText.textContent = '本地服务状态未知';
    }
  }

  /* ---------- History ---------- */

  function readHistory() {
    try {
      const saved = JSON.parse(localStorage.getItem(HISTORY_KEY) || 'null');
      if (Array.isArray(saved)) return saved.slice(0, 10);
    } catch {
      // Fall through to legacy migration.
    }
    const migrated = migrateLegacyHistory();
    if (migrated.length) {
      writeHistory(migrated);
      return migrated;
    }
    return [];
  }

  function migrateLegacyHistory() {
    try {
      const legacy = JSON.parse(localStorage.getItem(LEGACY_HISTORY_KEY) || '[]');
      if (!Array.isArray(legacy)) return [];
      return legacy.slice(0, 10).map((entry, index) => {
        const createdAt = typeof entry.createdAt === 'string' ? entry.createdAt : new Date().toISOString();
        return {
          id: `legacy-${index}-${Date.parse(createdAt) || Date.now()}`,
          createdAt,
          updatedAt: createdAt,
          productName: entry.productName || '未命名商品',
          payload: {
            productName: entry.productName || '',
            productDescription: entry.productDescription || '',
            tone: entry.tone || '',
            platforms: Array.isArray(entry.platforms) ? entry.platforms : []
          },
          drafts: Array.isArray(entry.drafts) ? entry.drafts : [],
          review: null,
          imageCount: 0,
          migrated: true
        };
      });
    } catch {
      return [];
    }
  }

  function writeHistory(entries) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, 10)));
    } catch {
      // Local history is optional; generation still succeeds when storage is unavailable.
    }
  }

  function upsertHistory(entry) {
    const remaining = readHistory().filter((item) => item.id !== entry.id);
    writeHistory([entry, ...remaining]);
  }

  function deleteHistory(id) {
    writeHistory(readHistory().filter((item) => item.id !== id));
  }

  /* ---------- Clipboard and files ---------- */

  async function copyText(text) {
    if (!text) throw new Error('没有可复制的内容。');
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const temporaryInput = document.createElement('textarea');
    temporaryInput.value = text;
    temporaryInput.setAttribute('readonly', '');
    temporaryInput.className = 'clipboard-fallback';
    document.body.append(temporaryInput);
    temporaryInput.select();
    const copied = document.execCommand('copy');
    temporaryInput.remove();
    if (!copied) throw new Error('剪贴板不可用。');
  }

  function downloadFile(fileName, text, mimeType) {
    const blob = new Blob([text], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function draftText(draft) {
    const parts = [platformLabel(draft.platform)];
    if (draft.title) parts.push(`标题：${draft.title}`);
    if (draft.sellingPoints && draft.sellingPoints.length) {
      parts.push('', '卖点：', ...draft.sellingPoints.map((point) => `- ${point}`));
    }
    if (draft.body) parts.push('', draft.body);
    if (draft.tags && draft.tags.length) parts.push('', `标签：${draft.tags.map((tag) => `#${tag}`).join(' ')}`);
    if (draft.reviewNotes && draft.reviewNotes.length) {
      parts.push('', '复核提示：', ...draft.reviewNotes.map((note) => `- ${note}`));
    }
    return parts.join('\n').trim();
  }

  function markdownFor(entry) {
    const payload = entry.payload || {};
    const drafts = Array.isArray(entry.drafts) ? entry.drafts : [];
    const review = entry.review || {};
    const lines = [`# ${payload.productName || '未命名商品'}：内容草稿`, ''];
    if (Array.isArray(payload.platforms) && payload.platforms.length) {
      lines.push(`- 平台：${payload.platforms.map(platformLabel).join('、')}`);
    }
    lines.push(`- 生成时间：${formatTime(entry.createdAt)}`);
    if (entry.updatedAt && entry.updatedAt !== entry.createdAt) lines.push(`- 最近编辑：${formatTime(entry.updatedAt)}`);
    if (entry.imageCount) lines.push(`- 使用图片：${entry.imageCount} 张（图片未保存到本地）`);
    lines.push('');
    for (const draft of drafts) {
      lines.push(`## ${platformLabel(draft.platform)}`, '');
      if (draft.title) lines.push(`**标题**：${draft.title}`, '');
      if (draft.sellingPoints && draft.sellingPoints.length) {
        lines.push('**核心卖点**', ...draft.sellingPoints.map((point) => `- ${point}`), '');
      }
      if (draft.body) lines.push('**正文**', '', draft.body, '');
      if (draft.tags && draft.tags.length) {
        lines.push(`**标签**：${draft.tags.map((tag) => `#${tag}`).join(' ')}`, '');
      }
      if (draft.reviewNotes && draft.reviewNotes.length) {
        lines.push('**模型复核提示**', ...draft.reviewNotes.map((note) => `- ${note}`), '');
      }
    }
    lines.push('## 复核与合规', '');
    if (review.missingInfo && review.missingInfo.length) {
      lines.push('### 缺失信息', ...review.missingInfo.map((item) => `- ${item}`), '');
    }
    if (review.riskWarnings && review.riskWarnings.length) {
      lines.push('### 风险提示', ...review.riskWarnings.map((warning) => `- [${warning.severity === 'high' ? '高' : '中'}] ${warning.term}：${warning.excerpt}（${warning.reason}）`), '');
    }
    if (review.factChecks && review.factChecks.length) {
      lines.push('### 数字核查', ...review.factChecks.map((check) => `- ${check.claim}：${check.note}`), '');
    }
    if (review.complianceReminders && review.complianceReminders.length) {
      lines.push('### 合规提醒', ...review.complianceReminders.map((item) => `- ${item}`), '');
    }
    lines.push('> 本文件由本地工具生成，仅为草稿，请人工核实事实、价格、资质与平台规则后使用。');
    return lines.join('\n');
  }

  function currentEntry() {
    const payload = collectPayload();
    delete payload.images;
    return {
      id: currentSessionId || createId(),
      createdAt: currentSessionCreatedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      productName: payload.productName,
      payload,
      drafts: collectEditedDrafts(),
      review: currentReview,
      imageCount: currentImageCount
    };
  }

  function collectEditedDrafts() {
    return [...results.querySelectorAll('.draft')].map((article, index) => {
      const base = currentDrafts[index] || {};
      return {
        platform: article.dataset.platform || base.platform || 'Unknown',
        title: article.querySelector('.draft-title').value.trim(),
        body: article.querySelector('.draft-body').value.trim(),
        tags: article.querySelector('.draft-tags').value
          .split(/[,，]/)
          .map((tag) => tag.trim().replace(/^#/, ''))
          .filter(Boolean)
          .slice(0, 12),
        sellingPoints: linesToList(article.querySelector('.draft-points').value).slice(0, 8),
        reviewNotes: Array.isArray(base.reviewNotes) ? base.reviewNotes : [],
        missingInfo: Array.isArray(base.missingInfo) ? base.missingInfo : []
      };
    });
  }

  /* ---------- Review rendering ---------- */

  function summaryChip(value, label, state = '') {
    const chip = document.createElement('span');
    chip.className = `summary-chip${state ? ` ${state}` : ''}`;
    const number = document.createElement('b');
    appendText(number, String(value));
    const text = document.createElement('span');
    appendText(text, label);
    chip.append(number, text);
    return chip;
  }

  function reviewBlock(title, items, renderItem) {
    const block = document.createElement('div');
    block.className = 'review-block';
    const heading = document.createElement('h3');
    appendText(heading, title);
    const badge = document.createElement('span');
    badge.className = 'count-badge';
    appendText(badge, String(items.length));
    heading.append(badge);
    block.append(heading);
    if (!items.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-inline';
      appendText(empty, '暂无。');
      block.append(empty);
      return block;
    }
    const list = document.createElement('ul');
    list.className = 'review-list';
    for (const item of items) {
      const entry = document.createElement('li');
      renderItem(entry, item);
      list.append(entry);
    }
    block.append(list);
    return block;
  }

  function renderReview(review) {
    reviewContent.replaceChildren();
    if (!review) {
      reviewEmpty.classList.remove('hidden');
      return;
    }
    reviewEmpty.classList.add('hidden');
    const missing = Array.isArray(review.missingInfo) ? review.missingInfo : [];
    const risks = Array.isArray(review.riskWarnings) ? review.riskWarnings : [];
    const facts = Array.isArray(review.factChecks) ? review.factChecks : [];
    const reminders = Array.isArray(review.complianceReminders) ? review.complianceReminders : [];

    const summary = document.createElement('div');
    summary.className = 'review-summary';
    summary.append(
      summaryChip(missing.length, '缺失', missing.length ? '' : 'is-ok'),
      summaryChip(risks.length, '风险', risks.length ? 'is-danger' : 'is-ok'),
      summaryChip(facts.length, '待核查', facts.length ? '' : 'is-ok')
    );
    reviewContent.append(summary);

    reviewContent.append(reviewBlock('缺失信息', missing, (entry, item) => {
      appendText(entry, item);
    }));
    reviewContent.append(reviewBlock('风险用语', risks, (entry, warning) => {
      const badge = document.createElement('span');
      badge.className = `severity ${warning.severity === 'high' ? 'high' : 'medium'}`;
      appendText(badge, warning.severity === 'high' ? '高' : '中');
      const text = document.createElement('span');
      appendText(text, `${platformLabel(warning.platform)} · “${warning.term}”：${warning.excerpt}（${warning.reason}）`);
      entry.append(badge, text);
    }));
    reviewContent.append(reviewBlock('数字核查', facts, (entry, check) => {
      const code = document.createElement('code');
      appendText(code, check.claim);
      const text = document.createElement('span');
      appendText(text, check.note);
      entry.append(code, text);
    }));
    reviewContent.append(reviewBlock('合规提醒', reminders, (entry, item) => {
      appendText(entry, item);
    }));
  }

  /* ---------- Draft rendering ---------- */

  function draftCharCount(draft) {
    const title = String(draft.title || '').replace(/\s/g, '');
    const body = String(draft.body || '').replace(/\s/g, '');
    return { title: title.length, body: body.length };
  }

  function renderDraftSummary(drafts, review) {
    draftSummary.replaceChildren();
    if (!drafts.length) return;
    const characters = drafts.reduce((total, draft) => {
      const counts = draftCharCount(draft);
      return total + counts.title + counts.body;
    }, 0);
    const missing = review && Array.isArray(review.missingInfo) ? review.missingInfo.length : 0;
    const risks = review && Array.isArray(review.riskWarnings) ? review.riskWarnings.length : 0;
    const facts = review && Array.isArray(review.factChecks) ? review.factChecks.length : 0;
    draftSummary.append(
      summaryChip(drafts.length, '个平台', 'is-ok'),
      summaryChip(characters, '字'),
      summaryChip(risks, '风险', risks ? 'is-danger' : 'is-ok'),
      summaryChip(facts, '待核查'),
      summaryChip(missing, '缺失提示')
    );
  }

  function updateDraftMeta(article) {
    const meta = article.querySelector('.draft-meta');
    if (!meta) return;
    const counts = draftCharCount({
      title: article.querySelector('.draft-title').value,
      body: article.querySelector('.draft-body').value
    });
    appendText(meta, `标题 ${counts.title} 字 · 正文 ${counts.body} 字`);
  }

  function renderDrafts(drafts) {
    results.replaceChildren();
    currentDrafts = Array.isArray(drafts) ? drafts : [];
    for (const [index, draft] of currentDrafts.entries()) {
      const article = document.createElement('article');
      article.className = 'draft';
      article.dataset.platform = draft.platform || 'Unknown';

      const head = document.createElement('header');
      head.className = 'draft-head';
      const badge = document.createElement('span');
      badge.className = 'platform-badge';
      const dot = document.createElement('span');
      dot.className = `platform-dot ${platformDotClass(draft.platform)}`;
      dot.setAttribute('aria-hidden', 'true');
      const name = document.createElement('span');
      appendText(name, platformLabel(draft.platform));
      const code = document.createElement('small');
      appendText(code, platformCode(draft.platform));
      badge.append(dot, name, code);
      const meta = document.createElement('span');
      meta.className = 'draft-meta';
      const actions = document.createElement('div');
      actions.className = 'button-row';
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'quiet-button small copy-button';
      appendText(copy, '复制本条');
      copy.addEventListener('click', async () => {
        try {
          await copyText(draftText(collectEditedDrafts()[index]));
          setStatus('已复制当前草稿。');
        } catch {
          setStatus('复制失败，请手动选择文本复制。', true);
        }
      });
      actions.append(copy);
      head.append(badge, meta, actions);

      const pair = document.createElement('div');
      pair.className = 'field-grid';
      const titleLabel = document.createElement('label');
      appendText(titleLabel, '标题');
      const title = document.createElement('input');
      title.className = 'draft-title';
      title.value = draft.title || '';
      title.setAttribute('aria-label', `${platformLabel(draft.platform)}标题`);
      titleLabel.append(title);

      const tagsLabel = document.createElement('label');
      appendText(tagsLabel, '标签（英文逗号分隔，不含 #）');
      const tags = document.createElement('input');
      tags.className = 'draft-tags';
      tags.value = Array.isArray(draft.tags) ? draft.tags.join(', ') : '';
      tags.setAttribute('aria-label', `${platformLabel(draft.platform)}标签`);
      tagsLabel.append(tags);
      pair.append(titleLabel, tagsLabel);

      const bodyLabel = document.createElement('label');
      appendText(bodyLabel, '正文');
      const body = document.createElement('textarea');
      body.className = 'draft-body';
      body.value = draft.body || '';
      body.setAttribute('aria-label', `${platformLabel(draft.platform)}正文`);
      bodyLabel.append(body);

      const pointsLabel = document.createElement('label');
      appendText(pointsLabel, '核心卖点（每行一条）');
      const points = document.createElement('textarea');
      points.className = 'draft-points compact';
      points.value = Array.isArray(draft.sellingPoints) ? draft.sellingPoints.join('\n') : '';
      points.setAttribute('aria-label', `${platformLabel(draft.platform)}卖点`);
      pointsLabel.append(points);

      title.addEventListener('input', () => updateDraftMeta(article));
      body.addEventListener('input', () => updateDraftMeta(article));
      article.append(head, pair, bodyLabel, pointsLabel);

      if (Array.isArray(draft.reviewNotes) && draft.reviewNotes.length) {
        const notes = document.createElement('details');
        notes.className = 'draft-notes';
        notes.open = true;
        const summary = document.createElement('summary');
        appendText(summary, `模型复核提示（${draft.reviewNotes.length}）`);
        const list = document.createElement('ul');
        list.className = 'review-notes';
        for (const note of draft.reviewNotes) {
          const item = document.createElement('li');
          appendText(item, note);
          list.append(item);
        }
        notes.append(summary, list);
        article.append(notes);
      }

      updateDraftMeta(article);
      results.append(article);
    }
    renderDraftSummary(currentDrafts, currentReview);
    resultSection.classList.toggle('hidden', currentDrafts.length === 0);
  }

  /* ---------- History rendering ---------- */

  function renderHistory() {
    const entries = readHistory();
    historyList.replaceChildren();
    for (const session of entries) {
      const item = document.createElement('article');
      item.className = 'history-item';
      const main = document.createElement('div');
      main.className = 'history-main';
      const name = document.createElement('strong');
      appendText(name, session.productName || '未命名商品');
      const metadata = document.createElement('span');
      metadata.className = 'history-meta';
      const platforms = session.payload && Array.isArray(session.payload.platforms)
        ? session.payload.platforms.map(platformLabel).join('、')
        : '';
      const pieces = [formatTime(session.createdAt)];
      if (platforms) pieces.push(platforms);
      if (session.imageCount) pieces.push(`${session.imageCount} 张图片`);
      if (session.edited) pieces.push('已编辑');
      appendText(metadata, pieces.join(' · '));
      main.append(name, metadata);

      const actions = document.createElement('div');
      actions.className = 'button-row';
      const dots = document.createElement('span');
      dots.className = 'history-dots';
      for (const platform of (session.payload && session.payload.platforms) || []) {
        const dot = document.createElement('span');
        dot.className = `platform-dot ${platformDotClass(platform)}`;
        dot.title = platformLabel(platform);
        dots.append(dot);
      }
      const restore = document.createElement('button');
      restore.type = 'button';
      restore.className = 'quiet-button small';
      appendText(restore, '恢复');
      restore.addEventListener('click', () => restoreSession(session));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'quiet-button small';
      appendText(remove, '删除');
      remove.addEventListener('click', () => {
        deleteHistory(session.id);
        renderHistory();
        setStatus('已删除该条历史记录。');
      });
      actions.append(dots, restore, remove);
      item.append(main, actions);
      historyList.append(item);
    }
    historySection.classList.toggle('hidden', entries.length === 0);
  }

  function fillForm(payload) {
    const source = payload || {};
    form.productName.value = source.productName || '';
    form.productDescription.value = source.productDescription || '';
    form.category.value = source.category || '';
    form.brand.value = source.brand || '';
    form.targetAudience.value = source.targetAudience || '';
    form.priceInfo.value = source.priceInfo || '';
    form.promotionInfo.value = source.promotionInfo || '';
    form.afterSales.value = source.afterSales || '';
    form.tone.value = source.tone || '清晰、友好、可信';
    form.sellingPoints.value = Array.isArray(source.sellingPoints) ? source.sellingPoints.join('\n') : '';
    form.specifications.value = Array.isArray(source.specifications)
      ? source.specifications.map((spec) => `${spec.name}: ${spec.value}`).join('\n')
      : '';
    setPlatforms(source.platforms);
  }

  function restoreSession(session) {
    fillForm(session.payload);
    images = [];
    renderImages();
    currentSessionId = session.id;
    currentSessionCreatedAt = session.createdAt || new Date().toISOString();
    currentImageCount = session.imageCount || 0;
    currentReview = session.review || null;
    renderReview(currentReview);
    renderDrafts(Array.isArray(session.drafts) ? session.drafts : []);
    setStep(3);
    setStatus('已恢复本地会话；图片不会保存，如需图片分析请重新选择图片并生成。');
    document.querySelector('#result-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ---------- Images ---------- */

  function renderImages() {
    imagePreview.replaceChildren();
    images.forEach((image, index) => {
      const figure = document.createElement('figure');
      figure.className = 'image-card';
      const preview = document.createElement('img');
      preview.src = image.dataUrl;
      preview.alt = image.name;
      const caption = document.createElement('figcaption');
      appendText(caption, image.name);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'quiet-button small';
      appendText(remove, '移除');
      remove.addEventListener('click', () => {
        images.splice(index, 1);
        renderImages();
      });
      figure.append(preview, caption, remove);
      imagePreview.append(figure);
    });
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
  }

  async function addFiles(fileList) {
    for (const file of [...fileList]) {
      if (images.length >= MAX_IMAGES) {
        setStatus(`最多支持 ${MAX_IMAGES} 张图片。`, true);
        break;
      }
      if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
        setStatus('只支持 PNG、JPEG、WebP 格式的图片。', true);
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        setStatus('单张图片不能超过 2MB。', true);
        continue;
      }
      const dataUrl = await readFileAsDataUrl(file);
      if (!dataUrl) {
        setStatus('图片读取失败，请重试。', true);
        continue;
      }
      const comma = dataUrl.indexOf(',');
      const mimeType = dataUrl.slice(5, comma).split(';')[0] || file.type;
      images.push({ name: file.name.slice(0, 100), mimeType, dataBase64: dataUrl.slice(comma + 1), dataUrl });
    }
    renderImages();
  }

  /* ---------- Events ---------- */

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = collectPayload();
    if (!payload.productName || !payload.productDescription) {
      setStatus('请填写商品名称和商品描述。', true);
      return;
    }
    if (payload.platforms.length === 0) {
      setStatus('请至少选择一个平台。', true);
      return;
    }
    submitButton.disabled = true;
    submitButton.classList.add('is-busy');
    setStep(2);
    setStatus(payload.images.length ? '正在生成草稿（含图片，可能需要更久）…' : '正在生成草稿…');
    try {
      const response = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(result && result.error && result.error.message ? result.error.message : '生成失败，请重试。');
      }
      currentDrafts = result.data.drafts;
      currentReview = result.data.review;
      currentImageCount = payload.images.length;
      currentSessionId = createId();
      currentSessionCreatedAt = new Date().toISOString();
      renderReview(currentReview);
      renderDrafts(currentDrafts);
      const storedPayload = { ...payload };
      delete storedPayload.images;
      upsertHistory({
        id: currentSessionId,
        createdAt: currentSessionCreatedAt,
        updatedAt: currentSessionCreatedAt,
        productName: storedPayload.productName,
        payload: storedPayload,
        drafts: currentDrafts,
        review: currentReview,
        imageCount: currentImageCount
      });
      renderHistory();
      setStep(3);
      setStatus(`已生成 ${currentDrafts.length} 条草稿，请先查看复核与合规提醒。`);
    } catch (error) {
      setStep(1);
      setStatus(error && error.message ? error.message : '生成失败，请重试。', true);
    } finally {
      submitButton.disabled = false;
      submitButton.classList.remove('is-busy');
    }
  });

  form.addEventListener('change', (event) => {
    if (event.target && event.target.name === 'platform') syncPlatformCards();
  });

  imageInput.addEventListener('change', async () => {
    await addFiles(imageInput.files || []);
    imageInput.value = '';
  });

  dropzone.addEventListener('click', () => imageInput.click());
  dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      imageInput.click();
    }
  });
  for (const name of ['dragenter', 'dragover']) {
    dropzone.addEventListener(name, (event) => {
      event.preventDefault();
      dropzone.classList.add('is-over');
    });
  }
  for (const name of ['dragleave', 'drop']) {
    dropzone.addEventListener(name, (event) => {
      event.preventDefault();
      dropzone.classList.remove('is-over');
    });
  }
  dropzone.addEventListener('drop', (event) => {
    const files = event.dataTransfer && event.dataTransfer.files;
    if (files && files.length) addFiles(files);
  });

  copyAll.addEventListener('click', async () => {
    const drafts = collectEditedDrafts();
    try {
      await copyText(drafts.map(draftText).join('\n\n---\n\n'));
      setStatus('已复制全部草稿。');
    } catch {
      setStatus('复制失败，请手动选择文本复制。', true);
    }
  });

  saveEdits.addEventListener('click', () => {
    if (!currentDrafts.length) {
      setStatus('当前没有可保存的草稿。', true);
      return;
    }
    const entry = currentEntry();
    entry.edited = true;
    currentSessionId = entry.id;
    currentSessionCreatedAt = entry.createdAt;
    currentDrafts = entry.drafts;
    upsertHistory(entry);
    renderHistory();
    setStatus('草稿修改已保存到本地历史。');
  });

  downloadMarkdown.addEventListener('click', () => {
    if (!currentDrafts.length) {
      setStatus('当前没有可导出的草稿。', true);
      return;
    }
    const entry = currentEntry();
    downloadFile(`ecommerce-drafts-${Date.now()}.md`, markdownFor(entry), 'text/markdown;charset=utf-8');
    setStatus('已导出 Markdown 文件。');
  });

  downloadJson.addEventListener('click', () => {
    if (!currentDrafts.length) {
      setStatus('当前没有可导出的草稿。', true);
      return;
    }
    const entry = currentEntry();
    downloadFile(
      `ecommerce-drafts-${Date.now()}.json`,
      JSON.stringify({ exportedAt: new Date().toISOString(), ...entry }, null, 2),
      'application/json;charset=utf-8'
    );
    setStatus('已导出 JSON 文件。');
  });

  clearHistory.addEventListener('click', () => {
    try {
      localStorage.removeItem(HISTORY_KEY);
      localStorage.removeItem(LEGACY_HISTORY_KEY);
    } catch {
      // Ignore storage failures.
    }
    renderHistory();
    setStatus('本地历史已清空。');
  });

  initTheme();
  syncPlatformCards();
  renderImages();
  renderHistory();
  loadHealth();
})();
