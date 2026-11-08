import { readFileSync } from 'node:fs';
import { canonicalJson } from '../lib/canonical-json.mjs';

// Final public catalog, kept in lock-step with migrations/postgres/*.sql.
// Rows are insert-shaped partial rows; omitted nullable/defaulted columns are
// supplied by PostgreSQL. This is deliberately a catalog, not a guessed ORM.
const PEOPLE_KINDS = new Set(['self', 'person', 'peer_ai']);
const NODE_KINDS = new Set(['concept', 'project', 'infrastructure', 'artifact', 'moment', 'session_log', 'practice', 'research', 'journal', 'community', 'emotional_pattern', 'relationship', 'self', 'place', 'object']);
export const OBS_CONTEXTS = new Set(['default', 'emotional-processing', 'interests-curiosities', 'creative-space', 'relational-models', 'episodic', 'values-ethics', 'research']);
const OBS_SOURCES = new Set(['conversation', 'realization', 'external', 'consolidated', 'inferred', 'journal']);
const OBS_SALIENCE = new Set(['active', 'high', 'background', 'foundational', 'medium', 'heavy']);
const OBS_WEIGHTS = new Set(['light', 'medium', 'heavy']);
const OBS_CHARGES = new Set(['fresh', 'active', 'processing', 'metabolized']);
const OBS_CERTAINTY = new Set(['believed', 'known', 'tentative']);

const schema = (columns, required = [], extras = {}) => ({ columns, required, ...extras });

