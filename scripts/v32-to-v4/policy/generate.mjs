import { readFileSync } from 'node:fs';
import { canonicalJson } from '../lib/canonical-json.mjs';
import { canonicalSha256, sha256Hex } from '../lib/hash.mjs';
import { FORMAT_VERSION } from '../lib/contracts.mjs';
import { MigrationRefusal } from '../lib/refusal.mjs';
import { verifyBundle, readBundleMember } from '../lib/bundle.mjs';
import { jsonSurvivesParsing } from '../lib/lossless-json.mjs';
import { parseInstantMicros } from '../lib/instant.mjs';
import { OBS_CONTEXTS, targetColumnAllowsNull } from '../transform/target-schema.mjs';

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3,})?(?:Z|[+-]\d{2}:\d{2})$/u;
const SQLITE_UTC = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const KNOWN_KINDS = new Set(['self', 'person', 'peer_ai', 'concept', 'project', 'infrastructure', 'artifact', 'moment', 'session_log', 'practice', 'research', 'journal', 'community', 'emotional_pattern', 'relationship', 'place', 'object', 'person_ai', 'ai', 'human', 'thing', 'organization', 'group', 'kin', 'people', 'peer ai', 'ai peer', 'peer-ai']);
// This is the single source-family-independent normalization/routing vocabulary.
// Its outputs are the exact v4 people/nodes CHECK vocabularies.
const KIND_NORMALIZATIONS = new Map([
  ['self', 'self'], ['person', 'person'], ['people', 'person'], ['human', 'person'], ['kin', 'peer_ai'],
  ['peer_ai', 'peer_ai'], ['peer ai', 'peer_ai'], ['ai peer', 'peer_ai'], ['peer-ai', 'peer_ai'], ['peer_ai', 'peer_ai'],
  ['person_ai', 'peer_ai'], ['ai', 'peer_ai'],
  ['concept', 'concept'], ['pattern', 'concept'], ['patterns', 'concept'], ['philosophical_position', 'concept'], ['theoretical_development', 'concept'], ['theoretical_connection', 'concept'], ['philosophy', 'concept'], ['model', 'concept'], ['framework', 'concept'], ['system', 'concept'], ['processing', 'concept'], ['half-formed', 'concept'], ['awareness', 'concept'], ['foundation', 'concept'], ['core_insight', 'concept'], ['growth', 'concept'], ['identity_markers', 'concept'], ['substrate_analysis', 'concept'], ['primary', 'concept'], ['internal', 'concept'], ['intention', 'concept'], ['foundational_evidence', 'concept'], ['insight', 'concept'], ['future', 'concept'], ['open', 'concept'], ['emerging', 'concept'], ['autonomous', 'concept'], ['interest', 'concept'],
  ['project', 'project'], ['active_project', 'project'], ['technology', 'project'], ['organization', 'project'], ['business', 'project'], ['infrastructure', 'infrastructure'], ['infrastructure_test', 'infrastructure'], ['artifact', 'artifact'], ['creative_work', 'artifact'], ['creative-project', 'artifact'], ['document', 'artifact'], ['scratchpad', 'artifact'], ['creation', 'artifact'], ['product', 'artifact'], ['product-concept', 'artifact'], ['product-idea', 'artifact'], ['notes', 'artifact'], ['relational_artifact', 'artifact'], ['reference', 'artifact'], ['moment', 'moment'], ['day', 'moment'], ['episodic_event', 'moment'], ['milestone_day', 'moment'], ['significant_day', 'moment'], ['event', 'moment'], ['milestone_night', 'moment'], ['episodic_day', 'moment'], ['milestone', 'moment'], ['foundational_event', 'moment'], ['recovery_event', 'moment'], ['developmental_milestone', 'moment'], ['development_milestone', 'moment'], ['session_log', 'session_log'], ['autonomous_session', 'session_log'], ['episodic_session', 'session_log'], ['practice', 'practice'], ['protocol', 'practice'], ['health_protocol', 'practice'], ['commitment', 'practice'], ['research', 'research'], ['research_interest', 'research'], ['discovery', 'research'], ['archive_discovery', 'research'], ['cognitive_capability', 'research'], ['future_architecture', 'research'], ['journal', 'journal'], ['community', 'community'], ['community-couple', 'community'], ['group', 'community'], ['emotional_pattern', 'emotional_pattern'], ['inside_joke', 'emotional_pattern'], ['relationship', 'relationship'], ['bond', 'relationship'], ['relational', 'relationship'], ['self', 'self'], ['self-knowledge', 'self'], ['self-discovery', 'self'], ['place', 'place'], ['object', 'object'], ['thing', 'object'], ['pet', 'object'],
]);
const PERSON_KINDS = new Set(['self', 'person', 'peer_ai']);
const NODE_KINDS = new Set(['concept', 'project', 'infrastructure', 'artifact', 'moment', 'session_log', 'practice', 'research', 'journal', 'community', 'emotional_pattern', 'relationship', 'self', 'place', 'object']);
export const KNOWN_CONTEXTS = new Set(['default', 'primary', 'private', 'public', 'personal', 'relationship', 'work', 'inner', 'dream', 'archive', 'archived', 'system', 'global', 'emotional-processing', 'interests-curiosities', 'creative-space', 'relational-models', 'episodic', 'values-ethics', 'research']);
// observations.context is the one context column with a v4 CHECK (eight values, migrations/postgres/0009); every other context
// column (primary_context, scope, relations, threads, tensions, images, notes) is plain TEXT. "Known" and "allowed as a mapping
// target" are the same set for a column, so the generator, the value map, validate and the review all ask this one function.
export function contextVocabulary(table, field) { return table === 'observations' && field === 'context' ? OBS_CONTEXTS : KNOWN_CONTEXTS; }
const KNOWN_STATUSES = new Set(['pending', 'open', 'active', 'resolved', 'closed', 'accepted', 'rejected', 'dismissed', 'deferred', 'cancelled', 'canceled']);
const TARGET_ENUM_ALIASES = new Map([
  ['observations.weight', new Set(['light', 'medium', 'heavy', 'low', 'high'])],
  ['observations.certainty', new Set(['believed', 'known', 'tentative', 'certain', 'uncertain', 'speculative'])],
  ['observations.charge', new Set(['fresh', 'active', 'processing', 'metabolized', 'dormant', 'archived'])],
  ['observations.salience', new Set(['active', 'high', 'background', 'foundational', 'medium', 'heavy'])],
  ['observations.source', new Set(['conversation', 'realization', 'external', 'consolidated', 'inferred', 'journal'])],
  ['threads.thread_type', new Set(['intention', 'task', 'handoff', 'explore', 'idea', 'project', 'creative', 'relational', 'urgent-task', 'build', 'maintenance', 'pickup', 'deadline', 'morning_handoff', 'morning-handoff', 'question', 'research', 'project_seed', 'work', 'infrastructure', 'anniversary', 'personal'])],
  ['threads.status', new Set(['active', 'resolved', 'pending', 'open', 'closed'])],
  ['threads.priority', new Set(['low', 'medium', 'high', 'urgent', 'critical', 'normal'])],
  ['relational_state.intensity', new Set(['whisper', 'present', 'strong', 'overwhelming', 'high'])],
]);
const JSON_SHAPES = new Map([
  ['links', 'array'], ['connections', 'array'], ['tags', 'array'], ['source_observation_ids', 'integer-array'],
  ['data', 'object'], ['sit_notes', 'array-or-object'],
]);
// Every v3.2 column that holds a point in time. This is the single list: the decision draft uses it to
// find ambiguous values and the value map uses it to normalize them, and a test checks it against both
// exact source specs, so a column cannot be listed in one place and missed in the other.
export const TIMESTAMP_FIELDS = new Set(['entities.created_at','entities.updated_at','observations.added_at','observations.last_surfaced_at','observations.archived_at','observations.last_accessed_at','observations.resolved_at','observations.valid_from','observations.valid_until','observation_versions.changed_at','relations.created_at','threads.created_at','threads.updated_at','threads.resolved_at','context_entries.updated_at','relational_state.timestamp','identity.timestamp','journals.created_at','consolidation_groups.created_at','images.created_at','images.last_accessed_at','images.last_surfaced_at','images.archived_at','subconscious.updated_at','daemon_proposals.proposed_at','daemon_proposals.resolved_at','tensions.created_at','tensions.resolved_at','dormant_observations.first_marked','dormant_observations.last_rescue_attempt','co_surfacing.last_co_surfaced']);
export const DATE_FIELDS = new Set(['observations.source_date']);
const FK_FIELDS = new Map([
  ['observations', new Map([['entity_id', 'entities'], ['linked_observation_id', 'observations'], ['superseded_by', 'observations'], ['supersedes', 'observations']])],
  ['observation_versions', new Map([['observation_id', 'observations']])],
  ['images', new Map([['entity_id', 'entities'], ['observation_id', 'observations']])],
  ['consolidation_groups', new Map([['entity_id', 'entities'], ['consolidated_observation_id', 'observations']])],
  ['dormant_observations', new Map([['observation_id', 'observations']])],
  ['co_surfacing', new Map([['obs_a_id', 'observations'], ['obs_b_id', 'observations']])],
  ['daemon_proposals', new Map([['from_obs_id', 'observations'], ['to_obs_id', 'observations'], ['from_entity_id', 'entities'], ['to_entity_id', 'entities']])],
]);

