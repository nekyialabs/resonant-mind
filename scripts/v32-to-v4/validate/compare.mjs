// Column-by-column comparison of what the source held with what the target holds.
//
// This is the strongest evidence the migrator produces, and it is deliberately not derived from the
// transform it checks. The transform decides what each v4 row should be; this module goes back to the
// verified source rows and the live target rows and asks, for every mapped column of every row, whether
// the target holds the source's value. A cell may differ from the source only for a reason the reviewed
// policy records for that exact cell (a remapped id, a normalized timestamp, an enum alias, a reviewed
// choice, a v4 default for a NULL), and each such difference is counted by kind, so the report shows
// what changed and why, never just "matched". Timestamps are compared as exact microsecond instants, not
// as text; ids, JSON, numbers and text follow the same exact-text rules the source adapter read with.
//
// Nothing here prints a value. Findings carry the table, the column, the kind of difference and an
// integer id or a hash of the key, never row content.

import { readFileSync } from 'node:fs';
import { canonicalJson } from '../lib/canonical-json.mjs';
import { canonicalSha256 } from '../lib/hash.mjs';
import { parseInstantMicros } from '../lib/instant.mjs';
import { jsonSurvivesParsing, sameJsonLossless } from '../lib/lossless-json.mjs';
import { sourceKey } from '../transform/id-map.mjs';
import { KIND_NORMALIZATIONS, ISO_WITH_OFFSET, SQLITE_UTC, DATE_FIELDS, TIMESTAMP_FIELDS, contextVocabulary, decisionItemForCell } from '../policy/generate.mjs';
import { ALIASES, ENUMS, ENUM_FIELDS } from '../transform/value-map.mjs';
import { TARGET_SCHEMAS, targetColumnAllowsNull } from '../transform/target-schema.mjs';

const MAP = JSON.parse(readFileSync(new URL('../spec/v3.2-to-v4-map.json', import.meta.url), 'utf8'));
const JSON_FIELDS = new Set(['links', 'connections', 'tags', 'source_observation_ids', 'data', 'sit_notes']);
const FK_COLUMNS = Object.freeze({ entity_id: 'entities', linked_observation_id: 'observations', superseded_by: 'observations', supersedes: 'observations', observation_id: 'observations', consolidated_observation_id: 'observations', obs_a_id: 'observations', obs_b_id: 'observations', from_obs_id: 'observations', to_obs_id: 'observations', from_entity_id: 'entities', to_entity_id: 'entities' });
const ROUTED = new Set(['observations', 'images', 'consolidation_groups']);
const NULL_DEFAULTS = Object.freeze({ salience: 'active', primary_context: 'default' });
const CONTEXT_FIELDS = new Set(['context', 'scope', 'primary_context']);
export const COMPARED_TARGET_TABLES = Object.freeze([...new Set(['entities', ...MAP.flatMap((entry) => entry.target_tables)])].sort());

/** Collects findings with a bounded sample per kind and exact counts, so a report stays readable. */
export class Findings {
  constructor(limit = 25) { this.limit = limit; this.counts = {}; this.samples = []; }
  add(check, details = {}) {
    this.counts[check] = (this.counts[check] ?? 0) + 1;
    // a finding is plain data for a report: a detail that is undefined is left out, not carried as a hole
    if (this.counts[check] <= this.limit) this.samples.push({ check, ...Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined)) });
  }
  get total() { return Object.values(this.counts).reduce((sum, value) => sum + value, 0); }
}

function lower(value) { return String(value).toLowerCase(); }
function rowIdOf(row, index) { return row.id ?? row.key ?? index; }
function lookup(table, id) { return sourceKey(table, id); }
function safeId(value) { return Number.isSafeInteger(value) ? { source_id: value } : { key_sha256: canonicalSha256(String(value)) }; }
function choiceAction(choice) { return typeof choice === 'string' ? choice : choice?.action ?? choice?.type ?? choice?.kind ?? choice?.choice; }
function reviewedChoice(decisions, table, rowHash, type, field) {
  return decisionItemForCell(decisions, { table, rowHash, type, field })?.choice;
}

/**
 * The instant a source timestamp means. An offset in the text, or SQLite's exact UTC form, speaks for
 * itself; a naive value means whatever timezone the reviewer chose for that exact cell.
 */
function sourceInstant(value, { decisions, table, field, rowHash }) {
  if (typeof value !== 'string') throw new Error('not text');
  if (SQLITE_UTC.test(value)) return { micros: parseInstantMicros(value, { naiveOffset: 'UTC' }), how: 'sqlite-utc' };
  try { return { micros: parseInstantMicros(value), how: 'offset' }; } catch (error) {
    if (!/no offset/u.test(error.message)) throw error;
    const choice = reviewedChoice(decisions, table, rowHash, 'timestamp', field);
    if (choiceAction(choice) !== 'normalize-utc') throw new Error('naive timestamp has no reviewed timezone');
    return { micros: parseInstantMicros(value, { naiveOffset: choice.timezone ?? choice.timezone_offset }), how: 'reviewed-timezone' };
  }
}

// JSON is compared digit for digit (lib/lossless-json.mjs): a number JSON.parse would round is a difference.
export function sameJson(left, right) { return sameJsonLossless(left, right); }

/**
 * What the v4 vocabulary and the reviewed decisions allow an enum value to become. A value may differ from
 * the source (case folded, an alias, a reviewed mapping) only if the compiled policy recorded that exact
 * value for this exact cell; a difference nobody recorded is not sanctioned, however plausible it looks.
 */
