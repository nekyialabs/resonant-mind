// Bond warmth against a real PostgreSQL: what counts as a touch.
// Needs its own fresh disposable database (skipped when the variable is unset):
//   TEST_BOND_WARMTH_DATABASE_URL=postgres://... npx vitest run tests/bond-warmth.integration.test.ts
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createD1Adapter } from '../src/adapter';
import { computeBondWarmth } from '../src/daemon/bond-warmth';
import type { Env } from '../src/types';

const url = process.env.TEST_BOND_WARMTH_DATABASE_URL;
let db: pg.Client;
let env: Env;

const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
const entity = async (name: string, type: string) =>
  Number((await q(`INSERT INTO entities (name, entity_type, primary_context) VALUES ($1, $2, 'default') RETURNING id`, [name, type]))[0].id);
const memory = (entityId: number, daysAgo: number, archived = false) =>
  q(`INSERT INTO observations (entity_id, content, added_at, archived_at)
     VALUES ($1, 'x', NOW() - ($2 || ' days')::interval, ${archived ? 'NOW()' : 'NULL'})`, [entityId, String(daysAgo)]);
const relate = (from: string, to: string, type: string) =>
  q(`INSERT INTO relations (from_entity, to_entity, relation_type) VALUES ($1, $2, $3)`, [from, to, type]);
const feel = (person: string, daysAgo: number) =>
  q(`INSERT INTO relational_state (person, feeling, intensity, timestamp) VALUES ($1, 'warm', 'soft', NOW() - ($2 || ' days')::interval)`, [person, String(daysAgo)]);
const warmthOf = async (name: string) => (await computeBondWarmth(env)).find((b) => b.name === name)!;

async function applyMigrations(client: pg.Client) {
  const existing = await client.query(`SELECT to_regclass('public.entities') AS e`);
  if (existing.rows[0].e) throw new Error('TEST_BOND_WARMTH_DATABASE_URL must point to a fresh disposable database');
  const dir = join(process.cwd(), 'migrations', 'postgres');
  for (const file of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    await client.query(await readFile(join(dir, file), 'utf8'));
  }
}

describe.runIf(Boolean(url))('bond warmth on PostgreSQL', () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: url });
    await db.connect();
    await applyMigrations(db);
    env = { DB: createD1Adapter({ connectionString: url! }) } as unknown as Env;
  });
  afterAll(async () => { await db?.end(); });

  it('a memory on the person warms them, and says so', async () => {
    const id = await entity('Ada', 'person');
    await memory(id, 0.1);
    const w = await warmthOf('Ada');
    expect(w.state).toBe('warm');
    expect(w.last_touch_source).toBe('memory');
  });

  it('a person with memories only on a related node reads warm (both directions)', async () => {
    await entity('Ben', 'person');
    const project = await entity('Ben project', 'project');
    await memory(project, 0.2);
    await relate('Ben project', 'Ben', 'is_part_of');
    const w = await warmthOf('Ben');
    expect(w.state).toBe('warm');
    expect(w.last_touch_source).toBe('related');

    await entity('Cleo', 'person');
    const notes = await entity('Cleo notes', 'artifact');
    await memory(notes, 0.2);
    await relate('Cleo', 'Cleo notes', 'includes');
    expect((await warmthOf('Cleo')).state).toBe('warm');
  });

  it('a feeling logged today reads warm with no memories', async () => {
    await entity('Dev', 'person');
    await feel('Dev', 0);
    const w = await warmthOf('Dev');
    expect(w.state).toBe('warm');
    expect(w.last_touch_source).toBe('feeling');
  });

  it('an archived observation does not count', async () => {
    const id = await entity('Eli', 'person');
    await memory(id, 0.1, true);
    const project = await entity('Eli project', 'project');
    await memory(project, 0.1, true);
    await relate('Eli project', 'Eli', 'belongs_to');
    expect((await warmthOf('Eli')).state).toBe('untouched');
  });

  it("an unrelated node's memory, or a loose relation, does not count", async () => {
    await entity('Fay', 'person');
    const stranger = await entity('Some topic', 'concept');
    await memory(stranger, 0.1);
    expect((await warmthOf('Fay')).state).toBe('untouched');
    await relate('Some topic', 'Fay', 'resonates_with');
    expect((await warmthOf('Fay')).state).toBe('untouched');
  });

  it('the latest of the three wins', async () => {
    const id = await entity('Gus', 'person');
    await memory(id, 20);
    await feel('Gus', 3);
    const w = await warmthOf('Gus');
    expect(w.last_touch_source).toBe('feeling');
    expect(w.state).toBe('cooling');
  });
});