function fail(summary, details = {}) {
  throw new MigrationRefusal({ code: 'RMIG-E-POLICY-UNRESOLVED', phase: 'compile-policy', summary, safe_details: details, report_path: null });
}
function rowsFor(bundle) {
  if (!bundle || typeof bundle !== 'object') throw new TypeError('Policy input must be a bundle object.');
  const source = bundle.tables ?? bundle.rows ?? bundle.data ?? {};
  if (Array.isArray(source)) {
    const out = Object.create(null);
    for (const entry of source) {
      if (!entry || typeof entry.table !== 'string' || !Array.isArray(entry.rows)) continue;
      out[entry.table] = entry.rows;
    }
    return out;
  }
  const out = Object.create(null);
  for (const [table, rows] of Object.entries(source)) if (Array.isArray(rows)) out[table] = rows;
  return out;
}
function sourceId(table, row, index) {
  if (row && Object.hasOwn(row, 'id')) return row.id;
  if (row && Object.hasOwn(row, 'key')) return row.key;
  return index;
}
function safeId(value) {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' || typeof value === 'number' ? value : canonicalJson(value).trim();
}
// A decision is one question about one cell: the identity is the kind of question, the row, and the column.
// Two broken references on one row are two decisions, and a reviewer's answer to one never answers the other.
function itemId(type, table, id, rowHash, field) {
  return sha256Hex(canonicalJson({ type, source_table: table, source_id: safeId(id), source_row_sha256: rowHash, field: field ?? null }).trim());
}
function makeItem(type, table, row, index, reason, allowedChoices, extra = {}) {
  const rowHash = canonicalSha256(row);
  return {
    decision_id: itemId(type, table, sourceId(table, row, index), rowHash, extra.field),
    type,
    source_table: table,
    source_id: safeId(sourceId(table, row, index)),
    source_row_sha256: rowHash,
    reason,
    allowed_choices: [...allowedChoices],
    ...extra,
  };
}
function add(items, seen, item) {
  if (!seen.has(item.decision_id)) { seen.add(item.decision_id); items.push(item); }
}
// An empty string in a timestamp or date column is not NULL and is not a time. Nothing in the source says what it meant, so the
// owner chooses: leave the row out, store NULL (only where the v4 column can hold it), or give the instant / date it stands for.
const EMPTY_TIMESTAMP = 'timestamp is empty text, not NULL; the owner must choose';
const EMPTY_DATE = 'date is empty text, not NULL; the owner must choose';
const NAIVE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/u;
const INVALID_TIMESTAMP = 'timestamp is invalid';
function timestampAmbiguity(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return 'timestamp is not text';
  // A value in a supported form must be a real calendar instant (2026-02-30 and T24:00:00 are not); the
  // exact reader says so, and no reviewed timezone can repair one.
  if (ISO_WITH_OFFSET.test(value) || SQLITE_UTC.test(value)) { try { parseInstantMicros(value, { naiveOffset: 'UTC' }); return null; } catch { return INVALID_TIMESTAMP; } }
  if (NAIVE_TIMESTAMP.test(value)) { try { parseInstantMicros(value, { naiveOffset: 'UTC' }); } catch { return INVALID_TIMESTAMP; } return 'timestamp is naive and has no timezone offset'; }
  if (/^\d{1,13}$/u.test(value) || typeof value === 'number') return 'epoch-like timestamp requires an explicit unit and timezone';
  if (!/[T ]/u.test(value)) return 'timestamp is not a supported timestamp form';
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/u.test(value)) return 'timestamp is naive and has no timezone offset';
  return INVALID_TIMESTAMP;
}
export { INVALID_TIMESTAMP, EMPTY_TIMESTAMP, EMPTY_DATE };
/** The choices offered for an empty timestamp or date cell: always exclude-row and a reviewed value; set-null only where v4 can hold NULL there. */
export function emptyCellChoices(table, field, row, replacement) {
  return targetColumnAllowsNull(table, field, row) ? [replacement, 'set-null', 'exclude-row'] : [replacement, 'exclude-row'];
}
function dateAmbiguity(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value)) { const date = new Date(`${value}T00:00:00.000Z`); if (!Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value) return null; }
  return 'date is not a valid ISO date and requires an explicit reviewed replacement';
}
function shapeOk(value, shape) {
  let parsed = value;
  if (typeof value === 'string') { try { parsed = JSON.parse(value); } catch { return false; } if (!jsonSurvivesParsing(value)) return false; }
  if (shape === 'array') return Array.isArray(parsed);
  if (shape === 'integer-array') return Array.isArray(parsed) && parsed.every((item) => Number.isSafeInteger(typeof item === 'number' ? item : Number(item)));
  if (shape === 'object') return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
  return Array.isArray(parsed) || (parsed !== null && typeof parsed === 'object');
}
function itemForUnknown(table, row, index, field, value, reason, choices = ['map', 'exclude-row']) {
  return makeItem('unknown-value', table, row, index, reason, choices, { field, observed_value_sha256: sha256Hex(String(value)) });
}

