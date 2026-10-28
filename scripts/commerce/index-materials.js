'use strict';
/**
 * Shop-materials indexer (read-only source).
 *
 * Usage:
 *   node scripts/commerce/index-materials.js \
 *     --input <catalog.json> --mapping <mapping.json> \
 *     --source-root <read-only source directory> \
 *     --imports <runtime/imports/materials> \
 *     --evidence <runtime/evidence/materials> \
 *     --catalog <docs/material-catalog.md> \
 *     [--reps <representative decodes per family>]
 *
 * Guards (application-level constraints, not OS isolation):
 * - Every output target (imports/evidence/catalog and their temp files) is resolved and rejected
 *   before any mkdir/write when it lies inside the read-only source (relative paths and
 *   existing-ancestor realpaths included, so junctions/aliases cannot bypass).
 * - Content fingerprints are taken before and after the scan; if the source changed during the
 *   scan the run stops BEFORE publishing any canonical output. Concurrent external changes still
 *   need a checkpoint — this is not a filesystem lock.
 *
 * All catalog values (paths, families, aliases, tokens) come from the injected files; this script
 * hardcodes none of them.
 */
const fs = require('node:fs');
const path = require('node:path');
const assets = require('../../lib/commerce/assets.js');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    args[key] = value;
  }
  return args;
}

function nearestExistingAncestor(target) {
  let current = target;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}
