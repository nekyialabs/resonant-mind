/**
 * A string-keyed accumulator with no prototype, for grouping and counting by
 * stored or caller-supplied names. Names such as "constructor" or "__proto__"
 * are ordinary keys on it; on a plain `{}` they reach Object.prototype members.
 */
export function dict<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}
