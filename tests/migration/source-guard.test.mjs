import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { sourceGuardFindings, sqlWords } from '../../scripts/v32-to-v4/lib/source-guard.mjs';
import { repositoryRoot, runCli } from './helpers/cli-run.mjs';

// The catalog fingerprint cannot see CHECK constraints, collations, generated columns, WITHOUT ROWID, STRICT, or partial
// and expression indexes. The source guard refuses them outside the fingerprint, whose published value does not change.
const work = mkdtempSync(join(tmpdir(), 'rmig-source-guard-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const file = (name) => join(work, name);
const V32 = join(repositoryRoot, 'tests', 'fixtures', 'migration', 'v3.2', 'd1');
const FILES = ['0001_init.sql', '0002_enhanced_memory.sql', '0003_graph_health.sql'];
const FINGERPRINT = 'dc8f0a9c11e2852cec4d6c59cfa9e62821ccc8d1b6e0ef34b75d25c34f982e2b';

/** The exact v3.2 schema, with one change that the fingerprint cannot see. `change(ddl)` may edit the DDL text first. */
function v32Database({ ddl = (text) => text, after } = {}) {
  const database = new DatabaseSync(':memory:');
  database.exec(FILES.map((name) => ddl(readFileSync(join(V32, name), 'utf8'))).join('\n'));
  if (after) after(database);
  return database;
}
// a table rebuilt from its own DDL with a suffix (WITHOUT ROWID, STRICT)
const rebuild = (table, suffix) => (database) => {
  const { sql } = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  database.exec(`DROP TABLE ${table}; ${sql} ${suffix}`);
};
const kinds = (database, options) => sourceGuardFindings(database, options).map(({ kind }) => kind);

const FEATURES = {
  'a column CHECK': { ddl: (text) => text.replace('name TEXT NOT NULL,', 'name TEXT NOT NULL CHECK (length(name) > 0),'), kind: 'check-constraint' },
  'a table CHECK': { ddl: (text) => text.replace('UNIQUE(name, primary_context)', 'CHECK (length(name) < 9999), UNIQUE(name, primary_context)'), kind: 'check-constraint' },
  'a column COLLATE NOCASE': { ddl: (text) => text.replace('name TEXT NOT NULL,', 'name TEXT NOT NULL COLLATE NOCASE,'), kind: 'collation' },
  'a generated column': { after: (database) => database.exec("ALTER TABLE journals ADD COLUMN shout TEXT GENERATED ALWAYS AS (upper(content)) VIRTUAL"), kind: 'generated-or-hidden-column' },
  'WITHOUT ROWID': { after: rebuild('subconscious', 'WITHOUT ROWID'), kind: 'without-rowid' },
  'STRICT': { after: rebuild('subconscious', 'STRICT'), kind: 'strict' },
  'a partial index': { after: (database) => database.exec("DROP INDEX idx_entities_name; CREATE INDEX idx_entities_name ON entities(name) WHERE name <> ''"), kind: 'partial-index' },
  'an expression index': { after: (database) => database.exec('DROP INDEX idx_entities_name; CREATE INDEX idx_entities_name ON entities(lower(name))'), kind: 'expression-index' },
  'an index COLLATE': { after: (database) => database.exec('DROP INDEX idx_entities_name; CREATE INDEX idx_entities_name ON entities(name COLLATE NOCASE)'), kind: 'collation' },
};

describe('the source guard', () => {
  it('finds nothing in the exact public v3.2 schema', () => {
    const database = v32Database();
    try { expect(sourceGuardFindings(database)).toEqual([]); } finally { database.close(); }
  });

  it.each(Object.entries(FEATURES))('refuses %s', (_label, feature) => {
    const database = v32Database(feature);
    try { expect(kinds(database)).toContain(feature.kind); } finally { database.close(); }
  });

  it('reads the SQL conservatively: words in strings, quoted names and comments are not keywords, an unclosed quote is unsure', () => {
    expect(sqlWords("CREATE TABLE t (a TEXT DEFAULT 'CHECK COLLATE', \"check\" TEXT, [collate] TEXT) -- CHECK\n/* COLLATE */")).not.toEqual(expect.arrayContaining(['CHECK']));
    expect(sqlWords("CREATE TABLE t (a TEXT DEFAULT 'it''s CHECK')")).toEqual(['CREATE', 'TABLE', 'T', 'A', 'TEXT', 'DEFAULT']);
    expect(sqlWords("CREATE TABLE t (a TEXT CHECK (a <> ''))")).toContain('CHECK');
    expect(sqlWords("CREATE TABLE t (a TEXT DEFAULT 'unclosed)")).toBeNull();
    expect(sqlWords('CREATE TABLE t (a TEXT /* unclosed')).toBeNull();
    const database = new DatabaseSync(':memory:');
    try {
      database.exec("CREATE TABLE harmless (id INTEGER PRIMARY KEY, \"check\" TEXT DEFAULT 'COLLATE CHECK GENERATED') -- CHECK");
      expect(sourceGuardFindings(database)).toEqual([]);
    } finally { database.close(); }
  });

  it('can be limited to named tables', () => {
    const database = v32Database({ ddl: FEATURES['a column CHECK'].ddl });
    try {
      expect(kinds(database, { tables: ['journals'] })).toEqual([]);
      expect(kinds(database, { tables: ['entities'] })).toContain('check-constraint');
    } finally { database.close(); }
  });
});

// What the fingerprint cannot see, as a source on disk: inspect-source refuses it, and the fingerprint is what it always was.
function sqliteWith(feature, path) {
  const database = v32Database(feature);
  try { database.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`); } finally { database.close(); }
  return path;
}
function exportWith(feature, path) {
  const database = v32Database(feature);
  try {
    const objects = database.prepare("SELECT type, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name").all();
    writeFileSync(path, `PRAGMA defer_foreign_keys=TRUE;\n${objects.map((object) => `${object.sql};`).join('\n')}\n`);
  } finally { database.close(); }
  return path;
}

describe('inspect-source with the source guard', () => {
  it('still accepts the exact schema, and the published fingerprint value has not changed', () => {
    const database = v32Database();
    try { database.exec(`VACUUM INTO '${file('exact.sqlite').replaceAll("'", "''")}'`); } finally { database.close(); }
    const result = runCli(['inspect-source', '--source-kind', 'sqlite', '--source', file('exact.sqlite'), '--report', file('exact.json'), '--json']);
    expect(result.status, result.output).toBe(0);
    expect(JSON.parse(result.stdout).details).toMatchObject({ catalog_match: true, expected_fingerprint: FINGERPRINT, actual_fingerprint: FINGERPRINT });
    expect(JSON.parse(result.stdout).details).not.toHaveProperty('source_guard');
  });

  let counter = 0;
  it.each(Object.entries(FEATURES).filter(([, feature]) => !['expression-index', 'generated-or-hidden-column'].includes(feature.kind)))('refuses %s, for a sqlite and for a d1-export source', (label, feature) => {
    for (const [kind, make] of [['sqlite', sqliteWith], ['d1-export', exportWith]]) {
      counter += 1;
      const source = make(feature, file(`feature-${counter}.${kind === 'sqlite' ? 'sqlite' : 'sql'}`));
      const result = runCli(['inspect-source', '--source-kind', kind, '--source', source, '--report', file(`feature-${counter}.json`), '--json']);
      expect(result.status, `${label} ${kind}: ${result.output}`).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({ code: 'RMIG-E-SOURCE-FINGERPRINT' });
      const report = JSON.parse(readFileSync(file(`feature-${counter}.json`), 'utf8'));
      expect(report.status).toBe('refused');
      // for what the fingerprint cannot see it matched: the guard is what saw it (WITHOUT ROWID also changes the key shape)
      if (feature.kind !== 'without-rowid') expect(report.details).toMatchObject({ catalog_match: true, expected_fingerprint: FINGERPRINT, actual_fingerprint: FINGERPRINT });
      if (feature.kind !== 'without-rowid') expect(report.details.source_guard.map((finding) => finding.kind)).toContain(feature.kind);
    }
  });

  it('refuses a generated column and an expression index too', () => {
    for (const label of ['a generated column', 'an expression index']) {
      counter += 1;
      const source = sqliteWith(FEATURES[label], file(`feature-${counter}.sqlite`));
      const result = runCli(['inspect-source', '--source-kind', 'sqlite', '--source', source, '--report', file(`feature-${counter}.json`), '--json']);
      expect(result.status, label).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({ code: 'RMIG-E-SOURCE-FINGERPRINT' });
    }
  });
});

