import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = process.cwd();
const ROUTE_ROOT = path.join(ROOT, "packages/web/app/api");
const HANDLER_ROOT = path.join(ROOT, "packages/web/test/handlers");
const ALLOWLIST_PATH = path.join(ROOT, "scripts/route-coverage-allowlist.json");

const SCOPED_ROUTE_PATTERNS = [
  "/api/internal/cataloging/workspaces/",
  "/api/v1/agents/deploy",
  "/api/v1/agents/provision",
  "/api/v1/github/clone",
  "/api/v1/github/query",
  "/api/v1/integrations/catalog",
  "/api/v1/linear/query",
  "/api/v1/notion/query",
  "/api/v1/proxy/slack",
  "/api/v1/ricky/runs",
  "/api/v1/ricky/runs/[rickyRunId]",
  "/api/v1/ricky/runs/[rickyRunId]/cancel",
  "/api/v1/ricky/runs/[rickyRunId]/gates/[gateId]/resolve",
  "/api/v1/ricky/slack/oauth/start",
  "/api/v1/ricky/slack/oauth/callback",
  "/api/v1/slack/post-message",
  "/api/v1/webhooks/github",
  "/api/v1/webhooks/hookdeck",
  "/api/v1/workflows/callback",
  "/api/v1/workflows/prepare",
  "/api/v1/workflows/run",
  "/api/v1/workflows/runs/[runId]",
  "/api/v1/workflows/runs/[runId]/cancel",
  "/api/v1/workflows/runs/[runId]/events",
  "/api/v1/workflows/schedules",
  "/api/v1/workflows/schedules/[scheduleId]",
  "/api/v1/workflows/schedules/trigger",
  "/api/v1/workspaces",
  "/api/v1/workspaces/create",
  "/api/v1/workspaces/[workspaceId]/deployments/[agentId]",
  "/api/v1/workspaces/[workspaceId]/deployments/[agentId]/usage",
  "/api/v1/workspaces/[workspaceId]/integrations/[provider]/accessible-resources",
  "/api/v1/workspaces/[workspaceId]/integrations/[provider]/metadata",
  "/api/v1/workspaces/[workspaceId]/integrations/[provider]/status",
  "/api/v1/workspaces/[workspaceId]/integrations/github/allowed-repos",
  "/api/v1/workspaces/[workspaceId]/integrations/github/allowed-repos/[owner]/[repo]",
  "/api/v1/workspaces/[workspaceId]/integrations/slack",
  "/api/v1/workspaces/[workspaceId]/join",
  "/api/v1/workspaces/[workspaceId]/memory",
  "/api/v1/workspaces/[workspaceId]/provider-credentials/byok",
  "/api/v1/workspaces/[workspaceId]/provider-credentials/managed",
  "/api/v1/workspaces/[workspaceId]/relayfile/mount-session",
  "/api/v1/workspaces/[workspaceId]/secrets",
  "/api/v1/workspaces/[workspaceId]/secrets/[secretName]",
  "/api/v1/workspaces/[workspaceId]/workflows/run",
  "/api/v1/workspaces/[workspaceId]/workflows/runs/[runId]",
  "/api/waitlist",
] as const;

const SIDE_EFFECT_PATTERNS = [
  "fetch",
  "globalThis.fetch",
  "insert",
  "update",
  "delete",
  "enqueueGithubCloneJob",
  "createRelaycronApiKey",
  "createRelaycronSchedule",
  "updateRelaycronSchedule",
  "deleteRelaycronSchedule",
  "createApiTokenSession",
  "revokeApiTokenSessionById",
  "mintS3Credentials",
  "emit",
  "claimOnceTrigger",
  "createConnectSession",
  "completeRickySlackInstall",
  "notifyRickySlackRunState",
  "replayOp",
] as const;

type StatefulRoute = {
  file: string;
  methods: string[];
  route: string;
};

type AllowlistEntry = {
  route: string;
  method?: string;
  reason: string;
  issue: string;
};

function walkFiles(dir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, acc);
      continue;
    }
    if (entry.isFile()) {
      acc.push(fullPath);
    }
  }
  return acc;
}

function toRoutePath(filePath: string): string {
  return filePath
    .replace(path.join(ROOT, "packages/web/app"), "")
    .replace(/\/route\.ts$/, "") || "/";
}

