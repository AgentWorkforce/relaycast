#!/usr/bin/env node
// Checks that Cloud does not contain hand-copied/duplicated implementations
// of @relayfile/sdk classes or types. Every file that reimplements SDK
// transport, error classes, or client types must be explicitly allowed
// (with a plan to eliminate the duplication) or this script exits 1.
//
// Rationale: the canonical SDK lives at packages/sdk/typescript/ in the
// relayfile OSS repo and is published as @relayfile/sdk on npm. Cloud
// must consume it, not fork it. See
// .claude/rules/relayfile-adapter-source-of-truth.md for the broader
// adapter-source-of-truth principle that inspired this check.

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
  "packages",
  "services",
  "tests",
];
const SELF_PATH = "scripts/audit-relayfile-sdk-duplication.mjs";

// Patterns that match DEFINITIONS of SDK classes, functions, or types.
// We match only top-level definitions (lines starting with optional
// whitespace + optional "export") so that consumer imports or test mocks
// inside describe/it blocks do not trigger false positives.
const DEFINITION_PATTERNS = [
  /^\s*(?:export\s+)?class\s+RelayFileClient\b/m,
  /^\s*(?:export\s+)?class\s+RelayFileApiError\b/m,
  /^\s*(?:export\s+)?class\s+RelayfileHttpWriter\b/m,
  /^\s*(?:export\s+)?class\s+RelayfileHttpWriteError\b/m,
  /^\s*(?:export\s+)?function\s+isRelayFileApiError\b/m,
  /^\s*(?:export\s+)?function\s+buildFileUrl\b/m,
  /^\s*(?:export\s+)?function\s+normalizeRelayfileUrl\b/m,
];

// Additional content patterns that strongly indicate a reimplementation.
const CONTENT_PATTERNS = [
  /DEFAULT_RELAYFILE_BASE_URL\s*=\s*["']https:\/\/api\.relayfile\.dev["']/,
  /export\s+(const|let)\s+DEFAULT_RELAYFILE_BASE_URL\s*=/,
];

// Combined match: the file must be a production TS/JS file (not test),
// and match either a definition pattern or a content pattern.
const isTarget = (rel, text) => {
  if (rel.endsWith(SELF_PATH)) return false;
  const isProd = !/\.(?:test|spec)\.(?:ts|tsx|js|mjs)$/.test(rel);
  if (!isProd) return false;
  return (
    DEFINITION_PATTERNS.some((p) => p.test(text)) ||
    CONTENT_PATTERNS.some((p) => p.test(text))
  );
};

// Files that match but are NOT drift — either they are a legitimate
// server-side implementation (not a client SDK copy) or have an audited
// exception. Key: relative path from ROOT. Value: documented reason.
const ALLOWED = new Map([
  [
    "packages/core/src/sync/relayfile-http-writer.ts",
    "CUSTOM HTTP writer — predates SDK reader usage in nango-sync-runtime. Should converge toward @relayfile/sdk.",
  ],
  [
    "packages/core/src/sync/record-writer.ts",
    "CUSTOM RelayfileWriteClient interface — predates SDK. Should converge toward SDK client contract.",
  ],
  [
    "packages/core/src/relayfile/client.ts",
    "TOKEN MINTING client — different concern from SDK transport. Relayauth token minting, not file operations.",
  ],
  [
    "services/agent-gateway/src/expand.ts",
    "URL resolution helper — uses DEFAULT_RELAYFILE_BASE_URL from SDK, not a class reimplementation.",
  ],
  [
    "services/agent-gateway/src/dlq.ts",
    "IMPORTS RelayFileClient from SDK — leftover inline types will be cleaned up.",
  ],
  [
    "services/agent-gateway/src/durable-object.ts",
    "LOCAL isRelayFileApiError type guard — wraps SDK error instances, not a reimplementation.",
  ],
]);

// Track agent-gateway files that have been migrated to @relayfile/sdk but
// may still have inline type definitions that should eventually be imported
// from the SDK. These are not drift — they're convenience types that predate
// SDK exports. Clean them up when the SDK exports the missing types.
const CLEANUP_CANDIDATES = new Set([]);

const findings = [];
for (const root of SCAN_ROOTS) {
  walk(join(ROOT, root), (file) => {
    if (!/\.(?:ts|tsx|js|mjs)$/.test(file)) return;
    const text = readFileSync(file, "utf8");
    const rel = relative(ROOT, file);
    if (!isTarget(rel, text)) return;
    findings.push({ file: rel, allowed: ALLOWED.get(rel) ?? null });
  });
}

const unknown = findings.filter((finding) => !finding.allowed);
if (unknown.length > 0) {
  console.error("Unknown @relayfile/sdk duplication pressure points found:");
  for (const finding of unknown) {
    console.error(`- ${finding.file}`);
  }
  console.error(
    "Import the SDK from @relayfile/sdk instead of reimplementing. " +
    "If this is a false positive, add an explicit audited exception to ALLOWED " +
    "in scripts/audit-relayfile-sdk-duplication.mjs.",
  );
  process.exit(1);
}

console.log("@relayfile/sdk duplication audit passed.");
for (const finding of findings) {
  const label = finding.allowed
    ? `ALLOWED (${finding.allowed})`
    : "UNKNOWN — REMOVE";
  console.log(`- ${finding.file}: ${label}`);
}

const remainingCleanup = findings.filter(
  (f) => CLEANUP_CANDIDATES.has(f.file) && f.allowed,
);
if (remainingCleanup.length > 0) {
  console.log(
    `\n${remainingCleanup.size} cleanup candidate(s) remaining. ` +
    "These import the SDK but still have local types that could be sourced from SDK exports.",
  );
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