describe('the d1_migrations shape check uses the same guard', () => {
  const stock = readFileSync(join(repositoryRoot, 'tests', 'fixtures', 'migration', 'v3.2', 'd1-export-stock.sql'), 'utf8');
  const TAMPERED = {
    'a CHECK': ['name       TEXT UNIQUE,', 'name       TEXT UNIQUE CHECK (name <> \'\'),'],
    'COLLATE NOCASE': ['name       TEXT UNIQUE,', 'name       TEXT UNIQUE COLLATE NOCASE,'],
    'a generated column': ['applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL', 'applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,\n\t\tshout TEXT GENERATED ALWAYS AS (upper(name)) VIRTUAL'],
  };
  it.each(Object.entries(TAMPERED))('a d1_migrations table with %s is drift, not set aside', (label, [from, to]) => {
    const changed = stock.replace(from, to);
    expect(changed).not.toBe(stock);
    writeFileSync(file(`tampered-${label.replaceAll(/\W+/gu, '-')}.sql`), changed);
    const result = runCli(['inspect-source', '--source-kind', 'd1-export', '--source', file(`tampered-${label.replaceAll(/\W+/gu, '-')}.sql`), '--report', file(`tampered-${label.replaceAll(/\W+/gu, '-')}.json`), '--json']);
    expect(result.status, result.output).toBe(2);
    // a generated column is refused while the export is loaded, before any report; the others by the guard, with a report
    if (label === 'a generated column') return;
    const report = JSON.parse(readFileSync(file(`tampered-${label.replaceAll(/\W+/gu, '-')}.json`), 'utf8'));
    expect(report.status).toBe('refused');
    expect(report.details).not.toHaveProperty('d1_migrations_set_aside');
  });

  it('the real wrangler table passes the same guard', () => {
    const result = runCli(['inspect-source', '--source-kind', 'd1-export', '--source', join(repositoryRoot, 'tests', 'fixtures', 'migration', 'v3.2', 'd1-export-stock.sql'), '--report', file('real-stock.json'), '--json']);
    expect(result.status, result.output).toBe(0);
  });
});
