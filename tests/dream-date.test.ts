import { describe, expect, it } from 'vitest';
import { shiftDate } from '../src/shared/time';

describe('shiftDate', () => {
  it('moves across month, year and leap-day boundaries', () => {
    expect(shiftDate('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDate('2027-01-01', -1)).toBe('2026-12-31');
    expect(shiftDate('2028-03-01', -1)).toBe('2028-02-29');
    expect(shiftDate('2026-12-31', 1)).toBe('2027-01-01');
  });
});
