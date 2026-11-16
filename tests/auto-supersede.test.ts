import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

vi.mock('../src/shared/mind-helpers', () => ({
  getEmbedding: async () => [0.1, 0.2, 0.3],
}));
vi.mock('../src/daemon/somatic', () => ({
  checkStartle: async () => undefined,
}));

import { handleMindWrite } from '../src/legacy-tools/write';
import { handleMindProposals } from '../src/legacy-tools/proposals';
import { resolveAutoSupersede } from '../src/shared/supersede';
import { AUTO_SUPERSEDE_MAX_CHARS, AUTO_SUPERSEDE_THRESHOLD, PROPOSAL_PENDING_CAP } from '../src/shared/constants';

const NEW_ID = 100;
const OLD_ID = 5;
const ENTITY_ID = 1;

interface Call { sql: string; binds: unknown[] }

/** A fake env: one entity, one active old observation, one vector match for it. */
function writeEnv(opts: { oldContent: string; score: number; autoSupersede?: string; pending?: number }) {
  const calls: Call[] = [];
  const query = vi.fn(async () => ({
    matches: [{
      id: `obs-${ENTITY_ID}-${OLD_ID}`,
      score: opts.score,
      metadata: { entity: 'Walker', source: 'observation' },
    }],
  }));
  const DB = {
    prepare(sql: string) {
      const call: Call = { sql, binds: [] };
      calls.push(call);
      const statement = {
        bind(...args: unknown[]) { call.binds = args; return statement; },
        first: async () => {
          if (/FROM entities WHERE name/.test(sql)) return { id: ENTITY_ID };
          if (/COUNT\(\*\) as count FROM daemon_proposals/.test(sql)) return { count: opts.pending ?? 0 };
          if (/SELECT id, content FROM observations WHERE id = \?/.test(sql)) return { id: OLD_ID, content: opts.oldContent };
          return null;
        },
        all: async () => ({ results: [] }),
        run: async () => ({
          success: true,
          meta: { changes: 1, last_row_id: /INSERT INTO observations/.test(sql) ? NEW_ID : 0 },
        }),
      };
      return statement;
    },
  };
  const env = {
    DB,
    VECTORS: { query, upsert: async () => undefined },
    GEMINI_API_KEY: 'test',
    AUTO_SUPERSEDE: opts.autoSupersede,
  } as unknown as Env;
  return { env, calls, query };
}

const retireCall = (calls: Call[]) => calls.find((c) => /SET valid_until = NOW\(\), superseded_by/.test(c.sql));
const backPointerCall = (calls: Call[]) => calls.find((c) => /SET supersedes = \?/.test(c.sql));
const proposalCall = (calls: Call[]) => calls.find((c) => /INSERT INTO daemon_proposals/.test(c.sql));

const write = (env: Env, text: string) =>
  handleMindWrite(env, { type: 'observation', entity_name: 'Walker', observations: [text] });

const SHORT_OLD = 'Lives in Leeds.';
const SHORT_NEW = 'Lives in York.';
const LONG = 'The walk along the river was slow and the light kept changing. '.repeat(6); // > 280

