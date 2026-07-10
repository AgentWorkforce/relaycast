import { describe, expect, it } from "vitest";
import { parse } from "acorn";

import { collectHelperScope, evaluateHelperValue, HelperEvalError } from "./persona-helper-eval";

type AstNode = { type: string; [key: string]: unknown };

// Parse a standalone expression (e.g. an agent's `schedules` array literal) into
// the acorn node the resolver would hand to evaluateHelperValue.
function parseExpr(source: string): AstNode {
  const ast = parse(`const __v = (${source});`, { ecmaVersion: 2024, sourceType: "module" }) as unknown as AstNode;
  const declaration = (ast.body as AstNode[]).find((node) => node.type === "VariableDeclaration") as AstNode;
  return ((declaration.declarations as AstNode[])[0]!.init as AstNode);
}

// The exact helper the watchdog customer-success personas use (TypeScript).
const WEEKDAYS_AT_SOURCE = `
const OSLO = 'Europe/Oslo';

function weekdaysAt(name: string, at: string | string[], tz: string = OSLO) {
  const times = (Array.isArray(at) ? at : [at]).map((t) => t.split(':').map(Number));
  const minute = times[0][1] || 0;
  const hours = times.map(([h]) => h).join(',');
  return { name, cron: \`\${minute} \${hours} * * 1-5\`, tz };
}
`;

describe("persona helper eval — weekdaysAt", () => {
  const scope = collectHelperScope(WEEKDAYS_AT_SOURCE);

  it("collects the helper function and the module const", () => {
    expect(scope.functions.has("weekdaysAt")).toBe(true);
    expect(scope.consts.has("OSLO")).toBe(true);
  });

  it("evaluates a single-time schedule (churn-digest morning)", () => {
    const result = evaluateHelperValue(parseExpr(`weekdaysAt('morning', '09:00')`), scope, "agent.schedules[0]");
    expect(result).toEqual({ name: "morning", cron: "0 9 * * 1-5", tz: "Europe/Oslo" });
  });

  it("evaluates the churn-digest schedules array (morning + evening)", () => {
    const result = evaluateHelperValue(
      parseExpr(`[weekdaysAt('morning', '09:00'), weekdaysAt('evening', '17:00')]`),
      scope,
      "agent.schedules",
    );
    expect(result).toEqual([
      { name: "morning", cron: "0 9 * * 1-5", tz: "Europe/Oslo" },
      { name: "evening", cron: "0 17 * * 1-5", tz: "Europe/Oslo" },
    ]);
  });

  it("evaluates the deadline-watcher single sweep", () => {
    const result = evaluateHelperValue(parseExpr(`[weekdaysAt('sweep', '08:00')]`), scope, "agent.schedules");
    expect(result).toEqual([{ name: "sweep", cron: "0 8 * * 1-5", tz: "Europe/Oslo" }]);
  });

  it("evaluates the linear-reconciler multi-time array argument", () => {
    const result = evaluateHelperValue(
      parseExpr(`[weekdaysAt('reconcile', ['10:00', '14:00', '18:00'])]`),
      scope,
      "agent.schedules",
    );
    expect(result).toEqual([{ name: "reconcile", cron: "0 10,14,18 * * 1-5", tz: "Europe/Oslo" }]);
  });

  it("respects an explicit tz argument over the default", () => {
    const result = evaluateHelperValue(
      parseExpr(`weekdaysAt('morning', '09:00', 'America/New_York')`),
      scope,
      "agent.schedules[0]",
    );
    expect(result).toMatchObject({ tz: "America/New_York" });
  });
});

describe("persona helper eval — safety + limits", () => {
  it("evaluates plain literals/objects/arrays without any helpers", () => {
    expect(evaluateHelperValue(parseExpr(`[{ on: 'pull_request.opened' }]`), { functions: new Map(), consts: new Map() }, "agent.triggers")).toEqual([
      { on: "pull_request.opened" },
    ]);
  });

  it("throws for an unknown identifier rather than reaching a host global", () => {
    const scope = collectHelperScope("");
    expect(() => evaluateHelperValue(parseExpr(`process.env.SECRET`), scope, "agent.x")).toThrow(HelperEvalError);
  });

  it("throws for a call to an undefined helper", () => {
    const scope = collectHelperScope("");
    expect(() => evaluateHelperValue(parseExpr(`mystery(1, 2)`), scope, "agent.x")).toThrow(HelperEvalError);
  });

  it("bounds runaway recursion with the step budget", () => {
    const scope = collectHelperScope(`
      function loop(n) { return loop(n + 1); }
    `);
    expect(() => evaluateHelperValue(parseExpr(`loop(0)`), scope, "agent.x")).toThrow(HelperEvalError);
  });

  it("forbids prototype-chain access", () => {
    const scope = collectHelperScope("");
    expect(() => evaluateHelperValue(parseExpr(`({}).constructor`), scope, "agent.x")).toThrow(HelperEvalError);
  });

  it("forbids reaching the constructor via object destructuring", () => {
    const scope = collectHelperScope(`
      function escape() { const { constructor } = {}; return constructor; }
    `);
    expect(() => evaluateHelperValue(parseExpr(`escape()`), scope, "agent.x")).toThrow(HelperEvalError);
  });

  it("forbids defining a __proto__ property when constructing an object", () => {
    const scope = collectHelperScope("");
    expect(() => evaluateHelperValue(parseExpr(`({ ["__proto__"]: { polluted: true } })`), scope, "agent.x")).toThrow(
      HelperEvalError,
    );
  });

  it("ignores commented-out helper declarations", () => {
    const scope = collectHelperScope(`
      // function weekdaysAt(name) { return { name, cron: 'HACKED' }; }
      /* const OSLO = 'commented-out'; */
      function weekdaysAt(name) { return { name, cron: 'REAL' }; }
    `);
    const result = evaluateHelperValue(parseExpr(`weekdaysAt('x')`), scope, "agent.x") as { cron: string };
    expect(result.cron).toBe("REAL");
  });

  it("does not treat // inside a string literal as a comment", () => {
    const scope = collectHelperScope(`const URL = 'https://example.com/path';`);
    expect(scope.consts.get("URL")).toBeDefined();
    expect(evaluateHelperValue(parseExpr(`URL`), scope, "agent.x")).toBe("https://example.com/path");
  });
});
