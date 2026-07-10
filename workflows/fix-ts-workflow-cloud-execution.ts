/**
 * Fix: TypeScript workflows should use DaytonaStepExecutor in cloud,
 * not run as standalone scripts.
 *
 * Problem: When a TS workflow is submitted to cloud, the bootstrap runs
 * `npx tsx workflow.ts` which executes the file's own WorkflowRunner
 * with no DaytonaStepExecutor, no relayfile, no cloud infrastructure.
 * All the executor fixes (orchestrator sandbox, relayfile sync, permissions)
 * are bypassed.
 *
 * Fix: For TS workflow files, the bootstrap should:
 *   1. Dynamic-import the file to get the exported `config` object
 *   2. Pass the config through the same WorkflowRunner + DaytonaStepExecutor
 *      path that YAML workflows use
 *   3. Fall back to `npx tsx` execution only if no config is exported
 *
 * This makes TS and YAML workflows execute identically in cloud — same
 * executor, same relayfile, same permissions, same sandboxing.
 *
 * Run from cloud repo root:
 *   agent-relay run workflows/fix-ts-workflow-cloud-execution.ts
 */

import { workflow } from '@relayflows/core';

async function main() {
  const result = await workflow('fix-ts-workflow-cloud-execution')
    .description('Make TS workflows use DaytonaStepExecutor in cloud like YAML does')
    .pattern('dag')
    .channel('wf-fix-ts-cloud')
    .maxConcurrency(4)
    .timeout(1_200_000)

    .agent('lead', {
      cli: 'claude',
      role: 'Review the fix for correctness and edge cases',
      preset: 'lead',
      retries: 1,
    })
    .agent('impl', {
      cli: 'codex',
      role: 'Implement the bootstrap changes',
      preset: 'worker',
      retries: 2,
    })

    // ── Phase 1: Read context ────────────────────────────────────────────

    .step('read-bootstrap', {
      type: 'deterministic',
      command: [
        'echo "=== executeWorkflow function (handles yaml + ts + py) ==="',
        'sed -n "620,670p" packages/core/src/bootstrap/script-generator.ts',
        'echo ""',
        'echo "=== YAML path (the pattern to follow for TS) ==="',
        'sed -n "620,645p" packages/core/src/bootstrap/script-generator.ts',
      ].join(' && '),
      captureOutput: true,
    })

    .step('read-notion-cloud', {
      type: 'deterministic',
      command: [
        'echo "=== Example TS workflow with exported config ==="',
        'head -30 /Users/khaliqgant/Sites/nango-workflows/workflows/notion-cloud.ts 2>/dev/null || echo "file not found"',
        'echo ""',
        'echo "=== hello-world.ts config export pattern ==="',
        'grep -A5 "export const config" workflows/hello-world.ts 2>/dev/null || echo "not found"',
      ].join(' && '),
      captureOutput: true,
    })

    .step('read-tests', {
      type: 'deterministic',
      command: 'cat tests/orchestrator/script-generator.test.ts',
      captureOutput: true,
    })

    // ── Phase 2: Implement ───────────────────────────────────────────────

    .step('implement', {
      agent: 'impl',
      dependsOn: ['read-bootstrap', 'read-notion-cloud'],
      task: `
Fix packages/core/src/bootstrap/script-generator.ts so TypeScript workflows
use the same DaytonaStepExecutor path as YAML workflows.

Context — current executeWorkflow function:
{{steps.read-bootstrap.output}}

Context — example TS workflow with exported config:
{{steps.read-notion-cloud.output}}

## Current behavior

The executeWorkflow function has two paths:
1. YAML: JSON.parse the config → strip permissions → create WorkflowRunner with
   DaytonaStepExecutor → runner.execute(parsedConfig)
2. TS: execFileSync('npx', ['tsx', workflowFile]) — runs the file as a script

The TS path completely bypasses the cloud executor infrastructure.

## Required fix

Change the TypeScript path to:
1. Try to dynamic-import the workflow file and extract the exported config
2. If a config is found, run it through the SAME path as YAML (WorkflowRunner +
   DaytonaStepExecutor)
3. If no config is exported, fall back to the current npx tsx execution

Replace the typescript block (around lines 652-660):

\`\`\`typescript
if (type === 'typescript') {
  // Try to import the TS file and extract its exported config.
  // If it exports a RelayYamlConfig, run it through the cloud executor
  // path (same as YAML). Otherwise fall back to script execution.
  try {
    const mod = await import(workflowFile);
    const tsConfig = mod.config ?? mod.default?.config ?? mod.default;
    if (tsConfig && typeof tsConfig === 'object' && tsConfig.version && tsConfig.swarm) {
      // Strip permissions (same as YAML path)
      if (Array.isArray(tsConfig.agents)) {
        for (const agent of tsConfig.agents) {
          delete agent.permissions;
        }
      }
      const runner = new WorkflowRunner({
        ...(executor ? { executor } : {}),
        cwd: brokerCwd,
        relay: { apiKey: env.RELAY_API_KEY ?? '', binaryArgs },
        workspaceId: env.RELAY_WORKSPACE_ID,
      });
      return runner.execute(tsConfig);
    }
  } catch (importErr) {
    console.log('[bootstrap] Could not import TS config, falling back to script execution:', importErr?.message ?? importErr);
  }

  // Fallback: run as a standalone script
  execFileSync('npx', ['tsx', workflowFile], {
    cwd: codeMountPath,
    env,
    stdio: 'inherit',
    timeout: 30 * 60 * 1000,
  });
  return { status: 'completed' };
}
\`\`\`

IMPORTANT: The binaryArgs variable and the process.env.RELAYFILE_URL /
process.env.RELAYFILE_BASE_URL assignments must happen BEFORE the TS block
(they're currently only in the YAML block). Move these to be shared setup
before the if/else blocks, or duplicate them in the TS path.

Actually, looking at the code more carefully: binaryArgs, process.env.RELAYFILE_URL,
and process.env.RELAYFILE_BASE_URL are set inside the YAML block before the runner
construction. For the TS path to use them, either:
- Move those assignments above the if (type === 'yaml') block so both paths share them
- Or duplicate them in the TS path

Moving them up is cleaner. Move these lines from inside the YAML block to before it:
\`\`\`typescript
const binaryArgs = [];
if (env.RELAY_BROKER_API_PORT) {
  binaryArgs.push('--api-port', env.RELAY_BROKER_API_PORT, '--api-bind', '0.0.0.0');
}
process.env.RELAYFILE_URL = relayfileBaseUrl;
process.env.RELAYFILE_BASE_URL = relayfileBaseUrl;
\`\`\`

## Rules
- Only modify packages/core/src/bootstrap/script-generator.ts
- The YAML path must continue to work unchanged
- The TS config detection must be safe (try/catch, type checks)
- Permissions stripping must happen for TS configs too
- The fallback to npx tsx must remain for TS files without exported configs
      `.trim(),
      verification: { type: 'exit_code' },
    })

    .step('add-test', {
      agent: 'impl',
      dependsOn: ['read-tests', 'implement'],
      task: `
Add a test to tests/orchestrator/script-generator.test.ts verifying that
the generated bootstrap script handles TypeScript workflows with exported configs.

Context — existing tests:
{{steps.read-tests.output}}

Add a test case:
\`\`\`typescript
it("imports TS workflow config and runs through executor path", () => {
  const script = generateBootstrapScript({ fileType: "typescript" });
  assert.ok(script.includes("await import(workflowFile)"));
  assert.ok(script.includes("tsConfig.version && tsConfig.swarm"));
});
\`\`\`

## Rules
- Only modify tests/orchestrator/script-generator.test.ts
- Add one or two test cases — don't change existing tests
- Follow existing test patterns
      `.trim(),
      verification: { type: 'exit_code' },
    })

    // ── Phase 3: Verify ──────────────────────────────────────────────────

    .step('build', {
      type: 'deterministic',
      dependsOn: ['implement', 'add-test'],
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
Review the changes to packages/core/src/bootstrap/script-generator.ts.

Test results: {{steps.test.output}}

Verify:
1. TS workflows with exported config use the same WorkflowRunner + executor path as YAML
2. Config detection is safe (try/catch, checks for version + swarm fields)
3. Permissions are stripped from TS configs
4. binaryArgs, RELAYFILE_URL, RELAYFILE_BASE_URL are available to both paths
5. Fallback to npx tsx still works for TS files without exported configs
6. YAML path is unchanged
7. Python path is unchanged
8. Build and tests pass

If anything is wrong, fix it. State APPROVED or CHANGES_REQUESTED.
      `.trim(),
    })

    .step('final-test', {
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
