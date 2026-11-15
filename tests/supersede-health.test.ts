import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

vi.mock('../src/daemon/state', () => ({
  getSubconsciousState: async () => ({}),
  recordAccessTracking: async () => undefined,
}));

import { handleMindHealth } from '../src/legacy-tools/health';
import { handleApiTelemetry } from '../src/http/handlers/telemetry';

/** Every count is 1, except the two superseded counts. */
function healthEnv() {
  const seen: Array<{ sql: string; binds: unknown[] }> = [];
  const DB = {
    prepare(sql: string) {
      const entry = { sql, binds: [] as unknown[] };
      seen.push(entry);
      const statement = {
        bind(...args: unknown[]) { entry.binds = args; return statement; },
        first: async () => {
          if (/superseded_by IS NOT NULL AND valid_until >/.test(sql)) return { c: 3 };
          if (/superseded_by IS NOT NULL/.test(sql)) return { c: 12 };
          return { c: 1 };
        },
        all: async () => ({ results: [] }),
      };
      return statement;
    },
  };
  return { env: { DB } as unknown as Env, seen };
}

describe('superseded counts in health', () => {
  it('mind_health reports the total and the last 7 days', async () => {
    const { env, seen } = healthEnv();
    const out = await handleMindHealth(env);
    expect(out).toMatch(/Superseded Obs:\s+12 \(3 in the last 7d/);
    const recent = seen.find((s) => /superseded_by IS NOT NULL AND valid_until >/.test(s.sql));
    const cutoff = new Date(String(recent?.binds[0])).getTime();
    expect(Date.now() - cutoff).toBeGreaterThan(6.9 * 86400_000);
    expect(Date.now() - cutoff).toBeLessThan(7.1 * 86400_000);
  });

  it('the telemetry endpoint mirrors them', async () => {
    const { env } = healthEnv();
    const res = await handleApiTelemetry(new Request('http://x/api/telemetry'), env);
    const body = await res.json() as { living_surface: Record<string, number> };
    expect(body.living_surface.superseded_obs).toBe(12);
    expect(body.living_surface.superseded_obs_7d).toBe(3);
  });
});
