import { beforeEach, describe, expect, it, vi } from 'vitest';

const searchVectors = vi.fn(async (..._args: unknown[]) => ({ matches: [] as unknown[] }));
vi.mock('../src/shared/mind-helpers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getEmbedding: async () => [0],
  searchVectors: (...args: unknown[]) => searchVectors(...args),
}));

import { handleApiArchive } from '../src/http/handlers/archive';
import { handleApiBonds } from '../src/http/handlers/bonds';
import { handleApiObservations } from '../src/http/handlers/observations';
import { handleBondEnter } from '../src/regions/bonds';
import { handleMindGraph } from '../src/legacy-tools/graph';
import { handleMindRead } from '../src/legacy-tools/read';
import { handleMindSearch } from '../src/legacy-tools/search';
import { handleMindTimeline } from '../src/legacy-tools/timeline';
import { clampLimit, clampOffset } from '../src/shared/limits';
import type { Env } from '../src/types';

type Call = { sql: string; args: unknown[] };

function recordingEnv() {
  const calls: Call[] = [];
  const DB = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const s = {
        bind(...a: unknown[]) { args = a; return s; },
        async all() { calls.push({ sql, args }); return { results: [] }; },
        async first() { calls.push({ sql, args }); return null; },
        async run() { calls.push({ sql, args }); return { success: true, meta: { changes: 0 } }; },
      };
      return s;
    },
  };
  return { env: { DB, VECTORS: {} } as unknown as Env, calls };
}

beforeEach(() => searchVectors.mockClear());

describe('clampLimit accepts only real numbers and digit strings', () => {
  it.each(['0x10', '1e3', ' 25', '25 ', '+5', '1.5', '١٢', 'Infinity'])('falls back for %j', (value) => {
    expect(clampLimit(value, 9)).toBe(9);
  });

  it('keeps digit strings and floors floats', () => {
    expect(clampLimit('25', 9)).toBe(25);
    expect(clampLimit('007', 9)).toBe(7);
    expect(clampLimit(7.9, 9)).toBe(7);
    expect(clampLimit(1e6, 9)).toBe(500);
    expect(clampLimit('99999999999999999999', 9)).toBe(500);
  });

  it('keeps the fallback for zero and negatives', () => {
    expect(clampLimit(0, 9)).toBe(9);
    expect(clampLimit(-4, 9)).toBe(9);
    expect(clampLimit('0', 9)).toBe(9);
    expect(clampLimit('-4', 9)).toBe(9);
  });

  it('honours a custom maximum', () => {
    expect(clampLimit(9000, 24, 8760)).toBe(8760);
  });
});

describe('clampOffset', () => {
  it('accepts non-negative whole numbers and caps them', () => {
    expect(clampOffset(0)).toBe(0);
    expect(clampOffset('40')).toBe(40);
    expect(clampOffset(12.9)).toBe(12);
    expect(clampOffset(5e9)).toBe(100000);
    expect(clampOffset('99999999999')).toBe(100000);
  });

  it('gives 0 for missing, negative or malformed values', () => {
    for (const bad of [undefined, null, '', 'abc', '-1', -1, NaN, Infinity, '1e3', '0x10', ' 5', {}]) {
      expect(clampOffset(bad)).toBe(0);
    }
  });
});

