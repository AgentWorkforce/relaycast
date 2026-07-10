// Shared assertion helpers for the conformance runners. These never throw —
// they return a list of human-readable failures so the harness can report all
// problems per fixture and surface the captured evidence for G5 sign-off.

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Deep-subset match: every key/value in `expected` must be present and equal in
 * `actual`. Arrays must match element-by-element as subsets. Returns failure
 * strings (empty array === match).
 */
export function deepSubsetMismatch(
  expected: unknown,
  actual: unknown,
  path = "body",
): string[] {
  if (isObject(expected)) {
    if (!isObject(actual)) {
      return [`${path}: expected object, got ${describe(actual)}`];
    }
    const errors: string[] = [];
    for (const [key, value] of Object.entries(expected)) {
      errors.push(...deepSubsetMismatch(value, actual[key], `${path}.${key}`));
    }
    return errors;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      return [`${path}: expected array, got ${describe(actual)}`];
    }
    const errors: string[] = [];
    expected.forEach((el, i) => {
      errors.push(...deepSubsetMismatch(el, actual[i], `${path}[${i}]`));
    });
    return errors;
  }
  // primitive
  if (expected !== actual) {
    return [`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`];
  }
  return [];
}

function describe(v: unknown): string {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/** Check that `contains` substrings all appear in the JSON-ified content. */
export function missingSubstrings(
  content: string,
  contains: readonly string[] | undefined,
): string[] {
  if (!contains || contains.length === 0) return [];
  return contains
    .filter((needle) => !content.includes(needle))
    .map((needle) => `content does not include ${JSON.stringify(needle)}`);
}

/** Test a captured path against an exact value or a regex string. */
export function pathMatches(
  capturedPath: string,
  exact: string | undefined,
  pattern: string | undefined,
): boolean {
  if (exact !== undefined && capturedPath === exact) return true;
  if (pattern !== undefined) {
    try {
      return new RegExp(pattern).test(capturedPath);
    } catch {
      return false;
    }
  }
  return false;
}
