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
  it('refuses a merge of an entity into itself before reading or writing anything', async () => {
    const { env, calls } = recordingEnv(entityLookup);

    expect(await mergeEntities(env, 7, 7)).toEqual({ found: false, refused: 'same-entity' });
    expect(calls).toEqual([]);
  });

  it('touches nothing when either entity is missing', async () => {
    const { env, calls } = recordingEnv(entityLookup);

    expect(await mergeEntities(env, 99, 3)).toEqual({ found: false, missing: 'from' });
    expect(await mergeEntities(env, 7, 99)).toEqual({ found: false, missing: 'into' });
    expect(calls.every((c) => /^SELECT/.test(c.sql.trim()))).toBe(true);
  });

  it('de-duplicates the moving vectors, then merges in one statement that carries every dependent', async () => {
    const { env, calls } = recordingEnv((sql, args) =>
      /^\s*WITH p AS/.test(sql)
        ? { observations_moved: 2, vectors_moved: 2, images_moved: 1, thread_links_moved: 1, consolidation_groups_moved: 0, relations_moved: 3, feelings_moved: 0, entity_vectors_removed: 1, entities_deleted: 1 }
        : entityLookup(sql, args));

    const result = await mergeEntities(env, 7, 3);

    expect(result).toMatchObject({ found: true, fromName: 'Old Lantern', intoName: 'Harbor', observationsMoved: 2, vectorsMoved: 2, imagesMoved: 1, threadLinksMoved: 1, relationsMoved: 3 });
    const writes = calls.filter((c) => !/^SELECT/.test(c.sql.trim()));
    expect(writes).toHaveLength(2);
    expect(writes[0].sql).toMatch(/DELETE FROM embeddings e/);
    expect(writes[0].args).toEqual([7, 7]);
    const merge = writes[1];
    expect(merge.args).toEqual([7, 3, 'Old Lantern', 'Harbor']);
    for (const table of ['embeddings', 'observations', 'images', 'consolidation_groups', 'thread_entities', 'relations', 'relational_state']) {
      expect(merge.sql).toMatch(new RegExp(`UPDATE ${table}\\b`));
    }
    expect(merge.sql).toMatch(/person_id = CASE/);
    expect(merge.sql).toMatch(/DELETE FROM entities x USING p/);
  });

  it('throws rather than report success when the source entity was not deleted', async () => {
    const { env } = recordingEnv((sql, args) => (/^\s*WITH p AS/.test(sql) ? { entities_deleted: 0 } : entityLookup(sql, args)));

    await expect(mergeEntities(env, 7, 3)).rejects.toThrow(/did not delete the source entity/);
  });
});