function isInside(child, parent) {
  const rel = path.relative(parent, child);
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${path.sep}`);
}
/** Resolves each output target (via its existing ancestor realpath) and rejects source overlap. */
function assertOutputsOutsideSource(sourceRoot, targets) {
  const sourceReal = fs.realpathSync(sourceRoot);
  for (const [name, target] of Object.entries(targets)) {
    const absolute = path.resolve(target);
    const ancestorReal = fs.realpathSync(nearestExistingAncestor(absolute));
    if (isInside(ancestorReal, sourceReal)) {
      throw new Error(`--${name} target resolves inside the read-only source and is refused before any write (${name}: ${target})`);
    }
  }
}

/** folder -> family/source-set from the supplied catalog (authoritative aliases/source folders). */
function buildFamilies(input) {
  const folders = {};
  const families = {};
  for (const product of input.products) {
    families[product.productFamilyKey] = {
      nickname: product.nickname,
      aliases: product.aliases ?? [],
      category: product.category,
      sourceSets: (product.sourceFolders ?? []).map((folder) => `${product.productFamilyKey}:${folder}`)
    };
    for (const folder of product.sourceFolders ?? []) {
      folders[folder] = { familyKey: product.productFamilyKey, sourceSetId: `${product.productFamilyKey}:${folder}` };
    }
  }
  return { folders, families };
}

/** Representative decode evidence: only supported pixel decodes become png_pixel_decode evidence. */
function buildDecodeEvidence(associated, families, sourceRoot, repsPerFamily) {
  const evidence = [];
  for (const familyKey of Object.keys(families).sort()) {
    const familyRecords = associated.files.filter((record) => record.familyKey === familyKey);
    const supportedPngs = familyRecords.filter((record) => record.format === 'png' && record.image?.pixelDecode?.supported === true);
    for (const record of supportedPngs.slice(0, repsPerFamily)) {
      const buffer = fs.readFileSync(path.join(sourceRoot, ...record.relPath.split('/')));
      const signature = assets.pixelSignature(buffer);
      evidence.push({
        familyKey,
        relPath: record.relPath,
        sha256: record.sha256,
        kind: 'png_pixel_decode',
        width: record.image.width,
        height: record.image.height,
        alpha: record.image.alpha,
        rgbaBytes: signature.bytes,
        rgbaSha256: signature.rgbaSha256,
        supported: signature.supported
      });
    }
    for (const record of familyRecords.filter((r) => r.format === 'png' && r.image?.pixelDecode && !r.image.pixelDecode.supported)) {
      evidence.push({ familyKey, relPath: record.relPath, sha256: record.sha256, kind: 'png_pixel_unsupported', supported: false, reason: record.image.pixelDecode.reason });
    }
    const jpeg = familyRecords.find((record) => record.format === 'jpeg' && record.image?.supported);
    if (jpeg) {
      evidence.push({
        familyKey,
        relPath: jpeg.relPath,
        sha256: jpeg.sha256,
        kind: 'jpeg_header_parse',
        width: jpeg.image.width,
        height: jpeg.image.height,
        alpha: jpeg.image.alpha,
        note: 'header-level dimensions only; no pixel decode for JPEG in this task'
      });
    }
  }
  return evidence;
}

function buildComparisons(associated, families) {
  const comparisons = [];
  for (const familyKey of Object.keys(families).sort()) {
    const bySet = new Map();
    for (const record of associated.files.filter((record) => record.familyKey === familyKey)) {
      if (!bySet.has(record.designSetId)) bySet.set(record.designSetId, record);
    }
    comparisons.push({
      familyKey,
      nickname: families[familyKey].nickname,
      sourceSets: [...bySet.values()].map((record) => ({
        designSetId: record.designSetId,
        representativeRelPath: record.relPath,
        sha256: record.sha256,
        width: record.image?.width ?? null,
        height: record.image?.height ?? null
      }))
    });
  }
  return comparisons;
}

function buildCatalog({ associated, families, input, decodeEvidence, sourceRoot, extraNotes = [] }) {
  const familyLines = Object.keys(families).sort().map((familyKey) => {
    const familyRecords = associated.files.filter((record) => record.familyKey === familyKey);
    const contentCount = new Set(familyRecords.map((record) => record.sha256)).size;
    return `| ${familyKey} | ${families[familyKey].nickname} | ${(families[familyKey].aliases ?? []).join(', ')} | ${familyRecords.length} | ${contentCount} | ${families[familyKey].sourceSets.join(' / ')} |`;
  });
  const pendingLines = (input.pending ?? []).map((item) => `- ${item}`);
  return [
    '# MATERIAL-CATALOG — 店铺素材索引（本地输入索引）',
    '',
    `> 生成：index-materials.js｜源目录（只读）：\`${sourceRoot}\`｜sourceRootId：\`${input.inputId}\``,
    `> 内容指纹：\`${associated.fingerprintAfter?.fingerprint ?? ''}\`（${associated.fingerprintAfter?.fileCount ?? ''} 文件 / ${associated.fingerprintAfter?.totalBytes ?? ''} 字节；前后一致=${associated.sourceStable}）`,
    `> rawIndexHash：\`${associated.rawIndexHash}\`｜关联版本 stableHash：\`${associated.stableHash}\`（canonical 投影含关联字段与 association 摘要）`,
    '',
    '## 状态/格式总览',
    '',
    `- 状态：${JSON.stringify(associated.statusCounts)}`,
    `- 格式（业务素材）：${JSON.stringify(associated.formats)}`,
    `- 忽略（.WeDrive 等设计工具元数据，非业务素材）：${associated.ignoredCount}`,
    '',
    '## 商品族（nickname ≠ 正式型号 ≠ SKU；alias 只关联商品族）',
    '',
    '| familyKey | nickname | aliases | 文件数 | 内容对象 | 来源集（designSetId） |',
    '|---|---|---|---|---|---|',
    ...familyLines,
    '',
    '## 角色/用途候选（candidate，不确认）',
    '',
    '- 角色来自路径 token / 格式默认：photo/cutout/product/reference/description/compliance_document/video/unknown。',
    '- 用途候选：main/detail（来自目录 token）；旧海报不自动获得 MAIN 资格；合规文档不绑定整机合规（complianceBinding=false）。',
    '- SKU：颜色/配置仅为候选（如 color:… candidate）；未映射保持 unknown；nickname/alias 不冒充 SKU。',
    '',
    '## 代表解码证据（本地文件）',
    '',
    ...decodeEvidence.map((entry) => `- [${entry.kind}] ${entry.familyKey} :: ${entry.relPath} — ${entry.width ?? '?'}x${entry.height ?? '?'}${entry.rgbaSha256 ? ` rgbaSha256=${entry.rgbaSha256}` : ''}${entry.reason ? ` reason=${entry.reason}` : ''}`),
    '',
    '## 待补（最短清单，来自当前输入）',
    '',
    ...pendingLines,
    '',
    '## 局限与未知（不猜）',
    '',
    '- 各商品族的未知参数（语言/离线能力/模型名/App/订阅等）保持 unknown，不推断；用户确认事实以已批准的 packs 为准。',
    '- PDF/MP4 仅元数据级处理，不默认播放/完整读过；JPEG 仅头部解析（本任务不逐像素解码）；PNG 按文件持久 pixel_decoded/pixel_unsupported/header_only 状态与原因。',
    '- 无 OCR：素材文字/参数只作候选，须经 Evidence（T1.3）引用后方可使用。',
    '- 不引用历史快照；以本次指纹与记录为准。',
    '- 未做媒体生成/listing 编辑/发布；不授予账号资格或公开上传权限。',
    ...extraNotes
  ].join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const required = ['input', 'mapping', 'source-root', 'imports', 'evidence', 'catalog'];
  for (const key of required) {
    if (typeof args[key] !== 'string' || args[key].trim() === '') throw new Error(`missing --${key}`);
  }
  const sourceRoot = args['source-root'];
  // Guard first: no output may resolve inside the read-only source (checked before any write).
  assertOutputsOutsideSource(sourceRoot, { imports: args.imports, evidence: args.evidence, catalog: args.catalog });

  const input = JSON.parse(fs.readFileSync(args.input, 'utf8'));
  const mappingFile = JSON.parse(fs.readFileSync(args.mapping, 'utf8'));
  const repsPerFamily = args.reps ? Number(args.reps) : 1;
  const { folders, families } = buildFamilies(input);
  const mapping = { folders, pathHints: mappingFile.pathHints ?? [], skuTokens: mappingFile.skuTokens ?? [] };

  const fingerprintBefore = assets.fingerprintDirectory(sourceRoot);
  const records = assets.scanDirectory(sourceRoot);
  const index = assets.buildIndex({ sourceRootId: input.inputId, sourceRoot, records });
  const associated = assets.associate(index, mapping);

  const fingerprintAfter = assets.fingerprintDirectory(sourceRoot);
  const sourceStable = fingerprintBefore.fingerprint === fingerprintAfter.fingerprint;
  if (!sourceStable) {
    throw new Error('source content changed during the scan; refusing to publish manifest/evidence/catalog (application-level guard, not an OS lock; concurrent external changes need a checkpoint)');
  }

  const decodeEvidence = buildDecodeEvidence(associated, families, sourceRoot, repsPerFamily);
  const comparisons = buildComparisons(associated, families);
  const retrievalSamples = {};
  for (const familyKey of Object.keys(families).sort()) {
    retrievalSamples[familyKey] = {
      all: assets.retrieve(associated, { familyKey }).total,
      mainUsage: assets.retrieve(associated, { familyKey, usage: 'main' }).total,
      detailUsage: assets.retrieve(associated, { familyKey, usage: 'detail' }).total
    };
  }

  const manifest = {
    ...associated,
    fingerprintBefore,
    fingerprintAfter,
    sourceStable,
    decodeEvidenceRef: 'runtime/evidence/materials/decode-evidence.json',
    comparisonsRef: 'runtime/evidence/materials/representative-comparisons.json',
    ocrPerformed: false,
    notes: [
      'roles/usages/languages/sku candidates are candidates only; nothing is confirmed here',
      'compliance documents never bind unit compliance (complianceBinding=false)',
      'different content hashes do not imply different designs; design relations need representative comparisons',
      'no OCR: material text/params stay candidate and require Evidence (T1.3) before use',
      'rawIndexHash = canonical hash of the raw scan projection; stableHash = canonical hash of the public projection including association fields'
    ]
  };

  fs.mkdirSync(args.imports, { recursive: true });
  fs.mkdirSync(args.evidence, { recursive: true });
  fs.mkdirSync(path.dirname(args.catalog), { recursive: true });
  assets.writeJsonAtomic(path.join(args.imports, 'manifest.json'), manifest);
  assets.writeJsonAtomic(path.join(args.evidence, 'decode-evidence.json'), {
    schemaVersion: 1,
    kind: 'materials-decode-evidence',
    sourceRootId: input.inputId,
    recordedAt: new Date().toISOString(),
    evidence: decodeEvidence
  });
  assets.writeJsonAtomic(path.join(args.evidence, 'representative-comparisons.json'), {
    schemaVersion: 1,
    kind: 'materials-representative-comparisons',
    sourceRootId: input.inputId,
    recordedAt: new Date().toISOString(),
    note: 'fingerprint-level representatives only; no visual analysis; different hashes do not imply different designs',
    comparisons
  });
  assets.writeJsonAtomic(path.join(args.evidence, 'source-fingerprint.json'), {
    schemaVersion: 1,
    kind: 'materials-source-fingerprint',
    sourceRootId: input.inputId,
    recordedAt: new Date().toISOString(),
    fingerprintBefore,
    fingerprintAfter,
    sourceStable
  });

  const catalog = buildCatalog({ associated: manifest, families, input, decodeEvidence, sourceRoot });
  const catalogTmp = `${args.catalog}.tmp-${Date.now()}`;
  fs.writeFileSync(catalogTmp, `${catalog}\n`, 'utf8');
  fs.renameSync(catalogTmp, args.catalog);

  const report = {
    ok: true,
    sourceRootId: input.inputId,
    fileCount: associated.files.length,
    ignoredCount: associated.ignoredCount,
    statusCounts: associated.statusCounts,
    formats: associated.formats,
    contentObjects: associated.contentObjects.length,
    dedupMultiSource: associated.contentObjects.filter((object) => object.sourceCount > 1).length,
    association: associated.association,
    rawIndexHash: associated.rawIndexHash,
    stableHash: associated.stableHash,
    fingerprintBefore: fingerprintBefore.fingerprint,
    fingerprintAfter: fingerprintAfter.fingerprint,
    sourceStable,
    decodeEvidenceCount: decodeEvidence.length,
    retrievalSamples,
    manifestPath: path.join(args.imports, 'manifest.json'),
    catalogPath: args.catalog
  };
  console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) main();

module.exports = { buildFamilies, buildDecodeEvidence, buildComparisons, buildCatalog, assertOutputsOutsideSource, isInside, nearestExistingAncestor };
