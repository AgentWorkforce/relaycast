import { describe, expect, it } from 'vitest';
import { isObserverTokenNameConflict } from './observerToken.js';

/**
 * Regression coverage for the D1-vs-better-sqlite3 driver mismatch: a name-collision
 * insert into `observer_tokens` must be recognized as a conflict (and converted to a
 * clean 409) no matter which driver threw it, or which shape that driver used.
 *
 * The better-sqlite3 shape is exercised end-to-end (through the real HTTP route, against
 * a real better-sqlite3-backed db) by
 * `src/__tests__/conformance/observerToken.test.ts` — "returns a conflict for duplicate
 * observer token names in one workspace". This file instead unit-tests the pure detection
 * function directly against driver error shapes that can't be produced by the
 * better-sqlite3 test harness at all, most importantly Cloudflare D1's, since we can't
 * spin up a real D1 binding in this package's test suite.
 *
 * The D1 shape below (`.code === 'SQLITE_CONSTRAINT_UNIQUE'`, `.message` prefixed
 * `D1_ERROR: UNIQUE constraint failed: ...`, and drizzle-orm's `.cause` wrapping) is not
 * speculative — it mirrors the shape this engine already confirmed and handles in
 * `engine/agent.ts`'s `isUniqueConstraintError` (added in PR #193 for the identical class
 * of bug: a 409 unique-name conflict silently regressing to an uncaught 500 against D1).
 */
describe('isObserverTokenNameConflict', () => {
  it('recognizes the better-sqlite3 shape (code + raw message)', () => {
    expect(isObserverTokenNameConflict({
      code: 'SQLITE_CONSTRAINT_UNIQUE',
      message: 'UNIQUE constraint failed: observer_tokens.workspace_id, observer_tokens.name',
    })).toBe(true);
  });

  it('recognizes the legacy better-sqlite3 code without SQLITE_CONSTRAINT_UNIQUE', () => {
    expect(isObserverTokenNameConflict({
      code: 'SQLITE_CONSTRAINT',
      message: 'SQLITE_CONSTRAINT: UNIQUE constraint failed: observer_tokens.workspace_id, observer_tokens.name',
    })).toBe(true);
  });

  it('recognizes the Cloudflare D1 shape (D1_ERROR-prefixed message, top level)', () => {
    expect(isObserverTokenNameConflict({
      code: 'SQLITE_CONSTRAINT_UNIQUE',
      message: 'D1_ERROR: UNIQUE constraint failed: observer_tokens.workspace_id, observer_tokens.name: SQLITE_CONSTRAINT',
    })).toBe(true);
  });

  it('recognizes D1 errors that drizzle-orm re-wraps under .cause', () => {
    const d1Error = {
      code: 'SQLITE_CONSTRAINT_UNIQUE',
      message: 'D1_ERROR: UNIQUE constraint failed: observer_tokens.workspace_id, observer_tokens.name: SQLITE_CONSTRAINT',
    };
    const wrapped = {
      message: 'Failed query: insert into "observer_tokens" ...',
      cause: d1Error,
    };
    expect(isObserverTokenNameConflict(wrapped)).toBe(true);
  });

  it('recognizes a generic case-insensitive "unique constraint" message with no recognizable code', () => {
    expect(isObserverTokenNameConflict({
      message: 'Unique Constraint Failed on observer_tokens',
    })).toBe(true);
  });

  it('does not falsely match unrelated errors', () => {
    expect(isObserverTokenNameConflict({ code: 'SQLITE_BUSY', message: 'database is locked' })).toBe(false);
    expect(isObserverTokenNameConflict(new Error('workspace not found'))).toBe(false);
    expect(isObserverTokenNameConflict({ message: 'Failed query', cause: { message: 'connection reset' } })).toBe(false);
  });

  it('does not recurse infinitely or throw on a self-referential .cause', () => {
    const circular: { message: string; cause?: unknown } = { message: 'wrapped' };
    circular.cause = circular;
    expect(() => isObserverTokenNameConflict(circular)).not.toThrow();
    expect(isObserverTokenNameConflict(circular)).toBe(false);
  });

  it('handles non-object and null inputs safely', () => {
    expect(isObserverTokenNameConflict(null)).toBe(false);
    expect(isObserverTokenNameConflict(undefined)).toBe(false);
    expect(isObserverTokenNameConflict('some string error')).toBe(false);
  });
});
