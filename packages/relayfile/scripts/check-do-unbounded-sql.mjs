#!/usr/bin/env node
/**
 * Hardening item 3 — CI gate: reject any new `SELECT ... FROM (files|
 * events|operations)` in packages/relayfile/src/durable-objects/** that
 * is NOT followed in the same SQL statement/template by a `LIMIT` clause.
 *
 * Rationale: the WorkspaceDO has a hard ~128MB cap. An unbounded scan of
 * any of these three tables pulls the whole rowset into the isolate and
 * OOMs the DO. Every existing query has a LIMIT after the P0 fix; this
 * gate keeps it that way.
 *
 * The gate is deliberately a lightweight scanner over the SQL
 * template-literal shape rather than a full SQL parser. If you genuinely
 * need an unbounded read (e.g. a one-shot count), use COUNT(*) — that's
 * structurally bounded.
 *
 * Run via:  node scripts/check-do-unbounded-sql.mjs
 * Exits non-zero on any finding.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../src/durable-objects/", import.meta.url));
const TABLES = ["files", "events", "operations"];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...walk(full));
    } else if (full.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

let failures = 0;
function statementSlice(text, fromIndex) {
  const selectStart = text.lastIndexOf("SELECT", fromIndex);
  const priorBoundary = Math.max(
    text.lastIndexOf("`", fromIndex - 1),
    text.lastIndexOf(";", fromIndex - 1),
  );
  if (selectStart === -1 || selectStart < priorBoundary) {
    return null;
  }
  const lineStart = text.lastIndexOf("\n", fromIndex) + 1;
  const linePrefix = text.slice(lineStart, fromIndex);
  if (/^\s*(?:\*|\/\/)/.test(linePrefix)) {
    return null;
  }
  const sliceStart = selectStart;
  const candidates = ["`", ";"]
    .map((ch) => text.indexOf(ch, fromIndex))
    .filter((idx) => idx !== -1);
  const sliceEnd =
    candidates.length > 0 ? Math.min(...candidates) : text.length;
  return text.slice(sliceStart, sliceEnd);
}

function isTrueSingleRowLookup(stmt) {
  if (!/WHERE\s+(event_id|op_id|path)\s*=\s*\?/i.test(stmt)) {
    return false;
  }
  const where = stmt.slice(stmt.search(/\bWHERE\b/i));
  return !/\bOR\b|[<>]=?/i.test(where);
}

for (const file of walk(ROOT)) {
  const text = readFileSync(file, "utf8");
  for (const table of TABLES) {
    // Locate every `FROM {table}` (or `INTO {table}` for completeness)
    // that begins a SELECT or sub-select. We scan the surrounding ~40
    // lines of context for a LIMIT clause.
    const pattern = new RegExp(`\\bFROM\\s+${table}\\b`, "gi");
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const stmt = statementSlice(text, match.index);
      if (stmt === null) continue;
      if (/\bLIMIT\b/i.test(stmt)) continue;
      // COUNT(*) is structurally bounded — exempt.
      if (/COUNT\s*\(\s*\*\s*\)/i.test(stmt)) continue;
      const localContext = text.slice(
        Math.max(0, match.index - 500),
        match.index + 500,
      );
      // EXISTS / WHERE event_id = ? / WHERE op_id = ? — single-row lookup.
      if (isTrueSingleRowLookup(stmt)) continue;
      // Explicit opt-out marker for the rare case a caller really wants
      // an unbounded read (e.g. seeded from an external cap).
      if (/--\s*(ALLOW UNBOUNDED|KEYSET ITERATOR)/i.test(localContext))
        continue;

      const lineNum = text.slice(0, match.index).split("\n").length;
      failures += 1;
      console.error(
        `[do-unbounded-sql] ${relative(ROOT, file)}:${lineNum}: SELECT ... FROM ${table} without LIMIT`,
      );
    }
  }
}

if (failures > 0) {
  console.error(
    `\n[do-unbounded-sql] ${failures} unbounded SELECT(s) found. Add a LIMIT, use a KeysetCursor, or annotate with \`-- ALLOW UNBOUNDED: <reason>\`.`,
  );
  process.exit(1);
}
console.log(
  "[do-unbounded-sql] OK — no unbounded SELECTs in durable-objects/.",
);
