/**
 * Text + ID helpers shared across regions, daemon, and legacy tools.
 */

/**
 * Normalize text to ASCII — prevents Unicode homoglyph issues in entity names
 * and observation content. Returns null on empty/null input.
 */
export function normalizeText(text: string | null | undefined): string | null {
  if (!text) return null;
  return text.normalize("NFKD").replace(/[^a-zA-Z0-9\s,.\-]/g, "").trim() || null;
}

/**
 * Generate a unique ID with a human-readable prefix.
 * Format: `${prefix}-YYYYMMDDHHMMSS-xxxx` where xxxx is base36 random.
 */
export function generateId(prefix: string): string {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const random = Math.random().toString(36).slice(2, 6);
  return `${prefix}-${timestamp}-${random}`;
}

/**
 * Escape `%`, `_` and `\` so a caller-supplied string matches literally inside
 * a LIKE pattern. Pair the pattern with `ESCAPE '\'` in the SQL.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}
