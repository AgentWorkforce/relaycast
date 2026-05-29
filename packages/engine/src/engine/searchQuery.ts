/**
 * Build an FTS5 match expression from user input.
 *
 * FTS5 uses implicit AND between terms. Special characters are stripped
 * to prevent query syntax errors. Double-quotes enable phrase matching.
 */
export function buildFtsQuery(q: string): string {
  return q
    .toLowerCase()
    .trim()
    // Strip characters that have special meaning in FTS5 (except quotes for phrases)
    .replace(/[^a-z0-9\s"]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}
