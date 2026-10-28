'use strict';
/**
 * T1.4 — Versioned Category / Market / Brand pack tests.
 * Synthetic fixtures only (generic widget/gadget data); real private pack values live in the
 * private runtime/packs area and never appear here. Temporary files go to $COMMERCE_TEST_TMP.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const W = path.join(__dirname, '..', '..');
const packs = require(path.join(W, 'lib', 'commerce', 'packs.js'));

const TMP_ROOT = process.env.COMMERCE_TEST_TMP;
const skip = TMP_ROOT ? false : 'COMMERCE_TEST_TMP is not set; T1.4 tests write only to the private runtime tmp';

function widgetCategory(overrides = {}) {
  return {
    schemaVersion: 1,
    packId: 'category:widget-a',
    kind: 'category',
    version: '1.0.0',
    title: 'Widget category (synthetic)',
    overridable: { market: ['lexicon', 'attributes'], brand: ['creativeHints'] },
    attributes: [
      { name: 'length', type: 'number', unit: 'mm', allowedValues: null, overridableBy: ['market'] },
      { name: 'label', type: 'string', unit: null, allowedValues: null, overridableBy: ['market'] },
      { name: 'finish', type: 'enum', unit: null, allowedValues: ['matte', 'gloss'], overridableBy: [] }
    ],
    lexicon: { widget: ['gadget'] },
    creativeHints: ['Synthetic base hint'],
    facts: {
      'category.name': {
        value: 'widget',
        unit: null,
        originType: 'user_statement',
        approvalStatus: 'user_confirmed',
        sourceRef: 'synthetic fixture',
        observedAt: '2026-10-09T00:00:00.000Z'
      }
    },
    annotations: ['Synthetic fixture only'],
    ...overrides
  };
}

function marketPack(overrides = {}) {
  return {
    schemaVersion: 1,
    packId: 'market:test-market',
    kind: 'market',
    version: '2.1.0',
    title: 'Test market (synthetic)',
    market: { channel: 'amazon', country: 'US', locale: 'en-US', currency: 'USD' },
    outputRules: {
      mainImage: { backgroundWhite: true, overlayText: false, floatingLogo: false, showOnlyIncludedAccessories: true },
      distinctUsages: ['main', 'scene', 'detail', 'a_plus'],
      aPlus: { conditional: true, eligibilityConfirmed: false, submissionAllowed: false }
    },
    overrides: {
      lexicon: { widget: ['sprocket'] },
      attributes: { label: { allowedValues: ['alpha', 'beta'] } }
    },
    ...overrides
  };
}

function brandPack(overrides = {}) {
  return {
    schemaVersion: 1,
    packId: 'brand:test-brand',
    kind: 'brand',
    version: '0.3.1',
    title: 'Test brand (synthetic)',
    brand: { mode: 'unbranded', brandName: null, logoEnabled: false, logoLayerIndependent: true, autoChangeGenericListing: false },
    overrides: { creativeHints: ['Synthetic brand hint'] },
    ...overrides
  };
}

test('category/market/brand packs compose with version refs, revalidate, and read back from JSON', { skip }, () => {
  const category = widgetCategory();
  const market = marketPack();
  const brand = brandPack();
  packs.validatePack(category);
  packs.validatePack(market);
  packs.validatePack(brand);

  const composed = packs.composePacks(category, [brand, market]); // precedence must not depend on call order
  assert.deepEqual(
    composed.composedFrom.map((ref) => [ref.kind, ref.packId, ref.version]),
    [['category', 'category:widget-a', '1.0.0'], ['market', 'market:test-market', '2.1.0'], ['brand', 'brand:test-brand', '0.3.1']]
  );
  assert.equal(composed.facts['category.name'].value, 'widget');
  assert.equal(composed.facts['category.name'].originType, 'user_statement');
  assert.deepEqual([...composed.lexicon.widget].sort(), ['gadget', 'sprocket']);
  assert.deepEqual(composed.attributes.find((a) => a.name === 'label').allowedValues, ['alpha', 'beta']);
  assert.ok(composed.creativeHints.includes('Synthetic brand hint'));
  assert.equal(composed.market.currency, 'USD');
  assert.equal(composed.brand.logoEnabled, false);
  assert.equal(composed.composedFrom[0].sha256, packs.packRef(category).sha256, 'refs cite the exact pack version hash');

  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'packs-'));
  const file = path.join(dir, 'composed.json');
  fs.writeFileSync(file, JSON.stringify(composed, null, 2));
  const readBack = JSON.parse(fs.readFileSync(file, 'utf8'));
  packs.validateComposed(readBack);
  assert.deepEqual(readBack.composedFrom, composed.composedFrom, 'version refs survive the read-back');

  const categoryB = widgetCategory({ packId: 'category:widget-b', version: '1.2.3' });
  const composedB = packs.composePacks(categoryB, [market, brand]);
  assert.equal(composedB.composedFrom[0].packId, 'category:widget-b');
  assert.deepEqual([...composedB.lexicon.widget].sort(), ['gadget', 'sprocket'], 'the same overlays are reusable with another category');

  const reordered = JSON.parse(JSON.stringify({
    title: category.title, version: category.version, packId: category.packId, kind: category.kind,
    schemaVersion: 1, facts: category.facts, lexicon: category.lexicon, creativeHints: category.creativeHints,
    attributes: category.attributes, overridable: category.overridable, annotations: category.annotations
  }));
  assert.equal(packs.packRef(reordered).sha256, packs.packRef(category).sha256, 'canonical refs ignore key order');
});

test('unknown fields, unknown attributes and unsupported versions are rejected', { skip }, () => {
  assert.throws(() => packs.validatePack(widgetCategory({ extra: true })), /not a known field/);
  assert.throws(() => packs.validatePack(widgetCategory({ schemaVersion: 2 })), /schemaVersion/);
  assert.throws(() => packs.validatePack(widgetCategory({ version: '1.0' })), /MAJOR\.MINOR\.PATCH/);
  assert.throws(() => packs.validatePack(widgetCategory({ kind: 'supplier' })), /kind/);
  assert.throws(
    () => packs.validatePack(widgetCategory({ attributes: [{ name: 'length', type: 'quantity', unit: null, allowedValues: null }] })),
    /type/
  );
  assert.throws(
    () => packs.validatePack(widgetCategory({ attributes: [{ name: 'length', type: 'number', unit: 'mm', allowedValues: ['10'] }] })),
    /allowedValues/
  );
  assert.throws(
    () => packs.validatePack(widgetCategory({ attributes: [{ name: 'label', type: 'string', unit: 'mm', allowedValues: null }] })),
    /unit/
  );
  const unknownAttribute = marketPack({ overrides: { attributes: { color: { allowedValues: ['red'] } } } });
  assert.throws(() => packs.composePacks(widgetCategory(), [unknownAttribute]), /unknown attribute/);
  const protectedSection = marketPack({ overrides: { facts: { 'category.name': { value: 'x' } } } });
  assert.throws(() => packs.validatePack(protectedSection), /not a known field/);
  const unknownMarketField = marketPack({ market: { channel: 'amazon', country: 'US', locale: 'en-US', currency: 'USD', region: 'NA' } });
  assert.throws(() => packs.validatePack(unknownMarketField), /not a known field/);
});

test('type/unit/overlay conflicts are rejected without mutating any pack or fact', { skip }, () => {
  const category = widgetCategory();
  const market = marketPack();
  const before = JSON.stringify([category, market]);

  const numberPatch = marketPack({ overrides: { attributes: { length: { allowedValues: ['10'] } } } });
  assert.throws(() => packs.composePacks(category, [numberPatch]), /cannot take allowedValues/);
  const finishPatch = marketPack({ overrides: { attributes: { finish: { allowedValues: ['satin'] } } } });
  assert.throws(() => packs.composePacks(category, [finishPatch]), /not overridable/);
  const typePatch = marketPack({ overrides: { attributes: { label: { type: 'number' } } } });
  assert.throws(() => packs.validatePack(typePatch), /not a known field/);
  const blankLexicon = marketPack({ overrides: { lexicon: { widget: [] } } });
  assert.throws(() => packs.validatePack(blankLexicon), /must not be empty/);
  const nullVariant = marketPack({ overrides: { lexicon: { widget: [null] } } });
  assert.throws(() => packs.validatePack(nullVariant), /non-empty string/);
  const blankHint = brandPack({ overrides: { creativeHints: [''] } });
  assert.throws(() => packs.validatePack(blankHint), /non-empty/);
  const brandLexicon = brandPack({ overrides: { lexicon: { widget: ['x'] } } });
  assert.throws(() => packs.composePacks(category, [brandLexicon]), /may not override section lexicon/);
  const nullFact = widgetCategory({ facts: { 'category.name': { value: null, unit: null, originType: 'estimate', approvalStatus: 'unreviewed', sourceRef: null, observedAt: null } } });
  assert.throws(() => packs.validatePack(nullFact), /value/);

  assert.equal(JSON.stringify([category, market]), before, 'failed validations/compositions must not mutate inputs');
});

test('reserved keys are rejected without prototype pollution; brand/market boundaries hold', { skip }, () => {
  const polluted = JSON.parse('{"schemaVersion":1,"packId":"category:evil","kind":"category","version":"1.0.0","title":"evil","attributes":[],"lexicon":{},"creativeHints":[],"facts":{},"__proto__":{"polluted":true}}');
  assert.throws(() => packs.validatePack(polluted), /reserved key/);
  assert.equal(Object.prototype.polluted, undefined, 'no prototype pollution from a rejected pack');
  const nested = JSON.parse('{"schemaVersion":1,"packId":"market:evil","kind":"market","version":"1.0.0","title":"evil","market":{"channel":"amazon","country":"US","locale":"en-US","currency":"USD","__proto__":{"polluted":true}}}');
  assert.throws(() => packs.validatePack(nested), /reserved key/);
  assert.equal({}.polluted, undefined, 'no pollution from nested reserved keys');

  assert.throws(() => packs.validatePack(brandPack({ brand: { ...brandPack().brand, logoEnabled: true } })), /logoEnabled/);
  assert.throws(() => packs.validatePack(brandPack({ brand: { ...brandPack().brand, autoChangeGenericListing: true } })), /autoChangeGenericListing/);
  assert.throws(
    () => packs.validatePack(brandPack({ brand: { mode: 'branded', brandName: null, logoEnabled: false, logoLayerIndependent: true, autoChangeGenericListing: false } })),
    /brandName/
  );
  assert.throws(
    () => packs.validatePack(marketPack({ outputRules: { ...marketPack().outputRules, aPlus: { conditional: true, eligibilityConfirmed: false, submissionAllowed: true } } })),
    /submission/
  );

  const composed = packs.composePacks(widgetCategory(), [marketPack(), brandPack()]);
  assert.equal(composed.facts['category.name'].originType, 'user_statement', 'facts keep their provenance through composition');
  const length = composed.attributes.find((a) => a.name === 'length');
  assert.equal(length.type, 'number', 'attribute identity (type) is not overridable');
  assert.equal(length.unit, 'mm', 'attribute identity (unit) is not overridable');
});

test('category core sections and enum/attribute rules are enforced', { skip }, () => {
  const missingLexicon = widgetCategory();
  delete missingLexicon.lexicon;
  assert.throws(() => packs.validatePack(missingLexicon), /lexicon/);
  const enumWithoutValues = widgetCategory({ attributes: [{ name: 'finish', type: 'enum', unit: null, allowedValues: null }] });
  assert.throws(() => packs.validatePack(enumWithoutValues), /allowedValues is required/);
  const duplicateAttribute = widgetCategory({
    attributes: [
      { name: 'same', type: 'string', unit: null, allowedValues: null },
      { name: 'same', type: 'string', unit: null, allowedValues: null }
    ]
  });
  assert.throws(() => packs.validatePack(duplicateAttribute), /duplicate/);
  const protectedList = widgetCategory({ overridable: { market: ['facts'] } });
  assert.throws(() => packs.validatePack(protectedList), /protected section facts/);
  assert.throws(() => packs.composePacks(widgetCategory(), [marketPack(), marketPack({ packId: 'market:test-market-2' })]), /only one market/);
});

test('brand logoEnabled must be a real boolean in both modes (legal true/false preserved)', { skip }, () => {
  assert.throws(() => packs.validatePack(brandPack({ brand: { ...brandPack().brand, logoEnabled: 'false' } })), /logoEnabled must be a boolean/, 'a string "false" must not pass for unbranded');
  assert.throws(() => packs.validatePack(brandPack({ brand: { ...brandPack().brand, logoEnabled: 0 } })), /logoEnabled must be a boolean/);
  assert.throws(() => packs.validatePack(brandPack({ brand: { ...brandPack().brand, logoEnabled: true } })), /must stay false for unbranded/);
  const branded = (logoEnabled) => ({ mode: 'branded', brandName: 'Synthetic Brand', logoEnabled, logoLayerIndependent: true, autoChangeGenericListing: false });
  assert.throws(() => packs.validatePack(brandPack({ brand: branded('false') })), /logoEnabled must be a boolean/, 'the branded branch must not accept strings');
  assert.throws(() => packs.validatePack(brandPack({ brand: branded(null) })), /logoEnabled must be a boolean/);
  assert.throws(() => packs.validatePack(brandPack({ brand: { ...branded(true), logoEnabled: undefined } })), /logoEnabled must be a boolean/);
  packs.validatePack(brandPack({ brand: branded(true) }));
  packs.validatePack(brandPack({ brand: branded(false) }));
  assert.equal(packs.composePacks(widgetCategory(), [brandPack({ brand: branded(true) })]).brand.logoEnabled, true, 'legal branded true survives composition');
  assert.equal(packs.composePacks(widgetCategory(), [brandPack({ brand: branded(false) })]).brand.logoEnabled, false);
});

test('lexicon overlays read own keys safely (toString/valueOf stay legal, no prototype reads, no pollution)', { skip }, () => {
  const base = widgetCategory({ lexicon: {} });
  const overlay = marketPack({ overrides: { lexicon: { toString: ['text-form'], valueOf: ['value-form'] } } });
  const composed = packs.composePacks(base, [overlay]);
  assert.ok(Array.isArray(composed.lexicon.toString), 'own array value, not an inherited function');
  assert.deepEqual(composed.lexicon.toString, ['text-form']);
  assert.deepEqual(composed.lexicon.valueOf, ['value-form']);
  const merged = widgetCategory({ lexicon: { toString: ['base-form'] } });
  const composedMerged = packs.composePacks(merged, [overlay]);
  assert.deepEqual(composedMerged.lexicon.toString, ['base-form', 'text-form']);
  assert.equal(typeof ({}).toString, 'function', 'Object.prototype untouched');
  assert.equal(Object.prototype['text-form'], undefined, 'no prototype pollution from the overlay');
  const readBack = JSON.parse(JSON.stringify(composedMerged));
  packs.validateComposed(readBack);
  assert.deepEqual(readBack.lexicon.toString, ['base-form', 'text-form'], 'own keys survive the read-back');
});

test('number facts require a unit; string/boolean facts may omit it', { skip }, () => {
  const withFact = (fact) => widgetCategory({ facts: { 'measure.value': fact } });
  const base = { unit: null, originType: 'estimate', approvalStatus: 'unreviewed', sourceRef: null, observedAt: '2026-10-09' };
  assert.throws(() => packs.validatePack(withFact({ ...base, value: 12.5 })), /unit is required for number facts/, 'a valid date must not hide the missing unit');
  assert.throws(() => packs.validatePack(withFact({ ...base, value: 12.5, unit: '   ' })), /unit must be a non-empty string/);
  packs.validatePack(withFact({ ...base, value: 12.5, unit: 'kg' }));
  packs.validatePack(withFact({ ...base, value: '03' }));
  packs.validatePack(withFact({ ...base, value: '12.5' }));
  packs.validatePack(withFact({ ...base, value: true }));
  packs.validatePack(withFact({ ...base, value: 12.5, unit: 'kg', observedAt: null }));
});

test('observedAt requires a real-calendar ISO date or a timezone-explicit timestamp', { skip }, () => {
  const withObservedAt = (observedAt) => widgetCategory({ facts: { 'measure.value': { value: 12.5, unit: 'kg', originType: 'estimate', approvalStatus: 'unreviewed', sourceRef: null, observedAt } } });
  for (const bad of ['2026-02-30', '2026-02-29', '2026-13-01', '2026-00-10', '2026-10-08T00:00:00', '2026-10-08T25:00:00Z', '2026-10-08T00:60:00Z', '2026-10-08 00:00:00Z', 'not-a-date', '0026-10-08']) {
    assert.throws(() => packs.validatePack(withObservedAt(bad)), /observedAt/, `observedAt ${bad} must be rejected (valid unit present)`);
  }
  assert.equal(packs.validatePack(withObservedAt('2026-10-09')).facts['measure.value'].observedAt, '2026-10-09', 'date-only precision is kept verbatim');
  packs.validatePack(withObservedAt('2026-09-29T20:08:00+08:00'));
  packs.validatePack(withObservedAt('2026-10-09T00:00:00.000Z'));
  packs.validatePack(withObservedAt('2024-02-29'));
  packs.validatePack(withObservedAt(null));
});
