import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script with no type declarations
import { buildReport, readPairs, wordOverlap, wordSet, SHORT_MAX_CHARS } from '../scripts/check-supersede.mjs';

import { AUTO_SUPERSEDE_MAX_CHARS } from '../src/shared/constants';

const SECRET_OLD = 'Zebrafish pelican saxophone lighthouse';
const SECRET_NEW = 'Zebrafish pelican quartz harbour';

function row(over: Record<string, unknown> = {}) {
  return {
    old_id: 1, new_id: 2, entity_id: 7,
    old_content: SECRET_OLD, new_content: SECRET_NEW,
    old_added_at: new Date('2026-10-01T10:00:00Z'), new_added_at: new Date('2026-10-02T10:00:00Z'),
    retired_at: new Date('2026-10-02T10:00:01Z'),
    ...over,
  };
}

describe('check-supersede constants', () => {
  it('uses the same short-fact length as the server', () => {
    expect(SHORT_MAX_CHARS).toBe(AUTO_SUPERSEDE_MAX_CHARS);
  });
});

describe('check-supersede word overlap', () => {
  it('uses lowercase words of 4+ letters', () => {
    expect([...wordSet('The CAT sat; Zebra, zebra! a-b 12345 über')].sort()).toEqual(['zebra', 'über'].sort());
  });

  it('is Jaccard over those sets', () => {
    // {zebrafish, pelican, saxophone, lighthouse} vs {zebrafish, pelican, quartz, harbour}: 2 / 6
    expect(wordOverlap(SECRET_OLD, SECRET_NEW)).toBeCloseTo(2 / 6);
    expect(wordOverlap('same words here', 'SAME Words Here')).toBe(1);
    expect(wordOverlap('alpha beta', 'gamma delta')).toBe(0);
    expect(wordOverlap('a b c', 'x y z')).toBe(0); // no 4+ letter words at all
    expect(wordOverlap('', '')).toBe(0);
  });
});

describe('check-supersede report', () => {
  it('counts pairs by length, overlap and date', () => {
    const now = new Date('2026-10-05T00:00:00Z');
    const long = 'x'.repeat(SHORT_MAX_CHARS + 1);
    const report = buildReport([
      row({ old_id: 1, new_id: 2 }),                                                    // short, partial overlap
      row({ old_id: 3, new_id: 4, old_content: long, new_content: 'completely different words entirely' }), // long old, no overlap
      row({ old_id: 5, new_id: 6, new_content: long, retired_at: new Date('2026-09-01T00:00:00Z') }),         // long new, retired long ago
      row({ old_id: 7, new_id: null, new_content: null, new_added_at: null }),         // superseder row missing
    ], now);
    expect(report.summary.superseded_total).toBe(4);
    expect(report.summary.pairs_either_side_over_short_max).toBe(2);
    expect(report.summary.pairs_both_short).toBe(2);
    expect(report.summary.retired_last_7_days).toBe(3);
    expect(report.summary.pairs_with_missing_superseder).toBe(1);
    const second = report.pairs[1];
    expect(second).toMatchObject({ old_id: 3, superseder_id: 4, entity_id: 7, old_length: SHORT_MAX_CHARS + 1, word_overlap: 0 });
    expect(report.pairs[0].word_overlap).toBeCloseTo(0.33, 2);
    expect(report.pairs[0].old_added_at).toBe('2026-10-01T10:00:00.000Z');
    expect(report.pairs[3].word_overlap).toBeNull();
  });

  it('never carries memory content into the output', () => {
    const report = buildReport([row()]);
    const printed = JSON.stringify(report);
    for (const word of ['zebrafish', 'pelican', 'saxophone', 'lighthouse', 'quartz', 'harbour']) {
      expect(printed.toLowerCase()).not.toContain(word);
    }
    expect(Object.keys(report.pairs[0]).some((k) => /content/.test(k))).toBe(false);
  });

  it('reads inside one READ ONLY transaction, SELECT only, and rolls back', async () => {
    const statements: string[] = [];
    const client = {
      query: async (sql: string) => { statements.push(sql.trim()); return { rows: [row()] }; },
    };
    const rows = await readPairs(client);
    expect(rows).toHaveLength(1);
    expect(statements[0]).toBe('BEGIN TRANSACTION READ ONLY');
    expect(statements.at(-1)).toBe('ROLLBACK');
    const middle = statements.slice(1, -1);
    expect(middle).toHaveLength(1);
    expect(middle[0]).toMatch(/^SELECT/i);
    expect(statements.join('\n')).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|COMMIT)\b/i);
  });
});
