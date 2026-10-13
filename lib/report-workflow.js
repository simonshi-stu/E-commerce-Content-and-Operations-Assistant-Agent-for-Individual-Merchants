'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { newAuditRecord } = require('./report-audit');

const REPORT_DEFINITIONS = {
  competitor: {
    prefix: 'Amazon美国站头盔竞品爆款拆解_',
    fallback: 'Amazon美国站头盔竞品爆款拆解_2026-09-22.xlsx'
  },
  yongbao: {
    prefix: '永宝产品美国站进入潜力评估_',
    fallback: '永宝产品美国站进入潜力评估_2026-09-22.xlsx'
  }
};

function readJson(filePath, fallback = null) {
  try {
    return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : fallback;
  } catch {
    return fallback;
  }
}

function fileInfo(root, filePath, kind) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  return {
    kind,
    fileName: path.basename(filePath),
    path: path.relative(root, filePath).replace(/\\/g, '/'),
    sizeBytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    downloadUrl: `/api/reports/download/${kind}`
  };
}

function latestReportPath(root, definition) {
  const reportsDir = path.join(root, 'reports');
  if (!fs.existsSync(reportsDir)) return path.join(reportsDir, definition.fallback);
  const candidates = fs.readdirSync(reportsDir)
    .filter((fileName) => fileName.startsWith(definition.prefix) && fileName.endsWith('.xlsx') && !fileName.startsWith('~$'))
    .map((fileName) => path.join(reportsDir, fileName))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0] || path.join(reportsDir, definition.fallback);
}

function sourceSnapshot(root) {
  const catalog = readJson(path.join(root, 'tmp', 'yongbao-catalog.json'), []);
  const details = readJson(path.join(root, 'tmp', 'yongbao-competitor-details.json'), { records: [], provenance: {} });
  const summaries = readJson(path.join(root, 'tmp', 'yongbao-competitor-summaries.json'), { products: {} });
  const pdfPath = process.env.YONGBAO_PDF || '';
  return {
    catalogRows: Array.isArray(catalog) ? catalog.length : 0,
    productFamilies: (() => {
      const keys = new Set((Array.isArray(catalog) ? catalog : []).map((row) => `${row.model}|${row.segment}`));
      return keys.size;
    })(),
    pdfAvailable: Boolean(pdfPath && fs.existsSync(pdfPath)),
    pdfPath: pdfPath && fs.existsSync(pdfPath) ? path.relative(root, pdfPath).replace(/\\/g, '/') : '',
    amazonRecords: Array.isArray(details.records) ? details.records.length : 0,
    amazonObservedAt: details.provenance?.observedAt || '',
    aiSummaries: summaries.products ? Object.keys(summaries.products).filter((key) => key !== 'type').length : 0,
    dataBasis: 'Amazon.com 美国站公开前台；不使用 Seller Central、SP-API、广告 API 或卖家后台'
  };
}

function compactBuildResult(root, build, source) {
  const assessment = build.assessment;
  const counts = assessment.products.reduce((result, product) => {
    result[product.verdict] = (result[product.verdict] || 0) + 1;
    return result;
  }, {});
  const priority = assessment.products.filter((product) => product.verdict === '首批推荐').slice(0, 9).map((product) => ({
    rank: product.rank,
    model: product.model,
    catalogNos: product.catalogNos,
    name: product.chineseName,
    score: product.totalScore,
    segment: product.segmentLabel
  }));
  return {
    observedAt: new Date().toISOString().slice(0, 10),
    source: { ...source, amazonRecords: source.amazonRecords || build.markets.reduce((total, market) => total + market.hits.length, 0) },
    competitor: {
      file: fileInfo(root, build.competitor.outputPath, 'competitor'),
      sheetCount: build.competitor.sheetCount,
      embeddedImages: build.competitor.embeddedImages,
      marketGroups: build.markets.map((market) => ({
        id: market.id,
        label: market.label,
        sample: market.summary.sample,
        medianPrice: market.summary.price.median,
        averageRating: market.summary.averageRating,
        reviewMedian: market.summary.reviewMedian,
        monthlyBoughtFloor: market.summary.monthlyBoughtFloor,
        entryFriendliness: market.summary.entryFriendliness,
        hits: market.hits.map((hit) => ({ asin: hit.asin, title: hit.title, price: hit.price, reviews: hit.reviews, rating: hit.rating, bought: hit.bought }))
      }))
    },
    yongbao: {
      file: fileInfo(root, build.yongbao.outputPath, 'yongbao'),
      sheetCount: build.yongbao.sheetCount,
      productFamilies: assessment.products.length,
      counts,
      priority,
      rankedProducts: assessment.products.map((product) => ({
        rank: product.rank,
        catalogNos: product.catalogNos,
        model: product.model,
        name: product.chineseName,
        segment: product.segmentLabel,
        audience: product.audienceLabel,
        score: product.totalScore,
        verdict: product.verdict,
        compliance: product.compliance.status
      })),
      pdfEmbedded: false
    },
    validation: build.validation
  };
}