function expectedEnum(column, value, { decisions, table, rowHash, recorded }) {
  const text = lower(value);
  const sanctioned = (candidate) => (candidate.how === null || recorded === candidate.value ? candidate : null);
  if (ENUMS[column]?.has(text)) return sanctioned({ value: text, how: text === value ? null : 'enum-case-folded' });
  if (ALIASES[column]?.[text] !== undefined) return sanctioned({ value: ALIASES[column][text], how: 'enum-alias' });
  const choice = reviewedChoice(decisions, table, rowHash, 'unknown-value', column);
  const mapped = choice?.value ?? choice?.mapped_value ?? choice?.target;
  if (['map', 'map-status', 'map-context'].includes(choiceAction(choice)) && typeof mapped === 'string') return sanctioned({ value: mapped, how: 'enum-reviewed-map' });
  return null;
}
function expectedContext(value, { decisions, table, rowHash, column, recorded }) {
  const text = lower(value);
  const sanctioned = (candidate) => (candidate.how === null || recorded === candidate.value ? candidate : null);
  if (contextVocabulary(table, column).has(text)) return sanctioned({ value: text, how: text === value ? null : 'context-case-folded' });
  const choice = reviewedChoice(decisions, table, rowHash, 'unknown-value', column);
  const mapped = choice?.value ?? choice?.mapped_value ?? choice?.target;
  if (choiceAction(choice) === 'map-context' && typeof mapped === 'string') return sanctioned({ value: lower(mapped), how: 'context-reviewed-map' });
  return null;
}

// What a reviewed merge or rename makes of an entity, worked out here from the source rows and the reviewed
// decisions alone (the compiled policy's own field values and names are checked against it, not trusted).
const MERGE_FIELDS = ['name', 'entity_type', 'primary_context', 'salience', 'created_at', 'updated_at'];
function mergeFieldValue(rule, byId, survivor, field) {
  if (rule === undefined) return survivor[field];
  if (rule !== null && typeof rule === 'object' && Object.hasOwn(rule, 'value')) return rule.value;
  const selected = rule !== null && typeof rule === 'object' ? (rule.source_id ?? rule.choose_source_id ?? rule.id) : rule;
  return byId.get(String(selected))?.[field];
}
// The instant a merge rule gives created_at / updated_at, worked out from the donor cell and its own reviewed choice (an empty cell takes the
// donor's replace-timestamp, a naive one its reviewed timezone), not from the compiled policy. null: the donor cell is NULL. 'unreadable': it has no reviewed value.
function mergeInstant(rule, byId, survivor, field, decisions) {
  if (rule !== null && typeof rule === 'object' && Object.hasOwn(rule, 'value')) { if (rule.value === null || rule.value === undefined) return null; try { return parseInstantMicros(rule.value); } catch { return 'unreadable'; } }
  const selected = rule !== null && typeof rule === 'object' ? (rule.source_id ?? rule.choose_source_id ?? rule.id) : rule;
  const donor = rule === undefined ? survivor : byId.get(String(selected));
  const raw = donor?.[field];
  if (raw === null || raw === undefined) return null;
  const rowHash = canonicalSha256(donor);
  try {
    if (raw === '') {
      const choice = reviewedChoice(decisions, 'entities', rowHash, 'timestamp', field);
      return choiceAction(choice) === 'replace-timestamp' && typeof choice.value === 'string' && ISO_WITH_OFFSET.test(choice.value) ? parseInstantMicros(choice.value) : 'unreadable';
    }
    return sourceInstant(raw, { decisions, table: 'entities', field, rowHash }).micros;
  } catch { return 'unreadable'; }
}
function reviewedEntityDecisions(decisions, entities) {
  const byId = new Map(entities.map((row) => [String(row.id), row]));
  const merges = new Map(); const renames = new Map();
  for (const item of decisions?.items ?? []) {
    if (item?.type !== 'duplicate-entity-name') continue;
    const choice = item.choice;
    if (choiceAction(choice) === 'merge') {
      const survivor = byId.get(String(choice.survivor_id));
      if (!survivor || !Array.isArray(choice.merged_ids) || !choice.field_rules) continue; // compiling the policy refuses these
      const values = Object.fromEntries(MERGE_FIELDS.map((field) => [field, mergeFieldValue(choice.field_rules[field], byId, survivor, field)]));
      const kind = String(choice.kind ?? choice.final_kind ?? KIND_NORMALIZATIONS.get(lower(values.entity_type)) ?? '').toLowerCase() || undefined;
      const instants = Object.fromEntries(['created_at', 'updated_at'].map((field) => [field, mergeInstant(choice.field_rules[field], byId, survivor, field, decisions)]));
      for (const id of choice.merged_ids) merges.set(String(id), { survivor_id: choice.survivor_id, values, kind, instants });
    } else if (choiceAction(choice) === 'rename' && choice.names && typeof choice.names === 'object') {
      for (const [id, name] of Object.entries(choice.names)) renames.set(String(id), name);
    }
  }
  return { merges, renames };
}

/**
 * Compares the source rows with the target rows.
 *
 *  - sourceTables     table -> rows, exactly as the verified bundle holds them
 *  - targetTables     table -> rows, as the live target holds them (timestamps as RFC 3339 text)
 *  - compiled         the compiled policy recomputed from the bundle and the reviewed decisions
 *  - decisions        the reviewed decision manifest
 *  - importedAt       the import transaction's time in microseconds (what v4's own NOW() defaults give)
 *  - family           'postgres' or 'sqlite'
 */
