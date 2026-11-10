import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { compareCatalog, sourceSpecFor } from '../lib/fingerprint.mjs';
import { isMigrationRefusal, MigrationRefusal } from '../lib/refusal.mjs';
import { buildRestoreSql } from '../lib/restore-sql.mjs';
import { sourceGuardFindings } from '../lib/source-guard.mjs';
import { createReport, writeReportAtomic } from '../lib/report.mjs';
import { readD1ExportStatements } from '../source/d1-export.mjs';
import { sqliteCatalog } from '../source/sqlite-v32.mjs';
import { parseOptions, publishNew, refuseArgument, writeBytesNew } from './shared.mjs';

const PHASE = 'normalise-source';
const VERSION = createRequire(import.meta.url)('../../../package.json').version;
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const V32_FIXTURES = join(REPOSITORY_ROOT, 'tests', 'fixtures', 'migration', 'v3.2');
const SET_ASIDE_FORMAT = 'rmig-set-aside/1';
const ID_LIMIT = 50;

/**
 * The NOT NULL v3.2 columns for which a person may choose a value for NULLs, one explicit switch per column.
 * Nothing else is ever filled in: every other NULL in a NOT NULL column is an unresolved item.
 */
export const NULL_CHOICES = Object.freeze([
  Object.freeze({ flag: '--null-context-default', table: 'entities', column: 'primary_context', value: 'default' }),
]);

const quote = (name) => `"${String(name).replaceAll('"', '""')}"`;
const sqlLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;

function refuse(code, summary, safeDetails = {}, reportPath = null) {
  return new MigrationRefusal({ code, phase: PHASE, summary, safe_details: safeDetails, report_path: reportPath });
}

export function parseNormaliseSourceArgs(argv) {
  const values = parseOptions(PHASE, argv, {
    required: ['--source-kind', '--source', '--out', '--set-aside', '--report'],
    optional: ['--restore-sql'],
    switches: NULL_CHOICES.map(({ flag }) => flag),
  });
  if (!['sqlite', 'd1-export'].includes(values['--source-kind'])) throw refuseArgument(PHASE, '--source-kind must be sqlite or d1-export.');
  return {
    sourceKind: values['--source-kind'],
    source: values['--source'],
    outPath: values['--out'],
    setAsidePath: values['--set-aside'],
    reportPath: values['--report'],
    restoreSqlPath: values['--restore-sql'] ?? null,
    nullChoices: NULL_CHOICES.filter(({ flag }) => values[flag] === true),
  };
}

// The exact public v3.2 DDL, read from the byte-identical tagged fixtures (their hashes are checked against
// PROVENANCE.json), so the output has the schema `inspect-source` fingerprints and not a schema this file made up.
function exactV32Ddl() {
  const provenance = JSON.parse(readFileSync(join(V32_FIXTURES, 'PROVENANCE.json'), 'utf8'));
  return ['d1/0001_init.sql', 'd1/0002_enhanced_memory.sql', 'd1/0003_graph_health.sql'].map((path) => {
    const entry = provenance.files.find((file) => file.path === path);
    const bytes = readFileSync(join(V32_FIXTURES, path));
    if (entry === undefined || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error(`The v3.2 schema fixture ${path} does not match its provenance.`);
    return bytes.toString('utf8');
  });
}

function tableNames(database, schema = 'main') {
  return database.prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all().map(({ name }) => name);
}

function columnsOf(database, table, schema = 'main') {
  return database.prepare(`PRAGMA ${schema}.table_xinfo(${sqlLiteral(table)})`).all().filter((column) => column.hidden !== 1)
    .map((column) => ({ name: column.name, notnull: column.notnull === 1, hasDefault: column.dflt_value !== null, pk: Number(column.pk) }));
}

function plain(value) {
  if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : { $integer: value.toString() };
  if (value instanceof Uint8Array) return { $blob_base64: Buffer.from(value).toString('base64') };
  return value;
}

function readRows(database, sql) {
  const statement = database.prepare(sql);
  statement.setReadBigInts(true);
  return statement.all().map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, plain(value)])));
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function sourceFileFor(kind, source) {
  if (typeof source !== 'string' || source.length === 0 || /^(?:https?|d1):/iu.test(source)) throw refuse('RMIG-E-D1-REMOTE-UNSUPPORTED', 'Only a local file can be normalised; remote identifiers are refused.');
  const resolved = resolve(source);
  let stat;
  try { stat = lstatSync(resolved); } catch { throw refuseArgument(PHASE, 'The source file does not exist.', 'RMIG-E-SOURCE-ARG', { source_kind: kind }); }
  if (!stat.isFile() && !stat.isSymbolicLink()) throw refuseArgument(PHASE, 'The source must be a regular file.', 'RMIG-E-SOURCE-ARG', { source_kind: kind });
  const real = realpathSync.native(resolved);
  if (!statSync(real).isFile()) throw refuseArgument(PHASE, 'The source must be a regular file.', 'RMIG-E-SOURCE-ARG', { source_kind: kind });
  return real;
}

