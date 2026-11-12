import { afterEach, describe, expect, it, vi } from 'vitest';
import { processDream } from '../src/daemon/dream-processing';
import type { Env } from '../src/types';

afterEach(() => vi.useRealTimers());

function dreamEnv(timezone: string | undefined) {
  const dreamDates: unknown[] = [];
  const DB = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const statement = {
        bind(...bound: unknown[]) { args = bound; return statement; },
        async all() { return { results: [] }; },
        async run() { return { success: true, meta: { changes: 0 } }; },
        async first() {
          if (/FROM dreams WHERE dream_date = \?/.test(sql)) {
            dreamDates.push(args[0]);
            return { id: 99 };
          }
          return null;
        },
      };
      return statement;
    },
  };
  return { env: { DB, LOCATION_TIMEZONE: timezone } as unknown as Env, dreamDates };
}

describe('dream "already tonight" key', () => {
  it('is the same on both sides of UTC midnight within one local night', async () => {
    vi.useFakeTimers();
    const results: string[] = [];
    for (const iso of ['2026-07-14T22:30:00Z', '2026-07-15T00:30:00Z']) {
      vi.setSystemTime(new Date(iso));
      const { env, dreamDates } = dreamEnv('Europe/London');
      const out = await processDream(env, true);
      expect(out.reason).toBe('already dreamed tonight (dream #99)');
      results.push(String(dreamDates[0]));
    }
    expect(results).toEqual(['2026-07-14', '2026-07-14']);
  });

  it('uses the UTC night when no timezone is configured', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T01:00:00Z'));
    const { env, dreamDates } = dreamEnv(undefined);
    await processDream(env, true);
    expect(dreamDates).toEqual(['2026-07-14']);
  });
});
