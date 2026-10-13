'use strict';

const STATES = Object.freeze([
  'uploaded', 'extracting', 'awaiting_confirmation', 'confirmed', 'researching',
  'scoring', 'building', 'completed', 'failed'
]);

const TASK_TYPES = new Set(['pdf_catalog', 'track_analysis']);

const TRANSITIONS = {
  uploaded: new Set(['extracting', 'awaiting_confirmation', 'failed']),
  extracting: new Set(['awaiting_confirmation', 'failed']),
  awaiting_confirmation: new Set(['confirmed', 'failed']),
  confirmed: new Set(['researching', 'building', 'failed']),
  researching: new Set(['scoring', 'failed']),
  scoring: new Set(['confirmed', 'building', 'failed']),
  building: new Set(['completed', 'failed']),
  completed: new Set(['confirmed', 'building', 'failed']),
  failed: new Set(['extracting', 'researching', 'building', 'failed'])
};

function normalizeTaskType(value) {
  if (!TASK_TYPES.has(value)) throw Object.assign(new Error('Unsupported report task type.'), { code: 'invalid_task_type' });
  return value;
}

function assertTransition(from, to) {
  if (!STATES.includes(from) || !STATES.includes(to) || !TRANSITIONS[from]?.has(to)) {
    throw Object.assign(new Error(`Invalid report state transition: ${from} -> ${to}.`), { code: 'invalid_state' });
  }
}

function assertRevision(job, revision) {
  const parsed = Number(revision);
  if (!Number.isInteger(parsed) || parsed !== job.revision) {
    throw Object.assign(new Error('The report revision is stale.'), { code: 'revision_conflict' });
  }
}

function text(value, max = 500) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function list(value, maxItems = 30, maxLength = 180) {
  return Array.isArray(value) ? value.map((item) => text(item, maxLength)).filter(Boolean).slice(0, maxItems) : [];
}

function normalizeBrief(value = {}) {
  return {
    category: text(value.category, 160),
    country: text(value.country, 80),
    marketplace: text(value.marketplace, 120),
    audience: text(value.audience, 240),
    priceBand: text(value.priceBand, 120),
    researchQuestions: list(value.researchQuestions, 12),
    marketGroups: Array.isArray(value.marketGroups) ? value.marketGroups.slice(0, 20).map((group, index) => ({
      id: text(group?.id, 60) || `group-${index + 1}`,
      label: text(group?.label, 120),
      keywords: list(group?.keywords, 12, 100)
    })) : []
  };
}

module.exports = { STATES, TASK_TYPES, assertRevision, assertTransition, normalizeBrief, normalizeTaskType, text, list };
