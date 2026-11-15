// Reads the live v4 target, read-only, for validation.
//
// One REPEATABLE READ READ ONLY transaction, with the same transaction-local session settings the source
// adapter uses (set_config, never startup options, so it works behind a transaction-mode pooler), reads
//  - the database identity, the import receipt row the importer wrote, and the migration ledger;
//  - every constraint, index, foreign key, CHECK and sequence, and re-proves them against the stored rows;
//  - every row of every table the migration populates, as exact text (timestamps as RFC 3339 with all six
//    fractional digits, json and jsonb as the text PostgreSQL prints).
// It writes nothing. Findings carry table names, counts and constraint names, never row content.

import { parseInstantMicros } from '../lib/instant.mjs';
import { MigrationRefusal } from '../lib/refusal.mjs';
import { SOURCE_SESSION_SETTINGS } from '../source/postgres-v32.mjs';
import { readSerialTables, ledgerBinding, readIdentityInTransaction } from '../target/postgres.mjs';
import { COMPARED_TARGET_TABLES } from './compare.mjs';
import { CHECKS_QUERY, classifyChecks, loadExpectedChecks } from '../spec/v4-checks.mjs';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const quote = (name) => {
  if (typeof name !== 'string' || !IDENTIFIER.test(name)) throw new MigrationRefusal({ code: 'RMIG-E-TARGET-SCHEMA', phase: 'validate', summary: 'The target contains a table or column name this validator will not put in SQL.', safe_details: {}, report_path: null });
  return `"${name}"`;
};

async function applySessionSettings(client) {
  await client.query(`SELECT ${SOURCE_SESSION_SETTINGS.map((_setting, index) => `set_config($${index * 2 + 1}, $${index * 2 + 2}, true)`).join(', ')}`, SOURCE_SESSION_SETTINGS.flatMap(({ name, value }) => [name, value]));
  const applied = (await client.query("SELECT current_setting('TimeZone') AS timezone, current_setting('DateStyle') AS datestyle, current_setting('search_path') AS search_path, current_setting('extra_float_digits') AS extra_float_digits")).rows[0] ?? {};
  if (applied.timezone !== 'UTC' || applied.datestyle !== 'ISO, YMD' || applied.search_path !== 'public' || applied.extra_float_digits !== '1') {
    throw new MigrationRefusal({ code: 'RMIG-E-TARGET-SCHEMA', phase: 'validate', summary: 'PostgreSQL did not apply the snapshot session settings to the target read.', safe_details: {}, report_path: null });
  }
}

/** The dimension of the target's own embeddings.embedding column (vector(768) is 768), or null when it cannot be read. */
export function embeddingDimensionOf(columnTypes) {
  const match = /^vector\((\d+)\)$/u.exec(columnTypes?.embeddings?.embedding ?? '');
  return match === null ? null : Number(match[1]);
}

/**
 * @param client   a connected pg client created with the exact-text type parsers (postgresClientConfig)
 * @param findings a Findings collector; live-database findings are added to it
 */
