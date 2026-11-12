import { describe, expect, it } from 'vitest';
import { handleMindTension } from '../src/legacy-tools/tension';
import { escapeLike } from '../src/shared/text';
import type { Env } from '../src/types';

type Row = { id: string; pole_a: string; pole_b: string; context: string | null; visits: number; created_at: string; resolved_at: string | null };

const regexSpecials = /[.*+?^${}()|[\]\\]/g;

// Emulates Postgres LIKE ... ESCAPE '\' closely enough to prove escaping.
function likeToRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\') source += (pattern[++i] ?? '').replace(regexSpecials, '\\$&');
    else if (ch === '%') source += '.*';
    else if (ch === '_') source += '.';
    else source += ch.replace(regexSpecials, '\\$&');
  }
  return new RegExp(`^${source}$`, 's');
}

function tensionEnv(ids: string[]) {
  const rows: Row[] = ids.map((id) => ({
    id, pole_a: `a-${id}`, pole_b: `b-${id}`, context: null, visits: 0,
    created_at: '2026-01-01T00:00:00Z', resolved_at: null,
  }));
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const DB = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const select = () => {
        if (/WHERE id = \?/.test(sql) && /^\s*SELECT/i.test(sql)) return rows.filter((r) => r.id === args[0]);
        if (/WHERE id LIKE \? ESCAPE '\\'/.test(sql)) {
          const re = likeToRegExp(String(args[0]));
          return rows.filter((r) => re.test(r.id)).sort((a, b) => a.id.localeCompare(b.id));
        }
        if (/FROM tensions WHERE resolved_at IS NULL/.test(sql)) return rows;
        if (/COUNT\(\*\)/.test(sql)) return [{ count: 0 }];
        throw new Error(`unexpected select: ${sql}`);
      };
      const statement = {
        bind(...bound: unknown[]) { args = bound; return statement; },
        async run() {
          calls.push({ sql, args });
          if (/^\s*DELETE FROM tensions WHERE id = \?\s*$/i.test(sql)) {
            const i = rows.findIndex((r) => r.id === args[0]);
            if (i >= 0) rows.splice(i, 1);
            return { success: true, meta: { changes: i >= 0 ? 1 : 0 } };
          }
          if (/^\s*UPDATE tensions/i.test(sql)) return { success: true, meta: { changes: 1 } };
          throw new Error(`unexpected run: ${sql}`);
        },
        async first() { calls.push({ sql, args }); return select()[0] ?? null; },
        async all() { calls.push({ sql, args }); return { results: select() }; },
      };
      return statement;
    },
  };
  return { env: { DB } as unknown as Env, rows, calls };
}

const A = 'tension-20260101120000-aaaa';
const B = 'tension-20260101120000-aaab';
const C = 'tension-20260202080000-zzzz';
const parse = (s: string) => JSON.parse(s) as Record<string, unknown>;
const wrote = (calls: Array<{ sql: string }>) => calls.some((c) => /^\s*(UPDATE|DELETE)/i.test(c.sql));

describe('escapeLike', () => {
  it('escapes percent, underscore and backslash', () => {
    expect(escapeLike('a%b_c\\d')).toBe('a\\%b\\_c\\\\d');
    expect(escapeLike('plain-id')).toBe('plain-id');
  });
});

describe('tension id resolution', () => {
  it('sits with a tension addressed by its exact id', async () => {
    const { env } = tensionEnv([A, B, C]);
    const out = parse(await handleMindTension(env, { action: 'sit', tension_id: A }));
    expect(out.tension_id).toBe(A);
  });

  it('accepts a unique prefix of at least 10 characters', async () => {
    const { env } = tensionEnv([A, B, C]);
    const out = parse(await handleMindTension(env, { action: 'resolve', tension_id: 'tension-20260202', resolution: 'done' }));
    expect(out.tension_id).toBe(C);
  });

  it('refuses a prefix shorter than 10 characters', async () => {
    const { env, calls } = tensionEnv([A, B, C]);
    const out = parse(await handleMindTension(env, { action: 'sit', tension_id: 'tension-2' }));
    expect(String(out.error)).toMatch(/at least 10 characters/);
    expect(wrote(calls)).toBe(false);
  });

  it('refuses an ambiguous prefix and says how many match', async () => {
    const { env, calls } = tensionEnv([A, B, C]);
    const out = parse(await handleMindTension(env, { action: 'sit', tension_id: 'tension-20260101' }));
    expect(String(out.error)).toMatch(/matches 2 tensions/);
    expect(String(out.error)).toMatch(/longer prefix or the full id/);
    expect(wrote(calls)).toBe(false);
  });

  it.each(['%', '%%%%%%%%%%', 'tension-%', 'tension-2026010_120000', '__________', '\\%%%%%%%%%'])(
    'treats wildcard input %s as literal text that matches nothing',
    async (id) => {
      const { env, rows, calls } = tensionEnv([A, B, C]);
      for (const action of ['sit', 'resolve']) {
        const out = parse(await handleMindTension(env, { action, tension_id: id }));
        expect(String(out.error)).toMatch(/not found|at least/);
      }
      const del = parse(await handleMindTension(env, { action: 'delete', tension_id: id.padEnd(24, '%') }));
      expect(del.error).toBeDefined();
      expect(rows).toHaveLength(3);
      expect(wrote(calls)).toBe(false);
    },
  );

  it('sends the prefix to SQL escaped and with an ESCAPE clause', async () => {
    const { env, calls } = tensionEnv([A]);
    await handleMindTension(env, { action: 'sit', tension_id: 'tension-2026_%1234' });
    const like = calls.find((c) => /LIKE/.test(c.sql));
    expect(like?.args).toEqual(['tension-2026\\_\\%1234%']);
  });

  it('lists full ids', async () => {
    const { env } = tensionEnv([A]);
    const out = await handleMindTension(env, { action: 'list' });
    expect(out).toContain(`[${A}]`);
  });
});

describe('tension delete', () => {
  it('deletes exactly one row by id, never by LIKE', async () => {
    const { env, rows, calls } = tensionEnv([A, B, C]);
    const out = parse(await handleMindTension(env, { action: 'delete', tension_id: C }));
    expect(out.success).toBe(true);
    expect(rows.map((r) => r.id)).toEqual([A, B]);
    const del = calls.filter((c) => /^\s*DELETE/i.test(c.sql));
    expect(del).toHaveLength(1);
    expect(del[0].sql).not.toMatch(/LIKE/i);
    expect(del[0].args).toEqual([C]);
  });

  it('requires at least 20 characters for a prefix', async () => {
    const { env, rows } = tensionEnv([A, B, C]);
    const out = parse(await handleMindTension(env, { action: 'delete', tension_id: 'tension-2026020' }));
    expect(String(out.error)).toMatch(/at least 20 characters/);
    expect(rows).toHaveLength(3);
  });

  it('refuses an ambiguous 20+ character prefix', async () => {
    const { env, rows } = tensionEnv([A, B, C]);
    const out = parse(await handleMindTension(env, { action: 'delete', tension_id: 'tension-20260101120000' }));
    expect(String(out.error)).toMatch(/matches 2 tensions/);
    expect(rows).toHaveLength(3);
  });

  it('deletes a unique long prefix', async () => {
    const { env, rows } = tensionEnv([A, B, C]);
    const out = parse(await handleMindTension(env, { action: 'delete', tension_id: 'tension-20260202080000' }));
    expect(out.success).toBe(true);
    expect(rows.map((r) => r.id)).toEqual([A, B]);
  });
});
