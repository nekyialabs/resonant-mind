// The owner's view of the open decisions: each item with the real values it concerns, the choices it allows,
// and what each choice does.
//
// A decision draft carries only the hash of an observed value (it is a file an agent passes around, and it must
// not hold memory content), so the owner cannot decide a merge, a timezone or a repaired JSON value from the
// draft alone. This module reads the verified bundle and renders what the owner needs to see. It returns text
// and HTML; it writes nothing and puts nothing into the decision file, a log or a report. Whatever shows
// memory content is shown only by `review-decisions`, to the person at the terminal or in the file they opened.
//
// Values are shown as JSON text (so a newline, a quote or a control character is visible, never acted on),
// with invisible and direction-changing characters written out, and long values are cut with a count.

import { canonicalJson } from './canonical-json.mjs';
import { canonicalSha256 } from './hash.mjs';
import { MigrationRefusal } from './refusal.mjs';
import { contextVocabulary, extractBundleRows, generateDecisionItems } from '../policy/generate.mjs';
import { NODE_KINDS, PERSON_KINDS } from '../transform/id-map.mjs';
import { ENUMS, normalizeTimestamp } from '../transform/value-map.mjs';

export const REVIEW_NOTICE = 'This shows MEMORY CONTENT from the bundle, in the clear. Read it yourself; do not paste it into a chat, a ticket or a log, and do not hand it to an agent. It is not written into the decision file, the reports or any other artifact.';
const MAX_VALUE = 300;
const MAX_PREVIEW = 160;
const MAX_ROWS = 25;
// code points that are invisible or change how text is laid out (controls, soft hyphen, zero-width and direction marks, line and paragraph separators)
const INVISIBLE_RANGES = [[0x7f, 0x9f], [0xad, 0xad], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2069], [0xfeff, 0xfeff]];
const isInvisible = (codePoint) => INVISIBLE_RANGES.some(([from, to]) => codePoint >= from && codePoint <= to);
/** Whether text holds a C0 control or a code point that is invisible or changes layout; text a person or an agent types that is printed back (reviewed_by, bulk_rule) must not. */
export const hasHiddenCharacters = (text) => [...String(text)].some((char) => { const code = char.codePointAt(0); return code < 0x20 || isInvisible(code); });
const BACKSLASH_U = String.fromCharCode(92) + 'u';

/** A value as the owner will read it: JSON text, invisible characters written out, cut at `max` characters with a count. */
export function boundedText(value, max = MAX_VALUE) {
  let text;
  if (value === undefined) text = 'undefined';
  else { try { text = JSON.stringify(value); } catch { text = undefined; } if (text === undefined) text = String(value); }
  const characters = Array.from(text).map((character) => (isInvisible(character.codePointAt(0)) ? BACKSLASH_U + character.codePointAt(0).toString(16).padStart(4, '0') : character));
  if (characters.length <= max) return characters.join('');
  return `${characters.slice(0, max).join('')} ... (+${characters.length - max} more characters)`;
}

function mismatch(summary, details = {}) {
  return new MigrationRefusal({ code: 'RMIG-E-POLICY-MISMATCH', phase: 'review-decisions', summary, safe_details: details, report_path: null });
}

const OWN = new Set(['choice', 'stated_by', 'bulk_rule', 'decision_id']);
const comparable = (item) => Object.fromEntries(Object.entries(item).filter(([key]) => !OWN.has(key)));
const TYPE_ORDER = ['duplicate-entity-name', 'entity-kind', 'broken-foreign-key', 'broken-name-reference', 'ambiguous-name-reference', 'timestamp', 'date', 'malformed-json', 'unknown-value', 'tension-state', 'dormancy-translation', 'secret-review'];

const TYPE_HEADINGS = {
  'duplicate-entity-name': 'Two or more entities have the same name',
  'entity-kind': 'An entity has a kind v4 does not know',
  'broken-foreign-key': 'A row points at a row that is not in the bundle',
  'broken-name-reference': 'A relation names an entity that is not in the bundle',
  'ambiguous-name-reference': 'A relation names an entity that more than one row has',
  timestamp: 'A time is empty text, has no timezone, or cannot be read',
  date: 'A date is empty text, or cannot be read as a date',
  'malformed-json': 'A JSON column does not hold the JSON v4 expects',
  'unknown-value': 'A value is not one v4 accepts',
  'tension-state': 'A tension has a state v4 stores differently',
  'dormancy-translation': 'A dormant observation becomes an orphan observation',
  'secret-review': 'A secret scan finding needs a decision',
};

