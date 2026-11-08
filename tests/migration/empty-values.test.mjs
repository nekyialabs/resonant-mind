import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../../scripts/v32-to-v4/lib/hash.mjs';
import { DATE_FIELDS, TIMESTAMP_FIELDS, decisionManifestHash, generateDecisionItems, generateDecisionManifest } from '../../scripts/v32-to-v4/policy/generate.mjs';
import { compilePolicy } from '../../scripts/v32-to-v4/policy/compile.mjs';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MigrationRefusal } from '../../scripts/v32-to-v4/lib/refusal.mjs';
import { transformRelational } from '../../scripts/v32-to-v4/transform/relational.mjs';
import { compareSourceToTarget } from '../../scripts/v32-to-v4/validate/compare.mjs';
import { targetColumnAllowsNull } from '../../scripts/v32-to-v4/transform/target-schema.mjs';
import { buildIdMaps } from '../../scripts/v32-to-v4/transform/id-map.mjs';
import { buildValueMaps, normalizeContext, normalizeDate, normalizeEntityKind, normalizeEnum, normalizeTimestamp } from '../../scripts/v32-to-v4/transform/value-map.mjs';

// An empty string is not a missing value. Where the generator lists it as a decision (enums, contexts, entity kinds: '' is not in the
// vocabulary) validate holds the target to the reviewed choice, so the transform has to apply that choice and not keep the empty text.
const entity = { id: 1, name: 'Ada', entity_type: '', primary_context: '', salience: 'active' };
const observation = { id: 5, entity_id: 1, content: 'c', weight: '', certainty: '', context: '', salience: 'active', added_at: '2026-01-01T00:00:00Z' };
const bundle = { migration_id: 'rmig_empty_values_test', bundle_manifest_sha256: 'b'.repeat(64), tables: { entities: [entity], observations: [observation] } };
const decided = (table, row, type, field, choice) => ({ source_table: table, source_row_sha256: canonicalSha256(row), type, field, choice });
const policy = { items: [
  decided('observations', observation, 'unknown-value', 'weight', { action: 'map', value: 'light' }),
  decided('observations', observation, 'unknown-value', 'certainty', { action: 'map', value: 'known' }),
  decided('observations', observation, 'unknown-value', 'context', { action: 'map-context', value: 'episodic' }),
  decided('entities', entity, 'unknown-value', 'primary_context', { action: 'map-context', value: 'default' }),
  decided('entities', entity, 'entity-kind', 'entity_type', { action: 'map-to-person', kind: 'person' }),
] };

describe('what the generator does with an empty string', () => {
  it('lists it for an enum, a context and an entity kind', () => {
    const items = generateDecisionItems(bundle).map((item) => `${item.type} ${item.source_table}.${item.field}`);
    expect(items).toEqual(expect.arrayContaining(['unknown-value observations.weight', 'unknown-value observations.certainty', 'unknown-value observations.context', 'unknown-value entities.primary_context', 'entity-kind entities.entity_type']));
  });

  it('lists an empty timestamp and an empty date, and leaves NULL and the supported forms alone', () => {
    const row = { id: 7, entity_id: 1, content: 'c', added_at: '', last_surfaced_at: null, archived_at: '2026-01-02T03:04:05Z', last_accessed_at: '2026-01-02 03:04:05', source_date: '' };
    const items = generateDecisionItems({ tables: { observations: [row] } }).filter((item) => item.type === 'timestamp' || item.type === 'date');
    expect(items.map((item) => `${item.type} ${item.field}`).sort()).toEqual(['date source_date', 'timestamp added_at']);
  });
});

