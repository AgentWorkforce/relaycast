import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Schema/SQL index drift test.
 *
 * Enforces the invariant that every index declared in
 * packages/relaycron/src/db/schema.ts (via index() / uniqueIndex() calls)
 * has a matching CREATE (UNIQUE )?INDEX statement in
 * packages/relaycron/src/db/migrations/0000_init.sql, and vice versa.
 *
 * Why it exists:
 *   - schema.ts is the source of truth for drizzle-kit. If its declared
 *     index set drifts from the migration SQL, the next drizzle-kit
 *     generate emits a migration that silently drops any index that's
 *     in the SQL but not in the schema — including the UNIQUE index
 *     that protects the api_keys.key_hash lookup used by auth.ts's
 *     .limit(1) query. Dropping that index turns every authed request
 *     into a table scan on api_keys and turns a uniqueness trust
 *     assumption into a "whichever row D1 returns first" silent bug.
 *
 *   - A future PR could also flip CREATE UNIQUE INDEX to CREATE INDEX
 *     in 0000_init.sql without touching schema.ts (or vice versa).
 *     That's a regression this test catches via the uniqueness flag
 *     comparison below.
 *
 * Why text parsing instead of drizzle's getTableConfig():
 *   - packages/relaycron depends on drizzle-orm@^0.38.0 while the
 *     repo root has drizzle-orm@^0.45.1. Loading schema.ts from this
 *     test would resolve drizzle-orm against whichever version got
 *     hoisted, and getTableConfig()'s shape may differ between them.
 *     Pure text parsing of both sources avoids that version mismatch
 *     entirely — at the cost of being slightly less type-safe, which
 *     is acceptable for a drift check that's only looking at index
 *     names and the UNIQUE keyword.
 *
 * Canary assertion first: if either parser returns an empty set (e.g.
 * because a regex broke or a file moved), the canary fails loudly
 * before the bidirectional comparison gets a chance to trivially pass
 * on two empty sets. Future contributors: do NOT "simplify" this by
 * iterating only one side — the bidirectional comparison is what keeps
 * the two sources in sync.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const relaycronRoot = resolve(__dirname, "..", "..", "packages", "relaycron");

function readRelaycron(relPath: string): string {
  return readFileSync(resolve(relaycronRoot, relPath), "utf8");
}

// Parse CREATE (UNIQUE )?INDEX lines out of the init SQL.
const sqlText = readRelaycron("src/db/migrations/0000_init.sql");
const sqlIndexes = new Map<string, { unique: boolean }>();
for (const line of sqlText.split("\n")) {
  const match = /^CREATE (UNIQUE )?INDEX\s+`?([a-z0-9_]+)`?/i.exec(
    line.trim(),
  );
  if (match) {
    sqlIndexes.set(match[2], { unique: Boolean(match[1]) });
  }
}

// Parse index() / uniqueIndex() calls out of schema.ts.
const schemaText = readRelaycron("src/db/schema.ts");
const declaredIndexes = new Map<string, { unique: boolean }>();
const indexCallRegex = /\b(uniqueIndex|index)\s*\(\s*["']([^"']+)["']\s*\)/g;
for (const match of schemaText.matchAll(indexCallRegex)) {
  const [, fnName, indexName] = match;
  declaredIndexes.set(indexName, { unique: fnName === "uniqueIndex" });
}

const EXPECTED_INDEX_COUNT = 6;

describe("relaycron schema/SQL index drift", () => {
  // CANARY — must run first. Without this, an empty `declaredIndexes`
  // Map would trivially pass the bidirectional comparison against an
  // also-empty parse of the SQL, and the test would silently no-op.
  // If you're adding a new index, bump this number.
  it(`parses exactly ${EXPECTED_INDEX_COUNT} indexes from each source (canary)`, () => {
    assert.equal(
      sqlIndexes.size,
      EXPECTED_INDEX_COUNT,
      `expected ${EXPECTED_INDEX_COUNT} CREATE INDEX statements in 0000_init.sql, found ${sqlIndexes.size}`,
    );
    assert.equal(
      declaredIndexes.size,
      EXPECTED_INDEX_COUNT,
      `expected ${EXPECTED_INDEX_COUNT} index()/uniqueIndex() calls in schema.ts, found ${declaredIndexes.size}`,
    );
  });

  it("every SQL index is declared in schema.ts and vice versa", () => {
    const sqlNames = [...sqlIndexes.keys()].sort();
    const declaredNames = [...declaredIndexes.keys()].sort();
    assert.deepEqual(
      declaredNames,
      sqlNames,
      `schema.ts and 0000_init.sql disagree on the set of index names.\n` +
        `  SQL only:      ${sqlNames.filter((n) => !declaredIndexes.has(n)).join(", ") || "(none)"}\n` +
        `  schema.ts only: ${declaredNames.filter((n) => !sqlIndexes.has(n)).join(", ") || "(none)"}`,
    );
  });

  it("uniqueness flags match for every index name", () => {
    for (const [name, { unique: declaredUnique }] of declaredIndexes) {
      const sqlEntry = sqlIndexes.get(name);
      assert.ok(sqlEntry, `index ${name} declared in schema.ts is missing from 0000_init.sql`);
      assert.equal(
        sqlEntry.unique,
        declaredUnique,
        `index ${name}: schema.ts declares unique=${declaredUnique} but 0000_init.sql has unique=${sqlEntry.unique}`,
      );
    }
  });
});
