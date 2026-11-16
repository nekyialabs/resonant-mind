import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import {
  BOND_WARMTH_SQL, WARMING_RELATIONS_FROM_PERSON, WARMING_RELATIONS_TO_PERSON,
  classifyWarmth, computeBondWarmth, resolveBondWarmthDays,
} from '../src/daemon/bond-warmth';

afterEach(() => { vi.restoreAllMocks(); });

describe('BOND_WARMTH_DAYS', () => {
  const dflt = { warm: 1, cooling: 4, cold: 14 };

  it('defaults to 1,4,14 when unset or empty', () => {
    expect(resolveBondWarmthDays({})).toEqual(dflt);
    expect(resolveBondWarmthDays({ BOND_WARMTH_DAYS: '' })).toEqual(dflt);
    expect(resolveBondWarmthDays({ BOND_WARMTH_DAYS: '  ' })).toEqual(dflt);
  });

  it('reads three increasing positive numbers', () => {
    expect(resolveBondWarmthDays({ BOND_WARMTH_DAYS: '2,7,30' })).toEqual({ warm: 2, cooling: 7, cold: 30 });
    expect(resolveBondWarmthDays({ BOND_WARMTH_DAYS: ' 0.5 , 3 , 10 ' })).toEqual({ warm: 0.5, cooling: 3, cold: 10 });
  });

  it('falls back to the default on a bad value, warning once per value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bad = ['1,4', '1,4,14,30', '4,4,14', '5,4,14', '0,4,14', '-1,4,14', 'a,b,c', '1,,14', '1;4;14'];
    for (const b of bad) {
      expect(resolveBondWarmthDays({ BOND_WARMTH_DAYS: b })).toEqual(dflt);
      expect(resolveBondWarmthDays({ BOND_WARMTH_DAYS: b })).toEqual(dflt); // second read: no second warning
    }
    expect(warn).toHaveBeenCalledTimes(bad.length);
    expect(String(warn.mock.calls[0][0])).toContain('BOND_WARMTH_DAYS');
  });

  it('classifies against the thresholds', () => {
    const d = { warm: 2, cooling: 7, cold: 30 };
    expect(classifyWarmth(null, d)).toBe('untouched');
    expect(classifyWarmth(1.9, d)).toBe('warm');
    expect(classifyWarmth(2, d)).toBe('cooling');
    expect(classifyWarmth(6.9, d)).toBe('cooling');
    expect(classifyWarmth(7, d)).toBe('cold');
    expect(classifyWarmth(30, d)).toBe('distant');
  });
});

describe('computeBondWarmth', () => {
  function envWith(results: Record<string, unknown>[], extra: Partial<Env> = {}) {
    const prepared: string[] = [];
    const DB = {
      prepare(sql: string) {
        prepared.push(sql);
        return { all: async () => ({ results }) };
      },
    };
    return { env: { DB, ...extra } as unknown as Env, prepared };
  }

  it('uses one SQL pass and maps the latest touch and its source', async () => {
    const { env, prepared } = envWith([
      { id: 1, name: 'A', last_observed_at: new Date('2026-11-14T10:00:00Z'), last_touch_source: 'feeling', days_since: '0.4' },
      { id: 2, name: 'B', last_observed_at: '2026-11-01T00:00:00Z', last_touch_source: 'related', days_since: '3' },
      { id: 3, name: 'C', last_observed_at: null, last_touch_source: null, days_since: null },
    ]);
    const out = await computeBondWarmth(env);
    expect(prepared).toHaveLength(1);
    expect(out.map((o) => [o.state, o.last_touch_source])).toEqual([
      ['warm', 'feeling'], ['cooling', 'related'], ['untouched', null],
    ]);
    expect(out[0].last_observed_at).toBe('2026-11-14T10:00:00.000Z');
    expect(out[0].days_since).toBe(0.4);
  });

  it('applies BOND_WARMTH_DAYS from the env', async () => {
    const { env } = envWith([{ id: 2, name: 'B', last_observed_at: 'x', last_touch_source: 'memory', days_since: '3' }], { BOND_WARMTH_DAYS: '5,10,20' });
    expect((await computeBondWarmth(env))[0].state).toBe('warm');
  });
});

describe('the warmth query', () => {
  it('counts only active observations, in all three sources', () => {
    const obsJoins = BOND_WARMTH_SQL.match(/JOIN observations o ON [^\n]*/g) ?? [];
    expect(obsJoins).toHaveLength(3);
    for (const join of obsJoins) expect(join).toContain('o.archived_at IS NULL');
    expect(BOND_WARMTH_SQL).toContain('JOIN relational_state rs ON rs.person = p.name');
  });

  it('follows only the chosen relation types, in the matching direction', () => {
    const list = (a: readonly string[]) => a.map((t) => `'${t}'`).join(', ');
    expect(BOND_WARMTH_SQL).toContain(`r.to_entity = p.name AND LOWER(r.relation_type) IN (${list(WARMING_RELATIONS_TO_PERSON)})`);
    expect(BOND_WARMTH_SQL).toContain(`r.from_entity = p.name AND LOWER(r.relation_type) IN (${list(WARMING_RELATIONS_FROM_PERSON)})`);
    // a loose connection does not warm a bond
    for (const loose of ['knows', 'connects_to', 'resonates_with', 'informs', 'tensions_with', 'loves']) {
      expect([...WARMING_RELATIONS_TO_PERSON, ...WARMING_RELATIONS_FROM_PERSON] as string[]).not.toContain(loose);
    }
    expect(WARMING_RELATIONS_TO_PERSON).toContain('is_part_of');
  });
});
