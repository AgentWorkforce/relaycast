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
    // Strip characters that have special meaning in FTS5 (except quotes for
    // phrases). Keep Unicode letters/numbers so non-English queries (CJK,
    // Cyrillic, accented Latin, …) still match instead of being stripped away.
    .replace(/[^\p{L}\p{N}\s"]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}
