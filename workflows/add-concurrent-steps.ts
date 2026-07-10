/**
 * add-concurrent-steps.ts
 *
 * Adds concurrent agent step support to the workflow system.
 * Enables multiple agents to work on the same codebase simultaneously
 * with relayfile providing the shared filesystem layer.
 *
 * Changes span three repos:
 *   - relay (SDK): new 'concurrent' step type, runner dispatch, completion tracking
 *   - cloud (executor): relayfile-backed sandbox orchestration, mount daemon lifecycle
 *   - relayfile (mount): ensure relayfile-mount binary is available in sandbox snapshots
 *
 * Run: agent-relay run workflows/add-concurrent-steps.ts
 */

import { workflow } from '@relayflows/core';

const RELAY = '/Users/khaliqgant/Projects/AgentWorkforce/relay';
const CLOUD = '/Users/khaliqgant/Projects/AgentWorkforce/cloud';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('add-concurrent-steps')
  .description('Add concurrent agent step type with relayfile shared filesystem')
  .pattern('dag')
  .channel('wf-concurrent-steps')
  .maxConcurrency(4)
  .timeout(3_600_000)

  // ── Agents ──────────────────────────────────────────────────────────

  .agent('sdk-architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design the concurrent step type, SDK types, runner changes',
    cwd: RELAY,
  })
  .agent('sdk-implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement concurrent step type in relay SDK runner',
    cwd: RELAY,
  })
  .agent('executor-architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design the cloud executor changes for relayfile integration',
    cwd: CLOUD,
  })
  .agent('executor-implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement relayfile-backed concurrent execution in cloud',
    cwd: CLOUD,
  })
  .agent('bootstrap-implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Update bootstrap to seed relayfile and start mount daemons',
    cwd: CLOUD,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for concurrent step execution',
    cwd: RELAY,
  })

  // ── Phase 1: Read existing code ────────────────────────────────────

  .step('read-sdk-types', {
    type: 'deterministic',
    command: `cat ${RELAY}/packages/sdk/src/workflows/types.ts`,
    captureOutput: true,
  })

  .step('read-sdk-runner', {
    type: 'deterministic',
    command: `cat ${RELAY}/packages/sdk/src/workflows/runner.ts`,
    captureOutput: true,
  })

  .step('read-sdk-builder', {
    type: 'deterministic',
    command: `cat ${RELAY}/packages/sdk/src/workflows/builder.ts`,
    captureOutput: true,
  })

  .step('read-executor', {
    type: 'deterministic',
    command: `cat ${CLOUD}/packages/core/src/executor/executor.ts`,
    captureOutput: true,
  })

  .step('read-launcher', {
    type: 'deterministic',
    command: `cat ${CLOUD}/packages/core/src/bootstrap/launcher.ts`,
    captureOutput: true,
  })

  .step('read-bootstrap-script', {
    type: 'deterministic',
    command: `cat ${CLOUD}/packages/core/src/bootstrap/script-generator.ts`,
    captureOutput: true,
  })

  .step('read-relayfile-sdk', {
    type: 'deterministic',
    command: `cat ${RELAYFILE}/sdk/relayfile-sdk/src/client.ts && echo "=== TYPES ===" && cat ${RELAYFILE}/sdk/relayfile-sdk/src/types.ts`,
    captureOutput: true,
  })

  .step('read-relayfile-mount', {
    type: 'deterministic',
    command: `cat ${RELAYFILE}/cmd/relayfile-mount/main.go`,
    captureOutput: true,
  })

  .step('read-relayfile-syncer', {
    type: 'deterministic',
    command: `head -100 ${RELAYFILE}/internal/mountsync/syncer.go`,
    captureOutput: true,
  })

  // ── Phase 2: SDK architect designs the concurrent step type ────────

  .step('design-concurrent-step', {
    agent: 'sdk-architect',
    dependsOn: ['read-sdk-types', 'read-sdk-runner', 'read-sdk-builder'],
    task: `Design the concurrent step type for the relay SDK.

Current SDK types:
{{steps.read-sdk-types.output}}

Current runner:
{{steps.read-sdk-runner.output}}

Current builder:
{{steps.read-sdk-builder.output}}

Create a design document at ${RELAY}/docs/concurrent-steps.md with:

1. **Type definitions** — what goes in types.ts:
   - Add 'concurrent' to WorkflowStepType union
   - ConcurrentStepConfig interface:
     \`\`\`typescript
     interface ConcurrentStepConfig {
       agents: string[];              // agents that work simultaneously
       tasks: Record<string, string>; // per-agent task descriptions
       shared: boolean;               // whether agents share filesystem (via relayfile)
       completion: 'all' | 'any';     // when is the step done
       timeout?: number;              // per-agent timeout
     }
     \`\`\`
   - Add concurrent fields to WorkflowStep

2. **Builder API** — how users define concurrent steps:
   \`\`\`typescript
   .step('build-feature', {
     type: 'concurrent',
     agents: ['backend-dev', 'frontend-dev'],
     tasks: {
       'backend-dev': 'Add the API route...',
       'frontend-dev': 'Build the component...',
     },
     shared: true,
     completion: 'all',
   })
   \`\`\`

3. **Runner dispatch** — how the runner executes concurrent steps:
   - Detect concurrent step type
   - If executor has executeConcurrentStep(), delegate to it
   - Otherwise fall back to sequential execution of each agent
   - Wait for completion based on 'all' or 'any' strategy
   - Collect outputs from all agents, merge into step output

4. **StepExecutor interface addition**:
   \`\`\`typescript
   executeConcurrentStep?(
     step: WorkflowStep,
     agents: Map<string, { def: AgentDefinition; resolvedTask: string }>,
     context: { workspaceId?: string; relayfileUrl?: string }
   ): Promise<Map<string, string>>; // agent name -> output
   \`\`\`

5. **Output chaining** — how {{steps.build-feature.output}} works:
   - Combined output from all agents
   - Individual outputs via {{steps.build-feature.output.backend-dev}}

Write the design doc. Be specific about types and interfaces.`,
    verification: { type: 'exit_code' },
  })

  // ── Phase 3: SDK implementation (parallel) ─────────────────────────

  .step('implement-sdk-types', {
    agent: 'sdk-implementer',
    dependsOn: ['design-concurrent-step', 'read-sdk-types'],
    task: `Add the concurrent step type to the relay SDK types.

Design doc:
{{steps.design-concurrent-step.output}}

Current types:
{{steps.read-sdk-types.output}}

Edit ${RELAY}/packages/sdk/src/workflows/types.ts:

1. Add 'concurrent' to WorkflowStepType:
   export type WorkflowStepType = 'agent' | 'deterministic' | 'worktree' | 'concurrent';

2. Add concurrent step fields to WorkflowStep interface:
   // Concurrent step fields
   agents?: string[];
   tasks?: Record<string, string>;
   shared?: boolean;
   completion?: 'all' | 'any';

3. Add to StepExecutor interface:
   executeConcurrentStep?(
     step: WorkflowStep,
     agents: Map<string, { def: AgentDefinition; resolvedTask: string }>,
     context: { workspaceId?: string; relayfileUrl?: string }
   ): Promise<Map<string, string>>;

Only edit types.ts. Write to disk.`,
    verification: { type: 'exit_code' },
  })

  .step('implement-sdk-runner', {
    agent: 'sdk-implementer',
    dependsOn: ['implement-sdk-types', 'read-sdk-runner'],
    task: `Add concurrent step execution to the workflow runner.

Design doc:
{{steps.design-concurrent-step.output}}

Current runner (may have changed from previous step):
Read the file fresh: cat ${RELAY}/packages/sdk/src/workflows/runner.ts

Edit ${RELAY}/packages/sdk/src/workflows/runner.ts:

1. Add isConcurrentStep(step) private method:
   Returns true if step.type === 'concurrent' or (step.agents && step.agents.length > 1)

2. In executeStep() dispatch, add concurrent branch AFTER deterministic, BEFORE agent:
   if (this.isConcurrentStep(step)) {
     return this.executeConcurrentStep(step, ...);
   }

3. Implement private async executeConcurrentStep():
   a. Resolve agent definitions for each agent in step.agents
   b. Interpolate {{steps.X.output}} in each task (step.tasks[agentName])
   c. If this.executor?.executeConcurrentStep exists, delegate:
      const results = await this.executor.executeConcurrentStep(step, agentMap, context);
   d. Otherwise, fall back to sequential execution:
      for each agent, call this.executeAgentStep() sequentially
   e. Combine outputs:
      - step.output = all outputs joined with separator
      - Store per-agent outputs for {{steps.X.output.agentName}} access
   f. Wait strategy:
      - 'all': Promise.all — wait for every agent
      - 'any': Promise.race — first agent to finish completes the step
   g. Emit step:completed with combined output

4. In validateConfig(), validate concurrent steps:
   - Must have 'agents' array with at least 2 entries
   - Each agent in 'agents' must be defined in the workflow agents list
   - Must have 'tasks' record with a key for each agent
   - 'completion' must be 'all' or 'any' (default: 'all')

Only edit runner.ts. Write to disk.`,
    verification: { type: 'exit_code' },
  })

  .step('implement-sdk-builder', {
    agent: 'sdk-implementer',
    dependsOn: ['implement-sdk-types', 'read-sdk-builder'],
    task: `Update the workflow builder to support concurrent step syntax.

Current builder:
{{steps.read-sdk-builder.output}}

The builder's .step() method should already accept the new fields since
WorkflowStep now has agents?, tasks?, shared?, completion?.

Verify by reading the builder and checking if .step() passes through all
WorkflowStep fields. If it filters or validates fields, add the concurrent
ones.

If the builder has a .concurrent() convenience method pattern, add:
  .concurrent(name, config: { agents, tasks, shared?, completion?, dependsOn? })
that creates a step with type: 'concurrent'.

Only edit builder.ts if changes are needed. Write to disk.`,
    verification: { type: 'exit_code' },
  })

  // ── Phase 4: Cloud executor (parallel with SDK) ───────────────────

  .step('design-executor', {
    agent: 'executor-architect',
    dependsOn: ['design-concurrent-step', 'read-executor', 'read-relayfile-sdk', 'read-relayfile-mount'],
    task: `Design how the cloud executor runs concurrent steps with relayfile.

Concurrent step design:
{{steps.design-concurrent-step.output}}

Current executor:
{{steps.read-executor.output}}

Relayfile SDK:
{{steps.read-relayfile-sdk.output}}

Relayfile mount daemon:
{{steps.read-relayfile-mount.output}}

Create a design doc at ${CLOUD}/docs/concurrent-executor.md covering:

1. **Workspace lifecycle**:
   - On workflow start: create relayfile workspace (POST or auto-created on first write)
   - Seed workspace with project files via relayfile bulk write API
   - On workflow end: export final tree as patch, cleanup workspace

2. **Concurrent step execution flow**:
   a. Create N sandboxes (one per agent), each with local /project
   b. Start relayfile-mount daemon in each sandbox:
      relayfile-mount --base-url $RELAYFILE_URL --workspace wf-$RUN_ID --local-dir /project --interval 1s
   c. Wait for initial sync (mount daemon pulls files to local disk)
   d. Launch agent CLIs in parallel (each in their own sandbox)
   e. Mount daemons sync changes bidirectionally as agents work
   f. Wait for completion (all/any strategy)
   g. Final sync to ensure all changes are in relayfile
   h. Collect outputs, cleanup sandboxes

3. **executeConcurrentStep() interface**:
   - Implements the StepExecutor method from the SDK
   - Uses existing createSandbox() but WITHOUT volume mount
   - Adds relayfile-mount as a background process in each sandbox
   - Uses existing runCommand() for agent execution

4. **Config requirements**:
   - RELAYFILE_URL env var (hosted relayfile endpoint)
   - RELAYFILE_JWT_SECRET for minting per-workspace tokens
   - relayfile-mount binary in sandbox snapshot

5. **Fallback for non-relayfile environments**:
   - If RELAYFILE_URL not set, fall back to sequential execution
   - Log warning: "Concurrent steps require relayfile — falling back to sequential"

Write the design doc. Be specific about the sandbox setup and mount daemon lifecycle.`,
    verification: { type: 'exit_code' },
  })

  .step('implement-executor-concurrent', {
    agent: 'executor-implementer',
    dependsOn: ['design-executor', 'implement-sdk-types', 'read-executor'],
    task: `Add executeConcurrentStep() to the DaytonaStepExecutor.

Design doc:
{{steps.design-executor.output}}

Current executor:
{{steps.read-executor.output}}

Edit ${CLOUD}/packages/core/src/executor/executor.ts:

1. Add to DaytonaStepExecutorOptions:
   relayfileUrl?: string;
   relayfileJwtSecret?: string;

2. Implement executeConcurrentStep():

async executeConcurrentStep(
  step: WorkflowStep,
  agents: Map<string, { def: AgentDefinition; resolvedTask: string }>,
  context: { workspaceId?: string; relayfileUrl?: string }
): Promise<Map<string, string>> {
  const relayfileUrl = context.relayfileUrl ?? this.relayfileUrl;
  if (!relayfileUrl) {
    // Fallback: run agents sequentially
    console.warn('[executor] No relayfile URL — running concurrent agents sequentially');
    const results = new Map<string, string>();
    for (const [agentName, { def, resolvedTask }] of agents) {
      const output = await this.executeAgentStep(step, def, resolvedTask);
      results.set(agentName, output);
    }
    return results;
  }

  const workspaceId = 'wf-' + (context.workspaceId ?? this.credentials.runId);
  const token = this.mintRelayfileToken(workspaceId);

  // Create N sandboxes, start mount daemons, run agents in parallel
  const agentEntries = Array.from(agents.entries());
  const promises = agentEntries.map(async ([agentName, { def, resolvedTask }]) => {
    const sandbox = await this.createSandbox(step.name + '-' + agentName);
    try {
      // Start relayfile-mount daemon in background
      await sandbox.process.executeCommand(
        'nohup relayfile-mount' +
        ' --base-url ' + relayfileUrl +
        ' --workspace ' + workspaceId +
        ' --local-dir /project' +
        ' --token ' + token +
        ' --interval 1s' +
        ' > /tmp/relayfile-mount.log 2>&1 &'
      );
      // Wait for initial sync
      await sandbox.process.executeCommand('sleep 3');

      // Run the agent (reuse existing executeAgentStep logic)
      const output = await this.executeAgentStep(step, def, resolvedTask);

      // Final sync — ensure all local changes are pushed
      await sandbox.process.executeCommand('relayfile-mount --once --base-url ' + relayfileUrl + ' --workspace ' + workspaceId + ' --local-dir /project --token ' + token);

      return [agentName, output] as const;
    } finally {
      await this.disposeSandbox(sandbox).catch(() => {});
    }
  });

  const results = new Map<string, string>();
  if (step.completion === 'any') {
    const first = await Promise.race(promises);
    results.set(first[0], first[1]);
  } else {
    const all = await Promise.all(promises);
    for (const [name, output] of all) {
      results.set(name, output);
    }
  }
  return results;
}

3. Add private mintRelayfileToken(workspaceId: string): string method:
   - Create a JWT with { workspace_id, scopes: ['fs:read', 'fs:write'], exp: now + 1h }
   - Sign with this.relayfileJwtSecret

4. Add 'jsonwebtoken' or use a lightweight JWT sign function.

Write all changes to disk.`,
    verification: { type: 'exit_code' },
  })

  // ── Phase 5: Bootstrap updates ─────────────────────────────────────

  .step('implement-bootstrap-relayfile', {
    agent: 'bootstrap-implementer',
    dependsOn: ['design-executor', 'read-launcher', 'read-bootstrap-script'],
    task: `Update the bootstrap and launcher to support relayfile.

Design doc:
{{steps.design-executor.output}}

Current launcher:
{{steps.read-launcher.output}}

Current bootstrap script generator:
{{steps.read-bootstrap-script.output}}

Make these changes:

1. Edit ${CLOUD}/packages/core/src/bootstrap/launcher.ts:
   - Add relayfileUrl to LaunchOptions interface
   - Pass RELAYFILE_URL and RELAYFILE_JWT_SECRET to env vars if provided
   - When relayfileUrl is set AND interactive mode, skip the Daytona volume:
     const needsCodeVolume = !options.relayfileUrl && !interactive && (fileType !== "config" || !!resolvedS3CodeKey);
   - Add relayfile-mount binary check in sandbox (like the deps check)

2. Edit ${CLOUD}/packages/core/src/bootstrap/script-generator.ts:
   - When env.RELAYFILE_URL is set, add to initializeWorkflow():
     - Seed relayfile workspace with project files after code extraction:
       Upload each file in /project to relayfile via HTTP PUT
     - Start relayfile-mount daemon in background for ongoing sync
   - This is for interactive mode only (non-interactive uses the executor directly)

3. Create ${CLOUD}/packages/core/src/relayfile/seed.ts:
   - seedRelayfileWorkspace(relayfileUrl, workspaceId, token, localDir):
     Walk localDir, for each file: PUT to relayfile with content
   - Uses the relayfile REST API directly (no SDK dependency needed)
   - Bulk upload for speed

Write all changes to disk.`,
    verification: { type: 'exit_code' },
  })

  // ── Phase 6: Tests ─────────────────────────────────────────────────

  .step('write-sdk-tests', {
    agent: 'test-writer',
    dependsOn: ['implement-sdk-runner', 'implement-sdk-types'],
    task: `Write tests for the concurrent step type.

Read the current test patterns:
cat ${RELAY}/tests/workflows/*.test.ts 2>/dev/null | head -200
cat ${RELAY}/packages/sdk/src/workflows/__tests__/*.test.ts 2>/dev/null | head -200

Create tests at ${RELAY}/packages/sdk/src/workflows/__tests__/concurrent-step.test.ts:

1. Test type validation:
   - Concurrent step must have agents array with >= 2 entries
   - Each agent in agents must be defined
   - Must have tasks record with key per agent
   - Completion defaults to 'all'

2. Test runner dispatch:
   - isConcurrentStep correctly identifies concurrent steps
   - Falls back to sequential when no executor.executeConcurrentStep

3. Test completion strategies:
   - 'all': waits for all agents
   - 'any': resolves when first agent finishes

4. Test output chaining:
   - Combined output accessible via {{steps.X.output}}
   - Per-agent output via {{steps.X.output.agentName}}

Use node:test and node:assert/strict (match existing test patterns).
Write to disk.`,
    verification: { type: 'exit_code' },
  })

  // ── Phase 7: Verification ─────────────────────────────────────────

  .step('verify-all-files', {
    type: 'deterministic',
    dependsOn: [
      'implement-sdk-runner', 'implement-sdk-builder',
      'implement-executor-concurrent', 'implement-bootstrap-relayfile',
      'write-sdk-tests',
    ],
    command: `echo "=== Relay SDK ===" && cd ${RELAY} && \
grep -q "concurrent" packages/sdk/src/workflows/types.ts && echo "types: OK" || echo "types: MISSING concurrent" && \
grep -q "isConcurrentStep\|executeConcurrentStep" packages/sdk/src/workflows/runner.ts && echo "runner: OK" || echo "runner: MISSING concurrent" && \
echo "" && echo "=== Cloud ===" && cd ${CLOUD} && \
grep -q "executeConcurrentStep" packages/core/src/executor/executor.ts && echo "executor: OK" || echo "executor: MISSING concurrent" && \
grep -q "RELAYFILE_URL\|relayfileUrl" packages/core/src/bootstrap/launcher.ts && echo "launcher: OK" || echo "launcher: MISSING relayfile" && \
echo "" && echo "=== Tests ===" && \
[ -f ${RELAY}/packages/sdk/src/workflows/__tests__/concurrent-step.test.ts ] && echo "tests: OK" || echo "tests: MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  .step('typecheck-relay', {
    type: 'deterministic',
    dependsOn: ['verify-all-files'],
    command: `cd ${RELAY} && npx tsc --noEmit 2>&1 | tail -20; echo "EXIT: $?"`,
    captureOutput: true,
    failOnError: false,
  })

  .step('typecheck-cloud', {
    type: 'deterministic',
    dependsOn: ['verify-all-files'],
    command: `cd ${CLOUD} && npx tsc --noEmit 2>&1 | tail -20; echo "EXIT: $?"`,
    captureOutput: true,
    failOnError: false,
  })

  .step('final-fixes', {
    agent: 'sdk-architect',
    dependsOn: ['typecheck-relay', 'typecheck-cloud'],
    task: `Fix any remaining type errors across both repos.

Relay typecheck:
{{steps.typecheck-relay.output}}

Cloud typecheck:
{{steps.typecheck-cloud.output}}

If both show EXIT: 0, do nothing.
Otherwise read the failing files and fix the type errors.
Run tsc --noEmit again in both repos to verify.`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: CLOUD,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\nConcurrent steps workflow: ${result.status}`);
}

main().catch(console.error);
