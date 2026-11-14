import { describe, expect, it } from 'vitest';
import { handleApiEntities } from '../src/http/handlers/entities';
import type { Env } from '../src/types';

function routeEnv() {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const DB = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const s = {
        bind(...a: unknown[]) { args = a; return s; },
        async run() { calls.push({ sql, args }); return { success: true, meta: { last_row_id: 5, changes: 1 } }; },
        async first() {
          calls.push({ sql, args });
          if (/FROM entities WHERE id = \?/.test(sql)) {
            return args[0] === 1 ? { id: 1, name: 'From' } : args[0] === 2 ? { id: 2, name: 'Into' } : null;
          }
          if (/^\s*WITH p AS/.test(sql)) return { entities_deleted: 1, observations_moved: 3 };
          return null;
        },
        async all() { calls.push({ sql, args }); return { results: [] }; },
      };
      return s;
    },
  };
  return { env: { DB } as unknown as Env, calls };
}

const post = (env: Env, parts: string[], body: Record<string, unknown>) =>
  handleApiEntities(
    new Request(`https://mind.example/${parts.join('/')}`, { method: 'POST', body: JSON.stringify(body) }),
    env,
    parts,
  );

describe('POST /api/entities routing', () => {
  it('reaches the merge branch for /api/entities/merge', async () => {
    const { env, calls } = routeEnv();

    const res = await post(env, ['api', 'entities', 'merge'], { merge_from_id: 1, merge_into_id: 2 });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, merged_from: 'From', merged_into: 'Into', observations_moved: 3 });
    expect(calls.some((c) => /INSERT INTO entities/.test(c.sql))).toBe(false);
  });

  it('validates merge input instead of creating an entity', async () => {
    const { env, calls } = routeEnv();

    const res = await post(env, ['api', 'entities', 'merge'], { merge_from_id: 1 });

    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('still creates an entity for POST /api/entities', async () => {
    const { env, calls } = routeEnv();

    const res = await post(env, ['api', 'entities'], { name: 'New one', entity_type: 'place' });

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ id: 5, name: 'New one' });
    expect(calls.find((c) => /INSERT INTO entities/.test(c.sql))?.args).toEqual(['New one', 'place', 'default']);
  });
});
