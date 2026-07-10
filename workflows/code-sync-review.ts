/**
 * Code-sync review workflow — Codex-driven review of the code-sync module refactor.
 */

import type { RelayYamlConfig } from "@relayflows/core";

export const config: RelayYamlConfig = {
  version: "1.0",
  name: "code-sync-review",
  description: "Codex-driven review of the code-sync module refactor",
  swarm: {
    pattern: "fan-out",
    maxConcurrency: 3,
    timeoutMs: 600_000,
    channel: "code-sync-review",
  },
  agents: [
    {
      name: "lead",
      cli: "claude",
      role: "Coordinates review findings and produces final verdict",
      interactive: false,
    },
    {
      name: "reviewer-architecture",
      cli: "codex",
      role: "Reviews module boundaries, dependency graph, and separation of concerns",
      interactive: false,
    },
    {
      name: "reviewer-correctness",
      cli: "codex",
      role: "Reviews behavioral correctness, error handling, and edge cases",
      interactive: false,
    },
    {
      name: "reviewer-testing",
      cli: "claude",
      role: "Reviews test coverage, test quality, and TDD adherence",
      interactive: false,
    },
  ],
  workflows: [
    {
      name: "review-flow",
      steps: [
        {
          name: "capture-diff",
          type: "deterministic",
          command: "git diff main --stat && echo '---' && git diff main",
          verification: { type: "exit_code", value: "0" },
        },
        {
          name: "prepare-context",
          type: "agent",
          agent: "lead",
          dependsOn: ["capture-diff"],
          task: `
Read the git diff from the previous step. Summarize:
1. Which files were added/modified/deleted
2. The key architectural changes (module split, new types, etc.)
3. Any behavioral changes (codeSync no longer calling initGitBaseline, etc.)

Write your summary to /shared/review-context.md. Output DONE.
          `.trim(),
          verification: { type: "output_contains", value: "DONE" },
        },
        {
          name: "review-architecture",
          type: "agent",
          agent: "reviewer-architecture",
          dependsOn: ["prepare-context"],
          task: `
Review the code-sync module architecture in lib/code-sync/:
1. Verify each module has a single responsibility
2. Check the dependency graph has no cycles (types/errors are leaves)
3. Verify the barrel export (index.ts) re-exports everything needed
4. Check that SandboxLike adapter eliminates all unsafe casts
5. Verify the exec() helper is used consistently (no manual exitCode checks)
6. Check path constants are centralized in types.ts
7. Verify no unused exports or dead code

Rate: PASS or ISSUES with details. Output ARCH_REVIEW_COMPLETE.
          `.trim(),
          verification: { type: "output_contains", value: "ARCH_REVIEW_COMPLETE" },
        },
        {
          name: "review-correctness",
          type: "agent",
          agent: "reviewer-correctness",
          dependsOn: ["prepare-context"],
          task: `
Review the code-sync module for correctness:
1. Verify initGitBaseline runs git init BEFORE git config
2. Verify generatePatch writes diff to sandbox (no unnecessary round-trip)
3. Verify downloadPatch and applyPatch are properly separated
4. Verify downloadAndApplyPatch composes them correctly
5. Check error classes store the right properties
6. Verify exec() throws SandboxCommandError with correct fields
7. Verify syncToSandbox error messages preserved for backward compat
8. Check codeSync() does NOT call initGitBaseline (orchestrator's job)
9. Check for command injection risks in shell commands

Rate: PASS or ISSUES with details. Output CORRECTNESS_REVIEW_COMPLETE.
          `.trim(),
          verification: { type: "output_contains", value: "CORRECTNESS_REVIEW_COMPLETE" },
        },
        {
          name: "review-testing",
          type: "agent",
          agent: "reviewer-testing",
          dependsOn: ["prepare-context"],
          task: `
Review the test suite in tests/code-sync/:
1. Verify all 41 original behaviors are preserved (no lost coverage)
2. Verify new tests cover: error classes, exec helper, downloadPatch, applyPatch
3. Check test isolation (each test file tests one module only)
4. Verify shared helpers are in helpers.ts (no duplication)
5. Check mock sandbox usage is consistent
6. Verify orchestrator tests cover the initGitBaseline composition change
7. Check the package.json test glob matches all test files

Rate: PASS or ISSUES with details. Output TESTING_REVIEW_COMPLETE.
          `.trim(),
          verification: { type: "output_contains", value: "TESTING_REVIEW_COMPLETE" },
        },
        {
          name: "consolidate",
          type: "agent",
          agent: "lead",
          dependsOn: ["review-architecture", "review-correctness", "review-testing"],
          task: `
Read all three review outputs. Produce a consolidated verdict:
1. List all ISSUES found (if any) with severity (critical/major/minor)
2. List all PASS items
3. Overall verdict: APPROVED or CHANGES_REQUESTED

Write to /shared/review-verdict.md. Output DONE.
          `.trim(),
          verification: { type: "output_contains", value: "DONE" },
        },
      ],
    },
  ],
  errorHandling: { strategy: "continue" },
};
