import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IMPORT_ORDER, SERIAL_TABLES, reconcileSerialTables, resetSequence } from '../../scripts/v32-to-v4/target/postgres.mjs';
import { COMPARED_TARGET_TABLES } from '../../scripts/v32-to-v4/validate/compare.mjs';

// Issue #26: relations and consolidation_groups have a serial id but were missing from the set whose sequences
// are reset after import (and checked by validate). The set is now read from the target's catalog and this
// list is only a cross-check; these tests keep the list honest without a database, by reading the migration SQL.
const MIGRATIONS = join(import.meta.dirname, '..', '..', 'migrations', 'postgres');

function serialTablesInMigrations() {
  const found = new Set();
  for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8').replace(/--[^\n]*/gu, '');
    for (const chunk of sql.split(/\bCREATE\s+TABLE\b/iu).slice(1)) {
      const name = /^\s*(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\(/iu.exec(chunk)?.[1];
      if (name === undefined) continue;
      const body = chunk.slice(0, chunk.search(/\n\)\s*;/u) === -1 ? undefined : chunk.search(/\n\)\s*;/u));
      if (/^\s*id\s+(?:BIG)?SERIAL\b/imu.test(body)) found.add(name);
    }
  }
  return found;
}

describe('serial id tables', () => {
  it('the migration SQL has a serial id for relations and consolidation_groups (so the parser below sees them)', () => {
    const serial = serialTablesInMigrations();
    expect(serial.has('relations')).toBe(true);
    expect(serial.has('consolidation_groups')).toBe(true);
  });

  it('every IMPORT_ORDER table with a serial id in migrations/postgres is in SERIAL_TABLES, and nothing else is', () => {
    const serial = serialTablesInMigrations();
    const expected = IMPORT_ORDER.filter((table) => serial.has(table)).sort();
    expect([...SERIAL_TABLES].sort()).toEqual(expected);
  });

  it('every serial table is one the validator compares, so its ids are read for the sequence check', () => {
    for (const table of SERIAL_TABLES) expect(COMPARED_TARGET_TABLES).toContain(table);
  });
});

describe('reconcileSerialTables', () => {
  const catalogFor = (tables, serial = tables) => tables.map((table_name) => ({ table_name, serial: serial.includes(table_name) }));

  it('returns the catalog set when it agrees with the list', () => {
    expect([...reconcileSerialTables(catalogFor([...SERIAL_TABLES, 'people', 'nodes'], [...SERIAL_TABLES]))].sort()).toEqual([...SERIAL_TABLES].sort());
  });

  it('ignores a listed table that is absent from the target (other checks report a missing table)', () => {
    const rows = catalogFor([...SERIAL_TABLES].filter((table) => table !== 'journals'));
    expect(reconcileSerialTables(rows).has('journals')).toBe(false);
  });

  it('refuses when the target has a serial id the list does not know', () => {
    const rows = [...catalogFor([...SERIAL_TABLES]), { table_name: 'threads', serial: true }];
    expect(() => reconcileSerialTables(rows)).toThrow(expect.objectContaining({ code: 'RMIG-E-TARGET-SCHEMA' }));
  });

  it('refuses when the list names a table whose id is not serial in the target', () => {
    const rows = catalogFor([...SERIAL_TABLES], [...SERIAL_TABLES].filter((table) => table !== 'relations'));
    expect(() => reconcileSerialTables(rows)).toThrow(expect.objectContaining({ code: 'RMIG-E-TARGET-SCHEMA' }));
  });
});

describe('resetSequence', () => {
  const clientFor = () => {
    const calls = [];
    return { calls, async query(text) {
      calls.push(text);
      if (/pg_get_serial_sequence/u.test(text)) return { rows: [{ schema_name: 'public', sequence_name: 'relations_id_seq' }] };
      if (/MAX\(id\)/u.test(text)) return { rows: [{ max_id: '41' }] };
      return { rows: [] };
    } };
  };

  it('moves the relations sequence past the largest imported id', async () => {
    const client = clientFor();
    await resetSequence(client, 'relations', new Set(['relations']));
    expect(client.calls).toContain('ALTER SEQUENCE "public"."relations_id_seq" RESTART WITH 42');
  });

  it('leaves a table alone that the catalog says has no serial id', async () => {
    const client = clientFor();
    await resetSequence(client, 'relations', new Set(['entities']));
    expect(client.calls).toEqual([]);
  });
});
