const { workflow } = require("@agent-relay/sdk/workflows");

/**
 * Workflow: Make workspace creation idempotent per owner
 *
 * Current: workspace names are globally unique → 409 on duplicate
 * Target: same API key + same name → return existing workspace
 *         different API key + same name → create new (names not globally unique)
 *
 * Files to change:
 *   - packages/server/src/engine/workspace.ts — idempotent createWorkspace
 *   - packages/server/src/db/schema.ts — already done in PR #113
 *   - packages/sdk-typescript/src/relay.ts — update ensureWorkspace
 *   - packages/local/src/main.rs — match server behavior
 *   - openapi.yaml — update 409 → 200 for existing workspace
 *   - README.md — update workspace creation docs
 *   - tests
 */

const RELAYCAST = "/Users/khaliqgant/Projects/AgentWorkforce/relaycast";

async function main() {
const result = await workflow("idempotent-workspace-creation")
  .description("Make workspace creation idempotent per owner — same name returns existing")
  .pattern("dag")
  .channel("wf-idempotent-ws")
  .maxConcurrency(4)
  .timeout(3_600_000)

  .agent("lead", {
    cli: "claude",
    role: "Architect — designs the idempotent behavior",
    preset: "lead",
    retries: 1,
  })
  .agent("impl-server", {
    cli: "codex",
    role: "Implementer — server engine + tests",
    preset: "worker",
    retries: 2,
  })
  .agent("impl-sdk", {
    cli: "codex",
    role: "Implementer — SDK + local server + docs",
    preset: "worker",
    retries: 2,
  })
  .agent("reviewer", {
    cli: "claude",
    role: "Reviewer",
    preset: "reviewer",
    retries: 1,
  })

  // ── Phase 1: Read current code ────────────────────────────────────

  .step("read-engine", {
    type: "deterministic",
    command: `cat ${RELAYCAST}/packages/server/src/engine/workspace.ts`,
    captureOutput: true,
  })

  .step("read-sdk", {
    type: "deterministic",
    command: `grep -A30 "ensureWorkspace\\|createWorkspace" ${RELAYCAST}/packages/sdk-typescript/src/relay.ts | head -60`,
    captureOutput: true,
  })

  .step("read-local-server", {
    type: "deterministic",
    command: `grep -B5 -A15 "workspace_already_exists\\|workspace_name\\|create.*workspace" ${RELAYCAST}/packages/local/src/main.rs | head -50`,
    captureOutput: true,
  })

  .step("read-openapi", {
    type: "deterministic",
    command: `grep -B2 -A10 "409\\|workspace_already_exists\\|Create.*workspace" ${RELAYCAST}/openapi.yaml | head -40`,
    captureOutput: true,
  })

  // ── Phase 2: Plan ─────────────────────────────────────────────────

  .step("plan", {
    agent: "lead",
    dependsOn: ["read-engine", "read-sdk", "read-local-server", "read-openapi"],
    task: `Design idempotent workspace creation for relaycast.

## Current behavior:
Engine: {{steps.read-engine.output}}
SDK: {{steps.read-sdk.output}}
Local: {{steps.read-local-server.output}}
OpenAPI: {{steps.read-openapi.output}}

## Requirements:
1. createWorkspace(db, name) should check if the SAME api_key_hash already
   owns a workspace with that name. If yes, return the existing workspace
   (with its api_key). If no, create new.
2. Different owners CAN have workspaces with the same name.
3. SDK ensureWorkspace should work without relying on 409.
4. Return 200 for existing, 201 for new (to distinguish).
5. Local Rust server should match.
6. Update openapi.yaml and README.md.

Write a file-by-file plan. End with PLAN_COMPLETE.`,
    verification: { type: "output_contains", value: "PLAN_COMPLETE" },
  })

  // ── Phase 3: Implement server ─────────────────────────────────────

  .step("impl-engine", {
    agent: "impl-server",
    dependsOn: ["plan"],
    task: `Edit packages/server/src/engine/workspace.ts in ${RELAYCAST}.

Change createWorkspace to be idempotent per owner:
1. Accept apiKeyHash as a parameter (or derive it from context)
2. Before insert, query: SELECT * FROM workspaces WHERE name = ? AND api_key_hash = ?
3. If found, return the existing workspace (don't throw)
4. If not found, insert new workspace as before
5. Return { workspace, created: boolean } so the route can return 200 vs 201

Keep the function signature backward-compatible.
Only edit workspace.ts.`,
    verification: { type: "exit_code" },
  })

  .step("impl-route", {
    agent: "impl-server",
    dependsOn: ["impl-engine"],
    task: `Edit packages/server/src/routes/workspace.ts in ${RELAYCAST}.

Update the POST /workspaces route handler:
1. Use the new createWorkspace return value to determine status code
2. Return 201 for new workspaces, 200 for existing (idempotent)
3. Both return the same response shape

Only edit the route file.`,
    verification: { type: "exit_code" },
  })

  // ── Phase 4: Implement SDK + docs (parallel) ─────────────────────

  .step("impl-sdk-update", {
    agent: "impl-sdk",
    dependsOn: ["plan"],
    task: `Edit packages/sdk-typescript/src/relay.ts in ${RELAYCAST}.

Simplify ensureWorkspace:
- createWorkspace now returns existing workspace if same name+owner
- ensureWorkspace can just call createWorkspace directly
- Remove the 409 catch + lookupWorkspace fallback
- Keep the existed: boolean in the response (check HTTP status 200 vs 201)

Only edit relay.ts.`,
    verification: { type: "exit_code" },
  })

  .step("impl-openapi", {
    agent: "impl-sdk",
    dependsOn: ["impl-sdk-update"],
    task: `Edit openapi.yaml in ${RELAYCAST}.

Update POST /v1/workspaces:
1. Add 200 response: "Existing workspace returned (idempotent)"
2. Keep 201 response: "Workspace created"
3. Remove 409 response (no longer returned)
4. Update description to explain idempotent behavior

Only edit openapi.yaml.`,
    verification: { type: "exit_code" },
  })

  .step("impl-readme", {
    agent: "impl-sdk",
    dependsOn: ["impl-openapi"],
    task: `Edit README.md in ${RELAYCAST}.

Update workspace creation docs:
1. Remove "names must be unique" text
2. Document idempotent behavior: same name + same API key = returns existing
3. Update ensureWorkspace docs if referenced

Only edit README.md.`,
    verification: { type: "exit_code" },
  })

  // ── Phase 5: Local server ─────────────────────────────────────────

  .step("impl-local", {
    agent: "impl-server",
    dependsOn: ["impl-route"],
    task: `Edit packages/local/src/main.rs in ${RELAYCAST}.

Find the workspace creation handler that checks for duplicate names
and returns workspace_already_exists. Change it to match the server:
1. If same name exists for same API key, return existing workspace
2. If different API key, allow duplicate name
3. Return 200 for existing, 201 for new

Only edit main.rs.`,
    verification: { type: "exit_code" },
  })

  // ── Phase 6: Tests ────────────────────────────────────────────────

  .step("run-tests", {
    type: "deterministic",
    dependsOn: ["impl-engine", "impl-route", "impl-sdk-update", "impl-local"],
    command: `cd ${RELAYCAST} && npm test 2>&1 | tail -30`,
    captureOutput: true,
    failOnError: false,
  })

  .step("fix-tests", {
    agent: "impl-server",
    dependsOn: ["run-tests"],
    task: `Fix any failing tests in ${RELAYCAST}.

Test results: {{steps.run-tests.output}}

If tests fail, fix them. The key behavioral change:
- Creating a workspace with the same name no longer throws 409
- It returns the existing workspace with 200

Update test assertions accordingly. Run npm test after.`,
    verification: { type: "exit_code" },
  })

  // ── Phase 7: Review ───────────────────────────────────────────────

  .step("read-changes", {
    type: "deterministic",
    dependsOn: ["fix-tests", "impl-readme"],
    command: `cd ${RELAYCAST} && git diff --stat && echo "===DIFF===" && git diff`,
    captureOutput: true,
  })

  .step("review", {
    agent: "reviewer",
    dependsOn: ["read-changes"],
    task: `Review the idempotent workspace creation changes.

{{steps.read-changes.output}}

Checklist:
1. createWorkspace returns existing for same name+owner
2. Different owners can have same workspace name
3. HTTP 200 for existing, 201 for new
4. SDK ensureWorkspace simplified (no 409 dependency)
5. Local Rust server matches
6. openapi.yaml updated (409 removed, 200 added)
7. README updated
8. Tests pass

End with REVIEW_PASS or REVIEW_NEEDS_FIXES.`,
    verification: { type: "exit_code" },
  })

  // ── Phase 8: Fix + Commit ─────────────────────────────────────────

  .step("apply-fixes", {
    agent: "impl-server",
    dependsOn: ["review"],
    task: `Apply any review fixes in ${RELAYCAST}.

Review: {{steps.review.output}}

If fixes needed, apply them. Then run npm test.`,
    verification: { type: "exit_code" },
  })

  .step("commit", {
    type: "deterministic",
    dependsOn: ["apply-fixes"],
    command: [
      `cd ${RELAYCAST}`,
      "git checkout -b feat/idempotent-workspace-creation",
      "git add -A",
      'git commit -m "feat: idempotent workspace creation — same name+owner returns existing\n\nSame API key + same name returns existing workspace (200).\nDifferent API keys can share workspace names.\nRemoves global name uniqueness constraint.\nUpdates SDK, local server, openapi.yaml, and README."',
    ].join(" && "),
    failOnError: true,
  })

  .onError("retry", { maxRetries: 2, retryDelayMs: 10_000 })
  .run({ cwd: RELAYCAST });

console.log("Result:", result.status);
}

main().catch(console.error);
