import { describe, expect, it } from 'vitest';
import { dreamDateFor, shiftDate } from '../src/shared/time';

describe('dreamDateFor', () => {
  const at = (iso: string, zone?: string) => dreamDateFor(new Date(iso), zone);

  it('matches the night date inside the night', () => {
    expect(at('2026-03-10T22:00:00Z')).toBe('2026-03-10');
    expect(at('2026-03-11T02:00:00Z')).toBe('2026-03-10');
    expect(at('2026-03-11T04:59:59Z')).toBe('2026-03-10');
  });

  it('keys a forced daytime dream to the previous night', () => {
    expect(at('2026-03-11T05:00:00Z')).toBe('2026-03-10');
    expect(at('2026-03-11T15:00:00Z')).toBe('2026-03-10');
    expect(at('2026-03-11T21:59:59Z')).toBe('2026-03-10');
    // 22:00 starts the new night, so it is no longer the previous night's.
    expect(at('2026-03-11T22:00:00Z')).toBe('2026-03-11');
  });

  it('uses the local clock', () => {
    // 15:00 in Los Angeles (PDT) on the 14th is 22:00Z.
    expect(at('2026-07-14T22:00:00Z', 'America/Los_Angeles')).toBe('2026-07-13');
    expect(at('2026-07-15T06:00:00Z', 'America/Los_Angeles')).toBe('2026-07-14');
  });
});

describe('shiftDate', () => {
  it('moves across month, year and leap-day boundaries', () => {
    expect(shiftDate('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDate('2027-01-01', -1)).toBe('2026-12-31');
    expect(shiftDate('2028-03-01', -1)).toBe('2028-02-29');
    expect(shiftDate('2026-12-31', 1)).toBe('2027-01-01');
  });
});
