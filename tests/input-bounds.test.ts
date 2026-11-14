import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/embeddings', () => ({
  getImageEmbedding: vi.fn(async () => [0.25]),
  getEmbedding: vi.fn(async () => [0.5]),
}));

import { routeRequest } from '../src/http/router';
import { handleMindEntity } from '../src/legacy-tools/entity';
import { handleMindListEntities } from '../src/legacy-tools/list-entities';
import { TOOLS } from '../src/mcp/registry';
import { clampLimit, MAX_LIMIT } from '../src/shared/limits';
import type { Env } from '../src/types';

describe('clampLimit', () => {
  it('keeps ordinary values', () => {
    expect(clampLimit(25, 10)).toBe(25);
    expect(clampLimit('25', 10)).toBe(25);
    expect(clampLimit(500, 10)).toBe(500);
  });

  it('caps large values at the maximum', () => {
    expect(MAX_LIMIT).toBe(500);
    expect(clampLimit(501, 10)).toBe(500);
    expect(clampLimit(1e9, 10)).toBe(500);
    expect(clampLimit('99999', 10)).toBe(500);
    expect(clampLimit(Infinity, 10)).toBe(10);
  });

  it('falls back to the default for missing, non-numeric and non-positive values', () => {
    for (const bad of [undefined, null, '', '   ', 'abc', '12abc', NaN, 0, -3, '-1', 0.5, {}, [], true]) {
      expect(clampLimit(bad, 7)).toBe(7);
    }
  });

  it('floors fractional values', () => {
    expect(clampLimit(2.9, 10)).toBe(2);
  });
});

describe('list_entities limit', () => {
  it('binds a capped limit and keeps the default when absent', async () => {
    const bound: unknown[][] = [];
    const DB = {
      prepare() {
        const s = {
          bind(...args: unknown[]) { bound.push(args); return s; },
          async all() { return { results: [] }; },
          async first() { return null; },
        };
        return s;
      },
    };
    const env = { DB } as unknown as Env;

    await handleMindListEntities(env, { limit: 100000 });
    await handleMindListEntities(env, {});

    const limits = bound.map((args) => args[args.length - 1]);
    expect(limits).toEqual([500, 50]);
  });
});

function entityEnv() {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const DB = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const s = {
        bind(...a: unknown[]) { args = a; return s; },
        async run() { calls.push({ sql, args }); return { success: true, meta: { changes: 4 } }; },
        async first() { return null; },
      };
      return s;
    },
  };
  return { env: { DB } as unknown as Env, calls };
}

describe('archive_old', () => {
  it.each([0, -1, 1.5, NaN, Infinity, '7', '1e3', {}, [], true, false])(
    'refuses older_than_days=%s without writing',
    async (value) => {
      const { env, calls } = entityEnv();
      const out = await handleMindEntity(env, { action: 'archive_old', older_than_days: value });
      expect(out).toMatch(/older_than_days must be a whole number/);
      expect(calls).toEqual([]);
    },
  );

  it('defaults to 30 days when absent', async () => {
    const { env, calls } = entityEnv();
    const out = await handleMindEntity(env, { action: 'archive_old' });
    expect(out).toBe('Archived 4 entities older than 30 days');
    expect(calls).toHaveLength(1);
  });

  it('accepts a positive whole number', async () => {
    const { env } = entityEnv();
    expect(await handleMindEntity(env, { action: 'archive_old', older_than_days: 90 }))
      .toBe('Archived 4 entities older than 90 days');
  });

  it("never archives entities of type 'self'", async () => {
    const { env, calls } = entityEnv();
    await handleMindEntity(env, { action: 'archive_old', older_than_days: 30, entity_type_filter: 'concept' });
    expect(calls[0].sql).toMatch(/entity_type != 'self'/);
    expect(calls[0].args).toHaveLength(2);
  });
});

describe('graph_shape salience schema', () => {
  it('lists the values the handler accepts', () => {
    const tool = TOOLS.find((t) => t.name === 'graph_shape');
    const salience = (tool?.inputSchema.properties as Record<string, { enum?: string[] }>).salience;
    expect(salience.enum).toEqual(['foundational', 'active', 'background', 'archive']);
  });

  it('accepts each listed value in the handler', async () => {
    for (const salience of ['foundational', 'active', 'background', 'archive']) {
      const DB = {
        prepare() {
          const s = {
            bind() { return s; },
            async run() { return { success: true, meta: { changes: 1 } }; },
            async first() { return { id: 1, name: 'X', salience: 'active' }; },
          };
          return s;
        },
      };
      const out = await handleMindEntity({ DB } as unknown as Env, { action: 'set_salience', entity_id: 1, salience });
      expect(out).toBe(`Set X salience to '${salience}' (was 'active')`);
    }
  });
});

const png = new Uint8Array(readFileSync(
  fileURLToPath(new URL('./fixtures/images/valid.png', import.meta.url)),
));
const handlers = {} as Parameters<typeof routeRequest>[2];

function upload(observationId: string | undefined) {
  const form = new FormData();
  form.set('file', new File([png], 'a.png'));
  form.set('description', 'Direct upload');
  if (observationId !== undefined) form.set('observation_id', observationId);
  const insertArgs: unknown[][] = [];
  const put = vi.fn(async () => undefined);
  const env = {
    MIND_API_KEY: 'test-api-key',
    DB: {
      prepare: () => ({
        bind: (...args: unknown[]) => {
          insertArgs.push(args);
          return { run: async () => ({ meta: { last_row_id: 9 } }), first: async () => null };
        },
      }),
    },
    R2_IMAGES: { put, delete: vi.fn(async () => undefined) },
    VECTORS: { upsert: vi.fn(async () => undefined) },
    GEMINI_API_KEY: 'test-gemini-key',
  } as unknown as Env;
  const request = new Request('https://mind.example/api/images/upload', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-api-key' },
    body: form,
  });
  return { response: routeRequest(request, env, handlers), put, insertArgs };
}

describe('image upload observation_id', () => {
  it.each(['12abc', '-4', '0', '1.5', '1e3', ' 12', 'NaN', '99999999999999999999'])(
    'rejects %j with 400 before storing anything',
    async (value) => {
      const { response, put, insertArgs } = upload(value);
      const res = await response;
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'observation_id must be a positive integer' });
      expect(put).not.toHaveBeenCalled();
      expect(insertArgs).toEqual([]);
    },
  );

  it('treats an empty or absent observation_id as none', async () => {
    for (const value of ['', undefined]) {
      const { response, insertArgs } = upload(value);
      expect((await response).status).toBe(200);
      const insert = insertArgs.find((a) => a.length === 7);
      expect(insert?.[6]).toBeNull();
    }
  });

  it('passes a positive integer through', async () => {
    const { response, insertArgs } = upload('12');
    expect((await response).status).toBe(200);
    const insert = insertArgs.find((a) => a.length === 7);
    expect(insert?.[6]).toBe(12);
  });
});