export function compareSourceToTarget({ sourceTables, targetTables, compiled, decisions, importedAt, family }) {
  const findings = new Findings();
  const sanctioned = {};
  const bump = (kind) => { sanctioned[kind] = (sanctioned[kind] ?? 0) + 1; };
  const tables = {};
  const claimed = Object.fromEntries(COMPARED_TARGET_TABLES.map((table) => [table, new Set()]));
  const index = Object.fromEntries(COMPARED_TARGET_TABLES.map((table) => {
    const byId = new Map();
    for (const row of targetTables[table] ?? []) {
      const key = String(row.id);
      if (byId.has(key)) findings.add('duplicate-target-id', { table, ...safeId(row.id) });
      byId.set(key, row);
    }
    return [table, byId];
  }));
  const excludedRows = new Set(compiled.excluded_rows ?? []);
  const nullLosses = new Set((compiled.losses ?? []).filter((loss) => loss.kind === 'null-replaced-by-v4-default').map((loss) => `${loss.source_row_sha256}:${loss.field}`));
  const nullObserved = new Set();
  const entityTarget = (id) => compiled.id_map?.[lookup('entities', id)];

  // Version numbers, worked out here from the source rows: per observation, ordered by the instant of
  // changed_at and then by integer id. The policy's own numbering is not consulted.
  const versionRows = (sourceTables.observation_versions ?? []).map((row, position) => ({ row, hash: canonicalSha256(row), id: rowIdOf(row, position) }));
  const expectedVersion = new Map();
  {
    const groups = new Map();
    for (const item of versionRows) {
      if (excludedRows.has(`observation_versions:${item.hash}`) || compiled.id_map?.[lookup('observation_versions', item.id)]?.excluded) continue;
      const observation = compiled.id_map?.[lookup('observations', item.row.observation_id)];
      const owner = observation?.target_id ?? item.row.observation_id;
      let micros = null;
      if (item.row.changed_at !== null && item.row.changed_at !== undefined) {
        try { micros = sourceInstant(item.row.changed_at, { decisions, table: 'observation_versions', field: 'changed_at', rowHash: item.hash }).micros; } catch { micros = null; }
      }
      const bucket = groups.get(String(owner)) ?? [];
      bucket.push({ ...item, micros });
      groups.set(String(owner), bucket);
    }
    for (const bucket of groups.values()) {
      bucket.sort((a, b) => (a.micros === b.micros ? 0 : a.micros === null ? -1 : b.micros === null ? 1 : a.micros < b.micros ? -1 : 1) || (Number.isSafeInteger(Number(a.id)) && Number.isSafeInteger(Number(b.id)) ? Number(a.id) - Number(b.id) : String(a.id).localeCompare(String(b.id))));
      bucket.forEach((item, position) => expectedVersion.set(item.hash, position + 1));
    }
  }

  const { merges, renames } = reviewedEntityDecisions(decisions, sourceTables.entities ?? []);
  // The link a reviewed decision gives a reference cell (re-linked to a reviewed id, or set to NULL), read from
  // the decision itself. The compiled link map must say the same; the cell's expectation follows the decision.
  const checkedLinks = new Map();
  const reviewedLink = (table, rowHash, column, types, where) => {
    const key = `${table}:${rowHash}:${column}`;
    if (checkedLinks.has(key)) return checkedLinks.get(key);
    let reviewed = { has: false };
    for (const type of types) {
      const item = decisionItemForCell(decisions, { table, rowHash, type, field: column });
      const action = choiceAction(item?.choice);
      if (action === 'link-by-reviewed-id') { reviewed = { has: true, value: item.choice.target_id }; break; }
      if (action === 'null-if-allowed') { reviewed = { has: true, value: null }; break; }
    }
    const compiledHas = compiled.link_map !== undefined && compiled.link_map !== null && Object.hasOwn(compiled.link_map, key);
    if (reviewed.has !== compiledHas || (reviewed.has && canonicalJson(reviewed.value) !== canonicalJson(compiled.link_map[key] ?? null))) findings.add('link-map-differs-from-reviewed-decision', { ...where, column });
    const result = reviewed.has ? reviewed.value : undefined;
    checkedLinks.set(key, result);
    return result;
  };
  const mappings = MAP.filter((entry) => entry.target_tables.length > 0 && entry.source_families.includes(family) && Array.isArray(sourceTables[entry.source_table]));
  let cells = 0;

  for (const mapping of mappings) {
    const sourceTable = mapping.source_table;
    const summary = { source_rows: 0, compared_rows: 0, excluded_by_review: 0, merged_by_review: 0, cells_compared: 0, target_table: mapping.target_tables.join(',') };
    tables[sourceTable] = summary;
    for (const [position, row] of (sourceTables[sourceTable] ?? []).entries()) {
      summary.source_rows += 1;
      const rowHash = canonicalSha256(row);
      const id = rowIdOf(row, position);
      const idEntry = compiled.id_map?.[lookup(sourceTable, id)];
      const where = { table: sourceTable, ...safeId(id) };
      if (excludedRows.has(`${sourceTable}:${rowHash}`) || idEntry?.excluded) { summary.excluded_by_review += 1; continue; }
      const merge = sourceTable === 'entities' ? merges.get(String(id)) : undefined;
      const mergedAway = merge !== undefined && String(merge.survivor_id) !== String(id);
      if (sourceTable === 'entities') {
        // the compiled policy may only skip a row as merged if the reviewed decisions merge it into a survivor, and the other way round
        if ((idEntry?.merged === true) !== mergedAway) findings.add(idEntry?.merged === true ? 'merged-row-without-reviewed-merge' : 'reviewed-merge-not-applied', where);
        // created_at / updated_at are held to the instant the rule's donor cell means, not to the donor's raw text
        const plannedInstant = (value) => { if (value === null || value === undefined) return null; try { return parseInstantMicros(value); } catch { return 'unreadable'; } };
        const mergeTextFields = MERGE_FIELDS.filter((field) => field !== 'created_at' && field !== 'updated_at');
        if (merge !== undefined && !mergedAway && (canonicalJson(Object.fromEntries(mergeTextFields.map((field) => [field, idEntry?.field_values?.[field] ?? null]))) !== canonicalJson(Object.fromEntries(mergeTextFields.map((field) => [field, merge.values[field] ?? null]))) || ['created_at', 'updated_at'].some((field) => String(plannedInstant(idEntry?.field_values?.[field])) !== String(merge.instants[field])))) findings.add('merge-values-differ-from-reviewed-rules', where);
        if (merge === undefined && renames.has(String(id)) && idEntry?.target_name !== renames.get(String(id))) findings.add('entity-name-differs-from-reviewed-decision', where);
      }
      if (idEntry?.merged) { summary.merged_by_review += 1; continue; }
      const targetTableName = sourceTable === 'entities' ? idEntry?.target_table : mapping.target_tables[0];
      if (!targetTableName || !index[targetTableName]) { findings.add('source-row-has-no-target-table', where); continue; }
      const targetId = idEntry?.target_id ?? id;
      const target = index[targetTableName].get(String(targetId));
      if (!target) { findings.add('source-row-missing-in-target', { ...where, target_table: targetTableName }); continue; }
      claimed[targetTableName].add(String(targetId));
      summary.compared_rows += 1;
      if (sourceTable === 'entities') {
        const other = targetTableName === 'people' ? 'nodes' : 'people';
        if (index[other].has(String(targetId))) findings.add('entity-routed-to-both', where);
      }

      const fail = (column, kind) => findings.add('cell-mismatch', { ...where, target_table: targetTableName, column, difference: kind });
      const compareCell = (sc, tc, rawValue, options = {}) => {
        let sv = rawValue;
        const tv = target[tc];
        cells += 1; summary.cells_compared += 1;
        const qualified = `${sourceTable}.${sc}`;
        if (options.expected !== undefined) { // computed by the caller (ids, names, routing)
          if (options.expected === tv || (options.expected !== null && tv !== null && String(options.expected) === String(tv))) { if (options.sanction) bump(options.sanction); return; }
          fail(tc, options.kind ?? 'value'); return;
        }
        if (TIMESTAMP_FIELDS.has(qualified)) {
          if (sv === null || sv === undefined) {
            if (tv === null || tv === undefined) return;
            if (sourceTable === 'entities' && (sc === 'created_at' || sc === 'updated_at') && importedAt !== null) {
              let micros = null; try { micros = parseInstantMicros(tv); } catch { /* fails below */ }
              if (micros === importedAt && nullLosses.has(`${rowHash}:${sc}`)) { nullObserved.add(`${rowHash}:${sc}`); bump('null-replaced-by-v4-default'); return; }
            }
            fail(tc, 'null-became-a-value'); return;
          }
          if (sv === '') { // empty text, not NULL: the target holds exactly what the owner chose for this cell
            const choice = reviewedChoice(decisions, sourceTable, rowHash, 'timestamp', sc);
            const chosen = choiceAction(choice);
            if (chosen === 'set-null') {
              if (!targetColumnAllowsNull(sourceTable, sc, row)) fail(tc, 'empty-set-null-not-allowed');
              else if (tv !== null && tv !== undefined) fail(tc, 'null-expected');
              else bump('timestamp-reviewed-empty');
              return;
            }
            let wanted = null;
            if (chosen === 'replace-timestamp' && typeof choice.value === 'string' && ISO_WITH_OFFSET.test(choice.value)) { try { wanted = parseInstantMicros(choice.value); } catch { wanted = null; } }
            if (wanted === null) { fail(tc, 'empty-unreviewed'); return; }
            let held = null;
            if (typeof tv === 'string') { try { held = parseInstantMicros(tv); } catch { held = null; } }
            if (held !== wanted) fail(tc, 'instant'); else bump('timestamp-reviewed-empty');
            return;
          }
          let expected;
          try { expected = sourceInstant(sv, { decisions, table: sourceTable, field: sc, rowHash }); } catch { fail(tc, 'source-timestamp-unreadable'); return; }
          let actual = null;
          if (typeof tv === 'string') { try { actual = parseInstantMicros(tv); } catch { actual = null; } }
          if (actual !== expected.micros) { fail(tc, 'instant'); return; }
          if (expected.how === 'reviewed-timezone') bump('timestamp-reviewed-timezone');
          else if (tv !== sv) bump('timestamp-reformatted-same-instant');
          return;
        }
        if (DATE_FIELDS.has(qualified)) {
          if (sv === null || sv === undefined) { if (tv !== null && tv !== undefined) fail(tc, 'null-became-a-value'); return; }
          const choice = reviewedChoice(decisions, sourceTable, rowHash, 'date', sc);
          if (sv === '') { // empty text, not NULL: the target holds exactly what the owner chose for this cell
            if (choiceAction(choice) === 'set-null') {
              if (!targetColumnAllowsNull(sourceTable, sc, row)) fail(tc, 'empty-set-null-not-allowed');
              else if (tv !== null && tv !== undefined) fail(tc, 'null-expected');
              else bump('date-reviewed-empty');
              return;
            }
            const wantedDate = choiceAction(choice) === 'normalize-date' && typeof choice.value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(choice.value) && !Number.isNaN(new Date(`${choice.value}T00:00:00.000Z`).valueOf()) && new Date(`${choice.value}T00:00:00.000Z`).toISOString().slice(0, 10) === choice.value ? choice.value : null;
            if (wantedDate === null) fail(tc, 'empty-unreviewed'); else if (tv !== wantedDate) fail(tc, 'date'); else bump('date-reviewed-empty');
            return;
          }
          const expected = /^\d{4}-\d{2}-\d{2}$/u.test(sv) ? sv : (choiceAction(choice) === 'normalize-date' ? choice.value : null);
          if (expected === null || tv !== expected) fail(tc, 'date'); else if (expected !== sv) bump('date-reviewed-replacement');
          return;
        }
        if (ENUM_FIELDS.has(qualified)) {
          if (sv === null || sv === undefined) { if (tv !== null && tv !== undefined) fail(tc, 'null-became-a-value'); return; }
          const expected = expectedEnum(sc, sv, { decisions, table: sourceTable, rowHash, recorded: compiled.value_map?.enums?.[`${sourceTable}:${rowHash}:${sc}`] });
          if (expected === null || tv !== expected.value) fail(tc, 'enum'); else if (expected.how) bump(expected.how);
          return;
        }
        if (CONTEXT_FIELDS.has(sc)) {
          if (sv === null || sv === undefined) {
            if (sourceTable === 'entities' && sc === 'primary_context' && tv === NULL_DEFAULTS.primary_context && nullLosses.has(`${rowHash}:${sc}`)) { nullObserved.add(`${rowHash}:${sc}`); bump('null-replaced-by-v4-default'); return; }
            if (tv !== null && tv !== undefined) fail(tc, 'null-became-a-value');
            return;
          }
          const expected = expectedContext(sv, { decisions, table: sourceTable, rowHash, column: sc, recorded: compiled.value_map?.contexts?.[`${sourceTable}:${rowHash}:${sc}`] });
          if (expected === null || tv !== expected.value) fail(tc, 'context'); else if (expected.how) bump(expected.how);
          return;
        }
        if (sourceTable === 'entities' && sc === 'salience' && (sv === null || sv === undefined)) {
          if (tv === NULL_DEFAULTS.salience && nullLosses.has(`${rowHash}:${sc}`)) { nullObserved.add(`${rowHash}:${sc}`); bump('null-replaced-by-v4-default'); } else fail(tc, 'null-became-a-value');
          return;
        }
        if (JSON_FIELDS.has(sc)) {
          if (sv === null || sv === undefined) { if (tv !== null && tv !== undefined) fail(tc, 'null-became-a-value'); return; }
          let expected = sv;
          let parsed;
          try { parsed = typeof sv === 'string' ? JSON.parse(sv) : sv; } catch { parsed = undefined; }
          if (typeof sv === 'string' && parsed !== undefined && !jsonSurvivesParsing(sv)) parsed = undefined; // a repeated key or an inexact number is a reviewed decision, as in the plan
          if (parsed === undefined) {
            const choice = reviewedChoice(decisions, sourceTable, rowHash, 'malformed-json', sc);
            if (choiceAction(choice) !== 'map-json' || !Object.hasOwn(choice, 'value')) { fail(tc, 'json-unreviewed'); return; }
            expected = choice.value; bump('json-reviewed-replacement');
          }
          if (!sameJson(expected, tv)) fail(tc, 'json'); else if (typeof tv === 'string' && tv !== sv) bump('json-reformatted-same-value');
          return;
        }
        if (sv === tv) return;
        if (typeof sv === 'number' && typeof tv === 'number' && Object.is(sv, tv)) return;
        fail(tc, typeof sv === 'string' ? 'text' : 'value');
      };

      // A reviewed tension decision states resolved_at / resolution itself; those cells are checked against it below.
      const tensionChoice = sourceTable === 'tensions' ? compiled.semantic_choices?.[`tensions:${rowHash}`] : undefined;
      const tensionAction = choiceAction(tensionChoice);
      const reviewedTensionColumns = new Set(tensionAction === 'preserve-visits-and-open' ? ['resolved_at', 'resolution'] : tensionAction === 'preserve-visits-and-resolve' ? [...(tensionChoice.resolved_at !== null && tensionChoice.resolved_at !== undefined ? ['resolved_at'] : []), ...(tensionChoice.resolution !== undefined ? ['resolution'] : [])] : []);
      for (const [sc, tc] of Object.entries(mapping.column_map)) {
        if (!Object.hasOwn(row, sc)) continue;
        if (reviewedTensionColumns.has(sc)) continue;
        const value = row[sc];
        if (sourceTable === 'entities') {
          const override = merge !== undefined ? merge.values[sc] : undefined;
          const reviewedName = merge !== undefined ? merge.values.name : (renames.get(String(id)) ?? idEntry?.target_name ?? value);
          if (sc === 'id') { compareCell(sc, tc, value, { expected: idEntry?.target_id ?? value, kind: 'id' }); continue; }
          if (sc === 'name') { compareCell(sc, tc, value, { expected: reviewedName, kind: 'name', sanction: reviewedName !== value ? 'entity-renamed-or-merged-by-review' : undefined }); continue; }
          if (sc === 'entity_type') {
            const derived = KIND_NORMALIZATIONS.get(lower(override ?? value)) ?? (() => { const choice = reviewedChoice(decisions, 'entities', rowHash, 'entity-kind', 'entity_type'); return choice?.kind ?? choice?.value; })();
            const expectedKind = merge !== undefined ? merge.kind : derived;
            if (idEntry?.final_kind !== undefined && expectedKind !== undefined && expectedKind !== idEntry.final_kind) { findings.add('entity-kind-not-derivable', where); cells += 1; summary.cells_compared += 1; continue; }
            compareCell(sc, tc, value, { expected: idEntry?.final_kind, kind: 'entity-kind' });
            continue;
          }
          if ((sc === 'created_at' || sc === 'updated_at') && merge !== undefined && merge.instants[sc] !== null) {
            cells += 1; summary.cells_compared += 1;
            let held = null; if (typeof target[tc] === 'string') { try { held = parseInstantMicros(target[tc]); } catch { held = null; } }
            if (merge.instants[sc] === 'unreadable') fail(tc, 'source-timestamp-unreadable'); else if (held !== merge.instants[sc]) fail(tc, 'instant');
            continue;
          }
          if (override !== undefined) { compareCell(sc, tc, override); continue; }
        }
        if (sc === 'source_observation_ids') {
          let ids; try { ids = typeof value === 'string' ? JSON.parse(value) : value; } catch { ids = null; }
          const expectedIds = Array.isArray(ids) ? ids.map((item) => { const entry = compiled.id_map?.[lookup('observations', Number(item))]; return entry === undefined ? Number(item) : entry.excluded ? null : entry.target_id; }).filter((item) => item !== null) : null;
          cells += 1; summary.cells_compared += 1;
          const actual = Array.isArray(target[tc]) ? target[tc].map(Number) : (typeof target[tc] === 'string' ? (() => { try { return JSON.parse(target[tc]).map(Number); } catch { return null; } })() : null);
          if (expectedIds === null || actual === null || canonicalJson(expectedIds) !== canonicalJson(actual)) fail(tc, 'id-list');
          else if (canonicalJson(expectedIds) !== canonicalJson((ids ?? []).map(Number))) bump('id-list-remapped');
          continue;
        }
        if (FK_COLUMNS[sc] !== undefined) {
          let expected;
          const link = reviewedLink(sourceTable, rowHash, sc, ['broken-foreign-key'], where);
          if (link !== undefined) {
            const entry = link === null ? null : compiled.id_map?.[lookup(FK_COLUMNS[sc], link)];
            expected = link === null ? null : (entry?.excluded ? null : entry?.target_id ?? link);
          } else if (value === null || value === undefined) expected = null;
          else { const entry = compiled.id_map?.[lookup(FK_COLUMNS[sc], value)]; expected = entry === undefined ? value : entry.excluded ? null : entry.target_id; }
          compareCell(sc, tc, value, { expected, kind: 'reference', sanction: link !== undefined ? (link === null ? 'reference-nullified-by-review' : 'reference-relinked-by-review') : (expected !== value ? 'reference-remapped' : undefined) });
          continue;
        }
        if (sourceTable === 'relations' && (sc === 'from_entity' || sc === 'to_entity')) {
          const link = reviewedLink('relations', rowHash, sc, ['broken-name-reference', 'ambiguous-name-reference'], where);
          let expected = value;
          if (link !== undefined) { const entry = compiled.id_map?.[lookup('entities', link)]; expected = entry?.excluded ? null : (entry?.target_name ?? String(value)); }
          else if (value !== null && value !== undefined) { const context = sc === 'from_entity' ? row.from_context : row.to_context; const mapped = compiled.name_map?.[`${context ?? 'default'}:${String(value)}`] ?? compiled.name_map?.[String(value)]; expected = mapped?.target_name ?? String(value); }
          compareCell(sc, tc, value, { expected, kind: 'endpoint-name', sanction: expected !== value ? 'endpoint-renamed-by-review' : undefined });
          continue;
        }
        compareCell(sc, tc, value);
      }

      if (ROUTED.has(sourceTable)) {
        const entityColumn = reviewedLink(sourceTable, rowHash, 'entity_id', ['broken-foreign-key'], where);
        const mappedEntity = entityColumn !== undefined ? entityColumn : (row.entity_id === null || row.entity_id === undefined ? null : (compiled.id_map?.[lookup('entities', row.entity_id)]?.target_id ?? row.entity_id));
        const entry = mappedEntity === null ? undefined : compiled.id_map?.[lookup('entities', mappedEntity)];
        const route = entry && !entry.excluded ? (entry.target_table === 'people' ? { person_id: entry.target_id, node_id: null } : { person_id: null, node_id: entry.target_id }) : { person_id: null, node_id: null };
        for (const column of ['person_id', 'node_id']) { cells += 1; summary.cells_compared += 1; if ((target[column] ?? null) !== route[column]) fail(column, 'routing'); }
      }
      if (sourceTable === 'observation_versions') {
        cells += 1; summary.cells_compared += 1;
        if (target.version_num !== expectedVersion.get(rowHash)) fail('version_num', 'version-order');
      }
      if (sourceTable === 'tensions') {
        const choice = compiled.semantic_choices?.[`tensions:${rowHash}`];
        const action = choiceAction(choice);
        const compareExtra = (column, expected, kind = 'value') => { cells += 1; summary.cells_compared += 1; if ((target[column] ?? null) !== expected) fail(column, kind); };
        const instantEquals = (column, text, how) => {
          cells += 1; summary.cells_compared += 1;
          if (text === null || text === undefined) { if (target[column] !== null && target[column] !== undefined) fail(column, 'null-became-a-value'); return; }
          let expected; try { expected = parseInstantMicros(text, { naiveOffset: how?.timezone ?? how?.timezone_offset }); } catch { fail(column, 'reviewed-timestamp-unreadable'); return; }
          let actual = null; try { actual = typeof target[column] === 'string' ? parseInstantMicros(target[column]) : null; } catch { actual = null; }
          if (actual !== expected) fail(column, 'instant'); else bump('tension-state-from-review');
        };
        if (action === 'preserve-visits-and-open') { compareExtra('resolved_at', null); compareExtra('resolution', null); bump('tension-state-from-review'); }
        else if (action === 'preserve-visits-and-resolve') {
          if (choice.resolved_at !== null && choice.resolved_at !== undefined) instantEquals('resolved_at', choice.resolved_at, choice.resolved_at_choice);
          if (choice.resolution !== undefined) compareExtra('resolution', choice.resolution);
        }
        if (choice?.last_visited !== undefined) instantEquals('last_visited', choice.last_visited, choice.last_visited_choice);
        else if (Number(row.sit_count ?? 0) > 0) {
          cells += 1; summary.cells_compared += 1;
          let created = null; try { created = sourceInstant(row.created_at, { decisions, table: 'tensions', field: 'created_at', rowHash }).micros; } catch { created = null; }
          let actual = null; try { actual = typeof target.last_visited === 'string' ? parseInstantMicros(target.last_visited) : null; } catch { actual = null; }
          if (created === null || actual !== created) fail('last_visited', 'instant'); else bump('last-visited-defaulted-to-created-at');
        }
      }
    }
  }

  // Every target row in a compared table must belong to a source row (or be the trigger's routed copy).
  for (const table of COMPARED_TARGET_TABLES) {
    if (table === 'entities') continue; // the compatibility surface is checked against the plan, row for row
    const total = index[table].size;
    if (claimed[table].size !== total) {
      for (const [key, row] of index[table]) if (!claimed[table].has(key)) findings.add('target-row-without-source', { table, ...safeId(row.id) });
    }
  }
  // A recorded 'null-replaced-by-v4-default' loss must be visible in the target, and the other way round.
  for (const key of nullLosses) if (!nullObserved.has(key)) findings.add('recorded-default-not-observed', { key_sha256: canonicalSha256(key) });
  return { findings, sanctioned, tables, cells_compared: cells };
}

