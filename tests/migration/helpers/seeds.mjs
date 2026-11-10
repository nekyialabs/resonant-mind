import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Source data shared by the live and non-live operator-flow tests.
const repo = join(dirname(fileURLToPath(import.meta.url)), '../../..');

// Every v3.2 PostgreSQL table has rows, with the awkward values real databases hold (microsecond
// timestamps, a non-UTC offset, NULLs, unicode, quotes and newlines, self references, JSON in text, vectors).
export const LONG = `${'long line with "quotes", \'apostrophes\', back\\slash and unicode ☃ \u{1F33F}\n'.repeat(200)}end`;

export const RICH_POSTGRES_SEED = `
INSERT INTO entities (id, name, entity_type, primary_context, salience, intentionally_isolated, created_at, updated_at) VALUES
  (1, 'Rich Person One', 'person', 'default', 'foundational', 0, '2026-01-02 03:04:05.123456+00', '2026-01-03 03:04:05+00'),
  (2, 'Rich Person Two', 'person', 'default', 'active', 0, '2026-01-02 03:04:06.5+00', NULL),
  (7, 'Garden ☃ naïve', 'concept', 'default', 'active', 1, '2026-02-01 12:00:00+01', '2026-02-01 12:00:00+01');
INSERT INTO observations (id, entity_id, content, salience, emotion, weight, certainty, source, source_date, context, charge, charge_note, sit_count, novelty_score, last_surfaced_at, surface_count, archived_at, added_at, resolved_at, resolution_note, linked_observation_id, access_count, last_accessed_at, valid_from, valid_until, superseded_by, supersedes) VALUES
  (3, 1, $$${LONG}$$, 'active', 'warm', 'heavy', 'known', 'conversation', '2026-01-02', 'default', 'processing', 'a note', 2, 0.25, '2026-03-01 00:00:00.000001+00', 4, NULL, '2026-01-02 04:00:00.987654+00', NULL, NULL, NULL, 9, '2026-03-02 10:00:00+00', '2026-01-01 00:00:00+00', NULL, NULL, NULL),
  (5, 1, 'second observation, ''quoted'' and "double"', 'active', NULL, 'medium', 'believed', 'conversation', NULL, 'default', NULL, NULL, 0, 1.0, NULL, 0, '2026-04-01 00:00:00+00', '2026-01-02 04:00:01+00', '2026-04-02 00:00:00+00', 'settled', 3, 0, NULL, NULL, NULL, NULL, NULL),
  (9, 2, 'third, about the garden', 'active', 'calm', 'light', 'believed', 'conversation', NULL, 'default', NULL, NULL, 0, 0.5, NULL, 0, NULL, '2026-01-05 08:30:00-05', NULL, NULL, NULL, 1, '2026-01-06 00:00:00+00', NULL, '2026-12-31 00:00:00+00', 5, 3);
INSERT INTO observation_versions (id, observation_id, content, weight, emotion, changed_at) VALUES
  (1, 3, 'earlier wording', 'medium', 'warm', '2026-01-02 05:00:00.5+00'),
  (2, 3, 'earlier still', NULL, NULL, '2026-01-02 04:30:00+00');
INSERT INTO relations (id, from_entity, to_entity, relation_type, from_context, to_context, store_in, created_at) VALUES
  (1, 'Rich Person One', 'Rich Person Two', 'knows', 'default', 'default', 'default', '2026-01-02 06:00:00+00'),
  (2, 'Rich Person One', 'Garden ☃ naïve', 'tends', 'default', 'default', 'default', '2026-01-02 06:00:01+00');
INSERT INTO threads (id, thread_type, content, context, priority, status, source, created_at, updated_at, resolved_at, resolution) VALUES
  ('thr-1', 'intention', 'a thread', 'default', 'high', 'active', 'self', '2026-01-02 07:00:00+00', '2026-01-02 07:00:01+00', NULL, NULL),
  ('thr-2', 'question', 'a resolved thread', NULL, 'low', 'resolved', 'self', '2026-01-02 07:00:00+00', '2026-01-02 07:30:00+00', '2026-01-02 07:30:00+00', 'answered');
INSERT INTO context_entries (id, scope, content, links, updated_at) VALUES
  ('ctx-1', 'work', 'what is happening', '["thr-1"]', '2026-01-02 08:00:00+00');
INSERT INTO relational_state (id, person, feeling, intensity, timestamp) VALUES
  (1, 'Rich Person One', 'fond', 'strong', '2026-01-02 09:00:00+00');
INSERT INTO identity (id, section, content, weight, connections, timestamp) VALUES
  (1, 'core.values', 'curiosity', 0.7, '[]', '2026-01-02 10:00:00+00'),
  (2, 'core.self', 'careful', 0.9, '["core.values"]', '2026-01-02 10:00:01+00');
INSERT INTO journals (id, entry_date, content, tags, emotion, journal_type, created_at) VALUES
  (1, '2026-01-02', 'a journal entry', '["a","b"]', 'content', 'entry', '2026-01-02 11:00:00+00'),
  (2, NULL, 'an undated one', '[]', NULL, 'entry', '2026-01-02 11:00:01+00');
INSERT INTO consolidation_groups (id, summary, entity_id, source_observation_ids, consolidated_observation_id, created_at) VALUES
  (1, 'merged two', 1, '[3,5]', 3, '2026-01-02 12:00:00+00');
INSERT INTO images (id, path, description, context, emotion, weight, entity_id, observation_id, created_at, novelty_score, last_surfaced_at, surface_count, archived_at, access_count, last_accessed_at) VALUES
  (1, 'images/one.png', 'a picture', 'default', 'warm', 'medium', 1, 3, '2026-01-02 13:00:00+00', 1.0, NULL, 0, NULL, 0, NULL);
INSERT INTO subconscious (id, state_type, data, updated_at) VALUES
  (1, 'mood', '{"valence":0.5}', '2026-01-02 14:00:00+00');
INSERT INTO daemon_proposals (id, proposal_type, from_obs_id, to_obs_id, from_entity_id, to_entity_id, reason, confidence, status, proposed_at, resolved_at) VALUES
  (1, 'resonance', 3, 5, 1, 1, 'they keep appearing together', 0.75, 'pending', '2026-01-02 15:00:00+00', NULL);
INSERT INTO tensions (id, pole_a, pole_b, context, sit_count, sit_notes, status, created_at, resolved_at, resolution) VALUES
  ('ten-1', 'speed', 'care', 'default', 2, '["first","second"]', 'active', '2026-01-02 16:00:00+00', NULL, NULL);
INSERT INTO dormant_observations (id, observation_id, first_marked, rescue_attempts, last_rescue_attempt) VALUES
  (1, 5, '2026-01-02 17:00:00+00', 1, '2026-01-03 17:00:00+00');
INSERT INTO co_surfacing (id, obs_a_id, obs_b_id, co_count, last_co_surfaced, relation_proposed, relation_created) VALUES
  (1, 3, 5, 6, '2026-01-02 18:00:00+00', 1, 0);
INSERT INTO embeddings (id, source_type, source_id, embedding, content, metadata) VALUES
  ('observation-3', 'observation', 3, (SELECT array_fill(0.125::real, ARRAY[768])::vector), 'embedded text', '{"k":[1,2],"n":null}'),
  ('observation-5', 'observation', 5, NULL, NULL, '{}');
`;

