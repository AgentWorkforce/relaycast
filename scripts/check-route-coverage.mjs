import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");
const ROUTES_FILE = path.join(ROOT, "packages/web/.next/types/routes.d.ts");
const ROUTES_ROOT = path.join(ROOT, "packages/web/app");
const ACCEPTANCE_ROOT = path.join(ROOT, "packages/acceptance/src");
const ROUTE_COVERAGE_ALLOWLIST = path.join(ROOT, "scripts/route-coverage-allowlist.json");
export const ROUTE_HEADER_REGEX = /^\/\/ @route (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (\/api\/\S+)\s*$/;

function parseArgs(argv) {
  const options = {
    prefixes: [],
    testPrefixes: [],
  };

  for (const arg of argv) {
    if (arg.startsWith("--prefix=")) {
      options.prefixes.push(
        ...arg
          .slice("--prefix=".length)
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      );
    }
    if (arg.startsWith("--tests-prefix=")) {
      options.testPrefixes.push(
        ...arg
          .slice("--tests-prefix=".length)
          .split(",")
          .map((value) => value.trim().replace(/^\.?\/+/, "").replace(/\/+$/, ""))
          .filter(Boolean),
      );
    }
  }

  return options;
}

function readRoutes() {
  // Prefer the generated routes.d.ts (most authoritative — comes from
  // next build) but fall back to walking the filesystem so local
  // dev / pre-build CI invocations don't require a full Next build
  // first. The two should agree in steady state; if they diverge,
  // the build step in CI will catch the drift.
  if (fs.existsSync(ROUTES_FILE)) {
    const content = fs.readFileSync(ROUTES_FILE, "utf8");
    const match = content.match(/type AppRouteHandlerRoutes = ([^\n]+)/);
    if (match) {
      return match[1]
        .split("|")
        .map((route) => route.trim().replace(/^"|"$/g, ""))
        .filter((route) => route.startsWith("/api/"));
    }
  }

  return walkAppRoutes(ROUTES_ROOT);
}

function walkAppRoutes(dir, prefix = "") {
  const routes = [];
  if (!fs.existsSync(dir)) return routes;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip Next.js conventional dirs that aren't route segments.
      if (entry.name === "_components" || entry.name.startsWith("_")) continue;
      routes.push(...walkAppRoutes(fullPath, `${prefix}/${entry.name}`));
      continue;
    }
    if (entry.isFile() && entry.name === "route.ts") {
      const route = prefix || "/";
      if (route.startsWith("/api/")) {
        routes.push(route);
      }
    }
  }
  return routes;
}

function routeToFile(route) {
  return path.join(ROUTES_ROOT, route.replace(/^\/+/, ""), "route.ts");
}

function readRouteMethods(route) {
  const routeFile = routeToFile(route);
  if (!fs.existsSync(routeFile)) {
    throw new Error(`Missing route file for ${route}: ${routeFile}`);
  }

  const content = fs.readFileSync(routeFile, "utf8");
  const methods = new Set();
  const exportedMethodPattern =
    /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b|export\s+const\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g;
  const destructuredExportPattern = /export\s+const\s*\{\s*([^}]+)\s*\}\s*=/g;
  const namedExportPattern = /export\s*\{\s*([^}]+)\s*\}(?:\s*from\s*["'][^"']+["'])?/g;

  for (const match of content.matchAll(exportedMethodPattern)) {
    const method = match[1] ?? match[2];
    if (method) {
      methods.add(method);
    }
  }

  for (const match of content.matchAll(destructuredExportPattern)) {
    collectExportedMethods(match[1], methods);
  }

  for (const match of content.matchAll(namedExportPattern)) {
    collectExportedMethods(match[1], methods);
  }

  if (methods.size === 0) {
    throw new Error(`Could not find exported HTTP methods in ${routeFile}`);
  }

  return [...methods];
}

function collectExportedMethods(list, methods) {
  for (const rawPart of list.split(",")) {
    const part = rawPart.trim();
    if (!part) {
      continue;
    }

    const candidates = part
      .split(/\s+as\s+/i)
      .map((value) => value.trim())
      .filter(Boolean);

    for (const candidate of candidates) {
      if (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(candidate)) {
        methods.add(candidate);
      }
    }
  }
}

function walkFiles(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, acc);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      acc.push(fullPath);
    }
  }
  return acc;
}

