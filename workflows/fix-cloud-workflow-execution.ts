/**
 * Fix cloud workflow execution — three issues blocking end-to-end runs.
 *
 * Issue 1 (cloud): Bootstrap must strip agent permissions from the parsed
 *   workflow config before passing to WorkflowRunner. The cloud launcher
 *   already compiles and seeds ACLs via relayfile — leaving permissions in
 *   the config triggers the SDK provisioner which calls POST /v1/workspaces
 *   on relayfile (a route that doesn't exist).
 *
 * Issue 2 (cloud): Bootstrap must also set RELAYFILE_BASE_URL (not just
 *   RELAYFILE_URL) since the SDK provisioner reads that specific env var.
 *   Already deployed via PR #96 but should be verified.
 *
 * Issue 3 (cloud): The esbuild TS validation in the relay CLI uses
 *   --bundle=false which is not a valid esbuild flag. Fixed in relay PR #698
 *   but the bootstrap script-generator.ts should also handle TS workflow
 *   files properly for cloud submission.
 *
 * Run from cloud repo root:
 *   agent-relay run workflows/fix-cloud-workflow-execution.ts
 */

import { workflow } from '@relayflows/core';

async function main() {
  const result = await workflow('fix-cloud-workflow-execution')
    .description('Fix cloud workflow execution — strip permissions, fix provisioner conflict')
    .pattern('dag')
    .channel('wf-fix-cloud-exec')
    .maxConcurrency(4)
    .timeout(1_800_000)

    .agent('lead', {
      cli: 'claude',
      role: 'Architecture review and coordination',
      preset: 'lead',
      retries: 1,
    })
    .agent('impl-bootstrap', {
      cli: 'codex',
      role: 'Fix the bootstrap script generator',
      preset: 'worker',
      retries: 2,
    })
    .agent('impl-test', {
      cli: 'codex',
      role: 'Update and add tests',
      preset: 'worker',
      retries: 2,
    })

    // ── Phase 1: Read context ────────────────────────────────────────────

    .step('read-bootstrap', {
      type: 'deterministic',
      command: [
        'echo "=== script-generator.ts (executeWorkflow + runner construction) ==="',
        'sed -n "600,650p" packages/core/src/bootstrap/script-generator.ts',
        'echo ""',
        'echo "=== script-generator.ts (collectWorkflowAgentConfigs) ==="',
        'grep -n "collectWorkflowAgentConfigs\\|permissions\\|agent\\.permissions" packages/core/src/bootstrap/script-generator.ts | head -15',
        'echo ""',
        'echo "=== launcher.ts (permission seeding) ==="',
        'grep -n "seedAgentPermissions\\|compileAgentPermissions\\|compiledPermissions" packages/core/src/bootstrap/launcher.ts | head -10',
      ].join(' && '),
      captureOutput: true,
    })

    .step('read-tests', {
      type: 'deterministic',
      command: [
        'echo "=== Existing bootstrap tests ==="',
        'cat tests/orchestrator/script-generator.test.ts | head -100',
        'echo ""',
        'echo "=== Test count ==="',
        'grep -c "it(" tests/orchestrator/script-generator.test.ts || echo "0"',
      ].join(' && '),
      captureOutput: true,
    })

    .step('read-provisioner', {
      type: 'deterministic',
      command: [
        'echo "=== SDK provisioner (what the runner does with permissions) ==="',
        'grep -n "provisionAgents\\|permissions\\|relayfileBaseUrl\\|RELAYFILE_BASE_URL" node_modules/@agent-relay/sdk/dist/workflows/runner.js | head -15',
        'echo ""',
        'echo "=== Provisioner seeder (the failing createWorkspaceIfNeeded) ==="',
        'cat node_modules/@agent-relay/sdk/dist/provisioner/seeder.js 2>/dev/null | grep -n "createWorkspaceIfNeeded\\|v1/workspaces\\|baseUrl" | head -10',
      ].join(' && '),
      captureOutput: true,
    })

    // ── Phase 2: Implement fix ───────────────────────────────────────────

    .step('fix-bootstrap', {
      agent: 'impl-bootstrap',
      dependsOn: ['read-bootstrap', 'read-provisioner'],
      task: `
Fix packages/core/src/bootstrap/script-generator.ts to strip agent permissions
from the parsed workflow config before passing it to WorkflowRunner.execute().

Context — bootstrap code:
{{steps.read-bootstrap.output}}

Context — SDK provisioner behavior:
{{steps.read-provisioner.output}}

## Problem

The cloud launcher already handles permissions correctly:
1. launcher.ts calls compileAgentPermissions() for each agent
2. launcher.ts calls seedAgentPermissions() to write ACLs to relayfile
3. launcher.ts calls provisionAgentAccess() to mint scoped tokens

But the SDK's WorkflowRunner ALSO has a provisioner that runs when it sees
agent.permissions in the config. This provisioner calls POST /v1/workspaces
on relayfile — a route that doesn't exist — causing the workflow to fail.

## Fix

In the executeWorkflow function (around line 607-632), after parsing the
workflow config JSON, strip the permissions field from all agents:

\`\`\`typescript
// Strip agent permissions — the cloud launcher already compiled and
// seeded ACLs via relayfile. Leaving them triggers the SDK provisioner
// which calls POST /v1/workspaces (doesn't exist on relayfile API).
if (Array.isArray(parsedConfig.agents)) {
  for (const agent of parsedConfig.agents) {
    delete agent.permissions;
  }
}
\`\`\`

Add this right after \`const parsedConfig = JSON.parse(workflowText);\` and
before the binaryArgs/runner construction.

## Rules
- Only modify packages/core/src/bootstrap/script-generator.ts
- Add the permission stripping after JSON parse, before runner construction
- Keep the existing RELAYFILE_URL and RELAYFILE_BASE_URL process.env assignments
- Do NOT change any other behavior in the function
      `.trim(),
      verification: { type: 'exit_code' },
    })

    .step('fix-tests', {
      agent: 'impl-test',
      dependsOn: ['read-tests', 'fix-bootstrap'],
      task: `
Update tests/orchestrator/script-generator.test.ts to add a test verifying
that agent permissions are stripped from the parsed config in the generated
bootstrap script.

Context — existing tests:
{{steps.read-tests.output}}

## What to add

Add a new test case in the generateBootstrapScript test suite that verifies
the generated script includes the permission-stripping logic. Specifically:

\`\`\`typescript
it("strips agent permissions from parsed config before runner execution", () => {
  const script = generateBootstrapScript({ fileType: "yaml" });
  assert.ok(script.includes("delete agent.permissions"));
});
\`\`\`

## Rules
- Only modify tests/orchestrator/script-generator.test.ts
- Add one new test case — do not change existing tests
- Follow the existing test patterns (assert.ok with script.includes)
      `.trim(),
      verification: { type: 'exit_code' },
    })

    // ── Phase 3: Verify ──────────────────────────────────────────────────

    .step('build', {
      type: 'deterministic',
      dependsOn: ['fix-bootstrap', 'fix-tests'],
      command: 'npm run -w @cloud/core build 2>&1 | tail -5',
      failOnError: true,
    })

    .step('test', {
      type: 'deterministic',
      dependsOn: ['build'],
      command: 'npx tsx --test tests/orchestrator/script-generator.test.ts 2>&1 | tail -15',
      failOnError: true,
    })

    // ── Phase 4: Review ──────────────────────────────────────────────────

    .step('review', {
      agent: 'lead',
      dependsOn: ['test'],
      task: `
Review the changes to packages/core/src/bootstrap/script-generator.ts and
tests/orchestrator/script-generator.test.ts.

Test results: {{steps.test.output}}

Verify:
1. Agent permissions are stripped after JSON parse, before runner construction
2. The delete loop handles the case where parsedConfig.agents is missing/empty
3. Existing RELAYFILE_URL and RELAYFILE_BASE_URL assignments are untouched
4. The new test correctly validates the permission stripping
5. No other behavior was accidentally changed
6. Build and tests pass

If anything is wrong, fix it and re-run:
  npm run -w @cloud/core build && npx tsx --test tests/orchestrator/script-generator.test.ts

State APPROVED or CHANGES_REQUESTED with reasoning.
      `.trim(),
    })

    .step('final-test', {
      type: 'deterministic',
      dependsOn: ['review'],
      command: 'npm run -w @cloud/core build && npx tsx --test tests/orchestrator/script-generator.test.ts 2>&1 | tail -10',
      failOnError: true,
    })

    .onError('retry', { maxRetries: 2, retryDelayMs: 10_000 })
    .run({ cwd: process.cwd() });

  console.log(`Done: ${result.status} (${result.id})`);
}

main().catch(console.error);