export const TARGET_SCHEMAS = Object.freeze({
  entities: schema({ id:'integer', name:'text', entity_type:'text', primary_context:'text', salience:'text', created_at:'timestamptz', updated_at:'timestamptz', affect_valence:'double', affect_arousal:'double', affect_n:'integer' }, ['id','name','entity_type'], { checks: { entity_type: new Set([...NODE_KINDS, 'peer_ai', 'person']) } }),
  people: schema({ id:'integer', name:'text', kind:'text', salience:'text', primary_context:'text', created_at:'timestamptz', updated_at:'timestamptz' }, ['id','name','kind'], { kind: PEOPLE_KINDS }),
  nodes: schema({ id:'integer', name:'text', kind:'text', salience:'text', primary_context:'text', created_at:'timestamptz', updated_at:'timestamptz' }, ['id','name','kind'], { kind: NODE_KINDS }),
  relations: schema({ id:'integer', from_entity:'text', to_entity:'text', relation_type:'text', from_context:'text', to_context:'text', store_in:'text', created_at:'timestamptz' }, ['id','from_entity','to_entity','relation_type']),
  threads: schema({ id:'text', thread_type:'text', content:'text', context:'text', priority:'text', status:'text', source:'text', notes:'text', created_at:'timestamptz', updated_at:'timestamptz', resolved_at:'timestamptz', resolution:'text' }, ['id','thread_type','content'], { checks: { thread_type: new Set(['intention','task','handoff','explore','idea','project','creative','relational']), status: new Set(['active','resolved']), priority: new Set(['low','medium','high','urgent','critical']) } }),
  context_entries: schema({ id:'text', scope:'text', content:'text', links:'text', updated_at:'timestamptz' }, ['id','scope','content']),
  relational_state: schema({ id:'integer', person:'text', feeling:'text', intensity:'text', timestamp:'timestamptz' }, ['id','person','feeling','intensity'], { checks: { intensity: new Set(['whisper','present','strong','overwhelming']) } }),
  identity: schema({ id:'integer', section:'text', content:'text', kind:'text', weight:'double', connections:'text', timestamp:'timestamptz', archived_at:'timestamptz' }, ['id','section','content','kind'], { generated: ['kind'] }),
  journals: schema({ id:'integer', entry_date:'text', content:'text', tags:'text', emotion:'text', journal_type:'text', created_at:'timestamptz' }, ['id','content']),
  consolidation_groups: schema({ id:'integer', summary:'text', entity_id:'integer', person_id:'integer', node_id:'integer', source_observation_ids:'integer_array', consolidated_observation_id:'integer', created_at:'timestamptz' }, ['id','summary','source_observation_ids']),
  observations: schema({ id:'integer', entity_id:'integer', person_id:'integer', node_id:'integer', content:'text', salience:'text', emotion:'text', added_at:'timestamptz', weight:'text', updated_at:'timestamptz', charge:'text', sit_count:'integer', last_sat_at:'timestamptz', resolution_note:'text', resolved_at:'timestamptz', linked_observation_id:'integer', last_surfaced_at:'timestamptz', surface_count:'integer', novelty_score:'double', certainty:'text', source:'text', archived_at:'timestamptz', source_date:'date', context:'text', access_count:'integer', last_accessed_at:'timestamptz', valid_from:'timestamptz', valid_until:'timestamptz', superseded_by:'integer', supersedes:'integer', rescued_at:'timestamptz' }, ['id','entity_id','content'], { checks: { weight: OBS_WEIGHTS, charge: OBS_CHARGES, certainty: OBS_CERTAINTY, source: OBS_SOURCES, salience: OBS_SALIENCE, context: OBS_CONTEXTS } }),
  observation_sits: schema({ id:'integer', observation_id:'integer', sit_note:'text', sat_at:'timestamptz' }, ['id','observation_id']),
  observation_versions: schema({ id:'integer', observation_id:'integer', version_num:'integer', content:'text', weight:'text', emotion:'text', edited_at:'timestamptz' }, ['id','observation_id','version_num','content']),
  co_surfacing: schema({ id:'integer', obs_a_id:'integer', obs_b_id:'integer', co_count:'integer', first_co_surfaced:'timestamptz', last_co_surfaced:'timestamptz', relation_proposed:'integer', relation_created:'integer' }, ['id','obs_a_id','obs_b_id']),
  orphan_observations: schema({ id:'integer', observation_id:'integer', first_marked:'timestamptz', rescue_attempts:'integer', last_rescue_attempt:'timestamptz' }, ['id','observation_id']),
  daemon_proposals: schema({ id:'integer', proposal_type:'text', from_obs_id:'integer', to_obs_id:'integer', from_entity_id:'integer', to_entity_id:'integer', reason:'text', confidence:'double', status:'text', proposed_at:'timestamptz', resolved_at:'timestamptz', co_count_at_resolution:'integer' }, ['id','proposal_type','reason']),
  tensions: schema({ id:'text', pole_a:'text', pole_b:'text', context:'text', visits:'integer', created_at:'timestamptz', last_visited:'timestamptz', resolved_at:'timestamptz', resolution:'text' }, ['id','pole_a','pole_b']),
  images: schema({ id:'integer', path:'text', description:'text', context:'text', emotion:'text', weight:'text', entity_id:'integer', person_id:'integer', node_id:'integer', observation_id:'integer', charge:'text', created_at:'timestamptz', last_viewed_at:'timestamptz', view_count:'integer', novelty_score:'double', last_surfaced_at:'timestamptz', surface_count:'integer', access_count:'integer', last_accessed_at:'timestamptz', archived_at:'timestamptz' }, ['id','path','description']),
  subconscious: schema({ id:'integer', state_type:'text', data:'text', updated_at:'timestamptz' }, ['id','state_type','data']),
  notes: schema({ id:'integer', content:'text', weight:'text', context:'text', emotion:'text', created_at:'timestamptz', charge:'text', sit_count:'integer', last_sat_at:'timestamptz', resolution_note:'text', resolved_at:'timestamptz', linked_insight_id:'integer' }, ['id','content']),
  vault_chunks: schema({ id:'integer', source_file:'text', chunk_index:'integer', content:'text', era:'text', month:'text', conversation_title:'text', created_at:'timestamptz' }, ['id','source_file','chunk_index','content']),
  session_chunks: schema({ id:'integer', session_path:'text', chunk_index:'integer', content:'text', session_date:'text', project:'text', created_at:'timestamptz' }, ['id','session_path','chunk_index','content']),
  dreams: schema({ id:'integer', dream_date:'text', content:'text', emotional_seed:'text', fragments:'text', recurring_dream_id:'integer', recurrence_count:'integer', created_at:'timestamptz', vectorized_at:'timestamptz', composed_by:'text' }, ['id','dream_date','content']),
  mood_log: schema({ id:'integer', logged_at:'timestamptz', dominant:'text', valence:'double', arousal:'double', signals:'integer', coverage:'double' }, ['id']),
  compass: schema({ id:'integer', kind:'text', content:'text', weight:'double', asserted_count:'integer', last_asserted_at:'timestamptz', source_identity_id:'integer', created_at:'timestamptz' }, ['id','kind','content'], { checks: { kind: new Set(['value','belief','ideology','boundary','commitment']) } }),
  compass_provenance: schema({ id:'integer', compass_id:'integer', source_type:'text', source_id:'integer', reason:'text', strength:'double', added_at:'timestamptz' }, ['id','compass_id','source_type','source_id'], { checks: { source_type: new Set(['observation','journal','image','thread']) } }),
  thread_entities: schema({ id:'integer', thread_id:'text', entity_id:'integer', role:'text', created_at:'timestamptz' }, ['id','thread_id','entity_id','role']),
  startles: schema({ id:'integer', observation_id:'integer', content:'text', valence:'double', arousal:'double', created_at:'timestamptz', acknowledged_at:'timestamptz' }, ['id']),
  drives: schema({ drive:'text', panksepp_system:'text', display_name:'text', baseline:'double', floor:'double', ceiling:'double', half_life_hours:'double', env_sensitivity:'jsonb', body_feel:'jsonb', action_bias:'jsonb', regulation_note:'text', enabled:'boolean', metadata:'jsonb', touch_affinities:'jsonb', created_at:'timestamptz', updated_at:'timestamptz' }, ['drive']),
  drive_states: schema({ id:'integer', state_type:'text', level:'double', content:'jsonb', source:'text', created_at:'timestamptz' }, ['id','state_type']),
  drive_events: schema({ id:'integer', perception:'text', appraisal:'jsonb', drive_deltas:'jsonb', advisory:'text', created_at:'timestamptz' }, ['id']),
  inner_entries: schema({ id:'integer', kind:'text', body:'text', about:'text', charge:'double', satisfied_at:'timestamptz', metadata:'jsonb', created_at:'timestamptz', archived_at:'timestamptz' }, ['id','kind','body'], { checks: { kind: new Set(['quiet_want','small_joy']) } }),
});

