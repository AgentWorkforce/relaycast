/**
 * Parse a Postgres `text[]` literal into a JS string array.
 *
 * Why this exists: some Postgres clients can return a `text[]` column as the
 * raw array literal (a string like `'{val1,val2}'` or `'{"val1","val2"}'`)
 * rather than a parsed JS array — e.g. drivers without OID-based type
 * introspection. Any consumer that needs the parsed array must normalise the
 * value at the SQL boundary; this helper does that defensively.
 *
 * Already array? Pass through. Already null/undefined? Return null. Otherwise
 * parse a Postgres array literal, supporting:
 *   - empty literal:  `{}`
 *   - unquoted items: `{a,b,c}`
 *   - quoted items:   `{"a","b","c"}`
 *   - mixed:          `{a,"b,c",d}`
 *   - escaped chars:  `{"hello\\\"world"}`  →  `['hello"world']`
 *   - NULL entries:   `{NULL,a}`  →  literal "NULL" string preserved (callers
 *     can decide; we don't currently store nullable text[] entries).
 *
 * Strict: malformed literals return `null` rather than throwing — callers in
 * the dispatch hot path treat null as "no watch globs" and bail safely. A
 * structured warn-log at the call site captures malformed inputs for
 * diagnosis without taking the request down.
 */
export function parsePostgresTextArray(value: unknown): string[] | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.every((entry) => typeof entry === "string")
      ? (value as string[])
      : null;
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return [];
  }
  if (trimmed === "{}") {
    return [];
  }
  if (trimmed[0] !== "{" || trimmed[trimmed.length - 1] !== "}") {
    return null;
  }

  const body = trimmed.slice(1, -1);
  const result: string[] = [];
  let i = 0;
  while (i < body.length) {
    if (body[i] === ",") {
      // empty unquoted item (e.g. `{a,,b}`) — preserve as empty string for symmetry
      result.push("");
      i += 1;
      continue;
    }
    if (body[i] === '"') {
      // quoted: read until unescaped closing quote
      let buf = "";
      i += 1;
      while (i < body.length) {
        const ch = body[i];
        if (ch === "\\" && i + 1 < body.length) {
          buf += body[i + 1];
          i += 2;
          continue;
        }
        if (ch === '"') {
          i += 1;
          break;
        }
        buf += ch;
        i += 1;
      }
      result.push(buf);
      // skip trailing comma
      if (body[i] === ",") {
        i += 1;
      }
      continue;
    }
    // unquoted: read until next comma
    let buf = "";
    while (i < body.length && body[i] !== ",") {
      buf += body[i];
      i += 1;
    }
    result.push(buf);
    if (body[i] === ",") {
      i += 1;
    }
  }
  return result;
}

/**
 * Parse a JSON array value that may have arrived from postgres-js as either a
 * JS array (when type introspection succeeded) or a JSON string (when
 * `fetch_types: false` disabled introspection). Mirrors the rationale on
 * `parsePostgresTextArray` above for the `jsonb` column case.
 *
 * Returns `null` on null/undefined input or unparseable strings; returns the
 * parsed array on success. We intentionally do not narrow the element type
 * since `watch_rules` is `unknown[]`.
 */
export function parseJsonArrayMaybeString(value: unknown): unknown[] | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