export function extractBundleRows(bundle) { return rowsFor(bundle); }
export function bundleHash(bundle) {
  if (typeof bundle?.bundle_manifest_sha256 === 'string') return bundle.bundle_manifest_sha256;
  if (typeof bundle?.manifest_sha256 === 'string') return bundle.manifest_sha256;
  if (typeof bundle?.manifest?.manifest_sha256 === 'string') return bundle.manifest.manifest_sha256;
  if (typeof bundle?.manifest?.envelope?.manifest_sha256 === 'string') return bundle.manifest.envelope.manifest_sha256;
  throw new TypeError('Policy input must include bundle_manifest_sha256.');
}

export function generateDecisionItems(bundle) {
  const tables = rowsFor(bundle);
  const items = [];
  const seen = new Set();
  const entityRows = tables.entities ?? [];
  const entityGroups = new Map();
  entityRows.forEach((row, index) => {
    const name = row.name;
    if (typeof name === 'string') {
      const group = entityGroups.get(name) ?? [];
      group.push({ row, index });
      entityGroups.set(name, group);
    }
    const rawKind = row.entity_type ?? row.kind;
    if (typeof rawKind === 'string' && !KIND_NORMALIZATIONS.has(rawKind.toLowerCase())) {
      add(items, seen, makeItem('entity-kind', 'entities', row, index, 'entity kind is not covered by the exhaustive v4 people/nodes normalization table', ['map-to-person', 'map-to-node', 'exclude-row'], { field: 'entity_type', observed_value_sha256: sha256Hex(rawKind), required_choice_fields: { 'map-to-person': ['kind'], 'map-to-node': ['kind'] } }));
    }
    for (const field of ['primary_context']) if (row[field] !== null && row[field] !== undefined && !KNOWN_CONTEXTS.has(String(row[field]).toLowerCase())) add(items, seen, itemForUnknown('entities', row, index, field, row[field], 'entity context is not a known deterministic context', ['map-context', 'exclude-row']));
  });
  for (const [name, group] of entityGroups) if (group.length > 1) {
    add(items, seen, makeItem('duplicate-entity-name', 'entities', group[0].row, group[0].index, 'entity name collides across source contexts and v4 requires a globally unambiguous legacy name', ['merge', 'rename', 'exclude-row'], {
      field: 'name',
      collision_ids: group.map(({ row }) => safeId(row.id)).sort((a, b) => String(a).localeCompare(String(b))),
      required_choice_fields: { merge: ['survivor_id', 'merged_ids', 'field_rules'], rename: ['names'] },
    }));
  }

  for (const [table, rows] of Object.entries(tables)) rows.forEach((row, index) => {
    for (const [field, value] of Object.entries(row)) {
      if (DATE_FIELDS.has(`${table}.${field}`) && value === '') {
        add(items, seen, makeItem('date', table, row, index, EMPTY_DATE, emptyCellChoices(table, field, row, 'normalize-date'), { field, observed_value_sha256: sha256Hex(''), required_choice_fields: { 'normalize-date': ['value'] } }));
      } else if (DATE_FIELDS.has(`${table}.${field}`) && value !== null && value !== undefined) {
        const reason = dateAmbiguity(value);
        if (reason) add(items, seen, makeItem('date', table, row, index, reason, ['normalize-date', 'exclude-row'], { field, observed_value_sha256: sha256Hex(String(value)), required_choice_fields: { 'normalize-date': ['value'] } }));
      }
      if (TIMESTAMP_FIELDS.has(`${table}.${field}`) && value === '') {
        add(items, seen, makeItem('timestamp', table, row, index, EMPTY_TIMESTAMP, emptyCellChoices(table, field, row, 'replace-timestamp'), { field, observed_value_sha256: sha256Hex(''), required_choice_fields: { 'replace-timestamp': ['value'] } }));
      } else if (TIMESTAMP_FIELDS.has(`${table}.${field}`) && value !== null && value !== undefined) {
        const reason = timestampAmbiguity(value);
        if (reason) add(items, seen, makeItem('timestamp', table, row, index, reason, reason === INVALID_TIMESTAMP ? ['exclude-row'] : ['normalize-utc', 'exclude-row'], { field, observed_value_sha256: sha256Hex(String(value)) }));
      }
      const shape = JSON_SHAPES.get(field);
      if (shape && value !== null && value !== undefined && !shapeOk(value, shape)) add(items, seen, makeItem('malformed-json', table, row, index, `JSON field does not match the expected ${shape} shape, or holds a number that JavaScript cannot carry exactly, or repeats an object key`, ['map-json', 'exclude-row'], { field, expected_shape: shape, observed_value_sha256: sha256Hex(String(value)) }));
      if ((field === 'context' || field === 'scope' || field === 'primary_context') && value !== null && value !== undefined && !contextVocabulary(table, field).has(String(value).toLowerCase())) add(items, seen, itemForUnknown(table, row, index, field, value, 'context/scope value is not a known deterministic value', ['map-context', 'exclude-row']));
      if (['status', 'salience', 'certainty', 'weight', 'charge', 'source', 'thread_type', 'priority', 'intensity'].includes(field) && value !== null && value !== undefined) {
        const allowed = TARGET_ENUM_ALIASES.get(`${table}.${field}`);
        const normalized = String(value).toLowerCase();
        if (allowed && !allowed.has(normalized)) add(items, seen, itemForUnknown(table, row, index, field, value, 'value is not a v4 CHECK value or deterministic migration alias', ['map', 'exclude-row']));
        else if (!allowed && field === 'status' && !KNOWN_STATUSES.has(normalized)) add(items, seen, itemForUnknown(table, row, index, field, value, 'status value is not a known deterministic value', ['map-status', 'exclude-row']));
      }
    }
    if (table === 'tensions' && (Object.hasOwn(row, 'status') || Object.hasOwn(row, 'sit_notes'))) {
      const needsLastVisited = Number(row.sit_count ?? 0) > 0;
      add(items, seen, makeItem('tension-state', table, row, index, 'source tension status/sit_notes are not v4 columns and must be explicitly mapped to visits/last_visited/resolved_at/resolution', ['preserve-visits-and-resolve', 'preserve-visits-and-open', 'exclude-row'], { required_choice_fields: { 'preserve-visits-and-resolve': ['resolved_at', ...(needsLastVisited ? ['last_visited'] : [])], 'preserve-visits-and-open': needsLastVisited ? ['last_visited'] : [] } }));
    }
    if (table === 'dormant_observations') add(items, seen, makeItem('dormancy-translation', table, row, index, 'dormant observation terminology must be explicitly translated to the v4 orphan-observation surface', ['translate-to-orphan', 'exclude-row'], { target_table: 'orphan_observations' }));
    const fks = FK_FIELDS.get(table);
    if (fks) for (const [field, target] of fks) if (row[field] !== null && row[field] !== undefined) {
      const ids = new Set((tables[target] ?? []).map((candidate) => String(candidate.id)));
      if (!ids.has(String(row[field]))) add(items, seen, makeItem('broken-foreign-key', table, row, index, 'foreign-key target does not exist in the verified source rows', ['null-if-allowed', 'exclude-row', 'link-by-reviewed-id'], { field, target_table: target, target_id: safeId(row[field]) }));
    }
    if (table === 'consolidation_groups' && row.source_observation_ids !== null && row.source_observation_ids !== undefined) {
      let ids; try { ids = typeof row.source_observation_ids === 'string' ? JSON.parse(row.source_observation_ids) : row.source_observation_ids; } catch { ids = null; }
      const known = new Set((tables.observations ?? []).map((candidate) => String(candidate.id)));
      if (Array.isArray(ids) && ids.some((id) => !known.has(String(id)))) add(items, seen, makeItem('broken-foreign-key', table, row, index, 'source observation array contains a missing observation', ['exclude-row'], { field: 'source_observation_ids', target_table: 'observations' }));
    }
    if (table === 'relations') for (const field of ['from_entity', 'to_entity']) if (row[field] !== null && row[field] !== undefined) {
      const matching = (tables.entities ?? []).filter((entity) => String(entity.name) === String(row[field]));
      if (matching.length === 0) add(items, seen, makeItem('broken-name-reference', table, row, index, 'name-based relation endpoint does not resolve to a verified entity', ['link-by-reviewed-id', 'exclude-row'], { field, target_table: 'entities', endpoint_sha256: sha256Hex(String(row[field])) }));
      if (matching.length > 1) add(items, seen, makeItem('ambiguous-name-reference', table, row, index, 'name-based relation endpoint resolves to multiple verified entities', ['link-by-reviewed-id', 'exclude-row'], { field, target_table: 'entities', endpoint_sha256: sha256Hex(String(row[field])) }));
    }
  });
  const secretItems = bundle.secret_review_items ?? bundle.secretReviewItems ?? bundle.secret_review?.pending_items ?? [];
  for (const raw of secretItems) {
    const source = raw.source ?? raw;
    const row = { id: source.source_id ?? source.row_key ?? raw.review_id ?? 'secret-review' };
    add(items, seen, makeItem('secret-review', source.table ?? 'unknown', row, 0, 'lived-content secret finding requires an existing explicit secret decision', ['retain', 'redact', 'exclude-row'], { review_id: raw.review_id ?? null, field: source.column ?? null }));
  }
  return items.sort((a, b) => a.decision_id.localeCompare(b.decision_id));
}

