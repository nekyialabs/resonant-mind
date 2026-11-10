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

  it.each([
    ['a CHECK constraint', 'CREATE TABLE extra_checked (a INTEGER CHECK (a > 0));', 'check-constraint'],
    ['a COLLATE NOCASE column', 'CREATE TABLE extra_collated (a TEXT COLLATE NOCASE);', 'collation'],
    ['a generated column', 'ALTER TABLE journals ADD COLUMN shout TEXT GENERATED ALWAYS AS (upper(content)) VIRTUAL;', 'generated-or-hidden-column'],
    ['WITHOUT ROWID', 'CREATE TABLE extra_wr (a INTEGER PRIMARY KEY) WITHOUT ROWID;', 'without-rowid'],
    ['STRICT', 'CREATE TABLE extra_strict (a INTEGER) STRICT;', 'strict'],
    ['a partial index', "CREATE INDEX extra_partial ON journals(content) WHERE content <> '';", 'partial-index'],
    ['an expression index', 'CREATE INDEX extra_expression ON journals(lower(content));', 'expression-index'],
  ])('refuses a source with %s, in any table', (_label, extra, kind) => {
    const source = buildDrifted(file(`guard-${kind}.sqlite`), extra);
    const paths = fresh();
    const refused = normalise('sqlite', source, paths, FLAG);
    expect(refused.status, refused.output).toBe(2);
    expect(JSON.parse(refused.stdout)).toMatchObject({ code: 'RMIG-E-NORMALISE-UNRESOLVED' });
    expect(reportOf(paths).unresolved.map((item) => `${item.type}:${item.kind}`)).toContain(`source-guard:${kind}`);
    expect(existsSync(paths.out)).toBe(false);
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