/**
 * Whether one planned cell is what the target holds, by the v4 column type: null when it is, otherwise the
 * kind of difference. A plan NULL in a column v4's routing trigger fills in must be exactly that default.
 */
export function planCellMismatch({ table, column, value, dbValue, columnType, importedAt }) {
  const type = TARGET_SCHEMAS[table]?.columns?.[column];
  if (value === null) {
    const routed = (table === 'people' || table === 'nodes');
    if (routed && (column === 'created_at' || column === 'updated_at')) {
      let micros = null; try { micros = parseInstantMicros(dbValue); } catch { micros = null; }
      return importedAt === null || importedAt === undefined || micros !== importedAt ? 'default-not-import-time' : null;
    }
    if (routed && column in NULL_DEFAULTS) return dbValue !== NULL_DEFAULTS[column] ? 'default' : null;
    return dbValue !== null && dbValue !== undefined ? 'null-became-a-value' : null;
  }
  if (type === 'timestamptz') {
    let expected = null; let actualMicros = null;
    try { expected = parseInstantMicros(value); actualMicros = typeof dbValue === 'string' ? parseInstantMicros(dbValue) : null; } catch { /* fails below */ }
    return expected === null || actualMicros !== expected ? 'instant' : null;
  }
  if (type === 'integer') return String(value) !== String(dbValue) ? 'integer' : null;
  if (type === 'double' || type === 'real') return typeof dbValue === 'number' && Object.is(value, dbValue) ? null : 'number';
  if (type === 'boolean') return value !== dbValue ? 'boolean' : null;
  if (type === 'integer_array') return !Array.isArray(dbValue) || canonicalJson(value.map(Number)) !== canonicalJson(dbValue.map(Number)) ? 'id-list' : null;
  if (type === 'date') return value !== dbValue ? 'date' : null;
  if (type === 'jsonb' || /^jsonb?$/u.test(columnType ?? '')) return sameJson(value, dbValue) ? null : 'json';
  return value !== dbValue ? 'text' : null;
}

