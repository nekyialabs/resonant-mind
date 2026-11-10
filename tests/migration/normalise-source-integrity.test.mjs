import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { repositoryRoot, runCli } from './helpers/cli-run.mjs';

// normalise-source never reports success while data changed or went missing, and --restore-sql.
const work = mkdtempSync(join(tmpdir(), 'rmig-normalise-integrity-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const file = (name) => join(work, name);
const V32 = join(repositoryRoot, 'tests', 'fixtures', 'migration', 'v3.2');
const DRIFT = readFileSync(join(repositoryRoot, 'tests', 'fixtures', 'migration', 'v3.2-drifted', 'drift.sql'), 'utf8');
const DRIFTED_EXPORT = join(repositoryRoot, 'tests', 'fixtures', 'migration', 'v3.2-drifted', 'drifted-d1-export.sql');
const FLAG = ['--null-context-default'];

let counter = 0;
const fresh = () => { counter += 1; return { out: file(`out-${counter}.sqlite`), setAside: file(`set-aside-${counter}.json`), report: file(`report-${counter}.json`), restore: file(`restore-${counter}.sql`) }; };

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

describe('normalise-source never reports success while data changed or went missing', () => {
  const COSURFACING = 'DROP TABLE co_surfacing; CREATE TABLE co_surfacing (id INTEGER PRIMARY KEY AUTOINCREMENT, obs_a_id INTEGER NOT NULL, obs_b_id INTEGER NOT NULL, co_count, last_co_surfaced TEXT, relation_proposed INTEGER, relation_created INTEGER, UNIQUE (obs_a_id, obs_b_id));';

  it("refuses a value the copy would change: the text '007' and '20260520' in an INTEGER column", () => {
    const source = buildDrifted(file('coerce.sqlite'), `${COSURFACING} INSERT INTO co_surfacing (id, obs_a_id, obs_b_id, co_count) VALUES (1, 1, 2, '007'), (2, 1, 3, '20260520'), (3, 2, 3, 4);`);
    const paths = fresh();
    const refused = normalise('sqlite', source, paths, FLAG);
    expect(refused.status, refused.output).toBe(2);
    expect(JSON.parse(refused.stdout)).toMatchObject({ code: 'RMIG-E-NORMALISE-UNRESOLVED' });
    expect(existsSync(paths.out)).toBe(false);
    expect(existsSync(paths.setAside)).toBe(false);
    // the table, column, row keys and the two typeofs; the row that was an integer already is not listed
    expect(reportOf(paths).unresolved).toEqual([{ type: 'value-changed-by-copy', table: 'co_surfacing', column: 'co_count', source_typeof: 'text', output_typeof: 'integer', count: 2, ids: [1, 2] }]);
    // never the values
    const text = readFileSync(paths.report, 'utf8');
    expect(text).not.toContain('007');
    expect(text).not.toContain('20260520');
  });

  it('does not mistake the NULL choice for a changed value, and compares NULLs', () => {
    const source = buildDrifted(file('nulls-ok.sqlite'), `${COSURFACING} INSERT INTO co_surfacing (id, obs_a_id, obs_b_id, co_count) VALUES (1, 1, 2, NULL), (2, 1, 3, 5);`);
    const paths = fresh();
    expect(normalise('sqlite', source, paths, FLAG).status).toBe(0);
  });

  it('refuses a v3.2 table the source does not have, and writes the report', () => {
    const source = buildDrifted(file('no-table.sqlite'), 'DROP TABLE subconscious;');
    const paths = fresh();
    const refused = normalise('sqlite', source, paths, FLAG);
    expect(refused.status, refused.output).toBe(2);
    expect(JSON.parse(refused.stdout)).toMatchObject({ code: 'RMIG-E-NORMALISE-UNRESOLVED', report_path: paths.report });
    expect(reportOf(paths).unresolved).toEqual([{ type: 'table-missing-from-source', table: 'subconscious' }]);
    expect(reportOf(paths).tables_missing_from_source).toEqual(['subconscious']);
    expect(existsSync(paths.out)).toBe(false);
  });

  it('refuses a source that lacks a v3.2 primary-key column, with a report and no crash (AUTOINCREMENT would renumber)', () => {
    const source = buildDrifted(file('no-key.sqlite'), "DROP TABLE journals; CREATE TABLE journals (entry_date TEXT, content TEXT NOT NULL); INSERT INTO journals VALUES ('2026-01-01', 'a'), ('2026-01-02', 'b');");
    const paths = fresh();
    const refused = normalise('sqlite', source, paths, FLAG);
    expect(refused.status, refused.output).toBe(2);
    expect(JSON.parse(refused.stdout)).toMatchObject({ code: 'RMIG-E-NORMALISE-UNRESOLVED', report_path: paths.report });
    expect(reportOf(paths).unresolved).toEqual([{ type: 'primary-key-column-missing', table: 'journals', columns: ['id'], rows: 2 }]);
    expect(existsSync(paths.out)).toBe(false);
    // an empty table without the column has nothing to renumber
    const empty = buildDrifted(file('no-key-empty.sqlite'), 'DROP TABLE journals; CREATE TABLE journals (entry_date TEXT, content TEXT NOT NULL);');
    expect(normalise('sqlite', empty, fresh(), FLAG).status).toBe(0);
  });

  it('a VIEW in place of a v3.2 table is a missing table, with a report, and is listed as ignored', () => {
    const source = buildDrifted(file('view.sqlite'), 'DROP TABLE subconscious; CREATE VIEW subconscious AS SELECT 1 AS id;');
    const paths = fresh();
    const refused = normalise('sqlite', source, paths, FLAG);
    expect(refused.status, refused.output).toBe(2);
    expect(existsSync(paths.report)).toBe(true);
    expect(reportOf(paths).ignored_source_objects).toEqual([{ type: 'view', name: 'subconscious' }]);
  });

  // The guard's job is the exactness of what is migrated from: inspect-source stays strict (source-guard.test.mjs), and the
  // normalised copy is built from the public DDL. Here the features of the source are reported, not refused.
  it('reports a CHECK on an extra table and a partial index on a shared table without refusing, and the output passes inspect-source', () => {
    const source = buildDrifted(file('features.sqlite'), "CREATE TABLE extra_checked (a INTEGER CHECK (a > 0), b TEXT COLLATE NOCASE); INSERT INTO extra_checked VALUES (1, 'B'); CREATE INDEX extra_partial ON journals(content) WHERE content <> ''; CREATE INDEX extra_expression ON journals(lower(content));");
    const paths = fresh();
    const run = normalise('sqlite', source, paths, FLAG);
    expect(run.status, run.output).toBe(0);
    const details = reportOf(paths);
    expect(details.unresolved).toEqual([]);
    const features = details.source_features.map((item) => `${item.table}:${item.kind}`).sort();
    expect(features).toEqual(expect.arrayContaining(['extra_checked:check-constraint', 'extra_checked:collation', 'journals:partial-index', 'journals:expression-index']));
    // the extra table is set aside whole, with its own DDL
    expect(JSON.parse(readFileSync(paths.setAside, 'utf8')).tables.extra_checked.rows).toEqual([{ a: 1, b: 'B' }]);
    const inspected = runCli(['inspect-source', '--source-kind', 'sqlite', '--source', paths.out, '--report', file(`features-inspect-${counter}.json`)]);
    expect(inspected.status, inspected.output).toBe(0);
  });

  it('compares carried values byte for byte even when the source column has a collation', () => {
    const source = buildDrifted(file('nocase.sqlite'), "DROP TABLE journals; CREATE TABLE journals (id INTEGER PRIMARY KEY AUTOINCREMENT, entry_date TEXT, content TEXT COLLATE NOCASE NOT NULL, tags TEXT, emotion TEXT, created_at TEXT); INSERT INTO journals (content) VALUES ('MiXed Case');");
    const paths = fresh();
    expect(normalise('sqlite', source, paths, FLAG).status).toBe(0);
    const out = new DatabaseSync(paths.out, { readOnly: true });
    try { expect(out.prepare('SELECT content FROM journals').get().content).toBe('MiXed Case'); } finally { out.close(); }
  });

  it('sets a generated column aside with a generated marker and never carries it', () => {
    const source = buildDrifted(file('generated.sqlite'), "INSERT INTO journals (id, entry_date, content) VALUES (7, '2026-02-01', 'quiet'); ALTER TABLE journals ADD COLUMN shout TEXT GENERATED ALWAYS AS (upper(content)) VIRTUAL;");
    const paths = fresh();
    const run = normalise('sqlite', source, paths, FLAG);
    expect(run.status, run.output).toBe(0);
    const details = reportOf(paths);
    expect(details.tables.journals.generated_columns).toEqual(['shout']);
    expect(details.tables.journals.set_aside_columns).toContain('shout');
    const setAside = JSON.parse(readFileSync(paths.setAside, 'utf8')).columns.journals;
    expect(setAside.column_info).toEqual({ shout: { generated: true } });
    expect(setAside.rows).toContainEqual({ key: { id: 7 }, values: { shout: 'QUIET' } });
    const out = new DatabaseSync(paths.out, { readOnly: true });
    try { expect(out.prepare("SELECT count(*) AS n FROM pragma_table_xinfo('journals') WHERE name = 'shout'").get().n).toBe(0); } finally { out.close(); }
  });

  it('refuses a virtual table unless --skip-virtual-tables is given, lists it either way, and sets its shadow tables aside', () => {
    const probe = new DatabaseSync(':memory:');
    let fts = true;
    try { probe.exec('CREATE VIRTUAL TABLE probe USING fts5(body)'); } catch { fts = false; } finally { probe.close(); }
    if (!fts) return;
    const source = buildDrifted(file('virtual.sqlite'), "CREATE VIRTUAL TABLE notes_fts USING fts5(body); INSERT INTO notes_fts (body) VALUES ('searchable words');");
    const refusedPaths = fresh();
    const refused = normalise('sqlite', source, refusedPaths, FLAG);
    expect(refused.status, refused.output).toBe(2);
    expect(reportOf(refusedPaths).unresolved).toEqual([{ type: 'virtual-table', table: 'notes_fts', choice_flag: '--skip-virtual-tables' }]);
    expect(reportOf(refusedPaths).virtual_tables).toEqual([{ table: 'notes_fts', skipped: false }]);
    expect(existsSync(refusedPaths.out)).toBe(false);
    const paths = fresh();
    const run = normalise('sqlite', source, paths, [...FLAG, '--skip-virtual-tables']);
    expect(run.status, run.output).toBe(0);
    expect(reportOf(paths).virtual_tables).toEqual([{ table: 'notes_fts', skipped: true }]);
    const setAside = JSON.parse(readFileSync(paths.setAside, 'utf8'));
    expect(Object.keys(setAside.tables)).not.toContain('notes_fts');
    expect(Object.keys(setAside.tables)).toContain('notes_fts_data');
  });
});

describe('normalise-source --restore-sql', () => {
  it('writes one plain, reviewable transaction for the data that has a v4 home, and never runs it', () => {
    const paths = fresh();
    const run = normalise('d1-export', DRIFTED_EXPORT, paths, [...FLAG, '--restore-sql', paths.restore]);
    expect(run.status, run.output).toBe(0);
    const sql = readFileSync(paths.restore, 'utf8');
    expect(sql).toMatch(/^-- Restore of set-aside data/u);
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('ROLLBACK;');
    expect(sql).not.toMatch(/\bE'/u);
    // observation_sits keep their ids; times are explicit UTC; the sequence is moved
    expect(sql).toContain("(1, 2, 'sat with this', TIMESTAMPTZ '2026-05-20 08:00:00+00')");
    expect(sql).toContain("SELECT setval(pg_get_serial_sequence('observation_sits', 'id')");
    expect(sql).toContain("(2, TIMESTAMPTZ '2026-05-20 08:00:00+00')");
    expect(sql).toContain("(4, TIMESTAMPTZ '2026-05-21 21:00:00+00')");
    // images: the view data only where v4 still has the defaults, and a SELECT to read first
    expect(sql).toContain("(1, 'active', 4, TIMESTAMPTZ '2026-05-01 10:00:00+00')");
    expect(sql).toContain('(i.view_count = 0 OR i.view_count IS NULL) AND i.last_viewed_at IS NULL');
    expect(sql.indexOf('READ THIS RESULT FIRST')).toBeLessThan(sql.indexOf('UPDATE images i SET view_count'));
    expect(reportOf(paths).restore_sql).toMatchObject({ observation_sits: 1, observations_last_sat_at: 2, images: 2, not_restored: 0 });
    // never over an existing file
    const again = fresh();
    const clash = normalise('d1-export', DRIFTED_EXPORT, again, [...FLAG, '--restore-sql', paths.restore]);
    expect(clash.status).toBe(2);
    expect(readFileSync(paths.restore, 'utf8')).toBe(sql);
  });

  it('quotes with doubled quotes, lists what it cannot write with certainty, and writes nothing on a refusal', () => {
    const backslash = String.fromCharCode(92);
    const note = `it''s a ${backslash} back${backslash}slash; DROP TABLE x;`;
    const source = buildDrifted(file('quotes.sqlite'), `INSERT INTO observation_sits (id, observation_id, sit_note, sat_at) VALUES (2, 4, '${note}', '2026-06-01T09:30:00Z'), (3, 4, 'odd time', 'yesterday');`);
    const paths = fresh();
    const run = normalise('sqlite', source, paths, [...FLAG, '--restore-sql', paths.restore]);
    expect(run.status, run.output).toBe(0);
    const sql = readFileSync(paths.restore, 'utf8');
    expect(sql).toContain(`(2, 4, '${note}', TIMESTAMPTZ '2026-06-01 09:30:00Z')`);
    expect(sql).toContain('-- NOT RESTORED by this file (1)');
    expect(sql).not.toContain("'odd time'");
    expect(reportOf(paths).restore_sql.not_restored).toBe(1);
    const refusedPaths = fresh();
    const refused = normalise('d1-export', DRIFTED_EXPORT, refusedPaths, ['--restore-sql', refusedPaths.restore]);
    expect(refused.status).toBe(2);
    expect(existsSync(refusedPaths.restore)).toBe(false);
  });
});