function inScopedSurface(route: string): boolean {
  return SCOPED_ROUTE_PATTERNS.some((pattern) =>
    pattern.endsWith("/") ? route.startsWith(pattern) : route === pattern,
  );
}

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

function isHttpHandler(node: ts.Node): node is ts.FunctionDeclaration {
  return (
    ts.isFunctionDeclaration(node) &&
    node.name !== undefined &&
    HTTP_METHODS.has(node.name.text) &&
    node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
  );
}

function collectDestructuredHandlerMethods(sourceFile: ts.SourceFile): string[] {
  // Match `export const { POST, GET } = makeHandlers(...)` and
  // `export const POST = makeHandler(...)` — both common patterns where the
  // function declaration is hidden behind a factory.
  const methods = new Set<string>();
  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    if (
      !stmt.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      continue;
    }
    for (const decl of stmt.declarationList.declarations) {
      // export const POST = ...
      if (ts.isIdentifier(decl.name) && HTTP_METHODS.has(decl.name.text)) {
        methods.add(decl.name.text);
      }
      // export const { POST, GET } = ...
      if (ts.isObjectBindingPattern(decl.name)) {
        for (const element of decl.name.elements) {
          if (ts.isIdentifier(element.name) && HTTP_METHODS.has(element.name.text)) {
            methods.add(element.name.text);
          }
        }
      }
    }
  }
  return [...methods];
}

function expressionName(node: ts.CallExpression["expression"]): string | null {
  if (ts.isIdentifier(node)) {
    return node.text;
  }
  if (ts.isPropertyAccessExpression(node)) {
    const left = expressionName(node.expression);
    return left ? `${left}.${node.name.text}` : node.name.text;
  }
  return null;
}

function functionHasSideEffects(fn: ts.FunctionDeclaration): boolean {
  let found = false;

  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(node)) {
      const name = expressionName(node.expression);
      if (name && SIDE_EFFECT_PATTERNS.some((pattern) => name.endsWith(pattern))) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };

  if (fn.body) {
    ts.forEachChild(fn.body, visit);
  }

  return found;
}

function collectStatefulRoutes(): StatefulRoute[] {
  const routes: StatefulRoute[] = [];

  for (const file of walkFiles(ROUTE_ROOT).filter((candidate) => candidate.endsWith("/route.ts"))) {
    const route = toRoutePath(file);
    if (!inScopedSurface(route)) {
      continue;
    }

    const sourceText = fs.readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
    const handlers = sourceFile.statements.filter(isHttpHandler);
    const destructuredMethods = collectDestructuredHandlerMethods(sourceFile);

    const declaredMethods = handlers
      .filter((handler) => handler.name?.text !== "GET" || functionHasSideEffects(handler))
      .map((handler) => handler.name!.text);

    // Destructured exports (e.g. `export const { POST } = createHandlers()`)
    // are assumed stateful — we can't statically prove side-effects through
    // a factory boundary, so default to "this route mutates state and needs
    // a test." Errs on the side of demanding more coverage, which is the
    // whole point of the gate.
    const methods = Array.from(new Set([...declaredMethods, ...destructuredMethods]));

    if (methods.length === 0) {
      continue;
    }

    routes.push({
      file: path.relative(ROOT, file),
      methods,
      route,
    });
  }

  return routes.sort((a, b) => a.route.localeCompare(b.route));
}

/**
 * Recursively collect static-import targets reachable from `entry`, capped
 * at `maxDepth`. Returns absolute paths of every .ts file in the dependency
 * graph (entry included).
 *
 * Detects both:
 *   - static `import ... from "./foo"` / `import "./foo"`
 *   - dynamic `import("./foo")` and `import(routeUrl)` where `routeUrl` is
 *     a const initialized to a string literal in the same file
 *   - bare string literals naming an `api/.../route.ts` path (used by tests
 *     that build a fileURL from a relative string and dynamic-import it)
 */
