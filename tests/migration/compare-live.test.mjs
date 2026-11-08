import { describe, expect, it } from 'vitest';
import { compilePolicy } from '../../scripts/v32-to-v4/policy/compile.mjs';
import { decisionManifestHash, generateDecisionManifest } from '../../scripts/v32-to-v4/policy/generate.mjs';
import { transformRelational } from '../../scripts/v32-to-v4/transform/relational.mjs';
import { comparePlanToTarget, compareSourceToTarget } from '../../scripts/v32-to-v4/validate/compare.mjs';
import { formatInstantMicros, parseInstantMicros } from '../../scripts/v32-to-v4/lib/instant.mjs';
import { canonicalSha256 } from '../../scripts/v32-to-v4/lib/hash.mjs';

// The column-by-column comparison, without a database: the target rows are made from the plan the way a
// database would hold them (timestamps as RFC 3339 text), then damaged one way at a time. The comparison
// must find each kind of damage by itself, from the source rows, whether or not the plan is also wrong.
const IMPORTED_AT = parseInstantMicros('2026-10-20T12:00:00.123456Z');

const bundle = {
  migration_id: 'rmig_compare_test',
  bundle_manifest_sha256: 'b'.repeat(64),
  tables: {
    entities: [
      { id: 1, name: 'Ada', entity_type: 'person', primary_context: 'default', salience: 'active', created_at: '2026-01-02T03:04:05.123456Z', updated_at: '2026-01-02T03:04:06Z' },
      { id: 2, name: 'Grove', entity_type: 'concept', primary_context: 'default', salience: null, created_at: '2026-02-01T11:00:00.000001Z', updated_at: null },
    ],
    observations: [
      { id: 3, entity_id: 1, content: 'line one\nline two ☃', weight: 'low', source_date: '2026-01-02', context: 'default', novelty_score: 0.3333333, added_at: '2026-01-02T04:00:00.987654Z', last_surfaced_at: '2026-03-01T00:00:00.000001+00:00', superseded_by: 4, linked_observation_id: null },
      { id: 4, entity_id: 2, content: 'second', weight: 'medium', added_at: '2026-01-05T08:30:00-05:00', last_accessed_at: '2026-01-06 00:00:00' },
    ],
    observation_versions: [
      { id: 10, observation_id: 3, content: 'later', changed_at: '2026-01-02T05:00:00.123456Z' },
      { id: 9, observation_id: 3, content: 'earlier', changed_at: '2026-01-02T05:00:00.123Z' },
    ],
    relations: [{ id: 1, from_entity: 'Ada', to_entity: 'Grove', relation_type: 'tends', created_at: '2026-01-02T06:00:00Z' }],
    context_entries: [{ id: 'ctx-1', scope: 'work', content: 'now', links: '["thr-1", "thr-2"]', updated_at: '2026-01-02T08:00:00Z' }],
    consolidation_groups: [{ id: 1, summary: 'both', entity_id: 1, source_observation_ids: '[3, 4]', consolidated_observation_id: 3, created_at: '2026-01-02T12:00:00Z' }],
    tensions: [{ id: 'ten-1', pole_a: 'a', pole_b: 'b', context: 'default', sit_count: 2, sit_notes: '[]', status: 'active', created_at: '2026-01-02T16:00:00Z' }],
  },
};

function reviewed() {
  const draft = generateDecisionManifest(bundle, { now: '2026-09-20T00:00:00.000Z' });
  const choices = { 'tension-state': { action: 'preserve-visits-and-open', last_visited: '2026-01-04T00:00:00.000Z' } };
  const unexpected = draft.items.filter((item) => choices[item.type] === undefined).map((item) => item.type);
  expect(unexpected).toEqual([]);
  const manifest = { ...draft, items: draft.items.map((item) => ({ ...item, stated_by: 'owner', choice: choices[item.type] })), reviewed: true, reviewed_by: 'test', reviewed_at: '2026-09-20T00:01:00.000Z' };
  manifest.manifest_sha256 = decisionManifestHash(manifest);
  return manifest;
}

