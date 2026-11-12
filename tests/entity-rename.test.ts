import { describe, expect, it, vi } from 'vitest';
import { handleMindEntity } from '../src/legacy-tools/entity';
import { handleApiEntities } from '../src/http/handlers/entities';
import type { Env } from '../src/types';

vi.mock('../src/shared/mind-helpers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getEmbedding: async () => [0],
}));

type Row = Record<string, unknown>;

function entityEnv(opts: { writeError?: unknown } = {}) {
  const entities: Row[] = [
    { id: 1, name: 'Lantern', entity_type: 'concept', primary_context: 'default', salience: 'active' },
    { id: 2, name: 'Harbor', entity_type: 'place', primary_context: 'default', salience: 'active' },
  ];
  const calls: Array<{ sql: string; args: unknown[]; kind: string }> = [];
  const DB = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const statement = {
        bind(...bound: unknown[]) { args = bound; return statement; },
        async run() {
          calls.push({ sql, args, kind: 'run' });
          if (opts.writeError) throw opts.writeError;
          return { success: true, meta: { changes: 1 } };
        },
        async first() {
          calls.push({ sql, args, kind: 'first' });
          if (/SELECT id, name, entity_type, primary_context, salience FROM entities WHERE id = \?/.test(sql)) {
            return entities.find((e) => e.id === args[0]) ?? null;
          }
          if (/SELECT id, name FROM entities WHERE id = \?/.test(sql) || /SELECT id FROM entities WHERE id = \?/.test(sql)) {
            return entities.find((e) => e.id === args[0]) ?? null;
          }
          if (/SELECT id FROM entities WHERE name = \? AND id != \?/.test(sql)) {
            return entities.find((e) => e.name === args[0] && e.id !== args[1]) ?? null;
          }
          if (/^\s*WITH p AS/.test(sql)) {
            if (opts.writeError) throw opts.writeError;
            return { relations_updated: 2, entities_updated: 1 };
          }
          throw new Error(`unexpected first: ${sql}`);
        },
        async all() { calls.push({ sql, args, kind: 'all' }); return { results: [] }; },
      };
      return statement;
    },
  };
  const env = { DB, VECTORS: { upsert: async () => undefined } } as unknown as Env;
  return { env, calls };
}

const writes = (calls: Array<{ sql: string }>) =>
  calls.filter((c) => /^\s*(UPDATE|WITH|DELETE|INSERT)/i.test(c.sql));

describe('graph_shape edit rename', () => {
  it('refuses a name another entity holds and writes nothing', async () => {
    const { env, calls } = entityEnv();

    const out = await handleMindEntity(env, { action: 'edit', entity_id: 1, new_name: 'Harbor' });

    expect(out).toMatch(/another entity already has that name/);
    expect(out).toMatch(/merge/);
    expect(writes(calls)).toEqual([]);
  });

  it('renames the entity and its relations in one statement', async () => {
    const { env, calls } = entityEnv();

    const out = await handleMindEntity(env, { action: 'edit', entity_id: 1, new_name: 'Beacon', new_type: 'object' });

    expect(out).toMatch(/Updated entity #1/);
    const w = writes(calls);
    expect(w).toHaveLength(1);
    expect(w[0].sql).toMatch(/UPDATE relations/);
    expect(w[0].sql).toMatch(/UPDATE entities/);
    expect(w[0].args).toEqual([1, 'Lantern', 'Beacon', 'object']);
  });

  it('refuses cleanly when the database reports a unique violation', async () => {
    const { env } = entityEnv({ writeError: Object.assign(new Error('duplicate key'), { code: '23505' }) });

    const out = await handleMindEntity(env, { action: 'edit', entity_id: 1, new_name: 'Beacon' });

    expect(out).toMatch(/another entity already has that name/);
    expect(out).not.toMatch(/duplicate key/);
  });

  it('updates type without touching relations', async () => {
    const { env, calls } = entityEnv();

    await handleMindEntity(env, { action: 'edit', entity_id: 1, new_type: 'object' });

    const w = writes(calls);
    expect(w).toHaveLength(1);
    expect(w[0].sql).not.toMatch(/relations/);
    expect(w[0].args).toEqual(['object', 1]);
  });
});

describe('PUT /api/entities/:id rename', () => {
  const put = (env: Env, body: Record<string, unknown>) =>
    handleApiEntities(
      new Request('https://mind.example/api/entities/1', { method: 'PUT', body: JSON.stringify(body) }),
      env,
      ['api', 'entities', '1'],
    );

  it('returns 409 for a taken name and writes nothing', async () => {
    const { env, calls } = entityEnv();

    const res = await put(env, { name: 'Harbor' });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ conflicting_entity_id: 2 });
    expect(writes(calls)).toEqual([]);
  });

  it('returns 409 rather than 500 on a unique violation', async () => {
    const { env } = entityEnv({ writeError: Object.assign(new Error('duplicate key'), { code: '23505' }) });

    const res = await put(env, { name: 'Beacon' });

    expect(res.status).toBe(409);
  });

  it('renames atomically when the name is free', async () => {
    const { env, calls } = entityEnv();

    const res = await put(env, { name: 'Beacon', salience: 'background' });

    expect(res.status).toBe(200);
    const w = writes(calls);
    expect(w).toHaveLength(1);
    expect(w[0].args).toEqual([1, 'Lantern', 'Beacon', 'background']);
  });

  it('rejects a non-string name with 400', async () => {
    const { env, calls } = entityEnv();

    const res = await put(env, { name: null });

    expect(res.status).toBe(400);
    expect(writes(calls)).toEqual([]);
  });
});