// A small SQLite v3.2 database that raises every kind of decision item the CLI can draft: a duplicate name,
// an unknown kind, a naive timestamp, a dormant observation, a tension and an ambiguous relation endpoint.
export const SQLITE_SEED = `
INSERT INTO entities (id, name, entity_type, primary_context, salience, created_at, updated_at) VALUES
  (1, 'Ada', 'person', 'default', 'active', '2026-01-02 03:04:05', '2026-01-02 03:04:06'),
  (2, 'Ada', 'concept', 'work', 'active', '2026-01-02 03:04:07', NULL),
  (3, 'Rhizome', 'mycelial', 'default', 'active', '2026-01-03 00:00:00', '2026-01-03 00:00:00');
INSERT INTO observations (id, entity_id, content, weight, source_date, added_at, last_surfaced_at) VALUES
  (10, 1, 'first thought', 'low', '2026-01-02', '2026-01-02 04:00:00', '2026-02-03T04:05:06'),
  (11, 3, 'about the rhizome', 'medium', NULL, '2026-01-04 00:00:00', NULL);
INSERT INTO dormant_observations (id, observation_id, first_marked, rescue_attempts) VALUES (1, 11, '2026-01-05 00:00:00', 2);
INSERT INTO tensions (id, pole_a, pole_b, context, sit_count, sit_notes, status, created_at) VALUES ('t1', 'a', 'b', 'default', 3, '["x"]', 'active', '2026-01-06 00:00:00');
INSERT INTO relations (id, from_entity, to_entity, relation_type, created_at) VALUES (1, 'Ada', 'Rhizome', 'tends', '2026-01-07 00:00:00');
INSERT INTO images (id, path, description, entity_id, observation_id, created_at) VALUES (1, 'images/ada.png', 'a portrait of Ada', 1, 10, '2026-01-08 00:00:00');
`;