const decisions = reviewed();
const compiled = compilePolicy({ bundle, decisions });
const plan = transformRelational({ bundle, compiledPolicy: compiled });

/** What a database holds for the plan: a copy, with the v4 trigger's defaults where the plan has a NULL. */
function targetFromPlan(source = plan) {
  const tables = structuredClone(source.members);
  for (const table of ['people', 'nodes']) for (const row of tables[table] ?? []) {
    if (row.created_at === null) row.created_at = formatInstantMicros(IMPORTED_AT);
    if (row.updated_at === null) row.updated_at = formatInstantMicros(IMPORTED_AT);
    if (row.salience === null) row.salience = 'active';
    if (row.primary_context === null) row.primary_context = 'default';
  }
  return tables;
}

const compare = (targetTables, { planOverride = plan, sourceTables = bundle.tables } = {}) => compareSourceToTarget({ sourceTables, targetTables, compiled, decisions, importedAt: IMPORTED_AT, family: 'postgres' });
const checksOf = (result) => Object.keys(result.findings.counts).sort();
const find = (result, check) => result.findings.samples.filter((finding) => finding.check === check);

describe('source rows against target rows, column by column', () => {
  it('finds nothing wrong in a faithful target, and says what it accepted and why', () => {
    const result = compare(targetFromPlan());
    expect(result.findings.samples).toEqual([]);
    expect(result.cells_compared).toBeGreaterThan(60);
    expect(result.sanctioned).toMatchObject({
      'null-replaced-by-v4-default': 2, // Grove has no updated_at and no salience
      'enum-alias': 1, // weight 'low' becomes 'light'
      'timestamp-reformatted-same-instant': expect.any(Number), // an offset or a missing fraction written differently
      'json-reformatted-same-value': expect.any(Number),
    });
    expect(result.tables.observations).toMatchObject({ source_rows: 2, compared_rows: 2, excluded_by_review: 0 });
    const planned = comparePlanToTarget({ plan, targetTables: targetFromPlan(), importedAt: IMPORTED_AT });
    expect(planned.findings.samples).toEqual([]);
    expect(planned.cells_compared).toBeGreaterThan(60);
  });

  it.each([
    ['text', (t) => { t.observations[0].content += '.'; }, 'cell-mismatch', 'content'],
    ['a trailing newline', (t) => { t.observations[0].content += '\n'; }, 'cell-mismatch', 'content'],
    ['a timestamp rounded to the millisecond', (t) => { t.observations[0].added_at = '2026-01-02T04:00:00.987Z'; }, 'cell-mismatch', 'added_at'],
    ['a timestamp one microsecond off', (t) => { t.observations[0].last_surfaced_at = '2026-03-01T00:00:00.000002Z'; }, 'cell-mismatch', 'last_surfaced_at'],
    ['an offset applied the wrong way', (t) => { t.observations[1].added_at = '2026-01-05T03:30:00Z'; }, 'cell-mismatch', 'added_at'],
    ['a naive source value read as the wrong zone (reviewed UTC, stored shifted)', (t) => { t.observations[1].last_accessed_at = '2026-01-06T01:00:00Z'; }, 'cell-mismatch', 'last_accessed_at'],
    ['a number changed in the last digit', (t) => { t.observations[0].novelty_score = 0.3333334; }, 'cell-mismatch', 'novelty_score'],
    ['an enum alias applied wrongly', (t) => { t.observations[0].weight = 'heavy'; }, 'cell-mismatch', 'weight'],
    ['a reference pointing at another row', (t) => { t.observations[0].superseded_by = 3; }, 'cell-mismatch', 'superseded_by'],
    ['a reference dropped', (t) => { t.observations[0].superseded_by = null; }, 'cell-mismatch', 'superseded_by'],
    ['routing to the wrong subject', (t) => { t.observations[0].person_id = null; t.observations[0].node_id = 2; }, 'cell-mismatch', 'person_id'],
    ['a relation endpoint renamed', (t) => { t.relations[0].to_entity = 'Other'; }, 'cell-mismatch', 'to_entity'],
    ['an id list changed', (t) => { t.consolidation_groups[0].source_observation_ids = [3]; }, 'cell-mismatch', 'source_observation_ids'],
    ['json that is not the same value', (t) => { t.context_entries[0].links = '["thr-2"]'; }, 'cell-mismatch', 'links'],
    ['a version numbered out of time order', (t) => { for (const row of t.observation_versions) row.version_num = 3 - row.version_num; }, 'cell-mismatch', 'version_num'],
    ['an entity kind changed', (t) => { t.people[0].kind = 'peer_ai'; }, 'cell-mismatch', 'kind'],
    ['an entity moved to the other table', (t) => { t.nodes.push({ ...t.people[0] }); t.people.length = 0; }, 'source-row-missing-in-target', undefined],
    ['a tension reopened differently from the review', (t) => { t.tensions[0].last_visited = '2026-01-09T00:00:00Z'; }, 'cell-mismatch', 'last_visited'],
    ['a default that is not the import time', (t) => { t.nodes[0].updated_at = '2026-10-20T12:00:00.123457Z'; }, 'cell-mismatch', 'updated_at'],
    ['a row missing', (t) => { t.observations.pop(); }, 'source-row-missing-in-target', undefined],
    ['a row that no source row explains', (t) => { t.relations.push({ id: 99, from_entity: 'Ada', to_entity: 'Grove', relation_type: 'x', created_at: '2026-01-01T00:00:00Z' }); }, 'target-row-without-source', undefined],
  ])('finds %s', (_label, damage, check, column) => {
    const target = targetFromPlan();
    damage(target);
    const result = compare(target);
    expect(checksOf(result)).toContain(check);
    if (column !== undefined) expect(find(result, check).map((finding) => finding.column)).toContain(column);
    // a finding carries a table, a column and an id, never the value
    expect(JSON.stringify(result.findings.samples)).not.toMatch(/line one|☃|Ada|Grove/u);
  });

  it('finds a transform that is wrong even when the target faithfully holds the wrong plan', () => {
    const wrong = structuredClone(plan);
    wrong.members.observations[0].added_at = '2026-01-02T04:00:00.987Z'; // what a millisecond-only transform would write
    const result = compare(targetFromPlan(wrong));
    expect(find(result, 'cell-mismatch').map((finding) => finding.column)).toContain('added_at');
    expect(comparePlanToTarget({ plan: wrong, targetTables: targetFromPlan(wrong), importedAt: IMPORTED_AT }).findings.samples).toEqual([]);
  });

  it('does not accept a default for a NULL unless the loss report records it, or a different default than the one v4 writes', () => {
    const target = targetFromPlan();
    target.nodes[0].salience = 'heavy';
    expect(checksOf(compare(target))).toContain('cell-mismatch');
    const unrecorded = { ...compiled, losses: compiled.losses.filter((loss) => loss.kind !== 'null-replaced-by-v4-default') };
    const result = compareSourceToTarget({ sourceTables: bundle.tables, targetTables: targetFromPlan(), compiled: unrecorded, decisions, importedAt: IMPORTED_AT, family: 'postgres' });
    expect(checksOf(result)).toContain('cell-mismatch');
    const noReceipt = compareSourceToTarget({ sourceTables: bundle.tables, targetTables: targetFromPlan(), compiled, decisions, importedAt: null, family: 'postgres' });
    expect(checksOf(noReceipt)).toEqual(expect.arrayContaining(['cell-mismatch', 'recorded-default-not-observed']));
  });
});

