import { describe, expect, it } from 'vitest';
import { compilePolicy } from '../../scripts/v32-to-v4/policy/compile.mjs';
import { decisionManifestHash, generateDecisionManifest } from '../../scripts/v32-to-v4/policy/generate.mjs';
import { transformRelational } from '../../scripts/v32-to-v4/transform/relational.mjs';
import { compareSourceToTarget } from '../../scripts/v32-to-v4/validate/compare.mjs';
import { JSON_SHAPES, jsonShapeValid, normalizeJson } from '../../scripts/v32-to-v4/transform/value-map.mjs';
import { parseInstantMicros } from '../../scripts/v32-to-v4/lib/instant.mjs';

// Issue #21: JSON that parses but has the wrong shape (a JSON string where an array belongs) needs the same
// reviewed `map-json` choice as unparseable text, and the validator must hold the target to that choice.
const IMPORTED_AT = parseInstantMicros('2026-10-20T12:00:00.123456Z');

function build({ tags, reviewedValue, extraContext }) {
  const bundle = {
    migration_id: 'rmig_shape_test',
    bundle_manifest_sha256: 'b'.repeat(64),
    tables: {
      entities: [{ id: 1, name: 'Ada', entity_type: 'person', primary_context: 'default', salience: 'active', created_at: '2026-01-02T03:04:05Z', updated_at: '2026-01-02T03:04:06Z' }],
      journals: [{ id: 1, entry_date: '2026-01-03', content: 'a day', tags, emotion: 'calm', journal_type: 'daily', created_at: '2026-01-03T10:00:00Z' }],
      ...(extraContext ? { context_entries: [{ id: 'ctx-1', scope: 'work', content: 'now', links: extraContext, updated_at: '2026-01-02T08:00:00Z' }] } : {}),
    },
  };
  const draft = generateDecisionManifest(bundle, { now: '2026-09-20T00:00:00.000Z' });
  const unexpected = draft.items.filter((item) => item.type !== 'malformed-json').map((item) => item.type);
  expect(unexpected).toEqual([]);
  const manifest = { ...draft, items: draft.items.map((item) => ({ ...item, stated_by: 'owner', choice: { action: 'map-json', value: reviewedValue } })), reviewed: true, reviewed_by: 'test', reviewed_at: '2026-09-20T00:01:00.000Z' };
  manifest.manifest_sha256 = decisionManifestHash(manifest);
  const compiled = compilePolicy({ bundle, decisions: manifest });
  const plan = transformRelational({ bundle, compiledPolicy: compiled });
  return { bundle, manifest, compiled, plan };
}
const compare = ({ bundle, compiled, plan }, decisions, mutate = () => {}) => {
  const targetTables = structuredClone(plan.members);
  mutate(targetTables);
  return compareSourceToTarget({ sourceTables: bundle.tables, targetTables, compiled, decisions, importedAt: IMPORTED_AT, family: 'postgres' });
};
const unreviewed = (manifest) => ({ ...manifest, items: manifest.items.map((item) => ({ ...item, choice: { action: 'exclude-row' } })) });