/**
 * The value of a simple literal column default as the catalog prints it ('active'::text, 0, 1.5, false,
 * '{}'::jsonb), or { literal: false } for anything else (a function call such as now() or nextval(...), an
 * expression, an array). Nothing here evaluates text from the target.
 */
export function literalDefault(expression) {
  if (typeof expression !== 'string') return { literal: false };
  const text = expression.trim().replace(/(?:::[A-Za-z_][A-Za-z0-9_ ]*(?:\(\d+(?:,\d+)?\))?)+$/u, '');
  if (/^NULL$/iu.test(text)) return { literal: true, value: null };
  if (/^(?:true|false)$/iu.test(text)) return { literal: true, value: text.toLowerCase() === 'true' };
  if (/^-?\d+(?:\.\d+)?$/u.test(text)) return { literal: true, value: Number(text), numeric: true };
  const quoted = /^'((?:[^']|'')*)'$/u.exec(text);
  if (quoted) return { literal: true, value: quoted[1].replaceAll("''", "'") };
  return { literal: false };
}

/**
 * What a default expression is, when it is one of the two the validator can evaluate itself, from the text the
 * catalog prints for it (never run against the target):
 *  - { kind: 'import-time' }: now(), CURRENT_TIMESTAMP and transaction_timestamp() (optionally cast to
 *    timestamptz). All three are the start time of the transaction, and the whole import is one transaction, so a
 *    column filled by one of them holds exactly the import's `imported_at` (the receipt row is stamped the same
 *    way). statement_timestamp(), clock_timestamp(), CURRENT_TIMESTAMP(n) and every other form are not this.
 *  - { kind: 'sequence', schema, name }: nextval('seq'::regclass); the value must be an integer within the
 *    sequence's own range.
 * Anything else is { kind: null }: it cannot be evaluated here.
 */