describe('the plan against the target', () => {
  const planned = (damage) => { const target = targetFromPlan(); damage(target); return comparePlanToTarget({ plan, targetTables: target, importedAt: IMPORTED_AT }); };

  it.each([
    ['a changed cell', (t) => { t.relations[0].relation_type = 'other'; }, 'plan-cell-mismatch'],
    ['a column the plan states and the database lacks', (t) => { delete t.relations[0].relation_type; }, 'plan-cell-mismatch'],
    ['a missing row', (t) => { t.relations.length = 0; }, 'plan-row-missing-in-target'],
    ['an extra row', (t) => { t.journals = [{ id: 1, content: 'stray' }]; }, 'target-row-not-in-plan'],
    ['a duplicated row', (t) => { t.relations.push({ ...t.relations[0] }); }, 'duplicate-target-id'],
  ])('finds %s', (_label, damage, check) => {
    expect(Object.keys(planned(damage).findings.counts)).toContain(check);
  });
});

describe('a reviewed merge of duplicate entities', () => {
  const mergeBundle = {
    migration_id: 'rmig_compare_merge',
    bundle_manifest_sha256: 'c'.repeat(64),
    tables: {
      entities: [
        { id: 1, name: 'Ada', entity_type: 'person', primary_context: 'default', salience: 'active', created_at: '2026-01-01T00:00:00Z', updated_at: null },
        { id: 2, name: 'Ada', entity_type: 'person', primary_context: 'work', salience: 'active', created_at: '2026-01-05T00:00:00Z', updated_at: '2026-01-06T00:00:00Z' },
      ],
      observations: [
        { id: 5, entity_id: 1, content: 'kept', added_at: '2026-01-07T00:00:00Z' },
        { id: 6, entity_id: 2, content: 'from the merged duplicate', added_at: '2026-01-08T00:00:00Z' },
      ],
    },
  };
  const mergeDraft = generateDecisionManifest(mergeBundle, { now: '2026-09-20T00:00:00.000Z' });
  const choice = { action: 'merge', survivor_id: 1, merged_ids: [1, 2], field_rules: { name: { source_id: 1 }, entity_type: { source_id: 1 }, primary_context: { source_id: 1 }, salience: { source_id: 1 }, created_at: { source_id: 1 }, updated_at: { source_id: 2 } } };
  const mergeDecisions = { ...mergeDraft, items: mergeDraft.items.map((item) => ({ ...item, stated_by: 'owner', choice })), reviewed: true, reviewed_by: 'test', reviewed_at: '2026-09-20T00:01:00.000Z' };
  mergeDecisions.manifest_sha256 = decisionManifestHash(mergeDecisions);
  const mergeCompiled = compilePolicy({ bundle: mergeBundle, decisions: mergeDecisions });
  const mergePlan = transformRelational({ bundle: mergeBundle, compiledPolicy: mergeCompiled });
  const run = (target) => compareSourceToTarget({ sourceTables: mergeBundle.tables, targetTables: target, compiled: mergeCompiled, decisions: mergeDecisions, importedAt: IMPORTED_AT, family: 'postgres' });

  it('accepts one survivor with the reviewed field rules and the remapped reference, and counts them', () => {
    expect(mergeDraft.items.map((item) => item.type)).toEqual(['duplicate-entity-name']);
    const result = run(structuredClone(mergePlan.members));
    expect(result.findings.samples).toEqual([]);
    expect(result.tables.entities).toMatchObject({ source_rows: 2, compared_rows: 1, merged_by_review: 1 });
    expect(result.sanctioned).toMatchObject({ 'reference-remapped': 1 });
    // the survivor's own NULL updated_at is replaced by the reviewed rule (the merged row's value), so v4 fills in nothing
    expect(mergeCompiled.losses.filter((loss) => loss.kind === 'null-replaced-by-v4-default')).toEqual([]);
    expect(result.sanctioned['null-replaced-by-v4-default']).toBeUndefined();
    expect(mergePlan.members.people).toEqual([expect.objectContaining({ id: 1, updated_at: '2026-01-06T00:00:00.000Z' })]);
  });

  it('refuses a survivor that took the wrong source row\'s field, and a duplicate that was left behind', () => {
    const wrongField = structuredClone(mergePlan.members);
    wrongField.people[0].updated_at = '2026-01-03T00:00:00Z';
    expect(find(run(wrongField), 'cell-mismatch').map((finding) => finding.column)).toContain('updated_at');
    const leftBehind = structuredClone(mergePlan.members);
    leftBehind.people.push({ ...leftBehind.people[0], id: 2, name: 'Ada two' });
    expect(checksOf(run(leftBehind))).toContain('target-row-without-source');
  });
});

