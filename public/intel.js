(() => {
  'use strict';

  const i18n = window.APP_I18N;
  const THEME_KEY = 'ecommerce-content-assistant-theme';
  const LOCALE_KEY = 'ecommerce-content-assistant-locale';
  const CANDIDATES_KEY = 'ecommerce-content-assistant-candidates-v1';
  const PLATFORMS = ['Xiaohongshu', 'Douyin', 'Tmall', 'Pinduoduo'];
  const SOURCE_TYPES = ['official_store', 'merchant_record', 'platform_search', 'third_party_tool', 'screenshot_note', 'unknown'];

  const themeSwitch = document.querySelector('#theme-switch');
  const languageSwitch = document.querySelector('#language-switch');
  const healthChip = document.querySelector('#health-chip');
  const healthText = document.querySelector('#health-text');

  const scoreForm = document.querySelector('#score-form');
  const scoreStatus = document.querySelector('#score-status');
  const scoreResultEl = document.querySelector('#score-result');
  const candidateList = document.querySelector('#candidate-list');
  const exportCandidates = document.querySelector('#export-candidates');

  const compareForm = document.querySelector('#compare-form');
  const compareStatus = document.querySelector('#compare-status');
  const compareResultEl = document.querySelector('#compare-result');
  const competitorRows = document.querySelector('#competitor-rows');
  const addCompetitor = document.querySelector('#add-competitor');

  const pricesForm = document.querySelector('#prices-form');
  const pricesStatus = document.querySelector('#prices-status');
  const pricesResultEl = document.querySelector('#prices-result');
  const priceRows = document.querySelector('#price-rows');
  const addPrice = document.querySelector('#add-price');

  let locale = i18n.detect();
  let currentHealth = null;
  let scoreResult = null;
  let compareResult = null;
  let pricesResult = null;
  const aiResults = { score: null, compare: null, prices: null };
  const aiErrors = { score: '', compare: '', prices: '' };
  let aiBusy = '';

  function t(key, params) {
    return i18n.t(locale, key, params);
  }

  function el(tag, className, props = {}) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    for (const [key, value] of Object.entries(props)) {
      if (key === 'text') node.textContent = value;
      else if (key === 'options') {
        for (const [optionValue, label] of value) node.append(new Option(label, optionValue));
      } else node.setAttribute(key, value);
    }
    return node;
  }

  function valueOf(selector) {
    const input = document.querySelector(selector);
    return input ? input.value.trim() : '';
  }

  function numberOf(selector) {
    const parsed = Number.parseFloat(valueOf(selector));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function fmt(value, digits = 2) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
    return new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'zh-CN', { maximumFractionDigits: digits }).format(value);
  }

  function setStatus(element, message, isError = false) {
    element.textContent = message;
    element.classList.toggle('error', isError);
  }

  function platformLabel(platform) {
    return platform ? t(`platform.${platform}`) : '';
  }

  function metric(label, value) {
    const box = el('div', 'metric');
    box.append(el('span', 'metric-label', { text: label }), el('span', 'metric-value', { text: value }));
    return box;
  }

  function metricGrid(items) {
    const grid = el('div', 'metric-grid');
    for (const [label, value] of items) grid.append(metric(label, value));
    return grid;
  }

  function chipList(items, renderLabel) {
    const list = el('ul', 'keyword-list');
    for (const item of items) {
      const entry = el('li');
      entry.append(document.createTextNode(renderLabel(item)));
      list.append(entry);
    }
    return list;
  }

  function buttonRow(buttons) {
    const row = el('div', 'button-row');
    for (const { label, onClick, kind } of buttons) {
      const button = el('button', 'quiet-button small', { type: 'button', text: label });
      if (kind) button.dataset.kind = kind;
      button.addEventListener('click', onClick);
      row.append(button);
    }
    return row;
  }

  function credBadge(level) {
    return el('span', `cred-badge ${level}`, { text: t(`intel.credibility.level.${level}`) });
  }

  function reasonChips(reasons) {
    const list = Array.isArray(reasons) ? reasons : [];
    if (!list.length) return el('p', 'empty-inline', { text: t('intel.compare.none') });
    return chipList(list, (reason) => t(`intel.reason.${reason}`));
  }

  function confidenceCard(confidence, extraMetrics = []) {
    const block = el('div', 'result-block');
    const heading = el('h4');
    heading.append(document.createTextNode(`${t('intel.confidence.title')} `), credBadge(confidence.level));
    block.append(heading);
    block.append(metricGrid([
      [`${t('intel.confidence.title')}`, `${confidence.score} / 100`],
      ...extraMetrics
    ]));
    block.append(reasonChips(confidence.reasons));
    return block;
  }

  function credibilityCard(dataCredibility) {
    const block = el('div', 'result-block');
    const heading = el('h4');
    heading.append(document.createTextNode(`${t('intel.credibility.title')} `), credBadge(dataCredibility.level));
    block.append(heading);
    block.append(metricGrid([
      [t('intel.credibility.title'), `${dataCredibility.score} / 100`],
      [t('intel.credibility.samples'), String(dataCredibility.sampleCount)],
      [t('intel.credibility.average'), `${dataCredibility.averageEntryScore} / 100`],
      [t('intel.credibility.agreement'), dataCredibility.agreement === null ? '-' : String(dataCredibility.agreement)]
    ]));
    block.append(reasonChips(dataCredibility.reasons));
    return block;
  }

  function download(fileName, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportJson(name, payload) {
    download(`${name}-${Date.now()}.json`, JSON.stringify({ exportedAt: new Date().toISOString(), locale, credibilityVersion: 1, ...payload }, null, 2), 'application/json;charset=utf-8');
  }

  function exportMarkdown(name, markdown) {
    download(`${name}-${Date.now()}.md`, markdown, 'text/markdown;charset=utf-8');
  }

  async function postIntel(path, payload) {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, locale })
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(body && body.error && body.error.message ? body.error.message : t('intel.error.calculate'));
    }
    return body.data;
  }

  /* ---------- Theme and locale ---------- */

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
        // Optional.
      }
    });
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
        if (document.documentElement.dataset.themeMode === 'auto') applyThemeMode('auto');
      });
    }
  }

  function updateHealthText() {
    healthChip.classList.remove('is-ok', 'is-warn');
    if (!currentHealth) {
      healthText.textContent = t('health.checking');
      return;
    }
    if (currentHealth.configured) {
      healthChip.classList.add('is-ok');
      healthText.textContent = t('health.connected', { model: currentHealth.model }) + (currentHealth.visionConfigured ? t('health.vision') : '');
    } else {
      healthChip.classList.add('is-warn');
      healthText.textContent = t('health.unconfigured');
    }
  }

  function applyLocale(next) {
    locale = i18n.normalize(next);
    document.documentElement.lang = locale === 'en' ? 'en' : 'zh-CN';
    try {
      localStorage.setItem(LOCALE_KEY, locale);
    } catch {
      // Optional.
    }
    i18n.applyStatic(document, locale);
    for (const button of languageSwitch.querySelectorAll('button')) {
      const active = button.dataset.locale === locale;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    renderScoreResult();
    renderCompareResult();
    renderPricesResult();
    renderCandidates();
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
      currentHealth = await (await fetch('/api/health')).json();
    } catch {
      currentHealth = null;
      healthText.textContent = t('health.unknown');
      return;
    }
    updateHealthText();
  }

  /* ---------- Score ---------- */

  function readScoreInput() {
    return {
      name: valueOf('#score-name'),
      price: numberOf('#score-price'),
      unitCost: numberOf('#score-unit-cost'),
      shippingCost: numberOf('#score-shipping'),
      platformFeeRate: numberOf('#score-fee'),
      adCostPerUnit: numberOf('#score-ad-cost'),
      targetMarginRate: numberOf('#score-target-margin'),
      demand: numberOf('#score-demand'),
      competition: numberOf('#score-competition'),
      differentiation: numberOf('#score-differentiation'),
      risk: numberOf('#score-risk'),
      dataBasis: valueOf('#score-basis') || 'estimated',
      observedAt: valueOf('#score-observed')
    };
  }

  function fillScoreInput(input) {
    const map = {
      '#score-name': input.name,
      '#score-price': input.price,
      '#score-unit-cost': input.unitCost,
      '#score-shipping': input.shippingCost,
      '#score-fee': input.platformFeeRate,
      '#score-ad-cost': input.adCostPerUnit,
      '#score-target-margin': input.targetMarginRate,
      '#score-demand': input.demand,
      '#score-competition': input.competition,
      '#score-differentiation': input.differentiation,
      '#score-risk': input.risk,
      '#score-basis': input.dataBasis || 'estimated',
      '#score-observed': input.observedAt || ''
    };
    for (const [selector, value] of Object.entries(map)) {
      const field = document.querySelector(selector);
      if (field) field.value = value === undefined || value === null ? '' : value;
    }
  }

  function scoreMarkdown(result) {
    const metrics = result.metrics;
    return [
      `# ${t('intel.score.title')}: ${result.name}`,
      '',
      `- ${t('intel.result.platformFee')}: ${fmt(metrics.platformFee)}`,
      `- ${t('intel.result.grossProfit')}: ${fmt(metrics.grossProfit)}`,
      `- ${t('intel.result.marginRate')}: ${fmt(metrics.marginRate)}%`,
      `- ${t('intel.result.breakEven')}: ${fmt(metrics.breakEvenPrice)}`,
      `- ${t('intel.result.total')}: ${result.totalScore} / 100`,
      `- ${t('intel.result.verdict')}: ${t(`intel.verdict.${result.verdict}`)}`,
      `- ${t('intel.confidence.title')}: ${result.confidence.score} / 100 (${t(`intel.credibility.level.${result.confidence.level}`)})`,
      '',
      `## ${t('intel.score.title')}`,
      ...Object.entries(result.scores).map(([key, value]) => `- ${t(`intel.score.${key}`)}: ${value}`)
    ].join('\n');
  }

  function renderScoreResult() {
    scoreResultEl.replaceChildren();
    if (!scoreResult) return;
    const result = scoreResult;
    const head = el('div', 'result-head');
    head.append(
      el('h3', null, { text: result.name }),
      el('span', `verdict ${result.verdict}`, { text: t(`intel.verdict.${result.verdict}`) }),
      buttonRow([
        { label: t('intel.score.save'), onClick: saveCandidate },
        { label: t('intel.action.exportJson'), onClick: () => exportJson('product-score', { result }) },
        { label: t('intel.action.exportMd'), onClick: () => exportMarkdown('product-score', scoreMarkdown(result)) }
      ])
    );

    const scores = el('div', 'score-list');
    for (const [key, value] of Object.entries(result.scores)) {
      const row = el('div', 'score-row');
      const track = el('div', 'score-track');
      const fill = el('div', 'score-fill');
      fill.style.width = `${Math.max(2, value)}%`;
      track.append(fill);
      row.append(el('span', null, { text: t(`intel.score.${key}`) }), track, el('span', null, { text: String(value) }));
      scores.append(row);
    }

    scoreResultEl.append(
      head,
      metricGrid([
        [t('intel.result.platformFee'), fmt(result.metrics.platformFee)],
        [t('intel.result.grossProfit'), fmt(result.metrics.grossProfit)],
        [t('intel.result.marginRate'), `${fmt(result.metrics.marginRate)}%`],
        [t('intel.result.breakEven'), fmt(result.metrics.breakEvenPrice)],
        [t('intel.result.total'), `${result.totalScore} / 100`]
      ]),
      scores,
      confidenceCard(result.confidence, [[t('intel.field.basis'), t(`intel.basis.${result.dataBasis}`)]]),
      aiBlock('score')
    );
  }

  /* ---------- Competitor rows ---------- */

  function platformSelect(className) {
    return el('select', className, {
      options: [['', t('intel.compare.platformOptional')], ...PLATFORMS.map((platform) => [platform, platformLabel(platform)])]
    });
  }

  function sourceSelect(className) {
    return el('select', className, {
      options: SOURCE_TYPES.map((source) => [source, t(`intel.source.${source}`)])
    });
  }

  function todayIso() {
    return new Date().toISOString().slice(0, 10);
  }

  function addCompetitorRow(data = {}) {
    const row = el('div', 'intel-row');
    row.dataset.competitor = 'true';
    const platform = platformSelect('comp-platform');
    platform.value = data.platform || '';
    const title = el('input', 'comp-title', { placeholder: t('intel.compare.competitorTitle'), maxlength: '200' });
    title.value = data.title || '';
    const price = el('input', 'comp-price', { type: 'number', min: '0', step: '0.01', placeholder: t('intel.field.price') });
    price.value = data.price === undefined ? '' : data.price;
    const points = el('input', 'comp-points', { placeholder: t('intel.compare.points'), maxlength: '300' });
    points.value = data.points || '';
    const source = sourceSelect('comp-source');
    source.value = data.sourceType || 'unknown';
    const note = el('input', 'comp-source-note', { placeholder: t('intel.field.sourceNote'), maxlength: '200' });
    note.value = data.sourceNote || '';
    const observed = el('input', 'comp-observed', { type: 'date', title: t('intel.field.observedAt') });
    observed.value = data.observedAt || todayIso();
    const remove = el('button', 'quiet-button small', { type: 'button', text: t('action.remove') });
    remove.addEventListener('click', () => {
      row.remove();
      if (!competitorRows.querySelector('[data-competitor]')) addCompetitorRow();
    });
    row.append(platform, title, price, points, source, note, observed, remove);
    competitorRows.append(row);
  }

  function readCompetitors() {
    return [...competitorRows.querySelectorAll('[data-competitor]')].map((row) => ({
      platform: row.querySelector('.comp-platform').value,
      title: row.querySelector('.comp-title').value.trim(),
      price: Number.parseFloat(row.querySelector('.comp-price').value) || 0,
      sellingPoints: row.querySelector('.comp-points').value.split(/[;；]+/).map((item) => item.trim()).filter(Boolean),
      sourceType: row.querySelector('.comp-source').value,
      sourceNote: row.querySelector('.comp-source-note').value.trim(),
      observedAt: row.querySelector('.comp-observed').value
    })).filter((competitor) => competitor.price > 0);
  }

  function compareMarkdown(result) {
    const lines = [
      `# ${t('intel.compare.title')}: ${result.productName || '-'}`,
      '',
      `## ${t('intel.compare.stats')}`,
      `- ${t('intel.stats.count')}: ${result.stats.count}`,
      `- ${t('intel.stats.min')}: ${fmt(result.stats.min)}`,
      `- ${t('intel.stats.max')}: ${fmt(result.stats.max)}`,
      `- ${t('intel.stats.average')}: ${fmt(result.stats.average)}`,
      `- ${t('intel.stats.median')}: ${fmt(result.stats.median)}`,
      `- ${t('intel.compare.yourGap')}: ${fmt(result.gapPercent)}%`,
      `- ${t('intel.compare.position')}: ${t(`intel.position.${result.position}`)}`,
      `- ${t('intel.credibility.title')}: ${result.dataCredibility.score} / 100 (${t(`intel.credibility.level.${result.dataCredibility.level}`)})`,
      `- ${t('intel.confidence.title')}: ${result.confidence.score} / 100 (${t(`intel.credibility.level.${result.confidence.level}`)})`,
      '',
      `## ${t('intel.credibility.ranking')}`,
      ...result.ranking.map((entry) => `- ${entry.title || entry.platform || '-'} (${entry.platform ? platformLabel(entry.platform) : '-'}, ${fmt(entry.price)}): ${entry.credibility.score}/100 ${t(`intel.credibility.level.${entry.credibility.level}`)}`),
      '',
      `## ${t('intel.compare.gaps')}`,
      ...(result.gaps.length ? result.gaps.map((item) => `- ${item.keyword} (${item.count})`) : [`- ${t('intel.compare.none')}`]),
      '',
      `## ${t('intel.compare.differentiators')}`,
      ...(result.differentiators.length ? result.differentiators.map((item) => `- ${item}`) : [`- ${t('intel.compare.none')}`])
    ];
    return lines.join('\n');
  }

  function rankingBlock(ranking) {
    const block = el('div', 'result-block');
    block.append(el('h4', null, { text: t('intel.credibility.ranking') }));
    const list = el('ul', 'ranking-list');
    for (const entry of ranking) {
      const item = el('li', 'ranking-item');
      const info = el('div', 'history-main');
      info.append(
        el('strong', null, { text: entry.title || platformLabel(entry.platform) || '-' }),
        el('span', 'history-meta', { text: `${platformLabel(entry.platform) || '-'} · ${fmt(entry.price)}` })
      );
      const score = el('div', 'ranking-score');
      score.append(credBadge(entry.credibility.level), el('span', 'history-meta', { text: `${entry.credibility.score}/100` }));
      item.append(info, score);
      list.append(item);
    }
    block.append(list);
    return block;
  }

  function renderCompareResult() {
    compareResultEl.replaceChildren();
    if (!compareResult) return;
    const result = compareResult;
    const head = el('div', 'result-head');
    head.append(
      el('h3', null, { text: result.productName || t('intel.compare.title') }),
      el('span', 'verdict watch', { text: t(`intel.position.${result.position}`) }),
      buttonRow([
        { label: t('intel.action.exportJson'), onClick: () => exportJson('competitor-compare', { result }) },
        { label: t('intel.action.exportMd'), onClick: () => exportMarkdown('competitor-compare', compareMarkdown(result)) }
      ])
    );
    const gapsBlock = el('div', 'result-block');
    gapsBlock.append(el('h4', null, { text: t('intel.compare.gaps') }));
    gapsBlock.append(result.gaps.length
      ? chipList(result.gaps, (item) => `${item.keyword} (${item.count})`)
      : el('p', 'empty-inline', { text: t('intel.compare.none') }));
    const diffBlock = el('div', 'result-block');
    diffBlock.append(el('h4', null, { text: t('intel.compare.differentiators') }));
    diffBlock.append(result.differentiators.length
      ? chipList(result.differentiators, (item) => item)
      : el('p', 'empty-inline', { text: t('intel.compare.none') }));

    compareResultEl.append(
      head,
      metricGrid([
        [t('intel.stats.count'), String(result.stats.count)],
        [t('intel.stats.min'), fmt(result.stats.min)],
        [t('intel.stats.max'), fmt(result.stats.max)],
        [t('intel.stats.average'), fmt(result.stats.average)],
        [t('intel.stats.median'), fmt(result.stats.median)],
        [t('intel.compare.yourGap'), `${fmt(result.gapPercent)}%`]
      ]),
      credibilityCard(result.dataCredibility),
      confidenceCard(result.confidence),
      rankingBlock(result.ranking),
      gapsBlock,
      diffBlock,
      aiBlock('compare')
    );
  }

  /* ---------- Price rows ---------- */

  function addPriceRow(data = {}) {
    const row = el('div', 'intel-row intel-row-price');
    row.dataset.price = 'true';
    const label = el('input', 'price-label', { placeholder: t('intel.prices.label'), maxlength: '80' });
    label.value = data.label || '';
    const platform = platformSelect('price-platform');
    platform.value = data.platform || '';
    const price = el('input', 'price-value', { type: 'number', min: '0', step: '0.01', placeholder: t('intel.field.price') });
    price.value = data.price === undefined ? '' : data.price;
    const type = el('select', 'price-type', {
      options: [['own', t('intel.prices.type.own')], ['competitor', t('intel.prices.type.competitor')]]
    });
    type.value = data.type || 'competitor';
    const source = sourceSelect('price-source');
    source.value = data.sourceType || 'unknown';
    const note = el('input', 'price-source-note', { placeholder: t('intel.field.sourceNote'), maxlength: '200' });
    note.value = data.sourceNote || '';
    const observed = el('input', 'price-observed', { type: 'date', title: t('intel.field.observedAt') });
    observed.value = data.observedAt || todayIso();
    const remove = el('button', 'quiet-button small', { type: 'button', text: t('action.remove') });
    remove.addEventListener('click', () => {
      row.remove();
      if (!priceRows.querySelector('[data-price]')) addPriceRow();
    });
    row.append(label, platform, price, type, source, note, observed, remove);
    priceRows.append(row);
  }

  function readPricePoints() {
    return [...priceRows.querySelectorAll('[data-price]')].map((row) => ({
      label: row.querySelector('.price-label').value.trim(),
      platform: row.querySelector('.price-platform').value,
      price: Number.parseFloat(row.querySelector('.price-value').value) || 0,
      type: row.querySelector('.price-type').value,
      sourceType: row.querySelector('.price-source').value,
      sourceNote: row.querySelector('.price-source-note').value.trim(),
      observedAt: row.querySelector('.price-observed').value
    }));
  }

  function pricesMarkdown(result) {
    const lines = [
      `# ${t('intel.prices.title')}`,
      '',
      `## ${t('intel.prices.stats')}`,
      `- ${t('intel.stats.count')}: ${result.stats.count}`,
      `- ${t('intel.stats.min')}: ${fmt(result.stats.min)}`,
      `- ${t('intel.stats.max')}: ${fmt(result.stats.max)}`,
      `- ${t('intel.stats.average')}: ${fmt(result.stats.average)}`,
      `- ${t('intel.stats.median')}: ${fmt(result.stats.median)}`,
      `- ${t('intel.stats.p25')}: ${fmt(result.stats.p25)}`,
      `- ${t('intel.stats.p75')}: ${fmt(result.stats.p75)}`,
      `- ${t('intel.stats.stddev')}: ${fmt(result.stats.standardDeviation)}`,
      `- ${t('intel.credibility.title')}: ${result.dataCredibility.score} / 100 (${t(`intel.credibility.level.${result.dataCredibility.level}`)})`,
      `- ${t('intel.confidence.title')}: ${result.confidence.score} / 100 (${t(`intel.credibility.level.${result.confidence.level}`)})`,
      '',
      `## ${t('intel.prices.points')}`,
      ...result.points.map((point) => `- ${point.label} (${point.type === 'own' ? t('intel.prices.type.own') : t('intel.prices.type.competitor')}): ${fmt(point.price)} · ${t(`intel.source.${point.sourceType}`)} · ${point.observedAt || '-'}`),
      '',
      `## ${t('intel.prices.costs')}`,
      `- ${t('intel.result.breakEven')}: ${fmt(result.costs.breakEvenPrice)}`,
      `- ${t('intel.prices.suggested')}: ${result.costs.feasible ? fmt(result.costs.suggestedPrice) : t('intel.prices.infeasible')}`
    ];
    return lines.join('\n');
  }

  function renderPricesResult() {
    pricesResultEl.replaceChildren();
    if (!pricesResult) return;
    const result = pricesResult;
    const head = el('div', 'result-head');
    head.append(
      el('h3', null, { text: t('intel.prices.title') }),
      buttonRow([
        { label: t('intel.action.exportJson'), onClick: () => exportJson('price-analysis', { result }) },
        { label: t('intel.action.exportMd'), onClick: () => exportMarkdown('price-analysis', pricesMarkdown(result)) }
      ])
    );
    const groups = el('div', 'result-block');
    groups.append(el('h4', null, { text: t('intel.prices.groups') }));
    groups.append(metricGrid([
      [t('intel.group.own'), result.groups.own.count ? `${t('intel.stats.count')} ${result.groups.own.count} · ${t('intel.stats.average')} ${fmt(result.groups.own.average)}` : '-'],
      [t('intel.group.competitor'), result.groups.competitor.count ? `${t('intel.stats.count')} ${result.groups.competitor.count} · ${t('intel.stats.average')} ${fmt(result.groups.competitor.average)}` : '-']
    ]));
    const costs = el('div', 'result-block');
    costs.append(el('h4', null, { text: t('intel.prices.costs') }));
    costs.append(result.costs.feasible
      ? metricGrid([
        [t('intel.result.breakEven'), fmt(result.costs.breakEvenPrice)],
        [t('intel.prices.suggested'), fmt(result.costs.suggestedPrice)]
      ])
      : el('p', 'empty-inline', { text: t('intel.prices.infeasible') }));

    pricesResultEl.append(
      head,
      metricGrid([
        [t('intel.stats.count'), String(result.stats.count)],
        [t('intel.stats.min'), fmt(result.stats.min)],
        [t('intel.stats.max'), fmt(result.stats.max)],
        [t('intel.stats.average'), fmt(result.stats.average)],
        [t('intel.stats.median'), fmt(result.stats.median)],
        [t('intel.stats.p25'), fmt(result.stats.p25)],
        [t('intel.stats.p75'), fmt(result.stats.p75)],
        [t('intel.stats.stddev'), fmt(result.stats.standardDeviation)]
      ]),
      credibilityCard(result.dataCredibility),
      confidenceCard(result.confidence),
      groups,
      costs,
      aiBlock('prices')
    );
  }

  /* ---------- AI review ---------- */

  async function runAiReview(kind) {
    const result = kind === 'score' ? scoreResult : kind === 'compare' ? compareResult : pricesResult;
    if (!result || aiBusy) return;
    aiBusy = kind;
    aiErrors[kind] = '';
    renderAiFor(kind);
    try {
      aiResults[kind] = await postIntel('/api/intel/interpret', { kind, result });
    } catch (error) {
      aiErrors[kind] = error && error.message ? error.message : t('intel.ai.failed');
      aiResults[kind] = null;
    } finally {
      aiBusy = '';
      renderAiFor(kind);
    }
  }

  function renderAiFor(kind) {
    if (kind === 'score') renderScoreResult();
    else if (kind === 'compare') renderCompareResult();
    else renderPricesResult();
  }

  function aiBlock(kind) {
    const block = el('div', 'result-block');
    block.append(el('h4', null, { text: t('intel.ai.title') }));
    if (aiBusy === kind) {
      block.append(el('p', 'empty-inline', { text: t('intel.ai.running') }));
      return block;
    }
    const review = aiResults[kind];
    if (!review) {
      block.append(buttonRow([{ label: t('intel.ai.review'), onClick: () => runAiReview(kind), kind }]));
      if (aiErrors[kind]) block.append(el('p', 'empty-inline', { text: aiErrors[kind] }));
      return block;
    }
    const summaryRow = el('div', 'review-summary');
    summaryRow.append(
      credBadge(review.confidence.level),
      el('span', 'summary-chip', { text: `${t('intel.ai.confidence')}: ${review.confidence.score} / 100` })
    );
    block.append(summaryRow);
    block.append(el('p', null, { text: review.summary }));
    if (review.caveats.length) {
      block.append(el('h4', null, { text: t('intel.ai.caveats') }));
      block.append(chipList(review.caveats, (item) => item));
    }
    if (review.recommendations.length) {
      block.append(el('h4', null, { text: t('intel.ai.recommendations') }));
      block.append(chipList(review.recommendations, (item) => item));
    }
    block.append(buttonRow([{ label: t('intel.ai.review'), onClick: () => runAiReview(kind), kind }]));
    return block;
  }

  /* ---------- Candidates ---------- */

  function readCandidates() {
    try {
      const saved = JSON.parse(localStorage.getItem(CANDIDATES_KEY) || '[]');
      return Array.isArray(saved) ? saved.slice(0, 20) : [];
    } catch {
      return [];
    }
  }

  function writeCandidates(entries) {
    try {
      localStorage.setItem(CANDIDATES_KEY, JSON.stringify(entries.slice(0, 20)));
    } catch {
      // Optional.
    }
  }

  function saveCandidate() {
    if (!scoreResult) return;
    const entry = {
      id: `candidate-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      savedAt: new Date().toISOString(),
      input: readScoreInput(),
      result: scoreResult
    };
    writeCandidates([entry, ...readCandidates()]);
    renderCandidates();
    setStatus(scoreStatus, t('intel.status.saved'));
  }

  function renderCandidates() {
    const entries = readCandidates();
    candidateList.replaceChildren();
    if (!entries.length) {
      candidateList.append(el('p', 'empty-inline', { text: t('intel.candidates.empty') }));
      return;
    }
    for (const entry of entries) {
      const item = el('div', 'intel-candidate');
      const info = el('div', 'history-main');
      const meta = el('span', 'history-meta');
      meta.append(credBadge(entry.result.confidence.level));
      meta.append(document.createTextNode(` ${t(`intel.verdict.${entry.result.verdict}`)} · ${entry.result.totalScore}/100 · ${t('intel.savedAt')} ${new Date(entry.savedAt).toLocaleString(locale === 'en' ? 'en-US' : 'zh-CN')}`));
      info.append(el('strong', null, { text: entry.result.name || entry.input.name || '-' }), meta);
      const actions = buttonRow([
        {
          label: t('action.restore'),
          onClick: () => {
            fillScoreInput(entry.input);
            scoreResult = entry.result;
            renderScoreResult();
            setStatus(scoreStatus, t('intel.status.restored'));
          }
        },
        {
          label: t('action.delete'),
          onClick: () => {
            writeCandidates(readCandidates().filter((row) => row.id !== entry.id));
            renderCandidates();
            setStatus(scoreStatus, t('intel.status.deleted'));
          }
        }
      ]);
      item.append(info, actions);
      candidateList.append(item);
    }
  }

  /* ---------- Events ---------- */

  scoreForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = readScoreInput();
    if (!input.name || input.price <= 0) {
      setStatus(scoreStatus, t('intel.status.needScore'), true);
      return;
    }
    setStatus(scoreStatus, t('intel.status.calculating'));
    try {
      scoreResult = await postIntel('/api/intel/score', input);
      aiResults.score = null;
      aiErrors.score = '';
      renderScoreResult();
      setStatus(scoreStatus, '');
    } catch (error) {
      scoreResult = null;
      renderScoreResult();
      setStatus(scoreStatus, error.message, true);
    }
  });

  compareForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = {
      productName: valueOf('#compare-name'),
      price: numberOf('#compare-price'),
      sellingPoints: valueOf('#compare-points').split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
      competitors: readCompetitors()
    };
    if (payload.price <= 0 || payload.competitors.length === 0) {
      setStatus(compareStatus, t('intel.status.needCompare'), true);
      return;
    }
    setStatus(compareStatus, t('intel.status.calculating'));
    try {
      compareResult = await postIntel('/api/intel/compare', payload);
      aiResults.compare = null;
      aiErrors.compare = '';
      renderCompareResult();
      setStatus(compareStatus, '');
    } catch (error) {
      compareResult = null;
      renderCompareResult();
      setStatus(compareStatus, error.message, true);
    }
  });

  pricesForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = {
      points: readPricePoints(),
      unitCost: numberOf('#prices-unit-cost'),
      shippingCost: numberOf('#prices-shipping'),
      platformFeeRate: numberOf('#prices-fee'),
      targetMarginRate: numberOf('#prices-target-margin'),
      adCostPerUnit: numberOf('#prices-ad-cost')
    };
    if (payload.points.filter((point) => point.price > 0).length === 0) {
      setStatus(pricesStatus, t('intel.status.needPrices'), true);
      return;
    }
    setStatus(pricesStatus, t('intel.status.calculating'));
    try {
      pricesResult = await postIntel('/api/intel/prices', payload);
      aiResults.prices = null;
      aiErrors.prices = '';
      renderPricesResult();
      setStatus(pricesStatus, '');
    } catch (error) {
      pricesResult = null;
      renderPricesResult();
      setStatus(pricesStatus, error.message, true);
    }
  });

  addCompetitor.addEventListener('click', () => addCompetitorRow());
  addPrice.addEventListener('click', () => addPriceRow());
  exportCandidates.addEventListener('click', () => {
    exportJson('candidates', { candidates: readCandidates() });
    setStatus(scoreStatus, t('intel.status.exported'));
  });

  initTheme();
  initLocale();
  addCompetitorRow();
  addPriceRow({ label: t('intel.group.own'), type: 'own', sourceType: 'merchant_record' });
  addPriceRow({ type: 'competitor' });
  loadHealth();
})();