const SOURCE_MAP = JSON.parse(readFileSync(new URL('../spec/v3.2-to-v4-map.json', import.meta.url), 'utf8'));
// Two v4 columns are nullable in the table but never hold NULL once a row has been imported: v4's entity routing trigger
// (migrations/postgres/0005d_routing_triggers.sql) writes COALESCE(NEW.created_at, NOW()) and COALESCE(NEW.updated_at, NOW())
// into people/nodes, so a source NULL there lands as the import time. "Set it to NULL" is therefore not an outcome the
// target can hold for entities.created_at and entities.updated_at, and the review does not offer it.
const ENTITY_TRIGGER_FILLED = new Set(['entities.created_at', 'entities.updated_at']);
/**
 * Whether a v3.2 cell (source table and column) may become NULL in v4. It reads the catalog above, which is kept in
 * lock-step with migrations/postgres/*.sql: the source column maps (spec/v3.2-to-v4-map.json) to a target column, and that
 * column is NULL-able unless the catalog lists it as required. `row` is optional; a tension that has been sat with takes its
 * last_visited from created_at, so a NULL created_at on such a row would leave last_visited without a value to default from.
 */
export function targetColumnAllowsNull(sourceTable, sourceField, row) {
  if (ENTITY_TRIGGER_FILLED.has(`${sourceTable}.${sourceField}`)) return false;
  const mapping = SOURCE_MAP.find((entry) => entry.source_table === sourceTable);
  const targetField = mapping?.column_map?.[sourceField];
  if (!mapping || targetField === undefined) return false;
  const targets = mapping.target_tables.map((name) => TARGET_SCHEMAS[name]).filter((schema) => schema !== undefined);
  if (targets.length === 0 || targets.some((schema) => (schema.required ?? []).includes(targetField))) return false;
  if (sourceTable === 'tensions' && sourceField === 'created_at' && row !== undefined && Number(row?.sit_count ?? 0) > 0) return false;
  return true;
}

