import { afterEach, describe, expect, it, vi } from 'vitest';
import { processDream } from '../src/daemon/dream-processing';
import { handleMindOrient } from '../src/legacy-tools/orient';
import type { Env } from '../src/types';

afterEach(() => vi.useRealTimers());

/** Fake DB holding dream rows by dream_date; records every dream_date lookup and stops the run once no row is found. */
function dreamEnv(timezone: string | undefined, rows: Record<string, number> = {}, lookupsBeforeStop = 1) {
  const lookups: unknown[] = [];
  const DB = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const statement = {
        bind(...bound: unknown[]) { args = bound; return statement; },
        async all() { return { results: [] }; },
        async run() { return { success: true, meta: { changes: 0 } }; },
        async first() {
          if (/FROM dreams WHERE dream_date = \?/.test(sql)) {
            lookups.push(args[0]);
            const id = rows[String(args[0])];
            if (id !== undefined) return { id };
            // No row: stop here so the run never reaches dream generation.
            if (lookups.length >= lookupsBeforeStop) throw new Error('stop after lookups');
            return null;
          }
          return null;
        },
      };
      return statement;
    },
  };
  return { env: { DB, LOCATION_TIMEZONE: timezone } as unknown as Env, lookups };
}

const run = async (iso: string, env: Env, force = true) => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(iso));
  return processDream(env, force).catch((e: Error) => {
    if (e.message !== 'stop after lookups') throw e;
    return { generated: false, reason: 'stopped' };
  });
};

describe('dream "already tonight" key', () => {
  it('is the same on both sides of UTC midnight within one local night', async () => {
    for (const iso of ['2026-07-14T22:30:00Z', '2026-07-15T00:30:00Z']) {
      const { env, lookups } = dreamEnv('Europe/London', { '2026-07-14': 99 });
      const out = await run(iso, env);
      expect(out.reason).toBe('already dreamed tonight (dream #99)');
      expect(lookups[0]).toBe('2026-07-14');
    }
  });

  it('uses the UTC night when no timezone is configured', async () => {
    const { env, lookups } = dreamEnv(undefined);
    await run('2026-07-15T01:00:00Z', env);
    expect(lookups[0]).toBe('2026-07-14');
  });

  it('keys a forced daytime dream to the previous night', async () => {
    const { env, lookups } = dreamEnv('UTC', { '2026-07-14': 7 });
    const out = await run('2026-07-15T15:00:00Z', env);
    expect(lookups[0]).toBe('2026-07-14');
    expect(out.reason).toBe('already dreamed tonight (dream #7)');
  });
});

describe('legacy UTC-dated rows during the transition', () => {
  it('west of UTC: a row the old code keyed by the UTC date still counts', async () => {
    // 23:00 PDT on 14 July is 06:00Z on the 15th. Old key: 2026-07-15. New key: 2026-07-14.
    const { env, lookups } = dreamEnv('America/Los_Angeles', { '2026-07-15': 41 }, 2);
    const out = await run('2026-07-15T06:00:00Z', env);
    expect(lookups).toEqual(['2026-07-14', '2026-07-15']);
    expect(out.reason).toBe('already dreamed tonight (dream #41)');
  });

  it('mid-night deploy: a row written just after UTC midnight under the old key still counts', async () => {
    // 01:30 BST on 15 July is 00:30Z. The old code wrote 2026-07-15 at 00:10Z.
    const { env, lookups } = dreamEnv('Europe/London', { '2026-07-15': 12 }, 2);
    const out = await run('2026-07-15T00:30:00Z', env);
    expect(lookups).toEqual(['2026-07-14', '2026-07-15']);
    expect(out.reason).toBe('already dreamed tonight (dream #12)');
  });

  it('a row under the new key wins without a second lookup', async () => {
    const { env, lookups } = dreamEnv('Europe/London', { '2026-07-14': 3, '2026-07-15': 4 });
    const out = await run('2026-07-15T00:30:00Z', env);
    expect(lookups).toEqual(['2026-07-14']);
    expect(out.reason).toBe('already dreamed tonight (dream #3)');
  });

  it('does not look up the legacy key when it equals the new key', async () => {
    const { env, lookups } = dreamEnv('UTC', {});
    await run('2026-07-14T23:00:00Z', env);
    expect(lookups).toEqual(['2026-07-14']);
  });

  it('west of UTC, an unrelated older row does not block tonight', async () => {
    const { env, lookups } = dreamEnv('America/Los_Angeles', { '2026-07-13': 5 }, 2);
    await run('2026-07-15T06:00:00Z', env);
    expect(lookups).toEqual(['2026-07-14', '2026-07-15']);
  });
});

describe('orient last-dream cutoff', () => {
  it('binds the local night date minus one day instead of using the database date', async () => {
    const binds: Array<{ sql: string; args: unknown[] }> = [];
    const DB = {
      prepare(sql: string) {
        const s = {
          bind(...args: unknown[]) { binds.push({ sql, args }); return s; },
          async all() { return { results: [] }; },
          async first() { return null; },
          async run() { return { success: true, meta: { changes: 0 } }; },
        };
        return s;
      },
    };
    vi.useFakeTimers();
    // 01:30 BST on 15 July: the night is 14 July, so the cutoff is 13 July.
    vi.setSystemTime(new Date('2026-07-15T00:30:00Z'));

    await handleMindOrient({ DB, LOCATION_TIMEZONE: 'Europe/London' } as unknown as Env).catch(() => undefined);

    const dreamQuery = binds.find((b) => /FROM dreams/.test(b.sql));
    expect(dreamQuery).toBeDefined();
    expect(dreamQuery!.sql).not.toMatch(/CURRENT_DATE/);
    expect(dreamQuery!.args).toEqual(['2026-07-13']);
  });
});
