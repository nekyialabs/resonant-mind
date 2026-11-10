import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MigrationRefusal } from '../lib/refusal.mjs';
import { validateD1Sql } from '../lib/sql-guard.mjs';
import { assertSourceAdapter } from './adapter.mjs';
import { SqliteV32Adapter } from './sqlite-v32.mjs';

function refusal(code, summary, safeDetails = {}) {
  return new MigrationRefusal({ code, phase: 'inspect-source', summary, safe_details: safeDetails, report_path: null });
}

function localSqlExport(source) {
  if (typeof source !== 'string' || /^(?:https?|d1):/iu.test(source) || !source.toLowerCase().endsWith('.sql')) throw refusal('RMIG-E-D1-REMOTE-UNSUPPORTED', 'D1 sources must be local .sql exports; remote identifiers are refused.');
  return resolve(source);
}

function assertNoDirectives(sql) {
  const lines = sql.split(/\r?\n/u);
  const line = lines.find((value) => /^\s*\./u.test(value));
  if (line) throw refusal('RMIG-E-D1-REMOTE-UNSUPPORTED', 'D1 SQL exports must not contain SQLite shell directives.', { directive: line.trim().split(/\s+/u)[0] });
}

export function createD1ExportAdapter({ source } = {}) {
  const exportPath = localSqlExport(source);
  let sql;
  try { sql = readFileSync(exportPath, 'utf8'); }
  catch { throw refusal('RMIG-E-SOURCE-ARG', 'The local D1 SQL export could not be read.', { source_kind: 'd1-export' }); }
  assertNoDirectives(sql);
  const statements = validateD1Sql(sql);
  const tempDirectory = mkdtempSync(join(tmpdir(), 'rm-d1-materialized-'));
  const materializedPath = join(tempDirectory, 'materialized.sqlite');
  try {
    // An export writes rows in id order, so a row may reference a row that comes later in the file
    // (observations.superseded_by, for one), and a dump's PRAGMA defer_foreign_keys lasts only for one
    // transaction. So the export is loaded without enforcement, and every foreign key is then proved over
    // the whole materialized database, which is the check enforcement would have made.
    const database = new DatabaseSync(materializedPath, { enableForeignKeyConstraints: false });
    try {
      for (const statement of statements) database.exec(statement.text);
      const violations = database.prepare('PRAGMA foreign_key_check').all();
      if (violations.length > 0) {
        const tables = [...new Set(violations.map((row) => row.table))].sort();
        throw refusal('RMIG-E-SOURCE-FINGERPRINT', 'The local D1 SQL export violates its own foreign keys.', { source_kind: 'd1-export', foreign_key_violations: violations.length, tables });
      }
    } finally { database.close(); }
    return assertSourceAdapter(new SqliteV32Adapter({ source: materializedPath, allowAnyTables: true, setAsideWranglerMigrations: true, tempDirectory, cleanupTemp: true }));
  } catch (error) {
    try { rmSync(tempDirectory, { recursive: true, force: true }); } catch { /* preserve the original refusal */ }
    if (error instanceof MigrationRefusal) throw error;
    throw refusal('RMIG-E-SOURCE-FINGERPRINT', 'The local D1 SQL export could not be materialized safely.', { source_kind: 'd1-export', reason: String(error?.code ?? 'invalid-sql') });
  }
}