function availableReports(root) {
  const files = Object.fromEntries(Object.entries(REPORT_DEFINITIONS).map(([kind, definition]) => [
    kind,
    fileInfo(root, latestReportPath(root, definition), kind)
  ]));
  const assessment = readJson(path.join(root, 'tmp', 'yongbao-product-assessment-v2.json'), null);
  const details = readJson(path.join(root, 'tmp', 'yongbao-competitor-details.json'), { records: [] });
  if (files.competitor) {
    files.competitor.sheetCount = 18;
    files.competitor.embeddedImages = Array.isArray(details.records) ? details.records.filter((record) => record.image).length : 0;
  }
  if (files.yongbao) {
    const productFamilies = Array.isArray(assessment?.products) ? assessment.products.length : 66;
    files.yongbao.sheetCount = productFamilies + 3;
    files.yongbao.productFamilies = productFamilies;
  }
  return files;
}

function createReportWorkflowService({ root, executePipeline } = {}) {
  const resultPath = path.join(root, 'tmp', 'report-workflow-latest.json');
  const statePath = path.join(root, 'tmp', 'report-workflow-state.json');
  const persistedResult = readJson(resultPath, null);
  const persisted = readJson(statePath, {});
  const producer = persisted.producer || { name: persistedResult ? '历史任务：制作会话未记录' : '', sessionId: '' };
  const state = {
    status: persisted.status || (persistedResult ? 'completed' : 'idle'),
    progress: persisted.progress || (persistedResult
      ? { stage: 'completed', completed: 5, total: 5, message: '报告已生成；待独立审核，通过后方可交付' }
      : { stage: 'idle', completed: 0, total: 5, message: '等待生成' }),
    result: persistedResult,
    error: persisted.error || null,
    jobId: persisted.jobId || '',
    revision: Number(persisted.revision) || (persistedResult ? 1 : 0),
    buildVersion: Number(persisted.buildVersion) || 0,
    producer,
    audit: persisted.audit || newAuditRecord(producer, { revision: Number(persisted.revision) || 0, buildVersion: Number(persisted.buildVersion) || 0 }),
    auditHistory: Array.isArray(persisted.auditHistory) ? persisted.auditHistory : [],
    startedAt: persisted.startedAt || '',
    finishedAt: persisted.finishedAt || ''
  };

  function persist() {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({
      status: state.status, progress: state.progress, error: state.error, jobId: state.jobId,
      revision: state.revision, buildVersion: state.buildVersion, producer: state.producer,
      audit: state.audit, auditHistory: state.auditHistory, startedAt: state.startedAt, finishedAt: state.finishedAt
    }, null, 2));
  }

  function publicState() {
    return {
      status: state.status, progress: state.progress, result: state.result, error: state.error,
      jobId: state.jobId, revision: state.revision, buildVersion: state.buildVersion,
      producer: state.producer, audit: state.audit, auditHistory: state.auditHistory,
      startedAt: state.startedAt, finishedAt: state.finishedAt,
      source: sourceSnapshot(root), availableReports: availableReports(root)
    };
  }

  function update(progress) {
    state.progress = { ...state.progress, ...progress };
  }

  async function run(options) {
    let build;
    if (executePipeline) {
      build = await executePipeline({ root, options, onProgress: update });
    } else {
      const { buildMarketData } = require('../scripts/yongbao-report-data');
      const { researchYongbaoCompetitors } = require('../scripts/research-yongbao-competitors');
      const { summarizeYongbaoCompetitors } = require('../scripts/summarize-yongbao-competitors');
      const { buildReportFiles } = require('../scripts/build-yongbao-xlsx-reports');
      const tmp = path.join(root, 'tmp');
      fs.mkdirSync(tmp, { recursive: true });
      update({ stage: 'catalog', completed: 1, total: 5, message: '读取目录并识别型号 + 品类去重键' });
      const marketData = buildMarketData();
      update({ stage: 'market', completed: 2, total: 5, message: `完成 ${marketData.length} 组市场清洗、受众证据和搜索展示位拆分` });

      if (options.refreshAmazon) {
        await researchYongbaoCompetitors({
          delayMs: options.delayMs,
          observedAt: options.observedAt,
          onProgress: (progress) => update({ stage: 'amazon', completed: 2, total: 5, message: `Amazon公开商品页 ${progress.completed || 0}/${progress.total || 12}` })
        });
      } else if (!fs.existsSync(path.join(tmp, 'yongbao-competitor-details.json'))) {
        throw Object.assign(new Error('缺少 Amazon 公开前台证据，请勾选“重新采集 Amazon 商品页”。'), { code: 'missing_amazon_evidence' });
      }
      update({ stage: 'amazon', completed: 3, total: 5, message: options.refreshAmazon ? 'Amazon公开商品页采集完成' : '复用已有 Amazon 公开商品页证据' });

      if (options.refreshSummary) {
        await summarizeYongbaoCompetitors();
      } else if (!fs.existsSync(path.join(tmp, 'yongbao-competitor-summaries.json'))) {
        fs.writeFileSync(path.join(tmp, 'yongbao-competitor-summaries.json'), JSON.stringify({ observedAt: options.observedAt, basis: 'Amazon.com US public front-end evidence only', products: {} }, null, 2));
      }
      update({ stage: 'scoring', completed: 4, total: 5, message: '完成产品拆分、中文命名、合规硬门槛和 100 分评分' });
      build = await buildReportFiles({ onProgress: (progress) => update({ stage: 'xlsx', completed: 4 + Math.min(1, progress.completed || 0) / 2, total: 5, message: progress.message }) });
    }
    state.result = compactBuildResult(root, build, sourceSnapshot(root));
    fs.writeFileSync(resultPath, JSON.stringify(state.result, null, 2));
    state.audit = newAuditRecord(state.producer, { revision: state.revision, buildVersion: state.buildVersion });
    update({ stage: 'completed', completed: 5, total: 5, message: '报告已生成；待独立审核，通过后方可交付' });
  }

  function start(options = {}) {
    if (state.status === 'running') return { accepted: false, status: publicState() };
    const repaired = state.status === 'completed' && state.audit?.status === '退回纠错';
    if (state.status === 'completed' && state.producer?.sessionId && !repaired) {
      throw Object.assign(new Error('A completed report can only be rebuilt after it is returned for correction.'), { code: 'report_review_return_required' });
    }
    const actorSessionId = String(options.actorSessionId || '');
    const repairNotes = String(options.repairNotes || '').trim().slice(0, 4000);
    if (!actorSessionId) throw Object.assign(new Error('A server-issued producer session is required.'), { code: 'producer_session_required' });
    if (repaired) {
      if (actorSessionId !== state.producer.sessionId) throw Object.assign(new Error('Only the producing session can rebuild a returned report.'), { code: 'repair_producer_required' });
      if (!repairNotes) throw Object.assign(new Error('Describe the repairs before rebuilding the report.'), { code: 'repair_notes_required' });
      state.auditHistory.push({
        type: 'repair', status: '已提交修复', producer: state.producer.name, producerSessionId: state.producer.sessionId,
        submittedAt: new Date().toISOString(), priorRevision: state.revision, priorBuildVersion: state.buildVersion,
        issuesAddressed: [...(state.audit.issues || [])], notes: repairNotes
      });
      state.revision += 1;
      state.audit = { ...state.audit, status: '修复中', releaseAllowed: false };
    } else if (!state.producer?.sessionId || !state.jobId) {
      state.jobId = `reports-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
      state.revision = 1;
      state.buildVersion = 0;
      state.producer = { name: String(options.producerName || '本会话制作者').slice(0, 120), sessionId: actorSessionId };
      state.audit = newAuditRecord(state.producer, { revision: state.revision, buildVersion: 0 });
    } else if (actorSessionId !== state.producer.sessionId) {
      throw Object.assign(new Error('Only the producing session can retry this report build.'), { code: 'repair_producer_required' });
    }
    state.buildVersion += 1;
    state.audit = newAuditRecord(state.producer, { revision: state.revision, buildVersion: state.buildVersion });
    state.status = 'running';
    state.error = null;
    state.startedAt = new Date().toISOString();
    state.finishedAt = '';
    state.progress = { stage: 'starting', completed: 0, total: 5, message: '准备报告工作流' };
    const parsedDelayMs = Number.parseInt(options.delayMs, 10);
    const resolved = {
      refreshAmazon: Boolean(options.refreshAmazon),
      refreshSummary: Boolean(options.refreshSummary),
      delayMs: Number.isInteger(parsedDelayMs) ? Math.min(15_000, Math.max(0, parsedDelayMs)) : 1_500,
      observedAt: options.observedAt || new Date().toISOString().slice(0, 10)
    };
    persist();
    void run(resolved).then(() => {
      state.status = 'completed';
      state.finishedAt = new Date().toISOString();
      persist();
    }).catch((error) => {
      state.status = 'failed';
      state.error = { code: error.code || 'report_workflow_failed', message: error.message || '报告生成失败。' };
      state.finishedAt = new Date().toISOString();
      persist();
    });
    return { accepted: true, status: publicState() };
  }

  function recordAudit(payload = {}) {
    if (state.status !== 'completed') throw Object.assign(new Error('Build the report before independent review.'), { code: 'review_requires_build' });
    if (!state.producer?.sessionId) throw Object.assign(new Error('This legacy report has no recorded producer session; rebuild it before review.'), { code: 'producer_session_missing' });
    if (state.audit?.releaseAllowed) throw Object.assign(new Error('This report version has already passed independent review.'), { code: 'review_already_approved' });
    if (state.audit?.status === '退回纠错') throw Object.assign(new Error('A returned report must be rebuilt before another review.'), { code: 'audit_returned_requires_rebuild' });
    const action = String(payload.action || '').trim();
    if (!['approve', 'return'].includes(action)) throw Object.assign(new Error('Audit action must be approve or return.'), { code: 'invalid_audit_action' });
    const reviewer = String(payload.reviewer || '').trim().slice(0, 120);
    const reviewerSessionId = String(payload.reviewerSessionId || '');
    if (!reviewer || !reviewerSessionId) throw Object.assign(new Error('Reviewer name and independent session are required.'), { code: 'independent_reviewer_required' });
    if (reviewerSessionId === state.producer.sessionId || reviewer.toLocaleLowerCase() === state.producer.name.toLocaleLowerCase()) {
      throw Object.assign(new Error('The producer cannot audit their own report.'), { code: 'self_audit_forbidden' });
    }
    if (Number(payload.revision) !== state.revision || Number(payload.buildVersion) !== state.buildVersion) {
      throw Object.assign(new Error('Audit must target the current report revision and build.'), { code: 'audit_version_mismatch' });
    }
    const issues = Array.isArray(payload.issues) ? payload.issues.map((item) => String(item || '').trim().slice(0, 1000)).filter(Boolean).slice(0, 100) : [];
    const gates = {
      facts: payload.gates?.facts === true, links: payload.gates?.links === true,
      comments: payload.gates?.comments === true, conclusions: payload.gates?.conclusions === true
    };
    if (action === 'return' && !issues.length) throw Object.assign(new Error('Add at least one actionable issue before returning the report.'), { code: 'audit_issue_required' });
    if (action === 'approve' && (!Object.values(gates).every(Boolean) || issues.length)) {
      throw Object.assign(new Error('Approval requires all audit gates checked and no unresolved issues.'), { code: 'audit_gates_incomplete' });
    }
    state.audit = {
      ...state.audit, status: action === 'approve' ? '独立审核通过' : '退回纠错', reviewer,
      reviewerSessionId, checkedAt: new Date().toISOString(), revision: state.revision,
      buildVersion: state.buildVersion, issues, gates, releaseAllowed: action === 'approve'
    };
    state.auditHistory.push({ type: 'audit', action, ...state.audit });
    persist();
    return publicState();
  }

  return { publicState, recordAudit, start };
}

function resolveReportDownload(root, kind) {
  const definition = REPORT_DEFINITIONS[kind];
  if (!definition) return null;
  const filePath = latestReportPath(root, definition);
  return filePath && fs.existsSync(filePath) ? { filePath, fileName: path.basename(filePath) } : null;
}

module.exports = { REPORT_DEFINITIONS, createReportWorkflowService, resolveReportDownload, sourceSnapshot };