/** What the person reviewing the SQLITE_SEED draft decides, by kind of item. The CLI selects nothing itself. */
export const SQLITE_REVIEW = {
  'duplicate-entity-name': { action: 'rename', names: { 1: 'Ada (person)', 2: 'Ada (work)' } },
  'entity-kind': { action: 'map-to-node', kind: 'concept' },
  timestamp: { action: 'normalize-utc', timezone: '+01:00' },
  'dormancy-translation': 'translate-to-orphan',
  'tension-state': { action: 'preserve-visits-and-open', last_visited: '2026-01-07T00:00:00Z' },
  'ambiguous-name-reference': { action: 'link-by-reviewed-id', target_id: 1 },
};

/** What the person reviewing the rich PostgreSQL draft decides. */
export const RICH_REVIEW = {
  'dormancy-translation': 'translate-to-orphan',
  'tension-state': { action: 'preserve-visits-and-open', last_visited: '2026-01-04T00:00:00.000Z' },
};

export function createSqliteSource(path) {
  const database = new DatabaseSync(path);
  try {
    for (const name of ['0001_init.sql', '0002_enhanced_memory.sql', '0003_graph_health.sql']) database.exec(readFileSync(join(repo, 'tests', 'fixtures', 'migration', 'v3.2', 'd1', name), 'utf8'));
    database.exec(SQLITE_SEED);
  } finally { database.close(); }
}

/**
 * The same data as a local D1 SQL export, written the way `wrangler d1 export` writes it (compare
 * tests/fixtures/migration/v3.2/d1-export-stock.sql, a real one): wrangler's own d1_migrations bookkeeping
 * table first, with a row for each migration `wrangler d1 migrations apply` ran, then the schema as SQLite
 * stores it (tables first, then indexes), one INSERT per row, and the sqlite_sequence reset. Every real export
 * has the d1_migrations table, so a test export without it tests something no operator will ever have.
 */
export function createD1Export(path) {
  const database = new DatabaseSync(':memory:');
  try {
    for (const name of ['0001_init.sql', '0002_enhanced_memory.sql', '0003_graph_health.sql']) database.exec(readFileSync(join(repo, 'tests', 'fixtures', 'migration', 'v3.2', 'd1', name), 'utf8'));
    database.exec(SQLITE_SEED);
    const literal = (value) => (value === null ? 'NULL' : typeof value === 'number' ? String(value) : `'${String(value).replaceAll("'", "''")}'`);
    const objects = database.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name").all();
    const migrationNames = ['0001_init.sql', '0002_enhanced_memory.sql', '0003_graph_health.sql'];
    const lines = [
      'PRAGMA defer_foreign_keys=TRUE;',
      // wrangler's own text, tabs included
      ['CREATE TABLE IF NOT EXISTS "d1_migrations"(', '@@id         INTEGER PRIMARY KEY AUTOINCREMENT,', '@@name       TEXT UNIQUE,', '@@applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL', ');'].join(String.fromCharCode(10)).replaceAll('@@', String.fromCharCode(9, 9)),
      ...migrationNames.map((name, index) => `INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(${index + 1},'${name}','2026-01-01 00:00:0${index}');`),
    ];
    for (const object of objects.filter((item) => item.type === 'table')) lines.push(`${object.sql};`);
    // parents before children, so the rows load without deferring any foreign key
    const order = (name) => (name === 'entities' ? 0 : name === 'observations' ? 1 : 2);
    for (const object of objects.filter((item) => item.type === 'table').sort((x, y) => order(x.name) - order(y.name) || x.name.localeCompare(y.name))) {
      for (const row of database.prepare(`SELECT * FROM "${object.name}"`).all()) lines.push(`INSERT INTO "${object.name}" (${Object.keys(row).map((key) => `"${key}"`).join(', ')}) VALUES (${Object.values(row).map(literal).join(', ')});`);
    }
    lines.push('DELETE FROM sqlite_sequence;');
    for (const row of database.prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name').all()) lines.push(`INSERT INTO "sqlite_sequence" ("name","seq") VALUES('${row.name}',${row.seq});`);
    lines.push(`INSERT INTO "sqlite_sequence" ("name","seq") VALUES('d1_migrations',${migrationNames.length});`);
    for (const object of objects.filter((item) => item.type === 'index')) lines.push(`${object.sql};`);
    writeFileSync(path, lines.join(String.fromCharCode(10)) + String.fromCharCode(10));
  } finally { database.close(); }
}