const EXCLUDE = 'The row is left out of v4, and so is every row that depends on it (observations, images and links that point at it); each is listed as a loss in the report. Nothing is deleted from the source.';
const CONSEQUENCES = {
  'exclude-row': EXCLUDE,
  merge: 'The listed entities become one. The survivor keeps its id; the observations, images and links of the others move to it. field_rules says, for each of name, entity_type, primary_context, salience, created_at and updated_at, whose value the survivor keeps (a source id) or what value it takes; the values it does not keep are recorded in the merge audit of the report and are not in v4.',
  rename: 'Every entity keeps its own id, observations and links, and takes the final name you give it in names (one name per id, all different). Nothing is merged and nothing is lost.',
  'map-to-person': 'The entity is stored in v4 people, with the final kind you give (self, person or peer_ai).',
  'map-to-node': 'The entity is stored in v4 nodes, with the final kind you give (one of the node kinds listed).',
  'normalize-utc': 'The time is read as local time in the timezone you give and stored as that exact moment in UTC. A wrong timezone shifts the moment, silently, by its offset.',
  'normalize-date': 'The date is replaced by the date you give (YYYY-MM-DD).',
  'replace-timestamp': 'The empty time is replaced by the instant you give, written with an explicit offset (for example 2026-01-02T03:04:05Z). Nothing is guessed: if you do not know the moment, choose set-null or exclude-row.',
  'set-null': 'The empty text is stored as NULL (no value). Offered only where v4 lets the column be empty.',
  'map-json': 'The column holds the JSON you give in place of the value shown, in the expected shape. The original text is not kept.',
  map: 'The value is stored as the allowed v4 value you give.',
  'map-context': 'The value is stored as the allowed context you give.',
  'map-status': 'The value is stored as the status you give.',
  'null-if-allowed': 'The reference is stored empty (NULL). Only possible where v4 lets the column be empty; for a required reference the migration refuses this choice.',
  'link-by-reviewed-id': 'The reference points at the row whose id you give (target_id), which must exist in the bundle and not be excluded.',
  'preserve-visits-and-resolve': 'The tension keeps its visit count and is stored as resolved at the time you give (and last visited, where it has been sat with).',
  'preserve-visits-and-open': 'The tension keeps its visit count and is stored as open (and last visited at the time you give, where it has been sat with).',
  'translate-to-orphan': 'The dormant observation is stored in v4 as an orphan observation.',
  retain: 'The content is kept as it is.',
  redact: 'The matching text is replaced before it is stored.',
};
const WRITE_AS = {
  merge: '{ "action": "merge", "survivor_id": <id>, "merged_ids": [<every colliding id>], "field_rules": { "name": <source id or { "value": ... }>, ... } }',
  rename: '{ "action": "rename", "names": { "<id>": "<final name>", ... } }',
  'map-to-person': '{ "action": "map-to-person", "kind": "<self | person | peer_ai>" }',
  'map-to-node': '{ "action": "map-to-node", "kind": "<a node kind>" }',
  'normalize-utc': '{ "action": "normalize-utc", "timezone": "<UTC | +01:00 | -05:00 ...>" }',
  'normalize-date': '{ "action": "normalize-date", "value": "YYYY-MM-DD" }',
  'replace-timestamp': '{ "action": "replace-timestamp", "value": "<RFC 3339 time with an offset, e.g. 2026-01-02T03:04:05Z>" }',
  'map-json': '{ "action": "map-json", "value": <JSON in the expected shape> }',
  map: '{ "action": "map", "value": "<allowed value>" }',
  'map-context': '{ "action": "map-context", "value": "<allowed context>" }',
  'map-status': '{ "action": "map-status", "value": "<allowed status>" }',
  'link-by-reviewed-id': '{ "action": "link-by-reviewed-id", "target_id": <id> }',
  'preserve-visits-and-resolve': '{ "action": "preserve-visits-and-resolve", "resolved_at": "<time>", "last_visited": "<time, where sat with>" }',
  'preserve-visits-and-open': '{ "action": "preserve-visits-and-open", "last_visited": "<time, where sat with>" }',
};

