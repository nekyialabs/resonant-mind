import { canonicalSha256, sha256Hex } from '../lib/hash.mjs';
import { FORMAT_VERSION } from '../lib/contracts.mjs';
import { MigrationRefusal } from '../lib/refusal.mjs';
import { extractBundleRows, bundleHash, generateDecisionItems, choiceForItem } from './generate.mjs';
import { summarizeStatements, validateDecisionManifest } from './validate.mjs';
import { buildIdMaps } from '../transform/id-map.mjs';
import { buildValueMaps } from '../transform/value-map.mjs';
import { canonicalJson } from '../lib/canonical-json.mjs';
import { sourceSpecFor } from '../lib/fingerprint.mjs';
import { readFileSync } from 'node:fs';
import { parseInstantMicros } from '../lib/instant.mjs';

const MAP = JSON.parse(readFileSync(new URL('../spec/v3.2-to-v4-map.json', import.meta.url), 'utf8'));
// migrations/postgres/0005d_routing_triggers.sql: COALESCE(NEW.salience, 'active'), COALESCE(NEW.primary_context, 'default'),
// COALESCE(NEW.created_at, NOW()), COALESCE(NEW.updated_at, NOW()).
export const V4_ENTITY_NULL_SUBSTITUTES = Object.freeze([
  ['created_at', 'the import time (NOW() inside the import transaction)'],
  ['updated_at', 'the import time (NOW() inside the import transaction)'],
  ['salience', "'active'"],
  ['primary_context', "'default'"],
]);
function refuse(summary, details = {}, code = 'RMIG-E-POLICY-UNRESOLVED') { throw new MigrationRefusal({ code, phase: 'compile-policy', summary, safe_details: details, report_path: null }); }
// Version numbers follow (observation, changed_at, id). changed_at is compared as an instant, not as text:
// '...00.123Z' and '...00.123456Z' differ in length, and as strings the later one sorts first. Ids that
// are integers are compared as integers ('10' comes after '9'), anything else as text. A missing time
// sorts first, and two missing times are equal.
function compareIdentifiers(left, right) {
  const a = Number(left); const b = Number(right);
  if (Number.isSafeInteger(a) && Number.isSafeInteger(b) && String(a) === String(left) && String(b) === String(right)) return a < b ? -1 : a > b ? 1 : 0;
  return String(left).localeCompare(String(right));
}
function compareInstants(left, right) {
  if ((left === null || left === undefined) && (right === null || right === undefined)) return 0;
  if (left === null || left === undefined) return -1;
  if (right === null || right === undefined) return 1;
  const a = parseInstantMicros(left); const b = parseInstantMicros(right);
  return a < b ? -1 : a > b ? 1 : 0;
}
function rowsOf(bundle) { return extractBundleRows(bundle); }
function choiceAction(choice) { return typeof choice === 'string' ? choice : choice?.action ?? choice?.type ?? choice?.kind ?? choice?.choice; }
function decisionFor(policy, item) { return choiceForItem(policy, item); }
function itemFor(items, table, row, type, field) { const hash = canonicalSha256(row); return items.find((item) => item.source_table === table && item.source_row_sha256 === hash && item.type === type && (!field || item.field === field)); }
function validatePolicyInput(bundle, decisions) {
  const hash = bundleHash(bundle); const expected = generateDecisionItems(bundle);
  try { validateDecisionManifest(decisions, { bundleManifestSha256: hash, expectedItems: expected }); }
  catch (error) { refuse(error.message, { bundle_manifest_sha256: hash }, /stale|source row|missing or extra decisions/iu.test(error.message) ? 'RMIG-E-POLICY-MISMATCH' : 'RMIG-E-POLICY-UNRESOLVED'); }
  if (!decisions.reviewed) refuse('A reviewed decision manifest is required; unresolved policy choices are not accepted.');
  const bundleMigrationId = bundle.migration_id ?? bundle.manifest?.migration_id;
  if (bundleMigrationId !== undefined && decisions.migration_id !== bundleMigrationId) refuse('The reviewed decisions belong to a different migration than this bundle.', { bundle_manifest_sha256: hash }, 'RMIG-E-POLICY-MISMATCH');
  for (const item of expected) if (choiceForItem(decisions, item) === undefined) refuse('Every generated ambiguity must have an explicit reviewed choice.', { decision_id: item.decision_id });
}
function effectiveFamily(bundle) { const sourceKind = bundle?.source_kind ?? bundle?.manifest?.source_kind; return sourceKind === 'd1-export' ? 'sqlite' : sourceKind; }
function activeMappings(tables, bundle) {
  const family = effectiveFamily(bundle); const explicit = family !== undefined;
  if (explicit && !['postgres', 'sqlite'].includes(family)) refuse('Unsupported source family for v3.2 mapping coverage.', { source_family: family });
  const expected = explicit ? sourceSpecFor(family).tables : Object.keys(tables).map((name) => ({ name, columns: Object.keys(tables[name]?.[0] ?? {}).map((column) => ({ name: column })) }));
  const expectedNames = new Set(expected.map(({ name }) => name));
  const actualNames = new Set(Object.keys(tables));
  if (explicit) {
    const missing = [...expectedNames].filter((name) => !actualNames.has(name));
    const extra = [...actualNames].filter((name) => !expectedNames.has(name));
    if (missing.length || extra.length) refuse('Bundle tables do not exactly cover the expected source family.', { source_family: family, missing_tables: missing.sort(), extra_tables: extra.sort() }, 'RMIG-E-POLICY-MISMATCH');
  }
  const selected = MAP.filter((mapping) => (family === undefined ? actualNames.has(mapping.source_table) : mapping.source_families.includes(family) && (actualNames.has(mapping.source_table) || explicit)));
  const selectedNames = new Set(selected.map(({ source_table }) => source_table));
  const unmapped = [...actualNames].filter((name) => !selectedNames.has(name));
  if (unmapped.length) refuse('Bundle contains a source table without a mapping for its source family.', { tables: unmapped.sort(), source_family: family ?? 'inferred' });
  for (const mapping of selected) {
    const source = expected.find(({ name }) => name === mapping.source_table);
    const fields = new Set(Object.keys(mapping.column_map ?? {})); for (const dropped of mapping.dropped_fields ?? []) fields.add(dropped.field);
    const missing = explicit ? (source?.columns ?? []).map(({ name }) => name).filter((name) => !fields.has(name)) : [];
    const duplicate = [...fields].filter((field) => Object.keys(mapping.column_map ?? {}).filter((name) => name === field).length > 1);
    if (missing.length || duplicate.length) refuse('Mapping does not exhaustively cover an exact v3.2 source table.', { source_table: mapping.source_table, missing_fields: missing.sort(), duplicate_fields: duplicate.sort() });
  }
  return { selected, family, expectedNames };
}
function validateReviewedLinks(items, decisions, tables, idMaps) {
  const nonNullable = new Set(['observations.entity_id', 'observation_versions.observation_id', 'orphan_observations.observation_id', 'co_surfacing.obs_a_id', 'co_surfacing.obs_b_id']);
  for (const item of items) {
    const choice = decisionFor(decisions, item); const selectedAction = choiceAction(choice);
    if (item.type === 'broken-foreign-key' && selectedAction === 'null-if-allowed' && nonNullable.has(`${item.source_table}.${item.field}`)) refuse('Reviewed nullification is not allowed for a required v4 foreign key.', { source_table: item.source_table, field: item.field });
    if (!['broken-name-reference', 'ambiguous-name-reference'].includes(item.type)) continue;
    if (selectedAction !== 'link-by-reviewed-id') continue;
    if (typeof item.endpoint_sha256 !== 'string' || item.endpoint_sha256 !== sha256Hex(String(tables[item.source_table]?.find((row) => canonicalSha256(row) === item.source_row_sha256)?.[item.field] ?? ''))) refuse('Relation endpoint locator is not bound to the reviewed source value.', { source_table: item.source_table, source_row_sha256: item.source_row_sha256, field: item.field });
    const target = idMaps.byKey.get(`entities:${canonicalJson(choice.target_id).trim()}`);
    if (!target || target.excluded) refuse('Reviewed relation endpoint target does not resolve to a non-excluded entity.', { source_table: item.source_table, source_row_sha256: item.source_row_sha256, field: item.field, target_id: choice.target_id });
  }
}
function markDependentExclusions(tables, idMaps, excludedRows) {
  const refs = { observations: [['entity_id', 'entities'], ['linked_observation_id', 'observations'], ['superseded_by', 'observations'], ['supersedes', 'observations']], observation_versions: [['observation_id', 'observations']], images: [['entity_id', 'entities'], ['observation_id', 'observations']], consolidation_groups: [['entity_id', 'entities'], ['consolidated_observation_id', 'observations'], ['source_observation_ids', 'observations']], dormant_observations: [['observation_id', 'observations']], co_surfacing: [['obs_a_id', 'observations'], ['obs_b_id', 'observations']], daemon_proposals: [['from_obs_id', 'observations'], ['to_obs_id', 'observations'], ['from_entity_id', 'entities'], ['to_entity_id', 'entities']] };
  for (const [table, fields] of Object.entries(refs)) for (const row of tables[table] ?? []) {
    const rowKey = sourceKey(table, row); for (const [field, targetTable] of fields) { const value = row[field]; if (value === null || value === undefined) continue; const values = table === 'consolidation_groups' && field === 'source_observation_ids' ? (typeof value === 'string' ? (() => { try { return JSON.parse(value); } catch { return []; } })() : value) : [value]; if (!Array.isArray(values)) continue; if (values.some((item) => idMaps.byKey.get(`${targetTable}:${canonicalJson(item).trim()}`)?.excluded)) excludedRows.add(rowKey); }
  }
  for (const row of tables.relations ?? []) {
    const rowKey = sourceKey('relations', row); for (const [field, contextField] of [['from_entity', 'from_context'], ['to_entity', 'to_context']]) { const value = row[field]; if (value === null || value === undefined) continue; const mapped = idMaps.nameMap.get(`${row[contextField] ?? 'default'}:${String(value)}`) ?? idMaps.nameMap.get(String(value)); if (mapped && idMaps.byKey.get(`entities:${canonicalJson(mapped.target_id).trim()}`)?.excluded) excludedRows.add(rowKey); }
  }
}
function collectCoverage(tables, mappings) { return Object.fromEntries(mappings.map((mapping) => [mapping.source_table, { source_rows: (tables[mapping.source_table] ?? []).length, mapped_rows: 0, excluded_rows: 0, losses: 0, target_tables: mapping.target_tables }])); }
function sortedEntries(value) { return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))); }
function sourceKey(table, row) { return `${table}:${canonicalSha256(row)}`; }

