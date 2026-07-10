/**
 * Fix: Deterministic steps should run on the orchestrator sandbox, not
 * create child sandboxes.
 *
 * Problem: DaytonaStepExecutor.executeDeterministicStep() creates a new
 * Daytona sandbox for each deterministic step. This is:
 *   - Slow (sandbox creation + relayfile mount + initial sync)
 *   - Fragile (sync timing causes "no such file or directory" errors)
 *   - Wasteful (a whole sandbox just to run `npx nango compile`)
 *
 * Fix: The executor should accept an orchestrator sandbox reference and
 * run deterministic steps directly on it. The orchestrator sandbox already
 * has relayfile mounted at /project with all files synced. Agent steps
 * still get their own sandboxes for isolation.
 *
 * Additionally, replace the `sleep 2` after relayfile-mount start with
 * `relayfile-mount --once` (explicit sync) for agent step sandboxes.
 *
 * Run from cloud repo root:
 *   agent-relay run workflows/fix-executor-deterministic-steps.ts
 */

import { workflow } from '@relayflows/core';

async function main() {
  const result = await workflow('fix-executor-deterministic-steps')
    .description('Run deterministic steps on orchestrator sandbox + fix relayfile sync wait')
    .pattern('dag')
    .channel('wf-fix-executor')
    .maxConcurrency(4)
    .timeout(1_800_000)

    .agent('lead', {
      cli: 'claude',
      role: 'Review architecture and correctness',
      preset: 'lead',
      retries: 1,
    })
    .agent('impl', {
      cli: 'codex',
      role: 'Implement executor changes',
      preset: 'worker',
      retries: 2,
    })
    .agent('impl-bootstrap', {
      cli: 'codex',
      role: 'Update bootstrap to pass orchestrator sandbox',
      preset: 'worker',
      retries: 2,
    })

    // ── Phase 1: Read context ────────────────────────────────────────────

    .step('read-executor', {
      type: 'deterministic',
      command: [
        'echo "=== DaytonaStepExecutor class ==="',
        'cat packages/core/src/executor/executor.ts',
      ].join(' && '),
      captureOutput: true,
    })

    .step('read-bootstrap', {
      type: 'deterministic',
      command: [
        'echo "=== Bootstrap script generator (executor construction + executeWorkflow) ==="',
        'sed -n "580,660p" packages/core/src/bootstrap/script-generator.ts',
      ].join(' && '),
      captureOutput: true,
    })

    .step('read-tests', {
      type: 'deterministic',
      command: [
        'echo "=== Executor tests ==="',
        'cat tests/orchestrator/executor.test.ts 2>/dev/null || echo "no executor tests yet"',
        'echo ""',
        'echo "=== Script generator tests ==="',
        'cat tests/orchestrator/script-generator.test.ts',
      ].join(' && '),
      captureOutput: true,
    })

    // ── Phase 2: Implement ───────────────────────────────────────────────

    .step('fix-executor', {
      agent: 'impl',
      dependsOn: ['read-executor'],
      task: `
Fix packages/core/src/executor/executor.ts with two changes.

Context — full executor file:
{{steps.read-executor.output}}

## Change 1: Add orchestrator sandbox support for deterministic steps

The executor should accept an optional orchestratorSandbox in its constructor
options. When set, executeDeterministicStep should run commands on that sandbox
directly instead of creating a new child sandbox.

Add to the DaytonaStepExecutorOptions interface:
\`\`\`typescript
orchestratorSandbox?: Sandbox;
\`\`\`

Store it as a private field:
\`\`\`typescript
private readonly orchestratorSandbox?: Sandbox;
\`\`\`

In the constructor:
\`\`\`typescript
this.orchestratorSandbox = options.orchestratorSandbox;
\`\`\`

Modify executeDeterministicStep: when this.orchestratorSandbox is set, run the
command directly on it at this.codeMountPath. Skip sandbox creation, relayfile
mount, and sandbox cleanup:

\`\`\`typescript
async executeDeterministicStep(
  step: WorkflowStep,
  resolvedCommand: string,
  stepCwd?: string,
): Promise<{ output: string; exitCode: number }> {
  // If orchestrator sandbox is available, run directly on it
  if (this.orchestratorSandbox) {
    const cwd = stepCwd || this.codeMountPath;
    const result = await this.orchestratorSandbox.process.executeCommand(
      resolvedCommand, cwd
    );
    return {
      output: result.result ?? '',
      exitCode: result.exitCode ?? 0,
    };
  }

  // Fallback: create child sandbox (existing behavior)
  // ... keep existing code ...
}
\`\`\`

## Change 2: Replace sleep 2 with explicit relayfile sync

In startRelayfileMount, replace the hardcoded sleep 2 with a
relayfile-mount --once call that blocks until sync completes:

Replace this:
\`\`\`typescript
const waitResult = await sandbox.process.executeCommand('sleep 2', sandboxHome);
if ((waitResult.exitCode ?? 0) !== 0) {
  throw new Error(\`Failed while waiting for relayfile sync: \${waitResult.result ?? ''}\`);
}
\`\`\`

With this:
\`\`\`typescript
// Run explicit one-time sync instead of arbitrary sleep.
// This blocks until the initial sync completes, ensuring all
// workspace files are available before the step runs.
const syncResult = await sandbox.process.executeCommand(
  [
    'relayfile-mount --once',
    '--base-url', shellEscape(this.relayfileUrl),
    '--workspace', shellEscape(this.relayfileWorkspaceId),
    '--local-dir', shellEscape(this.codeMountPath),
    '--token', shellEscape(relayfileToken),
  ].join(' '),
  sandboxHome,
  undefined,
  60,
);
if ((syncResult.exitCode ?? 0) !== 0) {
  throw new Error(\`Failed initial relayfile sync: \${syncResult.result ?? ''}\`);
}
\`\`\`

## Rules
- Only modify packages/core/src/executor/executor.ts
- Both changes go in the same file
- Don't remove the existing child sandbox path for deterministic steps — keep it as fallback
- Import Sandbox type if needed: import type { Sandbox } from '@daytonaio/sdk'
      `.trim(),
      verification: { type: 'exit_code' },
    })

    .step('fix-bootstrap', {
      agent: 'impl-bootstrap',
      dependsOn: ['read-bootstrap', 'fix-executor'],
      task: `
Update packages/core/src/bootstrap/script-generator.ts to pass the
orchestrator sandbox to the DaytonaStepExecutor.

Context — bootstrap code:
{{steps.read-bootstrap.output}}

## What to change

In the initializeOrchestration function, the bootstrap creates a sandbox
and then constructs the DaytonaStepExecutor. The sandbox variable is
available in scope. Pass it as orchestratorSandbox:

Find the DaytonaStepExecutor construction (around line 592):
\`\`\`typescript
const executor = new DaytonaStepExecutor({
  daytona,
  credentials,
  s3,
  relayfileUrl: relayfileBaseUrl,
  relayfileToken: env.RELAYFILE_TOKEN ?? '',
  relayfileWorkspaceId,
  codeMountPath,
  snapshot: 'relay-orchestrator-v2',
  ...(Object.keys(envSecrets).length > 0 ? { envSecrets } : {}),
});
\`\`\`

Add orchestratorSandbox. The sandbox variable is created earlier in the
initializeOrchestration function — look for it in the scope. It's the
Daytona sandbox that the bootstrap itself runs in. You can access it by
importing the sandbox instance. Since the bootstrap runs inside the sandbox,
the sandbox reference needs to come from the Daytona SDK:

\`\`\`typescript
// The orchestrator sandbox is the current sandbox we're running in.
// For deterministic steps, run commands here instead of creating new sandboxes.
const orchestratorSandbox = await daytona.get(env.DAYTONA_SANDBOX_ID ?? '');

const executor = new DaytonaStepExecutor({
  daytona,
  credentials,
  s3,
  relayfileUrl: relayfileBaseUrl,
  relayfileToken: env.RELAYFILE_TOKEN ?? '',
  relayfileWorkspaceId,
  codeMountPath,
  snapshot: 'relay-orchestrator-v2',
  orchestratorSandbox,
  ...(Object.keys(envSecrets).length > 0 ? { envSecrets } : {}),
});
\`\`\`

Note: DAYTONA_SANDBOX_ID is set automatically by Daytona in the sandbox
environment. Check that env.DAYTONA_SANDBOX_ID exists — if not, the
orchestratorSandbox is undefined and the executor falls back to child
sandboxes.

## Rules
- Only modify packages/core/src/bootstrap/script-generator.ts
- Add the orchestratorSandbox construction before the executor
- Guard against missing DAYTONA_SANDBOX_ID
      `.trim(),
      verification: { type: 'exit_code' },
    })

    // ── Phase 3: Verify ──────────────────────────────────────────────────

    .step('build', {
      type: 'deterministic',
      dependsOn: ['fix-executor', 'fix-bootstrap'],
      command: 'npm run -w @cloud/core build 2>&1 | tail -5',
      failOnError: true,
    })

    .step('test', {
      type: 'deterministic',
      dependsOn: ['build'],
      command: 'npx tsx --test tests/orchestrator/*.test.ts 2>&1 | tail -15',
      failOnError: true,
    })

    // ── Phase 4: Review ──────────────────────────────────────────────────

    .step('review', {
      agent: 'lead',
      dependsOn: ['test'],
      task: `
Review the changes to:
1. packages/core/src/executor/executor.ts
2. packages/core/src/bootstrap/script-generator.ts

Test results: {{steps.test.output}}

Verify:
1. Executor accepts orchestratorSandbox in constructor options
2. executeDeterministicStep runs on orchestratorSandbox when available
3. executeDeterministicStep falls back to child sandbox when not set
4. The orchestrator sandbox path uses this.codeMountPath as cwd
5. sleep 2 is replaced with relayfile-mount --once for agent sandboxes
6. Bootstrap passes orchestratorSandbox from DAYTONA_SANDBOX_ID
7. Missing DAYTONA_SANDBOX_ID is handled gracefully (undefined)
8. Build and tests pass
9. No unrelated changes

If anything is wrong, fix it and re-run:
  npm run -w @cloud/core build && npx tsx --test tests/orchestrator/*.test.ts

State APPROVED or CHANGES_REQUESTED.
      `.trim(),
    })

    .step('final-verify', {
      type: 'deterministic',
      dependsOn: ['review'],
      command: 'npm run -w @cloud/core build && npx tsx --test tests/orchestrator/*.test.ts 2>&1 | tail -10',
      failOnError: true,
    })

    .onError('retry', { maxRetries: 2, retryDelayMs: 10_000 })
    .run({ cwd: process.cwd() });

  console.log(`Done: ${result.status} (${result.id})`);
}

main().catch(console.error);