export function evaluableDefault(expression) {
  if (typeof expression !== 'string') return { kind: null };
  const text = expression.trim().replace(/::(?:timestamp with time zone|timestamptz)$/iu, '').trim();
  if (/^(?:now\(\)|current_timestamp|transaction_timestamp\(\))$/iu.test(text)) return { kind: 'import-time' };
  const call = /^nextval\('((?:[^']|'')*)'(?:::regclass)?\)$/iu.exec(text);
  if (call) {
    const name = parseQualifiedName(call[1].replaceAll("''", "'"));
    if (name !== null) return { kind: 'sequence', ...name };
  }
  return { kind: null };
}
// 'name', 'schema.name', '"Quoted"."Names"' -> { schema, name } (an unqualified name is in public). Null when it is not one.
function parseQualifiedName(text) {
  const parts = []; let index = 0;
  while (index <= text.length) {
    if (text[index] === '"') {
      let value = ''; index += 1;
      for (;;) {
        if (index >= text.length) return null;
        if (text[index] === '"') { if (text[index + 1] === '"') { value += '"'; index += 2; continue; } index += 1; break; }
        value += text[index]; index += 1;
      }
      parts.push(value);
    } else {
      const match = /^[a-z_][a-z0-9_$]*/u.exec(text.slice(index));
      if (match === null) return null;
      parts.push(match[0]); index += match[0].length;
    }
    if (index === text.length) break;
    if (text[index] !== '.') return null;
    index += 1;
  }
  if (parts.length === 1) return { schema: 'public', name: parts[0] };
  if (parts.length === 2) return { schema: parts[0], name: parts[1] };
  return null;
}
const asInteger = (value) => { try { if (typeof value === 'bigint') return value; if (typeof value === 'number') return Number.isSafeInteger(value) ? BigInt(value) : null; if (typeof value === 'string' && /^-?\d+$/u.test(value)) return BigInt(value); } catch { /* not an integer */ } return null; };

