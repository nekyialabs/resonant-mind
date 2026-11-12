/**
 * Bounds for caller-supplied row counts, offsets and day or hour windows.
 */

export const MAX_LIMIT = 500;
export const MAX_OFFSET = 100000;

/** A finite number, or a string of plain decimal digits; anything else is null. */
function parseCount(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

/**
 * Coerce a caller-supplied limit to an integer in [1, max]. Only finite
 * numbers and digit-only strings are accepted; fractions are floored. A
 * missing, malformed, zero or negative value gives `fallback`; a larger one is
 * capped at `max`.
 */
export function clampLimit(value: unknown, fallback: number, max = MAX_LIMIT): number {
  const n = parseCount(value);
  if (n === null) return fallback;
  const whole = Math.floor(n);
  if (whole < 1) return fallback;
  return Math.min(whole, max);
}

/**
 * Coerce a caller-supplied offset to an integer in [0, max]. A missing,
 * malformed or negative value gives 0.
 */
export function clampOffset(value: unknown, max = MAX_OFFSET): number {
  const n = parseCount(value);
  if (n === null) return 0;
  const whole = Math.floor(n);
  if (whole < 0) return 0;
  return Math.min(whole, max);
}
