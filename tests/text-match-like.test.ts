import { describe, expect, it } from 'vitest';
import { handleMindDelete } from '../src/legacy-tools/delete';
import { handleMindEdit } from '../src/legacy-tools/edit';
import { handleMindResolve } from '../src/legacy-tools/resolve';
import { handleMindSit } from '../src/legacy-tools/sit';
import type { Env } from '../src/types';

function recordingEnv() {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const DB = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const s = {
        bind(...a: unknown[]) { args = a; return s; },
        async first() { calls.push({ sql, args }); return null; },
        async run() { calls.push({ sql, args }); return { success: true, meta: { changes: 0 } }; },
        async all() { calls.push({ sql, args }); return { results: [] }; },
      };
      return s;
    },
  };
  return { env: { DB } as unknown as Env, calls };
}

const likeCall = (calls: Array<{ sql: string; args: unknown[] }>) => calls.find((c) => /LIKE \?/.test(c.sql));

describe('text_match is matched literally', () => {
  const cases: Array<[string, (env: Env, text: string) => Promise<string>]> = [
    ['mind_delete', (env, text) => handleMindDelete(env, { text_match: text })],
    ['mind_edit (observation)', (env, text) => handleMindEdit(env, { text_match: text, new_content: 'x' })],
    ['mind_edit (image description)', (env, text) => handleMindEdit(env, { description_match: text, new_content: 'x' })],
    ['active_resolve', (env, text) => handleMindResolve(env, { text_match: text })],
    ['mind_sit', (env, text) => handleMindSit(env, { text_match: text })],
  ];

  it.each(cases)('%s escapes wildcards and declares the escape character', async (_name, run) => {
    const { env, calls } = recordingEnv();

    await run(env, '50%_off\\');

    const call = likeCall(calls);
    expect(call).toBeDefined();
    expect(call!.sql).toContain("LIKE ? ESCAPE '\\'");
    expect(call!.args).toEqual(['%50\\%\\_off\\\\%']);
  });

  it.each(cases)('%s does not turn a bare wildcard into match-everything', async (_name, run) => {
    const { env, calls } = recordingEnv();

    await run(env, '%');

    expect(likeCall(calls)!.args).toEqual(['%\\%%']);
  });
});
