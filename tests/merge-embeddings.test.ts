import { describe, expect, it } from 'vitest';
import { deleteObservation, mergeEntities } from '../src/shared/surgery';
import type { Env } from '../src/types';

type Row = Record<string, unknown>;

function recordingEnv(first: (sql: string, args: unknown[]) => Row | null = () => null) {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const DB = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const statement = {
        bind(...bound: unknown[]) { args = bound; return statement; },
        async run() { calls.push({ sql, args }); return { success: true, meta: { changes: 3 } }; },
        async first() { calls.push({ sql, args }); return first(sql, args); },
        async all() { calls.push({ sql, args }); return { results: [] }; },
      };
      return statement;
    },
  };
  return { env: { DB } as unknown as Env, calls };
}

const entities: Record<number, Row> = { 7: { id: 7, name: 'Old Lantern' }, 3: { id: 3, name: 'Harbor' } };
const entityLookup = (sql: string, args: unknown[]) =>
  /FROM entities WHERE id = \?/.test(sql) ? entities[args[0] as number] ?? null : null;

describe('deleteObservation embeddings cleanup', () => {
  it('deletes the vector by (source_type, source_id), not by a rebuilt obs-{entity}-{id} key', async () => {
    const { env, calls } = recordingEnv((sql) =>
      /SELECT content, entity_id FROM observations/.test(sql) ? { content: 'moved once', entity_id: 3 } : null);

    await deleteObservation(env, 42);

    const embeddingDelete = calls.find((c) => /DELETE FROM embeddings/.test(c.sql));
    expect(embeddingDelete?.sql).toMatch(/source_type\s*=\s*'observation'\s+AND\s+source_id\s*=\s*\?/);
    expect(embeddingDelete?.args).toEqual([42]);
    expect(calls.some((c) => c.args.includes('obs-3-42'))).toBe(false);
  });
});

describe('mergeEntities', () => {
  it('re-keys moved vectors to the target entity before the observations move', async () => {
    const { env, calls } = recordingEnv(entityLookup);

    const result = await mergeEntities(env, 7, 3);

    expect(result).toMatchObject({ found: true, fromName: 'Old Lantern', intoName: 'Harbor', observationsMoved: 3 });
    const rekey = calls.findIndex((c) => /UPDATE embeddings/.test(c.sql));
    const move = calls.findIndex((c) => /UPDATE observations SET entity_id/.test(c.sql));
    expect(rekey).toBeGreaterThan(-1);
    expect(rekey).toBeLessThan(move);
    expect(calls[rekey].sql).toMatch(/SET id = 'obs-' \|\| \?::text \|\| '-' \|\| source_id/);
    expect(calls[rekey].sql).toMatch(/jsonb_set\(.*'\{entity\}'/s);
    expect(calls[rekey].args).toEqual([3, 'Harbor', 7]);
  });

  it("drops the source entity's own vector and deletes the source entity last", async () => {
    const { env, calls } = recordingEnv(entityLookup);

    await mergeEntities(env, 7, 3);

    expect(calls.some((c) => /DELETE FROM embeddings WHERE id = \?/.test(c.sql) && c.args[0] === 'entity-7')).toBe(true);
    const last = calls[calls.length - 1];
    expect(last.sql).toMatch(/DELETE FROM entities WHERE id = \?/);
    expect(last.args).toEqual([7]);
  });

  it('moves relations by name', async () => {
    const { env, calls } = recordingEnv(entityLookup);

    await mergeEntities(env, 7, 3);

    const relationUpdates = calls.filter((c) => /UPDATE relations/.test(c.sql));
    expect(relationUpdates.map((c) => c.args)).toEqual([['Harbor', 'Old Lantern'], ['Harbor', 'Old Lantern']]);
  });

  it('touches nothing when either entity is missing', async () => {
    const { env, calls } = recordingEnv(entityLookup);

    expect(await mergeEntities(env, 99, 3)).toEqual({ found: false, missing: 'from' });
    expect(await mergeEntities(env, 7, 99)).toEqual({ found: false, missing: 'into' });
    expect(calls.every((c) => /^SELECT/.test(c.sql.trim()))).toBe(true);
  });
});