// A private, writable copy of the source in the temporary directory. The source file itself is only ever read
// (a SQLite file through a read-only connection, a D1 export as text), so it cannot be changed here.
function copySource(kind, sourceFile, copyPath) {
  if (kind === 'sqlite') {
    let reader;
    try {
      reader = new DatabaseSync(sourceFile, { readOnly: true });
      reader.exec(`VACUUM INTO ${sqlLiteral(copyPath)}`);
    } catch (error) {
      throw refuseArgument(PHASE, 'The SQLite source could not be read as a database.', 'RMIG-E-SOURCE-ARG', { source_kind: kind, reason: String(error?.code ?? 'unreadable') });
    } finally { try { reader?.close(); } catch { /* the copy is the point */ } }
    return;
  }
  const statements = readD1ExportStatements(sourceFile, PHASE);
  const database = new DatabaseSync(copyPath, { enableForeignKeyConstraints: false });
  try { for (const statement of statements) database.exec(statement.text); }
  catch (error) { throw refuseArgument(PHASE, 'The local D1 SQL export could not be loaded.', 'RMIG-E-D1-SQL-UNSAFE', { source_kind: kind, reason: String(error?.code ?? 'invalid-sql') }); }
  finally { database.close(); }
}

function keyOf(pk) {
  return pk.length > 0 ? pk.map(quote).join(', ') : 'rowid';
}

function limited(ids) {
  return { count: ids.length, ids: ids.slice(0, ID_LIMIT).map((id) => (typeof id === 'object' && id !== null ? JSON.stringify(id) : id)) };
}

const CARRY_CODES = new Set(['value-changed-by-copy', 'row-not-found-by-key']);

/**
 * Rebuilds a drifted v3.2 database into the exact public v3.2 schema, on a copy, and sets aside everything that is
 * not v3.2. Pure function of its inputs apart from the new files it writes; nothing it reads is changed.
 *
 *  - Every v3.2 table's columns that the source also has are copied; v3.2 columns the source lacks take their v3.2 defaults.
 *  - Every column the source has and v3.2 does not, and every table v3.2 does not have, is written to the set-aside
 *    file with its primary key (non-null values only for columns).
 *  - Nothing is guessed, and success is never reported while data changed or went missing: a NULL in a NOT NULL v3.2
 *    column, a missing v3.2 table or key column, a CHECK/collation/generated column in the source, and any cell whose
 *    type or value differs after the copy (SQLite's column affinity turns the text '007' in an INTEGER column into 7)
 *    are unresolved items, and a column that looks like a renamed one is only listed. Every refusal writes the report.
 */
