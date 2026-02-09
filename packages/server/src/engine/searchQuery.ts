// Keep this logic separate so query parsing can be unit-tested without a DB.
export function buildTsquery(q: string): string {
  // Treat punctuation as a delimiter ("cursor-test" -> "cursor" + "test").
  // This avoids accidentally joining tokens into a non-existent lexeme.
  return q
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' & ');
}
