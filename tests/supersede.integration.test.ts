// Auto-supersede, supersede proposals, the health counts and scripts/check-supersede.mjs
// against a real PostgreSQL + pgvector. Needs its own fresh disposable database
// (skipped when the variable is unset):
//   TEST_SUPERSEDE_DATABASE_URL=postgres://... npx vitest run tests/supersede.integration.test.ts
// Only the embedding is faked (a hash of the text, so identical text is a score-1 match).
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../src/shared/mind-helpers', async (orig) => {
  const real = await orig<typeof import('../src/shared/mind-helpers')>();
  return {
    ...real,
    getEmbedding: vi.fn(async (_env: unknown, text: string) => {
      const h = createHash('sha256').update(text).digest();
      return Array.from({ length: 768 }, (_, i) => (h[i % 32] + 1) / 300);
    }),
  };
});

import { createD1Adapter } from '../src/adapter';
import { createVectorAdapter } from '../src/vectors';
import { handleMindWrite } from '../src/legacy-tools/write';
import { handleMindProposals } from '../src/legacy-tools/proposals';
import { handleMindHealth } from '../src/legacy-tools/health';
import { AUTO_SUPERSEDE_MAX_CHARS, PROPOSAL_PENDING_CAP } from '../src/shared/constants';
import type { Env } from '../src/types';

const url = process.env.TEST_SUPERSEDE_DATABASE_URL;
let db: pg.Client;
let env: Env;

const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
const write = (entity: string, text: string) =>
  handleMindWrite(env, { type: 'observation', entity_name: entity, observations: [text], context: 'default' });
const obs = async (id: number) => (await q(`SELECT id, valid_until, superseded_by, supersedes FROM observations WHERE id = $1`, [id]))[0];
const idsOf = async (entity: string) =>
  (await q(`SELECT o.id FROM observations o JOIN entities e ON e.id = o.entity_id WHERE e.name = $1 ORDER BY o.id`, [entity])).map((r) => Number(r.id));
const proposalFor = async (newId: number) =>
  (await q(`SELECT * FROM daemon_proposals WHERE proposal_type = 'supersede' AND to_obs_id = $1`, [newId]))[0];

// A long pair on one entity: the same text twice, so the vectors match at 1.0.
async function longPair(entity: string, marker: string) {
  const text = `${marker} lanterns drifted slowly past the quiet orchard while the evening settled. `.repeat(5);
  expect(text.length).toBeGreaterThan(AUTO_SUPERSEDE_MAX_CHARS);
  await write(entity, text);
  await write(entity, text);
  const [oldId, newId] = await idsOf(entity);
  return { oldId, newId, text };
}

async function applyMigrations(client: pg.Client) {
  const existing = await client.query(`SELECT to_regclass('public.entities') AS e`);
  if (existing.rows[0].e) throw new Error('TEST_SUPERSEDE_DATABASE_URL must point to a fresh disposable database');
  const dir = join(process.cwd(), 'migrations', 'postgres');
  for (const file of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    await client.query(await readFile(join(dir, file), 'utf8'));
  }
}

const SHORT = 'Quillfeather keeps bees on the roof.';
let shortPair: { oldId: number; newId: number };
let acceptedPair: { oldId: number; newId: number; text: string };