function rowIndex(rows) {
  const byHash = new Map();
  for (const row of rows) byHash.set(canonicalSha256(row), row);
  return byHash;
}
const idOf = (row) => (row?.id ?? row?.key);
const facts = (title, pairs) => ({ title, kind: 'facts', facts: pairs });
const table = (title, columns, rows, note) => ({ title, kind: 'rows', columns, rows, ...(note === undefined ? {} : { note }) });
const choiceDisplay = (choice) => (typeof choice === 'string' ? JSON.stringify(choice) : boundedText(choice, 600));

function rowFacts(row, title) {
  if (row === undefined) return facts(title, [['row', 'not found in the bundle']]);
  const pairs = []; let empty = 0;
  for (const [column, value] of Object.entries(row)) { if (value === null || value === undefined) empty += 1; else pairs.push([column, boundedText(value)]); }
  if (empty > 0) pairs.push(['(empty columns)', String(empty)]);
  return facts(title, pairs);
}

export function buildReviewModel({ bundle, decisions }) {
  const tables = extractBundleRows(bundle);
  const expected = generateDecisionItems(bundle);
  if (decisions === null || typeof decisions !== 'object' || !Array.isArray(decisions.items)) throw mismatch('The decision file is not a decision manifest (it has no items list).');
  if (decisions.migration_id !== bundle.migration_id) throw mismatch('The decision file belongs to a different migration than the bundle supplied.');
  if (decisions.bundle_manifest_sha256 !== bundle.bundle_manifest_sha256) throw mismatch('The decision file was drafted for a different bundle than the one supplied.');
  const given = new Map();
  for (const item of decisions.items) {
    if (item === null || typeof item !== 'object' || typeof item.decision_id !== 'string' || given.has(item.decision_id)) throw mismatch('The decision file lists an item twice, or an item that is not an item.');
    given.set(item.decision_id, item);
  }
  if (given.size !== expected.length || expected.some((item) => !given.has(item.decision_id))) throw mismatch('The decision file does not list the items this bundle raises (missing, extra or stale items); draft it again from this bundle.');
  for (const item of expected) if (canonicalJson(comparable(given.get(item.decision_id))) !== canonicalJson(comparable(item))) throw mismatch('An item in the decision file is stale or does not match the bundle row it names; draft it again from this bundle.');

  const indexes = new Map();
  const rowOf = (name, hash) => { if (!indexes.has(name)) indexes.set(name, rowIndex(tables[name] ?? [])); return indexes.get(name).get(hash); };
  const entities = tables.entities ?? []; const observations = tables.observations ?? []; const images = tables.images ?? []; const relations = tables.relations ?? [];
  const countBy = (rows, column) => { const counts = new Map(); for (const row of rows) { const key = String(row[column]); counts.set(key, (counts.get(key) ?? 0) + 1); } return counts; };
  const observationsPerEntity = countBy(observations, 'entity_id'); const imagesPerEntity = countBy(images, 'entity_id');
  const namedInRelations = new Map(); for (const row of relations) for (const column of ['from_entity', 'to_entity']) if (typeof row[column] === 'string') namedInRelations.set(row[column], (namedInRelations.get(row[column]) ?? 0) + 1);
  const entitySummary = (row) => [String(row.id), boundedText(row.name), boundedText(row.entity_type ?? row.kind), boundedText(row.primary_context), boundedText(row.salience), boundedText(row.created_at), boundedText(row.updated_at), String(observationsPerEntity.get(String(row.id)) ?? 0), String(imagesPerEntity.get(String(row.id)) ?? 0), String(namedInRelations.get(row.name) ?? 0)];
  const ENTITY_COLUMNS = ['id', 'name', 'kind', 'context', 'salience', 'created', 'updated', 'observations', 'images', 'relations naming it'];
  const previews = (entityId) => observations.filter((row) => String(row.entity_id) === String(entityId)).slice(0, 3).map((row) => [String(row.id), boundedText(row.content, MAX_PREVIEW)]);

  const ordered = [...expected].sort((a, b) => (TYPE_ORDER.indexOf(a.type) === -1 ? 99 : TYPE_ORDER.indexOf(a.type)) - (TYPE_ORDER.indexOf(b.type) === -1 ? 99 : TYPE_ORDER.indexOf(b.type)) || a.source_table.localeCompare(b.source_table) || String(a.source_id).localeCompare(String(b.source_id), undefined, { numeric: true }) || String(a.field ?? '').localeCompare(String(b.field ?? '')));
  const items = ordered.map((item, index) => {
    const row = rowOf(item.source_table, item.source_row_sha256);
    const entry = given.get(item.decision_id);
    const sections = [];
    const observedValue = row !== undefined && item.field !== undefined && item.field !== null ? row[item.field] : undefined;

    if (item.type === 'duplicate-entity-name') {
      const colliding = (item.collision_ids ?? []).map((id) => entities.find((candidate) => String(candidate.id) === String(id))).filter((candidate) => candidate !== undefined);
      sections.push(table('The entities that share the name', ENTITY_COLUMNS, colliding.map(entitySummary)));
      for (const candidate of colliding) { const shown = previews(candidate.id); if (shown.length > 0) sections.push(table(`The first observations of entity ${String(candidate.id)}`, ['observation', 'content'], shown)); }
    } else if (item.type === 'entity-kind') {
      sections.push(facts('The value in question', [['kind the source holds', boundedText(observedValue)]]));
      if (row !== undefined) sections.push(table('The entity', ENTITY_COLUMNS, [entitySummary(row)]));
      const shown = row === undefined ? [] : previews(row.id);
      if (shown.length > 0) sections.push(table('Its first observations', ['observation', 'content'], shown));
      sections.push(facts('Kinds v4 allows', [['people (map-to-person)', [...PERSON_KINDS].join(', ')], ['nodes (map-to-node)', [...NODE_KINDS].join(', ')]]));
    } else if (item.type === 'timestamp') {
      const pairs = [['the time the source holds', boundedText(observedValue)]];
      if (typeof observedValue === 'string' && item.allowed_choices.includes('normalize-utc')) {
        const preview = (timezone) => { try { return normalizeTimestamp(observedValue, { choice: { action: 'normalize-utc', timezone }, table: item.source_table, field: item.field }); } catch { return 'cannot be read'; } };
        pairs.push(['stored as, if the timezone is UTC', preview('UTC')], ['stored as, if the timezone is +01:00', preview('+01:00')], ['stored as, if the timezone is -05:00', preview('-05:00')]);
      }
      sections.push(facts(`The value in question (${item.source_table}.${item.field})`, pairs));
      sections.push(rowFacts(row, 'The row it is in'));
    } else if (item.type === 'date') {
      sections.push(facts(`The value in question (${item.source_table}.${item.field})`, [['the date the source holds', boundedText(observedValue)]]));
      sections.push(rowFacts(row, 'The row it is in'));
    } else if (item.type === 'malformed-json') {
      sections.push(facts(`The value in question (${item.source_table}.${item.field})`, [['the text the source holds', boundedText(observedValue)], ['the shape v4 expects', String(item.expected_shape)]]));
      sections.push(rowFacts(row, 'The row it is in'));
    } else if (item.type === 'unknown-value') {
      const allowed = ENUMS[item.field] === undefined ? (item.field === 'primary_context' || item.field === 'context' || item.field === 'scope' ? [...contextVocabulary(item.source_table, item.field)] : undefined) : [...ENUMS[item.field]];
      const strayNote = item.source_table === 'observations' && item.field === 'context' ? [['note', "v4's own migration stores any other observation context as default; here the choice is yours"]] : [];
      sections.push(facts(`The value in question (${item.source_table}.${item.field})`, [['the value the source holds', boundedText(observedValue)], ...(allowed === undefined ? [] : [['values v4 accepts', allowed.join(', ')]]), ...strayNote]));
      sections.push(rowFacts(row, 'The row it is in'));
    } else if (item.type === 'broken-foreign-key') {
      sections.push(facts(`The reference in question (${item.source_table}.${item.field})`, [['points at', `${item.target_table} id ${boundedText(item.target_id)}, which the bundle does not hold`]]));
      sections.push(rowFacts(row, 'The row that holds the reference'));
      if (item.target_table === 'entities') sections.push(table(`Entities you could link it to${entities.length > MAX_ROWS ? ` (the first ${MAX_ROWS} of ${entities.length})` : ''}`, ENTITY_COLUMNS, entities.slice(0, MAX_ROWS).map(entitySummary)));
      else sections.push(facts('Rows you could link it to', [[item.target_table, `${(tables[item.target_table] ?? []).length} rows; give the id of one that exists`]]));
    } else if (item.type === 'broken-name-reference' || item.type === 'ambiguous-name-reference') {
      const name = observedValue;
      sections.push(facts(`The name in question (${item.source_table}.${item.field})`, [['the name the relation holds', boundedText(name)]]));
      sections.push(rowFacts(row, 'The relation'));
      const exact = entities.filter((candidate) => candidate.name === name);
      const close = entities.filter((candidate) => candidate.name !== name && typeof candidate.name === 'string' && typeof name === 'string' && (candidate.name.toLowerCase() === name.toLowerCase() || candidate.name.toLowerCase().includes(name.toLowerCase()) || name.toLowerCase().includes(candidate.name.toLowerCase())));
      const candidates = (item.type === 'ambiguous-name-reference' ? exact : (close.length > 0 ? close : entities)).slice(0, MAX_ROWS);
      sections.push(table(item.type === 'ambiguous-name-reference' ? 'The entities with that name' : (close.length > 0 ? 'Entities with a similar name' : `No similar name; the first ${Math.min(MAX_ROWS, entities.length)} of ${entities.length} entities`), ENTITY_COLUMNS, candidates.map(entitySummary)));
    } else {
      sections.push(rowFacts(row, `The row (${item.source_table} ${boundedText(item.source_id)})`));
      if (item.field !== undefined && item.field !== null && observedValue !== undefined) sections.unshift(facts(`The value in question (${item.source_table}.${item.field})`, [['the value the source holds', boundedText(observedValue)]]));
    }

    const needs = item.required_choice_fields ?? {};
    const shownChoices = item.allowed_choices.map((action) => ({ action, consequence: item.type === 'duplicate-entity-name' && action === 'exclude-row' ? 'EVERY entity listed above is left out of v4 (not only one of them), and so is everything that depends on them (observations, images, links); each is listed as a loss in the report. Nothing is deleted from the source.' : (CONSEQUENCES[action] ?? 'See the migration guide for what this choice does.'), needs: needs[action] ?? [], write_as: WRITE_AS[action] ?? JSON.stringify(action) }));
    const recorded = Object.hasOwn(entry, 'choice') ? { choice: choiceDisplay(entry.choice), stated_by: typeof entry.stated_by === 'string' ? entry.stated_by : null, bulk_rule: typeof entry.bulk_rule === 'string' ? boundedText(entry.bulk_rule, 600) : null } : null;
    return {
      number: index + 1, decision_id: item.decision_id, type: item.type, heading: TYPE_HEADINGS[item.type] ?? item.type, table: item.source_table, source_id: boundedText(item.source_id), field: item.field ?? null,
      why: item.reason, status: recorded === null ? 'open' : 'recorded', recorded, sections, choices: shownChoices,
    };
  });
  const recordedCount = items.filter((entry) => entry.recorded !== null).length;
  return {
    migration_id: bundle.migration_id, bundle_manifest_sha256: bundle.bundle_manifest_sha256, decisions_manifest_sha256: typeof decisions.manifest_sha256 === 'string' ? decisions.manifest_sha256 : null,
    decisions_reviewed: decisions.reviewed === true, notice: REVIEW_NOTICE,
    counts: { items: items.length, open: items.length - recordedCount, recorded: recordedCount }, items,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Terminal rendering

function wrap(text, indent, width = 100) {
  const words = String(text).split(/\s+/u); const lines = []; let line = '';
  for (const word of words) { if (line.length + word.length + 1 > width - indent.length && line !== '') { lines.push(indent + line); line = word; } else line = line === '' ? word : `${line} ${word}`; }
  if (line !== '') lines.push(indent + line);
  return lines.join('\n');
}

export function renderText(model) {
  const out = [];
  out.push('='.repeat(100), wrap(`WARNING: ${model.notice}`, ''), '='.repeat(100), '');
  out.push(`Migration: ${model.migration_id}`, `Bundle:    ${model.bundle_manifest_sha256}`, `Decisions: ${model.decisions_manifest_sha256 ?? 'unhashed'} (${model.decisions_reviewed ? 'reviewed' : 'a draft'})`);
  out.push(`Items:     ${model.counts.items} (${model.counts.open} open, ${model.counts.recorded} with a recorded choice)`, '');
  if (model.items.length === 0) out.push('Nothing in this bundle needs a decision.');
  for (const item of model.items) {
    out.push('-'.repeat(100));
    out.push(`[${item.number}/${model.counts.items}] ${item.heading}   (${item.type}, ${item.status.toUpperCase()})`);
    out.push(`  Item:  ${item.decision_id}`, `  Where: ${item.table} ${item.source_id}${item.field === null ? '' : `, column ${item.field}`}`);
    out.push(wrap(`Why it needs you: ${item.why}`, '  '));
    if (item.recorded !== null) out.push(`  Recorded choice: ${item.recorded.choice}`, `    stated by: ${item.recorded.stated_by ?? 'NOT RECORDED'}${item.recorded.bulk_rule === null ? '' : `; bulk rule: ${item.recorded.bulk_rule}`}`);
    for (const section of item.sections) {
      out.push('', `  ${section.title}`);
      if (section.kind === 'facts') for (const [label, value] of section.facts) out.push(wrap(`${label}: ${value}`, '    '));
      else if (section.rows.length === 0) out.push('    (none)');
      else for (const row of section.rows) out.push(wrap(section.columns.map((column, index) => `${column}=${row[index]}`).join('  '), '    '));
    }
    out.push('', '  Choices');
    for (const choice of item.choices) {
      out.push(`    * ${choice.action}`, wrap(choice.consequence, '        '));
      if (choice.needs.length > 0) out.push(`        needs: ${choice.needs.join(', ')}`);
      out.push(wrap(`write as: ${choice.write_as}`, '        '));
    }
    out.push('');
  }
  out.push('='.repeat(100), wrap(`${model.notice}`, ''), '');
  return `${out.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------------------
// HTML rendering: one file, no scripts, no network. The page loads nothing (a Content-Security-Policy says so
// as well), links to nothing, and uses the reader's own fonts.

const escapeHtml = (value) => String(value).replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&#39;');
// forbids every load (scripts, images, fonts, frames, connections, forms, base) and allows only the page's own inline style
export const HTML_CSP = "default-src 'none'; style-src 'unsafe-inline'";
const STYLE = `
:root { color-scheme: light dark; --bg: #fbfaf7; --fg: #1c1b19; --muted: #5d5a54; --line: #d8d4ca; --card: #ffffff; --warn-bg: #fff1cc; --warn-fg: #4a3500; --accent: #1f5f8b; }
@media (prefers-color-scheme: dark) { :root { --bg: #16150f; --fg: #ece9e0; --muted: #a8a397; --line: #3a372e; --card: #1f1d16; --warn-bg: #3a2e07; --warn-fg: #ffe9a8; --accent: #7fb6dc; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 16px; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
main { max-width: 60rem; margin: 0 auto; }
h1 { font-size: 1.5rem; margin: 0 0 .5rem; }
h2 { font-size: 1.15rem; margin: 0 0 .25rem; }
h3 { font-size: .95rem; margin: 1rem 0 .25rem; color: var(--muted); text-transform: none; }
.warn { background: var(--warn-bg); color: var(--warn-fg); border: 2px solid var(--warn-fg); border-radius: 8px; padding: 12px 16px; margin: 0 0 16px; font-weight: 600; }
.meta { color: var(--muted); font-size: .9rem; margin: 0 0 16px; overflow-wrap: anywhere; }
article { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px 16px; margin: 0 0 16px; }
.tag { display: inline-block; font-size: .75rem; border: 1px solid var(--line); border-radius: 999px; padding: 0 .6rem; margin-left: .5rem; color: var(--muted); }
.tag.open { color: var(--warn-fg); background: var(--warn-bg); border-color: var(--warn-fg); }
dl { margin: 0; display: grid; grid-template-columns: minmax(8rem, 14rem) 1fr; gap: .25rem 1rem; }
dt { color: var(--muted); }
dd { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace; font-size: .9rem; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; font-size: .85rem; width: 100%; }
th, td { border: 1px solid var(--line); padding: .25rem .5rem; text-align: left; vertical-align: top; overflow-wrap: anywhere; font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace; }
th { font-family: inherit; color: var(--muted); }
ul.choices { padding-left: 1.25rem; margin: .25rem 0; }
ul.choices li { margin: 0 0 .75rem; }
code { font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace; font-size: .85rem; overflow-wrap: anywhere; }
.recorded { border-left: 4px solid var(--accent); padding-left: 12px; margin: .5rem 0; }
@media (max-width: 40rem) { dl { grid-template-columns: 1fr; } }
`;

export function renderHtml(model) {
  const h = escapeHtml;
  const out = [];
  out.push('<!doctype html>', '<html lang="en">', '<head>', '<meta charset="utf-8">', `<meta http-equiv="Content-Security-Policy" content="${HTML_CSP}">`, '<meta name="viewport" content="width=device-width, initial-scale=1">', '<meta name="referrer" content="no-referrer">', '<title>Decisions to review</title>', `<style>${STYLE}</style>`, '</head>', '<body>', '<main>');
  out.push('<h1>Decisions to review</h1>', `<p class="warn" role="note">${h(model.notice)} Delete this file when you have decided.</p>`);
  out.push(`<p class="meta">Migration ${h(model.migration_id)}<br>Bundle ${h(model.bundle_manifest_sha256)}<br>Decisions ${h(model.decisions_manifest_sha256 ?? 'unhashed')} (${model.decisions_reviewed ? 'reviewed' : 'a draft'})<br>${model.counts.items} items: ${model.counts.open} open, ${model.counts.recorded} with a recorded choice</p>`);
  if (model.items.length === 0) out.push('<p>Nothing in this bundle needs a decision.</p>');
  for (const item of model.items) {
    out.push(`<article id="item-${item.number}">`, `<h2>${item.number}. ${h(item.heading)}<span class="tag ${item.status}">${h(item.status)}</span><span class="tag">${h(item.type)}</span></h2>`);
    out.push(`<p class="meta">Item ${h(item.decision_id)}<br>Where: ${h(item.table)} ${h(item.source_id)}${item.field === null ? '' : `, column ${h(item.field)}`}</p>`, `<p><strong>Why it needs you.</strong> ${h(item.why)}</p>`);
    if (item.recorded !== null) out.push(`<div class="recorded"><strong>Recorded choice</strong><br><code>${h(item.recorded.choice)}</code><br>Stated by: ${h(item.recorded.stated_by ?? 'NOT RECORDED')}${item.recorded.bulk_rule === null ? '' : `<br>Bulk rule: <code>${h(item.recorded.bulk_rule)}</code>`}</div>`);
    for (const section of item.sections) {
      out.push(`<h3>${h(section.title)}</h3>`);
      if (section.kind === 'facts') out.push('<dl>', ...section.facts.map(([label, value]) => `<dt>${h(label)}</dt><dd>${h(value)}</dd>`), '</dl>');
      else if (section.rows.length === 0) out.push('<p>(none)</p>');
      else out.push('<div class="scroll"><table>', `<thead><tr>${section.columns.map((column) => `<th>${h(column)}</th>`).join('')}</tr></thead>`, '<tbody>', ...section.rows.map((row) => `<tr>${row.map((cell) => `<td>${h(cell)}</td>`).join('')}</tr>`), '</tbody></table></div>');
    }
    out.push('<h3>Choices</h3>', '<ul class="choices">');
    for (const choice of item.choices) out.push(`<li><strong>${h(choice.action)}</strong><br>${h(choice.consequence)}${choice.needs.length > 0 ? `<br>Needs: ${h(choice.needs.join(', '))}` : ''}<br>Write as: <code>${h(choice.write_as)}</code></li>`);
    out.push('</ul>', '</article>');
  }
  out.push(`<p class="warn" role="note">${h(model.notice)}</p>`, '</main>', '</body>', '</html>');
  return `${out.join('\n')}\n`;
}
