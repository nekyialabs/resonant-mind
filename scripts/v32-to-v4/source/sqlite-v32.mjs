import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { canonicalJson } from '../lib/canonical-json.mjs';
import { sourceGuardFindings } from '../lib/source-guard.mjs';
import { canonicalSha256 } from '../lib/hash.mjs';
import { MigrationRefusal } from '../lib/refusal.mjs';
import { sourceSpecFor } from '../lib/fingerprint.mjs';
import { assertSourceAdapter } from './adapter.mjs';

const SQLITE_TABLES = new Set(sourceSpecFor('sqlite').tables.map(({ name }) => name));

function refusal(code, summary, safeDetails = {}) {
  return new MigrationRefusal({ code, phase: 'inspect-source', summary, safe_details: safeDetails, report_path: null });
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function sourceFile(path) {
  if (typeof path !== 'string' || path.length === 0 || /^(?:https?|d1):/iu.test(path)) throw refusal('RMIG-E-D1-REMOTE-UNSUPPORTED', 'Only local SQLite files are supported; remote identifiers are refused.');
  const resolved = resolve(path);
  let linkStat;
  try { linkStat = lstatSync(resolved); } catch { throw refusal('RMIG-E-SOURCE-ARG', 'The SQLite source path does not exist.', { source_kind: 'sqlite' }); }
  const real = realpathSync.native(resolved);
  const stat = statSync(real);
  if (!linkStat.isFile() && !linkStat.isSymbolicLink() || !stat.isFile()) throw refusal('RMIG-E-SOURCE-ARG', 'The SQLite source must resolve to a regular file.', { source_kind: 'sqlite' });
  return real;
}

function pragma(db, name) {
  return db.prepare(`PRAGMA ${name}`).all();
}

function quotePragmaName(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function quoteIdentifier(value) {
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) throw new TypeError('SQLite identifier is not allowlisted.');
  return `"${value}"`;
}

function buildCatalog(db) {
  const tableRows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const tables = tableRows.map(({ name }) => {
    const columns = pragma(db, `table_xinfo(${quotePragmaName(name)})`).filter((row) => row.hidden === 0).map((row) => ({ name: row.name, type: String(row.type ?? '').toUpperCase(), nullable: row.notnull === 0, default: row.dflt_value ?? null, pk_position: Number(row.pk ?? 0) }));
    const primary_key = columns.filter((row) => row.pk_position > 0).sort((a, b) => a.pk_position - b.pk_position).map((row) => row.name);
    const foreign_keys = pragma(db, `foreign_key_list(${quotePragmaName(name)})`).sort((a, b) => a.id - b.id || a.seq - b.seq).map((row) => ({ name: `${name}_fk_${row.id}`, columns: [row.from], references: { table: row.table, columns: [row.to] }, on_delete: row.on_delete, on_update: row.on_update }));
    const unique_constraints = [];
    const indexes = [];
    for (const index of pragma(db, `index_list(${quotePragmaName(name)})`).sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
      if (index.origin === 'pk') continue;
      const indexColumns = pragma(db, `index_xinfo(${quotePragmaName(index.name)})`).filter((row) => row.key === 1).sort((a, b) => a.seqno - b.seqno).map((row) => row.name);
      const item = { name: index.name, unique: index.unique === 1, columns: indexColumns, where: null };
      if (index.unique === 1 && (index.origin === 'u' || index.origin === 'c')) unique_constraints.push(item);
      else indexes.push(item);
    }
    return { name, columns, primary_key, unique_constraints, foreign_keys, checks: [], indexes };
  });
  return { family: 'sqlite-v3.2-post-0003', catalog_version: 'v3.2.0-post-0003', tables };
}

// The bookkeeping table `wrangler d1 migrations apply` creates in every D1 database, so every `wrangler d1
// export` carries it. It is not part of v3.2 and holds no memory. Only its exact DDL is recognised; a table
// of that name in any other shape is not set aside, so it stays in the catalog and counts as drift.
export const WRANGLER_MIGRATIONS_TABLE = 'd1_migrations';
const WRANGLER_MIGRATIONS_DDL = 'CREATE TABLE "d1_migrations"(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)';

function wranglerMigrationsShape() {
  const reference = new DatabaseSync(':memory:');
  try {
    reference.exec(WRANGLER_MIGRATIONS_DDL);
    return buildCatalog(reference).tables[0];
  } finally { reference.close(); }
}

// True when `d1_migrations` is exactly wrangler's table: the same columns, types, nullability, defaults,
// key and unique constraint (compared against a table built from wrangler's own DDL), AUTOINCREMENT, and
// nothing else attached to it (no extra index, trigger or foreign key).
function isWranglerMigrationsTable(db, catalogTable) {
  if (catalogTable === undefined) return false;
  // the fingerprint cannot see a CHECK, a collation or a generated column: a table with any of them is not wrangler's
  if (sourceGuardFindings(db, { tables: [WRANGLER_MIGRATIONS_TABLE] }).length > 0) return false;
  const reference = wranglerMigrationsShape();
  const strip = (table) => ({ ...table, unique_constraints: table.unique_constraints.map(({ name: _name, ...rest }) => rest) });
  if (canonicalJson(strip(catalogTable)) !== canonicalJson(strip(reference))) return false;
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(WRANGLER_MIGRATIONS_TABLE);
  if (!/\bAUTOINCREMENT\b/iu.test(String(row?.sql ?? ''))) return false;
  // an index made with CREATE INDEX (sql is not null), a trigger or a view on it is something wrangler never writes
  const attached = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE tbl_name = ? AND sql IS NOT NULL AND type <> 'table'").get(WRANGLER_MIGRATIONS_TABLE).n;
  return attached === 0;
}

export class SqliteV32Adapter {
  constructor({ source, destination, allowAnyTables = false, setAsideWranglerMigrations = false, tempDirectory = null, cleanupTemp = false } = {}) {
    const real = sourceFile(source);
    if (destination && real === realpathSync.native(resolve(destination))) throw refusal('RMIG-E-SAME-SOURCE-TARGET', 'A source cannot also be its destination.', { source_kind: 'sqlite' });
    this.sourcePath = real;
    this.tempDirectory = tempDirectory;
    this.cleanupTemp = cleanupTemp;
    this.#allowAnyTables = allowAnyTables;
    this.#setAsideWrangler = setAsideWranglerMigrations;
    this.#initial = { hash: hashFile(real), mtimeMs: statSync(real).mtimeMs, size: statSync(real).size };
    try {
      this.#db = new DatabaseSync(real, { readOnly: true });
    } catch (error) {
      throw refusal('RMIG-E-SOURCE-NOT-READONLY', 'SQLite source could not be opened read-only.', { source_kind: 'sqlite', reason: String(error?.code ?? 'open-failed') });
    }
    this.#snapshot = false;
    this.#closed = false;
  }

  #db;
  #allowAnyTables;
  #setAsideWrangler;
  #wranglerChecked = false;
  #wranglerSetAside = false;
  #initial;
  #snapshot;
  #closed;

  identity() {
    return { kind: this.tempDirectory ? 'd1-export' : 'sqlite', source_path: this.sourcePath, source_sha256: this.#initial.hash, size: this.#initial.size, mtime_ms: this.#initial.mtimeMs };
  }

  // Whether wrangler's own d1_migrations table is present, in exactly its shape, and so set aside.
  #wranglerSetAsideNow(full) {
    if (!this.#setAsideWrangler) return false;
    if (!this.#wranglerChecked) {
      this.#wranglerSetAside = isWranglerMigrationsTable(this.#db, full.tables.find(({ name }) => name === WRANGLER_MIGRATIONS_TABLE));
      this.#wranglerChecked = true;
    }
    return this.#wranglerSetAside;
  }

  // The catalog the fingerprint is compared with: without wrangler's bookkeeping table when that is set aside.
  catalog() {
    const full = buildCatalog(this.#db);
    if (!this.#wranglerSetAsideNow(full)) return full;
    return { ...full, tables: full.tables.filter(({ name }) => name !== WRANGLER_MIGRATIONS_TABLE) };
  }

  // What the catalog fingerprint cannot see (see lib/source-guard.mjs), over every table that is not set aside.
  sourceGuard() {
    return sourceGuardFindings(this.#db, { tables: this.catalog().tables.map(({ name }) => name) });
  }

  // The migrations wrangler recorded as applied (oldest first), or null when the table is absent, is not in
  // wrangler's exact shape, or this is not a d1-export source. Names only; it is never exported or counted.
  wranglerMigrations() {
    if (!this.#wranglerSetAsideNow(buildCatalog(this.#db))) return null;
    const applied = this.#db.prepare(`SELECT name FROM "${WRANGLER_MIGRATIONS_TABLE}" ORDER BY id`).all().map(({ name }) => name);
    return { table: WRANGLER_MIGRATIONS_TABLE, applied };
  }

  beginSnapshot() {
    if (this.#snapshot) return;
    try { this.#db.exec('BEGIN'); this.#snapshot = true; }
    catch (error) { throw refusal('RMIG-E-SOURCE-DRIFT', 'SQLite source snapshot could not be started.', { reason: String(error?.code ?? 'begin-failed') }); }
  }

  async *streamTable(table, primaryKey = undefined) {
    const allowed = this.#allowAnyTables ? new Set(this.catalog().tables.map(({ name }) => name)) : SQLITE_TABLES;
    if (!allowed.has(table)) throw refusal('RMIG-E-SOURCE-FINGERPRINT', 'The requested table is not in the exact post-0003 SQLite catalog.', { table });
    const catalogTable = this.catalog().tables.find((item) => item.name === table);
    const order = primaryKey ?? catalogTable?.primary_key ?? [];
    if (!Array.isArray(order) || order.some((column) => !catalogTable?.primary_key.includes(column))) throw refusal('RMIG-E-BUNDLE-INTEGRITY', 'The requested table order is not its exact primary key.', { table });
    const orderBy = order.length === 0 ? '' : ` ORDER BY ${order.map(quoteIdentifier).join(', ')}`;
    for (const row of this.#db.prepare(`SELECT * FROM ${quoteIdentifier(table)}${orderBy}`).iterate()) yield row;
  }

  rowCount(table) {
    const allowed = this.#allowAnyTables ? new Set(this.catalog().tables.map(({ name }) => name)) : SQLITE_TABLES;
    if (!allowed.has(table)) throw refusal('RMIG-E-SOURCE-FINGERPRINT', 'The requested table is not allowlisted.', { table });
    return String(this.#db.prepare(`SELECT count(*) AS row_count FROM "${table}"`).get().row_count);
  }

  endSnapshot() {
    if (!this.#snapshot) return;
    try { this.#db.exec('ROLLBACK'); } finally { this.#snapshot = false; }
  }

  #assertUnchanged() {
    const current = statSync(this.sourcePath);
    if (current.size !== this.#initial.size || current.mtimeMs !== this.#initial.mtimeMs || hashFile(this.sourcePath) !== this.#initial.hash) throw refusal('RMIG-E-SOURCE-DRIFT', 'The SQLite source changed during read-only inspection.', { source_kind: this.identity().kind });
  }

  close() {
    let failure;
    try { this.endSnapshot(); } catch (error) { failure = error; }
    try { this.#db.close(); } catch (error) { failure ??= error; }
    try { this.#assertUnchanged(); } catch (error) { failure ??= error; }
    if (this.cleanupTemp && this.tempDirectory) {
      try { rmSync(this.tempDirectory, { recursive: true, force: true }); } catch (error) { failure ??= error; }
    }
    this.#closed = true;
    if (failure) throw failure;
  }
}

export function createSqliteV32Adapter(options) {
  return assertSourceAdapter(new SqliteV32Adapter(options));
}

export { buildCatalog as sqliteCatalog };
