import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleApiEntities } from '../src/http/handlers/entities';
import { handleApiDream } from '../src/http/handlers/daemon';
import { handleMindEntity } from '../src/legacy-tools/entity';
import { handleMindInnerWeather } from '../src/legacy-tools/inner-weather';
import { handleMindPatterns } from '../src/legacy-tools/patterns';
import { handleMindRead } from '../src/legacy-tools/read';
import { handleMindStoreImage } from '../src/legacy-tools/store-image';
import { handleMindTension } from '../src/legacy-tools/tension';
import { handleMindTimeline } from '../src/legacy-tools/timeline';
import type { Env } from '../src/types';

const SECRET = 'password authentication failed for user "svc" at db-internal.example:5432';

function failingEnv(): Env {
  const fail = async () => { throw new Error(SECRET); };
  const DB = {
    prepare() {
      const s = { bind() { return s; }, run: fail, first: fail, all: fail };
      return s;
    },
  };
  return { DB, R2_IMAGES: {}, VECTORS: {} } as unknown as Env;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('tool errors do not carry raw exception text', () => {
  const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => undefined);

  it.each([
    ['mind_tension', (env: Env) => handleMindTension(env, { action: 'list' })],
    ['mind_read', (env: Env) => handleMindRead(env, { scope: 'all' })],
    ['mind_patterns', (env: Env) => handleMindPatterns(env, {})],
    ['mind_timeline', (env: Env) => handleMindTimeline(env, {})],
    ['inner_weather', (env: Env) => handleMindInnerWeather(env)],
  ])('%s returns a generic error in the same JSON shape and logs the cause', async (_name, run) => {
    const log = quiet();

    const out = await run(failingEnv());

    expect(JSON.parse(out)).toEqual({ error: 'Internal error' });
    expect(out).not.toContain('db-internal');
    expect(log).toHaveBeenCalled();
    expect(log.mock.calls.some((call) => call.some((arg) => arg instanceof Error))).toBe(true);
  });

  it('graph_shape merge reports a generic failure', async () => {
    const log = quiet();

    const out = await handleMindEntity(failingEnv(), { action: 'merge', merge_from_id: 1, merge_into_id: 2 });

    expect(out).toBe('Merge of #1 into #2 failed and was not applied');
    expect(log).toHaveBeenCalled();
  });

  it('keeps deliberate validation messages', async () => {
    expect(JSON.parse(await handleMindTension(failingEnv(), { action: 'add' })))
      .toEqual({ error: "pole_a and pole_b required for action='add'" });
    expect(await handleMindEntity(failingEnv(), { action: 'merge' })).toBe('Must provide merge_from_id and merge_into_id');
  });

  it('POST /api/entities/merge returns a generic 500', async () => {
    const log = quiet();
    const res = await handleApiEntities(
      new Request('https://mind.example/api/entities/merge', {
        method: 'POST',
        body: JSON.stringify({ merge_from_id: 1, merge_into_id: 2 }),
      }),
      failingEnv(),
      ['api', 'entities', 'merge'],
    );

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Merge failed and was not applied' });
    expect(log).toHaveBeenCalled();
  });

  it('the dream endpoint returns a generic 500', async () => {
    const log = quiet();
    const res = await handleApiDream(new Request('https://mind.example/api/dream'), failingEnv());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ status: 'error', error: 'Dream generation failed' });
    expect(log).toHaveBeenCalled();
  });
});

describe('store_image fetch errors', () => {
  const run = () => handleMindStoreImage(
    { R2_IMAGES: {}, DB: {} } as unknown as Env,
    { action: 'store', source_url: 'https://images.example.com/a.png', description: 'x' },
  );

  it('hides a low-level network error but logs it', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', async () => { throw new TypeError('connect ECONNREFUSED 10.0.0.5:443'); });

    const out = await run();

    expect(out).toBe('Error: source_url fetch failed — the URL could not be fetched');
    expect(out).not.toContain('10.0.0.5');
    expect(log).toHaveBeenCalled();
  });

  it('keeps the module\'s own messages', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', async () => new Response('no', { status: 404, statusText: 'Not Found' }));

    expect(await run()).toBe('Error: source_url fetch failed — source_url fetch returned 404 Not Found');
  });
});