describe.runIf(Boolean(url))('supersede on PostgreSQL', () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: url });
    await db.connect();
    await applyMigrations(db);
    env = { DB: createD1Adapter({ connectionString: url! }), VECTORS: createVectorAdapter(url!), GEMINI_API_KEY: 'no-network' } as unknown as Env;
  });
  afterAll(async () => { await db?.end(); });

  it('a short pair is retired automatically, with the back-pointer', async () => {
    const msg = await (async () => { await write('Shorty', SHORT); return write('Shorty', SHORT); })();
    expect(msg).toContain('Superseded 1');
    const [oldId, newId] = await idsOf('Shorty');
    const o = await obs(oldId);
    const n = await obs(newId);
    expect(o.valid_until).not.toBeNull();
    expect(Number(o.superseded_by)).toBe(newId);
    expect(Number(n.supersedes)).toBe(oldId);
    expect(n.valid_until).toBeNull();
    shortPair = { oldId, newId };
  });

  it('a long pair is left alone and becomes a pending proposal', async () => {
    const { oldId, newId } = await longPair('Longhand', 'Zephyrine');
    expect((await obs(oldId)).valid_until).toBeNull();
    expect((await obs(oldId)).superseded_by).toBeNull();
    const p = await proposalFor(newId);
    expect(p.status).toBe('pending');
    expect(Number(p.from_obs_id)).toBe(oldId);
    expect(Number(p.confidence)).toBeGreaterThan(0.99);
    expect(p.from_entity_id).not.toBeNull();
    const list = await handleMindProposals(env, { action: 'list' });
    expect(list).toContain('Possible Supersedes');
  });

  it('accepting retires the old row, sets both pointers and closes the proposal', async () => {
    const { oldId, newId, text } = await longPair('Accepted', 'Marigold');
    const p = await proposalFor(newId);
    const out = await handleMindProposals(env, { action: 'accept', proposal_id: Number(p.id) });
    expect(out).toContain('superseded by');
    const o = await obs(oldId);
    expect(o.valid_until).not.toBeNull();
    expect(Number(o.superseded_by)).toBe(newId);
    expect(Number((await obs(newId)).supersedes)).toBe(oldId);
    const closed = await proposalFor(newId);
    expect(closed.status).toBe('accepted');
    expect(closed.resolved_at).not.toBeNull();
    acceptedPair = { oldId, newId, text };
  });

  it('rejecting changes no observation', async () => {
    const { oldId, newId } = await longPair('Rejected', 'Thistledown');
    const p = await proposalFor(newId);
    const before = await q(`SELECT id, valid_until, superseded_by, supersedes FROM observations WHERE id IN ($1, $2) ORDER BY id`, [oldId, newId]);
    const out = await handleMindProposals(env, { action: 'reject', proposal_id: Number(p.id) });
    expect(out).toContain('rejected');
    expect(await q(`SELECT id, valid_until, superseded_by, supersedes FROM observations WHERE id IN ($1, $2) ORDER BY id`, [oldId, newId])).toEqual(before);
    expect((await proposalFor(newId)).status).toBe('rejected');
  });

  it('accepting when the old row is already retired marks the proposal expired', async () => {
    const { oldId, newId } = await longPair('Already', 'Nightjar');
    const p = await proposalFor(newId);
    await q(`UPDATE observations SET valid_until = NOW() WHERE id = $1`, [oldId]);
    const out = await handleMindProposals(env, { action: 'accept', proposal_id: Number(p.id) });
    expect(out).toContain('was not changed');
    expect((await proposalFor(newId)).status).toBe('expired');
    expect((await obs(oldId)).superseded_by).toBeNull(); // nothing was overwritten
  });

  it('at the pending cap no proposal is recorded, and nothing is retired', async () => {
    const pending = Number((await q(`SELECT COUNT(*) AS c FROM daemon_proposals WHERE status = 'pending'`))[0].c);
    await q(`INSERT INTO daemon_proposals (proposal_type, reason, status)
             SELECT 'filler', 'x', 'pending' FROM generate_series(1, $1::int)`, [Math.max(0, PROPOSAL_PENDING_CAP - pending)]);
    try {
      const { oldId, newId } = await longPair('Capped', 'Ravenwing');
      expect(await proposalFor(newId)).toBeUndefined();
      expect((await obs(oldId)).valid_until).toBeNull();
    } finally {
      await q(`DELETE FROM daemon_proposals WHERE proposal_type = 'filler'`);
    }
    // and with room again, the proposal is recorded
    const { newId } = await longPair('Uncapped', 'Sandpiper');
    expect(await proposalFor(newId)).toBeDefined();
  });

  it('mind_health reports the superseded total and the last 7 days', async () => {
    // Move one retirement out of the 7-day window.
    await q(`UPDATE observations SET valid_until = NOW() - INTERVAL '10 days' WHERE id = $1`, [shortPair.oldId]);
    const total = Number((await q(`SELECT COUNT(*) AS c FROM observations WHERE superseded_by IS NOT NULL`))[0].c);
    const recent = Number((await q(`SELECT COUNT(*) AS c FROM observations WHERE superseded_by IS NOT NULL AND valid_until > NOW() - INTERVAL '7 days'`))[0].c);
    expect(total).toBeGreaterThanOrEqual(2);
    expect(recent).toBe(total - 1);
    const out = await handleMindHealth(env);
    const m = out.match(/Superseded Obs:\s+(\d+) \((\d+) in the last 7d/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(total);
    expect(Number(m![2])).toBe(recent);
  });

  it('check-supersede reports the pairs from the real database and prints no content', () => {
    const connection = url!.includes('?') ? `${url}&sslmode=disable` : `${url}?sslmode=disable`;
    const run = spawnSync(process.execPath, ['scripts/check-supersede.mjs', '--json'], {
      cwd: process.cwd(),
      env: { ...process.env, PG_URL: connection },
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(run.status).toBe(1); // superseded observations exist
    const report = JSON.parse(run.stdout);
    expect(report.read_only).toBe(true);
    expect(report.summary.superseded_total).toBe(report.pairs.length);

    const short = report.pairs.find((p: { old_id: number }) => p.old_id === shortPair.oldId);
    expect(short).toMatchObject({ old_id: shortPair.oldId, superseder_id: shortPair.newId, old_length: SHORT.length, superseder_length: SHORT.length, word_overlap: 1 });
    const long = report.pairs.find((p: { old_id: number }) => p.old_id === acceptedPair.oldId);
    expect(long).toMatchObject({ superseder_id: acceptedPair.newId, old_length: acceptedPair.text.length, superseder_length: acceptedPair.text.length, word_overlap: 1 });
    expect(long.entity_id).not.toBeNull();
    expect(report.summary.pairs_either_side_over_short_max).toBeGreaterThanOrEqual(1);
    expect(report.summary.pairs_both_short).toBeGreaterThanOrEqual(1);

    // no memory text anywhere in the output, human or JSON
    for (const word of ['Quillfeather', 'lanterns', 'orchard', 'Marigold', 'evening']) {
      expect(run.stdout.toLowerCase()).not.toContain(word.toLowerCase());
    }
    const human = spawnSync(process.execPath, ['scripts/check-supersede.mjs'], {
      cwd: process.cwd(), env: { ...process.env, PG_URL: connection }, encoding: 'utf8', windowsHide: true,
    });
    expect(human.status).toBe(1);
    expect(human.stdout.toLowerCase()).not.toContain('quillfeather');
    expect(human.stdout.toLowerCase()).not.toContain('lanterns');
  });
});