export const TARGET_ENUM_ALIASES = Object.freeze({
  observations: { weight: { low:'light', high:'heavy' }, certainty: { certain:'known', uncertain:'tentative', speculative:'tentative' }, charge: { dormant:'metabolized', archived:'metabolized' } },
  threads: { thread_type: { 'urgent-task':'task', build:'task', maintenance:'task', pickup:'task', deadline:'task', morning_handoff:'handoff', 'morning-handoff':'handoff', question:'explore', research:'explore', project_seed:'idea', work:'project', infrastructure:'project', anniversary:'relational', personal:'relational' }, priority: { normal:'medium', urgent:'urgent', critical:'critical' }, status: { pending:'active', open:'active', closed:'resolved' } },
  relational_state: { intensity: { high:'strong' } },
});

export function targetKindAllowed(table, kind) { return TARGET_SCHEMAS[table]?.kind?.has(kind) === true; }
export function canonicalText(value) { return value === null || value === undefined ? value ?? null : typeof value === 'string' ? value : canonicalJson(value).trim(); }
function integer(value, label) { if (!Number.isSafeInteger(value)) throw new TypeError(`${label} must be a safe integer.`); return value; }
function scalarText(value, label) { if (typeof value !== 'string') throw new TypeError(`${label} must be text.`); return value; }
function dateText(value, label) { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new TypeError(`${label} must be an ISO date.`); const date = new Date(`${value}T00:00:00.000Z`); if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) throw new TypeError(`${label} must be a valid ISO date.`); return value; }
export function assertTargetRow(table, row, { allowMissingRequired = false } = {}) {
  const target = TARGET_SCHEMAS[table];
  if (!target) throw new TypeError(`Unknown v4 target table ${table}.`);
  for (const key of Object.keys(row)) if (!Object.hasOwn(target.columns, key)) throw new TypeError(`${table}.${key} is not a v4 target column.`);
  if (!allowMissingRequired) for (const key of target.required ?? []) if (row[key] === null || row[key] === undefined) { if (!(target.generated ?? []).includes(key)) throw new TypeError(`${table}.${key} is required by the v4 target schema.`); }
  for (const [key, value] of Object.entries(row)) {
    if (value === null || value === undefined) continue;
    const type = target.columns[key];
    if (type === 'text' || type === 'timestamptz' || type === 'jsonb') scalarText(value, `${table}.${key}`);
    else if (type === 'date') dateText(value, `${table}.${key}`);
    else if (type === 'real' || type === 'double') { if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${table}.${key} must be a finite number.`); }
    else if (type === 'integer') integer(value, `${table}.${key}`);
    else if (type === 'boolean') { if (typeof value !== 'boolean') throw new TypeError(`${table}.${key} must be boolean.`); }
    else if (type === 'integer_array') { if (!Array.isArray(value) || value.some((item) => !Number.isSafeInteger(item))) throw new TypeError(`${table}.${key} must be an integer array.`); }
    const allowed = target.checks?.[key];
    if (allowed && !allowed.has(value)) throw new TypeError(`${table}.${key} violates the v4 CHECK vocabulary.`);
  }
  if (target.kind && !target.kind.has(row.kind)) throw new TypeError(`${table}.kind violates the v4 CHECK vocabulary.`);
  if (table === 'observations' && ((row.person_id === null || row.person_id === undefined) === (row.node_id === null || row.node_id === undefined))) throw new TypeError('observations requires exactly one of person_id/node_id.');
  if (['images','consolidation_groups'].includes(table) && row.person_id !== undefined && row.node_id !== undefined && row.person_id !== null && row.node_id !== null) throw new TypeError(`${table} cannot set both person_id and node_id.`);
  return row;
}