describe('findings are plain data', () => {
  it('leave out a detail that is undefined, so a report can always be written', async () => {
    const { Findings } = await import('../../scripts/v32-to-v4/validate/compare.mjs');
    const { canonicalJson } = await import('../../scripts/v32-to-v4/lib/canonical-json.mjs');
    const findings = new Findings();
    findings.add('observation-version-order', { table: 'observation_versions', observation_id: undefined, row_index: 0 });
    expect(findings.samples).toEqual([{ check: 'observation-version-order', table: 'observation_versions', row_index: 0 }]);
    expect(() => canonicalJson(findings.samples)).not.toThrow();
  });
});

describe('a difference is sanctioned only if the compiled policy recorded it', () => {
  const folded = {
    migration_id: 'rmig_compare_fold', bundle_manifest_sha256: 'd'.repeat(64),
    tables: {
      entities: [{ id: 1, name: 'Ada', entity_type: 'person', primary_context: 'DEFAULT', salience: 'active', created_at: '2026-01-02T03:04:05Z', updated_at: '2026-01-02T03:04:06Z' }],
      observations: [{ id: 3, entity_id: 1, content: 'x', weight: 'Light', added_at: '2026-01-02T04:00:00Z' }],
    },
  };
  const foldedDraft = generateDecisionManifest(folded, { now: '2026-09-20T00:00:00.000Z' });
  const foldedDecisions = { ...foldedDraft, reviewed: true, reviewed_by: 'test', reviewed_at: '2026-09-20T00:01:00.000Z' };
  foldedDecisions.manifest_sha256 = decisionManifestHash(foldedDecisions);
  const foldedCompiled = compilePolicy({ bundle: folded, decisions: foldedDecisions });
  const foldedPlan = transformRelational({ bundle: folded, compiledPolicy: foldedCompiled });
  const run = (compiledPolicy) => compareSourceToTarget({ sourceTables: folded.tables, targetTables: structuredClone(foldedPlan.members), compiled: compiledPolicy, decisions: foldedDecisions, importedAt: IMPORTED_AT, family: 'postgres' });

  it('accepts a case-folded enum and context the policy recorded, and counts them', () => {
    expect(foldedDraft.items).toEqual([]);
    const result = run(foldedCompiled);
    expect(result.findings.samples).toEqual([]);
    expect(result.sanctioned).toMatchObject({ 'enum-case-folded': 1, 'context-case-folded': 1 });
  });

  it('refuses the same difference when the compiled policy has no record of it', () => {
    const noEnums = structuredClone(foldedCompiled);
    noEnums.value_map.enums = {};
    const withoutEnum = run(noEnums);
    expect(checksOf(withoutEnum)).toContain('cell-mismatch');
    expect(find(withoutEnum, 'cell-mismatch').map((finding) => finding.column)).toContain('weight');
    const noContexts = structuredClone(foldedCompiled);
    noContexts.value_map.contexts = {};
    expect(find(run(noContexts), 'cell-mismatch').map((finding) => finding.column)).toEqual(expect.arrayContaining(['primary_context']));
    // and a recorded value that is not what the vocabulary allows is not accepted either
    const wrong = structuredClone(foldedCompiled);
    for (const key of Object.keys(wrong.value_map.enums)) wrong.value_map.enums[key] = 'heavy';
    expect(find(run(wrong), 'cell-mismatch').map((finding) => finding.column)).toContain('weight');
  });
});