export function normaliseSource({ sourceKind, source, outPath, setAsidePath, reportPath, restoreSqlPath = null, nullChoices = [], timestamp = new Date().toISOString(), migrationId = 'rmig_normalise_source' } = {}) {
  if (!['sqlite', 'd1-export'].includes(sourceKind)) throw refuseArgument(PHASE, '--source-kind must be sqlite or d1-export.');
  const outputs = [['--out', outPath], ['--set-aside', setAsidePath], ['--report', reportPath], ...(restoreSqlPath === null ? [] : [['--restore-sql', restoreSqlPath]])];
  for (const [label, path] of outputs) {
    if (typeof path !== 'string' || path.length === 0) throw refuseArgument(PHASE, `normalise-source requires ${label}.`);
    if (existsSync(path)) throw refuseArgument(PHASE, `The ${label} file already exists; this command never overwrites a file and never writes in place. Choose a new path.`);
  }
  const resolvedOutputs = outputs.map(([, path]) => resolve(path));
  if (new Set(resolvedOutputs).size !== outputs.length) throw refuseArgument(PHASE, 'The output files (--out, --set-aside, --report, --restore-sql) must all be different files.');
  const sourceFile = sourceFileFor(sourceKind, source);
  if (resolvedOutputs.some((path) => path === sourceFile)) throw refuse('RMIG-E-SAME-SOURCE-TARGET', 'A normalised output cannot be the source file.', { source_kind: sourceKind });
  const choiceFor = (table, column) => nullChoices.find((choice) => choice.table === table && choice.column === column);

  // The temporary directory holds plaintext copies of the memory data; it is removed on every path out of here.
  const work = mkdtempSync(join(tmpdir(), 'rm-normalise-'));
  const copyPath = join(work, 'source-copy.sqlite');
  const builtPath = join(work, 'normalised-v32.sqlite');
  let database;
  let report;
  let setAside;
  try {
    copySource(sourceKind, sourceFile, copyPath);
    database = new DatabaseSync(builtPath, { enableForeignKeyConstraints: false });
    for (const ddl of exactV32Ddl()) database.exec(ddl);
    database.exec(`ATTACH DATABASE ${sqlLiteral(copyPath)} AS src`);
    const v32Tables = tableNames(database);
    const sourceTables = tableNames(database, 'src');
    report = {
      source_kind: sourceKind,
      source_sha256: sha256File(sourceFile),
      source_tables: sourceTables.length,
      tables: {},
      tables_missing_from_source: v32Tables.filter((name) => !sourceTables.includes(name)),
      set_aside_tables: {},
      possible_renames: [],
      resolved: [],
      unresolved: [],
      ignored_source_objects: database.prepare("SELECT type, name FROM src.sqlite_master WHERE type IN ('view', 'trigger') ORDER BY type, name").all().map(({ type, name }) => ({ type, name })),
    };
    setAside = { format: SET_ASIDE_FORMAT, source_kind: sourceKind, source_sha256: report.source_sha256, columns: {}, tables: {} };
    try {
      return build();
    } catch (error) {
      if (isMigrationRefusal(error)) throw error;
      // an unexpected SQLite error is still a refusal with a report, never a crash without one
      report.unresolved.push({ type: 'analysis-failed', reason: String(error?.message ?? 'failed').split('\n')[0].slice(0, 200) });
      return finish({ refusal: { code: 'RMIG-E-NORMALISE-UNRESOLVED', summary: 'The source could not be analysed completely; nothing was built.' } });
    }

    function build() {
      // What the catalog fingerprint cannot see: a CHECK, a collation, a generated column, WITHOUT ROWID, STRICT, a partial or expression index.
      for (const finding of sourceGuardFindings(database, { schema: 'src' })) report.unresolved.push({ type: 'source-guard', ...finding });
      if (report.unresolved.length > 0) return finish({ refusal: { code: 'RMIG-E-NORMALISE-UNRESOLVED', summary: 'The source has a schema feature the v3.2 fingerprint cannot see (CHECK, collation, generated column, ...); nothing was built.' } });

      // A v3.2 table the source does not have cannot be told apart from an empty one: refuse, never leave it empty silently.
      for (const table of report.tables_missing_from_source) report.unresolved.push({ type: 'table-missing-from-source', table });

      // Tables v3.2 does not have: every row, whole, with the table's own DDL.
      for (const table of sourceTables.filter((name) => !v32Tables.includes(name))) {
        const columns = columnsOf(database, table, 'src');
        const pk = columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name);
        const rows = readRows(database, `SELECT * FROM src.${quote(table)} ORDER BY ${keyOf(pk)}`);
        setAside.tables[table] = { ddl: database.prepare('SELECT sql FROM src.sqlite_master WHERE type = ? AND name = ?').get('table', table).sql, key: pk, rows };
        report.set_aside_tables[table] = rows.length;
      }

      // v3.2 tables: plan each copy first, so that nothing is built when anything is unresolved.
      const plans = [];
      for (const table of v32Tables) {
        if (!sourceTables.includes(table)) continue;
        const v32Columns = columnsOf(database, table);
        const sourceColumns = columnsOf(database, table, 'src');
        const sourceNames = new Set(sourceColumns.map((column) => column.name));
        const v32Names = new Set(v32Columns.map((column) => column.name));
        const shared = v32Columns.filter((column) => sourceNames.has(column.name));
        const v32Only = v32Columns.filter((column) => !sourceNames.has(column.name));
        const extras = sourceColumns.filter((column) => !v32Names.has(column.name));
        const pk = v32Columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name);
        const sourceRows = Number(database.prepare(`SELECT count(*) AS n FROM src.${quote(table)}`).get().n);
        const entry = { source_rows: sourceRows, shared_columns: shared.length, v32_only_columns: v32Only.map((column) => column.name), set_aside_columns: extras.map((column) => column.name), set_aside_column_rows: 0 };
        report.tables[table] = entry;
        if (v32Only.length > 0 && extras.length > 0) {
          report.possible_renames.push({ table, v32_columns_not_in_source: entry.v32_only_columns, source_columns_not_in_v32: entry.set_aside_columns, note: 'Not applied: a rename is never guessed. The source values are in the set-aside file; the v3.2 columns took their defaults.' });
        }

        // a primary-key column the source does not have: rows could only be numbered afresh (AUTOINCREMENT), which renumbers every id
        const missingKey = pk.filter((name) => !sourceNames.has(name));
        if (missingKey.length > 0 && sourceRows > 0) {
          report.unresolved.push({ type: 'primary-key-column-missing', table, columns: missingKey, rows: sourceRows });
          continue;
        }
        const sourceKey = pk.filter((name) => sourceNames.has(name));

        // a required v3.2 column the source does not have, with no default to take
        for (const column of v32Only.filter((item) => item.notnull && !item.hasDefault && item.pk === 0)) {
          if (sourceRows > 0) report.unresolved.push({ type: 'required-column-missing', table, column: column.name, rows: sourceRows });
        }
        // NULLs in a NOT NULL v3.2 column: a decision, never a silent coercion
        const select = shared.map((column) => quote(column.name));
        const defaulted = new Set();
        for (const column of shared.filter((item) => item.notnull && item.pk === 0)) {
          const nulls = readRows(database, `SELECT ${keyOf(sourceKey)} AS k FROM src.${quote(table)} WHERE ${quote(column.name)} IS NULL ORDER BY ${keyOf(sourceKey)}`);
          if (nulls.length === 0) continue;
          const choice = choiceFor(table, column.name);
          if (choice === undefined) {
            const flag = NULL_CHOICES.find((item) => item.table === table && item.column === column.name)?.flag ?? null;
            report.unresolved.push({ type: 'null-in-required-column', table, column: column.name, ...limited(nulls.map((row) => row.k)), choice_flag: flag });
            continue;
          }
          // the chosen value must not collide with a row that already has it (UNIQUE(name, primary_context) in v3.2)
          if (table === 'entities' && column.name === 'primary_context') {
            const clashes = readRows(database, `SELECT a.id AS k FROM src.entities a WHERE a.primary_context IS NULL AND (EXISTS (SELECT 1 FROM src.entities b WHERE b.name = a.name AND b.primary_context = ${sqlLiteral(choice.value)}) OR EXISTS (SELECT 1 FROM src.entities c WHERE c.name = a.name AND c.primary_context IS NULL AND c.id <> a.id)) ORDER BY a.id`);
            if (clashes.length > 0) {
              report.unresolved.push({ type: 'choice-collides', table, column: column.name, value: choice.value, constraint: 'UNIQUE(name, primary_context)', ...limited(clashes.map((row) => row.k)) });
              continue;
            }
          }
          select[select.indexOf(quote(column.name))] = `COALESCE(${quote(column.name)}, ${sqlLiteral(choice.value)})`;
          defaulted.add(column.name);
          report.resolved.push({ type: 'null-defaulted', table, column: column.name, rows: nulls.length, value: choice.value, choice_flag: choice.flag });
        }
        plans.push({ table, shared: shared.map((column) => column.name), select, extras, pk: sourceKey, defaulted });
      }

      // Columns v3.2 does not have: the non-null values, by the table's primary key. (Read now, from the copy.)
      for (const { table, extras, pk } of plans) {
        if (extras.length === 0) continue;
        const keyColumns = pk.length > 0 ? pk : ['rowid'];
        const rows = readRows(database, `SELECT ${keyColumns.map((name) => (name === 'rowid' ? 'rowid AS rowid' : quote(name))).join(', ')}, ${extras.map((column) => quote(column.name)).join(', ')} FROM src.${quote(table)} ORDER BY ${keyOf(pk)}`)
          .map((row) => ({ key: Object.fromEntries(keyColumns.map((name) => [name, row[name]])), values: Object.fromEntries(extras.map((column) => [column.name, row[column.name]]).filter(([, value]) => value !== null)) }))
          .filter((row) => Object.keys(row.values).length > 0);
        setAside.columns[table] = { key: keyColumns, columns: extras.map((column) => column.name), rows };
        report.tables[table].set_aside_column_rows = rows.length;
      }

      if (report.unresolved.length > 0) return finish({ refusal: { code: 'RMIG-E-NORMALISE-UNRESOLVED', summary: 'The source has items that cannot be normalised without a decision; nothing was built.' } });

      // Build: copy inside one transaction. A failing insert is an unresolved item with SQLite's own message (it names
      // the constraint and column, never a value).
      database.exec('BEGIN');
      try {
        for (const { table, shared, select } of plans) {
          if (shared.length === 0) continue;
          try { database.exec(`INSERT INTO main.${quote(table)} (${shared.map(quote).join(', ')}) SELECT ${select.join(', ')} FROM src.${quote(table)}`); }
          catch (error) { report.unresolved.push({ type: 'copy-failed', table, reason: String(error?.message ?? 'insert failed').split('\n')[0].slice(0, 200) }); }
        }
        if (report.unresolved.length === 0) database.exec('COMMIT'); else database.exec('ROLLBACK');
      } catch (error) { try { database.exec('ROLLBACK'); } catch { /* already rolled back */ } throw error; }
      if (report.unresolved.length > 0) return finish({ refusal: { code: 'RMIG-E-NORMALISE-UNRESOLVED', summary: 'A table could not be copied into the exact v3.2 schema; nothing was kept.' } });

      // The ids of AUTOINCREMENT tables keep counting from where the source stopped, not from the highest remaining id.
      if (database.prepare("SELECT count(*) AS n FROM src.sqlite_master WHERE name = 'sqlite_sequence'").get().n > 0) {
        for (const { name, seq } of database.prepare('SELECT name, seq FROM src.sqlite_sequence').all()) {
          if (!v32Tables.includes(name)) continue;
          const current = database.prepare('SELECT seq FROM main.sqlite_sequence WHERE name = ?').get(name);
          if (current === undefined) database.prepare('INSERT INTO main.sqlite_sequence (name, seq) VALUES (?, ?)').run(name, seq);
          else if (Number(seq) > Number(current.seq)) database.prepare('UPDATE main.sqlite_sequence SET seq = ? WHERE name = ?').run(seq, name);
        }
      }

      // Every carried cell, source against output, by primary key: typeof and value, NULLs compared with IS. The copy
      // goes through the v3.2 column affinities, which can turn text into a number ('007' into 7); a changed cell is
      // never reported as a success. The report names the table, column, row key and both types, never a value.
      const failures = [];
      for (const { table, shared, pk, defaulted } of plans) {
        if (shared.length === 0) continue;
        if (pk.length === 0) {
          const list = shared.filter((name) => !defaulted.has(name)).map(quote).join(', ');
          if (list === '') continue;
          const changed = Number(database.prepare(`SELECT count(*) AS n FROM (SELECT ${list} FROM src.${quote(table)} EXCEPT SELECT ${list} FROM main.${quote(table)})`).get().n);
          if (changed > 0) failures.push({ type: 'value-changed-by-copy', table, column: null, rows: changed, note: 'the table has no primary key, so rows are counted, not named' });
          continue;
        }
        const on = pk.map((name) => `s.${quote(name)} IS m.${quote(name)}`).join(' AND ');
        const keyColumns = pk.map((name, position) => `s.${quote(name)} AS k${position}`).join(', ');
        const keyOfRow = (row) => (pk.length === 1 ? row.k0 : JSON.stringify(Object.fromEntries(pk.map((name, position) => [name, row[`k${position}`]]))));
        const orphans = readRows(database, `SELECT ${keyColumns} FROM src.${quote(table)} s WHERE NOT EXISTS (SELECT 1 FROM main.${quote(table)} m WHERE ${on}) ORDER BY ${pk.map((name) => `s.${quote(name)}`).join(', ')}`);
        if (orphans.length > 0) failures.push({ type: 'row-not-found-by-key', table, ...limited(orphans.map(keyOfRow)) });
        for (const column of shared) {
          const cell = `(typeof(s.${quote(column)}) <> typeof(m.${quote(column)}) OR s.${quote(column)} IS NOT m.${quote(column)})`;
          const guard = defaulted.has(column) ? ` AND s.${quote(column)} IS NOT NULL` : '';
          const rows = readRows(database, `SELECT ${keyColumns}, typeof(s.${quote(column)}) AS st, typeof(m.${quote(column)}) AS mt FROM src.${quote(table)} s JOIN main.${quote(table)} m ON ${on} WHERE ${cell}${guard} ORDER BY ${pk.map((name) => `s.${quote(name)}`).join(', ')}`);
          const byTypes = new Map();
          for (const row of rows) { const label = `${row.st}>${row.mt}`; byTypes.set(label, [...(byTypes.get(label) ?? []), row]); }
          for (const group of byTypes.values()) failures.push({ type: 'value-changed-by-copy', table, column, source_typeof: group[0].st, output_typeof: group[0].mt, ...limited(group.map(keyOfRow)) });
        }
      }

      database.exec('DETACH DATABASE src');

      // Proof over the finished database.
      for (const [table, entry] of Object.entries(report.tables)) {
        const actual = Number(database.prepare(`SELECT count(*) AS n FROM main.${quote(table)}`).get().n);
        entry.rows_copied = actual;
        if (actual !== entry.source_rows) failures.push({ type: 'row-count-mismatch', table, source_rows: entry.source_rows, rows_copied: actual });
      }
      const violations = database.prepare('PRAGMA main.foreign_key_check').all();
      if (violations.length > 0) failures.push({ type: 'foreign-key-violations', count: violations.length, tables: [...new Set(violations.map((row) => row.table))].sort() });
      const integrity = database.prepare('PRAGMA main.integrity_check').all().map((row) => row.integrity_check);
      if (integrity.length !== 1 || integrity[0] !== 'ok') failures.push({ type: 'integrity-check-failed', problems: integrity.length });
      const comparison = compareCatalog(sqliteCatalog(database), sourceSpecFor('sqlite'));
      if (!comparison.match) failures.push({ type: 'output-fingerprint-mismatch', actual_fingerprint: comparison.actualFingerprint, expected_fingerprint: comparison.expectedFingerprint });
      report.output_fingerprint = comparison.actualFingerprint;
      report.foreign_key_violations = violations.length;
      report.integrity_check = integrity.length === 1 ? integrity[0] : 'failed';
      if (failures.length > 0) {
        report.unresolved.push(...failures);
        if (failures.every((failure) => CARRY_CODES.has(failure.type))) return finish({ refusal: { code: 'RMIG-E-NORMALISE-UNRESOLVED', summary: 'A value changed in the copy (type or value differs from the source); nothing was kept.' } });
        return finish({ refusal: { code: 'RMIG-E-NORMALISE-FAILED', summary: 'The normalised database failed its own checks (carried values, foreign keys, integrity or the exact v3.2 fingerprint); nothing was kept.' } });
      }
      return finish({ success: true });
    }
  } finally {
    try { database?.close(); } catch { /* the result matters more */ }
    rmSync(work, { recursive: true, force: true });
  }

  // Writes what is allowed to exist and returns, or throws the refusal. The report is always written. The database,
  // the set-aside file and the restore SQL are written only on success, the database only after it passed every check,
  // and what was written is removed again if a later write fails.
  function finish({ refusal, success = false }) {
    const status = success ? 'succeeded' : 'refused';
    const made = [];
    try {
      if (success) {
        try { database?.exec('DETACH DATABASE src'); } catch { /* already detached */ }
        if (restoreSqlPath !== null) {
          const restore = buildRestoreSql(setAside);
          report.restore_sql = { ...restore.counts, not_restored_items: restore.not_restored.map((item) => ({ section: item.section, key: item.key })) };
          writeBytesNew(PHASE, restoreSqlPath, Buffer.from(restore.sql ?? '-- Nothing in the set-aside data has a home in v4, so there is nothing to restore.\n', 'utf8'));
          made.push(restoreSqlPath);
        }
        database.close();
        database = undefined;
        try { chmodSync(builtPath, 0o600); } catch { /* not every filesystem has modes */ }
        writeBytesNew(PHASE, setAsidePath, Buffer.from(`${JSON.stringify(setAside, null, 2)}\n`, 'utf8'));
        made.push(setAsidePath);
        publishNew(PHASE, builtPath, outPath);
        made.push(outPath);
      }
      const details = { ...report, counts: counts() };
      const written = createReport({ migrator_version: VERSION, phase: PHASE, timestamp, migration_id: migrationId, status, details });
      writeReportAtomic(reportPath, written);
      if (!success) throw refuse(refusal.code, refusal.summary, { source_kind: sourceKind, unresolved: report.unresolved.length, ...unresolvedKinds() }, reportPath);
      return { command: PHASE, ...details.counts, out: outPath, set_aside: setAsidePath, restore_sql: restoreSqlPath, report: reportPath };
    } catch (error) {
      if (success) for (const path of made) { try { unlinkSync(path); } catch { /* best effort */ } }
      throw error;
    }
  }
  function counts() {
    const entries = Object.values(report.tables);
    return {
      tables_carried: entries.length,
      rows_carried: entries.reduce((total, entry) => total + (entry.rows_copied ?? 0), 0),
      set_aside_columns: entries.reduce((total, entry) => total + entry.set_aside_columns.length, 0),
      set_aside_column_rows: entries.reduce((total, entry) => total + entry.set_aside_column_rows, 0),
      set_aside_tables: Object.keys(report.set_aside_tables).length,
      set_aside_table_rows: Object.values(report.set_aside_tables).reduce((total, rows) => total + rows, 0),
      possible_renames: report.possible_renames.length,
      resolved: report.resolved.length,
      unresolved: report.unresolved.length,
    };
  }
  function unresolvedKinds() {
    const kinds = {};
    for (const item of report.unresolved) kinds[item.type] = (kinds[item.type] ?? 0) + 1;
    return { items_by_type: kinds };
  }
}

export function humanNormaliseSourceResult(result) {
  const restore = result.restore_sql === null ? '' : `; restore_sql=${result.restore_sql}`;
  return `normalise-source: complete; tables=${result.tables_carried}; rows=${result.rows_carried}; set_aside_columns=${result.set_aside_columns} (${result.set_aside_column_rows} rows); set_aside_tables=${result.set_aside_tables} (${result.set_aside_table_rows} rows); possible_renames=${result.possible_renames}; resolved=${result.resolved}; unresolved=0; out=${result.out}; set_aside=${result.set_aside}${restore}; report=${result.report}\n`;
}

export function normaliseSourceCommand(args) {
  return normaliseSource(args);
}
