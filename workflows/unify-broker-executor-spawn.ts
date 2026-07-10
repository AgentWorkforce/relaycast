/**
 * unify-broker-executor-spawn — Make the broker the single spawn path
 * ====================================================================
 *
 * Problem: runner.ts:4038 forks into two completely separate paths:
 *
 *   this.executor ? executor.executeAgentStep()  // cloud — bypasses broker
 *                 : this.spawnAndWait()           // local — broker handles all
 *
 * The executor reimplements MCP wiring, CLI flags, auth — everything the
 * broker already does. This causes drift (new CLIs break in cloud) and
 * duplicates ~200 lines of agent configuration logic.
 *
 * Fix: The cloud should provide a ProcessBackend: "here's how to run a
 * process somewhere." The broker builds the fully-configured command (MCP,
 * flags, env) and calls the backend to execute it.
 *
 * Boundaries:
 *   relay owns:  agent config (MCP, CLI flags, auth env, lifecycle)
 *   cloud owns:  execution environment (create VM, run command, destroy)
 *
 * Operates in a git worktree and opens a PR when all gates pass.
 *
 * Run: agent-relay run workflows/unify-broker-executor-spawn.ts
 */
import { workflow } from '@relayflows/core';

const CHANNEL = 'wf-unify-spawn';
const BRANCH = 'feat/process-backend-interface';
const BASE_BRANCH = 'feat/runtime-adapter-rollout';

