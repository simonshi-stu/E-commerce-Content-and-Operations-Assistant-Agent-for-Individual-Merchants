(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const state = { result: null, busy: false };

  function text(value, fallback = '-') { return value === undefined || value === null || value === '' ? fallback : String(value); }
  function number(value, digits = 0) {
    if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) return '-';
    return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: digits }).format(Number(value));
  }
  function money(value) { return value === null || value === undefined ? '-' : `US$${Number(value).toFixed(2)}`; }
  function setStatus(value, error = false) { $('sourcing-status').textContent = value || ''; $('sourcing-status').classList.toggle('error', error); }
  function node(tag, value, cls) { const element = document.createElement(tag); if (value !== undefined) element.textContent = value; if (cls) element.className = cls; return element; }

  function renderMetrics(metrics) {
    const price = metrics?.price || {}, rating = metrics?.rating || {}, reviews = metrics?.reviews || {}, weight = metrics?.weight || {}, negative = metrics?.negativeReviewRate || {};
    const negativeValue = negative.ratePct === null || negative.ratePct === undefined ? '-' : `${number(negative.ratePct, 2)}%`;
    const negativeBasis = negative.basis === 'amazon_rating_histogram' ? '公开星级分布' : negative.basis === 'visible_review_sample' ? '可见评论样本' : '暂无可用口径';
    const items = [
      ['详情页', number(metrics?.productPages)], ['价格中位', money(price.median)], ['平均评分', rating.average === undefined ? '-' : `${number(rating.average, 2)} / 5`],
      ['评论数中位', number(reviews.median)], ['重量中位', weight.medianGrams ? `${number(weight.medianGrams, 1)} g` : '-'], ['差评率', `${negativeValue} · ${negativeBasis}`]
    ];
    $('sourcing-metrics').replaceChildren(...items.map(([label, value]) => { const card = node('div', undefined, 'sourcing-metric'); card.append(node('small', label), node('strong', value)); return card; }));
  }

  function renderFeatures(features) {
    const box = $('sourcing-features-table'); box.replaceChildren();
    const rows = (features || []).filter((item) => item.count > 0);
    if (!rows.length) { box.append(node('p', '未在已读取的详情页文字中发现已配置的关注特征。', 'sourcing-empty')); return; }
    const denominator = state.result?.metrics?.productPages || 1;
    rows.forEach((item) => {
      const row = node('div', undefined, 'sourcing-feature-row');
      row.append(node('span', item.label), node('span', undefined, 'sourcing-bar'));
      const bar = row.children[1]; const fill = document.createElement('span'); fill.style.width = `${Math.min(100, Number(item.sharePct || item.count / denominator * 100))}%`; bar.append(fill);
      row.append(node('strong', `${number(item.count)} / ${number(denominator)} · ${number(item.sharePct, 1)}%`)); box.append(row);
    });
  }

  function renderThemes(themes) {
    const box = $('sourcing-themes'); box.replaceChildren();
    if (!(themes || []).length) { box.append(node('p', '没有足够的公开评论样本生成问题主题。', 'sourcing-empty')); return; }
    themes.forEach((item) => { const row = node('div', undefined, 'sourcing-theme-row'); row.append(node('span', item.tag), node('span', '评论样本命中'), node('strong', number(item.count))); box.append(row); });
  }

  function appendList(parent, title, values) {
    const section = node('div'); section.append(node('strong', title));
    if (!values?.length) { section.append(node('span', ' 未抓取到公开样本')); parent.append(section); return; }
    const list = node('ul'); values.slice(0, 3).forEach((value) => list.append(node('li', value))); section.append(list); parent.append(section);
  }

  function renderProduct(item) {
    const card = node('article', undefined, 'sourcing-product');
    if (item.image) { const image = node('img', undefined, 'sourcing-product-image'); image.src = item.image; image.alt = item.title || item.asin || '商品图片'; image.loading = 'lazy'; card.append(image); }
    else card.append(node('div', 'PDP', 'sourcing-product-image'));
    const body = node('div', undefined, 'sourcing-product-body');
    const heading = node('h4');
    if (item.url) { const link = node('a', item.title || item.asin || '未命名商品'); link.href = item.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; heading.append(link); }
    else heading.textContent = item.title || item.asin || '未命名商品';
    body.append(heading, node('small', `${item.brand || '品牌未读出'} · ${item.asin || 'ASIN 未读出'}`, 'wb-muted'));
    const meta = node('div', undefined, 'sourcing-product-meta');
    [[money(item.price), false], [`${text(item.rating)} / 5`, false], [`${number(item.reviewCount)} 条评论`, false], [item.weight?.grams ? `${number(item.weight.grams, 1)} g` : text(item.itemWeight, '重量未读出'), false], [item.negativeReviewRate?.negativeRatePct === null || item.negativeReviewRate?.negativeRatePct === undefined ? '差评率暂无' : `差评率 ${number(item.negativeReviewRate.negativeRatePct, 2)}%`, false]].forEach(([value]) => meta.append(node('span', value, 'sourcing-tag')));
    (item.features || []).filter((feature) => feature.present).slice(0, 8).forEach((feature) => meta.append(node('span', feature.label, 'sourcing-tag is-feature')));
    body.append(meta); card.append(body);
    const detail = node('div', undefined, 'sourcing-product-detail');
    if (item.performance?.customerSummary) detail.append(node('p', `页面 Customers say：${item.performance.customerSummary}`));
    appendList(detail, '详情页性能/规格声明', item.performance?.pageClaims);
    appendList(detail, '可见好评样本', item.positives);
    appendList(detail, '可见差评样本', item.negatives);
    if (item.negativeReviewRate?.basis) detail.append(node('small', `差评率口径：${item.negativeReviewRate.basis === 'amazon_rating_histogram' ? 'Amazon 页面星级分布' : item.negativeReviewRate.basis === 'visible_review_sample' ? `可见评论样本（${number(item.negativeReviewRate.sampleCount)} 条）` : '暂无'}`, 'wb-muted'));
    card.append(detail); return card;
  }

  function renderCandidates(candidates) {
    const panel = $('sourcing-candidates-panel'); const box = $('sourcing-candidates'); box.replaceChildren(); panel.hidden = !(candidates || []).length;
    (candidates || []).forEach((item) => { const row = node('div', undefined, 'sourcing-candidate'); const title = node('span', `${item.position ? `#${item.position} ` : ''}${item.title || item.asin || '未命名候选'}`); const detail = node('span', `${money(item.price)} · ${text(item.rating)} / 5 · ${number(item.reviews)} 条`); if (item.url) { const link = node('a', '打开'); link.href = item.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; row.append(title, detail, link); } else row.append(title, detail); box.append(row); });
  }

  function renderResult(result) {
    state.result = result;
    $('sourcing-results').hidden = false;
    $('sourcing-provenance').textContent = `品类：${result.category || '-'} · 需求：${result.userNeed || '未填写'} · 检索词：${(result.provenance?.queries || []).join(' / ') || '-'} · 观察日期：${result.provenance?.observedAt || '-'} · 页面请求 ${number(result.provenance?.requests)} 次`;
    renderMetrics(result.metrics); renderFeatures(result.features); renderThemes(result.negativeThemes); renderCandidates(result.searchCandidates);
    $('sourcing-products').replaceChildren(...(result.products || []).map(renderProduct));
    $('sourcing-product-count').textContent = `${number(result.products?.length || 0)} 个可读详情页`;
    const errors = $('sourcing-errors'); errors.replaceChildren(); (result.errors || []).forEach((error) => errors.append(node('p', `${error.stage || '研究'} · ${error.code || 'error'}：${error.message || '页面不可读'}`, 'sourcing-error')));
  }

  function download(value, name, type) { const url = URL.createObjectURL(new Blob([value], { type })); const link = node('a'); link.href = url; link.download = name; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  function exportCsv() {
    if (!state.result) return;
    const header = ['asin', 'title', 'brand', 'price_usd', 'rating', 'review_count', 'negative_rate_pct', 'negative_rate_basis', 'weight_grams', 'features', 'url'];
    const rows = state.result.products.map((item) => [item.asin, item.title, item.brand, item.price ?? '', item.rating ?? '', item.reviewCount ?? '', item.negativeReviewRate?.negativeRatePct ?? '', item.negativeReviewRate?.basis || '', item.weight?.grams ?? '', (item.features || []).filter((feature) => feature.present).map((feature) => feature.label).join('|'), item.url]);
    const csv = [header, ...rows].map((row) => row.map((value) => `"${String(value ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
    download(`\ufeff${csv}`, 'category-pdp-insights.csv', 'text/csv;charset=utf-8');
  }

  $('sourcing-run').addEventListener('click', async () => {
    if (state.busy) return;
    const category = $('sourcing-category').value.trim(); if (!category) { setStatus('请先填写产品大类。', true); $('sourcing-category').focus(); return; }
    state.busy = true; $('sourcing-run').disabled = true; setStatus('正在读取 Amazon.com 公开搜索页和商品详情页；页面不可访问会记录为缺口。');
    try {
      const response = await fetch('/api/sourcing/insights', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        category, userNeed: $('sourcing-need').value.trim(), marketplace: $('sourcing-market').value.trim(), featureHints: $('sourcing-features').value.trim(), queries: $('sourcing-queries').value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean), maxProductPages: Number($('sourcing-pages').value), includeReviewPages: $('sourcing-reviews').checked
      }) });
      const body = await response.json(); if (!response.ok) throw new Error(body?.error?.message || `HTTP ${response.status}`);
      renderResult(body.data); setStatus(`研究完成：读取到 ${body.data.products?.length || 0} 个可读商品详情页；未输出成本或利润结论。`);
    } catch (error) { setStatus(error.message || '研究失败。', true); }
    finally { state.busy = false; $('sourcing-run').disabled = false; }
  });
  $('sourcing-json').addEventListener('click', () => { if (state.result) download(JSON.stringify(state.result, null, 2), 'category-pdp-insights.json', 'application/json'); });
  $('sourcing-csv').addEventListener('click', exportCsv);
  $('sourcing-theme').addEventListener('click', () => { const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = next; try { localStorage.setItem('ecommerce-content-assistant-theme', next); } catch { /* optional */ } });
  try { document.documentElement.dataset.theme = localStorage.getItem('ecommerce-content-assistant-theme') === 'light' ? 'light' : 'dark'; } catch { /* optional */ }
  const params = new URLSearchParams(location.search);
  if (params.has('category')) $('sourcing-category').value = params.get('category').slice(0, 160);
  if (params.has('market')) $('sourcing-market').value = params.get('market').slice(0, 120);
  if (params.has('need')) $('sourcing-need').value = params.get('need').slice(0, 500);
})();
