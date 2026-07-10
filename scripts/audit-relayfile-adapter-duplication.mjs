#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const IGNORE_DIRS = new Set([
  ".git",
  ".sst",
  ".trajectories",
  "build",
  "dist",
  "node_modules",
]);
const SCAN_ROOTS = [
  "nango-integrations",
  "packages/core/src",
  "packages/web/lib/integrations",
  "packages/cataloging-agent-github/src",
  "packages/cataloging-agent-linear/src",
];
const PATTERNS = [
  /mirror(?:s|ed)?\s+.*@relayfile\/adapter-/i,
  /Keep .*with adapter-/i,
  /Keep .*@relayfile\/adapter-/i,
  /adapter-[a-z-]+\/dist/i,
  /CLOUD-SIDE STAND-IN/i,
  /Local model.*adapter-/i,
];
const ALLOWED = new Map([
  [
    "nango-integrations/github-relay/shared/webhook-events.ts",
    "generated from @relayfile/adapter-github for Nango compiler boundary",
  ],
  [
    "nango-integrations/linear-relay/syncs/helpers.ts",
    "existing Nango compiler-boundary copy of adapter-linear GraphQL fragments; must become generated/imported before extension",
  ],
  [
    "packages/core/src/sync/by-edited-alias-emitter.ts",
    "existing cloud stand-in pending adapter-owned by-edited alias emission",
  ],
  [
    "packages/core/src/sync/record-writer.ts",
    "existing local resolver comments for adapter-version gaps; no new duplicated contracts",
  ],
  [
    "packages/core/src/sync/notion-record-shapes.ts",
    "cloud-owned Notion record-shape source with adapter-notion compatibility comments",
  ],
  [
    "nango-integrations/notion-relay/shared/notion-record-shapes.ts",
    "existing Nango compiler-boundary copy from cloud core; not an adapter source, but still audited for adapter compatibility comments",
  ],
]);

const findings = [];
for (const root of SCAN_ROOTS) {
  walk(join(ROOT, root), (file) => {
    if (!/\.(?:ts|tsx|js|mjs|md)$/.test(file)) return;
    const text = readFileSync(file, "utf8");
    const matched = PATTERNS.some((pattern) => pattern.test(text));
    if (!matched) return;
    const rel = relative(ROOT, file);
    findings.push({ file: rel, allowed: ALLOWED.get(rel) ?? null });
  });
}

const unknown = findings.filter((finding) => !finding.allowed);
if (unknown.length > 0) {
  console.error("Unknown relayfile-adapter duplication pressure points found:");
  for (const finding of unknown) {
    console.error(`- ${finding.file}`);
  }
  console.error("Import the adapter contract, generate from it, or add an explicit audited exception.");
  process.exit(1);
}

console.log("Relayfile adapter duplication audit passed.");
for (const finding of findings) {
  console.log(`- ${finding.file}: ${finding.allowed}`);
}

function walk(dir, visit) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      walk(path, visit);
    } else if (stat.isFile()) {
      visit(path);
    }
  }
}