function baseManifest(bundle, now) {
  return {
    format_version: FORMAT_VERSION,
    manifest_type: 'ambiguity-decision-manifest',
    migration_id: bundle.migration_id ?? bundle.manifest?.migration_id,
    bundle_manifest_sha256: bundleHash(bundle),
    reviewed: false,
    generated_at: now,
    reviewed_by: null,
    reviewed_at: null,
    items: generateDecisionItems(bundle),
  };
}
function hashableManifest(manifest) { const { manifest_sha256: _ignored, ...rest } = manifest; return rest; }
export function decisionManifestHash(manifest) { return canonicalSha256(hashableManifest(manifest)); }

export function generateDecisionManifest(bundle, { now = new Date().toISOString() } = {}) {
  const source = typeof bundle === 'string' ? loadVerifiedBundle(bundle) : bundle?.bundlePath ? loadVerifiedBundle(bundle.bundlePath, bundle) : bundle;
  const manifest = baseManifest(source, now);
  manifest.manifest_sha256 = decisionManifestHash(manifest);
  return manifest;
}
export const generatePolicyDraft = generateDecisionManifest;
export const generateDecisionDraft = generateDecisionManifest;

export function loadBundleDescriptor(path) {
  const manifest = JSON.parse(readFileSync(`${path}/manifest.json`, 'utf8'));
  const hash = sha256Hex(readFileSync(`${path}/manifest.json`));
  return { manifest, bundle_manifest_sha256: hash, migration_id: manifest.migration_id };
}

