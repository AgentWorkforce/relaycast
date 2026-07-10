#!/usr/bin/env node
// Guards against the Next.js "You cannot use different slug names for the same
// dynamic path" route-tree build failure.
//
// This is a RUNTIME route-tree error: `next build` / the OpenNext-CF
// deploy-equivalent CI step compile the code fine, but at request time Next.js
// refuses to assemble a route tree that has more than one dynamic segment at the
// SAME path position. When that happens EVERY request 500s — including
// `/api/health` — because the whole tree fails to build. This took all of prod
// down in the `agents/[agentId]` vs `agents/[parentAgentId]` incident (#1688);
// the build-time CI gates did not catch it.
//
// At a given route position Next.js allows at most ONE dynamic segment. This
// static scan groups dynamic segments by URL position and fails the build if any
// position has more than one distinct dynamic segment — covering both the
// different-name case (`[a]` vs `[b]`) and the different-type case
// (`[id]` vs `[...id]`). Route groups `(group)` are URL-transparent, so a
// segment inside one is grouped at the position of its nearest non-group
// ancestor (a conflict can span two different route groups).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_APP_ROOT = path.join(ROOT, "packages/web/app");

// `[x]` -> x ; `[...x]` -> x ; `[[...x]]` -> x. Route groups `(x)` and parallel
// `@slot` segments are NOT dynamic path positions and return null.
export function dynamicSlugName(segment) {
  if (!segment.startsWith("[")) return null;
  const inner = segment
    .replace(/^\[+/, "")
    .replace(/\]+$/, "")
    .replace(/^\.\.\./, "");
  return inner || null;
}

// A route group `(group)` is transparent to the URL — it does not occupy a path
// position, so it must NOT extend the position key (and must never be treated as
// a dynamic segment itself).
function isRouteGroup(segment) {
  return segment.startsWith("(") && segment.endsWith(")");
}

// Walk an app/ directory tree and return, per URL position, the set of distinct
// RAW dynamic segment strings at that position. Keying on the raw string (not
// the normalized name) makes `[id]` vs `[...id]` a detected conflict, not just
// `[a]` vs `[b]`.
export function collectDynamicSegmentsByPosition(appRoot) {
  const byPosition = new Map();

  function walk(dir, position) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (dynamicSlugName(name) !== null) {
        const key = position || ".";
        if (!byPosition.has(key)) byPosition.set(key, new Set());
        byPosition.get(key).add(name);
      }
      // Route groups are URL-transparent → do not extend the position path.
      const childPosition = isRouteGroup(name)
        ? position
        : position
          ? `${position}/${name}`
          : name;
      walk(path.join(dir, name), childPosition);
    }
  }

  walk(appRoot, "");
  return byPosition;
}

export function findSlugConflicts(appRoot) {
  const byPosition = collectDynamicSegmentsByPosition(appRoot);
  const conflicts = [];
  for (const [position, segments] of byPosition) {
    if (segments.size > 1) {
      conflicts.push({ parent: position, segments: [...segments].sort() });
    }
  }
  return { conflicts, positionsScanned: byPosition.size };
}

function main() {
  const appRoot = process.argv[2]
    ? path.resolve(process.argv[2])
    : DEFAULT_APP_ROOT;
  const { conflicts, positionsScanned } = findSlugConflicts(appRoot);

  if (conflicts.length > 0) {
    console.error(
      "✖ Route slug conflict(s) detected — Next.js allows at most ONE dynamic",
    );
    console.error(
      "  segment per path position. This is a RUNTIME route-tree failure that",
    );
    console.error(
      "  500s EVERY request (including /api/health) and is NOT caught by `next build`.\n",
    );
    for (const c of conflicts) {
      console.error(`  CONFLICT at app/${c.parent}/ : ${c.segments.join("  vs  ")}`);
    }
    console.error(
      "\n  Fix: collapse to ONE dynamic segment at each position (rename to share a",
    );
    console.error(
      "  single slug name, mapping back to the semantic name inside the handler).",
    );
    process.exit(1);
  }

  console.log(
    `✓ No route slug conflicts (${positionsScanned} dynamic route positions scanned).`,
  );
}

// Entry-point guard: realpath-compare both sides so main() runs even when the
// script is invoked via a symlinked path (e.g. macOS /tmp -> /private/tmp) or a
// relative argv[1]. A `file://${process.argv[1]}` string compare can silently
// fail to match and skip main() — fatal for a CI gate that MUST actually run.
const invokedDirectly = (() => {
  try {
    return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main();
}
