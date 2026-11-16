import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runChecks, sequenceStatus } from '../../scripts/check-sequences.mjs';

describe('check:sequences', () => {
  it('judges a sequence behind its data when the next value is not beyond the largest id', () => {
    expect(sequenceStatus(1n, 40n)).toBe('behind');
    expect(sequenceStatus(40n, 40n)).toBe('behind');
    expect(sequenceStatus(41n, 40n)).toBe('ok');
    expect(sequenceStatus(1n, null)).toBe('ok');
  });

  it('only reads: one READ ONLY transaction of SELECTs, rolled back, and reports numbers only', async () => {
    const calls = [];
    const client = { async query(text, values) {
      calls.push(text.trim());
      if (/FROM pg_catalog\.pg_class/u.test(text)) return { rows: [{ table_name: 'relations' }, { table_name: 'journals' }] };
      if (/pg_get_serial_sequence/u.test(text)) return { rows: [{ name: `public.${values[0].includes('relations') ? 'relations' : 'journals'}_id_seq` }] };
      if (/FROM public\.relations_id_seq|FROM public\.journals_id_seq/u.test(text)) return { rows: [{ last_value: '1', is_called: false }] };
      if (/max\(id\)/u.test(text)) return { rows: [{ max_id: /relations/u.test(text) ? '12' : null }] };
      return { rows: [] };
    } };
    const results = await runChecks(client);
    expect(results).toEqual([
      { table: 'relations', next_value: '1', max_id: '12', status: 'behind' },
      { table: 'journals', next_value: '1', max_id: null, status: 'ok' },
    ]);
    expect(calls[0]).toBe('BEGIN TRANSACTION READ ONLY');
    expect(calls.at(-1)).toBe('ROLLBACK');
    for (const text of calls.slice(1, -1)) expect(text).toMatch(/^SELECT\b/u);
  });

  it('is wired as an npm script and documented with the repair', () => {
    const root = join(import.meta.dirname, '..', '..');
    expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts['check:sequences']).toBe('node scripts/check-sequences.mjs');
    const guide = readFileSync(join(root, 'USER_MIGRATION_GUIDE.md'), 'utf8');
    expect(guide).toContain("SELECT setval(pg_get_serial_sequence('public.relations','id'), (SELECT max(id) FROM public.relations), true);");
    expect(guide).toContain('npm run check:sequences');
  });
});
