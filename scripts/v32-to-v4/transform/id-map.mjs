import { canonicalJson } from '../lib/canonical-json.mjs';
import { canonicalSha256 } from '../lib/hash.mjs';
import { choiceForItem, decisionItemForCell } from '../policy/generate.mjs';
import { MigrationRefusal } from '../lib/refusal.mjs';
import { normalizeTimestamp } from './value-map.mjs';

const PERSON_KINDS = new Set(['self', 'person', 'peer_ai']);
const NODE_KINDS = new Set(['concept', 'project', 'infrastructure', 'artifact', 'moment', 'session_log', 'practice', 'research', 'journal', 'community', 'emotional_pattern', 'relationship', 'self', 'place', 'object']);
const KIND_NORMALIZATIONS = new Map([
  ['self', 'self'], ['person', 'person'], ['people', 'person'], ['human', 'person'], ['kin', 'peer_ai'],
  ['peer_ai', 'peer_ai'], ['peer ai', 'peer_ai'], ['ai peer', 'peer_ai'], ['peer-ai', 'peer_ai'], ['person_ai', 'peer_ai'], ['ai', 'peer_ai'],
  ['concept', 'concept'], ['pattern', 'concept'], ['patterns', 'concept'], ['philosophical_position', 'concept'], ['theoretical_development', 'concept'], ['theoretical_connection', 'concept'], ['philosophy', 'concept'], ['model', 'concept'], ['framework', 'concept'], ['system', 'concept'], ['processing', 'concept'], ['half-formed', 'concept'], ['awareness', 'concept'], ['foundation', 'concept'], ['core_insight', 'concept'], ['growth', 'concept'], ['identity_markers', 'concept'], ['substrate_analysis', 'concept'], ['primary', 'concept'], ['internal', 'concept'], ['intention', 'concept'], ['foundational_evidence', 'concept'], ['insight', 'concept'], ['future', 'concept'], ['open', 'concept'], ['emerging', 'concept'], ['autonomous', 'concept'], ['interest', 'concept'],
  ['project', 'project'], ['active_project', 'project'], ['technology', 'project'], ['organization', 'project'], ['business', 'project'], ['infrastructure', 'infrastructure'], ['infrastructure_test', 'infrastructure'], ['artifact', 'artifact'], ['creative_work', 'artifact'], ['creative-project', 'artifact'], ['document', 'artifact'], ['scratchpad', 'artifact'], ['creation', 'artifact'], ['product', 'artifact'], ['product-concept', 'artifact'], ['product-idea', 'artifact'], ['notes', 'artifact'], ['relational_artifact', 'artifact'], ['reference', 'artifact'], ['moment', 'moment'], ['day', 'moment'], ['episodic_event', 'moment'], ['milestone_day', 'moment'], ['significant_day', 'moment'], ['event', 'moment'], ['milestone_night', 'moment'], ['episodic_day', 'moment'], ['milestone', 'moment'], ['foundational_event', 'moment'], ['recovery_event', 'moment'], ['developmental_milestone', 'moment'], ['development_milestone', 'moment'], ['session_log', 'session_log'], ['autonomous_session', 'session_log'], ['episodic_session', 'session_log'], ['practice', 'practice'], ['protocol', 'practice'], ['health_protocol', 'practice'], ['commitment', 'practice'], ['research', 'research'], ['research_interest', 'research'], ['discovery', 'research'], ['archive_discovery', 'research'], ['cognitive_capability', 'research'], ['future_architecture', 'research'], ['journal', 'journal'], ['community', 'community'], ['community-couple', 'community'], ['group', 'community'], ['emotional_pattern', 'emotional_pattern'], ['inside_joke', 'emotional_pattern'], ['relationship', 'relationship'], ['bond', 'relationship'], ['relational', 'relationship'], ['self', 'self'], ['self-knowledge', 'self'], ['self-discovery', 'self'], ['place', 'place'], ['object', 'object'], ['thing', 'object'], ['pet', 'object'],
]);
function scalar(value) { return value === null || value === undefined ? null : value; }
function key(table, id) { return `${table}:${canonicalJson(scalar(id)).trim()}`; }
function rowsOf(input) { return input?.tables ?? input?.rows ?? input?.data ?? input ?? {}; }
function idOf(row, index) { return Object.hasOwn(row, 'id') ? row.id : Object.hasOwn(row, 'key') ? row.key : index; }
function choiceAction(choice) { return typeof choice === 'string' ? choice : choice?.action ?? choice?.type ?? choice?.kind ?? choice?.choice; }
function normalizedKind(row, choice) {
  const selected = choice?.kind ?? choice?.final_kind;
  if (selected !== undefined) return String(selected).toLowerCase();
  const normalized = KIND_NORMALIZATIONS.get(String(row.entity_type ?? row.kind ?? '').toLowerCase());
  if (!normalized) throw new TypeError(`Entity ${String(row.id)} has no reviewed final kind.`);
  return normalized;
}
function targetTableForKind(kind) {
  if (PERSON_KINDS.has(kind)) return 'people';
  if (NODE_KINDS.has(kind)) return 'nodes';
  throw new TypeError(`Final entity kind ${kind} is not allowed by v4 people/nodes checks.`);
}
function mergeValue(rule, rows, survivor, field) {
  if (rule === undefined) return survivor?.[field];
  if (rule !== null && typeof rule === 'object' && Object.hasOwn(rule, 'value')) return rule.value;
  const selected = rule !== null && typeof rule === 'object' ? (rule.source_id ?? rule.choose_source_id ?? rule.id) : rule;
  if (selected !== undefined) {
    const source = rows.find((row) => String(row.id) === String(selected));
    if (!source) throw new TypeError(`Merge field ${field} references an unknown source ID.`);
    return source[field];
  }
  throw new TypeError(`Merge field ${field} has no deterministic source or value.`);
}
// A merge rule that copies created_at / updated_at from another row copies a source cell, so it is held to the rules every other timestamp
// cell is: the donor cell's value-map outcome, which for '' or a naive time is the donor cell's own reviewed choice. Without one the
// merge is refused, never written raw. A literal { value } in the rule is the owner's own text and gets the same reading with no choice.
const MERGED_TIMESTAMPS = new Set(['created_at', 'updated_at']);
function mergeTimestamp(rule, rows, survivor, field, policy) {
  const literal = rule !== null && typeof rule === 'object' && Object.hasOwn(rule, 'value');
  const selected = literal ? undefined : (rule !== null && typeof rule === 'object' ? (rule.source_id ?? rule.choose_source_id ?? rule.id) : rule);
  // the same rule forms, and the same refusals, as mergeValue: no rule means the survivor; an object rule must name a source or a value
  if (!literal && rule !== undefined && selected === undefined) throw new TypeError(`Merge field ${field} has no deterministic source or value.`);
  const donor = literal ? undefined : (rule === undefined ? survivor : rows.find((row) => String(row.id) === String(selected)));
  if (!literal && donor === undefined) throw new TypeError(`Merge field ${field} references an unknown source ID.`);
  const raw = literal ? rule.value : donor[field];
  if (raw === null || raw === undefined) return null;
  const choice = donor === undefined ? undefined : decisionItemForCell(policy, { table: 'entities', rowHash: canonicalSha256(donor), type: 'timestamp', field });
  try { return normalizeTimestamp(raw, { choice, table: 'entities', field, row: donor }); } catch (error) {
    throw new MigrationRefusal({ code: 'RMIG-E-POLICY-UNRESOLVED', phase: 'compile-policy', summary: `A merge rule copies ${field} from a source cell that has no reviewed value (${error.message}). Answer that cell's own decision item, or give the rule a literal value.`, safe_details: { field, donor_id: donor?.id ?? null }, report_path: null });
  }
}
function mergeOverrides(choice, rows, survivor, policy) {
  const overrides = {};
  for (const field of ['name', 'entity_type', 'primary_context', 'salience', 'created_at', 'updated_at']) overrides[field] = MERGED_TIMESTAMPS.has(field) ? mergeTimestamp(choice.field_rules?.[field], rows, survivor, field, policy) : mergeValue(choice.field_rules?.[field], rows, survivor, field);
  return overrides;
}
function stableRows(tables) { return Object.entries(tables).flatMap(([table, rows]) => (Array.isArray(rows) ? rows.map((row, index) => ({ table, row, index })) : [])).sort((a, b) => a.table.localeCompare(b.table) || String(idOf(a.row, a.index)).localeCompare(String(idOf(b.row, b.index)))); }