/**
 * Columns a released v4 trigger fills in when the plan row leaves them out, with the derivation the trigger
 * applies (0006_identity_kind.sql: identity.kind is the first dotted segment of section, other characters
 * folded to underscores, lower-cased). The validator re-derives the value itself, in the same order of
 * operations as the trigger (fold first, then lower-case), instead of trusting the stored one.
 */
export const TRIGGER_DERIVED = Object.freeze({
  identity: Object.freeze({ kind: (row) => (typeof row?.section === 'string' ? row.section.split('.')[0].replace(/[^a-z0-9_]+/gu, '_').toLowerCase() : null) }),
});

/**
 * A target column the plan row does not state. The database fills such a column from its default, so the
 * only values it may hold are NULL, the column's own literal default, a value the database computes (a
 * generated or identity column), or the result of a default expression (now(), nextval(...)) that this
 * validator does not evaluate and reports as such, or a value a released v4 trigger derives from the rest of
 * the row (TRIGGER_DERIVED), which must be exactly what that trigger derives. Anything else is a value nobody planned. With no
 * knowledge of the column's default, any non-NULL value is unplanned. Returns the state:
 * 'absent' | 'default' | 'computed' | 'derived' | 'default-expression-not-evaluated' | 'unplanned-value' | 'default-differs' | 'derived-value-differs'.
 *
 * now() / CURRENT_TIMESTAMP / transaction_timestamp() are evaluated as exactly `importedAt` (the import's one
 * transaction) and nextval(...) as an integer within the sequence's range (`sequences`, keyed 'schema.name',
 * each { min, max }); anything else the catalog prints as a function call is 'default-expression-not-evaluated'
 * and is never accepted as ready (comparePlanToTarget makes it a finding).
 */
