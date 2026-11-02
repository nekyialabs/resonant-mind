// Entity merge against a real PostgreSQL + pgvector: nothing that points at the
// merged-away entity is lost, and a merge that fails changes nothing.
// Needs its own fresh disposable database:
//   TEST_MERGE_DATABASE_URL=postgres://... npm run test:postgres:merge
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../src/shared/mind-helpers', async (orig) => {
  const real = await orig<typeof import('../src/shared/mind-helpers')>();
  return {
    ...real,
    // Deterministic, content-dependent vectors, so "unchanged" can be checked.
    getEmbedding: vi.fn(async (_env: unknown, text: string) => {
      const h = createHash('sha256').update(text).digest();
      return Array.from({ length: 768 }, (_, i) => (h[i % 32] + 1) / 300);
    }),
  };
});

import { createD1Adapter } from '../src/adapter';
import { createVectorAdapter } from '../src/vectors';
import { handleMindWrite } from '../src/legacy-tools/write';
import { handleMindEntity } from '../src/legacy-tools/entity';
import { deleteObservation, editObservation } from '../src/shared/surgery';
import type { Env } from '../src/types';
// @ts-expect-error -- plain .mjs script, no type declarations
import { RECOVERED_TABLE_SQL, repairMergeVectors } from '../scripts/repair-merge-vectors.mjs';

const url = process.env.TEST_MERGE_DATABASE_URL;
let db: pg.Client;
let env: Env;

const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
const entity = async (name: string, type: string) =>
  Number((await q(`INSERT INTO entities (name, entity_type, primary_context) VALUES ($1, $2, 'default') RETURNING id`, [name, type]))[0].id);
const write = (name: string, observations: string[]) =>
  handleMindWrite(env, { type: 'observation', entity_name: name, observations, context: 'default' });
const obsId = async (content: string) => Number((await q(`SELECT id FROM observations WHERE content = $1`, [content]))[0].id);
const merge = (from: number, into: number) => handleMindEntity(env, { action: 'merge', merge_from_id: from, merge_into_id: into });

async function invariants() {
  return {
    orphanVectors: await q(`SELECT id FROM embeddings e WHERE source_type = 'observation' AND NOT EXISTS (SELECT 1 FROM observations o WHERE o.id = e.source_id)`),
    orphanEntityVectors: await q(`SELECT id FROM embeddings e WHERE source_type = 'entity' AND NOT EXISTS (SELECT 1 FROM entities x WHERE x.id = e.source_id)`),
    notOneVector: await q(`SELECT o.id FROM observations o LEFT JOIN embeddings e ON e.source_type = 'observation' AND e.source_id = o.id GROUP BY o.id HAVING count(e.id) <> 1`),
    staleKeys: await q(`SELECT e.id FROM embeddings e JOIN observations o ON o.id = e.source_id WHERE e.source_type = 'observation' AND e.id <> 'obs-' || o.entity_id || '-' || o.id`),
    subjectMismatch: await q(`SELECT id FROM observations WHERE COALESCE(person_id, node_id) IS DISTINCT FROM entity_id`),
    imagesUnlinked: await q(`SELECT id FROM images WHERE entity_id IS NULL AND COALESCE(person_id, node_id) IS NOT NULL`),
  };
}
const clean = { orphanVectors: [], orphanEntityVectors: [], notOneVector: [], staleKeys: [], subjectMismatch: [], imagesUnlinked: [] };

async function applyMigrations(client: pg.Client) {
  const existing = await client.query(`SELECT to_regclass('public.entities') AS e`);
  if (existing.rows[0].e) throw new Error('TEST_MERGE_DATABASE_URL must point to a fresh disposable database');
  const dir = join(process.cwd(), 'migrations', 'postgres');
  for (const file of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    await client.query(await readFile(join(dir, file), 'utf8'));
  }
}