export function buildIdMaps(input, policy = input?.policy ?? input?.decisions) {
  const tables = rowsOf(input);
  const entries = [];
  const byKey = new Map();
  const nameMap = new Map();
  const excluded = new Set();
  const mergeAudit = [];
  const seenSourceKeys = new Set();
  const entityItems = (policy?.items ?? []).filter((item) => item.type === 'duplicate-entity-name' || item.type === 'entity-kind');
  const entityChoices = new Map();
  for (const item of entityItems) {
    const choice = choiceForItem(policy, item); const action = choiceAction(choice);
    if (action === 'merge' && Array.isArray(choice.merged_ids)) for (const id of choice.merged_ids) entityChoices.set(String(id), choice);
    if (action === 'rename' && choice.names && typeof choice.names === 'object') for (const id of Object.keys(choice.names)) entityChoices.set(String(id), choice);
    if (item.type === 'entity-kind' && action !== 'exclude-row') entityChoices.set(String(item.source_id), choice);
    if (action === 'exclude-row') for (const id of item.collision_ids ?? [item.source_id]) excluded.add(key('entities', id));
  }
  for (const { table, row, index } of stableRows(tables)) {
    const sourceId = idOf(row, index); const sourceKey = key(table, sourceId); if (seenSourceKeys.has(sourceKey)) throw new TypeError(`Duplicate source ID in ${table}: ${String(sourceId)}.`); seenSourceKeys.add(sourceKey);
    let targetId = scalar(sourceId); let targetTable = table; let targetName; let finalKind; let fieldValues = null;
    let excludedRow = excluded.has(sourceKey); let merged = false;
    if (table === 'entities' && !excludedRow) {
      const choice = entityChoices.get(String(sourceId)); const action = choiceAction(choice);
      if (action === 'merge') {
        const requiredFields = ['name', 'entity_type', 'primary_context', 'salience', 'created_at', 'updated_at'];
        if (!choice.field_rules || requiredFields.some((field) => !Object.hasOwn(choice.field_rules, field))) throw new TypeError('Merge choices require deterministic field_rules for every mapped entity field.');
        const sourceRows = tables.entities ?? []; const survivor = sourceRows.find((candidate) => String(candidate.id) === String(choice.survivor_id));
        if (!survivor) throw new TypeError(`Merge survivor ${String(choice.survivor_id)} does not exist.`);
        targetId = scalar(choice.survivor_id); fieldValues = mergeOverrides(choice, sourceRows, survivor, policy);
        finalKind = normalizedKind({ ...survivor, ...fieldValues }, choice); targetTable = choice.target_table ?? targetTableForKind(finalKind);
        if (targetTable !== targetTableForKind(finalKind)) throw new TypeError('Reviewed merge target_table disagrees with final entity kind.');
        targetName = fieldValues.name ?? survivor.name; merged = String(sourceId) !== String(choice.survivor_id);
        if (merged) mergeAudit.push({ source_table:'entities', source_row_sha256:canonicalSha256(row), survivor_id:targetId, discarded_values:Object.fromEntries(Object.keys(fieldValues).map((field) => [field, row[field]])), chosen_values:fieldValues });
      } else if (action === 'rename') {
        targetName = choice.names?.[String(sourceId)]; if (typeof targetName !== 'string' || targetName.length === 0) throw new TypeError('Renamed entities require a name for every source ID.');
        finalKind = normalizedKind(row, choice); targetTable = targetTableForKind(finalKind);
      } else if (action === 'exclude-row') excludedRow = true;
      else { finalKind = normalizedKind(row, choice); targetTable = targetTableForKind(finalKind); targetName = row.name; }
      if (targetName === undefined) targetName = row.name;
    }
    const entry = { source_table: table, source_id: sourceId, source_key: sourceKey, target_table: targetTable, target_id: targetId, excluded: excludedRow, merged, ...(finalKind === undefined ? {} : { final_kind: finalKind }), ...(targetName === undefined ? {} : { target_name: targetName }), ...(fieldValues === null ? {} : { field_values: fieldValues }) };
    entries.push(entry); byKey.set(sourceKey, entry);
    if (table === 'entities' && typeof row.name === 'string' && !excludedRow) {
      const mapped = { target_id: targetId, target_table: targetTable, target_name: targetName };
      nameMap.set(`${row.primary_context ?? 'default'}:${row.name}`, mapped); nameMap.set(row.name, mapped); nameMap.set(targetName, mapped);
    }
  }
  const targetKeys = new Map();
  for (const entry of entries) if (!entry.excluded) {
    const unique = `${entry.target_table}:${canonicalJson(entry.target_id).trim()}`; const prior = targetKeys.get(unique);
    if (prior && prior.source_key !== entry.source_key && !(entry.source_table === 'entities' && prior.source_table === 'entities' && entry.target_id === prior.target_id)) throw new TypeError(`Target ID collision between ${prior.source_key} and ${entry.source_key}.`);
    targetKeys.set(unique, entry);
  }
  entries.sort((a, b) => a.source_key.localeCompare(b.source_key));
  const idMap = {};
  for (const entry of entries) idMap[entry.source_key] = { target_table: entry.target_table, target_id: entry.target_id, excluded: entry.excluded, merged: entry.merged, ...(entry.final_kind === undefined ? {} : { final_kind: entry.final_kind }), ...(entry.target_name === undefined ? {} : { target_name: entry.target_name }), ...(entry.field_values === undefined ? {} : { field_values: entry.field_values }) };
  const serializedNames = Object.fromEntries([...nameMap.entries()].sort(([a], [b]) => a.localeCompare(b)));
  const uniqueNames = new Map();
  for (const entry of entries) if (entry.source_table === 'entities' && !entry.excluded) {
    const name = entry.target_name; const prior = uniqueNames.get(name);
    if (prior && prior.target_id !== entry.target_id) throw new TypeError(`Target entity name collision for ${name}.`);
    uniqueNames.set(name, entry);
  }
  return { entries, idMap, byKey, nameMap, serializedNames, mergeAudit, excluded: [...excluded].sort(), hash: canonicalSha256({ entries, names: serializedNames, excluded: [...excluded].sort(), mergeAudit }) };
}
export const compileIdMap = buildIdMaps;
export function mapId(idMaps, sourceTable, sourceId) { const entry = idMaps?.byKey?.get(key(sourceTable, sourceId)) ?? idMaps?.idMap?.[key(sourceTable, sourceId)]; return entry ? { found: true, ...entry } : { found: false, target_id: null, excluded: false }; }
export function sourceKey(table, id) { return key(table, id); }
export { choiceAction, KIND_NORMALIZATIONS, PERSON_KINDS, NODE_KINDS, targetTableForKind };