export function unstatedCellState({ table, column, row, dbValue = row?.[column], columnInfo, importedAt, sequences }) {
  if (dbValue === null || dbValue === undefined) return 'absent';
  const derive = TRIGGER_DERIVED[table]?.[column];
  if (derive !== undefined) return derive(row) === dbValue ? 'derived' : 'derived-value-differs';
  if (columnInfo === undefined || columnInfo === null) return 'unplanned-value';
  if (columnInfo.generated === true || columnInfo.identity === true) return 'computed';
  if (columnInfo.default === null || columnInfo.default === undefined) return 'unplanned-value';
  const parsed = literalDefault(columnInfo.default);
  if (!parsed.literal) return evaluatedExpressionState({ expression: columnInfo.default, dbValue, importedAt, sequences });
  if (parsed.value === null) return 'default-differs';
  let same;
  if (parsed.numeric) same = Number(dbValue) === parsed.value;
  else if (typeof parsed.value === 'boolean') same = dbValue === parsed.value;
  else if (typeof dbValue === 'string') same = dbValue === parsed.value || sameJson(dbValue, parsed.value);
  else same = false;
  return same ? 'default' : 'default-differs';
}

function evaluatedExpressionState({ expression, dbValue, importedAt, sequences }) {
  const evaluable = evaluableDefault(expression);
  if (evaluable.kind === 'import-time') {
    if (importedAt === null || importedAt === undefined) return 'default-expression-not-evaluated';
    let micros = null; try { micros = typeof dbValue === 'string' ? parseInstantMicros(dbValue) : null; } catch { micros = null; }
    return micros !== null && micros === importedAt ? 'default' : 'default-differs';
  }
  if (evaluable.kind === 'sequence') {
    const range = sequences?.[`${evaluable.schema}.${evaluable.name}`];
    if (range === undefined || range === null) return 'default-expression-not-evaluated';
    const value = asInteger(dbValue);
    return value !== null && value >= BigInt(range.min) && value <= BigInt(range.max) ? 'default' : 'default-differs';
  }
  return 'default-expression-not-evaluated';
}

/** The target columns of one row: those the catalog lists for the table and those the row carries (a view has no catalog entry). */
export function targetColumns(columnTypes, table, row) {
  return [...new Set([...Object.keys(columnTypes?.[table] ?? {}), ...Object.keys(row ?? {})])];
}

/**
 * The plan the target was imported from, against the rows the target holds. Every column the plan row
 * states is compared by its v4 column type; a plan NULL in a column v4's routing trigger fills in must be
 * exactly that default. Every other column the target holds is compared too (see unstatedCellState): plan
 * rows are insert-shaped and need not carry every v4 column, but a value in a column the plan did not state
 * is only acceptable if it is NULL or the database's own default. Rows may not be missing, extra or duplicated.
 */
export function comparePlanToTarget({ plan, targetTables, columnTypes = {}, columnDefaults = {}, importedAt, sequences }) {
  const unevaluated = new Map(); // 'table.column' -> cells
  const findings = new Findings();
  const tables = {};
  let cells = 0;
  for (const table of COMPARED_TARGET_TABLES) {
    const expectedRows = plan.members?.[table] ?? [];
    const actualRows = targetTables[table] ?? [];
    const schema = TARGET_SCHEMAS[table];
    const summary = { plan_rows: expectedRows.length, target_rows: actualRows.length, cells_compared: 0, unstated_cells_compared: 0, default_expressions_not_evaluated: 0 };
    tables[table] = summary;
    if (!schema) { findings.add('plan-table-unknown', { table }); continue; }
    const byId = new Map();
    for (const row of actualRows) { if (byId.has(String(row.id))) findings.add('duplicate-target-id', { table, ...safeId(row.id) }); byId.set(String(row.id), row); }
    const seen = new Set();
    for (const planned of expectedRows) {
      const key = String(planned.id);
      if (seen.has(key)) findings.add('duplicate-plan-id', { table, ...safeId(planned.id) });
      seen.add(key);
      const actual = byId.get(key);
      if (!actual) { findings.add('plan-row-missing-in-target', { table, ...safeId(planned.id) }); continue; }
      for (const [column, value] of Object.entries(planned)) {
        cells += 1; summary.cells_compared += 1;
        if (value === undefined) continue;
        const difference = planCellMismatch({ table, column, value, dbValue: actual[column], columnType: columnTypes[table]?.[column], importedAt });
        if (difference !== null) findings.add('plan-cell-mismatch', { table, ...safeId(planned.id), column, difference });
      }
      for (const column of targetColumns(columnTypes, table, actual)) {
        if (planned[column] !== undefined) continue;
        cells += 1; summary.cells_compared += 1; summary.unstated_cells_compared += 1;
        const state = unstatedCellState({ table, column, row: actual, columnInfo: columnDefaults[table]?.[column], importedAt, sequences });
        if (state === 'unplanned-value' || state === 'default-differs' || state === 'derived-value-differs') findings.add('target-column-not-in-plan', { table, ...safeId(planned.id), column, difference: state });
        else if (state === 'default-expression-not-evaluated') {
          summary.default_expressions_not_evaluated += 1;
          unevaluated.set(`${table}.${column}`, (unevaluated.get(`${table}.${column}`) ?? 0) + 1);
          findings.add('default-expression-not-evaluated', { table, ...safeId(planned.id), column });
        }
      }
    }
    for (const [key, row] of byId) if (!seen.has(key)) findings.add('target-row-not-in-plan', { table, ...safeId(row.id) });
  }
  const unevaluatedDefaults = [...unevaluated].sort(([a], [b]) => a.localeCompare(b)).map(([key, count]) => ({ table: key.slice(0, key.indexOf('.')), column: key.slice(key.indexOf('.') + 1), cells: count }));
  return { findings, tables, cells_compared: cells, unevaluated_defaults: unevaluatedDefaults };
}