describe('an empty string takes the reviewed choice', () => {
  it('normalizeEnum refuses it without a choice and applies the choice with one', () => {
    expect(() => normalizeEnum('', 'weight')).toThrow(/reviewed/u);
    expect(normalizeEnum('', 'weight', { choice: { action: 'map', value: 'light' } })).toBe('light');
    expect(() => normalizeEnum('', 'weight', { choice: { action: 'map', value: 'enormous' } })).toThrow(/unsupported/u);
    expect(normalizeEnum(null, 'weight')).toBeNull();
    expect(normalizeEnum('Heavy', 'weight')).toBe('heavy');
  });

  it('normalizeContext refuses it without a choice and applies the choice with one', () => {
    expect(() => normalizeContext('')).toThrow(/reviewed/u);
    expect(normalizeContext('', { choice: { action: 'map-context', value: 'episodic' } })).toBe('episodic');
    expect(() => normalizeContext('', { choice: { action: 'map-context', value: 'nowhere' } })).toThrow(/unsupported/u);
    expect(normalizeContext(null)).toBeNull();
  });

  it('normalizeEntityKind refuses it without a choice and applies the choice with one', () => {
    expect(() => normalizeEntityKind('')).toThrow(/reviewed/u);
    expect(normalizeEntityKind('', { choice: { action: 'map-to-person', kind: 'person' } })).toBe('person');
    expect(normalizeEntityKind('', { choice: { action: 'map-to-node', kind: 'concept' } })).toBe('concept');
    expect(() => normalizeEntityKind('', { choice: { action: 'map-to-node', kind: 'person' } })).toThrow(/reviewed/u);
    expect(normalizeEntityKind(null)).toBeNull();
  });

  it('lands in the value map, and is an unresolved loss until it is reviewed', () => {
    const maps = buildValueMaps({ tables: bundle.tables, policy });
    const key = (table, row, field) => `${table}:${canonicalSha256(row)}${field ? `:${field}` : ''}`;
    expect(maps.losses).toEqual([]);
    expect(maps.enums[key('observations', observation, 'weight')]).toBe('light');
    expect(maps.enums[key('observations', observation, 'certainty')]).toBe('known');
    expect(maps.contexts[key('observations', observation, 'context')]).toBe('episodic');
    expect(maps.contexts[key('entities', entity, 'primary_context')]).toBe('default');
    expect(maps.entity_kinds[key('entities', entity)]).toBe('person');
    const unreviewed = buildValueMaps({ tables: bundle.tables, policy: { items: [] } });
    expect(unreviewed.losses.map((loss) => `${loss.kind}:${loss.field ?? ''}`).sort()).toEqual(['unresolved-context:context', 'unresolved-context:primary_context', 'unresolved-entity-kind:', 'unresolved-enum:certainty', 'unresolved-enum:weight']);
  });

  it('compiles into the policy the import writes from', () => {
    const manifest = generateDecisionManifest(bundle, { now: '2026-09-20T00:00:00.000Z' });
    const choiceOf = (item) => policy.items.find((entry) => entry.source_table === item.source_table && entry.source_row_sha256 === item.source_row_sha256 && entry.type === item.type && entry.field === item.field)?.choice;
    manifest.items = manifest.items.map((item) => ({ ...item, stated_by: 'owner', choice: choiceOf(item) }));
    manifest.reviewed = true; manifest.reviewed_by = 'test'; manifest.reviewed_at = '2026-09-20T00:00:00.000Z'; manifest.manifest_sha256 = decisionManifestHash(manifest);
    const compiled = compilePolicy({ bundle, decisions: manifest });
    expect(Object.values(compiled.value_map.enums)).toEqual(expect.arrayContaining(['known', 'light']));
    expect(Object.values(compiled.value_map.contexts)).toEqual(expect.arrayContaining(['default', 'episodic']));
    expect(Object.values(compiled.value_map.entity_kinds)).toEqual(['person']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// An empty string in a timestamp or date column (issue 14). It is not NULL and it is not a time, so it is a decision: exclude the
// row, store NULL (only where the v4 column can hold it), or give the instant / date it stands for. The owner always chooses.
const T = '2026-01-02T03:04:05Z';
const ada = { id: 1, name: 'Ada', entity_type: 'person', primary_context: 'default', salience: 'active', created_at: T, updated_at: T };
const blankAdded = { id: 10, entity_id: 1, content: 'blank added_at', added_at: '', source_date: '2026-01-02' };
const blankSurfaced = { id: 11, entity_id: 1, content: 'blank last_surfaced_at', added_at: T, last_surfaced_at: '', source_date: '' };
const blankUntil = { id: 12, entity_id: 1, content: 'blank valid_until', added_at: T, valid_until: '', source_date: null };
const blankOut = { id: 13, entity_id: 1, content: 'blank, excluded', added_at: '' };
const blankEntity = { id: 2, name: 'Rhizome', entity_type: 'concept', primary_context: 'default', salience: 'active', created_at: '', updated_at: T };
const emptyBundle = {
  migration_id: 'rmig_empty_time_test', bundle_manifest_sha256: 'c'.repeat(64),
  tables: { entities: [ada, blankEntity], observations: [blankAdded, blankSurfaced, blankUntil, blankOut] },
};
const itemAt = (items, table, id, field) => items.find((item) => item.source_table === table && String(item.source_id) === String(id) && item.field === field);
const REPLACE = { action: 'replace-timestamp', value: '2026-03-04T05:06:07+01:00' };
const CHOICES = {
  'observations.10.added_at': REPLACE,
  'observations.11.last_surfaced_at': { action: 'set-null' },
  'observations.11.source_date': { action: 'normalize-date', value: '2026-03-05' },
  'observations.12.valid_until': 'set-null',
  'observations.13.added_at': 'exclude-row',
  'entities.2.created_at': { action: 'replace-timestamp', value: '2025-12-31T23:00:00-02:00' },
};
function reviewed(choices = CHOICES, bundle = emptyBundle) {
  const draft = generateDecisionManifest(bundle, { now: '2026-11-08T00:00:00.000Z' });
  const manifest = { ...draft, items: draft.items.map((item) => ({ ...item, stated_by: 'owner', choice: choices[`${item.source_table}.${item.source_id}.${item.field}`] })), reviewed: true, reviewed_by: 'test', reviewed_at: '2026-11-08T00:01:00.000Z' };
  manifest.manifest_sha256 = decisionManifestHash(manifest);
  return manifest;
}

describe('an empty timestamp or date is a decision item with the owner\'s choices', () => {
  const items = generateDecisionItems(emptyBundle);

  it('lists each empty cell once, as a timestamp or date item that says why', () => {
    const cells = items.filter((item) => item.type === 'timestamp' || item.type === 'date').map((item) => `${item.type} ${item.source_table}.${item.source_id}.${item.field}`).sort();
    expect(cells).toEqual(['date observations.11.source_date', 'timestamp entities.2.created_at', 'timestamp observations.10.added_at', 'timestamp observations.11.last_surfaced_at', 'timestamp observations.12.valid_until', 'timestamp observations.13.added_at']);
    expect(itemAt(items, 'observations', 10, 'added_at').reason).toBe('timestamp is empty text, not NULL; the owner must choose');
    expect(itemAt(items, 'observations', 11, 'source_date').reason).toBe('date is empty text, not NULL; the owner must choose');
  });

  it('offers a reviewed instant, NULL and exclusion where v4 can hold NULL, and requires the value', () => {
    expect(itemAt(items, 'observations', 10, 'added_at')).toMatchObject({ type: 'timestamp', allowed_choices: ['replace-timestamp', 'set-null', 'exclude-row'], required_choice_fields: { 'replace-timestamp': ['value'] } });
    expect(itemAt(items, 'observations', 11, 'source_date')).toMatchObject({ type: 'date', allowed_choices: ['normalize-date', 'set-null', 'exclude-row'], required_choice_fields: { 'normalize-date': ['value'] } });
  });

  it('does not offer set-null where the target cannot hold NULL', () => {
    // v4's entity routing trigger writes COALESCE(created_at, NOW()), so the target never holds NULL there
    expect(itemAt(items, 'entities', 2, 'created_at').allowed_choices).toEqual(['replace-timestamp', 'exclude-row']);
    const tension = (sit_count) => generateDecisionItems({ tables: { tensions: [{ id: 't', pole_a: 'a', pole_b: 'b', sit_count, created_at: '' }] } }).find((item) => item.type === 'timestamp');
    expect(tension(0).allowed_choices).toContain('set-null');
    expect(tension(2).allowed_choices).toEqual(['replace-timestamp', 'exclude-row']); // last_visited defaults from created_at
  });

  it('keeps the supported forms, naive values and NULL exactly as before', () => {
    const rows = [{ id: 1, entity_id: 1, content: 'x', added_at: T, last_surfaced_at: '2026-01-02 03:04:05', archived_at: '2026-01-02T03:04:05', resolved_at: null, source_date: '2026-02-30' }];
    const found = generateDecisionItems({ tables: { entities: [ada], observations: rows } }).filter((item) => item.type === 'timestamp' || item.type === 'date').map((item) => ({ type: item.type, field: item.field, allowed: item.allowed_choices }));
    expect(found).toEqual(expect.arrayContaining([{ type: 'timestamp', field: 'archived_at', allowed: ['normalize-utc', 'exclude-row'] }, { type: 'date', field: 'source_date', allowed: ['normalize-date', 'exclude-row'] }]));
    expect(found).toHaveLength(2);
  });

  it('reads nullability from the v4 catalog: only the entity trigger columns among the timestamp columns refuse NULL', () => {
    const refused = [...TIMESTAMP_FIELDS, ...DATE_FIELDS].filter((key) => !targetColumnAllowsNull(...key.split('.'))).sort();
    expect(refused).toEqual(['entities.created_at', 'entities.updated_at']);
  });

  it('agrees with migrations/postgres: no mapped timestamp or date column is declared NOT NULL there', () => {
    const migrations = join(import.meta.dirname, '../../migrations/postgres');
    const sql = readdirSync(migrations).filter((name) => name.endsWith('.sql')).map((name) => readFileSync(join(migrations, name), 'utf8')).join('\n');
    const map = JSON.parse(readFileSync(join(import.meta.dirname, '../../scripts/v32-to-v4/spec/v3.2-to-v4-map.json'), 'utf8'));
    const targets = new Set();
    for (const key of [...TIMESTAMP_FIELDS, ...DATE_FIELDS]) { const [table, field] = key.split('.'); const entry = map.find((candidate) => candidate.source_table === table); targets.add(entry.column_map[field]); }
    for (const column of targets) {
      expect(new RegExp(`\\b${column}\\s+(?:TIMESTAMPTZ|DATE)\\b[^,\\n]*NOT NULL`, 'iu').test(sql), `${column} declared NOT NULL`).toBe(false);
      expect(new RegExp(`ALTER COLUMN\\s+${column}\\s+SET NOT NULL`, 'iu').test(sql), `${column} SET NOT NULL`).toBe(false);
    }
    expect(sql).toMatch(/COALESCE\(NEW\.created_at, NOW\(\)\)/u); // the one place v4 itself fills an entity timestamp
  });
});

describe('every layer applies the reviewed outcome of an empty timestamp or date', () => {
  const decisions = reviewed();
  const key = (table, row, field) => `${table}:${canonicalSha256(row)}:${field}`;

  it('the value map applies each choice, and treats an unreviewed empty cell as an unresolved loss', () => {
    const maps = buildValueMaps({ tables: emptyBundle.tables, policy: decisions, skipRows: new Set([`observations:${canonicalSha256(blankOut)}`]) });
    expect(maps.losses).toEqual([]);
    expect(maps.timestamps[key('observations', blankAdded, 'added_at')]).toBe('2026-03-04T04:06:07.000Z');
    expect(maps.timestamps[key('observations', blankSurfaced, 'last_surfaced_at')]).toBeNull();
    expect(maps.dates[key('observations', blankSurfaced, 'source_date')]).toBe('2026-03-05');
    expect(maps.timestamps[key('observations', blankUntil, 'valid_until')]).toBeNull();
    expect(maps.timestamps[key('entities', blankEntity, 'created_at')]).toBe('2026-01-01T01:00:00.000Z');
    const unreviewed = buildValueMaps({ tables: emptyBundle.tables, policy: { items: [] } });
    expect(unreviewed.losses.map((loss) => `${loss.kind}:${loss.field}`).sort()).toEqual(['unresolved-date:source_date', 'unresolved-timestamp:added_at', 'unresolved-timestamp:added_at', 'unresolved-timestamp:created_at', 'unresolved-timestamp:last_surfaced_at', 'unresolved-timestamp:valid_until']);
    expect(Object.hasOwn(unreviewed.timestamps, key('observations', blankAdded, 'added_at'))).toBe(false); // '' is never passed through
    expect(Object.hasOwn(unreviewed.dates, key('observations', blankSurfaced, 'source_date'))).toBe(false);
  });

  it('normalizeTimestamp and normalizeDate refuse an empty string without a choice, and take only a valid one', () => {
    expect(() => normalizeTimestamp('')).toThrow(/reviewed choice/u);
    expect(() => normalizeDate('')).toThrow(/reviewed choice/u);
    expect(() => normalizeTimestamp('', { choice: { action: 'normalize-utc', timezone: 'UTC' } })).toThrow(/reviewed choice/u);
    expect(normalizeTimestamp(null)).toBeNull();
    expect(normalizeDate(null)).toBeNull();
    expect(normalizeTimestamp('', { choice: { action: 'replace-timestamp', value: '2026-01-02T03:04:05.123456Z' } })).toBe('2026-01-02T03:04:05.123456Z');
    expect(normalizeTimestamp('', { choice: { action: 'set-null' }, table: 'observations', field: 'archived_at' })).toBeNull();
    expect(normalizeDate('', { choice: { action: 'set-null' }, table: 'observations', field: 'source_date' })).toBeNull();
    for (const value of ['2026-01-02T03:04:05', '2026-01-02 03:04:05', '2026-02-30T00:00:00Z', '2026-01-02T24:00:00Z', 'soon', '', undefined]) expect(() => normalizeTimestamp('', { choice: { action: 'replace-timestamp', value } }), String(value)).toThrow();
    for (const value of ['2026-02-30', '2026-01-02T03:04:05Z', 'x', '', undefined]) expect(() => normalizeDate('', { choice: { action: 'normalize-date', value } }), String(value)).toThrow();
  });

  it('the value map refuses set-null where the target is NOT NULL, even if a choice file says so', () => {
    const forced = { items: [{ source_table: 'entities', source_row_sha256: canonicalSha256(blankEntity), type: 'timestamp', field: 'created_at', choice: { action: 'set-null' } }] };
    expect(buildValueMaps({ tables: { entities: [blankEntity] }, policy: forced }).losses.map((loss) => loss.kind)).toEqual(['unresolved-timestamp']);
    expect(() => normalizeTimestamp('', { choice: { action: 'set-null' }, table: 'entities', field: 'updated_at' })).toThrow(/cannot hold NULL/u);
  });

  it('policy validation and compile refuse a set-null the item does not offer, and a malformed replacement', () => {
    const attempt = (choices) => () => compilePolicy({ bundle: emptyBundle, decisions: reviewed({ ...CHOICES, ...choices }) });
    expect(attempt({})).not.toThrow();
    expect(attempt({ 'entities.2.created_at': 'set-null' })).toThrow(MigrationRefusal);
    expect(attempt({ 'entities.2.created_at': { action: 'set-null' } })).toThrow(MigrationRefusal);
    for (const value of ['2026-01-02T03:04:05', '2026-02-30T00:00:00Z', 'nonsense', '']) expect(attempt({ 'observations.10.added_at': { action: 'replace-timestamp', value } }), value).toThrow(MigrationRefusal);
    expect(attempt({ 'observations.10.added_at': { action: 'replace-timestamp' } })).toThrow(MigrationRefusal);
    expect(attempt({ 'observations.10.added_at': 'replace-timestamp' })).toThrow(MigrationRefusal);
    expect(attempt({ 'observations.10.added_at': { action: 'normalize-utc', timezone: 'UTC' } })).toThrow(MigrationRefusal);
    expect(attempt({ 'observations.11.source_date': { action: 'normalize-date', value: '2026-02-30' } })).toThrow(MigrationRefusal);
    expect(attempt({ 'observations.11.source_date': 'normalize-date' })).toThrow(MigrationRefusal);
  });

  it('compiles, plans and compares: the target must hold exactly the reviewed outcome, counted by reason', () => {
    const compiled = compilePolicy({ bundle: emptyBundle, decisions });
    expect(compiled.value_map.losses).toEqual([]);
    const plan = transformRelational({ bundle: emptyBundle, compiledPolicy: compiled });
    const observation = (id) => plan.members.observations.find((row) => row.id === id);
    expect(observation(10).added_at).toBe('2026-03-04T04:06:07.000Z');
    expect(observation(11)).toMatchObject({ last_surfaced_at: null, source_date: '2026-03-05' });
    expect(observation(12).valid_until).toBeNull();
    expect(observation(13)).toBeUndefined(); // exclude-row works like any other exclusion
    expect(plan.members.nodes.find((row) => row.id === 2).created_at).toBe('2026-01-01T01:00:00.000Z');
    expect(compiled.losses.filter((loss) => loss.kind === 'excluded-row').map((loss) => loss.source_table)).toEqual(['observations']);

    const compare = (tables) => compareSourceToTarget({ sourceTables: emptyBundle.tables, targetTables: tables, compiled, decisions, importedAt: null, family: 'postgres' });
    const clean = compare(structuredClone(plan.members));
    expect(clean.findings.samples).toEqual([]);
    expect(clean.sanctioned).toMatchObject({ 'timestamp-reviewed-empty': 4, 'date-reviewed-empty': 1 }); // 10.added_at, 11.last_surfaced_at, 12.valid_until, entity 2 created_at
    expect(clean.sanctioned['timestamp-reviewed-timezone']).toBeUndefined();

    const damaged = (change) => { const tables = structuredClone(plan.members); change(tables); return compare(tables).findings.samples; };
    const cell = (column, difference) => expect.objectContaining({ check: 'cell-mismatch', column, difference });
    expect(damaged((t) => { t.observations.find((row) => row.id === 11).last_surfaced_at = T; })).toContainEqual(cell('last_surfaced_at', 'null-expected'));
    expect(damaged((t) => { t.observations.find((row) => row.id === 12).valid_until = ''; })).toContainEqual(cell('valid_until', 'null-expected'));
    expect(damaged((t) => { t.observations.find((row) => row.id === 10).added_at = ''; })).toContainEqual(cell('added_at', 'instant'));
    expect(damaged((t) => { t.observations.find((row) => row.id === 10).added_at = '2026-03-04T05:06:07.000Z'; })).toContainEqual(cell('added_at', 'instant')); // the offset was ignored
    expect(damaged((t) => { t.observations.find((row) => row.id === 11).source_date = null; })).toContainEqual(cell('source_date', 'date'));
    expect(damaged((t) => { t.nodes.find((row) => row.id === 2).created_at = ''; })).toContainEqual(cell('created_at', 'instant'));
  });

  it('compare does not accept an empty cell nobody reviewed, or a set-null on a NOT NULL target', () => {
    const compiled = compilePolicy({ bundle: emptyBundle, decisions });
    const plan = transformRelational({ bundle: emptyBundle, compiledPolicy: compiled });
    const forced = structuredClone(decisions);
    forced.items.find((item) => item.source_table === 'entities' && item.field === 'created_at').choice = { action: 'set-null' };
    const asNull = structuredClone(plan.members); asNull.nodes.find((row) => row.id === 2).created_at = null;
    const run = (d, tables) => compareSourceToTarget({ sourceTables: emptyBundle.tables, targetTables: tables, compiled, decisions: d, importedAt: null, family: 'postgres' }).findings.samples;
    expect(run(forced, asNull)).toContainEqual(expect.objectContaining({ check: 'cell-mismatch', column: 'created_at', difference: 'empty-set-null-not-allowed' }));
    const blank = structuredClone(decisions);
    blank.items.find((item) => item.source_table === 'observations' && item.source_id === 10).choice = 'exclude-row';
    expect(run(blank, structuredClone(plan.members))).toContainEqual(expect.objectContaining({ check: 'cell-mismatch', column: 'added_at', difference: 'empty-unreviewed' }));
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// A merge rule that copies created_at / updated_at from another row copies a source cell, so it goes through the same rules as any other:
// the donor cell's reviewed outcome, never the raw text.
describe('an entity merge copies a timestamp only through the donor cell\'s reviewed value', () => {
  const survivor = { id: 1, name: 'Ada', entity_type: 'person', primary_context: 'default', salience: 'active', created_at: T, updated_at: T };
  const donorEmpty = { id: 2, name: 'Ada', entity_type: 'person', primary_context: 'default', salience: 'active', created_at: '', updated_at: T };
  const donorNaive = { id: 3, name: 'Ada', entity_type: 'person', primary_context: 'default', salience: 'active', created_at: T, updated_at: '2026-02-03 04:05:06.5' };
  const mergeBundle = (donor) => ({ migration_id: 'rmig_merge_empty_test', bundle_manifest_sha256: 'd'.repeat(64), tables: { entities: [survivor, donor], observations: [{ id: 1, entity_id: donor.id, content: 'moved', added_at: T }] } });
  const rules = (field, donor) => ({ name: { source_id: 1 }, entity_type: { source_id: 1 }, primary_context: { source_id: 1 }, salience: { source_id: 1 }, created_at: { source_id: 1 }, updated_at: { source_id: 1 }, [field]: { source_id: donor.id } });
  const decide = (bundle, mergeRules, own = {}) => {
    const draft = generateDecisionManifest(bundle, { now: '2026-11-08T00:00:00.000Z' });
    const items = draft.items.map((item) => ({ ...item, stated_by: 'owner', choice: item.type === 'duplicate-entity-name' ? { action: 'merge', survivor_id: 1, merged_ids: [1, bundle.tables.entities[1].id], field_rules: mergeRules } : own[`${item.source_id}.${item.field}`] }));
    const manifest = { ...draft, items: items.filter((item) => item.choice !== undefined), reviewed: true, reviewed_by: 'test', reviewed_at: '2026-11-08T00:01:00.000Z' };
    manifest.manifest_sha256 = decisionManifestHash(manifest);
    return manifest;
  };
  const run = (bundle, decisions) => {
    const compiled = compilePolicy({ bundle, decisions });
    const plan = transformRelational({ bundle, compiledPolicy: compiled });
    const compare = (members) => compareSourceToTarget({ sourceTables: bundle.tables, targetTables: members, compiled, decisions, importedAt: null, family: 'postgres' });
    return { compiled, plan, compare };
  };

  it('refuses a rule that copies an empty created_at from a donor row nobody reviewed', () => {
    const bundle = mergeBundle(donorEmpty);
    // the donor's own item exists, but the owner chose to exclude it, which leaves its cell without a value to copy
    const decisions = decide(bundle, rules('created_at', donorEmpty), { '2.created_at': 'exclude-row' });
    expect(() => compilePolicy({ bundle, decisions })).toThrow(MigrationRefusal);
    try { compilePolicy({ bundle, decisions }); } catch (error) { expect(error.code).toBe('RMIG-E-POLICY-UNRESOLVED'); expect(error.summary).toMatch(/created_at/u); }
    const unreviewedMerge = { items: [{ type: 'duplicate-entity-name', source_table: 'entities', source_id: 1, source_row_sha256: canonicalSha256(survivor), decision_id: 'x', choice: { action: 'merge', survivor_id: 1, merged_ids: [1, 2], field_rules: rules('created_at', donorEmpty) } }] };
    expect(() => buildIdMaps(bundle.tables, unreviewedMerge)).toThrow(MigrationRefusal);
  });

  it('lands the donor cell\'s reviewed replace-timestamp, and compare holds the target to it', () => {
    const bundle = mergeBundle(donorEmpty);
    const decisions = decide(bundle, rules('created_at', donorEmpty), { '2.created_at': { action: 'replace-timestamp', value: '2025-12-31T23:00:00-02:00' } });
    const { compiled, plan, compare } = run(bundle, decisions);
    expect(compiled.id_map['entities:1'].field_values.created_at).toBe('2026-01-01T01:00:00.000Z');
    expect(plan.members.people).toEqual([expect.objectContaining({ id: 1, created_at: '2026-01-01T01:00:00.000Z' })]);
    expect(compare(structuredClone(plan.members)).findings.samples).toEqual([]);
    const raw = structuredClone(plan.members); raw.people[0].created_at = '';
    expect(compare(raw).findings.samples).toContainEqual(expect.objectContaining({ check: 'cell-mismatch', column: 'created_at', difference: 'instant' }));
    const wrong = structuredClone(plan.members); wrong.people[0].created_at = T;
    expect(compare(wrong).findings.samples).toContainEqual(expect.objectContaining({ check: 'cell-mismatch', column: 'created_at' }));
  });

  it('lands a naive donor timestamp at its reviewed timezone, and refuses it with none', () => {
    const bundle = mergeBundle(donorNaive);
    const decisions = decide(bundle, rules('updated_at', donorNaive), { '3.updated_at': { action: 'normalize-utc', timezone: '+01:00' } });
    const { compiled, plan, compare } = run(bundle, decisions);
    expect(compiled.id_map['entities:1'].field_values.updated_at).toBe('2026-02-03T03:05:06.500Z');
    expect(plan.members.people).toEqual([expect.objectContaining({ id: 1, updated_at: '2026-02-03T03:05:06.500Z' })]);
    expect(compare(structuredClone(plan.members)).findings.samples).toEqual([]);
    const utc = structuredClone(plan.members); utc.people[0].updated_at = '2026-02-03T04:05:06.500Z'; // the timezone was ignored
    expect(compare(utc).findings.samples).toContainEqual(expect.objectContaining({ check: 'cell-mismatch', column: 'updated_at', difference: 'instant' }));
    const unreviewed = decide(bundle, rules('updated_at', donorNaive), { '3.updated_at': 'exclude-row' });
    expect(() => compilePolicy({ bundle, decisions: unreviewed })).toThrow(MigrationRefusal);
  });

  it('still copies an ordinary donor timestamp, as its normalized instant', () => {
    const bundle = mergeBundle({ ...donorEmpty, created_at: '2026-01-05T00:00:00+02:00' });
    const { plan, compare } = run(bundle, decide(bundle, rules('created_at', donorEmpty)));
    expect(plan.members.people[0].created_at).toBe('2026-01-04T22:00:00.000Z');
    expect(compare(structuredClone(plan.members)).findings.samples).toEqual([]);
  });
});
