#!/usr/bin/env node
'use strict';
/**
 * T1.7 — fixture material import CLI (local synthetic files only; NO real outbound calls).
 *
 * Runs the imports pipeline over a JSON job and writes the task outputs:
 *   <outDir>/import-report.json, <outDir>/samples/localization-samples.json,
 *   <dbPath> (+ <outDir>/fixture/imports-fixture.backup.db when outDir is set)
 *
 * Job shape:
 * {
 *   "runId": "...", "projectId": "...", "dbPath": "...",
 *   "materials": [
 *     { "kind": "pdf_text"|"table"|"scan"|"manual", "filePath": "...", "supplierKey": "...",
 *       "parserVersion"?: "...", "fieldKey"?, "rawValue"?, "unit"?, "currency"?, "incoterm"?,
 *       "subjectKey"?, "confirm"?, "observedAt"? }
 *   ],
 *   "replayFirst": true, "outDir": "..."
 * }
 */
const fs = require('node:fs');
const path = require('node:path');
const W = path.join(__dirname, '..', '..');
const { openDb, migrateUp, backupTo, verifyDatabaseFile } = require(path.join(W, 'lib', 'commerce', 'db.js'));
const core = require(path.join(W, 'lib', 'commerce', 'migrations', '0001_core.js'));
const m3 = require(path.join(W, 'lib', 'commerce', 'migrations', '0003_evidence_observation.js'));
const m11 = require(path.join(W, 'lib', 'commerce', 'migrations', '0011_imports.js'));
const imports = require(path.join(W, 'lib', 'commerce', 'imports.js'));

/** Deterministic synthetic OCR fixture transport (protocol validation only, never a real call). */
function fixtureOcrTransport() {
  let call = 0;
  return async () => {
    call += 1;
    const lines = call % 2 === 1
      ? [{ text: 'H0 出厂价 40元/套 FOB 深圳', x: 0, y: 0, w: 1, h: 1 }, { text: '数量：100件' }]
      : [{ text: 'HO 出厂价 ¥45 FOB 深圳' }];
    return {
      kind: 'response',
      httpStatus: 200,
      body: { id: `cli-fixture-remote-${call}`, choices: [{ message: { content: JSON.stringify({ lines }) } }], usage: { prompt_tokens: 2500, completion_tokens: 50 } }
    };
  };
}

async function runMaterial(db, projectId, material) {
  if (material.kind === 'pdf_text') return imports.importPdfText(db, projectId, material);
  if (material.kind === 'table') return imports.importTable(db, projectId, material);
  if (material.kind === 'scan') return imports.importScan(db, projectId, { ...material, fixtureTransport: fixtureOcrTransport() });
  if (material.kind === 'manual') {
    const added = imports.addManualCandidate(db, projectId, material);
    if (material.confirm) {
      const confirmed = imports.confirmCandidate(db, projectId, { candidateId: added.candidate.candidate_id, observedAt: material.observedAt });
      return { ...added, confirmedObservation: confirmed.observation.id };
    }
    return added;
  }
  throw new Error(`unknown material kind: ${material.kind}`);
}

async function main() {
  const jobPath = process.argv[2];
  if (!jobPath) throw new Error('usage: node scripts/commerce/import-materials.js <job.json>');
  const job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
  const outDir = job.outDir ? path.resolve(job.outDir) : null;
  const dbPath = path.resolve(job.dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(`${dbPath}${suffix}`)) fs.rmSync(`${dbPath}${suffix}`);
  const db = openDb(dbPath);
  migrateUp(db, [core, m3, m11]);
  const results = [];
  for (const material of job.materials) {
    const result = await runMaterial(db, job.projectId, material);
    results.push({ supplierKey: material.supplierKey, kind: material.kind, status: result.status, counts: result.counts ?? null });
  }
  let idempotency = null;
  if (job.replayFirst && job.materials.length > 0) {
    const before = imports.listCandidates(db, job.projectId).length;
    const replay = await runMaterial(db, job.projectId, job.materials[0]);
    const after = imports.listCandidates(db, job.projectId).length;
    idempotency = { replayStatus: replay.status, countsStable: before === after, candidatesBefore: before, candidatesAfter: after };
  }
  const report = imports.buildReport(db, job.projectId, { taskId: 'T1.7', runId: job.runId, idempotency });
  let backup = null;
  if (outDir) {
    fs.mkdirSync(path.join(outDir, 'samples'), { recursive: true });
    fs.mkdirSync(path.join(outDir, 'fixture'), { recursive: true });
    fs.writeFileSync(path.join(outDir, 'import-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(outDir, 'samples', 'localization-samples.json'), `${JSON.stringify({
      schemaVersion: 1, taskId: 'T1.7', runId: job.runId, generatedAt: report.generatedAt,
      candidates: report.samples, scanPages: report.scanPages, corrections: report.corrections
    }, null, 2)}\n`, 'utf8');
    backup = path.join(outDir, 'fixture', 'imports-fixture.backup.db');
    if (fs.existsSync(backup)) fs.rmSync(backup);
    backupTo(db, backup);
  }
  db.close();
  const summary = {
    runId: job.runId,
    dbPath,
    documents: report.counts.documents,
    candidates: report.counts.candidates,
    confirmed: report.counts.confirmed,
    scanPages: report.scanPages.length,
    idempotency,
    backup,
    backupVerified: backup ? verifyDatabaseFile(backup, { expectedTables: ['import_documents', 'import_candidates', 'import_scan_pages', 'import_corrections'] }).ok : null,
    results
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
