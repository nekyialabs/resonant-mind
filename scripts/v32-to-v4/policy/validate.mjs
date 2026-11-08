import { canonicalJson } from '../lib/canonical-json.mjs';
import { canonicalSha256 } from '../lib/hash.mjs';
import { assertMigrationId, assertTimestamp, assertPlainData, FORMAT_VERSION } from '../lib/contracts.mjs';
import { decisionManifestHash, generateDecisionItems, bundleHash, ISO_WITH_OFFSET } from './generate.mjs';
import { targetColumnAllowsNull } from '../transform/target-schema.mjs';
import { parseInstantMicros } from '../lib/instant.mjs';
import { hasHiddenCharacters } from '../lib/review-render.mjs';

const HASH = /^[0-9a-f]{64}$/u;
const SAFE_ID = new Set(['string', 'number']);
const ITEM_REQUIRED = ['decision_id', 'type', 'source_table', 'source_id', 'source_row_sha256', 'reason', 'allowed_choices'];
const ITEM_OPTIONAL = new Set(['field', 'target_table', 'target_id', 'expected_shape', 'observed_value_sha256', 'endpoint_sha256', 'collision_ids', 'required_choice_fields', 'review_id']);
const TOP_KEYS = new Set(['format_version', 'manifest_type', 'migration_id', 'bundle_manifest_sha256', 'reviewed', 'generated_at', 'reviewed_by', 'reviewed_at', 'items', 'manifest_sha256']);
// Who stated each choice. 'owner': the owner said it. 'owner-accepted-agent-suggestion': it began as a suggestion made
// by an agent that the owner then accepted. There is no value for a choice the agent made on its own: such a choice is
// not recorded at all (the runbook: an owner who delegates has not chosen). `bulk_rule` is the owner's own words for a
// rule that settled several items at once, kept verbatim.
export const STATED_BY = Object.freeze(['owner', 'owner-accepted-agent-suggestion']);
export const BULK_RULE_MAX_LENGTH = 500;
const WILDCARDS = new Set(['*', 'all', 'accept-all', 'accept_all', 'any', 'unknown']);
function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(`${label} must be a plain object.`);
  return value;
}
function keysOnly(value, allowed, label) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${label} contains unsupported key ${key}.`);
}
function safeText(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim() || hasHiddenCharacters(value)) throw new TypeError(`${label} must be safe text, with no control, invisible or direction-changing characters.`);
}
function choiceValid(choice, item) {
  if (typeof choice === 'string') {
    if (WILDCARDS.has(choice.toLowerCase()) || !item.allowed_choices.includes(choice)) throw new TypeError(`Unsupported choice for ${item.decision_id}.`);
    if ((item.type === 'timestamp' || item.type === 'date') && (item.required_choice_fields?.[choice] ?? []).length > 0) throw new TypeError(`Choice ${choice} requires ${item.required_choice_fields[choice].join(', ')}; give it as an object.`);
    return;
  }
  object(choice, `items[${item.decision_id}].choice`);
  if (Object.keys(choice).some((key) => WILDCARDS.has(key.toLowerCase()))) throw new TypeError('Wildcard policy choices are not supported.');
  const action = choice.action ?? choice.type ?? choice.kind ?? choice.choice;
  if (typeof action !== 'string' || WILDCARDS.has(action.toLowerCase()) || !item.allowed_choices.includes(action)) throw new TypeError(`Unsupported structured choice for ${item.decision_id}.`);
  for (const value of Object.values(choice)) if (typeof value === 'string' && WILDCARDS.has(value.toLowerCase())) throw new TypeError('Wildcard policy choices are not supported.');
  if (action === 'merge') {
    if (!Object.hasOwn(choice, 'survivor_id') || !Array.isArray(choice.merged_ids) || !Object.hasOwn(choice, 'field_rules')) throw new TypeError('Merge choices require survivor_id, merged_ids, and field_rules.');
    if (choice.merged_ids.length === 0 || choice.merged_ids.some((id) => id === null || id === undefined)) throw new TypeError('Merge choices must enumerate all source IDs.');
    if (Array.isArray(item.collision_ids) && (choice.merged_ids.length !== item.collision_ids.length || [...choice.merged_ids].map(String).sort().join(',') !== [...item.collision_ids].map(String).sort().join(','))) throw new TypeError('Merge choices must enumerate every colliding source ID exactly once.');
  }
  if (action === 'rename' && (!choice.names || typeof choice.names !== 'object')) throw new TypeError('Rename choices require deterministic names for every source ID.');
  if (action === 'rename' && Array.isArray(item.collision_ids) && item.collision_ids.some((id) => typeof choice.names[String(id)] !== 'string' || choice.names[String(id)].length === 0)) throw new TypeError('Rename choices must provide a final name for every colliding source ID.');
  if (action === 'link-by-reviewed-id' && (choice.target_id === null || choice.target_id === undefined)) throw new TypeError('Reviewed link choices require target_id.');
  if (Object.hasOwn(item, 'endpoint_sha256') && !HASH.test(item.endpoint_sha256)) throw new TypeError('Endpoint hash is invalid.');
  const required = item.required_choice_fields?.[action];
  if (required !== undefined) {
    if (!Array.isArray(required) || required.some((field) => typeof field !== 'string' || field.length === 0)) throw new TypeError('required_choice_fields is invalid.');
    for (const field of required) if (!Object.hasOwn(choice, field) || choice[field] === null || choice[field] === undefined || choice[field] === '') throw new TypeError(`Choice ${action} requires ${field}.`);
  }
  if (item.type === 'timestamp' || item.type === 'date') {
    // a reviewed time or date is checked here, when the choice is recorded, not only when the value map applies it
    if (action === 'set-null' && !targetColumnAllowsNull(item.source_table, item.field)) throw new TypeError(`set-null is not allowed for ${item.source_table}.${item.field}: its v4 column cannot hold NULL.`);
    if (action === 'replace-timestamp') {
      if (typeof choice.value !== 'string' || !ISO_WITH_OFFSET.test(choice.value)) throw new TypeError('replace-timestamp requires value: an RFC 3339 instant with an explicit offset.');
      try { parseInstantMicros(choice.value); } catch { throw new TypeError('replace-timestamp value is not a real calendar instant.'); }
    }
    if (action === 'normalize-date') {
      const real = typeof choice.value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(choice.value) && !Number.isNaN(new Date(`${choice.value}T00:00:00.000Z`).valueOf()) && new Date(`${choice.value}T00:00:00.000Z`).toISOString().slice(0, 10) === choice.value;
      if (!real) throw new TypeError('normalize-date requires value: a real ISO date (YYYY-MM-DD).');
    }
  }
  if (action === 'map-to-person' || action === 'map-to-node') {
    if (typeof choice.kind !== 'string' || choice.kind.length === 0) throw new TypeError(`${action} choices require a final kind.`);
  }
  if (action === 'preserve-visits-and-resolve' || action === 'preserve-visits-and-open') {
    if (Object.hasOwn(choice, 'last_visited') && typeof choice.last_visited !== 'string') throw new TypeError('Tension last_visited must be text.');
    if (Object.hasOwn(choice, 'resolved_at') && typeof choice.resolved_at !== 'string') throw new TypeError('Tension resolved_at must be text.');
  }
}
function validateItem(item, index, reviewed) {
  object(item, `items[${index}]`);
  const allowed = new Set([...ITEM_REQUIRED, ...ITEM_OPTIONAL]);
  if (reviewed) { allowed.add('choice'); allowed.add('stated_by'); allowed.add('bulk_rule'); }
  keysOnly(item, allowed, `items[${index}]`);
  for (const key of ITEM_REQUIRED) if (!Object.hasOwn(item, key)) throw new TypeError(`items[${index}] is missing ${key}.`);
  if (!HASH.test(item.decision_id) || !HASH.test(item.source_row_sha256)) throw new TypeError(`items[${index}] has invalid decision or row hash.`);
  safeText(item.type, `items[${index}].type`); safeText(item.source_table, `items[${index}].source_table`); safeText(item.reason, `items[${index}].reason`);
  if (!SAFE_ID.has(typeof item.source_id) || item.source_id === '') throw new TypeError(`items[${index}].source_id must be a scalar source ID.`);
  if (!Array.isArray(item.allowed_choices) || item.allowed_choices.length === 0 || new Set(item.allowed_choices).size !== item.allowed_choices.length) throw new TypeError(`items[${index}].allowed_choices must be a non-empty choice list.`);
  for (const choice of item.allowed_choices) { safeText(choice, `items[${index}].allowed_choices`); if (WILDCARDS.has(choice.toLowerCase())) throw new TypeError('Wildcard choices are not supported.'); }
  if (Object.hasOwn(item, 'observed_value_sha256') && !HASH.test(item.observed_value_sha256)) throw new TypeError('Observed value hash is invalid.');
  if (Object.hasOwn(item, 'endpoint_sha256') && !HASH.test(item.endpoint_sha256)) throw new TypeError('Endpoint hash is invalid.');
  if (Object.hasOwn(item, 'collision_ids') && (!Array.isArray(item.collision_ids) || item.collision_ids.length < 2)) throw new TypeError('Collision IDs must enumerate at least two IDs.');
  if (reviewed) {
    if (!Object.hasOwn(item, 'choice')) throw new TypeError(`items[${index}] is unresolved.`);
    choiceValid(item.choice, item);
    if (!STATED_BY.includes(item.stated_by)) throw new TypeError(`items[${index}] has a choice but no stated_by (owner, or owner-accepted-agent-suggestion): a choice must say who stated it.`);
    if (Object.hasOwn(item, 'bulk_rule')) {
      const rule = item.bulk_rule;
      if (typeof rule !== 'string' || rule.length === 0 || rule !== rule.trim() || rule.length > BULK_RULE_MAX_LENGTH || hasHiddenCharacters(rule)) throw new TypeError(`items[${index}].bulk_rule must be the owner's rule as one line of text, at most ${BULK_RULE_MAX_LENGTH} characters, with no control, invisible or direction-changing characters.`);
    }
  } else if (Object.hasOwn(item, 'choice') || Object.hasOwn(item, 'stated_by') || Object.hasOwn(item, 'bulk_rule')) throw new TypeError('Draft decision manifests must not contain choices.');
}
export function validateDecisionManifest(value, { bundleManifestSha256, expectedItems, bundle } = {}) {
  object(value, 'Decision manifest');
  assertPlainData(value);
  keysOnly(value, TOP_KEYS, 'Decision manifest');
  for (const key of TOP_KEYS) if (!Object.hasOwn(value, key)) throw new TypeError(`Decision manifest is missing ${key}.`);
  if (value.format_version !== FORMAT_VERSION || value.manifest_type !== 'ambiguity-decision-manifest') throw new TypeError('Unsupported decision manifest format.');
  assertMigrationId(value.migration_id, 'migration_id');
  if (!HASH.test(value.bundle_manifest_sha256)) throw new TypeError('bundle_manifest_sha256 must be a lowercase SHA-256 digest.');
  const expectedBundleHash = bundleManifestSha256 ?? (bundle === undefined ? undefined : bundleHash(bundle));
  if (expectedBundleHash !== undefined && value.bundle_manifest_sha256 !== expectedBundleHash) throw new TypeError('Decision manifest is stale for this bundle.');
  if (typeof value.reviewed !== 'boolean') throw new TypeError('reviewed must be boolean.');
  assertTimestamp(value.generated_at, 'generated_at');
  if (!Array.isArray(value.items)) throw new TypeError('items must be an array.');
  const ids = new Set();
  for (let index = 0; index < value.items.length; index += 1) { validateItem(value.items[index], index, value.reviewed); if (ids.has(value.items[index].decision_id)) throw new TypeError('Decision IDs must be unique.'); ids.add(value.items[index].decision_id); }
  if (!HASH.test(value.manifest_sha256) || decisionManifestHash(value) !== value.manifest_sha256) throw new TypeError('manifest_sha256 does not match canonical decision content.');
  if (value.reviewed) {
    safeText(value.reviewed_by, 'reviewed_by'); assertTimestamp(value.reviewed_at, 'reviewed_at');
    const completeItems = expectedItems ?? (bundle === undefined ? undefined : generateDecisionItems(bundle));
    if (completeItems !== undefined) {
      const expectedById = new Map(completeItems.map((item) => [item.decision_id, item]));
      const expected = new Set(expectedById.keys());
      if (expected.size !== ids.size || [...expected].some((id) => !ids.has(id))) throw new TypeError('Reviewed policy has missing or extra decisions.');
      for (const item of value.items) {
        const expectedItem = expectedById.get(item.decision_id);
        const comparable = (candidate) => { const copy = { ...candidate }; delete copy.decision_id; delete copy.choice; delete copy.stated_by; delete copy.bulk_rule; return copy; };
        if (canonicalJson(comparable(item)) !== canonicalJson(comparable(expectedItem))) throw new TypeError(`Decision ${item.decision_id} is stale or does not match the verified source row.`);
      }
    }
  } else if (value.reviewed_by !== null || value.reviewed_at !== null) throw new TypeError('Unreviewed decision manifests must have null review metadata.');
  return value;
}
/**
 * Who stated each choice of a reviewed manifest, for the compiled policy and the report: the count by who stated it,
 * the owner's bulk rules verbatim with the number of items each settled, and the ids of the items whose choice began as
 * an agent's suggestion. Holds no memory content: only ids, counts and the owner's own rule text.
 */
export function summarizeStatements(decisions) {
  const counts = Object.fromEntries(STATED_BY.map((name) => [name, 0]));
  const rules = new Map();
  const accepted = [];
  for (const item of decisions?.items ?? []) {
    if (!Object.hasOwn(item, 'choice')) continue;
    counts[item.stated_by] = (counts[item.stated_by] ?? 0) + 1;
    if (item.stated_by === 'owner-accepted-agent-suggestion') accepted.push(item.decision_id);
    if (typeof item.bulk_rule === 'string') rules.set(item.bulk_rule, (rules.get(item.bulk_rule) ?? 0) + 1);
  }
  return {
    stated_by: counts,
    bulk_rules: [...rules].sort(([a], [b]) => a.localeCompare(b)).map(([rule, items]) => ({ rule, items })),
    suggestions_accepted: accepted.sort(),
  };
}
export function assertReviewedDecisionManifest(value, options = {}) { validateDecisionManifest(value, options); if (!value.reviewed) throw new TypeError('Decision manifest is not reviewed.'); return value; }
export function decisionContentHash(value) { const { manifest_sha256: _ignored, ...rest } = value; return canonicalSha256(rest); }
