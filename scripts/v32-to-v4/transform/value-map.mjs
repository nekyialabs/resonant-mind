import { canonicalJson } from '../lib/canonical-json.mjs';
import { canonicalSha256 } from '../lib/hash.mjs';
import { KIND_NORMALIZATIONS, ISO_WITH_OFFSET, SQLITE_UTC, TIMESTAMP_FIELDS, DATE_FIELDS, KNOWN_CONTEXTS as CONTEXTS, contextVocabulary, decisionItemForCell } from '../policy/generate.mjs';
import { choiceAction } from './id-map.mjs';
import { targetColumnAllowsNull } from './target-schema.mjs';
import { jsonSurvivesParsing } from '../lib/lossless-json.mjs';
import { parseInstantMicros } from '../lib/instant.mjs';

const ENUMS = {
  status: new Set(['active', 'resolved']),
  salience: new Set(['active', 'high', 'background', 'foundational', 'medium', 'heavy']),
  certainty: new Set(['believed', 'known', 'tentative']),
  weight: new Set(['light', 'medium', 'heavy']),
  charge: new Set(['fresh', 'active', 'processing', 'metabolized']),
  source: new Set(['conversation', 'realization', 'external', 'consolidated', 'inferred', 'journal']),
  thread_type: new Set(['intention', 'task', 'handoff', 'explore', 'idea', 'project', 'creative', 'relational']),
  priority: new Set(['low', 'medium', 'high', 'urgent', 'critical']),
  intensity: new Set(['whisper', 'present', 'strong', 'overwhelming']),
};
const ALIASES = {
  weight: { low:'light', high:'heavy' }, certainty: { certain:'known', uncertain:'tentative', speculative:'tentative' }, charge: { dormant:'metabolized', archived:'metabolized' },
  status: { pending:'active', open:'active', closed:'resolved' }, intensity: { high:'strong' },
  thread_type: { 'urgent-task':'task', build:'task', maintenance:'task', pickup:'task', deadline:'task', morning_handoff:'handoff', 'morning-handoff':'handoff', question:'explore', research:'explore', project_seed:'idea', work:'project', infrastructure:'project', anniversary:'relational', personal:'relational' },
};
const ENUM_FIELDS = new Set(['observations.salience', 'observations.weight', 'observations.certainty', 'observations.charge', 'observations.source', 'threads.thread_type', 'threads.status', 'threads.priority', 'relational_state.intensity']);
function action(choice) { return choiceAction(choice); }
// Enums, contexts and entity kinds treat only NULL as missing: the generator lists '' as a decision item (it is not in the
// vocabulary) and validate holds the target to the reviewed choice, so the transform must apply it. Timestamps and dates are
// the same: the generator lists '' for them (type 'timestamp' / 'date') and the owner chooses exclude-row, set-null where v4 can
// hold NULL, or a reviewed instant / date. An empty string without that choice is an unresolved loss, never passed through.
function absent(value) { return value === null || value === undefined; }
function policyChoice(policy, row, table, type, field) { return decisionItemForCell(policy, { table, rowHash: canonicalSha256(row), type, field }); }
// A JavaScript Date counts milliseconds, PostgreSQL timestamptz counts microseconds, and the v4
// columns are timestamptz. toISOString() alone would drop the last three digits of a v3.2 value such
// as 2026-01-02T03:04:05.987654Z, which changes the stored instant, and new Date() accepts
// 2026-02-30 (as 1 March) and T24:00:00 (as the next midnight), which changes the date. So the text is read
// exactly first (lib/instant.mjs, integer arithmetic, a real calendar instant or a refusal), and the Date
// is only used to print it. The digits the source had are kept (up to six); a value that is whole to the
// millisecond keeps the usual toISOString() form, so SQLite and millisecond sources are unchanged. Finer
// than a microsecond cannot come from PostgreSQL and is refused rather than rounded.
const NAIVE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/u;
function isoFromMicros(micros) {
  const milliseconds = micros >= 0n ? micros / 1000n : -((-micros + 999n) / 1000n);
  const iso = new Date(Number(milliseconds)).toISOString();
  if (micros - milliseconds * 1000n === 0n) return iso;
  const inSecond = ((micros % 1_000_000n) + 1_000_000n) % 1_000_000n;
  return `${iso.slice(0, 19)}.${String(inSecond).padStart(6, '0')}Z`;
}
// The reviewed outcome for an empty timestamp or date cell. `set-null` is accepted only where v4 can hold NULL in that column;
// a replacement must be what the owner wrote down, exactly, and a real instant / date.
function reviewedEmpty(kind, selected, { table, field, row }) {
  const chosen = action(selected);
  const label = `${kind === 'timestamp' ? 'Timestamp' : 'Date'} ${table ?? 'row'}.${field ?? 'value'}`;
  if (chosen === 'set-null') {
    if (table === undefined || field === undefined || !targetColumnAllowsNull(table, field, row)) throw new Error(`${label} is empty text and its v4 column cannot hold NULL; set-null is not an allowed choice.`);
    return null;
  }
  if (kind === 'timestamp' && chosen === 'replace-timestamp') {
    const replacement = selected?.value;
    if (typeof replacement !== 'string' || !ISO_WITH_OFFSET.test(replacement)) throw new Error('A reviewed timestamp replacement must be an RFC 3339 instant with an explicit offset.');
    return isoFromMicros(parseInstantMicros(replacement)); // a value that is not a real calendar instant throws
  }
  if (kind === 'date' && chosen === 'normalize-date') {
    if (typeof selected.value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(selected.value)) throw new Error('Reviewed date choice must provide an ISO date.');
    return normalizeDate(selected.value, { table, field });
  }
  throw new Error(`${label} is empty text, not NULL; it requires a reviewed choice.`);
}
export function normalizeTimestamp(value, { choice, table, field, row } = {}) {
  if (value === null || value === undefined) return null;
  if (value === '') return reviewedEmpty('timestamp', choice?.choice ?? choice, { table, field, row });
  if (typeof value !== 'string') throw new Error(`Timestamp ${table ?? 'row'}.${field ?? 'value'} requires a reviewed choice.`);
  if (ISO_WITH_OFFSET.test(value) || SQLITE_UTC.test(value)) return isoFromMicros(parseInstantMicros(value, { naiveOffset: 'UTC' })); // SQLite's own form is UTC; an invalid calendar value throws
  const selected = choice?.choice ?? choice;
  if (action(selected) !== 'normalize-utc') throw new Error(`Timestamp ${table ?? 'row'}.${field ?? 'value'} is ambiguous.`);
  const timezone = selected?.timezone ?? selected?.timezone_offset;
  if (typeof timezone !== 'string' || !/^(?:UTC|Z|[+-]\d{2}:?\d{2})$/u.test(timezone)) throw new Error('Naive timestamps require an explicit reviewed timezone.');
  if (!NAIVE_TIMESTAMP.test(value)) throw new Error('A reviewed timezone applies only to a timestamp that has no offset of its own.');
  return isoFromMicros(parseInstantMicros(value, { naiveOffset: timezone }));
}
export function normalizeDate(value, { choice, table, field, row } = {}) {
  if (value === null || value === undefined) return null;
  if (value === '') return reviewedEmpty('date', choice?.choice ?? choice, { table, field, row });
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    const date = new Date(`${value}T00:00:00.000Z`); if (!Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value) return value;
  }
  const selected = choice?.choice ?? choice;
  if (action(selected) !== 'normalize-date') throw new Error(`Date ${table ?? 'row'}.${field ?? 'value'} is ambiguous.`);
  if (typeof selected.value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(selected.value)) throw new Error('Reviewed date choice must provide an ISO date.');
  return normalizeDate(selected.value, { table, field });
}
export function normalizeJson(value, expectedShape, { choice } = {}) {
  // Only NULL is missing here. Empty text is not JSON: the policy generator lists it as malformed and the validator
  // holds the target to the reviewed choice, so the transform must apply that choice rather than keep the text.
  if (value === null || value === undefined) return null;
  let parsed = value;
  if (typeof value === 'string') { try { parsed = JSON.parse(value); } catch { parsed = undefined; } if (parsed !== undefined && !jsonSurvivesParsing(value)) parsed = undefined; }
  const valid = expectedShape === 'array' ? Array.isArray(parsed) : expectedShape === 'integer-array' ? Array.isArray(parsed) && parsed.every((item) => Number.isSafeInteger(typeof item === 'number' ? item : Number(item))) : expectedShape === 'object' ? parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) : Array.isArray(parsed) || (parsed !== null && typeof parsed === 'object');
  if (valid) return parsed;
  const selected = choice?.choice ?? choice;
  if (action(selected) !== 'map-json' || !Object.hasOwn(selected, 'value')) throw new Error('Malformed JSON requires a reviewed shape-preserving choice.');
  const mapped = selected.value; const mappedValid = expectedShape === 'array' ? Array.isArray(mapped) : expectedShape === 'integer-array' ? Array.isArray(mapped) && mapped.every((item) => Number.isSafeInteger(typeof item === 'number' ? item : Number(item))) : expectedShape === 'object' ? mapped !== null && typeof mapped === 'object' && !Array.isArray(mapped) : true;
  if (!mappedValid) throw new Error('Reviewed JSON choice has the wrong shape.');
  return mapped;
}
export function normalizeEnum(value, field, { choice } = {}) {
  if (absent(value)) return null;
  const normalized = String(value).toLowerCase();
  if (ENUMS[field]?.has(normalized)) return normalized;
  if (ALIASES[field]?.[normalized] !== undefined) return ALIASES[field][normalized];
  const selected = choice?.choice ?? choice; const selectedAction = action(selected);
  if (selectedAction !== 'map' && selectedAction !== 'map-status' && selectedAction !== 'map-context') throw new Error(`Unknown ${field} value requires a reviewed mapping.`);
  const mapped = selected.value ?? selected.mapped_value ?? selected.target;
  if (typeof mapped !== 'string' || (ENUMS[field] && !ENUMS[field].has(mapped))) throw new Error(`Reviewed mapping for ${field} is unsupported.`);
  return mapped;
}
export function normalizeEntityKind(value, { choice } = {}) {
  if (absent(value)) return null;
  const normalized = KIND_NORMALIZATIONS.get(String(value).toLowerCase());
  if (normalized) return normalized;
  const selected = choice?.choice ?? choice; const selectedAction = action(selected); const mapped = selected?.kind ?? selected?.value ?? selected?.mapped_value;
  if (selectedAction === 'map-to-person' && ['self', 'person', 'peer_ai'].includes(String(mapped).toLowerCase())) return String(mapped).toLowerCase();
  if (selectedAction === 'map-to-node' && ['concept', 'project', 'infrastructure', 'artifact', 'moment', 'session_log', 'practice', 'research', 'journal', 'community', 'emotional_pattern', 'relationship', 'self', 'place', 'object'].includes(String(mapped).toLowerCase())) return String(mapped).toLowerCase();
  throw new Error('Unknown entity kind requires a reviewed final kind allowed by v4 checks.');
}
export function normalizeContext(value, { choice, table, field } = {}) {
  if (absent(value)) return null;
  const known = contextVocabulary(table, field); // observations.context has a v4 CHECK of eight values; the other columns are free text
  const normalized = String(value).toLowerCase(); if (known.has(normalized)) return normalized;
  const selected = choice?.choice ?? choice; if (action(selected) !== 'map-context') throw new Error('Unknown context requires a reviewed mapping.');
  const mapped = selected.value ?? selected.mapped_value ?? selected.target;
  if (typeof mapped !== 'string' || !known.has(mapped.toLowerCase())) throw new Error('Reviewed context mapping is unsupported.');
  return mapped.toLowerCase();
}
export function buildValueMaps({ tables = {}, policy, skipRows = new Set() } = {}) {
  const output = { timestamps: {}, dates: {}, enums: {}, contexts: {}, json: {}, entity_kinds: {} }; const losses = [];
  for (const [table, rows] of Object.entries(tables)) for (const row of rows ?? []) {
    const rowHash = canonicalSha256(row); if (skipRows.has(`${table}:${rowHash}`)) continue;
    for (const [field, value] of Object.entries(row)) {
      if (DATE_FIELDS.has(`${table}.${field}`) && value !== null && value !== undefined) { const item = policyChoice(policy, row, table, 'date', field); try { output.dates[`${table}:${rowHash}:${field}`] = normalizeDate(value, { choice: item, table, field, row }); } catch (error) { losses.push({ kind: 'unresolved-date', source_table: table, source_row_sha256: rowHash, field, reason: error.message }); } }
      if (TIMESTAMP_FIELDS.has(`${table}.${field}`) && value !== null && value !== undefined) { const item = policyChoice(policy, row, table, 'timestamp', field); try { output.timestamps[`${table}:${rowHash}:${field}`] = normalizeTimestamp(value, { choice: item, table, field, row }); } catch (error) { losses.push({ kind: 'unresolved-timestamp', source_table: table, source_row_sha256: rowHash, field, reason: error.message }); } }
      if (ENUM_FIELDS.has(`${table}.${field}`) && value !== null && value !== undefined) { const item = policyChoice(policy, row, table, 'unknown-value', field); try { output.enums[`${table}:${rowHash}:${field}`] = normalizeEnum(value, field, { choice: item }); } catch (error) { losses.push({ kind: 'unresolved-enum', source_table: table, source_row_sha256: rowHash, field, reason: error.message }); } }
      if (['context', 'scope', 'primary_context'].includes(field) && value !== null && value !== undefined) { const item = policyChoice(policy, row, table, 'unknown-value', field); try { output.contexts[`${table}:${rowHash}:${field}`] = normalizeContext(value, { choice: item, table, field }); } catch (error) { losses.push({ kind: 'unresolved-context', source_table: table, source_row_sha256: rowHash, field, reason: error.message }); } }
      if (['links', 'connections', 'tags', 'source_observation_ids', 'data', 'sit_notes'].includes(field) && value !== null && value !== undefined) { const item = policyChoice(policy, row, table, 'malformed-json', field); try { output.json[`${table}:${rowHash}:${field}`] = normalizeJson(value, field === 'data' ? 'object' : field === 'sit_notes' ? 'array-or-object' : field === 'source_observation_ids' ? 'integer-array' : 'array', { choice: item }); } catch (error) { losses.push({ kind: 'unresolved-json', source_table: table, source_row_sha256: rowHash, field, reason: error.message }); } }
    }
    if (table === 'entities') { const value = row.entity_type ?? row.kind; if (value !== null && value !== undefined) { const item = policyChoice(policy, row, table, 'entity-kind', 'entity_type'); try { output.entity_kinds[`${table}:${rowHash}`] = normalizeEntityKind(value, { choice: item }); } catch (error) { losses.push({ kind: 'unresolved-entity-kind', source_table: table, source_row_sha256: rowHash, reason: error.message }); } } }
  }
  losses.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))); return { ...output, losses, hash: canonicalSha256({ ...output, losses }) };
}
export const compileValueMap = buildValueMaps;
export { ENUMS, ALIASES, CONTEXTS, ENUM_FIELDS };