describe('a merged entity is derived from the source rows and the reviewed rules, not from the compiled output', () => {
  const mergeBundle = {
    migration_id: 'rmig_compare_merge2', bundle_manifest_sha256: 'e'.repeat(64),
    tables: {
      entities: [
        { id: 1, name: 'Ada', entity_type: 'person', primary_context: 'default', salience: 'active', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' },
        { id: 2, name: 'Ada', entity_type: 'person', primary_context: 'work', salience: 'heavy', created_at: '2026-01-05T00:00:00Z', updated_at: '2026-01-06T00:00:00Z' },
      ],
      observations: [{ id: 5, entity_id: 2, content: 'from the duplicate', added_at: '2026-01-08T00:00:00Z' }],
    },
  };
  const draft = generateDecisionManifest(mergeBundle, { now: '2026-09-20T00:00:00.000Z' });
  const choice = { action: 'merge', survivor_id: 1, merged_ids: [1, 2], field_rules: { name: { source_id: 1 }, entity_type: { source_id: 1 }, primary_context: { source_id: 1 }, salience: { source_id: 2 }, created_at: { source_id: 1 }, updated_at: { source_id: 1 } } };
  const decisions = { ...draft, items: draft.items.map((item) => ({ ...item, stated_by: 'owner', choice })), reviewed: true, reviewed_by: 'test', reviewed_at: '2026-09-20T00:01:00.000Z' };
  decisions.manifest_sha256 = decisionManifestHash(decisions);
  const compiledMerge = compilePolicy({ bundle: mergeBundle, decisions });
  const mergePlan = transformRelational({ bundle: mergeBundle, compiledPolicy: compiledMerge });
  const compareWith = (compiledPolicy, target = structuredClone(mergePlan.members)) => compareSourceToTarget({ sourceTables: mergeBundle.tables, targetTables: target, compiled: compiledPolicy, decisions, importedAt: IMPORTED_AT, family: 'postgres' });

  it('accepts the faithful result', () => {
    expect(compareWith(compiledMerge).findings.samples).toEqual([]);
    expect(mergePlan.members.people[0]).toMatchObject({ id: 1, salience: 'heavy' });
  });

  it('finds a compiled policy whose merged field values are not what the reviewed rules give, even when the target follows it', () => {
    const tampered = structuredClone(compiledMerge);
    tampered.id_map['entities:1'].field_values.salience = 'active'; // the rule says source 2 ('heavy')
    const target = structuredClone(mergePlan.members);
    target.people[0].salience = 'active'; // the target faithfully holds what the tampered policy says
    const result = compareWith(tampered, target);
    expect(checksOf(result)).toContain('merge-values-differ-from-reviewed-rules');
    expect(find(result, 'cell-mismatch').map((finding) => finding.column)).toContain('salience');
  });

  it('finds a row skipped as merged that no reviewed decision merges, and a reviewed merge the policy did not apply', () => {
    const skipsTheSurvivor = structuredClone(compiledMerge);
    skipsTheSurvivor.id_map['entities:1'].merged = true;
    expect(checksOf(compareWith(skipsTheSurvivor))).toContain('merged-row-without-reviewed-merge');
    const forgotten = structuredClone(compiledMerge);
    forgotten.id_map['entities:2'].merged = false;
    expect(checksOf(compareWith(forgotten))).toContain('reviewed-merge-not-applied');
  });
});

describe('a rename comes from the reviewed decision', () => {
  it('finds a policy whose entity name differs from the reviewed rename', () => {
    const renameBundle = {
      migration_id: 'rmig_compare_rename', bundle_manifest_sha256: 'f'.repeat(64),
      tables: { entities: [
        { id: 1, name: 'Ada', entity_type: 'person', primary_context: 'default', salience: 'active', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' },
        { id: 2, name: 'Ada', entity_type: 'person', primary_context: 'work', salience: 'active', created_at: '2026-01-05T00:00:00Z', updated_at: '2026-01-06T00:00:00Z' },
      ] },
    };
    const draft = generateDecisionManifest(renameBundle, { now: '2026-09-20T00:00:00.000Z' });
    const decisions = { ...draft, items: draft.items.map((item) => ({ ...item, stated_by: 'owner', choice: { action: 'rename', names: { 1: 'Ada (home)', 2: 'Ada (work)' } } })), reviewed: true, reviewed_by: 'test', reviewed_at: '2026-09-20T00:01:00.000Z' };
    decisions.manifest_sha256 = decisionManifestHash(decisions);
    const compiledRename = compilePolicy({ bundle: renameBundle, decisions });
    const members = transformRelational({ bundle: renameBundle, compiledPolicy: compiledRename }).members;
    const clean = compareSourceToTarget({ sourceTables: renameBundle.tables, targetTables: structuredClone(members), compiled: compiledRename, decisions, importedAt: IMPORTED_AT, family: 'postgres' });
    expect(clean.findings.samples).toEqual([]);
    const tampered = structuredClone(compiledRename);
    tampered.id_map['entities:2'].target_name = 'Ada (somewhere else)';
    const target = structuredClone(members);
    target.people.find((row) => row.id === 2).name = 'Ada (somewhere else)';
    const result = compareSourceToTarget({ sourceTables: renameBundle.tables, targetTables: target, compiled: tampered, decisions, importedAt: IMPORTED_AT, family: 'postgres' });
    expect(Object.keys(result.findings.counts)).toEqual(expect.arrayContaining(['entity-name-differs-from-reviewed-decision', 'cell-mismatch']));
  });
});

describe('a reviewed re-link or nullification is derived from the decision, not from the compiled link map', () => {
  const linkBundle = {
    migration_id: 'rmig_compare_links', bundle_manifest_sha256: 'a'.repeat(64),
    tables: {
      entities: [{ id: 1, name: 'Ada', entity_type: 'person', primary_context: 'default', salience: 'active', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' }],
      observations: [
        { id: 3, entity_id: 1, content: 'kept', added_at: '2026-01-07T00:00:00Z' },
        { id: 4, entity_id: 1, content: 'two broken references', added_at: '2026-01-08T00:00:00Z', superseded_by: 900, linked_observation_id: 901 },
      ],
    },
  };
  const linkDraft = generateDecisionManifest(linkBundle, { now: '2026-09-20T00:00:00.000Z' });
  const linkDecisions = { ...linkDraft, items: linkDraft.items.map((item) => ({ ...item, stated_by: 'owner', choice: item.field === 'superseded_by' ? 'null-if-allowed' : { action: 'link-by-reviewed-id', target_id: 3 } })), reviewed: true, reviewed_by: 'test', reviewed_at: '2026-09-20T00:01:00.000Z' };
  linkDecisions.manifest_sha256 = decisionManifestHash(linkDecisions);
  const linkCompiled = compilePolicy({ bundle: linkBundle, decisions: linkDecisions });
  const linkPlan = transformRelational({ bundle: linkBundle, compiledPolicy: linkCompiled });
  const targetWithDefaults = () => {
    const tables = structuredClone(linkPlan.members);
    for (const row of tables.observations) { row.superseded_by ??= null; row.linked_observation_id ??= null; }
    return tables;
  };
  const compareLinks = (compiledPolicy, target) => compareSourceToTarget({ sourceTables: linkBundle.tables, targetTables: target, compiled: compiledPolicy, decisions: linkDecisions, importedAt: IMPORTED_AT, family: 'postgres' });

  it('accepts the faithful result: one reference nullified, the other re-linked', () => {
    const result = compareLinks(linkCompiled, targetWithDefaults());
    expect(result.findings.samples).toEqual([]);
    expect(result.sanctioned).toMatchObject({ 'reference-nullified-by-review': 1, 'reference-relinked-by-review': 1 });
  });

  it('finds a link map that disagrees with the decision even when the target follows the link map', () => {
    const tampered = structuredClone(linkCompiled);
    const rowHash = canonicalSha256(linkBundle.tables.observations[1]);
    tampered.link_map[`observations:${rowHash}:superseded_by`] = 3; // the decision says NULL
    delete tampered.link_map[`observations:${rowHash}:linked_observation_id`]; // the decision says re-link to 3
    const target = targetWithDefaults();
    const row = target.observations.find((candidate) => candidate.id === 4);
    row.superseded_by = 3;
    row.linked_observation_id = 901;
    const result = compareLinks(tampered, target);
    expect(find(result, 'link-map-differs-from-reviewed-decision').map((finding) => finding.column).sort()).toEqual(['linked_observation_id', 'superseded_by']);
    expect(find(result, 'cell-mismatch').map((finding) => finding.column).sort()).toEqual(['linked_observation_id', 'superseded_by']);
  });
});