export function compilePolicy({ bundle, decisions, migrationId, bundleManifestSha256 } = {}) {
  if (!bundle || !decisions) throw new TypeError('compilePolicy requires verified bundle data and decisions.');
  const actualHash = bundleHash(bundle); if (bundleManifestSha256 !== undefined && bundleManifestSha256 !== actualHash) refuse('The supplied bundle hash does not match the verified bundle.');
  validatePolicyInput(bundle, decisions);
  const tables = rowsOf(bundle); const mappingInfo = activeMappings(tables, bundle); const mappings = mappingInfo.selected;
  const items = generateDecisionItems(bundle); const excludedRows = new Set(); const semanticChoices = {};
  for (const item of items) {
    const choice = choiceForItem(decisions, item); const action = choiceAction(choice); const rowKey = `${item.source_table}:${item.source_row_sha256}`;
    if (item.type === 'tension-state' || item.type === 'dormancy-translation') semanticChoices[rowKey] = choice;
    if (action === 'exclude-row') excludedRows.add(rowKey);
  }
  const idMaps = buildIdMaps(tables, decisions);
  validateReviewedLinks(items, decisions, tables, idMaps);
  markDependentExclusions(tables, idMaps, excludedRows);
  const ignoredRows = new Set(excludedRows);
  for (const entry of idMaps.entries) if (entry.excluded || entry.merged) ignoredRows.add(sourceKey(entry.source_table, tables[entry.source_table]?.find((row, index) => String(row.id ?? row.key ?? index) === String(entry.source_id)) ?? { id: entry.source_id }));
  const valueMaps = buildValueMaps({ tables, policy: decisions, skipRows: ignoredRows });
  if (valueMaps.losses.some((loss) => String(loss.kind).startsWith('unresolved-'))) refuse('Reviewed policy choices did not resolve every semantic value.', { unresolved: valueMaps.losses.map(({ source_table, source_row_sha256, field, kind }) => ({ source_table, source_row_sha256, field, kind })) });
  const losses = [...valueMaps.losses]; const audit = []; const coverage = collectCoverage(tables, mappings); const linkMap = {}; const versionNumbers = {};
  for (const item of items) {
    const choice = choiceForItem(decisions, item); const action = choiceAction(choice); const rowKey = `${item.source_table}:${item.source_row_sha256}`;
    if (['broken-foreign-key', 'broken-name-reference', 'ambiguous-name-reference'].includes(item.type)) {
      const selected = choice?.action === 'link-by-reviewed-id' ? choice.target_id : action === 'null-if-allowed' ? null : undefined;
      if (selected !== undefined) linkMap[`${rowKey}:${item.field}`] = selected;
    }
  }
  const versions = (tables.observation_versions ?? []).filter((row) => !ignoredRows.has(sourceKey('observation_versions', row))).map((row, index) => ({ row, hash: canonicalSha256(row), observationId: idMaps.byKey.get(`observations:${canonicalJson(row.observation_id).trim()}`)?.target_id ?? row.observation_id, changedAt: Object.hasOwn(valueMaps.timestamps, `observation_versions:${canonicalSha256(row)}:changed_at`) ? valueMaps.timestamps[`observation_versions:${canonicalSha256(row)}:changed_at`] : row.changed_at ?? null, id: row.id ?? index })).sort((a, b) => compareIdentifiers(a.observationId, b.observationId) || compareInstants(a.changedAt, b.changedAt) || compareIdentifiers(a.id, b.id));
  let previousObservation = null; let version = 0; for (const entry of versions) { if (String(entry.observationId) !== String(previousObservation)) { previousObservation = entry.observationId; version = 0; } version += 1; versionNumbers[entry.hash] = version; }
  for (const mapping of mappings) {
    const rows = tables[mapping.source_table] ?? [];
    for (const row of rows) {
      const rowHash = canonicalSha256(row); const rowKey = `${mapping.source_table}:${rowHash}`; const idEntry = idMaps.byKey.get(`${mapping.source_table}:${canonicalJson(row.id ?? row.key ?? rows.indexOf(row)).trim()}`);
      if (excludedRows.has(rowKey)) { coverage[mapping.source_table].excluded_rows += 1; losses.push({ kind: 'excluded-row', source_table: mapping.source_table, source_row_sha256: rowHash, rationale: 'explicit reviewed policy choice excluded this row' }); continue; }
      if (idEntry?.excluded || idEntry?.merged) { coverage[mapping.source_table].excluded_rows += 1; losses.push({ kind: idEntry.excluded ? 'excluded-row' : 'merged-source-row', source_table: mapping.source_table, source_row_sha256: rowHash, target_id: idEntry.target_id, rationale: idEntry.excluded ? 'reviewed exclusion' : 'source row represented by reviewed merge survivor' }); continue; }
      coverage[mapping.source_table].mapped_rows += 1;
      for (const dropped of mapping.dropped_fields ?? []) if (row[dropped.field] !== null && row[dropped.field] !== undefined) losses.push({ kind: 'dropped-field', source_table: mapping.source_table, source_row_sha256: rowHash, field: dropped.field, rationale: dropped.rationale });
      // v3.2 lets these entity columns be NULL; v4's own routing trigger fills them in (it is not something
      // this migrator chooses). The target therefore holds a value the source did not, and the audit says so.
      // (a reviewed merge may give the survivor another source row's value for a field; that value is what counts)
      if (mapping.source_table === 'entities') {
        const effective = (field) => (idEntry?.field_values !== undefined && Object.hasOwn(idEntry.field_values, field) ? idEntry.field_values[field] : row[field]);
        for (const [field, substitute] of V4_ENTITY_NULL_SUBSTITUTES) if (effective(field) === null || effective(field) === undefined) losses.push({ kind: 'null-replaced-by-v4-default', source_table: 'entities', source_row_sha256: rowHash, field, rationale: `The source row has no ${field} (NULL). v4's entity routing trigger stores ${substitute} in people/nodes, so the target holds a value the source did not.` });
      }
      if (mapping.source_table === 'embeddings' && row.embedding !== null && row.embedding !== undefined) losses.push({ kind: 'legacy-vector-inventory-only', source_table: mapping.source_table, source_row_sha256: rowHash, field: 'embedding', rationale: 'legacy vectors are inventory-only and are never copied' });
      audit.push({ source_table: mapping.source_table, source_row_sha256: rowHash, target_tables: mapping.target_tables, status: 'mapped' });
    }
  }
  if (losses.some((loss) => !loss.source_row_sha256)) refuse('Every loss entry must cite a source row hash.');
  losses.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))); audit.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  for (const [table, value] of Object.entries(coverage)) value.losses = losses.filter((loss) => loss.source_table === table).length;
  const plan = { format_version: FORMAT_VERSION, plan_type: 'deterministic-v3-to-v4-policy', migration_id: migrationId ?? bundle.migration_id, source_family: mappingInfo.family ?? 'inferred', bundle_manifest_sha256: actualHash, decision_manifest_sha256: decisions.manifest_sha256, choice_statements: summarizeStatements(decisions), id_map: sortedEntries(Object.fromEntries(Object.entries(idMaps.idMap).sort(([a], [b]) => a.localeCompare(b)))), name_map: idMaps.serializedNames, merge_audit: idMaps.mergeAudit, value_map: valueMaps, link_map: sortedEntries(linkMap), excluded_rows: [...excludedRows].sort(), version_numbers: sortedEntries(versionNumbers), semantic_choices: sortedEntries(semanticChoices), losses, audit, coverage, mapping_tables: mappings.map((mapping) => mapping.source_table) };
  plan.plan_sha256 = canonicalSha256(plan); return plan;
}
export const compile = compilePolicy;
export const compileDeterministicPolicy = compilePolicy;