describe('reviewed JSON of the wrong shape', () => {
  it('a JSON string where an array belongs: the reviewed array is applied and validate accepts it', () => {
    const built = build({ tags: '"a, b, c"', reviewedValue: ['a', 'b', 'c', 'd', 'e'] });
    expect(JSON.parse(built.plan.members.journals[0].tags)).toEqual(['a', 'b', 'c', 'd', 'e']);
    const result = compare(built, built.manifest);
    expect(result.findings.samples).toEqual([]);
    expect(result.sanctioned['json-reviewed-replacement']).toBe(1);
  });

  it('the same cell without a reviewed choice fails as json-unreviewed', () => {
    const built = build({ tags: '"a, b, c"', reviewedValue: ['a'] });
    const result = compare(built, unreviewed(built.manifest));
    expect(JSON.stringify(result.findings.samples)).toContain('json-unreviewed');
    expect(JSON.stringify(result.findings.samples)).not.toContain('a, b, c');
  });

  it('a target that does not hold the reviewed value fails as a json mismatch', () => {
    const built = build({ tags: '"a, b, c"', reviewedValue: ['a', 'b'] });
    const result = compare(built, built.manifest, (t) => { t.journals[0].tags = ['a']; });
    expect(JSON.stringify(result.findings.samples)).toContain('json');
    expect(result.findings.samples.length).toBeGreaterThan(0);
  });

  it('an object where an array belongs, reviewed, passes', () => {
    const built = build({ tags: '{"a":1}', reviewedValue: ['a'] });
    expect(JSON.parse(built.plan.members.journals[0].tags)).toEqual(['a']);
    const result = compare(built, built.manifest);
    expect(result.findings.samples).toEqual([]);
    expect(result.sanctioned['json-reviewed-replacement']).toBe(1);
  });

  it('unparseable text keeps working as before', () => {
    const built = build({ tags: 'a, b, c', reviewedValue: ['a', 'b', 'c'] });
    expect(compare(built, built.manifest).findings.samples).toEqual([]);
    expect(JSON.stringify(compare(built, unreviewed(built.manifest)).findings.samples)).toContain('json-unreviewed');
  });

  it('well-shaped JSON needs no review and counts no replacement', () => {
    const bundle = { migration_id: 'rmig_shape_ok', bundle_manifest_sha256: 'b'.repeat(64), tables: { entities: [{ id: 1, name: 'Ada', entity_type: 'person', primary_context: 'default', salience: 'active', created_at: '2026-01-02T03:04:05Z', updated_at: '2026-01-02T03:04:06Z' }], journals: [{ id: 1, entry_date: '2026-01-03', content: 'x', tags: '["a","b"]', emotion: 'calm', journal_type: 'daily', created_at: '2026-01-03T10:00:00Z' }] } };
    const draft = generateDecisionManifest(bundle, { now: '2026-09-20T00:00:00.000Z' });
    expect(draft.items).toEqual([]);
    const manifest = { ...draft, reviewed: true, reviewed_by: 'test', reviewed_at: '2026-09-20T00:01:00.000Z' };
    manifest.manifest_sha256 = decisionManifestHash(manifest);
    const compiled = compilePolicy({ bundle, decisions: manifest });
    const plan = transformRelational({ bundle, compiledPolicy: compiled });
    const result = compare({ bundle, compiled, plan }, manifest);
    expect(result.findings.samples).toEqual([]);
    expect(result.sanctioned['json-reviewed-replacement']).toBeUndefined();
  });
});

// For every JSON column and a spread of values, the transform and the validator must agree on whether the
// value needs the reviewed choice. Both now call jsonShapeValid, so this fails if either grows its own test again.
const VALUES = ['[]', '[1,2]', '["a"]', '[1,"x"]', '{}', '{"a":1}', '"text"', '"a, b, c"', '42', 'true', 'null', 'a, b', '', '[1.5]', '["7"]', '[[1]]'];

describe('transform and validator agree on which values need a reviewed choice', () => {
  const fields = [...JSON_SHAPES.keys()];
  const table = { links: 'context_entries', connections: 'subconscious', tags: 'journals', source_observation_ids: 'consolidation_groups', data: 'subconscious', sit_notes: 'tensions' };

  it('knows the shape of every JSON field', () => {
    expect(fields.sort()).toEqual(['connections', 'data', 'links', 'sit_notes', 'source_observation_ids', 'tags']);
    expect(Object.keys(table).sort()).toEqual(fields);
  });

  for (const field of Object.keys(table)) {
    const shape = JSON_SHAPES.get(field);
    it.each(VALUES)(`${field} (${shape}) value %j`, (text) => {
      let parsed; try { parsed = JSON.parse(text); } catch { parsed = undefined; }
      const accepted = parsed !== undefined && jsonShapeValid(parsed, shape);
      let replaced = false;
      try { normalizeJson(text, shape, {}); } catch { replaced = true; }
      expect(replaced).toBe(!accepted);
      // and with a reviewed array/object value that fits the shape, the transform takes the reviewed value exactly when the validator would
      const fit = shape === 'object' ? { r: 1 } : shape === 'integer-array' ? [7] : ['r'];
      const taken = normalizeJson(text, shape, { choice: { action: 'map-json', value: fit } });
      expect(taken).toEqual(accepted ? parsed : fit);
    });
  }

  it('two wrong-shape cells in one bundle (journals.tags and context_entries.links) are both held to their reviewed choice', () => {
    const built = build({ tags: '"x"', reviewedValue: ['r'], extraContext: '"text"' });
    const result = compare(built, built.manifest);
    expect(result.findings.samples).toEqual([]);
    expect(result.sanctioned['json-reviewed-replacement']).toBe(2);
  });
});