describe('callers use the bounds', () => {
  it('archive and observations lists bind a capped limit and a safe offset', async () => {
    for (const [handler, path] of [[handleApiArchive, 'archive'], [handleApiObservations, 'observations']] as const) {
      const { env, calls } = recordingEnv();
      const request = new Request(`https://mind.example/api/${path}?limit=999999&offset=-5`);

      await handler(request, env, ['api', path]);

      const list = calls.find((c) => /LIMIT \? OFFSET \?/.test(c.sql));
      expect(list?.args.slice(-2)).toEqual([500, 0]);
    }
    const { env, calls } = recordingEnv();
    await handleApiArchive(new Request('https://mind.example/api/archive?offset=1e9'), env, ['api', 'archive']);
    expect(calls.find((c) => /OFFSET/.test(c.sql))?.args.slice(-2)).toEqual([50, 0]);
    const second = recordingEnv();
    await handleApiArchive(new Request('https://mind.example/api/archive?offset=99999999'), second.env, ['api', 'archive']);
    expect(second.calls.find((c) => /OFFSET/.test(c.sql))?.args.slice(-2)).toEqual([50, 100000]);
  });

  it('mind_graph falls back to its default for a negative limit', async () => {
    const { env, calls } = recordingEnv();
    await handleMindGraph(env, { limit: -3 });
    expect(calls.find((c) => /LIMIT \$1/.test(c.sql))?.args).toEqual([25]);
  });

  it('mind_graph still caps at 200', async () => {
    const { env, calls } = recordingEnv();
    await handleMindGraph(env, { limit: 5000 });
    expect(calls.find((c) => /LIMIT \$1/.test(c.sql))?.args).toEqual([200]);
  });

  it('mind_read clamps hours to 1..8760 and defaults on junk', async () => {
    const hoursFor = async (hours: unknown) => {
      const { env } = recordingEnv();
      const out = JSON.parse(await handleMindRead(env, { scope: 'recent', hours }));
      return out.query as string;
    };
    expect(await hoursFor(1e9)).toBe('Last 8760 hours');
    expect(await hoursFor(-5)).toBe('Last 24 hours');
    expect(await hoursFor('abc')).toBe('Last 24 hours');
    expect(await hoursFor(NaN)).toBe('Last 24 hours');
    expect(await hoursFor(48)).toBe('Last 48 hours');
  });

  it('mind_timeline and mind_search cap n_results', async () => {
    const { env } = recordingEnv();

    await handleMindTimeline(env, { query: 'x', n_results: 100000 }).catch(() => undefined);
    expect(searchVectors.mock.calls[0][2]).toBe(1000);

    searchVectors.mockClear();
    await handleMindTimeline(env, { query: 'x', n_results: -4 }).catch(() => undefined);
    expect(searchVectors.mock.calls[0][2]).toBe(100);

    searchVectors.mockClear();
    await handleMindSearch(env, { query: 'x', n_results: 100000 }).catch(() => undefined);
    expect(searchVectors.mock.calls[0][2]).toBe(500);

    searchVectors.mockClear();
    await handleMindSearch(env, { query: 'x', n_results: 0 }).catch(() => undefined);
    expect(searchVectors.mock.calls[0][2]).toBe(10);
  });
});

describe('prefix and substring searches are literal', () => {
  it('search text fallback escapes wildcards', async () => {
    const { env, calls } = recordingEnv();

    await handleMindSearch(env, { query: '50%_off\\', n_results: 3 }).catch(() => undefined);

    const text = calls.find((c) => /FROM journals WHERE content LIKE/.test(c.sql));
    expect(text?.sql).toContain("LIKE ? ESCAPE '\\'");
    expect(text?.args).toEqual(['%50\\%\\_off\\\\%', '%50\\%\\_off\\\\%', 3]);
  });

  it('bond_enter escapes the ILIKE prefix', async () => {
    const { env, calls } = recordingEnv();

    await handleBondEnter(env, { name: '%' }).catch(() => undefined);

    const ilike = calls.find((c) => /ILIKE/.test(c.sql));
    expect(ilike?.sql).toContain("ILIKE $1 ESCAPE '\\'");
    expect(ilike?.args).toEqual(['\\%%']);
  });

  it('GET /api/bonds/:name escapes the ILIKE prefix', async () => {
    const { env, calls } = recordingEnv();

    await handleApiBonds(new Request('https://mind.example/api/bonds/a_b'), env, ['api', 'bonds', 'a_b']);

    const ilike = calls.find((c) => /ILIKE/.test(c.sql));
    expect(ilike?.sql).toContain("ILIKE $2 ESCAPE '\\'");
    expect(ilike?.args).toEqual(['a_b', 'a\\_b%']);
  });
});