async function main() {
  const result = await workflow('unify-broker-executor-spawn')
    .description(
      'Refactor executor into a ProcessBackend — broker owns agent config, cloud owns execution environment',
    )
    .pattern('dag')
    .channel(CHANNEL)
    .maxConcurrency(3)
    .timeout(1_200_000)

    .agent('impl', {
      cli: 'claude',
      role: 'Implements the ProcessBackend interface and refactors the executor',
      retries: 2,
    })

    // ── Phase 0: Set up worktree ─────────────────────────────────────
    .step('setup-worktree', {
      type: 'deterministic',
      command: [
        'WORKTREE_PATH=".worktrees/' + BRANCH + '"',
        'git worktree remove --force "$WORKTREE_PATH" 2>/dev/null || true',
        'git branch -D ' + BRANCH + ' 2>/dev/null || true',
        'git worktree add -b ' + BRANCH + ' "$WORKTREE_PATH" HEAD',
        // Symlink node_modules so the worktree can run tsc/tests without npm install
        'ln -sf "$(pwd)/node_modules" "$WORKTREE_PATH/node_modules"',
        'echo "$WORKTREE_PATH"',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ── Phase 1: Read current state ──────────────────────────────────
    .step('read-executor', {
      type: 'deterministic',
      dependsOn: ['setup-worktree'],
      workdir: '{{steps.setup-worktree.output}}',
      command: 'cat packages/core/src/executor/executor.ts',
      captureOutput: true,
    })

    .step('read-runtime-types', {
      type: 'deterministic',
      dependsOn: ['setup-worktree'],
      workdir: '{{steps.setup-worktree.output}}',
      command: 'cat packages/core/src/runtime/types.ts',
      captureOutput: true,
    })

    .step('read-presets', {
      type: 'deterministic',
      dependsOn: ['setup-worktree'],
      workdir: '{{steps.setup-worktree.output}}',
      command: 'cat packages/core/src/executor/presets.ts',
      captureOutput: true,
    })

    .step('read-credentials', {
      type: 'deterministic',
      dependsOn: ['setup-worktree'],
      workdir: '{{steps.setup-worktree.output}}',
      command: 'cat packages/core/src/auth/credentials.ts',
      captureOutput: true,
    })

    .step('read-tests', {
      type: 'deterministic',
      dependsOn: ['setup-worktree'],
      workdir: '{{steps.setup-worktree.output}}',
      command: 'cat tests/orchestrator/executor.test.ts',
      captureOutput: true,
    })

    .step('read-runner-interface', {
      type: 'deterministic',
      dependsOn: ['setup-worktree'],
      workdir: '{{steps.setup-worktree.output}}',
      command: 'grep -A25 "export interface RunnerStepExecutor" node_modules/@agent-relay/sdk/src/workflows/runner.ts 2>/dev/null || grep -A25 "RunnerStepExecutor" node_modules/@agent-relay/sdk/dist/workflows/runner.d.ts 2>/dev/null || echo "interface not found"',
      captureOutput: true,
    })

    .step('read-worker-rs', {
      type: 'deterministic',
      dependsOn: ['setup-worktree'],
      command: 'sed -n "159,350p" /Users/khaliqgant/Projects/AgentWorkforce/relay/src/worker.rs 2>/dev/null || echo "worker.rs not accessible"',
      captureOutput: true,
    })

    // ── Phase 2: Implement ───────────────────────────────────────────
    .step('implement', {
      agent: 'impl',
      dependsOn: [
        'read-executor', 'read-runtime-types', 'read-presets',
        'read-credentials', 'read-tests', 'read-runner-interface', 'read-worker-rs',
      ],
      workdir: '{{steps.setup-worktree.output}}',
      task: `You need to refactor the cloud executor to separate "where to run" from "how to configure agents."

## Current files

=== packages/core/src/executor/executor.ts ===
{{steps.read-executor.output}}

=== packages/core/src/runtime/types.ts ===
{{steps.read-runtime-types.output}}

=== packages/core/src/executor/presets.ts ===
{{steps.read-presets.output}}

=== packages/core/src/auth/credentials.ts ===
{{steps.read-credentials.output}}

=== tests/orchestrator/executor.test.ts ===
{{steps.read-tests.output}}

=== Current RunnerStepExecutor interface (relay SDK) ===
{{steps.read-runner-interface.output}}

=== Broker spawn logic (Rust — builds commands with MCP, auth, flags) ===
{{steps.read-worker-rs.output}}

## The problem

RunnerStepExecutor.executeAgentStep() is too coarse. It takes the whole step, then the executor reimplements everything the broker does: MCP wiring, CLI flags, auth, command building. This duplicates logic and falls behind when relay adds new CLIs.

## What to do

### Step 1: Add ProcessBackend interface to packages/core/src/runtime/types.ts

Add these to the EXISTING file (keep all existing content):

export interface ProcessBackend {
  createEnvironment(label: string): Promise<ProcessEnvironment>;
}

export interface ProcessEnvironment {
  id: string;
  homeDir: string;
  exec(command: string, opts?: { cwd?: string; env?: Record<string, string>; timeoutSeconds?: number }): Promise<{ output: string; exitCode: number }>;
  uploadFile(content: string | Buffer, remotePath: string): Promise<void>;
  destroy(): Promise<void>;
}

### Step 2: Add createEnvironment to SandboxedStepExecutor

Add a public createEnvironment method that implements ProcessBackend. This method:
- Creates a sandbox via this.createRuntimeHandle()
- Mounts relayfile for code sync
- Mounts CLI credentials for all available providers
- Initializes git in the working directory
- Returns a ProcessEnvironment object with exec/uploadFile/destroy

The ProcessEnvironment.exec() should delegate to this.runtime.exec().
The ProcessEnvironment.uploadFile() should delegate to this.runtime.uploadFile().
The ProcessEnvironment.destroy() should flush relayfile then call this.disposeRuntime().

Use closure over 'this' (assign const self = this before the return) to access private methods.

### Step 3: Mark executeAgentStep for deprecation

Add this comment at the top of executeAgentStep:

// DEPRECATED: This method reimplements broker logic (MCP wiring, CLI flags, auth).
// Use createEnvironment() instead — the broker builds a fully-configured command
// and calls env.exec(). See packages/core/docs/sandbox-provider-design.md.

Do NOT remove executeAgentStep or any of its methods. Keep everything working.

### Step 4: Export the new types

Check if packages/core/src/runtime/index.ts exists. If so, add ProcessBackend and ProcessEnvironment to its exports. If not, they're already exported from types.ts.

### What NOT to change
- Do NOT remove executeAgentStep, executeDeterministicStep, or any existing methods
- Do NOT remove writeOpencodeRelaycastConfig or mountCloudAuthFile (still used)
- Do NOT change presets.ts or the bootstrap script
- Do NOT change test files

After making changes, run:
  npx tsc --noEmit --project packages/core/tsconfig.build.json
  npx tsx --test tests/orchestrator/executor.test.ts

IMPORTANT: Write all changes to disk in the worktree. Do NOT just output code.`,
      verification: { type: 'exit_code' },
    })

    // ── Phase 2b: Verify edits ───────────────────────────────────────
    .step('verify-edits', {
      type: 'deterministic',
      dependsOn: ['implement'],
      workdir: '{{steps.setup-worktree.output}}',
      command: [
        'set -e',
        'if git diff --quiet packages/core/src/runtime/types.ts; then echo "types.ts NOT MODIFIED"; exit 1; fi',
        'grep -q "ProcessBackend" packages/core/src/runtime/types.ts || (echo "MISSING: ProcessBackend"; exit 1)',
        'grep -q "ProcessEnvironment" packages/core/src/runtime/types.ts || (echo "MISSING: ProcessEnvironment"; exit 1)',
        'grep -q "createEnvironment" packages/core/src/executor/executor.ts || (echo "MISSING: createEnvironment"; exit 1)',
        'grep -q "DEPRECATED" packages/core/src/executor/executor.ts || (echo "MISSING: deprecation comment"; exit 1)',
        'echo "All expected changes verified"',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ── Phase 3: Test-fix-rerun ──────────────────────────────────────
    .step('run-tests', {
      type: 'deterministic',
      dependsOn: ['verify-edits'],
      workdir: '{{steps.setup-worktree.output}}',
      command: 'npx tsx --test tests/orchestrator/executor.test.ts 2>&1 | tail -60',
      captureOutput: true,
      failOnError: false,
    })

    .step('typecheck', {
      type: 'deterministic',
      dependsOn: ['verify-edits'],
      workdir: '{{steps.setup-worktree.output}}',
      command: 'npx tsc --noEmit --project packages/core/tsconfig.build.json 2>&1 | tail -40',
      captureOutput: true,
      failOnError: false,
    })

    .step('fix-failures', {
      agent: 'impl',
      dependsOn: ['run-tests', 'typecheck'],
      workdir: '{{steps.setup-worktree.output}}',
      task: `Fix any test or typecheck failures.

Test output:
{{steps.run-tests.output}}

Typecheck output:
{{steps.typecheck.output}}

If all passed, do nothing.
If failures, read the failing files, fix, re-run until both pass:
  npx tsc --noEmit --project packages/core/tsconfig.build.json
  npx tsx --test tests/orchestrator/executor.test.ts`,
      verification: { type: 'exit_code' },
    })

    .step('run-tests-final', {
      type: 'deterministic',
      dependsOn: ['fix-failures'],
      workdir: '{{steps.setup-worktree.output}}',
      command: 'npx tsx --test tests/orchestrator/executor.test.ts 2>&1',
      captureOutput: true,
      failOnError: true,
    })

    .step('typecheck-final', {
      type: 'deterministic',
      dependsOn: ['fix-failures'],
      workdir: '{{steps.setup-worktree.output}}',
      command: 'npx tsc --noEmit --project packages/core/tsconfig.build.json 2>&1',
      captureOutput: true,
      failOnError: true,
    })

    // ── Phase 4: Regression ──────────────────────────────────────────
    .step('regression', {
      type: 'deterministic',
      dependsOn: ['run-tests-final', 'typecheck-final'],
      workdir: '{{steps.setup-worktree.output}}',
      command: 'npx tsx --test tests/orchestrator/*.test.ts 2>&1 | tail -40',
      captureOutput: true,
      failOnError: false,
    })

    .step('fix-regressions', {
      agent: 'impl',
      dependsOn: ['regression'],
      workdir: '{{steps.setup-worktree.output}}',
      task: `Fix any regressions. Output:
{{steps.regression.output}}

If all passed, do nothing. Otherwise fix and re-run:
  npx tsx --test tests/orchestrator/*.test.ts`,
      verification: { type: 'exit_code' },
    })

    .step('regression-gate', {
      type: 'deterministic',
      dependsOn: ['fix-regressions'],
      workdir: '{{steps.setup-worktree.output}}',
      command: 'npx tsx --test tests/orchestrator/*.test.ts 2>&1',
      captureOutput: true,
      failOnError: true,
    })

    // ── Phase 5: Commit + push + PR ──────────────────────────────────
    .step('commit', {
      type: 'deterministic',
      dependsOn: ['regression-gate'],
      workdir: '{{steps.setup-worktree.output}}',
      command: 'git add packages/core/src/runtime/types.ts packages/core/src/executor/executor.ts && git add -u packages/core/src/runtime/ packages/core/src/executor/ 2>/dev/null; git diff --cached --quiet && echo "NO CHANGES TO COMMIT" && exit 1; git commit -m "feat(executor): add ProcessBackend interface for broker-delegated sandbox execution" && git push origin ' + BRANCH,
      captureOutput: true,
      failOnError: true,
    })

    .step('open-pr', {
      type: 'deterministic',
      dependsOn: ['commit'],
      command: 'gh pr create --repo AgentWorkforce/cloud --base ' + BASE_BRANCH + ' --head ' + BRANCH + ' --title "feat(executor): add ProcessBackend interface" --body-file - <<\'PRBODY\'\n## Summary\n\n- Adds ProcessBackend and ProcessEnvironment interfaces to runtime/types.ts\n- SandboxedStepExecutor implements createEnvironment() returning a ProcessEnvironment\n- Clean boundary: relay owns agent config, cloud owns execution environment\n- executeAgentStep preserved for backward compat, marked DEPRECATED\n\n## Boundary\n\n| Relay owns | Cloud owns |\n|---|---|\n| MCP wiring | Create sandbox |\n| CLI flags | Run command |\n| Auth env | Upload files |\n| Agent lifecycle | Destroy sandbox |\n\n## Test plan\n\n- [x] TypeScript typecheck passes\n- [x] Existing executor tests pass\n- [x] Full orchestrator regression suite passes\nPRBODY',
      captureOutput: true,
      failOnError: true,
    })

    .onError('retry', { maxRetries: 2, retryDelayMs: 10_000 })
    .run({ cwd: process.cwd() });

  console.log(`Run status: ${result.status}`);
  if (result.status !== 'completed') {
    process.exit(1);
  }
}

main().catch(console.error);