describe('auto-supersede: short facts only', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('retires a short old observation for a short new one at or above the threshold', async () => {
    const { env, calls } = writeEnv({ oldContent: SHORT_OLD, score: 0.9 });
    const msg = await write(env, SHORT_NEW);
    expect(retireCall(calls)?.binds).toEqual([NEW_ID, OLD_ID]);
    expect(backPointerCall(calls)?.binds).toEqual([OLD_ID, NEW_ID]);
    expect(proposalCall(calls)).toBeUndefined();
    expect(msg).toContain('Superseded 1 older observation');
  });

  it('retires nothing below the threshold', async () => {
    const { env, calls } = writeEnv({ oldContent: SHORT_OLD, score: 0.84 });
    const msg = await write(env, SHORT_NEW);
    expect(retireCall(calls)).toBeUndefined();
    expect(proposalCall(calls)).toBeUndefined();
    expect(msg).not.toContain('Superseded');
  });

  it('treats exactly the maximum length as short', async () => {
    const edge = 'a'.repeat(AUTO_SUPERSEDE_MAX_CHARS);
    const { env, calls } = writeEnv({ oldContent: edge, score: 0.9 });
    await write(env, edge);
    expect(retireCall(calls)).toBeDefined();
    expect(proposalCall(calls)).toBeUndefined();
  });

  it('never retires a long pair; it records a supersede proposal instead', async () => {
    const { env, calls } = writeEnv({ oldContent: LONG, score: 0.93 });
    const msg = await write(env, LONG + 'And then it rained.');
    expect(retireCall(calls)).toBeUndefined();
    expect(backPointerCall(calls)).toBeUndefined();
    const proposal = proposalCall(calls);
    expect(proposal).toBeDefined();
    // proposal_type, from (old), to (new), from_entity, to_entity, reason, confidence
    expect(proposal!.binds[0]).toBe('supersede');
    expect(proposal!.binds[1]).toBe(OLD_ID);
    expect(proposal!.binds[2]).toBe(NEW_ID);
    expect(proposal!.binds[3]).toBe(ENTITY_ID);
    expect(proposal!.binds[4]).toBe(ENTITY_ID);
    expect(proposal!.binds[6]).toBeCloseTo(0.93);
    expect(String(proposal!.binds[5])).toContain('93%');
    expect(msg).toContain('ritual_tend');
    expect(msg).not.toContain('Superseded');
  });

  it('proposes when only the new observation is long', async () => {
    const { env, calls } = writeEnv({ oldContent: SHORT_OLD, score: 0.9 });
    await write(env, LONG);
    expect(retireCall(calls)).toBeUndefined();
    expect(proposalCall(calls)).toBeDefined();
  });

  it('proposes when only the old observation is long', async () => {
    const { env, calls } = writeEnv({ oldContent: LONG, score: 0.9 });
    await write(env, SHORT_NEW);
    expect(retireCall(calls)).toBeUndefined();
    expect(proposalCall(calls)).toBeDefined();
  });

  it('does not propose a long pair below the threshold', async () => {
    const { env, calls } = writeEnv({ oldContent: LONG, score: 0.82 });
    await write(env, LONG);
    expect(proposalCall(calls)).toBeUndefined();
  });

  it('at the pending cap: no proposal, nothing retired, nothing claimed, one log line', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { env, calls } = writeEnv({ oldContent: LONG, score: 0.93, pending: PROPOSAL_PENDING_CAP });
    const msg = await write(env, LONG);
    expect(proposalCall(calls)).toBeUndefined();
    expect(retireCall(calls)).toBeUndefined();
    expect(msg).not.toContain('ritual_tend');
    expect(msg).not.toContain('Superseded');
    expect(log.mock.calls.filter((c) => String(c[0]).includes('cap'))).toHaveLength(1);

    const under = writeEnv({ oldContent: LONG, score: 0.93, pending: PROPOSAL_PENDING_CAP - 1 });
    await write(under.env, LONG);
    expect(proposalCall(under.calls)).toBeDefined();
  });

  it('still writes the observation when the proposal cannot be recorded', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { env } = writeEnv({ oldContent: LONG, score: 0.9 });
    const original = env.DB.prepare.bind(env.DB);
    (env.DB as unknown as { prepare: (s: string) => unknown }).prepare = (sql: string) => {
      const st = original(sql) as { run: () => Promise<unknown> };
      if (/INSERT INTO daemon_proposals/.test(sql)) st.run = async () => { throw new Error('no such table'); };
      return st;
    };
    const msg = await write(env, LONG);
    expect(msg).toContain('Added 1 observations');
    expect(msg).not.toContain('ritual_tend');
  });
});

