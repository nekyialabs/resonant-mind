/**
 * Bounds for caller-supplied row counts and day windows.
 */

export const MAX_LIMIT = 500;

/**
 * Coerce a caller-supplied limit to an integer in [1, max]. A missing,
 * non-numeric, or non-positive value gives `fallback`; a larger one is capped.
 */
export function clampLimit(value: unknown, fallback: number, max = MAX_LIMIT): number {
  let n: number;
  if (typeof value === "number") n = value;
  else if (typeof value === "string" && value.trim() !== "") n = Number(value);
  else return fallback;
  if (!Number.isFinite(n)) return fallback;
  n = Math.floor(n);
  if (n < 1) return fallback;
  return Math.min(n, max);
}
