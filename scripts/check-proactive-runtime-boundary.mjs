#!/usr/bin/env node
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";

const repoRoot = process.cwd();
const baselinePath = join(repoRoot, "scripts/proactive-runtime-boundary-baseline.json");
const updateBaseline = process.argv.includes("--update-baseline");

const scanRoots = ["packages/web/app", "packages/web/lib"];

const allowedProactiveModules = new Set([
  "agents-md",
  "api",
  "cloudflare-waituntil",
  "current-workspace",
  "dashboard",
  "deploy-auth",
  // Light leaf helper (imports only cloudflare-context + logger) that enqueues a
  // durable delivery-drain job onto WEBHOOK_QUEUE. Safe for cloud-web to import
  // directly (#2530/#2533) — same category as cloudflare-waituntil/service-client.
  "integration-watch-delivery-queue",
  "service-client",
  "spawnable-clis",
  "types",
]);

const movedStepOneRoutes = new Set([
  "packages/web/app/api/internal/proactive-runtime/deployment-tick-deliveries/sweep/route.ts",
  "packages/web/app/api/internal/proactive-runtime/inbox/candidates/route.ts",
  "packages/web/app/api/internal/proactive-runtime/inbox/deliver/route.ts",
  "packages/web/app/api/internal/proactive-runtime/integration-watch-deliveries/sweep/route.ts",
  "packages/web/app/api/internal/proactive-runtime/pr-sandbox/drain/route.ts",
  "packages/web/app/api/internal/proactive-runtime/sandbox-reaper/route.ts",
  "packages/web/app/api/internal/proactive-runtime/vfs-watch/candidates/route.ts",
  "packages/web/app/api/internal/proactive-runtime/vfs-watch/deliver/route.ts",
]);

function readBaseline() {
  if (!existsSync(baselinePath)) {
    return new Set();
  }
  const parsed = JSON.parse(readFileSync(baselinePath, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error("proactive-runtime boundary baseline must be a JSON array");
  }
  return new Set(parsed);
}

function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === "node_modules" ||
      entry.name === ".next" ||
      entry.name.startsWith(".open-next")
    ) {
      continue;
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(path, files);
    } else if (entry.isFile() && /\.(?:ts|tsx|mts|cts)$/u.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

function proactiveModuleName(specifier) {
  const aliasPrefix = "@/lib/proactive-runtime/";
  if (specifier.startsWith(aliasPrefix)) {
    return specifier.slice(aliasPrefix.length).split("/")[0];
  }

  const relativeMarker = "/lib/proactive-runtime/";
  if (specifier.includes(relativeMarker)) {
    return specifier
      .slice(specifier.indexOf(relativeMarker) + relativeMarker.length)
      .split("/")[0];
  }

  return null;
}

const importPatterns = [
  /\b(?:import|export)\b[\s\S]*?\bfrom\s*["']([^"']+)["']/gu,
  /\bimport\s*["']([^"']+)["']/gu,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
];

function collectHeavyImports() {
  const imports = new Map();

  for (const root of scanRoots) {
    const absoluteRoot = join(repoRoot, root);
    try {
      if (!statSync(absoluteRoot).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }

    for (const file of walk(absoluteRoot)) {
      const relativeFile = relative(repoRoot, file);
      if (
        relativeFile.includes("/lib/proactive-runtime/") ||
        /\.(?:test|spec)\.(?:ts|tsx|mts|cts)$/u.test(relativeFile)
      ) {
        continue;
      }

      const source = readFileSync(file, "utf8");
      for (const importPattern of importPatterns) {
        for (const match of source.matchAll(importPattern)) {
          const specifier = match[1] ?? "";
          const moduleName = proactiveModuleName(specifier);
          if (!moduleName || allowedProactiveModules.has(moduleName)) {
            continue;
          }
          const line = source.slice(0, match.index).split("\n").length;
          imports.set(`${relativeFile}|${specifier}`, {
            file: relativeFile,
            line,
            specifier,
          });
        }
      }
    }
  }

  return imports;
}

const heavyImports = collectHeavyImports();
const sortedEdges = [...heavyImports.keys()].sort();

if (updateBaseline) {
  writeFileSync(baselinePath, `${JSON.stringify(sortedEdges, null, 2)}\n`);
  console.log(
    `[proactive-runtime-boundary] Wrote ${sortedEdges.length} legacy import edges to ${relative(repoRoot, baselinePath)}.`,
  );
  process.exit(0);
}

const legacyAllowedImports = readBaseline();
const violations = [];
for (const [edge, detail] of heavyImports) {
  if (!movedStepOneRoutes.has(detail.file) && legacyAllowedImports.has(edge)) {
    continue;
  }
  violations.push(detail);
}

if (violations.length > 0) {
  console.error(
    "[proactive-runtime-boundary] FAIL: cloud-web imports heavy proactive-runtime modules outside the checked legacy baseline",
  );
  for (const violation of violations.sort((a, b) =>
    `${a.file}:${a.line}:${a.specifier}`.localeCompare(
      `${b.file}:${b.line}:${b.specifier}`,
    ),
  )) {
    console.error(
      `  ${violation.file}:${violation.line} imports ${JSON.stringify(violation.specifier)}`,
    );
  }
  process.exit(1);
}

console.log(
  "[proactive-runtime-boundary] PASS: moved routes are clean and no new heavy proactive-runtime imports were added.",
);