export async function readLiveTarget({ client, migrationId, findings }) {
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const readOnly = await client.query('SHOW transaction_read_only');
    if (String(readOnly.rows[0]?.transaction_read_only).toLowerCase() !== 'on') throw new MigrationRefusal({ code: 'RMIG-E-TARGET-SCHEMA', phase: 'validate', summary: 'Validation could not prove a read-only transaction on the target.', safe_details: {}, report_path: null });
    await applySessionSettings(client);
    const identity = await readIdentityInTransaction(client);

    // The receipt the importer committed together with the data.
    const receiptTable = await client.query("SELECT to_regclass('public.migration_import_receipts')::text AS name");
    let receiptRow = null;
    if (receiptTable.rows[0]?.name) receiptRow = (await client.query('SELECT migration_id, bundle_manifest_sha256, compiled_policy_sha256, target_identity_sha256, migration_set_sha256, migrator_version, plan_sha256, stage_content_sha256, target_state_sha256, receipt_sha256, status, imported_at FROM public.migration_import_receipts WHERE migration_id = $1', [migrationId])).rows[0] ?? null;
    let importedAt = null;
    if (receiptRow) { try { importedAt = parseInstantMicros(receiptRow.imported_at); } catch { importedAt = null; } }

    // The released migration set, as the importer binds it.
    let ledger = null;
    const ledgerTable = await client.query("SELECT to_regclass('public.schema_migrations')::text AS name");
    if (!ledgerTable.rows[0]?.name) findings.add('target-ledger-mismatch', { reason: 'no-migration-ledger' });
    else { try { ledger = await ledgerBinding(client); } catch (error) { findings.add('target-ledger-mismatch', { reason: error instanceof MigrationRefusal ? error.code : 'ledger-unreadable' }); } }

    // Constraints and indexes: nothing may be left unvalidated or invalid.
    const constraints = (await client.query("SELECT c.conname::text AS name, rel.relname::text AS table_name, c.contype::text AS kind, c.convalidated AS validated FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class rel ON rel.oid = c.conrelid JOIN pg_catalog.pg_namespace n ON n.oid = rel.relnamespace WHERE n.nspname = 'public' AND c.contype IN ('p', 'u', 'f', 'c')")).rows;
    for (const row of constraints) if (!row.validated) findings.add('constraint-not-validated', { table: row.table_name, constraint: row.name });
    const indexes = (await client.query("SELECT idx.relname::text AS name, tab.relname::text AS table_name, i.indisvalid AS valid, i.indisready AS ready FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class idx ON idx.oid = i.indexrelid JOIN pg_catalog.pg_class tab ON tab.oid = i.indrelid JOIN pg_catalog.pg_namespace n ON n.oid = tab.relnamespace WHERE n.nspname = 'public'")).rows;
    for (const row of indexes) if (!row.valid || !row.ready) findings.add('index-not-valid', { table: row.table_name, index: row.name });

    // Foreign keys: re-proved with an anti-join per key, whatever the constraint says about itself.
    const foreignKeys = (await client.query("SELECT c.conname::text AS name, rel.relname::text AS child, refrel.relname::text AS parent, array_agg(att.attname::text ORDER BY k.ord) AS child_columns, array_agg(ratt.attname::text ORDER BY k.ord) AS parent_columns FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class rel ON rel.oid = c.conrelid JOIN pg_catalog.pg_namespace n ON n.oid = rel.relnamespace JOIN pg_catalog.pg_class refrel ON refrel.oid = c.confrelid CROSS JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS k(child_attnum, parent_attnum, ord) JOIN pg_catalog.pg_attribute att ON att.attrelid = c.conrelid AND att.attnum = k.child_attnum JOIN pg_catalog.pg_attribute ratt ON ratt.attrelid = c.confrelid AND ratt.attnum = k.parent_attnum WHERE n.nspname = 'public' AND c.contype = 'f' GROUP BY c.conname, rel.relname, refrel.relname ORDER BY rel.relname, c.conname")).rows;
    let foreignKeysChecked = 0;
    for (const key of foreignKeys) {
      const match = key.child_columns.map((column, position) => `p.${quote(key.parent_columns[position])} = c.${quote(column)}`).join(' AND ');
      const present = key.child_columns.map((column) => `c.${quote(column)} IS NOT NULL`).join(' AND ');
      const orphans = Number((await client.query(`SELECT count(*)::text AS n FROM public.${quote(key.child)} c WHERE ${present} AND NOT EXISTS (SELECT 1 FROM public.${quote(key.parent)} p WHERE ${match})`)).rows[0].n);
      foreignKeysChecked += 1;
      if (orphans > 0) findings.add('foreign-key-orphans', { table: key.child, constraint: key.name, rows: orphans });
    }

    // Unique and primary-key indexes: no duplicates among the stored rows. The check groups by the index's key
    // columns, which only says what a plain unique index means. A unique index that is partial (it has a
    // predicate) or built on an expression means something else, and the validator will not run text from the
    // target's catalog to find out what; the released v4 schema has none, so one is a finding, like an
    // unexpected CHECK, and is not evaluated.
    const oddUniques = (await client.query("SELECT idx.relname::text AS name, tab.relname::text AS table_name, (i.indpred IS NOT NULL) AS partial, (i.indexprs IS NOT NULL) AS expression FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class idx ON idx.oid = i.indexrelid JOIN pg_catalog.pg_class tab ON tab.oid = i.indrelid JOIN pg_catalog.pg_namespace n ON n.oid = tab.relnamespace WHERE n.nspname = 'public' AND i.indisunique AND (i.indpred IS NOT NULL OR i.indexprs IS NOT NULL) ORDER BY tab.relname, idx.relname")).rows;
    for (const row of oddUniques) findings.add('unique-index-unexpected', { table: row.table_name, index: row.name, reason: row.partial ? 'partial-not-in-the-released-schema' : 'expression-not-in-the-released-schema' });
    const uniques = (await client.query("SELECT idx.relname::text AS name, tab.relname::text AS table_name, array_agg(att.attname::text ORDER BY k.ord) AS columns FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class idx ON idx.oid = i.indexrelid JOIN pg_catalog.pg_class tab ON tab.oid = i.indrelid JOIN pg_catalog.pg_namespace n ON n.oid = tab.relnamespace CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord) JOIN pg_catalog.pg_attribute att ON att.attrelid = i.indrelid AND att.attnum = k.attnum WHERE n.nspname = 'public' AND i.indisunique AND i.indpred IS NULL AND i.indexprs IS NULL AND k.attnum > 0 AND k.ord <= i.indnkeyatts GROUP BY idx.relname, tab.relname ORDER BY tab.relname, idx.relname")).rows;
    let uniquesChecked = 0;
    for (const unique of uniques) {
      const columns = unique.columns.map(quote).join(', ');
      const notNull = unique.columns.map((column) => `${quote(column)} IS NOT NULL`).join(' AND ');
      const duplicates = Number((await client.query(`SELECT count(*)::text AS n FROM (SELECT 1 FROM public.${quote(unique.table_name)} WHERE ${notNull} GROUP BY ${columns} HAVING count(*) > 1) d`)).rows[0].n);
      uniquesChecked += 1;
      if (duplicates > 0) findings.add('unique-duplicates', { table: unique.table_name, index: unique.name, groups: duplicates });
    }

    // CHECK constraints: each released constraint's expression is evaluated against every stored row (a CHECK
    // passes on TRUE or NULL). The expression is text from the target's catalog, so it is only evaluated when it
    // is exactly the released v4 schema's own (spec/v4-checks.json); any other CHECK is a finding and is never
    // run, because running it would execute whatever the target's catalog says with the validator's rights.
    const catalogChecks = (await client.query(CHECKS_QUERY)).rows;
    const classified = classifyChecks(catalogChecks, loadExpectedChecks().checks);
    for (const item of classified.unexpected) findings.add('check-constraint-unexpected', item);
    for (const item of classified.missing) findings.add('check-constraint-missing', item);
    let checksChecked = 0;
    for (const check of classified.evaluate) {
      const violations = Number((await client.query(`SELECT count(*)::text AS n FROM public.${quote(check.table_name)} WHERE (${check.expression}) IS FALSE`)).rows[0].n);
      checksChecked += 1;
      if (violations > 0) findings.add('check-violations', { table: check.table_name, constraint: check.name, rows: violations });
    }

    // Column types, to know which text columns are really json, and every row of every migrated table.
    const columnTypes = {};
    for (const row of (await client.query("SELECT c.relname::text AS table_name, a.attname::text AS column_name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped")).rows) (columnTypes[row.table_name] ??= {})[row.column_name] = row.data_type;
    // What fills a column the plan does not state: its default (as the catalog prints it, never evaluated here), or the database computing it.
    const columnDefaults = {};
    for (const row of (await client.query("SELECT c.relname::text AS table_name, a.attname::text AS column_name, pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS column_default, (a.attgenerated::text <> '') AS generated, (a.attidentity::text <> '') AS identity FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped")).rows) (columnDefaults[row.table_name] ??= {})[row.column_name] = { default: row.column_default, generated: row.generated, identity: row.identity };
    // The range of every sequence, so that a column filled by nextval(...) can be checked to hold a value the sequence could give.
    const sequenceRanges = {};
    for (const row of (await client.query("SELECT n.nspname::text AS schema_name, c.relname::text AS sequence_name, s.seqmin::text AS min, s.seqmax::text AS max FROM pg_catalog.pg_sequence s JOIN pg_catalog.pg_class c ON c.oid = s.seqrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'")).rows) sequenceRanges[`${row.schema_name}.${row.sequence_name}`] = { min: row.min, max: row.max };
    const tables = {};
    for (const table of COMPARED_TARGET_TABLES) {
      if (!columnTypes[table]) { findings.add('target-table-missing', { table }); tables[table] = []; continue; }
      const order = columnTypes[table].id ? ' ORDER BY id' : '';
      tables[table] = (await client.query(`SELECT * FROM public.${quote(table)}${order}`)).rows;
    }

    // Sequences: the next value of every serial id must be beyond the largest id stored.
    const sequences = [];
    for (const table of await readSerialTables(client)) { // from the target's catalog, cross-checked against the migrator's list (refuses on a disagreement)
      if (!columnTypes[table]?.id) continue;
      const name = (await client.query("SELECT pg_catalog.pg_get_serial_sequence($1, 'id') AS name", [`public.${table}`])).rows[0]?.name;
      if (!name) continue;
      const [schema, sequence] = String(name).replaceAll('"', '').split('.');
      const state = (await client.query(`SELECT last_value::text AS last_value, is_called FROM ${quote(schema)}.${quote(sequence)}`)).rows[0];
      const next = state.is_called ? BigInt(state.last_value) + 1n : BigInt(state.last_value);
      const ids = (tables[table] ?? []).map((row) => BigInt(row.id));
      const maximum = ids.length === 0 ? 0n : ids.reduce((a, b) => (a > b ? a : b));
      sequences.push({ table, next_value: next.toString(), max_id: maximum.toString() });
      if (next <= maximum) findings.add('sequence-behind-data', { table });
    }

    return {
      identity,
      receiptRow,
      importedAt,
      ledger,
      tables,
      columnTypes,
      columnDefaults,
      sequenceRanges,
      embeddingDimension: embeddingDimensionOf(columnTypes),
      checks: { constraints: constraints.length, foreign_keys: foreignKeysChecked, unique_indexes: uniquesChecked, check_constraints: checksChecked, check_constraints_unexpected: classified.unexpected.length, indexes: indexes.length, sequences },
    };
  } finally {
    try { await client.query('ROLLBACK'); } catch { /* the read result or the refusal matters more */ }
  }
}
