'use strict';

const IN_FLIGHT = new Set(['submitting', 'submission_unknown', 'queued', 'running']);

function runtimeReadiness(result) {
  const reasons = [];
  if (result.state !== 'succeeded') reasons.push(`state_${result.state}`);
  if (result.mode !== 'real') reasons.push('simulated_mode_only');
  if (result.media.status !== 'verified') reasons.push('media_not_verified');
  if (result.qa.status !== 'passed') reasons.push('qa_not_passed');
  if (result.qa.codes.length) reasons.push('qa_findings_unresolved');
  if (result.export.status !== 'ready') reasons.push('export_not_ready');
  if (result.errors.length) reasons.push('runtime_errors_unresolved');
  if (!result.budget.usageKnown) reasons.push('budget_usage_unknown');
  if (result.budget.reservedMinor !== 0) reasons.push('budget_reservation_unsettled');
  return {
    ready: reasons.length === 0,
    reasons,
    // v1 receipts carry declarations, not provider-request provenance or a
    // reviewed reference analysis. Never promote media consumption to E2E proof.
    endToEndVerified: false,
    evidenceScope: 'controlled_media_and_receipt_only',
    newPaidWorkAllowed: result.mode === 'real' && !IN_FLIGHT.has(result.state) && result.state !== 'blocked'
      && !result.errors.length && !result.qa.codes.length && result.budget.usageKnown === true
      && result.budget.reservedMinor === 0 && result.budget.settledMinor < result.budget.capMinor
  };
}

module.exports = { runtimeReadiness };
