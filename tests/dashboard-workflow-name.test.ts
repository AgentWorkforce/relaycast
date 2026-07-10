/**
 * Tests for `getWorkflowName` — the dashboard's best-effort extraction of a
 * human-readable name from a stored workflow source. The `workflow_runs`
 * table stores the raw workflow text, not a parsed name, so the dashboard
 * has to guess. This file locks in the guessing rules and their priority.
 *
 * Regression context: TS workflows that start with a JSDoc comment and use
 * the `workflow("name")` fluent builder were surfacing `/**` as the name
 * in the dashboard list.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ optionalEnv: () => "" }));

async function loadGetWorkflowName() {
  const moduleUrl = new URL(
    "../packages/web/app/dashboard/_components/dashboard-data.tsx",
    import.meta.url,
  ).href;
  const mod = await import(moduleUrl);
  return mod.getWorkflowName as (run: { workflow: string }) => string;
}

async function getName(workflow: string): Promise<string> {
  const fn = await loadGetWorkflowName();
  return fn({ workflow });
}

describe("getWorkflowName", () => {
  it("honors JSON workflows with a top-level `name` field", async () => {
    const source = JSON.stringify({ name: "my-json-workflow", steps: [] });
    await expect(getName(source)).resolves.toBe("my-json-workflow");
  });

  it("extracts the top-level name from a YAML workflow", async () => {
    const source = `version: "1"
name: yaml-workflow
swarm:
  pattern: dag
agents: []
`;
    await expect(getName(source)).resolves.toBe("yaml-workflow");
  });

  it("extracts the top-level `name:` from a TS exported config object", async () => {
    const source = `/**
 * Tic-tac-toe workflow.
 */
import type { RelayYamlConfig } from "@relayflows/core";

export const config: RelayYamlConfig = {
  version: "1.0",
  name: "tic-tac-toe",
  description: "two agents play",
  agents: [
    { name: "player-x", cli: "claude" },
    { name: "player-o", cli: "claude" },
  ],
};
`;
    await expect(getName(source)).resolves.toBe("tic-tac-toe");
  });

  it("extracts the workflow name from the fluent WorkflowBuilder pattern", async () => {
    // Regression: previously the first non-empty line was `/**` because
    // JSDoc opens the file and `workflow('name')` wasn't recognized.
    const source = `/**
 * Hi — Interactive
 */
import { workflow } from '@relayflows/core';

async function main() {
  const result = await workflow('hi-interactive')
    .description('greet on a channel')
    .pattern('dag')
    .agent('claude-agent', { cli: 'claude' });
  return result;
}
`;
    await expect(getName(source)).resolves.toBe("hi-interactive");
  });

  it.each([
    ["WorkflowBuilder.create", `WorkflowBuilder.create("alpha-flow").run();`, "alpha-flow"],
    ["new WorkflowBuilder(...)", `new WorkflowBuilder("beta-flow").run();`, "beta-flow"],
    ["backtick-quoted", `await workflow(\`delta-flow\`).run();`, "delta-flow"],
  ])("handles builder variant: %s", async (_label, source, expected) => {
    await expect(getName(source)).resolves.toBe(expected);
  });

  it("doesn't match unrelated fluent .name() calls before a real workflow declaration", async () => {
    const source = `const schema = z.object({}).name("schema-name");
const result = workflow("real-workflow").run();
`;
    await expect(getName(source)).resolves.toBe("real-workflow");
  });

  it("falls back to a legacy `const name = ...` declaration", async () => {
    const source = `// legacy style
const name = "legacy-workflow";
export function run() {}
`;
    await expect(getName(source)).resolves.toBe("legacy-workflow");
  });

  it("skips JSDoc / line-comment openers when falling back to first-line heuristic", async () => {
    const source = `/**
 * Doc block at top.
 */
// single-line comment
doSomething();
`;
    // Regression guard for the "/**" dashboard display.
    await expect(getName(source)).resolves.toBe("doSomething();");
  });

  it("skips shell-comment openers too (python/shell fallback)", async () => {
    const source = `#!/usr/bin/env python3
# comment
print("hello")
`;
    await expect(getName(source)).resolves.toBe('print("hello")');
  });

  it("returns `Untitled workflow` when the source is empty or all-comment", async () => {
    await expect(getName("")).resolves.toBe("Untitled workflow");
    await expect(getName("/**\n * only comments\n */")).resolves.toBe(
      "Untitled workflow",
    );
  });

  it("prefers top-level `name:` over per-agent `name:` entries", async () => {
    // Multiple `name:` occurrences in a TS config — the first one
    // (top-level) wins, not a nested agent entry.
    const source = `export const config = {
  name: "outer-workflow",
  agents: [
    { name: "agent-a" },
    { name: "agent-b" },
  ],
};
`;
    await expect(getName(source)).resolves.toBe("outer-workflow");
  });

  it("doesn't match `name:` inside prose comments (anchored to line start)", async () => {
    const source = `// This workflow has an agent name: something
const result = workflow("real-name").run();
`;
    await expect(getName(source)).resolves.toBe("real-name");
  });
});
