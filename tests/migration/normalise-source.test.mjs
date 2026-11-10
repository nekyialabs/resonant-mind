import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { repositoryRoot, runCli } from './helpers/cli-run.mjs';
import { createSqliteSource } from './helpers/seeds.mjs';

// normalise-source: a drifted v3.2 source (issue #21) rebuilt into the exact v3.2 schema on a copy, with everything
// that is not v3.2 set aside. The data is made up; see tests/fixtures/migration/v3.2-drifted/README.md.
const work = mkdtempSync(join(tmpdir(), 'rmig-normalise-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const file = (name) => join(work, name);
const V32 = join(repositoryRoot, 'tests', 'fixtures', 'migration', 'v3.2');
const DRIFT = readFileSync(join(repositoryRoot, 'tests', 'fixtures', 'migration', 'v3.2-drifted', 'drift.sql'), 'utf8');
const DRIFTED_EXPORT = join(repositoryRoot, 'tests', 'fixtures', 'migration', 'v3.2-drifted', 'drifted-d1-export.sql');
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

let counter = 0;
const fresh = () => { counter += 1; return { out: file(`out-${counter}.sqlite`), setAside: file(`set-aside-${counter}.json`), report: file(`report-${counter}.json`) }; };

/** The exact v3.2 schema, the drift on top of it (made-up rows), and then whatever a test adds. */
function buildDrifted(path, extra = '') {
  const database = new DatabaseSync(path, { enableForeignKeyConstraints: false });
  try {
    for (const name of ['0001_init.sql', '0002_enhanced_memory.sql', '0003_graph_health.sql']) database.exec(readFileSync(join(V32, 'd1', name), 'utf8'));
    database.exec(DRIFT);
    if (extra) database.exec(extra);
  } finally { database.close(); }
  return path;
}

function normalise(kind, source, paths, flags = []) {
  return runCli(['normalise-source', '--source-kind', kind, '--source', source, '--out', paths.out, '--set-aside', paths.setAside, '--report', paths.report, ...flags, '--json']);
}
const reportOf = (paths) => JSON.parse(readFileSync(paths.report, 'utf8')).details;
const FLAG = ['--null-context-default'];

describe('normalise-source on the drifted replica', () => {
  it.each([['d1-export', DRIFTED_EXPORT], ['sqlite', 'built']])('refuses a NULL in a required column until the explicit choice is given (%s)', (kind, source) => {
    const input = source === 'built' ? buildDrifted(file('drifted-a.sqlite')) : source;
    const paths = fresh();
    const refused = normalise(kind, input, paths);
    expect(refused.status, refused.output).toBe(2);
    expect(JSON.parse(refused.stdout)).toMatchObject({ code: 'RMIG-E-NORMALISE-UNRESOLVED', phase: 'normalise-source', report_path: paths.report });
    // nothing is built, and the report says what is unresolved, by id and without content
    expect(existsSync(paths.out)).toBe(false);
    expect(existsSync(paths.setAside)).toBe(false);
    const details = reportOf(paths);
    expect(details.unresolved).toEqual([{ type: 'null-in-required-column', table: 'entities', column: 'primary_context', count: 1, ids: [2], choice_flag: '--null-context-default' }]);
    expect(JSON.parse(readFileSync(paths.report, 'utf8')).status).toBe('refused');
  });

  it('normalises a real wrangler export of the drifted D1: v3.2 shape, shared columns carried, the rest set aside', () => {
    const paths = fresh();
    const before = sha256(DRIFTED_EXPORT);
    const run = normalise('d1-export', DRIFTED_EXPORT, paths, FLAG);
    expect(run.status, run.output).toBe(0);
    expect(sha256(DRIFTED_EXPORT)).toBe(before);
    const details = reportOf(paths);
    expect(details.unresolved).toEqual([]);
    expect(details.resolved).toEqual([{ type: 'null-defaulted', table: 'entities', column: 'primary_context', rows: 1, value: 'default', choice_flag: '--null-context-default' }]);
    expect(details.foreign_key_violations).toBe(0);
    expect(details.integrity_check).toBe('ok');
    // every v3.2 table: the rows in equal the rows out
    expect(Object.keys(details.tables)).toHaveLength(16);
    for (const [table, entry] of Object.entries(details.tables)) expect(entry.rows_copied, table).toBe(entry.source_rows);
    expect(details.tables.entities).toMatchObject({ source_rows: 3, rows_copied: 3, set_aside_columns: [] });
    expect(details.tables.images).toMatchObject({ source_rows: 2, rows_copied: 2, set_aside_columns: ['charge', 'last_viewed_at', 'view_count'], set_aside_column_rows: 2 });
    expect(details.tables.journals.v32_only_columns).toEqual(['journal_type']);
    // the NULL context took v3.2's own default, and nothing else changed
    const out = new DatabaseSync(paths.out, { readOnly: true });
    try {
      expect(out.prepare('SELECT id, primary_context FROM entities ORDER BY id').all().map((row) => ({ ...row }))).toEqual([{ id: 1, primary_context: 'default' }, { id: 2, primary_context: 'default' }, { id: 3, primary_context: 'default' }]);
      expect(out.prepare('SELECT count(*) AS n FROM observations').get().n).toBe(4);
      expect(out.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()).toHaveLength(16);
      expect(out.prepare('SELECT count(*) AS n FROM pragma_table_info(\'images\') WHERE name IN (\'charge\', \'view_count\', \'last_viewed_at\')').get().n).toBe(0);
    } finally { out.close(); }
    // set aside: non-v3.2 columns by primary key, non-null values only; non-v3.2 tables whole
    const setAside = JSON.parse(readFileSync(paths.setAside, 'utf8'));
    expect(setAside.format).toBe('rmig-set-aside/1');
    expect(setAside.columns.images).toEqual({ key: ['id'], columns: ['charge', 'last_viewed_at', 'view_count'], rows: [
      { key: { id: 1 }, values: { charge: 'active', last_viewed_at: '2026-05-01 10:00:00', view_count: 4 } },
      { key: { id: 2 }, values: { charge: 'fresh', view_count: 0 } },
    ] });
    expect(setAside.columns.observations.rows).toEqual([{ key: { id: 2 }, values: { last_sat_at: '2026-05-20 08:00:00' } }, { key: { id: 4 }, values: { last_sat_at: '2026-05-21 21:00:00' } }]);
    expect(setAside.tables.observation_sits.rows).toEqual([{ id: 1, observation_id: 2, sit_note: 'sat with this', sat_at: '2026-05-20 08:00:00' }]);
    expect(setAside.tables.observation_sits.ddl).toMatch(/^CREATE TABLE observation_sits/u);
    expect(Object.keys(setAside.tables).sort()).toEqual(['consolidation_candidates', 'd1_migrations', 'note_sits', 'notes', 'observation_sits', 'orphan_observations', 'reflection_journals', 'session_chunks', 'vault_chunks']);
    expect(details.set_aside_tables.observation_sits).toBe(1);
    expect(details.ignored_source_objects).toEqual([]);
    // the report holds no memory content
    const reportText = readFileSync(paths.report, 'utf8');
    for (const content of ['likes early mornings', 'sat with this', 'the garden at dusk']) expect(reportText).not.toContain(content);
    // never in place: the same paths again are refused, and the files are untouched
    const outHash = sha256(paths.out);
    const again = normalise('d1-export', DRIFTED_EXPORT, paths, FLAG);
    expect(again.status).toBe(2);
    expect(JSON.parse(again.stdout)).toMatchObject({ code: 'RMIG-E-SOURCE-ARG' });
    expect(sha256(paths.out)).toBe(outHash);
  });

  it('the normalised database is supported by inspect-source, exports, verifies and drafts decisions with nothing it cannot place', () => {
    const paths = fresh();
    expect(normalise('d1-export', DRIFTED_EXPORT, paths, FLAG).status).toBe(0);
    writeFileSync(file('pass'), 'normalise-source-passphrase', { mode: 0o600 });
    const inspect = runCli(['inspect-source', '--source-kind', 'sqlite', '--source', paths.out, '--report', file('inspect.json')]);
    expect(inspect.status, inspect.output).toBe(0);
    expect(inspect.stdout).toMatch(/^inspect-source: supported sqlite; tables=16; rows=13;/u);
    const exported = runCli(['export', '--source-kind', 'sqlite', '--source', paths.out, '--source-report', file('inspect.json'), '--migration-id', 'rmig_normalised_01', '--bundle', file('bundle.rmigrate'), '--passphrase-file', file('pass')]);
    expect(exported.status, exported.output).toBe(0);
    const verified = runCli(['verify-bundle', '--bundle', file('bundle.rmigrate'), '--passphrase-file', file('pass')]);
    expect(verified.status, verified.output).toBe(0);
    expect(verified.stdout).toMatch(/^verify-bundle: valid;/u);
    const draft = runCli(['draft-decisions', '--bundle', file('bundle.rmigrate'), '--passphrase-file', file('pass'), '--out', file('decisions.json')]);
    expect(draft.status, draft.output).toBe(0);
    expect(draft.stdout).toMatch(/^draft-decisions: complete; items=0;/u);
  }, 120_000);

  it('normalises a SQLite file the same way, and leaves the source file byte for byte as it was', () => {
    const source = buildDrifted(file('drifted-b.sqlite'));
    const before = { hash: sha256(source), mtime: statSync(source).mtimeMs };
    const paths = fresh();
    const run = normalise('sqlite', source, paths, FLAG);
    expect(run.status, run.output).toBe(0);
    expect({ hash: sha256(source), mtime: statSync(source).mtimeMs }).toEqual(before);
    const fromD1 = fresh();
    expect(normalise('d1-export', DRIFTED_EXPORT, fromD1, FLAG).status).toBe(0);
    expect(JSON.parse(readFileSync(paths.setAside, 'utf8')).columns).toEqual(JSON.parse(readFileSync(fromD1.setAside, 'utf8')).columns);
    expect(reportOf(paths).tables).toEqual(reportOf(fromD1).tables);
  });

  it('never guesses a rename: tensions.visits goes to set-aside, sit_count takes its default, and the report lists the pair', () => {
    const source = buildDrifted(file('drifted-c.sqlite'), "INSERT INTO tensions (id, pole_a, pole_b, visits, last_visited) VALUES ('x1', 'rest', 'work', 5, '2026-06-01 09:00:00');");
    const paths = fresh();
    const run = normalise('sqlite', source, paths, FLAG);
    expect(run.status, run.output).toBe(0);
    const details = reportOf(paths);
    const pair = details.possible_renames.find((item) => item.table === 'tensions');
    expect(pair.source_columns_not_in_v32).toEqual(['visits', 'last_visited']);
    expect(pair.v32_columns_not_in_source).toEqual(['sit_count', 'sit_notes', 'status']);
    expect(details.possible_renames.map((item) => item.table).sort()).toEqual(['observation_versions', 'observations', 'tensions']);
    expect(JSON.parse(readFileSync(paths.setAside, 'utf8')).columns.tensions.rows).toEqual([{ key: { id: 'x1' }, values: { visits: 5, last_visited: '2026-06-01 09:00:00' } }]);
    const out = new DatabaseSync(paths.out, { readOnly: true });
    try { expect({ ...out.prepare("SELECT id, sit_count, status FROM tensions").get() }).toEqual({ id: 'x1', sit_count: 0, status: 'active' }); } finally { out.close(); }
  });

  it('keeps AUTOINCREMENT ids counting from where the source stopped', () => {
    const source = buildDrifted(file('drifted-d.sqlite'), "INSERT INTO journals (id, entry_date, content) VALUES (50, '2026-07-01', 'x'); DELETE FROM journals WHERE id = 50;");
    const paths = fresh();
    expect(normalise('sqlite', source, paths, FLAG).status).toBe(0);
    const out = new DatabaseSync(paths.out, { readOnly: true });
    try { expect(out.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'journals'").get().seq).toBe(50); } finally { out.close(); }
  });
});

describe('normalise-source refusals', () => {
  it.each([
    ['an entity with no context has the name of an entity in default', "INSERT INTO entities (id, name, entity_type, primary_context) VALUES (10, 'Alder', 'person', NULL);", [10]],
    ['two entities with no context share a name', "INSERT INTO entities (id, name, entity_type, primary_context) VALUES (11, 'Moss', 'concept', NULL), (12, 'Moss', 'concept', NULL);", [11, 12]],
  ])('refuses the choice when it would collide on UNIQUE(name, primary_context): %s', (_label, extra, ids) => {
    const source = buildDrifted(file(`collide-${ids[0]}.sqlite`), extra);
    const paths = fresh();
    const refused = normalise('sqlite', source, paths, FLAG);
    expect(refused.status, refused.output).toBe(2);
    expect(JSON.parse(refused.stdout)).toMatchObject({ code: 'RMIG-E-NORMALISE-UNRESOLVED' });
    expect(existsSync(paths.out)).toBe(false);
    expect(existsSync(paths.setAside)).toBe(false);
    const collision = reportOf(paths).unresolved.find((item) => item.type === 'choice-collides');
    expect(collision).toMatchObject({ table: 'entities', column: 'primary_context', value: 'default', constraint: 'UNIQUE(name, primary_context)', ids });
  });

  it('refuses a NULL in any other NOT NULL column: there is no switch for it', () => {
    const source = buildDrifted(file('null-other.sqlite'), "DROP TABLE threads; CREATE TABLE threads (id TEXT PRIMARY KEY, thread_type TEXT NOT NULL, content TEXT, context TEXT, priority TEXT, status TEXT, source TEXT, created_at TEXT, updated_at TEXT, resolved_at TEXT, resolution TEXT); INSERT INTO threads (id, thread_type, content) VALUES ('t9', 'intention', NULL);");
    const paths = fresh();
    const refused = normalise('sqlite', source, paths, FLAG);
    expect(refused.status, refused.output).toBe(2);
    expect(reportOf(paths).unresolved).toEqual([{ type: 'null-in-required-column', table: 'threads', column: 'content', count: 1, ids: ['t9'], choice_flag: null }]);
    expect(existsSync(paths.out)).toBe(false);
  });

  it('refuses a required v3.2 column the source does not have (no default to take)', () => {
    const missing = buildDrifted(file('missing-col.sqlite'), "DROP TABLE journals; CREATE TABLE journals (id INTEGER PRIMARY KEY AUTOINCREMENT, note TEXT); INSERT INTO journals (note) VALUES ('a');");
    const paths = fresh();
    const refused = normalise('sqlite', missing, paths, FLAG);
    expect(refused.status, refused.output).toBe(2);
    expect(reportOf(paths).unresolved.map((item) => `${item.type}:${item.table}.${item.column}`).sort()).toEqual(['required-column-missing:journals.content']);
    expect(existsSync(paths.out)).toBe(false);
  });

  it('exits non-zero and keeps nothing when the result has a foreign-key violation', () => {
    const source = buildDrifted(file('fk.sqlite'), "INSERT INTO observations (id, entity_id, content) VALUES (99, 777, 'an orphan');");
    const paths = fresh();
    const refused = normalise('sqlite', source, paths, FLAG);
    expect(refused.status, refused.output).toBe(2);
    expect(JSON.parse(refused.stdout)).toMatchObject({ code: 'RMIG-E-NORMALISE-FAILED' });
    expect(existsSync(paths.out)).toBe(false);
    expect(existsSync(paths.setAside)).toBe(false);
    expect(reportOf(paths).unresolved).toEqual([{ type: 'foreign-key-violations', count: 1, tables: ['observations'] }]);
    expect(reportOf(paths).foreign_key_violations).toBe(1);
  });

  it('never overwrites an existing output, and never writes over the source', () => {
    const source = buildDrifted(file('exists.sqlite'));
    for (const which of ['out', 'setAside', 'report']) {
      const paths = fresh();
      writeFileSync(paths[which], 'keep me');
      const refused = normalise('sqlite', source, paths, FLAG);
      expect(refused.status, which).toBe(2);
      expect(refused.stdout, which).toMatch(/already exists/u);
      expect(readFileSync(paths[which], 'utf8'), which).toBe('keep me');
      for (const other of ['out', 'setAside', 'report'].filter((name) => name !== which)) expect(existsSync(paths[other]), `${which}/${other}`).toBe(false);
    }
    const paths = fresh();
    const inPlace = runCli(['normalise-source', '--source-kind', 'sqlite', '--source', source, '--out', source, '--set-aside', paths.setAside, '--report', paths.report, ...FLAG, '--json']);
    expect(inPlace.status).toBe(2);
    expect(JSON.parse(inPlace.stdout).code).toMatch(/RMIG-E-(?:SOURCE-ARG|SAME-SOURCE-TARGET)/u);
    const same = fresh();
    const twice = runCli(['normalise-source', '--source-kind', 'sqlite', '--source', source, '--out', same.out, '--set-aside', same.out, '--report', same.report, '--json']);
    expect(twice.status).toBe(2);
  });

  it('refuses a bad argument list, a remote name and a file that is not a database', () => {
    const paths = fresh();
    expect(runCli(['normalise-source', '--source-kind', 'postgres', '--source', 'x', '--out', paths.out, '--set-aside', paths.setAside, '--report', paths.report]).status).toBe(2);
    expect(runCli(['normalise-source', '--source-kind', 'sqlite', '--source', 'x']).status).toBe(2);
    expect(runCli(['normalise-source', '--source-kind', 'sqlite', '--source', 'x', '--out', paths.out, '--set-aside', paths.setAside, '--report', paths.report, '--guess-renames']).status).toBe(2);
    const remote = runCli(['normalise-source', '--source-kind', 'd1-export', '--source', 'https://example.com/db.sql', '--out', paths.out, '--set-aside', paths.setAside, '--report', paths.report, '--json']);
    expect(JSON.parse(remote.stdout).code).toBe('RMIG-E-D1-REMOTE-UNSUPPORTED');
    writeFileSync(file('garbage.sqlite'), 'this is not a database');
    const garbage = runCli(['normalise-source', '--source-kind', 'sqlite', '--source', file('garbage.sqlite'), '--out', paths.out, '--set-aside', paths.setAside, '--report', paths.report, '--json']);
    expect(garbage.status).toBe(2);
    expect(existsSync(paths.out)).toBe(false);
  });

  it('an exact v3.2 source passes through unchanged with nothing to set aside', () => {
    createSqliteSource(file('exact.sqlite'));
    const paths = fresh();
    const run = normalise('sqlite', file('exact.sqlite'), paths);
    expect(run.status, run.output).toBe(0);
    const details = reportOf(paths);
    expect(details.possible_renames).toEqual([]);
    expect(details.counts).toMatchObject({ set_aside_columns: 0, set_aside_tables: 0, unresolved: 0 });
    const setAside = JSON.parse(readFileSync(paths.setAside, 'utf8'));
    expect(setAside.columns).toEqual({});
    expect(setAside.tables).toEqual({});
    const inspected = runCli(['inspect-source', '--source-kind', 'sqlite', '--source', paths.out, '--report', file('exact-inspect.json'), '--json']);
    const original = runCli(['inspect-source', '--source-kind', 'sqlite', '--source', file('exact.sqlite'), '--report', file('exact-inspect-original.json'), '--json']);
    expect(JSON.parse(inspected.stdout).details.tables).toEqual(JSON.parse(original.stdout).details.tables);
  });
});
