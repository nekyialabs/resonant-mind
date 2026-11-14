import { describe, expect, it, vi } from 'vitest';

const queries: Array<{ sql: string; values: unknown[] }> = [];
vi.mock('pg', () => ({
  Client: class {
    async connect() {}
    async end() {}
    async query(sql: string, values: unknown[]) {
      queries.push({ sql, values });
      return { rows: [], rowCount: 0 };
    }
  },
}));

import { createD1Adapter } from '../src/adapter';

describe('adapter and LIKE ... ESCAPE', () => {
  it('keeps the escape literal and numbers placeholders on both sides of it', async () => {
    const db = createD1Adapter({ connectionString: 'postgres://unused' });
    await db.prepare("SELECT id FROM t WHERE id LIKE ? ESCAPE '\\' AND kind = ?").bind('a\\%', 'k').all();
    expect(queries[0].sql).toBe("SELECT id FROM t WHERE id LIKE $1 ESCAPE '\\' AND kind = $2");
    expect(queries[0].values).toEqual(['a\\%', 'k']);
  });
});