// consolidation_groups.source_observation_ids is compared as an id list (its own branch), and a reviewed value goes
// through the same observation id remap in the transform as a well-shaped source list does.
describe('reviewed consolidation_groups.source_observation_ids', () => {
  function buildGroups({ ids, reviewedValue, excludeObservation4 = false }) {
    const bundle = {
      migration_id: 'rmig_ids_test',
      bundle_manifest_sha256: 'b'.repeat(64),
      tables: {
        entities: [{ id: 1, name: 'Ada', entity_type: 'person', primary_context: 'default', salience: 'active', created_at: '2026-01-02T03:04:05Z', updated_at: '2026-01-02T03:04:06Z' }],
        observations: [
          { id: 3, entity_id: 1, content: 'three', weight: 'light', context: 'default', added_at: '2026-01-02T04:00:00Z' },
          { id: 4, entity_id: 1, content: 'four', weight: 'light', context: 'default', added_at: excludeObservation4 ? 'not a time' : '2026-01-02T05:00:00Z' },
        ],
        consolidation_groups: [{ id: 1, summary: 'both', entity_id: 1, source_observation_ids: ids, consolidated_observation_id: 3, created_at: '2026-01-02T12:00:00Z' }],
      },
    };
    const draft = generateDecisionManifest(bundle, { now: '2026-09-20T00:00:00.000Z' });
    const choose = (item) => (item.type === 'malformed-json' ? { action: 'map-json', value: reviewedValue } : { action: 'exclude-row' });
    const manifest = { ...draft, items: draft.items.map((item) => ({ ...item, stated_by: 'owner', choice: choose(item) })), reviewed: true, reviewed_by: 'test', reviewed_at: '2026-09-20T00:01:00.000Z' };
    manifest.manifest_sha256 = decisionManifestHash(manifest);
    const compiled = compilePolicy({ bundle, decisions: manifest });
    const plan = transformRelational({ bundle, compiledPolicy: compiled });
    return { bundle, manifest, compiled, plan };
  }
  const idsOf = (built) => built.plan.members.consolidation_groups[0].source_observation_ids;

  it.each([
    ['a JSON string', '"3, 4"', [3, 4]],
    ['an object', '{"a":3}', [3, 4]],
    ['a JSON boolean', 'true', [3, 4]], // a list with a non-integer item is also flagged broken-foreign-key, whose only reviewed choice is exclude-row
    ['unparseable text', '3, 4', [3, 4]],
  ])('%s, reviewed, passes', (_label, ids, reviewedValue) => {
    const built = buildGroups({ ids, reviewedValue });
    expect(idsOf(built)).toEqual([3, 4]);
    const result = compare(built, built.manifest);
    expect(result.findings.samples).toEqual([]);
    expect(result.sanctioned['json-reviewed-replacement']).toBe(1);
  });

  it('the same cells without a reviewed choice fail as json-unreviewed', () => {
    for (const ids of ['"3, 4"', '3, 4', 'true']) {
      const built = buildGroups({ ids, reviewedValue: [3, 4] });
      // only the malformed-json choice is withdrawn; every other reviewed choice stays as it was
      const withdrawn = { ...built.manifest, items: built.manifest.items.map((item) => (item.type === 'malformed-json' ? { ...item, choice: { action: 'keep' } } : item)) };
      const result = compare(built, withdrawn);
      expect(JSON.stringify(result.findings.samples)).toContain('json-unreviewed');
    }
  });

  it('a reviewed list is carried through the observation id map exactly as a well-shaped source list is', () => {
    // Observation 4 is excluded by review. The id map only marks excluded *entities*, so neither a source list nor a reviewed
    // list drops id 4 (the transform keeps it; validate expects the same). What matters here is that the two paths agree.
    const reviewedPath = buildGroups({ ids: '"3, 4"', reviewedValue: [3, 4], excludeObservation4: true });
    const sourcePath = buildGroups({ ids: '[3, 4]', reviewedValue: [3, 4], excludeObservation4: true });
    expect(idsOf(reviewedPath)).toEqual(idsOf(sourcePath));
    expect(compare(reviewedPath, reviewedPath.manifest).findings.samples).toEqual([]);
    expect(compare(sourcePath, sourcePath.manifest).findings.samples).toEqual([]);
  });

  it('a target that does not hold the reviewed list fails as id-list', () => {
    const built = buildGroups({ ids: '"3, 4"', reviewedValue: [3, 4] });
    const wrong = compare(built, built.manifest, (t) => { t.consolidation_groups[0].source_observation_ids = [3]; });
    expect(JSON.stringify(wrong.findings.samples)).toContain('id-list');
  });

  it('a well-shaped list needs no review', () => {
    const built = buildGroups({ ids: '[3, 4]', reviewedValue: [3] });
    expect(built.manifest.items.filter((item) => item.type === 'malformed-json')).toEqual([]);
    const result = compare(built, built.manifest);
    expect(result.findings.samples).toEqual([]);
    expect(result.sanctioned['json-reviewed-replacement']).toBeUndefined();
  });
});
