'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, describe, it } = require('node:test');

const { createReportWorkflowService } = require('../lib/report-workflow');

const ownsTestTmp = !process.env.COMMERCE_TEST_TMP;
const testTmpRoot = process.env.COMMERCE_TEST_TMP || fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-report-workflow-'));

after(() => {
  if (ownsTestTmp) fs.rmSync(testTmpRoot, { recursive: true, force: true });
});

describe('static report package workflow', () => {
  const root = fs.mkdtempSync(path.join(testTmpRoot, 'report-workflow-test-'));
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  let buildCount = 0;
  const workflow = createReportWorkflowService({
    root,
    executePipeline: async ({ root: buildRoot }) => {
      buildCount += 1;
      const reports = path.join(buildRoot, 'tmp', 'report-workflow-artifacts');
      fs.mkdirSync(reports, { recursive: true });
      const competitorPath = path.join(reports, `competitor-research_${buildCount}.xlsx`);
      const assessmentPath = path.join(reports, `product-market-assessment_${buildCount}.xlsx`);
      fs.writeFileSync(competitorPath, Buffer.from(`competitor-${buildCount}`));
      fs.writeFileSync(assessmentPath, Buffer.from(`assessment-${buildCount}`));
      return {
        competitor: { outputPath: competitorPath, sheetCount: 2, embeddedImages: 0 },
        assessment: { outputPath: assessmentPath, sheetCount: 3, products: [] },
        markets: [],
        validation: { passed: true }
      };
    }
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  async function waitForCompleted() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const state = workflow.publicState();
      if (state.status === 'completed') return state;
      if (state.status === 'failed') throw new Error(state.error?.message || 'Report build failed.');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('Report build did not finish in time.');
  }

  it('requires a separate reviewer and producer-authenticated repair, then binds approval to the rebuilt version', async () => {
    const started = workflow.start({ actorSessionId: 'producer-session', producerName: 'Producer' });
    assert.equal(started.accepted, true);
    const firstBuild = await waitForCompleted();
    assert.equal(firstBuild.revision, 1);
    assert.equal(firstBuild.buildVersion, 1);
    assert.equal(firstBuild.audit.releaseAllowed, false);

    const returned = workflow.recordAudit({
      action: 'return', reviewer: 'Independent reviewer', reviewerSessionId: 'reviewer-session',
      revision: 1, buildVersion: 1, gates: {}, issues: ['核对来源和图片绑定']
    });
    assert.equal(returned.audit.status, '退回纠错');
    assert.equal(returned.audit.releaseAllowed, false);
    assert.ok(returned.audit.checkedAt);
    assert.throws(
      () => workflow.recordAudit({ action: 'approve', reviewer: 'Producer', reviewerSessionId: 'reviewer-session', revision: 1, buildVersion: 1 }),
      { code: 'audit_returned_requires_rebuild' }
    );

    assert.throws(
      () => workflow.start({ actorSessionId: 'reviewer-session', repairNotes: '伪造修复' }),
      { code: 'repair_producer_required' }
    );
    assert.throws(
      () => workflow.start({ actorSessionId: 'producer-session' }),
      { code: 'repair_notes_required' }
    );

    const rebuilt = workflow.start({ actorSessionId: 'producer-session', repairNotes: '逐项复核链接与图片，补齐证据说明。' });
    assert.equal(rebuilt.accepted, true);
    assert.equal(rebuilt.status.revision, 2);
    assert.equal(rebuilt.status.buildVersion, 2);
    assert.equal(rebuilt.status.audit.releaseAllowed, false);
    assert.equal(rebuilt.status.auditHistory.length, 2);
    assert.equal(rebuilt.status.auditHistory[1].type, 'repair');
    assert.equal(rebuilt.status.auditHistory[1].notes, '逐项复核链接与图片，补齐证据说明。');
    const secondBuild = await waitForCompleted();
    assert.equal(secondBuild.revision, 2);
    assert.equal(secondBuild.buildVersion, 2);
    assert.equal(secondBuild.audit.status, '待独立审核');

    const stale = {
      action: 'approve', reviewer: 'Independent reviewer', reviewerSessionId: 'reviewer-session',
      revision: 1, buildVersion: 1, gates: { facts: true, links: true, comments: true, conclusions: true }, issues: []
    };
    assert.throws(() => workflow.recordAudit(stale), { code: 'audit_version_mismatch' });
    const approved = workflow.recordAudit({
      ...stale, revision: 2, buildVersion: 2,
      gates: { facts: true, links: true, comments: true, conclusions: true }
    });
    assert.equal(approved.audit.releaseAllowed, true);
    assert.equal(approved.audit.status, '独立审核通过');
    assert.equal(approved.audit.revision, 2);
    assert.equal(approved.audit.buildVersion, 2);
    assert.equal(approved.auditHistory.length, 3);
    assert.throws(
      () => workflow.recordAudit({ ...stale, revision: 2, buildVersion: 2 }),
      { code: 'review_already_approved' }
    );
  });
});

describe('public report boundary', () => {
  const root = fs.mkdtempSync(path.join(testTmpRoot, 'report-workflow-boundary-'));
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  const workflow = createReportWorkflowService({ root });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it('fails closed when the private/static report pipeline is not configured', async () => {
    const started = workflow.start({ actorSessionId: 'synthetic-producer' });
    assert.equal(started.accepted, true);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const state = workflow.publicState();
      if (state.status === 'failed') {
        assert.equal(state.error.code, 'pipeline_not_configured');
        assert.equal(fs.existsSync(path.join(root, 'reports')), false);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('Unconfigured report pipeline did not fail closed in time.');
  });
});