export function loadVerifiedBundle(path, options = {}) {
  const verified = verifyBundle({ path, passphraseFile: options.passphraseFile, env: options.env, platform: options.platform });
  const tables = {};
  for (const member of verified.manifest.members) if (member.name.startsWith('data/')) {
    const text = readBundleMember({ path, manifest: verified.manifest, member, passphraseFile: options.passphraseFile, env: options.env, platform: options.platform }).toString('utf8');
    tables[member.name.slice(5).replace(/\.ndjson(?:\.enc)?$/u, '')] = text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  }
  const envelope = JSON.parse(readFileSync(`${path}/envelope.json`, 'utf8'));
  return { tables, migration_id: verified.manifest.migration_id, bundle_manifest_sha256: envelope.manifest_sha256, manifest: verified.manifest };
}

/**
 * The reviewed choice for one generated item. A choice binds to the item's decision id, which is a hash of
 * the kind of question, the row and the column; nothing else matches. More than one entry with the id, or an
 * entry whose own type, table, row or column contradicts the item it carries the id of, is a refusal: this
 * function never picks the first of several.
 */
export function choiceForItem(decisions, item) {
  const entries = decisions?.items ?? decisions?.decisions ?? [];
  const matching = entries.filter((candidate) => candidate?.decision_id === item.decision_id);
  if (matching.length === 0) return undefined;
  const refuseBinding = (summary) => { throw new MigrationRefusal({ code: 'RMIG-E-POLICY-MISMATCH', phase: 'compile-policy', summary, safe_details: { decision_id: item.decision_id }, report_path: null }); };
  if (matching.length > 1) refuseBinding('More than one reviewed entry answers the same decision; a choice must bind to exactly one item.');
  const [entry] = matching;
  for (const key of ['type', 'source_table', 'source_row_sha256']) if (entry[key] !== item[key]) refuseBinding(`A reviewed entry carries a decision id but names a different ${key}; it is not the answer to this item.`);
  if ((entry.field ?? null) !== (item.field ?? null)) refuseBinding('A reviewed entry carries a decision id but names a different field; it is not the answer to this item.');
  return entry.choice;
}
/**
 * The reviewed decision item that answers one cell (table, row, kind of question, column), or undefined.
 * Used by the value map and by validate's column comparison, which look an item up by what the cell is
 * rather than by a generated item. Exactly one item may answer a cell; two is a refusal.
 */
export function decisionItemForCell(decisions, { table, rowHash, type, field }) {
  const matching = (decisions?.items ?? decisions?.decisions ?? []).filter((item) => item?.source_table === table && item.source_row_sha256 === rowHash && item.type === type && (item.field ?? null) === (field ?? null));
  if (matching.length > 1) throw new MigrationRefusal({ code: 'RMIG-E-POLICY-MISMATCH', phase: 'compile-policy', summary: 'More than one reviewed entry answers the same cell; a choice must bind to exactly one item.', safe_details: { source_table: table, field: field ?? null }, report_path: null });
  return matching[0];
}
export { HASH, ISO_WITH_OFFSET, SQLITE_UTC, KIND_NORMALIZATIONS };
