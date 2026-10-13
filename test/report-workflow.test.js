'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { after, describe, it } = require('node:test');

const { createReportWorkflowService } = require('../lib/report-workflow');

describe('static report package workflow', () => {
  const root = fs.mkdtempSync(path.join(__dirname, '..', 'tmp', 'report-workflow-test-'));
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  let buildCount = 0;
  const workflow = createReportWorkflowService({
    root,
    executePipeline: async ({ root: buildRoot }) => {
      buildCount += 1;
      const reports = path.join(buildRoot, 'reports');
      fs.mkdirSync(reports, { recursive: true });
      const competitorPath = path.join(reports, `Amazon美国站头盔竞品爆款拆解_${buildCount}.xlsx`);
      const yongbaoPath = path.join(reports, `永宝产品美国站进入潜力评估_${buildCount}.xlsx`);
      fs.writeFileSync(competitorPath, Buffer.from(`competitor-${buildCount}`));
      fs.writeFileSync(yongbaoPath, Buffer.from(`yongbao-${buildCount}`));
      return {
        competitor: { outputPath: competitorPath, sheetCount: 2, embeddedImages: 0 },
        yongbao: { outputPath: yongbaoPath, sheetCount: 3 },
        markets: [],
        assessment: { products: [] },
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
