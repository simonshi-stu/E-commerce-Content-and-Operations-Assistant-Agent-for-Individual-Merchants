'use strict';

const { normalizeSourceType } = require('./credibility');
const { uiMessage } = require('./messages');

const HEADER_ALIASES = {
  observedAt: ['date', 'observedat', 'observed_at', '日期', '采集日期'],
  platform: ['platform', '平台'],
  label: ['label', 'name', 'title', '标签', '名称'],
  price: ['price', '价格', '售价'],
  type: ['type', '类型'],
  sourceType: ['source', 'sourcetype', 'source_type', '来源', '数据来源'],
  sourceNote: ['note', 'sourcenote', 'source_note', '备注', '来源备注']
};

const SOURCE_ALIASES = {
  official_store: ['官方店铺', '官方商品页', '官方', 'official'],
  merchant_record: ['我的实测', '我的记录', '实测', '采购记录', '订单记录', 'mine', 'record'],
  platform_search: ['平台搜索', '平台榜单', '搜索', '榜单'],
  third_party_tool: ['第三方工具', '第三方', '工具'],
  screenshot_note: ['截图', '人工记录', '截图记录', '笔记'],
  unknown: ['未注明', '未知', '无', 'not stated', 'unknown']
};

function splitCsvLine(line) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        current += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ',' || character === '\t' || character === '，') {
      cells.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

function normalizeDate(value) {
  const text = String(value || '').trim().replace(/[/.]/g, '-');
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(text)) {
    const [year, month, day] = text.split('-');
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }
  return '';
}

function normalizeSourceAlias(value) {
  const text = String(value || '').trim().toLowerCase();
  for (const [sourceType, aliases] of Object.entries(SOURCE_ALIASES)) {
    if (aliases.includes(text)) return sourceType;
  }
  return normalizeSourceType(text);
}

function normalizeType(value) {
  const text = String(value || '').trim().toLowerCase();
  return text === 'own' || text === '我的' || text === '我的价格' ? 'own' : 'competitor';
}

function headerMap(cells) {
  const map = {};
  cells.forEach((cell, index) => {
    const normalized = cell.toLowerCase();
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (map[field] === undefined && aliases.includes(normalized)) map[field] = index;
    }
  });
  return map;
}

function hasHeaderRow(cells) {
  const aliases = Object.values(HEADER_ALIASES).flat();
  return cells.some((cell) => aliases.includes(cell.toLowerCase()));
}

function parsePriceCsv(text, locale = 'zh') {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return { error: uiMessage(locale, 'intel.import.empty') };

  const firstCells = splitCsvLine(lines[0]);
  const useHeader = hasHeaderRow(firstCells);
  const map = useHeader ? headerMap(firstCells) : null;
  const rows = [];
  const start = useHeader ? 1 : 0;

  for (let index = start; index < lines.length; index += 1) {
    const cells = splitCsvLine(lines[index]);
    const pick = (field, position) => {
      if (map) return map[field] !== undefined ? (cells[map[field]] || '').trim() : '';
      return (cells[position] || '').trim();
    };
    const row = {
      observedAt: normalizeDate(map ? pick('observedAt') : cells[0]),
      platform: pick('platform', 1),
      label: pick('label', 2),
      price: Number.parseFloat(pick('price', 3)),
      type: normalizeType(pick('type', 4)),
      sourceType: normalizeSourceAlias(pick('sourceType', 5)),
      sourceNote: pick('sourceNote', 6)
    };
    if (!Number.isFinite(row.price) || row.price <= 0) continue;
    rows.push(row);
    if (rows.length >= 30) break;
  }

  if (rows.length === 0) return { error: uiMessage(locale, 'intel.import.noRows') };
  return { result: { rows, skipped: Math.max(0, lines.length - start - rows.length) } };
}

module.exports = { parsePriceCsv, splitCsvLine };
