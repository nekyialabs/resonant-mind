import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { createD1ExportAdapter } from '../../scripts/v32-to-v4/source/d1-export.mjs';
import { createSqliteV32Adapter } from '../../scripts/v32-to-v4/source/sqlite-v32.mjs';
import { readTree, repositoryRoot, runCli } from './helpers/cli-run.mjs';
import { createD1Export, createSqliteSource } from './helpers/seeds.mjs';

// `wrangler d1 migrations apply` creates a bookkeeping table in every D1 database, so every `wrangler d1 export`
// carries it. The migrator sets it aside, but only in wrangler's exact shape (issue #21).
const work = mkdtempSync(join(tmpdir(), 'rmig-d1-migrations-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const file = (name) => join(work, name);
const STOCK = join(repositoryRoot, 'tests', 'fixtures', 'migration', 'v3.2', 'd1-export-stock.sql');
const STOCK_NAMES = ['0001_init.sql', '0002_enhanced_memory.sql', '0003_graph_health.sql'];
const stockText = () => readFileSync(STOCK, 'utf8');
const WRANGLER_DDL = stockText().match(/CREATE TABLE IF NOT EXISTS "d1_migrations"\([\s\S]*?\n\);/u)[0];

let reports = 0;
function inspect(kind, source, label = 'report') {
  const name = `${label}-${(reports += 1)}.json`;
  const result = runCli(['inspect-source', '--source-kind', kind, '--source', source, '--report', file(name), '--json']);
  return { ...result, report: JSON.parse(readFileSync(file(name), 'utf8')) };
}

describe('wrangler\'s d1_migrations table in a d1-export source', () => {
  it('a real `wrangler d1 export` of stock v3.2 inspects as supported, and the table is set aside', () => {
    const result = inspect('d1-export', STOCK, 'stock.json');
    expect(result.status, result.output).toBe(0);
    const { details } = result.report;
    expect(result.report.status).toBe('succeeded');
    expect(details.catalog_match).toBe(true);
    expect(details.tables).toHaveLength(16);
    expect(details.tables.map((table) => table.name)).not.toContain('d1_migrations');
    expect(details.tables.every((table) => table.row_count === '0')).toBe(true);
    expect(details.d1_migrations_set_aside).toEqual({ table: 'd1_migrations', applied: STOCK_NAMES });
    expect(runCli(['inspect-source', '--source-kind', 'd1-export', '--source', STOCK, '--report', file('stock-human.json')]).stdout).toMatch(/^inspect-source: supported d1-export; tables=16; rows=0;/u);
  });

  it('the hand-built export helper writes the table the way wrangler does, and the export inspects with real rows', () => {
    createD1Export(file('helper.sql'));
    const text = readFileSync(file('helper.sql'), 'utf8');
    expect(text).toContain(WRANGLER_DDL);
    expect(text).toContain('INSERT INTO "sqlite_sequence" ("name","seq") VALUES(\'d1_migrations\',3);');
    const result = inspect('d1-export', file('helper.sql'), 'helper.json');
    expect(result.status, result.output).toBe(0);
    expect(result.report.details.d1_migrations_set_aside.applied).toEqual(STOCK_NAMES);
    // not counted in any row total: the tables and counts are those of the same data as a plain SQLite file
    createSqliteSource(file('twin.sqlite'));
    const twin = inspect('sqlite', file('twin.sqlite'), 'twin.json');
    expect(result.report.details.tables).toEqual(twin.report.details.tables);
    expect(twin.report.details).not.toHaveProperty('d1_migrations_set_aside');
  });

  it('is never exported into a bundle', () => {
    createD1Export(file('export-source.sql'));
    const exported = runCli(['export', '--source-kind', 'd1-export', '--source', file('export-source.sql'), '--migration-id', 'rmig_wrangler_bookkeeping_01', '--bundle', file('bundle.rmigrate'), '--allow-plaintext-bundle', '--acknowledge-plaintext-risk']);
    expect(exported.status, exported.output).toBe(0);
    for (const member of readTree(file('bundle.rmigrate'))) expect(member.text, member.path).not.toContain('d1_migrations');
    expect(runCli(['verify-bundle', '--bundle', file('bundle.rmigrate')]).status).toBe(0);
  });

  it('only d1-export does this: the same table in a sqlite source is still drift', () => {
    const database = new DatabaseSync(file('plain-with-table.sqlite'));
    database.exec(stockText().replace(/PRAGMA[^;]*;/u, '').replace(/DELETE FROM sqlite_sequence;[\s\S]*?VALUES\('d1_migrations',3\);/u, ''));
    database.close();
    const result = inspect('sqlite', file('plain-with-table.sqlite'), 'plain.json');
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ code: 'RMIG-E-SOURCE-FINGERPRINT' });
    expect(JSON.stringify(result.report.details.catalog_diff)).toContain('d1_migrations');
  });

  // Each variant is one change to wrangler's table. A table named d1_migrations that is not exactly wrangler's is
  // somebody's own table: it is not set aside, so it stays in the catalog and is drift.
  const WRONG = {
    'a missing UNIQUE on name': ['name       TEXT UNIQUE', 'name       TEXT'],
    'a nullable applied_at': ['TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'],
    'a different default': ['DEFAULT CURRENT_TIMESTAMP NOT NULL', "DEFAULT '' NOT NULL"],
    'a different type on name': ['name       TEXT UNIQUE', 'name       INTEGER UNIQUE'],
    'no AUTOINCREMENT': ['INTEGER PRIMARY KEY AUTOINCREMENT', 'INTEGER PRIMARY KEY'],
    'an extra column': ['NOT NULL\n);', 'NOT NULL,\n\t\tnote TEXT\n);'],
  };
  it.each(Object.entries(WRONG))('refuses d1_migrations with %s', (label, [from, to]) => {
    const changed = stockText().replace(from, to);
    expect(changed, 'the variant must change the DDL').not.toBe(stockText());
    const path = file(`wrong-${label.replaceAll(/\W+/gu, '-')}.sql`);
    writeFileSync(path, changed.replace('DELETE FROM sqlite_sequence;\nINSERT INTO "sqlite_sequence" ("name","seq") VALUES(\'d1_migrations\',3);', label === 'no AUTOINCREMENT' ? '' : 'DELETE FROM sqlite_sequence;\nINSERT INTO "sqlite_sequence" ("name","seq") VALUES(\'d1_migrations\',3);'));
    const result = inspect('d1-export', path, 'wrong.json');
    expect(result.status, result.output).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ code: 'RMIG-E-SOURCE-FINGERPRINT' });
    expect(result.report.status).toBe('refused');
    // the diff is bounded and starts at the first differing table, so what it proves is that the table stayed in the catalog
    expect(result.report.details.catalog_diff.length).toBeGreaterThan(0);
    expect(result.report.details).not.toHaveProperty('d1_migrations_set_aside');
  });

  it('refuses a renamed column, and an extra index on the table', () => {
    const renamed = stockText().replace('applied_at TIMESTAMP', 'applied    TIMESTAMP').replaceAll('("id","name","applied_at")', '("id","name","applied")');
    writeFileSync(file('renamed.sql'), renamed);
    const result = inspect('d1-export', file('renamed.sql'), 'renamed');
    expect(result.status, result.output).toBe(2);
    expect(result.report.status).toBe('refused');
    writeFileSync(file('extra-index.sql'), `${stockText()}\nCREATE INDEX idx_d1m_applied ON d1_migrations(applied_at);\n`);
    const indexed = inspect('d1-export', file('extra-index.sql'), 'extra-index');
    expect(indexed.status, indexed.output).toBe(2);
    expect(indexed.report.status).toBe('refused');
  });

  it('a d1-export without the table is still accepted, and the field is absent', () => {
    const stripped = stockText().replace(/CREATE TABLE IF NOT EXISTS "d1_migrations"[\s\S]*?\n\);\n/u, '').replace(/INSERT INTO "d1_migrations"[^\n]*\n/gu, '').replace(/INSERT INTO "sqlite_sequence"[^\n]*\n/u, '');
    writeFileSync(file('no-table.sql'), stripped);
    const result = inspect('d1-export', file('no-table.sql'), 'no-table.json');
    expect(result.status, result.output).toBe(0);
    expect(result.report.details).not.toHaveProperty('d1_migrations_set_aside');
  });

  it('the adapter lists the applied names in order, and the table cannot be streamed or counted', async () => {
    const adapter = createD1ExportAdapter({ source: STOCK });
    try {
      expect(adapter.wranglerMigrations()).toEqual({ table: 'd1_migrations', applied: STOCK_NAMES });
      expect(adapter.catalog().tables.map((table) => table.name)).not.toContain('d1_migrations');
      await adapter.beginSnapshot();
      await expect((async () => { for await (const _row of adapter.streamTable('d1_migrations')) { /* never */ } })()).rejects.toMatchObject({ code: 'RMIG-E-SOURCE-FINGERPRINT' });
      expect(() => adapter.rowCount('d1_migrations')).toThrow(/allowlisted/u);
      await adapter.endSnapshot();
    } finally { await adapter.close(); }
    createSqliteSource(file('plain.sqlite'));
    const plain = createSqliteV32Adapter({ source: file('plain.sqlite') });
    try { expect(plain.wranglerMigrations()).toBeNull(); } finally { await plain.close(); }
  });
});