describe.runIf(Boolean(url))('entity merge on PostgreSQL loses nothing', () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: url });
    await db.connect();
    await applyMigrations(db);
    env = { DB: createD1Adapter({ connectionString: url! }), VECTORS: createVectorAdapter(url!), GEMINI_API_KEY: 'no-network' } as unknown as Env;
  });
  afterAll(async () => { await db?.end(); });

  it('carries observations, vectors, images, thread links and relations to the target', async () => {
    const a = await entity('Alpha', 'concept');
    const b = await entity('Beta', 'concept');
    await entity('Gamma', 'concept');
    await write('Alpha', ['alpha one', 'alpha two']);
    await write('Beta', ['beta one']);
    await env.VECTORS.upsert([{ id: `entity-${a}`, values: Array(768).fill(0.01), metadata: { source: 'entity', entity: 'Alpha' } }]);
    await q(`INSERT INTO relations (from_entity, to_entity, relation_type) VALUES ('Alpha', 'Gamma', 'knows'), ('Gamma', 'Alpha', 'knows')`);
    await q(`INSERT INTO images (path, description, entity_id) VALUES ('a.png', 'alpha image', $1)`, [a]);
    await q(`INSERT INTO threads (id, thread_type, content) VALUES ('t-alpha', 'intention', 'about alpha')`);
    await q(`INSERT INTO thread_entities (thread_id, entity_id) VALUES ('t-alpha', $1)`, [a]);
    const vectorsBefore = await q(`SELECT source_id, md5(embedding::text) AS v FROM embeddings WHERE source_type = 'observation' ORDER BY source_id`);

    expect(await merge(a, b)).toBe(`Merged 'Alpha' (#${a}) into 'Beta' (#${b})\nMoved 2 observations`);

    expect(await q(`SELECT content FROM observations WHERE entity_id = $1 ORDER BY id`, [b])).toEqual(
      [{ content: 'alpha one' }, { content: 'alpha two' }, { content: 'beta one' }]);
    expect(await q(`SELECT source_id, md5(embedding::text) AS v FROM embeddings WHERE source_type = 'observation' ORDER BY source_id`)).toEqual(vectorsBefore);
    expect(await q(`SELECT DISTINCT metadata->>'entity' AS m FROM embeddings WHERE source_type = 'observation' AND id LIKE $1`, [`obs-${b}-%`])).toEqual([{ m: 'Beta' }]);
    expect(await q(`SELECT entity_id, node_id FROM images`)).toEqual([{ entity_id: b, node_id: b }]);
    expect(await q(`SELECT entity_id FROM thread_entities WHERE thread_id = 't-alpha'`)).toEqual([{ entity_id: b }]);
    expect(await q(`SELECT from_entity, to_entity FROM relations ORDER BY id`)).toEqual(
      [{ from_entity: 'Beta', to_entity: 'Gamma' }, { from_entity: 'Gamma', to_entity: 'Beta' }]);
    expect(await invariants()).toEqual(clean);
  });

  it('later deletes and edits of a moved memory find its one vector', async () => {
    await deleteObservation(env, await obsId('alpha one'));
    await editObservation(env, await obsId('alpha two'), { content: 'alpha two, edited' });
    expect(await invariants()).toEqual(clean);
  });

  it('merges a person so the bonds view (person_id) and feelings follow', async () => {
    const pat = await entity('Pat', 'person');
    const patricia = await entity('Patricia', 'person');
    await write('Pat', ['pat likes tea']);
    await q(`INSERT INTO relational_state (person, feeling, intensity) VALUES ('Pat', 'fond', 'present')`);

    await merge(pat, patricia);

    expect(await q(`SELECT content FROM observations WHERE person_id = $1`, [patricia])).toEqual([{ content: 'pat likes tea' }]);
    expect(await q(`SELECT person FROM relational_state WHERE feeling = 'fond'`)).toEqual([{ person: 'Patricia' }]);
    expect(await invariants()).toEqual(clean);
  });

  it('completes when the source has a consolidation group (it used to fail half-way)', async () => {
    const xi = await entity('Xi', 'concept');
    const ypsilon = await entity('Ypsilon', 'concept');
    await write('Xi', ['xi one']);
    await q(`INSERT INTO consolidation_groups (summary, entity_id, source_observation_ids) VALUES ('xi', $1, ARRAY[$2::int])`, [xi, await obsId('xi one')]);

    expect(await merge(xi, ypsilon)).toMatch(/^Merged 'Xi'/);
    expect(await q(`SELECT id FROM entities WHERE id = $1`, [xi])).toEqual([]);
    expect(await q(`SELECT entity_id, node_id FROM consolidation_groups`)).toEqual([{ entity_id: ypsilon, node_id: ypsilon }]);
  });

  it('keeps the newest vector when an earlier merge and an edit left two', async () => {
    const d = await entity('Delta', 'concept');
    const e = await entity('Epsilon', 'concept');
    const z = await entity('Zeta', 'concept');
    await write('Delta', ['delta one']);
    // The state an earlier release left: observations moved, vectors not.
    await q(`UPDATE observations SET entity_id = $1, node_id = $1 WHERE entity_id = $2`, [e, d]);
    await q(`DELETE FROM entities WHERE id = $1`, [d]);
    const id = await obsId('delta one');
    await editObservation(env, id, { content: 'delta one, edited' }); // second vector at obs-E-id

    await merge(e, z);

    expect(await q(`SELECT id, content FROM embeddings WHERE source_type = 'observation' AND source_id = $1`, [id])).toEqual(
      [{ id: `obs-${z}-${id}`, content: 'delta one, edited' }]);
    expect(await invariants()).toEqual(clean);
  });

  it('refuses a merge of an entity into itself and keeps its memories', async () => {
    const s = await entity('Sigma', 'concept');
    await write('Sigma', ['sigma one']);

    expect(await merge(s, s)).toBe(`Cannot merge entity #${s} into itself`);
    expect(await q(`SELECT count(*)::int AS n FROM observations WHERE entity_id = $1`, [s])).toEqual([{ n: 1 }]);
  });

  it('changes nothing when the merge statement fails', async () => {
    const t = await entity('Theta', 'concept');
    const i = await entity('Iota', 'concept');
    await write('Theta', ['theta one']);
    await q(`INSERT INTO images (path, description, entity_id) VALUES ('t.png', 'theta image', $1)`, [t]);
    await q(`DELETE FROM nodes WHERE id = $1`, [i]); // target in neither people nor nodes: the subject CHECK refuses
    const snapshot = () => Promise.all([
      q(`SELECT * FROM observations ORDER BY id`), q(`SELECT id, metadata FROM embeddings ORDER BY id`),
      q(`SELECT * FROM images ORDER BY id`), q(`SELECT id FROM entities ORDER BY id`),
    ]);
    const before = await snapshot();

    expect(await merge(t, i)).toMatch(/failed and was not applied/);
    expect(await snapshot()).toEqual(before);
  });

  it('repair:merge-vectors clears what the old merge left and destroys nothing', async () => {
    // Damage as 4.1.1 left it: a merge that moved observations only, a delete
    // after it (orphan), an edit after it (duplicate), and a self-merge
    // (every memory gone, vectors left).
    const k = await entity('Kappa', 'concept');
    const l = await entity('Lambda', 'concept');
    const m = await entity('Mu', 'concept');
    await write('Kappa', ['kappa kept', 'kappa deleted', 'kappa edited']);
    await write('Mu', ['mu lost one', 'mu lost two']);
    await env.VECTORS.upsert([{ id: `entity-${k}`, values: Array(768).fill(0.02), metadata: { source: 'entity', entity: 'Kappa' } }]);
    await q(`UPDATE observations SET entity_id = $1, node_id = $1 WHERE entity_id = $2`, [l, k]);
    await q(`DELETE FROM entities WHERE id = $1`, [k]);
    await q(`DELETE FROM observations WHERE content = 'kappa deleted'`);
    await editObservation(env, await obsId('kappa edited'), { content: 'kappa edited, twice' });
    await q(`DELETE FROM entities WHERE id = $1`, [m]); // the old self-merge: cascade took Mu's memories

    const vectorsOf = (pattern: string) => q(`SELECT id, content FROM embeddings WHERE content LIKE $1 ORDER BY id`, [pattern]);
    const memories = () => q(`SELECT id, entity_id, content FROM observations ORDER BY id`);
    const allVectors = () => q(`SELECT id, content, md5(embedding::text) AS v FROM embeddings ORDER BY id`);
    const memoriesBefore = await memories();
    const vectorsBefore = await allVectors();
    expect(await vectorsOf('kappa%')).toHaveLength(4); // 3 written + the edit's second vector

    const pgClient = new pg.Client({ connectionString: url });
    await pgClient.connect();
    try {
      const dry = await repairMergeVectors(pgClient);
      expect(dry).toMatchObject({ apply: false, committed: false, refused: null });
      expect(await allVectors()).toEqual(vectorsBefore);
      expect((await q(`SELECT to_regclass('embeddings_recovered') AS t`))[0].t).toBeNull();

      const applied = await repairMergeVectors(pgClient, { apply: true });
      expect(applied).toMatchObject({ committed: true, refused: null, verified: { memories_unchanged: true, remaining: { 'MD-1': 0, 'MD-2': 0, 'MD-3': 0, 'MD-4': 0 } } });
      expect(await memories()).toEqual(memoriesBefore);
      // Every vector that left embeddings is in embeddings_recovered, byte for byte.
      const after = await allVectors();
      const recovered = await q(`SELECT id, content, md5(embedding::text) AS v, reason FROM embeddings_recovered ORDER BY recovered_id`);
      const keptValues = new Set([...after, ...recovered].map((r: any) => `${r.content}|${r.v}`));
      for (const v of vectorsBefore) expect(keptValues.has(`${v.content}|${v.v}`)).toBe(true);
      // The self-merge's lost memories survive as text.
      expect(recovered.filter((r: any) => r.reason === 'MD-1')).toHaveLength(3);
      expect(recovered.some((r: any) => /mu lost one/.test(r.content))).toBe(true);
      expect(recovered.some((r: any) => /mu lost two/.test(r.content))).toBe(true);
      expect(recovered.some((r: any) => /kappa deleted/.test(r.content))).toBe(true);
      expect(await invariants()).toEqual(clean);

      const again = await repairMergeVectors(pgClient, { apply: true });
      expect(again.steps.map((x: any) => x.rows)).toEqual([0, 0, 0, 0]);
    } finally {
      await pgClient.end();
    }
  });

  it('repair:merge-vectors rolls back and changes nothing when its verification fails', async () => {
    await entity('Nu', 'concept');
    await write('Nu', ['nu one']);
    const id = await obsId('nu one');
    // A duplicate vector (MD-2), so the repair has something to move.
    await q(`INSERT INTO embeddings (id, source_type, source_id, embedding, content) SELECT 'obs-999-' || $1::text, 'observation', $1::int, embedding, content FROM embeddings WHERE source_id = $1::int AND source_type = 'observation'`, [id]);
    await q(RECOVERED_TABLE_SQL);
    // A trigger that changes a memory mid-repair stands in for any surprise.
    await q(`CREATE FUNCTION touch_obs() RETURNS trigger AS $$ BEGIN UPDATE observations SET content = content || '!' WHERE id = (SELECT min(id) FROM observations); RETURN NULL; END $$ LANGUAGE plpgsql`);
    await q(`CREATE TRIGGER touch_obs AFTER INSERT ON embeddings_recovered FOR EACH STATEMENT EXECUTE FUNCTION touch_obs()`);
    const before = await Promise.all([q(`SELECT id, content FROM embeddings ORDER BY id`), q(`SELECT id, content FROM observations ORDER BY id`), q(`SELECT count(*)::int AS n FROM embeddings_recovered`)]);
    const pgClient = new pg.Client({ connectionString: url });
    await pgClient.connect();
    try {
      const report = await repairMergeVectors(pgClient, { apply: true });
      expect(report.committed).toBe(false);
      expect(report.refused).toEqual(['memories changed']);
    } finally {
      await pgClient.end();
      await q(`DROP TRIGGER touch_obs ON embeddings_recovered; DROP FUNCTION touch_obs()`);
    }
    expect(await Promise.all([q(`SELECT id, content FROM embeddings ORDER BY id`), q(`SELECT id, content FROM observations ORDER BY id`), q(`SELECT count(*)::int AS n FROM embeddings_recovered`)])).toEqual(before);
  });
});
