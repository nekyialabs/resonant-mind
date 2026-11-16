#!/usr/bin/env node
// check-sequences — READ-ONLY check that every serial `id` sequence in the public schema is ahead of
// the largest id stored in its table (see USER_MIGRATION_GUIDE.md, "Id sequences after a migration").
//
// A sequence that is behind its data hands out ids that already exist: the next INSERT into that table
// fails with a duplicate primary key. Before 4.1.6 the v3.2 -> v4 migrator did not reset the `relations`
// and `consolidation_groups` sequences after importing, so a migrated mind can be in this state.
//
// It opens one READ ONLY transaction, runs SELECTs, rolls back, and prints table names and integers.
// It never writes and never prints row content.
//
//   PG_URL=postgres://... npm run check:sequences            # human report
//   PG_URL=postgres://... npm run check:sequences -- --json  # machine report
//
// Exit codes: 0 every sequence is ahead of its data, 1 at least one is behind, 2 the check could not run.
import pg from 'pg';
import { pathToFileURL } from 'node:url';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const SEQUENCE_NAME = /^(?:"?[A-Za-z_][A-Za-z0-9_]*"?\.)?"?[A-Za-z_][A-Za-z0-9_]*"?$/u;

// Every ordinary table in `public` whose `id` column is filled from a sequence (SERIAL, BIGSERIAL or an identity column).
const SERIAL_TABLES_SQL = `
  SELECT c.relname::text AS table_name
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attname = 'id' AND NOT a.attisdropped
  LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
    AND (pg_catalog.pg_get_expr(d.adbin, d.adrelid) LIKE 'nextval(%' OR a.attidentity <> '')
  ORDER BY c.relname
`;

/** Pure: the verdict for one table. `next` and `max` are BigInt (max is null for an empty table). */
export function sequenceStatus(next, max) {
  return max !== null && next <= max ? 'behind' : 'ok';
}

export async function runChecks(client) {
  await client.query('BEGIN TRANSACTION READ ONLY');
  try {
    const tables = (await client.query(SERIAL_TABLES_SQL)).rows.map((row) => row.table_name);
    const results = [];
    for (const table of tables) {
      if (!IDENTIFIER.test(table)) { results.push({ table, error: 'table name is not a plain identifier; skipped' }); continue; }
      const sequence = (await client.query("SELECT pg_catalog.pg_get_serial_sequence($1, 'id') AS name", [`public."${table}"`])).rows[0]?.name;
      if (!sequence || !SEQUENCE_NAME.test(sequence)) { results.push({ table, error: 'no sequence is attached to this id column; skipped' }); continue; }
      const state = (await client.query(`SELECT last_value::text AS last_value, is_called FROM ${sequence}`)).rows[0];
      const next = state.is_called ? BigInt(state.last_value) + 1n : BigInt(state.last_value);
      const maxText = (await client.query(`SELECT max(id)::text AS max_id FROM public."${table}"`)).rows[0]?.max_id ?? null;
      const max = maxText === null ? null : BigInt(maxText);
      results.push({ table, next_value: next.toString(), max_id: max === null ? null : max.toString(), status: sequenceStatus(next, max) });
    }
    return results;
  } finally {
    await client.query('ROLLBACK');
  }
}

function printHuman(results) {
  console.log('Resonant Mind id sequence check (read-only; nothing was changed)\n');
  const width = Math.max(5, ...results.map((r) => r.table.length));
  console.log(`${'table'.padEnd(width)}  ${'next value'.padStart(12)}  ${'max id'.padStart(12)}  status`);
  for (const r of results) {
    if (r.error) { console.log(`${r.table.padEnd(width)}  ${r.error}`); continue; }
    console.log(`${r.table.padEnd(width)}  ${r.next_value.padStart(12)}  ${(r.max_id ?? '(empty)').padStart(12)}  ${r.status === 'behind' ? 'BEHIND' : 'ok'}`);
  }
  const behind = results.filter((r) => r.status === 'behind');
  console.log(behind.length
    ? `\n${behind.length} sequence(s) are behind their data: the next INSERT into ${behind.map((r) => r.table).join(', ')} will fail with a duplicate key. Do not change anything yet: take a backup and read "Id sequences after a migration" in USER_MIGRATION_GUIDE.md. The repair is the owner's decision.`
    : '\nEvery sequence is ahead of its data.');
}

async function main() {
  const connectionString = process.env.PG_URL || process.env.DATABASE_URL;
  if (!connectionString) { console.error('PG_URL or DATABASE_URL is required'); process.exitCode = 2; return; }
  // Same TLS rules as db:migrate (verify by default, PG_SSL_NO_VERIFY=1 to skip verification);
  // `sslmode=disable` in the URL is honoured for a local database.
  const ssl = /[?&]sslmode=disable\b/.test(connectionString) ? false
    : process.env.PG_SSL_NO_VERIFY === '1' ? { rejectUnauthorized: false } : { rejectUnauthorized: true };
  const client = new pg.Client({ connectionString, ssl });
  try {
    await client.connect();
    const results = await runChecks(client);
    if (process.argv.includes('--json')) console.log(JSON.stringify({ read_only: true, results }, null, 2));
    else printHuman(results);
    process.exitCode = results.some((r) => r.status === 'behind') ? 1 : results.some((r) => r.error) ? 2 : 0;
  } catch (error) {
    console.error(`check could not run: ${error?.message ?? error}`);
    process.exitCode = 2;
  } finally {
    await client.end().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
