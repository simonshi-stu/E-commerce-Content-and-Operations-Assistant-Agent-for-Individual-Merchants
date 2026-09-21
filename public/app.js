(() => {
  'use strict';

  const i18n = window.APP_I18N;
  const HISTORY_KEY = 'ecommerce-content-assistant-history-v2';
  const LEGACY_HISTORY_KEY = 'ecommerce-content-demo-history-v1';
  const THEME_KEY = 'ecommerce-content-assistant-theme';
  const LOCALE_KEY = 'ecommerce-content-assistant-locale';
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
  const downloadPack = document.querySelector('#download-pack');
  const historySection = document.querySelector('#history-section');
  const historyList = document.querySelector('#history-list');
  const clearHistory = document.querySelector('#clear-history');
  const imageInput = document.querySelector('#image-input');
  const imagePreview = document.querySelector('#image-preview');
  const dropzone = document.querySelector('#dropzone');
  const themeSwitch = document.querySelector('#theme-switch');
  const languageSwitch = document.querySelector('#language-switch');
  const healthChip = document.querySelector('#health-chip');
  const healthText = document.querySelector('#health-text');
  const stepper = document.querySelector('#stepper');

  let locale = i18n.detect();
  let images = [];
  let currentDrafts = [];
  let currentReview = null;
  let currentSessionId = null;
  let currentSessionCreatedAt = null;
  let currentImageCount = 0;
  let currentHealth = null;

  function t(key, params) {
    return i18n.t(locale, key, params);
  }

  function platformLabel(platform) {
    return platform ? t(`platform.${platform}`) : t('platform.Unknown', {});
  }

  function platformCode(platform) {
    return String(platform || 'PLATFORM').toUpperCase();
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
    return time && !Number.isNaN(time.valueOf()) ? time.toLocaleString(locale === 'en' ? 'en-US' : 'zh-CN') : '-';
  }

  function collectPayload() {
    return {
      locale,
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

  function systemTheme() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  function applyThemeMode(mode) {
    const resolved = mode === 'auto' ? systemTheme() : mode === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themeMode = mode;
    for (const button of themeSwitch.querySelectorAll('button')) {
      button.classList.toggle('is-active', button.dataset.themeMode === mode);
      button.setAttribute('aria-pressed', String(button.dataset.themeMode === mode));
    }
  }

  function initTheme() {
    let saved = 'dark';
    try {
      saved = localStorage.getItem(THEME_KEY) || 'dark';
    } catch {
      saved = 'dark';
    }
    applyThemeMode(saved);
    themeSwitch.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-theme-mode]');
      if (!button) return;
      applyThemeMode(button.dataset.themeMode);
      try {
        localStorage.setItem(THEME_KEY, button.dataset.themeMode);
      } catch {
        // Theme preference is optional.
      }
    });
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
        if (document.documentElement.dataset.themeMode === 'auto') applyThemeMode('auto');
      });
    }
  }

  /* ---------- Locale ---------- */

  function updateHealthText() {
    healthChip.classList.remove('is-ok', 'is-warn');
    if (!currentHealth) {
      appendText(healthText, t('health.checking'));
      return;
    }
    if (currentHealth.configured) {
      const vision = currentHealth.visionConfigured ? t('health.vision') : '';
      healthChip.classList.add('is-ok');
      appendText(healthText, t('health.connected', { model: currentHealth.model }) + vision);
    } else {
      healthChip.classList.add('is-warn');
      appendText(healthText, t('health.unconfigured'));
    }
  }

  function applyLocale(next) {
    locale = i18n.normalize(next);
    document.documentElement.lang = locale === 'en' ? 'en' : 'zh-CN';
    try {
      localStorage.setItem(LOCALE_KEY, locale);
    } catch {
      // Locale preference is optional.
    }
    i18n.applyStatic(document, locale);
    for (const button of languageSwitch.querySelectorAll('button')) {
      const active = button.dataset.locale === locale;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    if (currentDrafts.length) currentDrafts = collectEditedDrafts();
    renderReview(currentReview);
    renderDrafts(currentDrafts);
    renderHistory();
    updateHealthText();
  }

  function initLocale() {
    languageSwitch.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-locale]');
      if (!button) return;
      applyLocale(button.dataset.locale);
    });
    applyLocale(locale);
  }

  async function loadHealth() {
    try {
      const response = await fetch('/api/health');
      currentHealth = await response.json();
    } catch {
      currentHealth = null;
      appendText(healthText, t('health.unknown'));
      return;
    }
    updateHealthText();
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
          productName: entry.productName || 'Untitled',
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
    if (!text) throw new Error('empty');
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
    if (!copied) throw new Error('clipboard');
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
    if (draft.title) parts.push(`${t('draft.title')}: ${draft.title}`);
    if (draft.sellingPoints && draft.sellingPoints.length) {
      parts.push('', `${t('draft.points')}:`, ...draft.sellingPoints.map((point) => `- ${point}`));
    }
    if (draft.body) parts.push('', draft.body);
    if (draft.tags && draft.tags.length) parts.push('', `${t('draft.tags')}: ${draft.tags.map((tag) => `#${tag}`).join(' ')}`);
    if (draft.reviewNotes && draft.reviewNotes.length) {
      parts.push('', `${t('draft.notes', { count: draft.reviewNotes.length })}:`, ...draft.reviewNotes.map((note) => `- ${note}`));
    }
    return parts.join('\n').trim();
  }

  function reviewSectionLines(review) {
    const lines = [];
    if (!review) return lines;
    if (review.missingInfo && review.missingInfo.length) {
      lines.push(`### ${t('review.block.missing')}`, ...review.missingInfo.map((item) => `- ${item}`), '');
    }
    if (review.riskWarnings && review.riskWarnings.length) {
      lines.push(
        `### ${t('review.block.risks')}`,
        ...review.riskWarnings.map((warning) => `- [${warning.severity === 'high' ? '!' : '-'}] ${platformLabel(warning.platform)} · ${warning.term}: ${warning.excerpt} (${warning.reason})`),
        ''
      );
    }
    if (review.factChecks && review.factChecks.length) {
      lines.push(`### ${t('review.block.facts')}`, ...review.factChecks.map((check) => `- ${check.claim}: ${check.note}`), '');
    }
    if (review.complianceReminders && review.complianceReminders.length) {
      lines.push(`### ${t('review.block.compliance')}`, ...review.complianceReminders.map((item) => `- ${item}`), '');
    }
    return lines;
  }

  function markdownFor(entry) {
    const payload = entry.payload || {};
    const drafts = Array.isArray(entry.drafts) ? entry.drafts : [];
    const lines = [`# ${payload.productName || 'Untitled'}: ${t('results.title')}`, ''];
    if (Array.isArray(payload.platforms) && payload.platforms.length) {
      lines.push(`- ${t('platforms.title')}: ${payload.platforms.map(platformLabel).join(', ')}`);
    }
    lines.push(`- ${formatTime(entry.createdAt)}`);
    if (entry.imageCount) lines.push(`- ${t('history.images', { count: entry.imageCount })}`);
    lines.push('');
    for (const draft of drafts) {
      lines.push(`## ${platformLabel(draft.platform)}`, '');
      if (draft.title) lines.push(`**${t('draft.title')}**: ${draft.title}`, '');
      if (draft.sellingPoints && draft.sellingPoints.length) {
        lines.push(`**${t('draft.points')}**`, ...draft.sellingPoints.map((point) => `- ${point}`), '');
      }
      if (draft.body) lines.push('**' + t('draft.body') + '**', '', draft.body, '');
      if (draft.tags && draft.tags.length) {
        lines.push(`**${t('draft.tags')}**: ${draft.tags.map((tag) => `#${tag}`).join(' ')}`, '');
      }
      if (draft.reviewNotes && draft.reviewNotes.length) {
        lines.push(`**${t('draft.notes', { count: draft.reviewNotes.length })}**`, ...draft.reviewNotes.map((note) => `- ${note}`), '');
      }
    }
    lines.push(`## ${t('pack.reviewTitle')}`, '', ...reviewSectionLines(entry.review));
    lines.push(t('pack.warning'));
    return lines.join('\n');
  }

  function publishPackFor(entry) {
    const payload = entry.payload || {};
    const drafts = Array.isArray(entry.drafts) ? entry.drafts : [];
    const lines = [`# ${payload.productName || 'Untitled'} · ${t('pack.title')}`, '', `> ${t('pack.warning')}`, ''];
    lines.push(`## ${t('pack.checklist')}`, '');
    for (let index = 1; index <= 5; index += 1) lines.push(`- [ ] ${t(`pack.check.${index}`)}`);
    lines.push('');
    for (const draft of drafts) {
      lines.push(`## ${platformLabel(draft.platform)}`, '');
      if (draft.title) lines.push(`### ${t('draft.title')}`, '', draft.title, '');
      if (draft.body) lines.push(`### ${t('draft.body')}`, '', draft.body, '');
      if (draft.tags && draft.tags.length) lines.push(`### ${t('draft.tags')}`, '', draft.tags.map((tag) => `#${tag}`).join(' '), '');
      if (draft.sellingPoints && draft.sellingPoints.length) {
        lines.push(`### ${t('draft.points')}`, '', ...draft.sellingPoints.map((point) => `- ${point}`), '');
      }
    }
    lines.push(`## ${t('pack.reviewTitle')}`, '', ...reviewSectionLines(entry.review));
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
      appendText(empty, t('review.emptyInline'));
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
      summaryChip(missing.length, t('summary.missing'), missing.length ? '' : 'is-ok'),
      summaryChip(risks.length, t('summary.risks'), risks.length ? 'is-danger' : 'is-ok'),
      summaryChip(facts.length, t('summary.facts'), facts.length ? '' : 'is-ok')
    );
    reviewContent.append(summary);

    reviewContent.append(reviewBlock(t('review.block.missing'), missing, (entry, item) => {
      appendText(entry, item);
    }));
    reviewContent.append(reviewBlock(t('review.block.risks'), risks, (entry, warning) => {
      const badge = document.createElement('span');
      badge.className = `severity ${warning.severity === 'high' ? 'high' : 'medium'}`;
      appendText(badge, warning.severity === 'high' ? '!' : '-');
      const text = document.createElement('span');
      appendText(text, `${platformLabel(warning.platform)} · “${warning.term}”: ${warning.excerpt} (${warning.reason})`);
      entry.append(badge, text);
    }));
    reviewContent.append(reviewBlock(t('review.block.facts'), facts, (entry, check) => {
      const code = document.createElement('code');
      appendText(code, check.claim);
      const text = document.createElement('span');
      appendText(text, check.note);
      entry.append(code, text);
    }));
    reviewContent.append(reviewBlock(t('review.block.compliance'), reminders, (entry, item) => {
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
      summaryChip(drafts.length, t('summary.platforms'), 'is-ok'),
      summaryChip(characters, t('summary.characters')),
      summaryChip(risks, t('summary.risks'), risks ? 'is-danger' : 'is-ok'),
      summaryChip(facts, t('summary.facts')),
      summaryChip(missing, t('summary.missingHints'))
    );
  }

  function updateDraftMeta(article) {
    const meta = article.querySelector('.draft-meta');
    if (!meta) return;
    const counts = draftCharCount({
      title: article.querySelector('.draft-title').value,
      body: article.querySelector('.draft-body').value
    });
    appendText(meta, t('draft.meta', { title: counts.title, body: counts.body }));
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
      appendText(copy, t('action.copyOne'));
      copy.addEventListener('click', async () => {
        try {
          await copyText(draftText(collectEditedDrafts()[index]));
          setStatus(t('status.copiedOne'));
        } catch {
          setStatus(t('status.copyFailed'), true);
        }
      });
      actions.append(copy);
      head.append(badge, meta, actions);

      const pair = document.createElement('div');
      pair.className = 'field-grid';
      const titleLabel = document.createElement('label');
      appendText(titleLabel, t('draft.title'));
      const title = document.createElement('input');
      title.className = 'draft-title';
      title.value = draft.title || '';
      title.setAttribute('aria-label', `${platformLabel(draft.platform)} ${t('draft.title')}`);
      titleLabel.append(title);

      const tagsLabel = document.createElement('label');
      appendText(tagsLabel, t('draft.tags'));
      const tags = document.createElement('input');
      tags.className = 'draft-tags';
      tags.value = Array.isArray(draft.tags) ? draft.tags.join(', ') : '';
      tags.setAttribute('aria-label', `${platformLabel(draft.platform)} ${t('draft.tags')}`);
      tagsLabel.append(tags);
      pair.append(titleLabel, tagsLabel);

      const bodyLabel = document.createElement('label');
      appendText(bodyLabel, t('draft.body'));
      const body = document.createElement('textarea');
      body.className = 'draft-body';
      body.value = draft.body || '';
      body.setAttribute('aria-label', `${platformLabel(draft.platform)} ${t('draft.body')}`);
      bodyLabel.append(body);

      const pointsLabel = document.createElement('label');
      appendText(pointsLabel, t('draft.points'));
      const points = document.createElement('textarea');
      points.className = 'draft-points compact';
      points.value = Array.isArray(draft.sellingPoints) ? draft.sellingPoints.join('\n') : '';
      points.setAttribute('aria-label', `${platformLabel(draft.platform)} ${t('draft.points')}`);
      pointsLabel.append(points);

      title.addEventListener('input', () => updateDraftMeta(article));
      body.addEventListener('input', () => updateDraftMeta(article));
      article.append(head, pair, bodyLabel, pointsLabel);

      if (Array.isArray(draft.reviewNotes) && draft.reviewNotes.length) {
        const notes = document.createElement('details');
        notes.className = 'draft-notes';
        notes.open = true;
        const summary = document.createElement('summary');
        appendText(summary, t('draft.notes', { count: draft.reviewNotes.length }));
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
      appendText(name, session.productName || '-');
      const metadata = document.createElement('span');
      metadata.className = 'history-meta';
      const platforms = session.payload && Array.isArray(session.payload.platforms)
        ? session.payload.platforms.map(platformLabel).join(', ')
        : '';
      const pieces = [formatTime(session.createdAt)];
      if (platforms) pieces.push(platforms);
      if (session.imageCount) pieces.push(t('history.images', { count: session.imageCount }));
      if (session.edited) pieces.push(t('history.edited'));
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
      appendText(restore, t('action.restore'));
      restore.addEventListener('click', () => restoreSession(session));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'quiet-button small';
      appendText(remove, t('action.delete'));
      remove.addEventListener('click', () => {
        deleteHistory(session.id);
        renderHistory();
        setStatus(t('status.deleted'));
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
    form.tone.value = source.tone || '';
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
    setStatus(t('status.restored'));
    resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
      appendText(remove, t('action.remove'));
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
        setStatus(t('status.imageLimit', { max: MAX_IMAGES }), true);
        break;
      }
      if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
        setStatus(t('status.imageType'), true);
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        setStatus(t('status.imageSize'), true);
        continue;
      }
      const dataUrl = await readFileAsDataUrl(file);
      if (!dataUrl) {
        setStatus(t('status.imageRead'), true);
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
      setStatus(t('status.needName'), true);
      return;
    }
    if (payload.platforms.length === 0) {
      setStatus(t('status.needPlatform'), true);
      return;
    }
    submitButton.disabled = true;
    submitButton.classList.add('is-busy');
    setStep(2);
    setStatus(t(payload.images.length ? 'status.generatingImages' : 'status.generating'));
    try {
      const response = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(result && result.error && result.error.message ? result.error.message : t('error.generic'));
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
      setStatus(t('status.generated', { count: currentDrafts.length }));
    } catch (error) {
      setStep(1);
      setStatus(error && error.message ? error.message : t('error.generic'), true);
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
    if (!drafts.length) {
      setStatus(t('status.noDrafts'), true);
      return;
    }
    try {
      await copyText(drafts.map(draftText).join('\n\n---\n\n'));
      setStatus(t('status.copiedAll'));
    } catch {
      setStatus(t('status.copyFailed'), true);
    }
  });

  saveEdits.addEventListener('click', () => {
    if (!currentDrafts.length) {
      setStatus(t('status.noDrafts'), true);
      return;
    }
    const entry = currentEntry();
    entry.edited = true;
    currentSessionId = entry.id;
    currentSessionCreatedAt = entry.createdAt;
    currentDrafts = entry.drafts;
    upsertHistory(entry);
    renderHistory();
    setStatus(t('status.savedEdits'));
  });

  downloadMarkdown.addEventListener('click', () => {
    if (!currentDrafts.length) {
      setStatus(t('status.noDrafts'), true);
      return;
    }
    downloadFile(`ecommerce-drafts-${Date.now()}.md`, markdownFor(currentEntry()), 'text/markdown;charset=utf-8');
    setStatus(t('status.exportedMd'));
  });

  downloadJson.addEventListener('click', () => {
    if (!currentDrafts.length) {
      setStatus(t('status.noDrafts'), true);
      return;
    }
    const entry = currentEntry();
    downloadFile(
      `ecommerce-drafts-${Date.now()}.json`,
      JSON.stringify({ exportedAt: new Date().toISOString(), ...entry }, null, 2),
      'application/json;charset=utf-8'
    );
    setStatus(t('status.exportedJson'));
  });

  downloadPack.addEventListener('click', () => {
    if (!currentDrafts.length) {
      setStatus(t('status.noDrafts'), true);
      return;
    }
    downloadFile(`ecommerce-publish-pack-${Date.now()}.md`, publishPackFor(currentEntry()), 'text/markdown;charset=utf-8');
    setStatus(t('status.exportedPack'));
  });

  clearHistory.addEventListener('click', () => {
    try {
      localStorage.removeItem(HISTORY_KEY);
      localStorage.removeItem(LEGACY_HISTORY_KEY);
    } catch {
      // Ignore storage failures.
    }
    renderHistory();
    setStatus(t('status.cleared'));
  });

  initTheme();
  initLocale();
  syncPlatformCards();
  renderImages();
  renderHistory();
  loadHealth();
})();