function collectReachableSources(entry: string, maxDepth = 3): Set<string> {
  const reached = new Set<string>();
  const queue: Array<{ file: string; depth: number }> = [{ file: entry, depth: 0 }];

  while (queue.length > 0) {
    const { file, depth } = queue.shift()!;
    if (reached.has(file)) continue;
    if (!fs.existsSync(file)) continue;
    reached.add(file);
    if (depth >= maxDepth) continue;

    const content = fs.readFileSync(file, "utf8");
    const baseDir = path.dirname(file);

    const candidateSpecs: string[] = [];

    // Static import statements: `import X from "./y"` or `import "./y"`.
    const staticImport = /(?:^|\n)\s*import\s+(?:[^"']*\bfrom\s+)?["']([^"']+)["']/g;
    for (const match of content.matchAll(staticImport)) {
      candidateSpecs.push(match[1]);
    }

    // Dynamic `import("…")` with a string literal argument.
    const dynamicImport = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
    for (const match of content.matchAll(dynamicImport)) {
      candidateSpecs.push(match[1]);
    }

    // Any bare string literal naming a route.ts under packages/web/app/api —
    // catches the `const routeUrl = "../packages/web/app/api/.../route.ts"`
    // pattern used by node:test-era handler tests that build a fileURL and
    // then dynamic-import it.
    const routePathLiteral = /["']([^"']*\bpackages\/web\/app\/api\/[^"']*?route\.ts)["']/g;
    for (const match of content.matchAll(routePathLiteral)) {
      candidateSpecs.push(match[1]);
    }

    for (const spec of candidateSpecs) {
      if (!spec.startsWith(".") && !spec.startsWith("/")) continue;
      let resolved = path.resolve(baseDir, spec);
      if (!resolved.endsWith(".ts") && !resolved.endsWith(".mts") && !resolved.endsWith(".cts")) {
        if (fs.existsSync(resolved + ".ts")) {
          resolved = resolved + ".ts";
        } else if (fs.existsSync(path.join(resolved, "index.ts"))) {
          resolved = path.join(resolved, "index.ts");
        }
      }
      queue.push({ file: resolved, depth: depth + 1 });
    }
  }

  return reached;
}

/**
 * A handler test file genuinely covers a route iff somewhere in its
 * import graph (capped at depth 3) at least one file:
 *  - imports from `vitest` (so the tests actually register with the runner)
 *    OR uses `node:test` describe/it; AND
 *  - imports the route module corresponding to a claimed `@handler` route
 *    (or a deps/types module under the same route directory).
 *
 * Empty placeholders, comment-only files, and tests that load `node:test`
 * suites that vitest can't see all fail this gate.
 */
function evaluateHandlerCoverage(
  testFile: string,
  claimedRoutes: string[],
): { realCoveredRoutes: string[]; reasons: string[] } {
  const reachable = collectReachableSources(testFile);
  const reasons: string[] = [];

  let usesVitest = false;
  for (const file of reachable) {
    if (!fs.existsSync(file)) continue;
    const content = fs.readFileSync(file, "utf8");
    // Match static `from "vitest"`, dynamic `await import("vitest")`, and
    // hybrid suites that gate the vitest import behind a `VITEST_WORKER_ID`
    // check (a pattern used by tests that double as node:test runners).
    if (
      /from\s+["']vitest["']/.test(content) ||
      /import\s*\(\s*["']vitest["']\s*\)/.test(content)
    ) {
      usesVitest = true;
      break;
    }
  }

  if (!usesVitest) {
    reasons.push(
      `${path.relative(ROOT, testFile)}: no transitive import from "vitest" — handler suite uses vitest, node:test suites are invisible to it.`,
    );
    return { realCoveredRoutes: [], reasons };
  }

  const realCovered: string[] = [];
  for (const claimedRoute of claimedRoutes) {
    // Route directory: /api/v1/foo[/[bar]] → packages/web/app/api/v1/foo[/[bar]]
    const routeDir = path.join(ROUTE_ROOT, claimedRoute.replace(/^\/api\//, ""));
    const reachableUnderRoute = [...reachable].some((file) =>
      file.startsWith(routeDir + path.sep) || file === path.join(routeDir, "route.ts"),
    );
    if (reachableUnderRoute) {
      realCovered.push(claimedRoute);
    } else {
      reasons.push(
        `${path.relative(ROOT, testFile)}: claims @handler ${claimedRoute} but no file in its import graph lives under ${path.relative(ROOT, routeDir)}/`,
      );
    }
  }

  return { realCoveredRoutes: realCovered, reasons };
}

function collectCoveredRoutes(): {
  coveredByFile: Map<string, string[]>;
  realCoverage: Set<string>;
  validationReasons: string[];
} {
  const coveredByFile = new Map<string, string[]>();
  const realCoverage = new Set<string>();
  const validationReasons: string[] = [];
  const handlerPattern = /^\s*\/\/\s*@handler\s+(\S+)/gm;

  for (const file of walkFiles(HANDLER_ROOT).filter((candidate) => candidate.endsWith(".test.ts"))) {
    const content = fs.readFileSync(file, "utf8");
    const matches = [...content.matchAll(handlerPattern)].map((match) => match[1]);
    coveredByFile.set(path.relative(ROOT, file), matches);
    const { realCoveredRoutes, reasons } = evaluateHandlerCoverage(file, matches);
    for (const route of realCoveredRoutes) realCoverage.add(route);
    validationReasons.push(...reasons);
  }

  return { coveredByFile, realCoverage, validationReasons };
}

function readAllowlist(): { allowedRoutes: Set<string>; entries: AllowlistEntry[]; errors: string[] } {
  // A route is "allowed" if any allowlist entry names it. Method may be
  // omitted to cover all methods, or specified to allowlist a single
  // method (the gate today is route-level, but storing the method keeps
  // the data honest for tools that want to scope finer).
  const allowedRoutes = new Set<string>();
  const entries: AllowlistEntry[] = [];
  const errors: string[] = [];
  if (!fs.existsSync(ALLOWLIST_PATH)) {
    return { allowedRoutes, entries, errors };
  }
  const parsed = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, "utf8")) as unknown;
  if (!Array.isArray(parsed)) {
    errors.push(`${ALLOWLIST_PATH} must contain a JSON array.`);
    return { allowedRoutes, entries, errors };
  }
  for (const [index, raw] of parsed.entries()) {
    if (typeof raw !== "object" || raw === null) {
      errors.push(`Allowlist entry ${index} must be an object.`);
      continue;
    }
    const entry = raw as Record<string, unknown>;
    if (typeof entry.route !== "string" || entry.route.length === 0) {
      errors.push(`Allowlist entry ${index} requires a non-empty "route" string.`);
      continue;
    }
    if (typeof entry.reason !== "string" || entry.reason.trim().length === 0) {
      errors.push(`Allowlist entry ${index} (route=${entry.route}) requires a non-empty "reason".`);
      continue;
    }
    if (typeof entry.issue !== "string" || entry.issue.trim().length === 0) {
      errors.push(
        `Allowlist entry ${index} (route=${entry.route}) requires a non-empty "issue" (e.g. "#633" or "https://github.com/.../issues/N").`,
      );
      continue;
    }
    const method = typeof entry.method === "string" ? entry.method.toUpperCase() : undefined;
    allowedRoutes.add(entry.route);
    entries.push({
      route: entry.route,
      method,
      reason: entry.reason,
      issue: entry.issue,
    });
  }
  return { allowedRoutes, entries, errors };
}

function main() {
  const statefulRoutes = collectStatefulRoutes();
  const { realCoverage, validationReasons } = collectCoveredRoutes();
  const { allowedRoutes, errors: allowlistErrors } = readAllowlist();

  const missing = statefulRoutes.filter(({ route }) =>
    !realCoverage.has(route) && !allowedRoutes.has(route)
  );

  if (allowlistErrors.length > 0) {
    console.error("Allowlist validation errors:");
    for (const err of allowlistErrors) console.error(`- ${err}`);
    process.exitCode = 1;
  }

  if (validationReasons.length > 0) {
    console.error("Handler-coverage validation warnings (claims that are not backed by real imports + vitest tests):");
    for (const reason of validationReasons) console.error(`- ${reason}`);
    // These are diagnostics, not fatal — fatal only when they cause a
    // route to fall off the covered list AND the route isn't allowlisted.
  }

  if (missing.length === 0 && allowlistErrors.length === 0) {
    console.log(
      `Handler coverage OK (${statefulRoutes.length} stateful routes checked, ${realCoverage.size} real-covered, ${allowedRoutes.size} allowlisted).`,
    );
    return;
  }

  if (missing.length > 0) {
    console.error("Missing layer-1 handler coverage (and no allowlist entry):");
    for (const route of missing) {
      console.error(`- ${route.route} [${route.methods.join(", ")}] (${route.file})`);
    }
    process.exitCode = 1;
  }
}

main();
