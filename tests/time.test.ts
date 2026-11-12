import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTimeOfDayContext, nightDateFor } from '../src/shared/time';

afterEach(() => vi.useRealTimers());

describe('deployment time context', () => {
  it('uses the configured timezone', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-14T12:00:00Z'));
    expect(getTimeOfDayContext('UTC').period).toBe('midday');
    expect(getTimeOfDayContext('Pacific/Auckland').period).toBe('night');
  });

  it('falls back safely to UTC for an invalid timezone', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-14T23:00:00Z'));
    expect(getTimeOfDayContext('not/a-zone').period).toBe('night');
  });
});

describe('nightDateFor', () => {
  const at = (iso: string, zone?: string) => nightDateFor(new Date(iso), zone);

  it('defaults to UTC and dates the hours before 05:00 to the previous evening', () => {
    expect(at('2026-03-10T21:59:00Z')).toBe('2026-03-10');
    expect(at('2026-03-10T22:00:00Z')).toBe('2026-03-10');
    expect(at('2026-03-10T23:59:59Z')).toBe('2026-03-10');
    expect(at('2026-03-11T00:00:00Z')).toBe('2026-03-10');
    expect(at('2026-03-11T04:59:59Z')).toBe('2026-03-10');
    expect(at('2026-03-11T05:00:00Z')).toBe('2026-03-11');
  });

  it('rolls back across a month and a year boundary', () => {
    expect(at('2026-03-01T02:00:00Z')).toBe('2026-02-28');
    expect(at('2027-01-01T01:00:00Z')).toBe('2026-12-31');
    expect(at('2028-03-01T01:00:00Z')).toBe('2028-02-29');
  });

  it('keeps one local night under one key in Europe/Lisbon during WEST', () => {
    // WEST is UTC+1: the night of 14 July runs 21:00Z on the 14th to 04:00Z on the 15th.
    expect(at('2026-07-14T20:59:59Z', 'Europe/Lisbon')).toBe('2026-07-14');
    expect(at('2026-07-14T21:00:00Z', 'Europe/Lisbon')).toBe('2026-07-14');
    expect(at('2026-07-14T23:30:00Z', 'Europe/Lisbon')).toBe('2026-07-14');
    expect(at('2026-07-15T03:59:59Z', 'Europe/Lisbon')).toBe('2026-07-14');
    expect(at('2026-07-15T04:00:00Z', 'Europe/Lisbon')).toBe('2026-07-15');
    // The UTC date flips at midnight UTC; the night key must not.
    expect(at('2026-07-14T22:30:00Z', 'Europe/Lisbon')).toBe(at('2026-07-15T00:30:00Z', 'Europe/Lisbon'));
  });

  it('keeps one local night under one key in Europe/Lisbon during WET', () => {
    expect(at('2026-01-14T21:59:59Z', 'Europe/Lisbon')).toBe('2026-01-14');
    expect(at('2026-01-14T22:00:00Z', 'Europe/Lisbon')).toBe('2026-01-14');
    expect(at('2026-01-15T04:59:59Z', 'Europe/Lisbon')).toBe('2026-01-14');
    expect(at('2026-01-15T05:00:00Z', 'Europe/Lisbon')).toBe('2026-01-15');
  });

  it('follows the clock change in Europe/Lisbon', () => {
    // 2026-03-29 01:00Z is when WEST starts; local 05:00 WEST is 04:00Z.
    expect(at('2026-03-29T03:59:59Z', 'Europe/Lisbon')).toBe('2026-03-28');
    expect(at('2026-03-29T04:00:00Z', 'Europe/Lisbon')).toBe('2026-03-29');
  });

  it('works for a zone far ahead of UTC (Pacific/Auckland)', () => {
    // NZST is UTC+12 in July: local 22:00 on the 14th is 10:00Z the same day.
    expect(at('2026-07-14T09:59:59Z', 'Pacific/Auckland')).toBe('2026-07-14');
    expect(at('2026-07-14T10:00:00Z', 'Pacific/Auckland')).toBe('2026-07-14');
    expect(at('2026-07-14T12:00:00Z', 'Pacific/Auckland')).toBe('2026-07-14');
    expect(at('2026-07-14T16:59:59Z', 'Pacific/Auckland')).toBe('2026-07-14');
    expect(at('2026-07-14T17:00:00Z', 'Pacific/Auckland')).toBe('2026-07-15');
  });

  it('works for a zone behind UTC (America/Los_Angeles)', () => {
    // PDT is UTC-7: local 22:00 on the 14th is 05:00Z on the 15th, and the night ends 12:00Z.
    expect(at('2026-07-15T04:59:59Z', 'America/Los_Angeles')).toBe('2026-07-14');
    expect(at('2026-07-15T05:00:00Z', 'America/Los_Angeles')).toBe('2026-07-14');
    expect(at('2026-07-15T08:00:00Z', 'America/Los_Angeles')).toBe('2026-07-14');
    expect(at('2026-07-15T11:59:59Z', 'America/Los_Angeles')).toBe('2026-07-14');
    expect(at('2026-07-15T12:00:00Z', 'America/Los_Angeles')).toBe('2026-07-15');
  });

  it('falls back to UTC for an invalid or empty zone', () => {
    expect(at('2026-07-15T01:00:00Z', 'not/a-zone')).toBe('2026-07-14');
    expect(at('2026-07-15T01:00:00Z', '')).toBe('2026-07-14');
    expect(at('2026-07-15T01:00:00Z', undefined)).toBe('2026-07-14');
  });
});