function routeTemplateToRegex(route) {
  const escaped = route
    .split("/")
    .map((segment) => {
      if (segment.startsWith("[") && segment.endsWith("]")) {
        return "[^/]+";
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");

  return new RegExp(`^${escaped}$`);
}

function normalizeRoute(candidate, templates) {
  const clean = candidate.split("?")[0];
  if (templates.includes(clean)) {
    return clean;
  }

  const matched = templates.find((template) => routeTemplateToRegex(template).test(clean));
  return matched ?? clean;
}

function readAllowlist() {
  if (!fs.existsSync(ROUTE_COVERAGE_ALLOWLIST)) {
    return new Set();
  }

  const parsed = JSON.parse(fs.readFileSync(ROUTE_COVERAGE_ALLOWLIST, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error(`${ROUTE_COVERAGE_ALLOWLIST} must contain a JSON array.`);
  }

  return new Set(
    parsed.map((entry, index) => {
      if (!entry || typeof entry !== "object") {
        throw new Error(`Allowlist entry ${index} must be an object.`);
      }
      if (typeof entry.route !== "string" || typeof entry.method !== "string") {
        throw new Error(`Allowlist entry ${index} requires route and method strings.`);
      }
      if (typeof entry.reason !== "string" || entry.reason.trim().length === 0) {
        throw new Error(`Allowlist entry ${index} requires a non-empty reason.`);
      }
      if (typeof entry.issue !== "string" || entry.issue.trim().length === 0) {
        throw new Error(
          `Allowlist entry ${index} (route=${entry.route}) requires a non-empty "issue" — a tracking reference (e.g. "#633" or a full GitHub issue URL). This keeps deferred coverage honest.`,
        );
      }
      return `${entry.method.toUpperCase()} ${entry.route}`;
    }),
  );
}

function headerBlock(content) {
  const lines = content.split(/\r?\n/);
  const block = [];
  let seenRouteHeader = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      if (seenRouteHeader) {
        block.push(line);
        continue;
      }
      block.push(line);
      continue;
    }
    if (trimmed.startsWith("//")) {
      block.push(line);
      if (ROUTE_HEADER_REGEX.test(trimmed)) {
        seenRouteHeader = true;
      }
      continue;
    }
    break;
  }

  return block.join("\n");
}

function collectCoveredRoutes(testFiles, templates) {
  const covered = new Set();
  const missingHeaders = [];

  for (const testFile of testFiles) {
    const content = fs.readFileSync(testFile, "utf8");
    const block = headerBlock(content);
    const matches = [...block.matchAll(new RegExp(ROUTE_HEADER_REGEX, "gm"))];

    if (matches.length === 0) {
      missingHeaders.push(path.relative(ROOT, testFile));
      continue;
    }

    for (const match of matches) {
      const method = match[1];
      const route = normalizeRoute(match[2], templates);
      covered.add(`${method} ${route}`);
    }
  }

  return { covered, missingHeaders };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const allRoutes = readRoutes();
  const scopedRoutes = options.prefixes.length > 0
    ? allRoutes.filter((route) => options.prefixes.some((prefix) => route.startsWith(prefix)))
    : allRoutes;
  const expectedRoutes = scopedRoutes.flatMap((route) =>
    readRouteMethods(route).map((method) => `${method} ${route}`)
  );
  const allowlistedRoutes = readAllowlist();

  const testFiles = walkFiles(ACCEPTANCE_ROOT).filter((file) => {
    if (options.testPrefixes.length === 0) {
      return true;
    }

    const relativePath = path.relative(ACCEPTANCE_ROOT, file);
    return options.testPrefixes.some((prefix) =>
      relativePath === prefix || relativePath.startsWith(`${prefix}${path.sep}`)
    );
  });
  const { covered, missingHeaders } = collectCoveredRoutes(testFiles, scopedRoutes);
  const missingRoutes = expectedRoutes.filter((route) =>
    !covered.has(route) && !allowlistedRoutes.has(route)
  );

  if (missingHeaders.length > 0) {
    console.error("Missing required // @route header comments:");
    for (const file of missingHeaders) {
      console.error(`- ${file}`);
    }
    process.exitCode = 1;
  }

  if (missingRoutes.length === 0 && missingHeaders.length === 0) {
    console.log(`Route coverage OK (${expectedRoutes.length} route-method pairs checked).`);
    return;
  }

  if (missingRoutes.length > 0) {
    console.error("Missing acceptance route coverage:");
  }
  for (const route of missingRoutes) {
    console.error(`- ${route}`);
  }
  if (missingRoutes.length > 0) {
    process.exitCode = 1;
  }
}

main();