describe('AUTO_SUPERSEDE setting', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('off: never retires, never proposes, and does not even search', async () => {
    const short = writeEnv({ oldContent: SHORT_OLD, score: 0.99, autoSupersede: 'off' });
    await write(short.env, SHORT_NEW);
    expect(retireCall(short.calls)).toBeUndefined();
    expect(short.query).not.toHaveBeenCalled();

    const long = writeEnv({ oldContent: LONG, score: 0.99, autoSupersede: ' OFF ' });
    await write(long.env, LONG);
    expect(retireCall(long.calls)).toBeUndefined();
    expect(proposalCall(long.calls)).toBeUndefined();
  });

  it('a number is the threshold, including below the 0.80 candidate floor', async () => {
    const lower = writeEnv({ oldContent: SHORT_OLD, score: 0.72, autoSupersede: '0.7' });
    await write(lower.env, SHORT_NEW);
    expect(retireCall(lower.calls)).toBeDefined();

    const higher = writeEnv({ oldContent: SHORT_OLD, score: 0.9, autoSupersede: '0.95' });
    await write(higher.env, SHORT_NEW);
    expect(retireCall(higher.calls)).toBeUndefined();
  });

  it('a bad value falls back to the default and warns once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bad = 'banana-' + Math.random().toString(36).slice(2);
    // 0.9 retires under the default 0.85; 0.82 does not.
    const above = writeEnv({ oldContent: SHORT_OLD, score: 0.9, autoSupersede: bad });
    await write(above.env, SHORT_NEW);
    expect(retireCall(above.calls)).toBeDefined();
    const below = writeEnv({ oldContent: SHORT_OLD, score: 0.82, autoSupersede: bad });
    await write(below.env, SHORT_NEW);
    expect(retireCall(below.calls)).toBeUndefined();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('AUTO_SUPERSEDE'))).toHaveLength(1);
  });

  it('resolveAutoSupersede validates the value', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const dflt = { off: false, threshold: AUTO_SUPERSEDE_THRESHOLD };
    expect(resolveAutoSupersede({})).toEqual(dflt);
    expect(resolveAutoSupersede({ AUTO_SUPERSEDE: '' })).toEqual(dflt);
    expect(resolveAutoSupersede({ AUTO_SUPERSEDE: 'off' }).off).toBe(true);
    expect(resolveAutoSupersede({ AUTO_SUPERSEDE: '0.9' })).toEqual({ off: false, threshold: 0.9 });
    expect(resolveAutoSupersede({ AUTO_SUPERSEDE: '1' })).toEqual({ off: false, threshold: 1 });
    for (const bad of ['0', '-0.5', '1.2', 'high', 'NaN', '0.8x', 'Infinity']) {
      expect(resolveAutoSupersede({ AUTO_SUPERSEDE: bad })).toEqual(dflt);
    }
  });
});

describe('ritual_tend: supersede proposals', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  /** A fake env holding one pending proposal row. */
  function tendEnv(proposal: Record<string, unknown> | null, listRows: Record<string, unknown>[] = []) {
    const calls: Call[] = [];
    const DB = {
      prepare(sql: string) {
        const call: Call = { sql, binds: [] };
        calls.push(call);
        const statement = {
          bind(...args: unknown[]) { call.binds = args; return statement; },
          first: async () => {
            if (/FROM daemon_proposals dp/.test(sql) && /WHERE dp.id = \?/.test(sql)) return proposal;
            if (/SELECT from_obs_id, to_obs_id FROM daemon_proposals/.test(sql)) return proposal;
            if (/COUNT\(\*\) as count FROM orphan_observations/.test(sql)) return { count: 0 };
            return null;
          },
          all: async () => (/FROM daemon_proposals dp/.test(sql) ? { results: listRows } : { results: [] }),
          run: async () => ({ success: true, meta: { changes: 1 } }),
        };
        return statement;
      },
    };
    return { env: { DB } as unknown as Env, calls };
  }

  const supersedeRow = {
    id: 9, proposal_type: 'supersede', from_obs_id: OLD_ID, to_obs_id: NEW_ID,
    from_entity_id: ENTITY_ID, to_entity_id: ENTITY_ID, entity_a: 'Walker', confidence: 0.91,
    content_a: 'old words', content_b: 'new words', reason: 'Possible supersede (91% similar)',
  };

  it('accept retires the older observation the way auto-supersede does, then closes the proposal', async () => {
    const { env, calls } = tendEnv(supersedeRow);
    const out = await handleMindProposals(env, { action: 'accept', proposal_id: 9 });
    expect(retireCall(calls)?.binds).toEqual([NEW_ID, OLD_ID]);
    expect(backPointerCall(calls)?.binds).toEqual([OLD_ID, NEW_ID]);
    const close = calls.find((c) => /UPDATE daemon_proposals SET status = \$2/.test(c.sql));
    expect(close?.binds).toEqual([9, 'accepted']);
    expect(out).toContain('superseded by');
    // no relation was created
    expect(calls.some((c) => /INSERT INTO relations/.test(c.sql))).toBe(false);
  });

  it('reject changes no observation', async () => {
    const { env, calls } = tendEnv(supersedeRow);
    const out = await handleMindProposals(env, { action: 'reject', proposal_id: 9 });
    expect(out).toContain('rejected');
    expect(calls.some((c) => /UPDATE observations/.test(c.sql))).toBe(false);
    expect(calls.some((c) => /SET status = 'rejected'/.test(c.sql))).toBe(true);
  });

  it('list shows supersedes in their own section, not as relations', async () => {
    const { env } = tendEnv(null, [supersedeRow]);
    const out = await handleMindProposals(env, { action: 'list' });
    expect(out).toContain('Possible Supersedes (1)');
    expect(out).toContain('#5');
    expect(out).toContain('#100');
    expect(out).not.toContain('Cross-Entity Relations');
  });
});
