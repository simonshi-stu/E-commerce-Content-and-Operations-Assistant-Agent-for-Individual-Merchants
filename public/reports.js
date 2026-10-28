(() => {
  'use strict';

  const i18n = window.APP_I18N;
  const THEME_KEY = 'ecommerce-content-assistant-theme';
  const LOCALE_KEY = 'ecommerce-content-assistant-locale';
  const copy = {
    zh: {
      eyebrow: 'STAGE 3 · REPORT FACTORY', titleLead: '把公开证据，', titleAccent: '整理成可复用的 Excel 工作台',
       subtitle: '通用报告与无 PDF 任务共用人工确认门；可逐配置核对准入证据、查看带图 Excel 预览，正式下载仍须独立审核。',
       archiveNote: '下方卡片仅用于展示报告结构，不代表任何真实商品、供应商或利润结论；请以当前任务的配置级证据和人工确认结果为准。',
      controlTitle: '生成设置', idle: '等待任务', running: '生成中', completed: '已完成', failed: '生成失败',
      controlHint: '默认复用已经抓取的 Amazon 前台证据，适合快速重新排版。需要更新市场数据时，再开启重新采集。',
       refreshAmazon: '重新采集 Amazon 商品页', refreshAmazonHint: '只访问 amazon.com 公开商品详情页，不登录、不访问后台；请求数量取决于当前任务。',
      refreshSummary: '重新生成竞品评价归纳', refreshSummaryHint: '使用商品页公开 Customers say 和评价主题；需要配置 DeepSeek API Key。',
      delayLabel: '公开页请求间隔（毫秒）', observedLabel: '观察日期', build: '生成两份 Excel 报告', refresh: '刷新状态',
      boundary: '数据边界：只使用 Amazon.com 公开前台；评论列表页要求登录时不绕过；销量只显示公开购买标签和评论数 ÷ 0.01 的粗估，不伪造后台销量。',
      progressTitle: '工作流进度', progressFoot: '每一步都保留可核验的来源与口径，最后才进入 Excel 排版。', overviewTitle: '当前数据底座',
      marketFlowTitle: '市场拆分结果', scoreFlowTitle: '产品决策结果', detailTitle: '决策明细', detailHint: '把 Excel 首页的结论先放到网页上，下载后仍保留完整逐款 Sheet。',
       competitorKicker: '公开市场竞品研究', competitorTitle: '公开市场竞品研究', competitorDesc: '按当前任务的关键词和可比配置整理公开商品页、价格、评价和来源证据。',
       assessmentKicker: '产品进入评估', assessmentTitle: '产品市场进入评估', assessmentDesc: '按型号、品类、证据和配置生成产品页；示例内容仅用于演示结构。', download: '下载 Excel',
       priorityTitle: '首批推荐', methodTitle: '评分结构', allProducts: '查看全部产品评分', allProductsHint: '按综合分排序；不改变 Excel 的逐款深度 Sheet', stepCatalog: '目录识别', stepCatalogHint: '型号 + 品类去重，变体归并', stepMarket: '市场清洗', stepMarketHint: '按当前任务配置市场分组', stepEvidence: '前台取证', stepEvidenceHint: '图片、价格、评价摘要、配置证据', stepScore: '产品决策', stepScoreHint: '合规硬门槛 + 评分', stepLayout: 'Excel排版', stepLayoutHint: '总览、市场组、逐款产品页', footerLabel: 'Notice:', footer: '这是本地研究和报告生成工具，不会自动发布内容、修改价格或操作平台账号。认证、成本、图片和产品结论仍需人工核验。',
      noData: '生成报告后，这里会显示结构化结果。', noFile: '尚未生成文件', noPriority: '暂无首批推荐结果。', noMarket: '暂无市场组结果。',
      catalogRows: '目录原始行', productFamilies: '去重产品', amazonRecords: 'Amazon前台记录', aiSummaries: '评价归纳', pdf: 'PDF原图',
      yes: '可用', no: '未提供', sourceBasis: '数据口径', observed: '观察日期', records: '条记录', families: '个产品', summaries: '款已归纳',
      sheets: '个 Sheet', images: '张嵌入图片', path: '生成路径', modified: '更新时间', bytes: '文件大小', sample: '样本', medianPrice: '价格中位', avgRating: '平均评分', reviewMedian: '评论中位', demand: '月购买下限', friendliness: '进入友好度',
      rank: '排名', model: '型号', name: '中文名', segment: '品类', score: '综合分', verdict: '结论', priority: '首批推荐', pilot: '第二批试点', hold: '暂缓',
      scoreCompliance: '合规 30', scoreMarket: '市场 25', scoreValue: '价格 15', scoreDiff: '差异 20', scoreReady: '资料 10',
      stageCatalog: '读取目录并识别型号 + 品类去重键', stageMarket: '完成市场清洗、受众证据和搜索展示位拆分', stageAmazon: '采集/复用 Amazon 公开商品页证据', stageScoring: '完成产品拆分、中文命名、合规硬门槛和评分', stageXlsx: '生成两个多 Sheet Excel 并完成结构验证',
       retry: '重新生成', apiKeyHint: '当前未配置模型 Key，不能重新生成评价归纳；可取消该选项并使用已缓存归纳。', preparing: '准备报告工作流', buildCompleted: '两个 Excel 报告已生成并完成结构验证',
       workbenchTitle: '通用报告任务', workbenchHint: '可上传供应商 PDF，也可直接创建无 PDF 手工建档任务；每个截图型号/配置单独录入成本并人工确认后，再进行 Amazon 研究和逐款定价。',
       entryPdf: 'PDF 目录分析', entryTrack: '赛道 / 无 PDF 手工建档',
      dropTitle: '选择或拖入 PDF 产品目录', dropHint: '只在本机解析；文本型 PDF 可直接拆解，扫描件会标记为需要人工确认，不会伪造内容。',
      fieldCategory: '品类', fieldCountry: '目标国家', fieldMarketplace: '目标站点', fieldAudience: '受众', fieldPrice: '价格带',
      fieldQuestions: '研究问题（每行一条）', fieldGroups: '市场分组（每行：分组名 | 关键词1,关键词2）',
      trackCreate: '创建赛道任务', analysisTitle: '初步拆解与人工确认', confirm: '确认并继续', research: '研究准备', generate: '生成 Excel',
      previewTitle: 'Excel 在线预览', downloadExcel: '下载 Excel', loadMore: '加载更多', jobIdle: '未开始',
      jobMetaFile: '文件', jobMetaPages: '页数', jobMetaMode: '解析模式', jobMetaConfidence: '置信度', jobMetaJobs: '任务类型',
      textModeText: '文本型', textModeScanned: '扫描/图片型（需人工确认）', textModeUnreadable: '无法解析（需人工确认）',
      ocrNote: '该 PDF 未提取到足够文本，无法自动拆解；请人工确认或补充字段后再继续。',
       categoriesTitle: '候选品类（可修改）', rulePackLabel: '规则包', productsTitle: '用户产品 SKU / 配置（每种配置单独计价）',
      productName: '产品名', productModel: '型号', productMissing: '缺失字段', productKeep: '保留', productMergeNext: '合并下一行', productSplit: '拆分一行', productReject: '移除',
      noProducts: '未识别到产品行，可人工新增或直接确认后继续。', addProduct: '新增一行',
      briefTitle: '研究设置（确认后生效）', trackCategoryRequired: '请先填写品类。',
      statusUploaded: '已上传', statusExtracting: '解析中', statusAwaiting: '等待人工确认', statusConfirmed: '已确认',
      statusResearching: '研究准备中', statusScoring: '评分准备中', statusBuilding: '生成中', statusCompleted: '已完成', statusFailed: '失败',
      confirmSaved: '已保存人工确认，可以研究准备或直接生成 Excel。', researchReady: '已执行研究准备，可以生成 Excel。',
      buildDone: '当前版本 Excel 和预览 manifest 已完成。', confirmFirst: '请先完成人工确认。',
      uploadDone: '目录初步拆解完成，请人工确认。', uploadFailed: 'PDF 上传或解析失败。',
      previewLoadFailed: 'Excel 已生成，但预览加载失败。可直接下载当前版本。', previewStale: '预览版本与当前任务不一致，已隐藏旧预览。',
      previewFrozen: '冻结', previewRows: '行', previewSource: '预览数据与下载文件同版本'
    },
    en: {
      eyebrow: 'STAGE 3 · REPORT FACTORY', titleLead: 'Turn public evidence into ', titleAccent: 'reusable Excel workbooks',
      subtitle: 'Generic reports and no-PDF jobs share manual confirmation gates. Review each configuration and its image evidence in the workbook preview; independent audit is still required before download.',
       archiveNote: 'The cards below demonstrate report structure only. They do not represent a real product, supplier, or profit conclusion; use the current job’s evidence and manual confirmations.',
      controlTitle: 'Build settings', idle: 'Idle', running: 'Building', completed: 'Completed', failed: 'Failed',
      controlHint: 'The default build reuses captured Amazon evidence for a fast rebuild. Turn on refresh only when the public market evidence should be updated.',
       refreshAmazon: 'Refresh Amazon product pages', refreshAmazonHint: 'Public amazon.com product pages only; no login or seller backend. Request count depends on the current job.',
      refreshSummary: 'Regenerate competitor commentary', refreshSummaryHint: 'Uses public Customers say and aspect summaries; requires a DeepSeek API key.',
      delayLabel: 'Public-page delay (ms)', observedLabel: 'Observed date', build: 'Build both Excel reports', refresh: 'Refresh status',
      boundary: 'Boundary: Amazon.com public front end only. Login-gated review pages are not bypassed. Demand is shown as public purchase signals and the reviews ÷ 0.01 rough proxy, never backend sales.',
      progressTitle: 'Workflow progress', progressFoot: 'Each step keeps its source and measurement basis before the workbook layout is produced.', overviewTitle: 'Current data foundation',
      marketFlowTitle: 'Market segmentation', scoreFlowTitle: 'Product decisions', detailTitle: 'Decision detail', detailHint: 'The workbook homepage is surfaced here first; the downloaded file keeps the full product-level sheets.',
       competitorKicker: 'Public market research', competitorTitle: 'Public market competitor research', competitorDesc: 'Organize public product pages, prices, reviews, and source evidence by the current job’s keywords and comparable configurations.',
       assessmentKicker: 'Product entry assessment', assessmentTitle: 'Product market-entry assessment', assessmentDesc: 'Product sheets are organized by model, category, evidence, and configuration. Example content is structural only.', download: 'Download Excel',
       priorityTitle: 'First-wave recommendations', methodTitle: 'Scoring model', allProducts: 'View all product scores', allProductsHint: 'Sorted by composite score; the workbook keeps the full product sheets', stepCatalog: 'Catalog identity', stepCatalogHint: 'Deduplicate by model + category', stepMarket: 'Market cleaning', stepMarketHint: 'Configured market groups and evidence', stepEvidence: 'Public evidence', stepEvidenceHint: 'Images, price, review summary, and configuration', stepScore: 'Product decision', stepScoreHint: 'Compliance gate + evidence-based score', stepLayout: 'Excel layout', stepLayoutHint: 'Overview, markets, product sheets', footerLabel: 'Notice:', footer: 'This is a local research and report tool. It never publishes, changes prices, or operates platform accounts. Verify certifications, costs, images, and conclusions manually.',
      noData: 'Structured results will appear here after a build.', noFile: 'No file generated yet', noPriority: 'No first-wave recommendation yet.', noMarket: 'No market groups yet.',
      catalogRows: 'Catalog rows', productFamilies: 'Deduplicated products', amazonRecords: 'Amazon records', aiSummaries: 'Commentaries', pdf: 'PDF source images',
      yes: 'Available', no: 'Not provided', sourceBasis: 'Data basis', observed: 'Observed', records: ' records', families: ' products', summaries: ' summarized',
      sheets: ' sheets', images: ' embedded images', path: 'Output path', modified: 'Updated', bytes: 'File size', sample: 'Sample', medianPrice: 'Median price', avgRating: 'Avg rating', reviewMedian: 'Median reviews', demand: 'Monthly purchase floor', friendliness: 'Entry friendliness',
      rank: 'Rank', model: 'Model', name: 'Chinese name', segment: 'Segment', score: 'Score', verdict: 'Verdict', priority: 'First wave', pilot: 'Pilot', hold: 'Hold',
      scoreCompliance: 'Compliance 30', scoreMarket: 'Market 25', scoreValue: 'Price 15', scoreDiff: 'Differentiation 20', scoreReady: 'Readiness 10',
      stageCatalog: 'Read catalog and build model + category keys', stageMarket: 'Clean markets, audience evidence, and display positions', stageAmazon: 'Collect/reuse public Amazon product-page evidence', stageScoring: 'Split products, name them, apply gates, and score', stageXlsx: 'Build and structurally validate both multi-sheet workbooks',
       retry: 'Build again', apiKeyHint: 'No model key is configured, so commentary refresh is unavailable. Disable it to use cached commentary.', preparing: 'Preparing report workflow', buildCompleted: 'Both Excel workbooks were generated and structurally validated.',
       workbenchTitle: 'Generic report jobs', workbenchHint: 'Upload a supplier PDF or create a no-PDF manual catalog job. Enter each screenshot SKU/configuration as its own product, attach cost evidence, confirm it, and then run Amazon research and per-SKU pricing.',
       entryPdf: 'PDF catalog analysis', entryTrack: 'Track / no-PDF manual entry',
      dropTitle: 'Choose or drop a PDF catalog', dropHint: 'Parsed locally only. Text PDFs are extracted; scanned files are marked for manual confirmation instead of fabricating content.',
      fieldCategory: 'Category', fieldCountry: 'Target country', fieldMarketplace: 'Marketplace', fieldAudience: 'Audience', fieldPrice: 'Price band',
      fieldQuestions: 'Research questions (one per line)', fieldGroups: 'Market groups (per line: label | keyword1,keyword2)',
      trackCreate: 'Create track job', analysisTitle: 'Initial parsing and manual confirmation', confirm: 'Confirm and continue', research: 'Prepare research', generate: 'Build Excel',
      previewTitle: 'Excel preview', downloadExcel: 'Download Excel', loadMore: 'Load more', jobIdle: 'Not started',
      jobMetaFile: 'File', jobMetaPages: 'Pages', jobMetaMode: 'Parse mode', jobMetaConfidence: 'Confidence', jobMetaJobs: 'Task',
      textModeText: 'Text', textModeScanned: 'Scanned / image-only (needs confirmation)', textModeUnreadable: 'Unreadable (needs confirmation)',
      ocrNote: 'Not enough text was extracted from this PDF, so automatic parsing is unavailable. Confirm or fill in fields manually before continuing.',
       categoriesTitle: 'Category candidates (editable)', rulePackLabel: 'Rule pack', productsTitle: 'Uploaded product SKUs / configurations (price each configuration separately)',
      productName: 'Name', productModel: 'Model', productMissing: 'Missing fields', productKeep: 'Keep', productMergeNext: 'Merge next', productSplit: 'Split row', productReject: 'Remove',
      noProducts: 'No product rows were identified. Add rows manually or confirm and continue.', addProduct: 'Add row',
      briefTitle: 'Research brief (applies after confirmation)', trackCategoryRequired: 'Enter a category first.',
      statusUploaded: 'Uploaded', statusExtracting: 'Parsing', statusAwaiting: 'Awaiting confirmation', statusConfirmed: 'Confirmed',
      statusResearching: 'Preparing research', statusScoring: 'Preparing scoring', statusBuilding: 'Building', statusCompleted: 'Completed', statusFailed: 'Failed',
      confirmSaved: 'Confirmation saved. You can prepare research or build the Excel.', researchReady: 'Research preparation done. You can build the Excel.',
      buildDone: 'The Excel workbook and its preview manifest are ready.', confirmFirst: 'Confirm the inputs first.',
      uploadDone: 'Initial parsing finished. Confirm the catalog to continue.', uploadFailed: 'The PDF upload or parse failed.',
      previewLoadFailed: 'The Excel was generated but the preview failed to load. Download the current version directly.', previewStale: 'The preview version does not match the current task; the stale preview was hidden.',
      previewFrozen: 'Frozen', previewRows: 'rows', previewSource: 'Preview and download share the same job version'
    }
  };

  const themeSwitch = document.querySelector('#theme-switch');
  const languageSwitch = document.querySelector('#language-switch');
  const healthChip = document.querySelector('#health-chip');
  const healthText = document.querySelector('#health-text');
  const buildButton = document.querySelector('#report-build');
  const refreshStatusButton = document.querySelector('#report-refresh-status');
  const refreshAmazon = document.querySelector('#report-refresh-amazon');
  const refreshSummary = document.querySelector('#report-refresh-summary');
  const delayInput = document.querySelector('#report-delay');
  const observedInput = document.querySelector('#report-observed');
  const statusEl = document.querySelector('#report-status');
  const jobChip = document.querySelector('#report-job-chip');
  const progressText = document.querySelector('#report-progress-text');
  const progressFill = document.querySelector('#report-progress-fill');
  const stagesEl = document.querySelector('#report-stages');
  const sourceMetrics = document.querySelector('#report-source-metrics');
  const marketTable = document.querySelector('#report-market-table');
  const scoreSummary = document.querySelector('#report-score-summary');
  const priorityList = document.querySelector('#report-priority-list');
  const methodList = document.querySelector('#report-method-list');
  const allProductsTable = document.querySelector('#report-all-products-table');
  const observedChip = document.querySelector('#report-observed-chip');
  const workflowAuditEl = document.querySelector('#report-workflow-audit');
  const workflowAuditStatus = document.querySelector('#report-workflow-audit-status');
  const workflowAuditMeta = document.querySelector('#report-workflow-audit-meta');
  const workflowReviewer = document.querySelector('#report-workflow-reviewer');
  const workflowIssues = document.querySelector('#report-workflow-issues');
  const workflowRepairWrap = document.querySelector('#report-workflow-repair-wrap');
  const workflowRepairNotes = document.querySelector('#report-workflow-repair-notes');
  const workflowApprove = document.querySelector('#report-workflow-approve');
  const workflowReturn = document.querySelector('#report-workflow-return');
  const workflowAuditActionStatus = document.querySelector('#report-workflow-audit-action-status');
  const workflowAuditHistory = document.querySelector('#report-workflow-audit-history');
  let locale = i18n.detect();
  let state = null;
  let pollTimer = null;

  const stageKeys = ['catalog', 'market', 'amazon', 'scoring', 'xlsx'];

  function t(key) {
    return (copy[locale] && copy[locale][key]) || copy.zh[key] || key;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function fmt(value, digits = 0) {
    if (value === undefined || value === null || value === '') return '-';
    return new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'zh-CN', { maximumFractionDigits: digits }).format(Number(value));
  }

  function money(value) {
    return Number(value) > 0 ? `US$${Number(value).toFixed(2)}` : '-';
  }

  function fileSize(value) {
    if (!Number(value)) return '-';
    if (value > 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
    return `${Math.ceil(value / 1024)} KB`;
  }

  function setStatus(message, error = false) {
    statusEl.textContent = message || '';
    statusEl.classList.toggle('error', error);
  }

  function progressMessage(progress, fallbackKey) {
    const message = String(progress?.message || '').trim();
    if (locale === 'zh') return message || (fallbackKey ? t(fallbackKey) : '');
    if (progress?.stage === 'starting') return t('preparing');
    if (progress?.stage === 'completed') return t('buildCompleted');
    const amazonMatch = message.match(/Amazon公开商品页\s*(\d+)\/(\d+)/);
    if (amazonMatch) return `Amazon public product pages ${amazonMatch[1]}/${amazonMatch[2]}`;
    if (message.includes('复用已有 Amazon')) return 'Reusing existing Amazon public product-page evidence';
    if (message.includes('Amazon公开商品页采集完成')) return 'Amazon public product pages collected';
    if (message.includes('正在构建竞品报告')) return 'Building competitor workbook';
    if (message.includes('正在构建产品评估报告')) return 'Building assessment workbook';
    if (message.includes('Excel 报告已生成')) return t('buildCompleted');
    return fallbackKey ? t(fallbackKey) : message;
  }

  function applyThemeMode(mode) {
    const resolved = mode === 'auto' ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : mode === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themeMode = mode;
    themeSwitch.querySelectorAll('button').forEach((button) => {
      const active = button.dataset.themeMode === mode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  function initTheme() {
    let saved = 'dark';
    try { saved = localStorage.getItem(THEME_KEY) || 'dark'; } catch { /* optional */ }
    applyThemeMode(saved);
    themeSwitch.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-theme-mode]');
      if (!button) return;
      applyThemeMode(button.dataset.themeMode);
      try { localStorage.setItem(THEME_KEY, button.dataset.themeMode); } catch { /* optional */ }
    });
  }

  function applyLocale(next) {
    locale = i18n.normalize(next);
    document.documentElement.lang = locale === 'en' ? 'en' : 'zh-CN';
    try { localStorage.setItem(LOCALE_KEY, locale); } catch { /* optional */ }
    i18n.applyStatic(document, locale);
    document.querySelectorAll('[data-report]').forEach((node) => {
      const key = node.dataset.report;
      if (copy[locale][key]) node.textContent = copy[locale][key];
    });
    languageSwitch.querySelectorAll('button').forEach((button) => {
      const active = button.dataset.locale === locale;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    renderAll();
    renderJobAll();
  }

  function initLocale() {
    languageSwitch.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-locale]');
      if (button) applyLocale(button.dataset.locale);
    });
    applyLocale(locale);
  }

  async function loadHealth() {
    try {
      const response = await fetch('/api/health');
      const health = await response.json();
      healthChip.classList.remove('is-ok', 'is-warn');
      if (health.configured) {
        healthChip.classList.add('is-ok');
        healthText.textContent = i18n.t(locale, 'health.connected', { model: health.model });
      } else {
        healthChip.classList.add('is-warn');
        healthText.textContent = i18n.t(locale, 'health.unconfigured');
      }
      refreshSummary.disabled = !health.configured;
      refreshSummary.closest('.report-option').classList.toggle('is-disabled', !health.configured);
      refreshSummary.title = health.configured ? '' : t('apiKeyHint');
    } catch {
      healthText.textContent = i18n.t(locale, 'health.unknown');
    }
  }

  function metric(label, value, tone = '') {
    const node = el('div', `metric report-metric ${tone}`);
    node.append(el('span', 'metric-label', label), el('span', 'metric-value', value));
    return node;
  }

  function renderStages() {
    stagesEl.replaceChildren();
    const progress = state?.progress || { stage: 'idle', completed: 0, total: 5 };
    const completed = Number(progress.completed || 0);
    stageKeys.forEach((key, index) => {
      const step = el('li', 'report-stage');
      const done = progress.stage === 'completed' || completed >= index + 1;
      const active = progress.stage === key || (progress.stage === 'starting' && index === 0);
      step.classList.toggle('is-done', done);
      step.classList.toggle('is-active', active && !done);
      step.append(el('span', 'report-stage-number', String(index + 1).padStart(2, '0')));
      const body = el('span', 'report-stage-body');
      const labelKey = key === 'catalog' ? 'stepCatalog' : key === 'market' ? 'stepMarket' : key === 'amazon' ? 'stepEvidence' : key === 'scoring' ? 'stepScore' : 'stepLayout';
      body.append(el('strong', null, t(labelKey)));
      const detailKey = key === 'catalog' ? 'stageCatalog' : key === 'market' ? 'stageMarket' : key === 'amazon' ? 'stageAmazon' : key === 'scoring' ? 'stageScoring' : 'stageXlsx';
       body.append(el('small', null, active ? progressMessage(progress, detailKey) : t(detailKey)));
      step.append(body, el('span', 'report-stage-state', done ? '✓' : active ? '…' : '·'));
      stagesEl.append(step);
    });
  }

  function renderSource(source) {
    sourceMetrics.replaceChildren();
    if (!source) {
      sourceMetrics.append(el('p', 'empty-inline', t('noData')));
      return;
    }
    sourceMetrics.append(
      metric(t('catalogRows'), `${fmt(source.catalogRows)} ${t('records')}`),
      metric(t('productFamilies'), `${fmt(source.productFamilies)} ${t('families')}`),
      metric(t('amazonRecords'), `${fmt(source.amazonRecords)} ${t('records')}`),
      metric(t('aiSummaries'), `${fmt(source.aiSummaries)}${t('summaries')}`),
      metric(t('pdf'), source.pdfAvailable ? t('yes') : t('no'), source.pdfAvailable ? 'is-positive' : 'is-warning')
    );
    observedChip.textContent = source.amazonObservedAt ? `${t('observed')}: ${source.amazonObservedAt}` : '-';
  }

  function renderMarket(groups) {
    marketTable.replaceChildren();
    if (!groups || !groups.length) {
      marketTable.append(el('p', 'empty-inline', t('noMarket')));
      return;
    }
    const table = el('table', 'result-table report-result-table');
    const headers = [t('segment'), t('sample'), t('medianPrice'), t('avgRating'), t('reviewMedian'), t('demand'), t('friendliness')];
    const head = el('tr');
    headers.forEach((header) => head.append(el('th', null, header)));
    const thead = el('thead');
    thead.append(head);
    table.append(thead);
    const body = el('tbody');
    groups.forEach((group) => {
      const row = el('tr');
      [group.label, fmt(group.sample), money(group.medianPrice), fmt(group.averageRating, 2), fmt(group.reviewMedian), `${fmt(group.monthlyBoughtFloor)}+`, `${fmt(group.entryFriendliness)}/100`].forEach((value) => row.append(el('td', null, value)));
      body.append(row);
    });
    table.append(body);
    marketTable.append(table);
  }

  function renderScore(result) {
    scoreSummary.replaceChildren();
    if (!result) {
      scoreSummary.append(el('p', 'empty-inline', t('noData')));
      return;
    }
    const counts = result.counts || {};
    const summary = el('div', 'review-summary report-verdict-summary');
    summary.append(
      el('span', 'summary-chip report-chip-positive', `${t('priority')}: ${fmt(counts['首批推荐'] || 0)}`),
      el('span', 'summary-chip report-chip-warning', `${t('pilot')}: ${fmt(counts['第二批试点'] || 0)}`),
      el('span', 'summary-chip report-chip-negative', `${t('hold')}: ${fmt(counts['暂缓'] || 0)}`)
    );
    scoreSummary.append(summary);
    if (result.priority && result.priority.length) {
      scoreSummary.append(el('p', 'report-score-note', `${t('priority')}: ${result.priority.slice(0, 3).map((item) => `${item.model} ${item.score}`).join(' · ')}`));
    }
  }

  function renderFile(kind, file, result, releaseAllowed = false) {
    const meta = document.querySelector(`#report-file-${kind}`);
    const link = document.querySelector(`#report-download-${kind}`);
    meta.replaceChildren();
    if (!file) {
      meta.append(el('span', 'report-file-path', t('noFile')));
      link.classList.add('disabled');
      link.removeAttribute('href');
      return;
    }
    const details = kind === 'competitor'
      ? [`${result?.sheetCount || file.sheetCount || '-'}${t('sheets')}`, `${result?.embeddedImages ?? file.embeddedImages ?? 0}${t('images')}`]
      : [`${result?.sheetCount || file.sheetCount || '-'}${t('sheets')}`, `${result?.productFamilies || file.productFamilies || '-'}${t('families')}`];
    meta.append(el('span', 'report-file-path', `${t('path')}: ${file.path || file.fileName}`));
    meta.append(el('span', 'report-file-stats', `${fileSize(file.sizeBytes)} · ${details.join(' · ')}`));
    if (releaseAllowed) {
      link.href = file.downloadUrl;
      link.classList.remove('disabled');
      link.setAttribute('download', file.fileName);
      link.setAttribute('aria-disabled', 'false');
    } else {
      meta.append(el('span', 'report-file-stats', '待独立审核；不可下载交付'));
      link.removeAttribute('href');
      link.removeAttribute('download');
      link.classList.add('disabled');
      link.setAttribute('aria-disabled', 'true');
      link.tabIndex = -1;
    }
  }

  function renderPriority(result) {
    priorityList.replaceChildren();
    const rows = result?.priority || [];
    if (!rows.length) {
      priorityList.append(el('p', 'empty-inline', t('noPriority')));
      return;
    }
    rows.forEach((item) => {
      const row = el('div', 'priority-item');
      row.append(el('span', 'priority-rank', `#${item.rank}`));
      const info = el('span', 'priority-info');
      info.append(el('strong', null, `${item.model} · ${item.name}`), el('small', null, `${item.segment} · ${item.catalogNos.join('/')}`));
      row.append(info, el('span', 'priority-score', `${item.score}/100`));
      priorityList.append(row);
    });
  }

  function renderMethod() {
    methodList.replaceChildren();
    [[t('scoreCompliance'), 30], [t('scoreMarket'), 25], [t('scoreValue'), 15], [t('scoreDiff'), 20], [t('scoreReady'), 10]].forEach(([label, value]) => {
      const row = el('div', 'method-item');
      const track = el('span', 'method-track');
      const fill = el('span', 'method-fill');
      fill.style.width = `${value * 3.333}%`;
      track.append(fill);
      row.append(el('span', null, label), track, el('strong', null, String(value)));
      methodList.append(row);
    });
     methodList.append(el('p', 'report-score-note', locale === 'zh' ? '品类规则不匹配时，先过证据门槛，再看总分。' : 'A category-rule mismatch is a hard gate before the composite score.'));
  }

  function renderAllProducts(rows) {
    allProductsTable.replaceChildren();
    if (!rows || !rows.length) {
      allProductsTable.append(el('p', 'empty-inline', t('noData')));
      return;
    }
    const table = el('table', 'result-table report-result-table');
    const thead = el('thead');
    const header = el('tr');
    [t('rank'), t('model'), t('name'), t('segment'), locale === 'zh' ? '受众' : 'Audience', t('score'), t('verdict'), locale === 'zh' ? '合规门槛' : 'Compliance gate'].forEach((label) => header.append(el('th', null, label)));
    thead.append(header);
    table.append(thead);
    const body = el('tbody');
    rows.forEach((product) => {
      const row = el('tr');
      [product.rank, product.model, product.name, product.segment, product.audience, product.score, product.verdict, product.compliance].forEach((value) => row.append(el('td', null, String(value ?? '-'))));
      body.append(row);
    });
    table.append(body);
    allProductsTable.append(table);
  }

  let workflowAuditVersion = '';

  function renderWorkflowAudit() {
    const files = state?.result
      ? [state.result.competitor?.file, state.result.assessment?.file]
      : [state?.availableReports?.competitor, state?.availableReports?.assessment];
    const hasFiles = files.some(Boolean);
    const visible = Boolean(state && (hasFiles || state.status === 'completed'));
    workflowAuditEl.hidden = !visible;
    if (!visible) return;
    const audit = state.audit || {};
    const version = `${state.jobId || 'legacy'}:${state.revision || 0}:${state.buildVersion || 0}`;
    if (version !== workflowAuditVersion) {
      workflowAuditVersion = version;
      workflowReviewer.value = '';
      workflowIssues.value = '';
      workflowRepairNotes.value = '';
      workflowAuditActionStatus.textContent = '';
      workflowAuditActionStatus.classList.remove('error');
      workflowAuditEl.querySelectorAll('[data-workflow-gate]').forEach((input) => {
        input.checked = audit.gates?.[input.dataset.workflowGate] === true;
      });
    }
    const producerId = state.producer?.sessionId || audit.producerSessionId || '';
    const isProducer = Boolean(producerId && actorSessionId() === producerId);
    const canReview = state.status === 'completed' && Boolean(producerId) && !isProducer
      && !audit.releaseAllowed && audit.status !== '退回纠错';
    const canRepair = state.status === 'completed' && audit.status === '退回纠错' && isProducer;
    workflowAuditStatus.textContent = audit.releaseAllowed ? '独立审核通过' : audit.status || '待独立审核';
    workflowAuditStatus.className = `chip ${audit.releaseAllowed ? 'is-ok' : audit.status === '退回纠错' ? 'is-warn' : 'chip-muted'}`;
    workflowAuditMeta.textContent = `${state.jobId ? `任务 ${state.jobId}` : '历史报告：制作会话未登记'} · 制作者 ${state.producer?.name || '未记录'} · revision ${state.revision || 0} / build ${state.buildVersion || 0} · ${audit.status || '待独立审核'}${audit.reviewer ? ` · 审核人 ${audit.reviewer} · 服务器审核时间 ${audit.checkedAt || '未记录'}` : ''}${audit.releaseAllowed ? ' · 已开放下载' : ' · 不可交付'}`;
    workflowRepairWrap.hidden = !canRepair;
    workflowRepairNotes.disabled = !canRepair;
    workflowReviewer.disabled = !canReview;
    workflowIssues.disabled = !canReview;
    workflowAuditEl.querySelectorAll('[data-workflow-gate]').forEach((input) => { input.disabled = !canReview; });
    workflowApprove.disabled = !canReview;
    workflowReturn.disabled = !canReview;
    if (canReview) {
      if (!workflowAuditActionStatus.classList.contains('error')) workflowAuditActionStatus.textContent = '';
    } else if (!producerId) {
      workflowAuditActionStatus.textContent = hasFiles ? '这些是未登记制作会话的历史文件；请重新生成一版后再进入审核。' : '生成报告包后开启独立审核。';
    } else if (isProducer && audit.status === '退回纠错') {
      workflowAuditActionStatus.textContent = '请填写修复说明，再点击“生成两份 Excel 报告”提交新版本。';
    } else if (isProducer && !audit.releaseAllowed) {
      workflowAuditActionStatus.textContent = '当前为制作会话，已禁用自审；请在独立浏览器会话审核。';
    } else if (audit.status === '退回纠错') {
      workflowAuditActionStatus.textContent = '已退回制作者修复；等待新的 revision/build。';
    } else if (audit.releaseAllowed) {
      workflowAuditActionStatus.textContent = '审核记录已锁定；当前报告包可下载交付。';
    } else {
      workflowAuditActionStatus.textContent = '等待报告构建完成。';
    }
    workflowAuditHistory.replaceChildren();
    const history = state.auditHistory || [];
    if (!history.length) workflowAuditHistory.append(el('li', '', '暂无审核或修复记录。'));
    history.forEach((entry) => {
      const li = el('li');
      if (entry.type === 'repair') {
        li.textContent = `修复提交 · ${entry.producer || '制作者'} · ${entry.submittedAt || ''} · ${entry.notes || ''} · 对应问题：${(entry.issuesAddressed || []).join('；') || '未列明'}`;
      } else {
        li.textContent = `${entry.action === 'approve' ? '独立审核通过' : '退回纠错'} · ${entry.reviewer || '审核人未记录'} · ${entry.checkedAt || ''} · v${entry.revision || '?'} / build ${entry.buildVersion || '?'} · ${(entry.issues || []).join('；') || '未记录问题'}`;
      }
      workflowAuditHistory.append(li);
    });
  }

  async function submitWorkflowAudit(action) {
    if (!state) return;
    const reviewer = workflowReviewer.value.trim();
    const issues = workflowIssues.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const gates = Object.fromEntries([...workflowAuditEl.querySelectorAll('[data-workflow-gate]')].map((input) => [input.dataset.workflowGate, input.checked]));
    if (!reviewer) {
      workflowAuditActionStatus.textContent = '审核人姓名为必填项。';
      workflowAuditActionStatus.classList.add('error');
      workflowReviewer.focus();
      return;
    }
    if (action === 'return' && !issues.length) {
      workflowAuditActionStatus.textContent = '退回时请至少填写一条可执行修复问题。';
      workflowAuditActionStatus.classList.add('error');
      workflowIssues.focus();
      return;
    }
    if (action === 'approve' && (!Object.values(gates).every(Boolean) || issues.length)) {
      workflowAuditActionStatus.textContent = '通过需要勾选全部核查项并清空未解决问题。';
      workflowAuditActionStatus.classList.add('error');
      return;
    }
    workflowApprove.disabled = true;
    workflowReturn.disabled = true;
    workflowAuditActionStatus.classList.remove('error');
    workflowAuditActionStatus.textContent = '正在保存独立审核记录…';
    try {
      const response = await fetch('/api/reports/audit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, reviewer, revision: state.revision, buildVersion: state.buildVersion, gates, issues })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error?.message || `HTTP ${response.status}`);
      state = body.data;
      renderAll();
      workflowAuditActionStatus.textContent = action === 'approve'
        ? `审核通过；服务器记录时间 ${state.audit.checkedAt}。当前报告包已开放下载。`
        : `已退回制作者修复；服务器记录时间 ${state.audit.checkedAt}。请修复后重新生成。`;
    } catch (error) {
      workflowAuditActionStatus.textContent = error.message;
      workflowAuditActionStatus.classList.add('error');
    } finally {
      renderWorkflowAudit();
    }
  }

  workflowApprove.addEventListener('click', () => { void submitWorkflowAudit('approve'); });
  workflowReturn.addEventListener('click', () => { void submitWorkflowAudit('return'); });

  function renderAll() {
    const progress = state?.progress || { completed: 0 };
    const completed = Math.min(5, Number(progress.completed || 0));
    progressText.textContent = `${fmt(completed, 1)} / 5`;
    progressFill.style.width = `${Math.min(100, completed / 5 * 100)}%`;
    const statusKey = state?.status || 'idle';
    jobChip.textContent = t(statusKey);
    const releaseAllowed = Boolean(state?.audit?.releaseAllowed);
    jobChip.className = `chip ${statusKey === 'completed' ? (releaseAllowed ? 'is-ok' : 'is-warn') : statusKey === 'failed' ? 'is-warn' : statusKey === 'running' ? 'is-active' : 'chip-muted'}`;
    const canRepair = statusKey === 'completed' && state?.audit?.status === '退回纠错' && actorSessionId() === state?.producer?.sessionId;
    buildButton.disabled = statusKey === 'running' || (statusKey === 'completed' && Boolean(state?.producer?.sessionId) && !canRepair);
    renderStages();
    renderSource(state?.source);
    const result = state?.result;
    renderMarket(result?.competitor?.marketGroups);
    renderScore(result?.assessment);
    renderPriority(result?.assessment);
    renderAllProducts(result?.assessment?.rankedProducts);
    renderMethod();
    const files = result ? { competitor: result.competitor?.file, assessment: result.assessment?.file } : state?.availableReports || {};
    renderFile('competitor', files?.competitor, result?.competitor, releaseAllowed);
    renderFile('assessment', files?.assessment, result?.assessment, releaseAllowed);
    renderWorkflowAudit();
    if (statusKey === 'failed') setStatus(`${state.error?.message || t('failed')}`, true);
    else if (statusKey === 'completed') setStatus(`${progressMessage(state.progress, 'completed')} · ${state.audit?.releaseAllowed ? '独立审核通过；可下载' : '待独立审核；不可交付'}`);
    else if (statusKey === 'running') setStatus(progressMessage(state.progress, 'running'));
  }

  function schedulePoll() {
    if (pollTimer) clearTimeout(pollTimer);
    if (state?.status === 'running') pollTimer = setTimeout(loadStatus, 1200);
  }

  async function loadStatus() {
    try {
      const response = await fetch('/api/reports/status');
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error?.message || 'Unable to load report status.');
      state = body.data;
      renderAll();
      schedulePoll();
    } catch (error) {
      setStatus(error.message || 'Unable to load report status.', true);
    }
  }

  async function buildReports() {
    const repairing = state?.audit?.status === '退回纠错';
    if (repairing && !workflowRepairNotes.value.trim()) {
      workflowAuditActionStatus.textContent = '重新生成前请填写修复说明。';
      workflowAuditActionStatus.classList.add('error');
      workflowRepairNotes.focus();
      return;
    }
    buildButton.disabled = true;
    setStatus(t('running'));
    try {
      const response = await fetch('/api/reports/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          refreshAmazon: refreshAmazon.checked,
          refreshSummary: refreshSummary.checked,
          delayMs: (() => { const value = Number.parseInt(delayInput.value, 10); return Number.isInteger(value) ? value : 1500; })(),
          observedAt: observedInput.value || new Date().toISOString().slice(0, 10),
          repairNotes: repairing ? workflowRepairNotes.value.trim() : ''
        })
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message || 'Report build could not start.');
      state = body.data.status;
      renderAll();
      schedulePoll();
    } catch (error) {
      buildButton.disabled = false;
      setStatus(error.message || 'Report build could not start.', true);
    }
  }

  // ---------------------------------------------------------------------------
  // Generic report jobs: PDF catalog upload, manual confirmation gate, track
  // analysis, and version-bound Excel preview / download.
  // ---------------------------------------------------------------------------
  const JOB_STORAGE_KEY = 'ecommerce-content-assistant-report-job';
  const PREVIEW_PAGE_SIZE = 120;
  const PREVIEW_ROW_HEIGHT = 28;
  const PREVIEW_HEADER_HEIGHT = 30;
  const PREVIEW_COL_WIDTH = 108;
  const JOB_STATUS_KEYS = {
    uploaded: 'statusUploaded', extracting: 'statusExtracting', awaiting_confirmation: 'statusAwaiting',
    confirmed: 'statusConfirmed', researching: 'statusResearching', scoring: 'statusScoring',
    building: 'statusBuilding', completed: 'statusCompleted', failed: 'statusFailed'
  };
  const EDITABLE_JOB_STATES = ['awaiting_confirmation', 'confirmed'];
  const RULE_PACKS = ['helmet-v1', 'apparel-generic-v1', 'unknown-v1'];

  const jobEl = {
    workbench: document.querySelector('#report-workbench'),
    state: document.querySelector('#report-job-state'),
    entryPdfTab: document.querySelector('#report-entry-pdf'),
    entryTrackTab: document.querySelector('#report-entry-track'),
    pdfEntry: document.querySelector('#report-pdf-entry'),
    trackEntry: document.querySelector('#report-track-entry'),
    pdfInput: document.querySelector('#report-pdf-input'),
    dropzone: document.querySelector('#report-dropzone'),
    uploadStatus: document.querySelector('#report-upload-status'),
    trackStatus: document.querySelector('#report-track-status'),
    auditJobId: document.querySelector('#report-audit-job-id'),
    auditLoad: document.querySelector('#report-audit-load'),
    auditLoadStatus: document.querySelector('#report-audit-load-status'),
    trackCategory: document.querySelector('#report-track-category'),
    trackCountry: document.querySelector('#report-track-country'),
    trackMarketplace: document.querySelector('#report-track-marketplace'),
    trackAudience: document.querySelector('#report-track-audience'),
    trackPrice: document.querySelector('#report-track-price'),
    trackQuestions: document.querySelector('#report-track-questions'),
    trackGroups: document.querySelector('#report-track-groups'),
    trackCreate: document.querySelector('#report-track-create'),
    analysis: document.querySelector('#report-job-analysis'),
    meta: document.querySelector('#report-job-meta'),
    categories: document.querySelector('#report-job-categories'),
    products: document.querySelector('#report-job-products'),
    brief: document.querySelector('#report-job-brief'),
    confirm: document.querySelector('#report-job-confirm'),
    research: document.querySelector('#report-job-research'),
    build: document.querySelector('#report-job-build'),
    jobStatus: document.querySelector('#report-job-status'),
    auditPanel: document.querySelector('#report-audit-panel'),
    auditStatus: document.querySelector('#report-audit-status'),
    auditMeta: document.querySelector('#report-audit-meta'),
    auditReviewer: document.querySelector('#report-audit-reviewer'),
    auditIssues: document.querySelector('#report-audit-issues'),
    auditRepairWrap: document.querySelector('#report-audit-repair-wrap'),
    auditRepairNotes: document.querySelector('#report-audit-repair-notes'),
    auditApprove: document.querySelector('#report-audit-approve'),
    auditReturn: document.querySelector('#report-audit-return'),
    auditActionStatus: document.querySelector('#report-audit-action-status'),
    auditHistory: document.querySelector('#report-audit-history'),
    panel: document.querySelector('#report-preview-panel'),
    version: document.querySelector('#report-preview-version'),
    download: document.querySelector('#report-preview-download'),
    sheets: document.querySelector('#report-preview-sheets'),
    previewMeta: document.querySelector('#report-preview-meta'),
    table: document.querySelector('#report-preview-table'),
    images: document.querySelector('#report-preview-images'),
    more: document.querySelector('#report-preview-more'),
    previewStatus: document.querySelector('#report-preview-status')
  };

  let job = null;
  let jobRenderedKey = '';
  let jobPreview = { manifest: null, sheet: null, allCells: [] };
  let jobPreviewSheetId = '';
  let jobPreviewPage = 1;
  let jobPreviewLoading = false;
  let jobPreviewState = 'none';
  let currentActorSessionId = '';

  function actorSessionId() {
    return currentActorSessionId;
  }

  async function loadActorSession() {
    const session = await jobApi('/api/reports/session');
    currentActorSessionId = session?.sessionId || '';
    return currentActorSessionId;
  }

  function reducedMotion() {
    return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function jobSplitLines(value) {
    return String(value || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 12);
  }

  function jobParseGroups(value) {
    return jobSplitLines(value).map((line, index) => {
      const [label, keywords] = line.split('|');
      return {
        id: `group-${index + 1}`,
        label: String(label || '').trim(),
        keywords: String(keywords || '').split(/[,，]/).map((item) => item.trim()).filter(Boolean)
      };
    }).filter((group) => group.label || group.keywords.length);
  }

  async function jobApi(path, options) {
    const response = await fetch(path, options);
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error((body && body.error && body.error.message) || `HTTP ${response.status}`);
      error.code = body && body.error && body.error.code;
      error.jobId = body && body.jobId;
      throw error;
    }
    return body ? body.data : null;
  }

  function jobField(labelText, id, value, placeholder) {
    const label = el('label');
    label.append(el('span', null, labelText));
    const input = document.createElement('input');
    input.type = 'text';
    input.id = id;
    input.value = value || '';
    if (placeholder) input.placeholder = placeholder;
    label.append(input);
    return label;
  }

  function jobTextarea(labelText, id, value, placeholder) {
    const label = el('label');
    label.append(el('span', null, labelText));
    const area = document.createElement('textarea');
    area.id = id;
    area.rows = 3;
    area.value = value || '';
    if (placeholder) area.placeholder = placeholder;
    label.append(area);
    return label;
  }

  function setJobStatus(message, isError = false, artifact = null) {
    jobEl.jobStatus.replaceChildren();
    if (message) jobEl.jobStatus.append(document.createTextNode(message));
    if (artifact) {
      const link = el('a', 'report-job-download-link', `${t('downloadExcel')} · ${artifact.fileName}`);
      link.href = artifact.downloadUrl;
      link.setAttribute('download', artifact.fileName);
      jobEl.jobStatus.append(document.createTextNode(' '), link);
    }
    jobEl.jobStatus.classList.toggle('error', Boolean(isError));
  }

  function setPreviewState(next) {
    jobPreviewState = next;
    jobEl.workbench.dataset.previewState = next;
    jobEl.panel.hidden = next !== 'ready';
    if (next !== 'ready') {
      jobPreview = { manifest: null, sheet: null, allCells: [] };
      jobPreviewSheetId = '';
      jobPreviewPage = 1;
      jobEl.table.replaceChildren();
      jobEl.images.replaceChildren();
      jobEl.images.hidden = true;
      jobEl.sheets.replaceChildren();
      jobEl.previewMeta.textContent = '';
      jobEl.more.hidden = true;
      jobEl.previewStatus.textContent = '';
      jobEl.download.classList.add('disabled');
      jobEl.download.removeAttribute('href');
      jobEl.version.textContent = '-';
    }
  }

  function renderJobMeta() {
    jobEl.meta.replaceChildren();
    const analysis = job.analysis || {};
    const chips = [];
    const fileName = analysis.originalFileName || (job.taskType === 'track_analysis' ? t('entryTrack') : '-');
    chips.push(el('span', 'chip chip-muted', `${t('jobMetaFile')}: ${fileName}`));
    if (analysis.pageCount) chips.push(el('span', 'chip chip-muted', `${t('jobMetaPages')}: ${analysis.pageCount}`));
    if (analysis.textMode) {
      const mode = analysis.textMode === 'text' ? t('textModeText') : analysis.textMode === 'scanned' ? t('textModeScanned') : t('textModeUnreadable');
      chips.push(el('span', 'chip chip-muted', `${t('jobMetaMode')}: ${mode}`));
    }
    const hypothesis = (analysis.categoryHypotheses || [])[0];
    if (hypothesis) chips.push(el('span', 'chip chip-muted', `${t('jobMetaConfidence')}: ${Math.round((hypothesis.confidence || 0) * 100)}%`));
    chips.push(el('span', 'chip chip-muted', `${t('jobMetaJobs')}: ${job.taskType}`));
    chips.push(el('span', 'chip chip-muted', `任务 ID: ${job.jobId}`));
    chips.push(el('span', 'chip chip-muted', `制作会话: ${job.producer?.name || '制作者'}`));
    jobEl.meta.append(...chips);
    if (analysis.ocrRequired) jobEl.meta.append(el('p', 'report-job-warning', t('ocrNote')));
    (analysis.warnings || []).forEach((warning) => jobEl.meta.append(el('p', 'report-job-warning', warning)));
  }

  function renderJobCategories() {
    jobEl.categories.replaceChildren();
    const hypotheses = job.analysis?.categoryHypotheses || [];
    if (!hypotheses.length) return;
    jobEl.categories.append(el('h4', 'report-job-subtitle', t('categoriesTitle')));
    hypotheses.forEach((item) => {
      const row = el('div', 'report-category-row');
      const label = document.createElement('input');
      label.type = 'text';
      label.value = item.label || '';
      label.dataset.categoryLabel = item.id;
      const pack = document.createElement('select');
      pack.dataset.categoryRulepack = item.id;
      RULE_PACKS.forEach((id) => {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = id;
        if (item.rulePackId === id) option.selected = true;
        pack.append(option);
      });
      const meta = el('span', 'report-category-meta', `${t('rulePackLabel')} / ${t('jobMetaConfidence')} ${Math.round((item.confidence || 0) * 100)}%`);
      row.append(label, pack, meta);
      jobEl.categories.append(row);
    });
  }

  function candidateRow(item, index) {
    const row = el('div', 'report-candidate');
    row.dataset.index = String(index);
    row.dataset.candidateId = item.candidateId || '';
    row._candidateSeed = item;
    const nameField = el('label', 'report-candidate-field');
    nameField.append(el('span', null, t('productName')));
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = item.displayName || '';
    nameInput.dataset.candidateField = 'displayName';
    nameField.append(nameInput);
    const modelField = el('label', 'report-candidate-field');
    modelField.append(el('span', null, t('productModel')));
    const modelInput = document.createElement('input');
    modelInput.type = 'text';
    modelInput.value = item.model || '';
    modelInput.dataset.candidateField = 'model';
    modelField.append(modelInput);
    const costHint = item.fields?.purchaseCostCandidate;
    const costLocationHint = costHint?.sourcePageNumber ? `p.${costHint.sourcePageNumber}` : (item.cost?.sourceLocation || '来源待补');
    const stats = el('span', 'report-candidate-stats', `${t('jobMetaConfidence')} ${Math.round((item.confidence || 0) * 100)}% · ${t('productMissing')}: ${(item.missingFields || []).slice(0, 5).join(', ') || '-'}${costHint ? ` · 成本候选 ${costHint.amount} ${costHint.currency || '币种待核'}（${costLocationHint}，未确认）` : ''}`);
    const actions = el('div', 'report-candidate-actions');
    const merge = el('button', 'quiet-button', t('productMergeNext'));
    merge.type = 'button';
    merge.addEventListener('click', () => {
      const next = row.nextElementSibling;
      if (!next || !next.classList.contains('report-candidate')) return;
      const nextName = next.querySelector('[data-candidate-field="displayName"]')?.value.trim() || '';
      const nextModel = next.querySelector('[data-candidate-field="model"]')?.value.trim() || '';
      if (nextName) nameInput.value = `${nameInput.value.trim()} / ${nextName}`.trim();
      if (nextModel && !modelInput.value.trim()) modelInput.value = nextModel;
      next.remove();
    });
    const split = el('button', 'quiet-button', t('productSplit'));
    split.type = 'button';
    split.addEventListener('click', () => {
      const clone = candidateRow({ displayName: `${nameInput.value.trim()} (2)`, model: modelInput.value.trim(), confidence: item.confidence || 0, missingFields: item.missingFields || [] }, 0);
      row.after(clone);
    });
    const reject = el('button', 'quiet-button', t('productReject'));
    reject.type = 'button';
    reject.addEventListener('click', () => row.remove());
    actions.append(merge, split, reject);
    row.append(nameField, modelField, stats, actions);

    const cost = item.cost || {};
    const extractedCost = costHint || {};
    const costPanel = el('section', 'report-product-section report-cost-section');
    costPanel.append(el('h5', '', '成本与型号人工确认（未确认前不能开始 Amazon 研究）'));
    const modelCheck = document.createElement('label');
    modelCheck.className = 'report-confirm-check';
    const modelConfirmed = document.createElement('input');
    modelConfirmed.type = 'checkbox';
    modelConfirmed.dataset.modelConfirmed = 'true';
    modelConfirmed.checked = item.modelConfirmed === true;
    modelCheck.append(modelConfirmed, el('span', '', '我已对照 PDF 原页或截图来源确认型号拼写（字母 O 与数字 0 不自动互换）'));
    costPanel.append(modelCheck);
    const costGrid = el('div', 'report-inline-grid');
    const costAmount = jobField('采购成本候选（需人工复核）', '', String(cost.amount ?? extractedCost.amount ?? ''), '单件/套成本');
    costAmount.querySelector('input').type = 'number';
    costAmount.querySelector('input').step = '0.01';
    costAmount.querySelector('input').min = '0';
    costAmount.querySelector('input').dataset.costField = 'amount';
    const currencyLabel = el('label', 'report-candidate-field');
    currencyLabel.append(el('span', '', '币种（人工选择）'));
    const currency = document.createElement('select');
    currency.dataset.costField = 'currency';
    [['', '请选择'], ['CNY', 'CNY 人民币'], ['USD', 'USD 美元'], ['EUR', 'EUR 欧元'], ['GBP', 'GBP 英镑'], ['JPY', 'JPY 日元'], ['CAD', 'CAD 加元'], ['AUD', 'AUD 澳元']].forEach(([value, label]) => {
      const option = document.createElement('option'); option.value = value; option.textContent = label;
      if ((cost.currency || extractedCost.currency || '') === value) option.selected = true;
      currency.append(option);
    });
    currencyLabel.append(currency);
    const unit = jobField('计价单位（如 元/件、美元/套）', '', cost.unit || extractedCost.unit || '', '必须填写');
    unit.querySelector('input').dataset.costField = 'unit';
    const incoterm = jobField('价格条款（如 EXW、FOB、DDP）', '', cost.incoterm || extractedCost.incoterm || '', '请按供应商报价确认');
    incoterm.querySelector('input').dataset.costField = 'incoterm';
    const variant = jobField('成本适用型号/变体', '', cost.variant || extractedCost.variant || modelInput.value, '说明颜色/尺码/配置适用范围');
    variant.querySelector('input').dataset.costField = 'variant';
    const fxRate = jobField('该币种兑 USD 汇率（USD/原币单位）', '', cost.fxToUSD ?? ((cost.currency || extractedCost.currency) === 'USD' ? '1' : ''), '手工确认汇率');
    fxRate.querySelector('input').type = 'number'; fxRate.querySelector('input').step = '0.000001'; fxRate.querySelector('input').min = '0';
    fxRate.querySelector('input').dataset.costField = 'fxToUSD';
     const fxDate = jobField('汇率日期 / 来源', '', cost.fxDate || '', '如 2026-10-01 / 用户报价');
    fxDate.querySelector('input').dataset.costField = 'fxDate';
     const sourceLocation = jobField('成本来源定位（文件名/页码/行）', '', cost.sourceLocation || '', '如 catalog.pdf / p.2 / row 4');
    sourceLocation.querySelector('input').dataset.costField = 'sourceLocation';
    costGrid.append(costAmount, currencyLabel, unit, incoterm, variant, fxRate, fxDate, sourceLocation);
    costPanel.append(costGrid);
    const costScreenshotWrap = el('label', 'report-candidate-field report-screenshot-field');
    const attachedCostScreenshot = item.costEvidenceFile?.name ? `已匹配待保存截图：${item.costEvidenceFile.name}` : '';
    costScreenshotWrap.append(el('span', '', cost.evidencePath ? `成本截图已保存：${cost.evidencePath}` : attachedCostScreenshot || '成本来源证据（无 PDF 页证据的截图成本必须上传；PNG/JPEG/WebP，≤5 MB）'));
    const costScreenshot = document.createElement('input'); costScreenshot.type = 'file'; costScreenshot.accept = 'image/png,image/jpeg,image/webp'; costScreenshot.dataset.costEvidence = 'true';
    costScreenshot.addEventListener('change', () => {
      const file = costScreenshot.files?.[0];
      const locationInput = row.querySelector('[data-cost-field="sourceLocation"]');
      if (file && locationInput && !locationInput.value.trim()) locationInput.value = file.name;
    });
    costScreenshotWrap.append(costScreenshot); costPanel.append(costScreenshotWrap);
    const costCheck = document.createElement('label');
    costCheck.className = 'report-confirm-check';
    const costConfirmed = document.createElement('input');
    costConfirmed.type = 'checkbox'; costConfirmed.dataset.costConfirmed = 'true'; costConfirmed.checked = cost.confirmed === true;
    costCheck.append(costConfirmed, el('span', '', '我已核对成本数值、币种、计价单位、条款、适用变体和汇率（以上不代表供应商实付成本）'));
    costPanel.append(costCheck);
    row.append(costPanel);

    const economics = el('details', 'report-product-section report-economics');
    economics.open = true;
    economics.append(el('summary', '', '费用假设与利润情景（每款独立填写；填 0 代表已确认无此费用）'));
    const feeGrid = el('div', 'report-inline-grid');
    const feeFields = [
      ['inboundPerUnit', '头程/入仓 USD/件', '0.00'], ['packagingPerUnit', '包装 USD/件', '0.00'],
      ['fulfillmentPerUnit', 'FBA/履约 USD/件', '0.00'], ['referralRatePct', 'Amazon佣金 %', '15'],
      ['adPerUnit', '单件广告固定成本 USD', '0.00'], ['adRatePct', '按销售额广告 %', '0'],
      ['returnPerUnit', '单件退货准备 USD', '0.00'], ['returnRatePct', '按销售额退货准备 %', '0'],
      ['taxPerUnit', '关税/其他税费 USD/件', '0.00'], ['taxRatePct', '销售额计税费 %（适用才填）', '0'],
      ['otherPerUnit', '其他固定成本 USD/件', '0.00'], ['discountRatePct', '促销折扣 %', '0'],
      ['couponFixed', '固定 Coupon USD', '0.00'], ['targetMarginPct', '目标利润率 %', '20']
    ];
    const fees = item.fees || {};
    feeFields.forEach(([key, label, placeholder]) => {
      const field = jobField(label, '', fees[key] ?? '', placeholder);
      const input = field.querySelector('input');
      input.type = 'number'; input.step = key.endsWith('Pct') ? '0.1' : '0.01'; input.min = '0';
      input.dataset.feeField = key;
      feeGrid.append(field);
    });
    economics.append(feeGrid);
    const feeConfirmedLabel = document.createElement('label');
    feeConfirmedLabel.className = 'report-confirm-check';
    const feeConfirmed = document.createElement('input'); feeConfirmed.type = 'checkbox'; feeConfirmed.dataset.feesConfirmed = 'true'; feeConfirmed.checked = fees.confirmed === true;
    feeConfirmedLabel.append(feeConfirmed, el('span', '', '我已确认以上单件费用/费率；所有零值均为明确的用户情景假设，不是平台账单'));
    economics.append(feeConfirmedLabel);
    const premium = jobField('高于可比竞品上沿时的溢价理由（无依据则留空）', '', item.premiumRationale || '', '留空时超过市场上沿将明确判为不建议进入');
    premium.querySelector('input').dataset.productField = 'premiumRationale';
    economics.append(premium);
    row.append(economics);

    const shipping = item.shipping || {};
    const freightPanel = el('details', 'report-product-section report-freight-section');
    freightPanel.append(el('summary', '', 'UPS / FedEx 空运计费情景（按外箱；毛重与体积重取大值）'));
    const shippingHeader = el('div', 'report-inline-grid');
    const divisor = el('label', 'report-candidate-field'); divisor.append(el('span', '', '体积重除数 cm³/kg'));
    const divisorSelect = document.createElement('select'); divisorSelect.dataset.shippingField = 'volumetricDivisor';
    [['5000', '5000（未知时保守默认）'], ['6000', '6000']].forEach(([value, label]) => {
      const option = document.createElement('option'); option.value = value; option.textContent = label;
      option.selected = String(shipping.volumetricDivisor ?? 5000) === value; divisorSelect.append(option);
    });
    divisor.append(divisorSelect);
    const batteryLabel = el('label', 'report-candidate-field'); batteryLabel.append(el('span', '', '配置电池类型'));
    const batteryType = document.createElement('select'); batteryType.dataset.batteryType = 'true';
    [['unknown', '待确认'], ['none', '无电池'], ['button_cell', '纽扣电池'], ['rechargeable', '充电灯/锂电池']].forEach(([value, label]) => {
      const option = document.createElement('option'); option.value = value; option.textContent = label; option.selected = (item.batteryType || 'unknown') === value; batteryType.append(option);
    });
    batteryLabel.append(batteryType);
    shippingHeader.append(divisor, batteryLabel);
    freightPanel.append(shippingHeader);
    const cartonsList = el('div', 'report-shipping-cartons');
    (shipping.cartons?.length ? shipping.cartons : [{}]).forEach((carton) => cartonsList.append(shippingCartonRow(carton)));
    freightPanel.append(el('h5', '', '外箱包装规格（一个 SKU 可有多个箱型）'), cartonsList);
    const addCarton = el('button', 'quiet-button', '新增箱型'); addCarton.type = 'button'; addCarton.addEventListener('click', () => cartonsList.append(shippingCartonRow({})));
    freightPanel.append(addCarton);
    const rate = shipping.rate || {};
    const rateGrid = el('div', 'report-inline-grid');
    const rateCurrency = jobField('运价币种（PM 已确认）', '', 'CNY', 'CNY'); rateCurrency.querySelector('input').dataset.rateField = 'currency'; rateCurrency.querySelector('input').readOnly = true;
    const rateFx = jobField('CNY 兑 USD 汇率', '', rate.fxToUSD ?? '', '填用户确认汇率'); rateFx.querySelector('input').type = 'number'; rateFx.querySelector('input').step = '0.000001'; rateFx.querySelector('input').min = '0'; rateFx.querySelector('input').dataset.rateField = 'fxToUSD';
    const rateFxDate = jobField('汇率日期 / 来源', '', rate.fxDate || '', '非 USD 必填'); rateFxDate.querySelector('input').dataset.rateField = 'fxDate';
     const magnetic = jobField('可能附加费 / 票（CNY 情景）', '', rate.magneticInspectionPerShipment ?? '', '填已确认或明确标注的情景费用'); magnetic.querySelector('input').type = 'number'; magnetic.querySelector('input').step = '0.01'; magnetic.querySelector('input').min = '0'; magnetic.querySelector('input').dataset.rateField = 'magneticInspectionPerShipment';
     const magneticApplicabilityLabel = el('label', 'report-candidate-field'); magneticApplicabilityLabel.append(el('span', '', '附加费适用性'));
     const magneticApplicability = document.createElement('select'); magneticApplicability.dataset.rateField = 'magneticFeeApplicable';
     [['unknown', '未知：并列无费用 / 输入情景'], ['yes', '货代确认本票适用'], ['no', '货代确认本票不适用']].forEach(([value, label]) => {
      const option = document.createElement('option'); option.value = value; option.textContent = label; option.selected = (rate.magneticFeeApplicable || 'unknown') === value; magneticApplicability.append(option);
    });
    magneticApplicabilityLabel.append(magneticApplicability);
    const otherShipment = jobField('其他票级费用（CNY/票）', '', rate.otherPerShipment ?? '', '无则填 0；不混入元/kg'); otherShipment.querySelector('input').type = 'number'; otherShipment.querySelector('input').step = '0.01'; otherShipment.querySelector('input').min = '0'; otherShipment.querySelector('input').dataset.rateField = 'otherPerShipment';
    const rateSource = jobField('费率表总来源定位', '', rate.sourceLocation || '', '截图文件、有效期或报价编号'); rateSource.querySelector('input').dataset.rateField = 'sourceLocation';
    rateGrid.append(rateCurrency, rateFx, rateFxDate, magnetic, magneticApplicabilityLabel, otherShipment, rateSource);
     freightPanel.append(rateGrid, el('p', 'report-job-warning', '除数未知时并列 5000/6000；若已确认实际除数，保守情景按确认值。只从人工核对、明确可承运、邮区行有效且实际重量档匹配的 CNY/kg 费率候选中取最高值；邮区未知时比较全部合格邮区。附加费与元/kg 分列，适用性未知时只作为标记为情景的输入。'));
    const rateOptionsList = el('div', 'report-shipping-rate-options');
    const rateOptions = Array.isArray(shipping.rateOptions) && shipping.rateOptions.length
      ? shipping.rateOptions
      : Number(rate.perKg) > 0 && (!rate.currency || String(rate.currency).toUpperCase() === 'CNY') ? [{ ...rate, candidateOnly: false }] : [];
    rateOptions.forEach((option) => rateOptionsList.append(shippingRateOptionRow(option)));
    freightPanel.append(el('h5', '', 'CNY/kg 费率候选（每行对应渠道 × 邮区 × 重量档）'), rateOptionsList);
    const addRateOption = el('button', 'quiet-button', '新增费率行候选'); addRateOption.type = 'button'; addRateOption.addEventListener('click', () => rateOptionsList.append(shippingRateOptionRow({ currency: 'CNY' })));
    freightPanel.append(addRateOption);
    const rateEvidence = el('label', 'report-candidate-field report-screenshot-field');
    rateEvidence.append(el('span', '', rate.evidencePath ? `货代运价证据已保存：${rate.evidencePath}` : '货代价目表截图（PNG/JPEG/WebP，≤5 MB）'));
    const rateEvidenceInput = document.createElement('input'); rateEvidenceInput.type = 'file'; rateEvidenceInput.accept = 'image/png,image/jpeg,image/webp'; rateEvidenceInput.dataset.rateEvidence = 'true';
    rateEvidence.append(rateEvidenceInput); freightPanel.append(rateEvidence);
    const checkShipping = (key, label, checked) => {
      const wrapper = document.createElement('label'); wrapper.className = 'report-confirm-check';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.dataset.shippingConfirmed = key; checkbox.checked = checked === true;
      wrapper.append(checkbox, el('span', '', label)); return wrapper;
    };
    freightPanel.append(
      checkShipping('divisorConfirmed', '已向货代确认体积重除数与 20kg 进位规则', shipping.divisorConfirmed),
      checkShipping('batteryTypeConfirmed', '已按产品截图确认本配置是否含电池/灯具及电池类型', item.batteryTypeConfirmed),
      checkShipping('rateConfirmed', '已核对截图费率行、路线/邮区/实际重量档与票费（不等于全包到岸确认）', rate.confirmed),
      checkShipping('shippingConfirmed', '已确认当前 SKU 外箱规格及本票计费规则', shipping.confirmed)
    );
    const pricing = (job.pricingResults || []).find((result) => result.candidateId === item.candidateId)?.result;
    const freightResult = pricing?.airFreight;
    if (freightResult) {
       const magneticPerUnit = freightResult.magneticInspectionPerUnit === null ? '' : ` · 票级附加费情景 ¥${freightResult.magneticInspectionPerUnit.toFixed(2)}/顶`;
      freightPanel.append(el('p', `report-pricing-result ${freightResult.status}`, `保守情景（除数 ${freightResult.volumetricDivisor ?? 5000}）：计费重 ${freightResult.totalBillableKg ?? '-'} kg · 档位 ${freightResult.calculatedShipmentTier || '-'} · ${freightResult.ratePerKg ? `适用费率 ¥${freightResult.ratePerKg}/kg` : '合格费率行待补'} · 运费 ${freightResult.freightPerUnit ?? '未计算'} CNY/顶${magneticPerUnit}${freightResult.freightPerUnitUSD ? `（US$${freightResult.freightPerUnitUSD.toFixed(2)}/顶）` : ''} · ${freightResult.warning}`));
      const sensitivity = pricing.freightSensitivity;
      if (sensitivity) {
         const rows = sensitivity.scenarios.map((scenario) => `${scenario.volumetricDivisor}/${scenario.magneticInspectionPerShipmentCNY ? `含附加费 ¥${scenario.magneticInspectionPerShipmentCNY}` : '不含附加费'}: ${scenario.result.totalBillableKg}kg，${scenario.result.freightPerUnit === null ? '费率待核' : `¥${scenario.result.freightPerUnit.toFixed(2)}/顶`}`).join('；');
         freightPanel.append(el('p', 'report-job-warning', `运费敏感性（不代表到岸价）：${rows}`));
      }
    }
     else freightPanel.append(el('p', 'report-job-warning', '缺外箱尺寸/毛重/装箱数或经确认的带电渠道时，只显示可用情景，不把产品净重直接套运价。'));
    row.append(freightPanel);

    const researchPanel = el('details', 'report-product-section report-research-section');
    researchPanel.open = true;
    researchPanel.append(el('summary', '', '英文 Amazon 检索与可比 ASIN 确认'));
    const keywords = jobField('Amazon 英文检索词（逐款填写）', '', item.researchKeywords || '', '例如 adult commuter bike helmet with visor');
    keywords.querySelector('input').dataset.productField = 'researchKeywords';
    researchPanel.append(keywords);
    const researchData = (job.researchData?.byProduct || []).find((result) => result.candidateId === item.candidateId);
    if (researchData) {
      researchPanel.append(el('p', 'report-job-warning', `搜索词：${researchData.query || '未提供'} · 状态：${researchData.status} · 观察：${researchData.observedAt || job.researchData.observedAt || '-'}`));
      if (researchData.errors?.length) researchData.errors.forEach((error) => researchPanel.append(el('p', 'report-job-warning', `${error.code || 'Amazon 页面不可读'}：${error.message || '未获取商品页数据'}`)));
      const discoveries = el('div', 'report-discovery-list');
      (researchData.records || []).forEach((record) => {
        const discovery = el('article', 'report-discovery');
        const isPdp = record.sourceType === 'amazon_public_product' && record.pageStatus === 'parsed' && record.priceStatus === 'observed';
        discovery.append(el('strong', '', `${record.title || record.asin || '未命名候选'} · ${record.asin || 'ASIN未读出'}`));
        discovery.append(el('small', '', `${isPdp ? `PDP当前价 US$${Number(record.price).toFixed(2)}` : '搜索发现候选；搜索页价格不可作为定价证据'} · 页面 ${record.pageStatus || '未读'} · 观察 ${record.observedAt || '-'}`));
        if (record.url) {
          const link = el('a', '', '打开 Amazon 商品页'); link.href = record.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; discovery.append(link);
        }
        const add = el('button', 'quiet-button', '加入待确认竞品'); add.type = 'button';
        add.addEventListener('click', () => {
          const list = row.querySelector('.report-comparable-list');
          list.append(comparableRow({
            asin: record.asin, url: record.url, title: record.title, brand: record.brand,
            price: isPdp ? record.price : '', currency: 'USD', selectedVariant: record.selectedVariant || '',
            variantLabel: record.selectedVariant || '', observedAt: isPdp ? (record.observedAt || '') : '',
            pageStatus: record.pageStatus, priceStatus: record.priceStatus, sourceType: record.sourceType,
            similarity: 'unreviewed', matchConfirmed: false, reviewsVisible: record.reviewsVisible || [],
            reviewDataStatus: record.reviewDataStatus || 'not_fetched'
          }));
        });
        discovery.append(add); discoveries.append(discovery);
      });
      if (!researchData.records?.length && !researchData.errors?.length) discoveries.append(el('p', 'empty-inline', '未发现可读结果；可以人工输入 Amazon 链接/ASIN 与截图证据。'));
      researchPanel.append(discoveries);
    } else {
      researchPanel.append(el('p', 'report-job-warning', '先保存成本确认和英文关键词，再开始 Amazon 搜索。搜索页仅用于发现 ASIN；当前价格只接受可读 PDP 或用户截图证据。'));
    }
    const compList = el('div', 'report-comparable-list');
    (item.competitors || []).forEach((competitor) => compList.append(comparableRow(competitor)));
    researchPanel.append(el('h5', '', '已加入竞品（相似性与变体须逐条人工确认）'), compList);
    const addManual = el('button', 'quiet-button', '手工添加 ASIN / PDP 链接 / 截图证据'); addManual.type = 'button';
    addManual.addEventListener('click', () => compList.append(comparableRow({ similarity: 'unreviewed', currency: 'USD' })));
    researchPanel.append(addManual);
    const pricingResult = (job.pricingResults || []).find((result) => result.candidateId === item.candidateId)?.result;
    if (pricingResult) researchPanel.append(el('p', `report-pricing-result ${pricingResult.status}`, `${pricingResult.decision || ''}${pricingResult.breakEvenListPrice ? ` · 保本 US$${pricingResult.breakEvenListPrice.toFixed(2)} · 目标利润 US$${pricingResult.targetProfitListPrice.toFixed(2)}` : ''}${pricingResult.market?.sampleCount ? ` · 已核相似样本 ${pricingResult.market.sampleCount}` : ''}`));
    row.append(researchPanel);
    return row;
  }

  function shippingCartonRow(carton = {}) {
    const row = el('div', 'report-shipping-carton');
    const grid = el('div', 'report-inline-grid');
    [['cartonCount', '箱数', '1'], ['unitsPerCarton', '每箱装顶数', ''], ['lengthCm', '外箱长 cm', ''], ['widthCm', '外箱宽 cm', ''], ['heightCm', '外箱高 cm', ''], ['grossKg', '单箱毛重 kg', '']].forEach(([key, label, placeholder]) => {
      const field = jobField(label, '', carton[key] ?? '', placeholder);
      const input = field.querySelector('input'); input.type = 'number'; input.step = key.includes('Count') || key === 'unitsPerCarton' ? '1' : '0.01'; input.min = '0'; input.dataset.shippingCartonField = key;
      grid.append(field);
    });
    const remove = el('button', 'quiet-button', '移除此箱型'); remove.type = 'button'; remove.addEventListener('click', () => row.remove());
    row.append(grid, remove); return row;
  }

  function shippingRateOptionRow(option = {}) {
    const row = el('div', 'report-shipping-rate-option');
    row.dataset.candidateOnly = option.candidateOnly === true ? 'true' : 'false';
    if (option.candidateOnly === true) row.append(el('p', 'report-job-warning', 'PRD 条件示例行：不可自动套用。只有补全实际路线/邮区/重量档、来源，并由货代确认本 SKU 可承运后才可纳入。'));
    const grid = el('div', 'report-inline-grid');
    const fields = [
      ['perKg', 'CNY/kg', option.perKg ?? '', '0.00', 'number'],
      ['channel', '渠道 / 路线', option.channel || '', '须可承运当前 SKU', 'text'],
      ['sourceLocation', '截图/报价行来源定位', option.sourceLocation || '', '截图文件 + 页码/行/有效期', 'text']
    ];
    fields.forEach(([key, label, value, placeholder, type]) => {
      const field = jobField(label, '', String(value), placeholder);
      const input = field.querySelector('input'); input.type = type; input.dataset.rateOptionField = key;
      if (key === 'perKg') { input.step = '0.01'; input.min = '0'; }
      grid.append(field);
    });
    const zoneLabel = el('label', 'report-candidate-field'); zoneLabel.append(el('span', '', '美国邮区'));
    const zone = document.createElement('select'); zone.dataset.rateOptionField = 'postalZone';
    [['', '待确认'], ['0-4', '0-4'], ['5-7', '5-7'], ['8-9', '8-9']].forEach(([value, label]) => {
      const item = document.createElement('option'); item.value = value; item.textContent = label; item.selected = String(option.postalZone || '') === value; zone.append(item);
    });
    zoneLabel.append(zone); grid.append(zoneLabel);
    const tierLabel = el('label', 'report-candidate-field'); tierLabel.append(el('span', '', '费率表实际重量档'));
    const tier = document.createElement('select'); tier.dataset.rateOptionField = 'tier';
    [['', '待确认'], ['below_23kg', '低于 23 kg'], ['23_70kg', '23–70 kg'], ['71_100kg', '71–100 kg'], ['101kg_plus', '101 kg 以上']].forEach(([value, label]) => {
      const item = document.createElement('option'); item.value = value; item.textContent = label; item.selected = String(option.tier || '') === value; tier.append(item);
    });
    tierLabel.append(tier); grid.append(tierLabel);
    const toggle = (key, label, checked) => {
      const wrapper = document.createElement('label'); wrapper.className = 'report-confirm-check';
      const input = document.createElement('input'); input.type = 'checkbox'; input.dataset.rateOptionField = key; input.checked = checked === true;
      wrapper.append(input, el('span', '', label)); return wrapper;
    };
    const eligible = toggle('routeEligible', '货代已确认该路线可承运此 SKU 配置', option.routeEligible === true);
    const battery = toggle('batteryCompatible', '若含电：货代已确认此路线接收本电池/灯具配置', option.batteryCompatible === true);
    const remove = el('button', 'quiet-button', '移除此费率候选'); remove.type = 'button'; remove.addEventListener('click', () => row.remove());
    row.append(grid, eligible, battery, remove); return row;
  }

  function comparableRow(item = {}) {
    const row = el('div', 'report-comparable');
    row.dataset.sourceType = item.sourceType || 'user_entered';
    row.dataset.pageStatus = item.pageStatus || '';
    row.dataset.reviewDataStatus = item.reviewDataStatus || 'not_fetched';
    row.dataset.screenshotPath = item.screenshotPath || '';
    row.dataset.screenshotSha256 = item.screenshotSha256 || '';
    row.dataset.screenshotReference = item.screenshotReference || '';
    row._reviewsVisible = Array.isArray(item.reviewsVisible) ? item.reviewsVisible : [];
    row._reviewGap = item.reviewGap || '';
    row._reviewCounts = item.reviewCounts || {};
    row._importedSimilarityStatus = item.importedSimilarityStatus || '';
    row._screenshotDataUrl = item.screenshotDataUrl || '';
    row._screenshotFile = item.screenshotFile || null;
    const grid = el('div', 'report-inline-grid');
    const fields = [
      ['asin', 'ASIN', item.asin || '', '10位 ASIN', 'text'], ['url', 'Amazon PDP 链接', item.url || '', 'https://www.amazon.com/dp/…', 'url'],
      ['title', '商品标题', item.title || '', '', 'text'], ['brand', '品牌', item.brand || '', '', 'text'],
      ['price', '所选变体 PDP 价 USD', item.price ?? '', '仅填 PDP / 截图可核价格', 'number'],
      ['variantLabel', '所选颜色/尺码/配置', item.variantLabel || item.selectedVariant || '', '不可只填父体通用配置', 'text'],
       ['observedAt', '价格观察时间（保留来源时区）', item.observedAt || '', '如 2026-10-01T20:07:58+08:00', 'text'],
      ['coupon', '可见 Coupon / 促销', item.coupon || '', '未显示可留空', 'text'],
      ['similarityReason', '相似性理由', item.similarityReason || '', '用途/配置/人群/功能', 'text']
    ];
    fields.forEach(([key, label, value, placeholder, type]) => {
      const field = jobField(label, '', String(value), placeholder);
      const input = field.querySelector('input'); input.type = type; input.dataset.comparableField = key;
      if (key === 'asin') input.maxLength = 10;
      if (key === 'price') { input.min = '0'; input.step = '0.01'; }
      grid.append(field);
    });
    const similarityField = el('label', 'report-candidate-field');
    similarityField.append(el('span', '', '竞品关系'));
    const similarity = document.createElement('select'); similarity.dataset.comparableField = 'similarity';
    [['unreviewed', '待判断'], ['similar', '相似（计入价格带）'], ['adjacent', '邻近参照（不计入）'], ['not_comparable', '不可比']].forEach(([value, label]) => {
      const option = document.createElement('option'); option.value = value; option.textContent = label; option.selected = (item.similarity || 'unreviewed') === value; similarity.append(option);
    });
    similarityField.append(similarity); grid.append(similarityField);
    row.append(grid);
    const confirmWrap = document.createElement('label'); confirmWrap.className = 'report-confirm-check';
    const confirm = document.createElement('input'); confirm.type = 'checkbox'; confirm.dataset.comparableConfirmed = 'true'; confirm.checked = item.matchConfirmed === true;
    confirmWrap.append(confirm, el('span', '', '我已核对 ASIN 与链接一致、所选变体、价格时点及相似性；只有 PDP 或截图证据可计入市场带'));
    row.append(confirmWrap);
    const screenshotWrap = el('label', 'report-candidate-field report-screenshot-field');
    screenshotWrap.append(el('span', '', item.screenshotPath ? `已保存截图证据：${item.screenshotPath}` : item.screenshotFile?.name ? `已匹配待保存 PDP 截图：${item.screenshotFile.name}` : '页面不可读时附截图（PNG/JPEG/WebP，≤5 MB）'));
    const screenshot = document.createElement('input'); screenshot.type = 'file'; screenshot.accept = 'image/png,image/jpeg,image/webp'; screenshot.dataset.comparableScreenshot = 'true';
    screenshotWrap.append(screenshot); row.append(screenshotWrap);
    const note = jobField('来源/截图说明', '', item.sourceNote || '', '页内展示了所选变体价格 / 截图对应区域');
    note.querySelector('input').dataset.comparableField = 'sourceNote'; row.append(note);
    if (row._reviewsVisible.length || item.reviewGap || item.reviewDataStatus !== 'not_fetched') {
      const highCount = row._reviewsVisible.filter((review) => Number(review.rating) >= 4).length;
      const lowCount = row._reviewsVisible.filter((review) => Number(review.rating) >= 1 && Number(review.rating) <= 3).length;
      row.append(el('p', 'report-job-warning', `评论状态：${item.reviewDataStatus || '部分样本'} · 当前导入 ${highCount} 条高星 / ${lowCount} 条低星；每类最多 3 条，不足不补造。${item.reviewGap ? ` ${item.reviewGap}` : ''}`));
    }
    const remove = el('button', 'quiet-button', '移除该竞品'); remove.type = 'button'; remove.addEventListener('click', () => row.remove());
    row.append(remove);
    return row;
  }

  function renderJobProducts() {
    jobEl.products.replaceChildren();
    jobEl.products.append(el('h4', 'report-job-subtitle', t('productsTitle')));
    const list = el('div', 'report-candidate-list');
    const candidates = job.analysis?.productCandidates || [];
    candidates.forEach((item, index) => list.append(candidateRow(item, index)));
    if (!candidates.length) list.append(el('p', 'empty-inline', t('noProducts')));
    jobEl.products.append(list);
    const add = el('button', 'quiet-button', t('addProduct'));
    add.type = 'button';
    add.addEventListener('click', () => {
      if (list.querySelector('.empty-inline')) list.replaceChildren();
      list.append(candidateRow({ displayName: '', model: '', confidence: 0, missingFields: [] }, list.childElementCount));
    });
    jobEl.products.append(el('p', 'report-job-warning', '每个可售 SKU/配置单独一行；同一型号可重复添加，分别录入灯/风镜/颜色配置与成本。可通过“指定赛道分析”先建空任务，再人工新增截图型号，无需上传旧样本 PDF。'));
    jobEl.products.append(add);
   }

  function renderJobBrief() {
    jobEl.brief.replaceChildren();
    const brief = job.researchBrief || {};
    jobEl.brief.append(el('h4', 'report-job-subtitle', t('briefTitle')));
    const grid = el('div', 'field-grid report-brief-grid');
    grid.append(
      jobField(t('fieldCountry'), 'report-brief-country', brief.country || '', ''),
      jobField(t('fieldMarketplace'), 'report-brief-marketplace', brief.marketplace || '', 'Amazon.com'),
      jobField(t('fieldAudience'), 'report-brief-audience', brief.audience || '', ''),
      jobField(t('fieldPrice'), 'report-brief-price', brief.priceBand || '', 'US$20-60')
    );
    const groupsText = (brief.marketGroups || []).map((group) => `${group.label} | ${(group.keywords || []).join(',')}`).join('\n');
    grid.append(
      jobTextarea(t('fieldQuestions'), 'report-brief-questions', (brief.researchQuestions || []).join('\n'), ''),
      jobTextarea(t('fieldGroups'), 'report-brief-groups', groupsText, '')
    );
    jobEl.brief.append(grid);
  }

  function collectJobCorrections() {
    const categoryInput = jobEl.categories.querySelector('[data-category-label]');
    const ruleSelect = jobEl.categories.querySelector('[data-category-rulepack]');
    const categoryLabel = categoryInput ? categoryInput.value.trim() : (job.analysis?.categoryHypotheses?.[0]?.label || '');
    const products = [...jobEl.products.querySelectorAll('.report-candidate')].map((row, index) => {
      const base = (job.analysis?.productCandidates || []).find((candidate) => candidate.candidateId && candidate.candidateId === row.dataset.candidateId)
        || row._candidateSeed || (job.analysis?.productCandidates || [])[Number(row.dataset.index)] || {};
      const collectValues = (selector) => Object.fromEntries([...row.querySelectorAll(selector)].map((input) => [input.dataset.costField || input.dataset.feeField || input.dataset.comparableField || input.dataset.productField, input.value.trim()]));
      const cost = collectValues('[data-cost-field]');
      const fees = collectValues('[data-fee-field]');
      const shippingFields = collectValues('[data-shipping-field]');
      const rateFields = collectValues('[data-rate-field]');
      const shipping = {
        ...(base.shipping || {}), ...shippingFields,
        divisorConfirmed: row.querySelector('[data-shipping-confirmed="divisorConfirmed"]')?.checked === true,
        confirmed: row.querySelector('[data-shipping-confirmed="shippingConfirmed"]')?.checked === true,
        batteryTypeConfirmed: row.querySelector('[data-shipping-confirmed="batteryTypeConfirmed"]')?.checked === true,
        cartons: [...row.querySelectorAll('.report-shipping-carton')].map((cartonRow) => Object.fromEntries(
          [...cartonRow.querySelectorAll('[data-shipping-carton-field]')].map((input) => [input.dataset.shippingCartonField, input.value.trim()])
        )),
        rateOptions: [...row.querySelectorAll('.report-shipping-rate-option')].map((optionRow) => ({
          ...Object.fromEntries([...optionRow.querySelectorAll('[data-rate-option-field]')].map((input) => [
            input.dataset.rateOptionField, input.type === 'checkbox' ? input.checked : input.value.trim()
          ])),
          candidateOnly: optionRow.dataset.candidateOnly === 'true'
        })),
        rate: {
          ...(base.shipping?.rate || {}), ...rateFields,
          confirmed: row.querySelector('[data-shipping-confirmed="rateConfirmed"]')?.checked === true,
          batteryCompatible: false,
          evidencePath: base.shipping?.rate?.evidencePath || '',
          evidenceSha256: base.shipping?.rate?.evidenceSha256 || '',
          evidenceFile: row.querySelector('[data-rate-evidence]')?.files?.[0] || null
        }
      };
      const comparables = [...row.querySelectorAll('.report-comparable')].map((comparable) => {
        const fields = Object.fromEntries([...comparable.querySelectorAll('[data-comparable-field]')].map((input) => [input.dataset.comparableField, input.value.trim()]));
        const screenshotFile = comparable.querySelector('[data-comparable-screenshot]')?.files?.[0] || null;
        return {
          ...fields,
          price: fields.price || '',
          matchConfirmed: comparable.querySelector('[data-comparable-confirmed]')?.checked === true,
          sourceType: comparable.dataset.sourceType || 'user_entered',
          pageStatus: comparable.dataset.pageStatus || '',
          screenshotPath: comparable.dataset.screenshotPath || '',
          screenshotSha256: comparable.dataset.screenshotSha256 || '',
          screenshotReference: comparable.dataset.screenshotReference || '',
          reviewDataStatus: comparable.dataset.reviewDataStatus || 'not_fetched',
          reviewGap: comparable._reviewGap || '', reviewCounts: comparable._reviewCounts || {},
          importedSimilarityStatus: comparable._importedSimilarityStatus || '',
          reviewsVisible: comparable._reviewsVisible || [],
          screenshotFile: screenshotFile || comparable._screenshotFile || null,
          screenshotDataUrl: comparable._screenshotDataUrl || ''
        };
      });
      return {
        ...base,
        candidateId: base.candidateId || `candidate-${index + 1}`,
        displayName: row.querySelector('[data-candidate-field="displayName"]')?.value.trim() || base.displayName || '',
        model: row.querySelector('[data-candidate-field="model"]')?.value.trim() || base.model || '',
        modelConfirmed: row.querySelector('[data-model-confirmed]')?.checked === true,
        confidence: base.confidence ?? 0,
        missingFields: base.missingFields || [],
        researchKeywords: row.querySelector('[data-product-field="researchKeywords"]')?.value.trim() || '',
        premiumRationale: row.querySelector('[data-product-field="premiumRationale"]')?.value.trim() || '',
        cost: { ...(base.cost || {}), ...cost, confirmed: row.querySelector('[data-cost-confirmed]')?.checked === true },
      costEvidenceFile: row.querySelector('[data-cost-evidence]')?.files?.[0] || base.costEvidenceFile || null,
        shipping, batteryType: row.querySelector('[data-battery-type]')?.value || 'unknown',
        batteryTypeConfirmed: row.querySelector('[data-shipping-confirmed="batteryTypeConfirmed"]')?.checked === true,
        fees: { ...(base.fees || {}), ...fees, confirmed: row.querySelector('[data-fees-confirmed]')?.checked === true },
        competitors: comparables,
        status: 'candidate'
      };
    });
    const researchBrief = {
      category: categoryLabel,
      country: document.querySelector('#report-brief-country')?.value.trim() || '',
      marketplace: document.querySelector('#report-brief-marketplace')?.value.trim() || '',
      audience: document.querySelector('#report-brief-audience')?.value.trim() || '',
      priceBand: document.querySelector('#report-brief-price')?.value.trim() || '',
      researchQuestions: jobSplitLines(document.querySelector('#report-brief-questions')?.value),
      marketGroups: jobParseGroups(document.querySelector('#report-brief-groups')?.value)
    };
    return {
      category: categoryLabel,
      rulePackId: ruleSelect ? ruleSelect.value : (job.analysis?.categoryHypotheses?.[0]?.rulePackId || 'unknown-v1'),
      productCandidates: products,
      researchBrief
    };
  }

  function fileAsDataUrl(file) {
    if (!file) return Promise.resolve('');
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('截图读取失败，请重新选择文件。'));
      reader.readAsDataURL(file);
    });
  }

  async function correctionsWithScreenshots() {
    const corrections = collectJobCorrections();
    const evidenceLibrary = {};
    const evidenceIdByDataUrl = new Map();
    const fileDataUrls = new Map();
    let nextEvidenceId = 1;
    let uniqueEvidenceBytes = 0;
    const addEvidence = async (file, existingDataUrl = '') => {
      if (file && file.size > 5 * 1024 * 1024) throw new Error(`截图 ${file.name || ''} 超过 5 MB。`);
      if (file && !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error(`截图 ${file.name || ''} 不是 PNG/JPEG/WebP。`);
      const dataUrl = existingDataUrl || (file ? fileDataUrls.get(file) || await fileAsDataUrl(file) : '');
      if (!dataUrl) return '';
      if (file) fileDataUrls.set(file, dataUrl);
      const encoded = dataUrl.split(',')[1] || '';
      const decodedBytes = Math.floor(encoded.length * 3 / 4);
      if (decodedBytes > 5 * 1024 * 1024) throw new Error('单张截图超过 5 MB。');
      let evidenceId = evidenceIdByDataUrl.get(dataUrl);
      if (!evidenceId) {
        uniqueEvidenceBytes += decodedBytes;
        if (uniqueEvidenceBytes > 8 * 1024 * 1024) throw new Error('本次确认的不同截图总量超过 8 MB；请压缩图片或分批处理。');
        evidenceId = `image-${nextEvidenceId++}`;
        evidenceIdByDataUrl.set(dataUrl, evidenceId);
        evidenceLibrary[evidenceId] = dataUrl;
      }
      return evidenceId;
    };
    for (const product of corrections.productCandidates) {
      product.costEvidenceRef = await addEvidence(product.costEvidenceFile, product.costEvidenceDataUrl);
      delete product.costEvidenceDataUrl;
      delete product.costEvidenceFile;
      if (product.shipping?.rate?.evidenceFile) {
        product.shipping.rate.evidenceRef = await addEvidence(product.shipping.rate.evidenceFile, product.shipping.rate.evidenceDataUrl);
        delete product.shipping.rate.evidenceDataUrl;
        delete product.shipping.rate.evidenceFile;
      } else if (product.shipping?.rate) {
        delete product.shipping.rate.evidenceFile;
      }
      for (const competitor of product.competitors || []) {
        competitor.screenshotEvidenceRef = await addEvidence(competitor.screenshotFile, competitor.screenshotDataUrl);
        delete competitor.screenshotDataUrl;
        delete competitor.screenshotFile;
      }
    }
    corrections.evidenceLibrary = evidenceLibrary;
    return corrections;
  }

  function updateJobDownloadGate() {
    if (!jobEl.download) return;
    const artifact = job?.artifacts?.[0];
    const allowed = Boolean(job?.status === 'completed' && job.audit?.releaseAllowed && artifact);
    if (allowed) {
      jobEl.download.href = artifact.downloadUrl;
      jobEl.download.setAttribute('download', artifact.fileName);
      jobEl.download.classList.remove('disabled');
      jobEl.download.setAttribute('aria-disabled', 'false');
      jobEl.download.removeAttribute('tabindex');
      jobEl.download.title = '独立审核已通过';
    } else {
      jobEl.download.removeAttribute('href');
      jobEl.download.removeAttribute('download');
      jobEl.download.classList.add('disabled');
      jobEl.download.setAttribute('aria-disabled', 'true');
      jobEl.download.tabIndex = -1;
      jobEl.download.title = '独立审核通过前不可下载交付';
    }
  }

  function renderAuditPanel() {
    const hasArtifact = Boolean(job?.artifacts?.length);
    jobEl.auditPanel.hidden = !hasArtifact;
    updateJobDownloadGate();
    if (!hasArtifact) return;
    const audit = job.audit || {};
    const isProducerSession = Boolean(job.producer?.sessionId && actorSessionId() === job.producer.sessionId);
    const canReview = job.status === 'completed' && !audit.releaseAllowed && audit.status !== '退回纠错' && !isProducerSession;
    const canRepair = job.status === 'completed' && audit.status === '退回纠错' && isProducerSession;
    jobEl.auditStatus.textContent = audit.releaseAllowed ? '独立审核通过' : audit.status || '待独立审核';
    jobEl.auditStatus.className = `chip ${audit.releaseAllowed ? 'is-ok' : audit.status === '退回纠错' ? 'is-warn' : 'chip-muted'}`;
    jobEl.auditMeta.textContent = `任务 ${job.jobId} · 制作者 ${job.producer?.name || '未记录'} · 当前版本 revision ${job.revision} / build ${job.buildVersion} · 状态 ${audit.status || '待独立审核'}${audit.reviewer ? ` · 审核人 ${audit.reviewer} · 服务器审核时间 ${audit.checkedAt || '未记录'}` : ''}${audit.releaseAllowed ? ' · 已开放下载' : ' · 不可交付'}`;
    jobEl.auditRepairWrap.hidden = !canRepair;
    jobEl.auditRepairNotes.disabled = !canRepair;
    jobEl.auditReviewer.disabled = !canReview;
    jobEl.auditIssues.disabled = !canReview;
    jobEl.auditPanel.querySelectorAll('[data-audit-gate]').forEach((input) => {
      const gate = input.dataset.auditGate;
      input.checked = audit.gates?.[gate] === true;
      input.disabled = !canReview;
    });
    jobEl.auditApprove.disabled = !canReview;
    jobEl.auditReturn.disabled = !canReview;
    if (canReview) {
      if (!jobEl.auditActionStatus.classList.contains('error')) jobEl.auditActionStatus.textContent = '';
    } else if (isProducerSession && job.status === 'completed' && !audit.releaseAllowed && audit.status !== '退回纠错') {
      jobEl.auditActionStatus.textContent = '当前会话为制作会话，已禁用自审；请在独立审核会话输入此任务 ID。';
    } else if (audit.status === '退回纠错') {
      jobEl.auditActionStatus.textContent = canRepair ? '请根据退回问题修复并填写说明，再确认和重新生成版本。' : '已退回制作者修复；等待制作会话提交修订版本。';
    } else if (audit.releaseAllowed) {
      jobEl.auditActionStatus.textContent = '审核记录已锁定；当前版本可以下载交付。';
    } else {
      jobEl.auditActionStatus.textContent = '先生成 Excel，再由独立会话审核当前版本。';
    }

    jobEl.auditHistory.replaceChildren();
    const history = job.auditHistory || [];
    if (!history.length) {
      jobEl.auditHistory.append(el('li', '', '暂无审核或修复记录。'));
      return;
    }
    history.forEach((entry) => {
      const li = el('li');
      if (entry.type === 'repair') {
        li.textContent = `修复提交 · ${entry.producer || '制作者'} · ${entry.submittedAt || ''} · ${entry.notes || ''} · 对应问题：${(entry.issuesAddressed || []).join('；') || '未列明'}`;
      } else {
        li.textContent = `${entry.action === 'approve' ? '独立审核通过' : '退回纠错'} · ${entry.reviewer || '审核人未记录'} · ${entry.checkedAt || '审核时间未记录'} · v${entry.revision || '?'} / build ${entry.buildVersion || '?'} · ${(entry.issues || []).join('；') || '未记录问题'}`;
      }
      jobEl.auditHistory.append(li);
    });
  }

  async function loadAuditJob() {
    const jobId = jobEl.auditJobId.value.trim();
    if (!jobId) {
      jobEl.auditLoadStatus.textContent = '请输入制作方提供的任务 ID。';
      jobEl.auditLoadStatus.classList.add('error');
      return;
    }
    jobEl.auditLoad.disabled = true;
    jobEl.auditLoadStatus.classList.remove('error');
    jobEl.auditLoadStatus.textContent = '正在读取任务与审核版本…';
    try {
      const data = await jobApi(`/api/reports/jobs/${encodeURIComponent(jobId)}`);
      setJob(data);
      jobEl.auditLoadStatus.textContent = `已载入 ${data.jobId}；${data.status === 'completed' ? '可查看当前工作簿并执行审核。' : `当前任务状态：${data.status}`}`;
    } catch (error) {
      jobEl.auditLoadStatus.textContent = error.message;
      jobEl.auditLoadStatus.classList.add('error');
    } finally {
      jobEl.auditLoad.disabled = false;
    }
  }

  async function submitAudit(action) {
    if (!job) return;
    const reviewer = jobEl.auditReviewer.value.trim();
    const issues = jobEl.auditIssues.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const gates = Object.fromEntries([...jobEl.auditPanel.querySelectorAll('[data-audit-gate]')].map((input) => [input.dataset.auditGate, input.checked]));
    if (!reviewer) {
      jobEl.auditActionStatus.textContent = '审核人姓名为必填项。';
      jobEl.auditActionStatus.classList.add('error');
      jobEl.auditReviewer.focus();
      return;
    }
    if (action === 'return' && !issues.length) {
      jobEl.auditActionStatus.textContent = '退回时请至少填写一条可执行修复问题。';
      jobEl.auditActionStatus.classList.add('error');
      jobEl.auditIssues.focus();
      return;
    }
    if (action === 'approve' && (!Object.values(gates).every(Boolean) || issues.length)) {
      jobEl.auditActionStatus.textContent = '通过需要勾选全部核查项并清空未解决问题。';
      jobEl.auditActionStatus.classList.add('error');
      return;
    }
    jobEl.auditApprove.disabled = true;
    jobEl.auditReturn.disabled = true;
    jobEl.auditActionStatus.classList.remove('error');
    jobEl.auditActionStatus.textContent = '正在保存独立审核记录…';
    try {
      const data = await jobApi(`/api/reports/jobs/${encodeURIComponent(job.jobId)}/audit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action, reviewer, revision: job.revision,
          buildVersion: job.buildVersion, gates, issues
        })
      });
      setJob(data);
      jobEl.auditActionStatus.textContent = action === 'approve'
        ? `审核通过；服务器记录时间 ${data.audit.checkedAt}。当前版本已开放下载。`
        : `已退回制作者修复；服务器记录时间 ${data.audit.checkedAt}。原审核将保留在历史中。`;
    } catch (error) {
      jobEl.auditActionStatus.textContent = error.message;
      jobEl.auditActionStatus.classList.add('error');
    } finally {
      renderAuditPanel();
    }
  }

  function renderJob() {
    const status = job ? job.status : 'idle';
    jobEl.state.textContent = t(JOB_STATUS_KEYS[status] || 'jobIdle');
    jobEl.state.className = `chip ${status === 'completed' ? (job.audit?.releaseAllowed ? 'is-ok' : 'is-warn') : status === 'failed' ? 'is-warn' : status === 'awaiting_confirmation' ? 'is-active' : 'chip-muted'}`;
    if (!job) {
      jobEl.analysis.hidden = true;
      setPreviewState('none');
      renderAuditPanel();
      return;
    }
    const returnedToProducer = status === 'completed'
      && job.audit?.status === '退回纠错'
      && actorSessionId() === job.producer?.sessionId;
    const editable = EDITABLE_JOB_STATES.includes(status) || returnedToProducer;
    jobEl.analysis.hidden = !editable && status !== 'failed';
    const key = `${job.jobId}:${job.revision}`;
    if (editable && key !== jobRenderedKey) {
      jobRenderedKey = key;
      renderJobMeta();
      renderJobCategories();
      renderJobProducts();
      renderJobBrief();
    }
    jobEl.confirm.disabled = !editable;
    jobEl.research.disabled = status !== 'confirmed';
    jobEl.build.disabled = status !== 'confirmed';
    if (status === 'failed') setJobStatus(job.error?.message || t('statusFailed'), true);
    else if (status === 'completed') setJobStatus(job.audit?.status || '待独立审核；审核通过前不可交付');
    else if (['extracting', 'researching', 'scoring', 'building'].includes(status)) setJobStatus(t(JOB_STATUS_KEYS[status] || 'statusBuilding'));
    else if (status === 'awaiting_confirmation') setJobStatus(t('uploadDone'));
    renderAuditPanel();
  }

  function renderJobAll() {
    if (!job) {
      renderJob();
      return;
    }
    renderJobMeta();
    renderJobCategories();
    renderJobProducts();
    renderJobBrief();
    renderJob();
    if (jobPreviewState === 'ready' && jobPreview.sheet) {
      renderPreviewTable(jobPreview.manifest, jobPreview.sheet, jobPreview.allCells);
    }
  }

  function setJob(data) {
    const previousVersion = job ? `${job.jobId}:${job.revision}:${job.buildVersion}` : '';
    job = data || null;
    const nextVersion = job ? `${job.jobId}:${job.revision}:${job.buildVersion}` : '';
    if (nextVersion && nextVersion !== previousVersion) {
      jobEl.auditReviewer.value = '';
      jobEl.auditIssues.value = '';
      jobEl.auditRepairNotes.value = '';
      jobEl.auditActionStatus.textContent = '';
      jobEl.auditActionStatus.classList.remove('error');
    }
    if (previousVersion && nextVersion !== previousVersion) setPreviewState('none');
    try {
      if (job) sessionStorage.setItem(JOB_STORAGE_KEY, job.jobId);
      else sessionStorage.removeItem(JOB_STORAGE_KEY);
    } catch { /* optional */ }
    if (!job) {
      jobRenderedKey = '';
      renderJob();
      return;
    }
    if (jobEl.auditJobId) jobEl.auditJobId.value = job.jobId;
    if (job.status === 'completed' && Array.isArray(job.artifacts) && job.artifacts.length) {
      renderJob();
      void loadJobPreview();
    } else {
      setPreviewState('none');
      renderJob();
    }
  }

  async function confirmJob() {
    if (!job) return;
    jobEl.confirm.disabled = true;
    try {
      setPreviewState('none');
      jobRenderedKey = '';
      const corrections = await correctionsWithScreenshots();
      const data = await jobApi(`/api/reports/jobs/${encodeURIComponent(job.jobId)}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          revision: job.revision, corrections,
          repairNotes: job.audit?.status === '退回纠错' ? jobEl.auditRepairNotes.value.trim() : ''
        })
      });
      setJob(data);
      setJobStatus(t('confirmSaved'));
    } catch (error) {
      setJobStatus(`${t('statusFailed')}: ${error.message}`, true);
    } finally {
      jobEl.confirm.disabled = false;
    }
  }

  async function researchJob() {
    if (!job) return;
    jobEl.research.disabled = true;
    try {
      const data = await jobApi(`/api/reports/jobs/${encodeURIComponent(job.jobId)}/research`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: job.revision, delayMs: 600 })
      });
      jobRenderedKey = '';
      setJob(data);
      setJobStatus(t('researchReady'));
    } catch (error) {
      setJobStatus(`${t('statusFailed')}: ${error.message}`, true);
    } finally {
      jobEl.research.disabled = false;
    }
  }

  async function buildJob() {
    if (!job) return;
    jobEl.build.disabled = true;
    try {
      setPreviewState('none');
      const data = await jobApi(`/api/reports/jobs/${encodeURIComponent(job.jobId)}/build`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: job.revision })
      });
      setJob(data);
    } catch (error) {
      setJobStatus(`${t('statusFailed')}: ${error.message}`, true);
    } finally {
      jobEl.build.disabled = false;
    }
  }

  async function uploadCatalog(file) {
    if (!file) return;
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
      jobEl.uploadStatus.textContent = t('uploadFailed');
      jobEl.uploadStatus.classList.add('error');
      return;
    }
    jobEl.uploadStatus.classList.remove('error');
      jobEl.uploadStatus.textContent = `${t('statusExtracting')}…`;
    try {
      const form = new FormData();
      form.append('file', file, file.name);
      form.append('producerName', '本会话制作者');
      const data = await jobApi('/api/reports/jobs', { method: 'POST', body: form });
      setJob(data);
      jobEl.uploadStatus.textContent = t('uploadDone');
    } catch (error) {
      jobEl.uploadStatus.classList.add('error');
      jobEl.uploadStatus.textContent = `${t('uploadFailed')} ${error.message}`;
    }
  }

  async function createTrackJob() {
    const brief = {
      category: jobEl.trackCategory.value.trim(),
      country: jobEl.trackCountry.value.trim(),
      marketplace: jobEl.trackMarketplace.value.trim(),
      audience: jobEl.trackAudience.value.trim(),
      priceBand: jobEl.trackPrice.value.trim(),
      researchQuestions: jobSplitLines(jobEl.trackQuestions.value),
      marketGroups: jobParseGroups(jobEl.trackGroups.value)
    };
    if (!brief.category) {
      jobEl.trackStatus.textContent = t('trackCategoryRequired');
      jobEl.trackStatus.classList.add('error');
      return;
    }
    jobEl.trackStatus.classList.remove('error');
    jobEl.trackStatus.textContent = `${t('statusResearching')}…`;
    try {
      const data = await jobApi('/api/reports/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskType: 'track_analysis', brief, producerName: '本会话制作者' })
      });
      setJob(data);
      jobEl.trackStatus.textContent = t('uploadDone');
    } catch (error) {
      jobEl.trackStatus.classList.add('error');
      jobEl.trackStatus.textContent = `${t('uploadFailed')} ${error.message}`;
    }
  }

  function selectJobEntry(entry) {
    const isPdf = entry === 'pdf';
    jobEl.entryPdfTab.classList.toggle('is-active', isPdf);
    jobEl.entryTrackTab.classList.toggle('is-active', !isPdf);
    jobEl.entryPdfTab.setAttribute('aria-selected', String(isPdf));
    jobEl.entryTrackTab.setAttribute('aria-selected', String(!isPdf));
    jobEl.pdfEntry.hidden = !isPdf;
    jobEl.trackEntry.hidden = isPdf;
  }

  function columnLetter(index) {
    let value = index;
    let label = '';
    while (value > 0) {
      const mod = (value - 1) % 26;
      label = String.fromCharCode(65 + mod) + label;
      value = Math.floor((value - 1) / 26);
    }
    return label;
  }

  function columnIndex(letters) {
    let value = 0;
    for (const char of String(letters).toUpperCase()) value = value * 26 + (char.charCodeAt(0) - 64);
    return value;
  }

  function parseCellAddress(address) {
    const match = String(address || '').match(/^([A-Z]+)(\d+)$/i);
    return match ? { column: columnIndex(match[1]), row: Number(match[2]) } : null;
  }

  function parseMergeRange(range) {
    const [start, end] = String(range || '').split(':');
    const from = parseCellAddress(start);
    const to = parseCellAddress(end || start);
    return from && to ? { top: from.row, left: from.column, bottom: to.row, right: to.column } : null;
  }

  function argbToCss(value) {
    const text = String(value || '');
    return /^[0-9a-f]{6,8}$/i.test(text) ? `#${text.slice(-6)}` : '';
  }

  function safePreviewHref(value) {
    try {
      const url = new URL(String(value || ''), window.location.href);
      if (url.origin === window.location.origin && url.pathname.startsWith('/api/reports/jobs/')) return url.href;
      if (['amazon.com', 'www.amazon.com', 'smile.amazon.com'].includes(url.hostname.toLowerCase()) && ['http:', 'https:'].includes(url.protocol)) return url.href;
    } catch { /* invalid preview hyperlink */ }
    return '';
  }

  function renderPreviewImages(sheet) {
    jobEl.images.replaceChildren();
    const images = Array.isArray(sheet.imageEvidence) ? sheet.imageEvidence : [];
    jobEl.images.hidden = images.length === 0;
    images.forEach((image) => {
      const figure = document.createElement('figure');
      figure.className = 'report-preview-evidence';
      const link = document.createElement('a');
      link.href = safePreviewHref(image.imageUrl) || '#';
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      const thumbnail = document.createElement('img');
      thumbnail.src = safePreviewHref(image.imageUrl);
      thumbnail.alt = image.altText || image.fileName || '图片证据';
      thumbnail.loading = 'lazy';
      thumbnail.addEventListener('error', () => {
        figure.classList.add('is-unavailable');
        link.removeAttribute('href');
        link.textContent = '图片证据暂不可用';
      }, { once: true });
      link.append(thumbnail);
      figure.append(link);
      const caption = document.createElement('figcaption');
      caption.textContent = `${image.altText || image.fileName || '图片证据'}${image.sha256 ? ` · SHA-256 ${image.sha256.slice(0, 12)}…` : ''}`;
      figure.append(caption);
      jobEl.images.append(figure);
    });
  }

  function renderPreviewSheetTabs(manifest) {
    jobEl.sheets.replaceChildren();
    (manifest.sheets || []).forEach((sheet) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `report-preview-sheet-tab${sheet.sheetId === jobPreviewSheetId ? ' is-active' : ''}`;
      button.textContent = sheet.name;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(sheet.sheetId === jobPreviewSheetId));
      button.addEventListener('click', () => {
        if (sheet.sheetId !== jobPreviewSheetId) void selectPreviewSheet(sheet.sheetId);
      });
      jobEl.sheets.append(button);
    });
  }

  function renderPreviewTable(manifest, sheet, cells) {
    renderPreviewSheetTabs(manifest);
    const merges = (sheet.mergedRanges || []).map(parseMergeRange).filter(Boolean);
    const covered = new Set();
    const anchors = new Map();
    merges.forEach((merge) => {
      anchors.set(`${merge.top}:${merge.left}`, merge);
      for (let row = merge.top; row <= merge.bottom; row += 1) {
        for (let column = merge.left; column <= merge.right; column += 1) {
          if (row !== merge.top || column !== merge.left) covered.add(`${row}:${column}`);
        }
      }
    });
    const cellMap = new Map();
    let maxRow = 0;
    let maxColumn = 0;
    cells.forEach((cell) => {
      cellMap.set(`${cell.row}:${cell.column}`, cell);
      maxRow = Math.max(maxRow, cell.row);
      maxColumn = Math.max(maxColumn, cell.column);
    });
    maxRow = Math.max(maxRow, Math.min(sheet.rowCount || 0, 400));
    maxColumn = Math.max(maxColumn, Math.min(sheet.columnCount || 0, 40));
    const table = document.createElement('table');
    table.className = 'report-preview-grid';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    const corner = document.createElement('th');
    corner.className = 'is-corner';
    headRow.append(corner);
    for (let column = 1; column <= maxColumn; column += 1) {
      const th = document.createElement('th');
      th.textContent = columnLetter(column);
      if (column <= (sheet.frozenColumns || 0)) {
        th.classList.add('is-frozen-col');
        th.style.left = `${(column - 1) * PREVIEW_COL_WIDTH}px`;
      }
      headRow.append(th);
    }
    thead.append(headRow);
    table.append(thead);
    const tbody = document.createElement('tbody');
    for (let row = 1; row <= maxRow; row += 1) {
      const tr = document.createElement('tr');
      const header = document.createElement('th');
      header.scope = 'row';
      header.className = 'is-rowhead';
      header.textContent = String(row);
      if (row <= (sheet.frozenRows || 0)) {
        header.classList.add('is-frozen-row');
        header.style.top = `${PREVIEW_HEADER_HEIGHT + (row - 1) * PREVIEW_ROW_HEIGHT}px`;
      }
      tr.append(header);
      for (let column = 1; column <= maxColumn; column += 1) {
        if (covered.has(`${row}:${column}`)) continue;
        const cell = cellMap.get(`${row}:${column}`);
        const td = document.createElement('td');
        const merge = anchors.get(`${row}:${column}`);
        if (merge) {
          if (merge.right > merge.left) td.colSpan = merge.right - merge.left + 1;
          if (merge.bottom > merge.top) td.rowSpan = merge.bottom - merge.top + 1;
        }
        if (cell) {
          const hyperlink = safePreviewHref(cell.hyperlink);
          if (hyperlink) {
            const link = document.createElement('a');
            link.href = hyperlink;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = cell.displayValue;
            td.append(link);
          } else td.textContent = cell.displayValue;
          td.title = cell.address;
          if (cell.type === 'number') td.classList.add('is-number');
          if (cell.style?.bold) td.style.fontWeight = '700';
          const fill = argbToCss(cell.style?.fill);
          if (fill) td.style.background = fill;
          const color = argbToCss(cell.style?.color);
          if (color) td.style.color = color;
        }
        if (row <= (sheet.frozenRows || 0)) {
          td.classList.add('is-frozen-row');
          td.style.top = `${PREVIEW_HEADER_HEIGHT + (row - 1) * PREVIEW_ROW_HEIGHT}px`;
        }
        if (column <= (sheet.frozenColumns || 0)) {
          td.classList.add('is-frozen-col');
          td.style.left = `${(column - 1) * PREVIEW_COL_WIDTH}px`;
        }
        tr.append(td);
      }
      tbody.append(tr);
    }
    table.append(tbody);
    jobEl.table.replaceChildren(table);
    renderPreviewImages(sheet);
    jobEl.previewMeta.textContent = `${sheet.name} · ${sheet.rowCount || maxRow} ${t('previewRows')} × ${sheet.columnCount || maxColumn} · ${t('previewSource')}`;
    jobEl.more.hidden = !sheet.hasMore;
  }

  async function fetchPreviewPage() {
    const artifact = job.artifacts?.[0];
    if (!artifact) throw new Error(t('previewLoadFailed'));
    const path = `/api/reports/jobs/${encodeURIComponent(job.jobId)}/workbooks/${encodeURIComponent(artifact.workbookId)}/preview?sheetId=${encodeURIComponent(jobPreviewSheetId)}&page=${jobPreviewPage}&pageSize=${PREVIEW_PAGE_SIZE}`;
    const data = await jobApi(path);
    const matches = data.jobId === job.jobId
      && data.revision === job.revision
      && data.buildVersion === job.buildVersion
      && data.workbookId === artifact.workbookId
      && data.manifest?.artifactId === artifact.artifactId;
    if (!matches) throw Object.assign(new Error(t('previewStale')), { code: 'artifact_version_mismatch' });
    return data;
  }

  async function loadJobPreview() {
    if (!job || jobPreviewState === 'ready' || jobPreviewLoading) return;
    const artifact = job.artifacts?.[0];
    if (!artifact) return;
    jobPreviewLoading = true;
    try {
      jobPreviewSheetId = '';
      jobPreviewPage = 1;
      const data = await fetchPreviewPage();
      jobPreviewSheetId = data.sheet.sheetId;
      jobPreview = { manifest: data.manifest, sheet: data.sheet, allCells: data.sheet.cells };
      renderPreviewTable(data.manifest, data.sheet, data.sheet.cells);
      updateJobDownloadGate();
      jobEl.version.textContent = `${artifact.fileName} · v${job.buildVersion}`;
      setPreviewState('ready');
    } catch (error) {
      setPreviewState('error');
      setJobStatus(`${t('previewLoadFailed')} ${error.message}`, true, artifact);
    } finally {
      jobPreviewLoading = false;
    }
  }

  async function selectPreviewSheet(sheetId) {
    if (!job) return;
    try {
      jobPreviewSheetId = sheetId;
      jobPreviewPage = 1;
      const data = await fetchPreviewPage();
      jobPreview = { manifest: data.manifest, sheet: data.sheet, allCells: data.sheet.cells };
      renderPreviewTable(data.manifest, data.sheet, data.sheet.cells);
    } catch (error) {
      setJobStatus(error.message, true);
    }
  }

  async function loadMorePreview() {
    if (!job || !jobPreview.sheet?.hasMore) return;
    jobEl.more.disabled = true;
    try {
      jobPreviewPage += 1;
      const data = await fetchPreviewPage();
      jobPreview = {
        manifest: data.manifest,
        sheet: data.sheet,
        allCells: jobPreview.allCells.concat(data.sheet.cells)
      };
      renderPreviewTable(data.manifest, data.sheet, jobPreview.allCells);
    } catch (error) {
      setJobStatus(error.message, true);
    } finally {
      jobEl.more.disabled = false;
    }
  }

  async function resumeJob() {
    const entry = new URLSearchParams(window.location.search);
    if (entry.get('entry') === 'track') {
      // A new cross-category project must not silently resume the previous task.
      renderJob();
      selectJobEntry('track');
      if (entry.has('category')) jobEl.trackCategory.value = entry.get('category').slice(0, 100);
      if (entry.has('market')) jobEl.trackCountry.value = entry.get('market').slice(0, 100);
      return;
    }
    let stored = '';
    try { stored = sessionStorage.getItem(JOB_STORAGE_KEY) || ''; } catch { /* optional */ }
    if (!stored) {
      renderJob();
      return;
    }
    try {
      const data = await jobApi(`/api/reports/jobs/${encodeURIComponent(stored)}`);
      setJob(data);
    } catch {
      try { sessionStorage.removeItem(JOB_STORAGE_KEY); } catch { /* optional */ }
      renderJob();
    }
  }

  function initJobFlow() {
    jobEl.entryPdfTab.addEventListener('click', () => selectJobEntry('pdf'));
    jobEl.entryTrackTab.addEventListener('click', () => selectJobEntry('track'));
    jobEl.pdfInput.addEventListener('change', () => {
      const file = jobEl.pdfInput.files?.[0];
      jobEl.pdfInput.value = '';
      void uploadCatalog(file);
    });
    ['dragenter', 'dragover'].forEach((type) => jobEl.dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      jobEl.dropzone.classList.add('is-dragover');
    }));
    ['dragleave', 'drop'].forEach((type) => jobEl.dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      jobEl.dropzone.classList.remove('is-dragover');
    }));
    jobEl.dropzone.addEventListener('drop', (event) => {
      const file = event.dataTransfer?.files?.[0];
      if (file) void uploadCatalog(file);
    });
    jobEl.trackCreate.addEventListener('click', () => { void createTrackJob(); });
    jobEl.auditLoad.addEventListener('click', () => { void loadAuditJob(); });
    jobEl.auditJobId.addEventListener('keydown', (event) => { if (event.key === 'Enter') void loadAuditJob(); });
    jobEl.auditApprove.addEventListener('click', () => { void submitAudit('approve'); });
    jobEl.auditReturn.addEventListener('click', () => { void submitAudit('return'); });
    jobEl.confirm.addEventListener('click', () => { void confirmJob(); });
    jobEl.research.addEventListener('click', () => { void researchJob(); });
    jobEl.build.addEventListener('click', () => { void buildJob(); });
    jobEl.more.addEventListener('click', () => { void loadMorePreview(); });
    void loadActorSession().then(async () => {
      await loadStatus();
      await resumeJob();
    }).catch(async () => {
      jobEl.auditLoadStatus.textContent = '无法读取安全审核会话；请刷新报告中心后重试。';
      jobEl.auditLoadStatus.classList.add('error');
      await loadStatus();
      await resumeJob();
    });
  }

  refreshSummary.addEventListener('change', () => {
    if (refreshSummary.checked && refreshSummary.disabled) refreshSummary.checked = false;
  });
  buildButton.addEventListener('click', buildReports);
  refreshStatusButton.addEventListener('click', loadStatus);
  observedInput.value = new Date().toISOString().slice(0, 10);
  initTheme();
  initLocale();
  renderMethod();
  loadHealth();
  initJobFlow();
})();
