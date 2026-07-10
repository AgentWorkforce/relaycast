/**
 * fix-opencode-cloud-executor — Wire opencode MCP + cloud auth in per-agent sandboxes
 * =====================================================================================
 *
 * Follows the 80-to-100 pattern: implement → verify edits landed → run tests →
 * fix failures → rerun tests (hard gate) → regression check → commit.
 *
 * Fixes two issues that prevent opencode agents from working in cloud:
 *
 * 1. **Executor MCP wiring** — SandboxedStepExecutor must write opencode.json
 *    with relaycast MCP config and pass --agent relaycast. The broker does this
 *    locally but the executor path bypasses the broker entirely.
 *
 * 2. **Cloud auth mount** — Fresh per-agent sandboxes lack cloud-auth.json,
 *    causing the relay cloud login flow to hang on browser login.
 *
 * Run: agent-relay run workflows/fix-opencode-cloud-executor.ts
 */
import { workflow } from '@relayflows/core';

const CHANNEL = 'wf-fix-opencode-executor';

async function main() {
  const result = await workflow('fix-opencode-executor')
    .description(
      'Add opencode MCP wiring and cloud auth to SandboxedStepExecutor with full E2E validation',
    )
    .pattern('dag')
    .channel(CHANNEL)
    .maxConcurrency(3)
    .timeout(900_000)

    .agent('impl', {
      cli: 'claude',
      role: 'Implements the executor fixes and iterates on test failures',
      retries: 2,
    })

    // ── Phase 1: Read current state ──────────────────────────────────
    .step('read-executor', {
      type: 'deterministic',
      command: 'cat packages/core/src/executor/executor.ts',
      captureOutput: true,
    })

    .step('read-presets', {
      type: 'deterministic',
      command: 'cat packages/core/src/executor/presets.ts',
      captureOutput: true,
    })

    .step('read-credentials', {
      type: 'deterministic',
      command: 'cat packages/core/src/auth/credentials.ts',
      captureOutput: true,
    })

    .step('read-runtime-types', {
      type: 'deterministic',
      command: 'cat packages/core/src/runtime/types.ts',
      captureOutput: true,
    })

    .step('read-tests', {
      type: 'deterministic',
      command: 'cat tests/orchestrator/executor.test.ts',
      captureOutput: true,
    })

    // ── Phase 2: Implement ───────────────────────────────────────────
    .step('implement-fixes', {
      agent: 'impl',
      dependsOn: ['read-executor', 'read-presets', 'read-credentials', 'read-runtime-types', 'read-tests'],
      task: `You need to make two changes to the SandboxedStepExecutor in packages/core/src/executor/executor.ts.
The codebase uses a runtime abstraction (WorkflowRuntime/RuntimeHandle) instead of raw Daytona SDK.

Here are the current files:

=== packages/core/src/executor/executor.ts ===
{{steps.read-executor.output}}

=== packages/core/src/executor/presets.ts ===
{{steps.read-presets.output}}

=== packages/core/src/auth/credentials.ts ===
{{steps.read-credentials.output}}

=== packages/core/src/runtime/types.ts ===
{{steps.read-runtime-types.output}}

## Change 1: Add opencode MCP wiring

In the executeAgentStep method, AFTER the codex bypass block (the if block that checks agentDef.cli === 'codex') and BEFORE the mergedEnv construction, add this block:

// OpenCode agents need relaycast MCP wired via opencode.json so they
// can communicate with other agents through relay channels.
if (agentDef.cli === 'opencode') {
  await this.writeOpencodeRelaycastConfig(handle, {
    relayApiKey: stepEnv.RELAY_API_KEY,
    agentName: agentDef.name,
    agentToken: agentRelayfileToken,
    workspaceId: this.relayfileWorkspaceId,
  });
  if (!command.includes('--agent')) {
    command = command.replace(/^opencode\\s+run\\b/, 'opencode run --agent relaycast');
  }
}

Add this private method to the class (near ensureCliInstalled):

private async writeOpencodeRelaycastConfig(
  handle: RuntimeHandle,
  opts: {
    relayApiKey: string;
    agentName: string;
    agentToken: string;
    workspaceId: string;
  },
): Promise<void> {
  const env: Record<string, string> = {
    RELAY_API_KEY: opts.relayApiKey,
    RELAY_AGENT_NAME: opts.agentName,
    RELAY_AGENT_TYPE: 'agent',
    RELAY_STRICT_AGENT_NAME: '1',
    RELAY_DEFAULT_WORKSPACE: opts.workspaceId,
  };
  if (opts.agentToken) {
    env.RELAY_AGENT_TOKEN = opts.agentToken;
    env.RELAY_SKIP_BOOTSTRAP = '1';
  }
  const config = {
    mcp: {
      relaycast: {
        type: 'local',
        command: ['npx', '-y', '@relaycast/mcp'],
        environment: env,
      },
    },
    agent: {
      relaycast: {
        description: 'Agent with Relaycast MCP enabled',
        tools: { 'relaycast_*': true },
      },
    },
  };
  const configJson = JSON.stringify(config, null, 2);
  const configPath = this.codeMountPath + '/opencode.json';
  const result = await this.runtime.exec(
    handle,
    "printf '%s' " + shellEscape(configJson) + " > " + shellEscape(configPath),
    { cwd: this.codeMountPath },
  );
  if (result.exitCode !== 0) {
    throw new Error("Failed to write opencode.json: " + result.output);
  }
}

## Change 2: Add cloud auth mounting

Add this private method to the class:

private async mountCloudAuthFile(
  handle: RuntimeHandle,
  sandboxHome: string,
  env: Record<string, string>,
): Promise<void> {
  const apiUrl = env.CLOUD_API_URL?.trim();
  const accessToken = env.CLOUD_API_ACCESS_TOKEN?.trim();
  const refreshToken = env.CLOUD_API_REFRESH_TOKEN?.trim();
  const accessTokenExpiresAt = env.CLOUD_API_ACCESS_TOKEN_EXPIRES_AT?.trim();
  if (!apiUrl || !accessToken || !refreshToken || !accessTokenExpiresAt) {
    return;
  }
  const authDir = sandboxHome + '/.agentworkforce/relay';
  const payload = JSON.stringify({ apiUrl, accessToken, refreshToken, accessTokenExpiresAt }) + '\\n';
  await this.runtime.exec(handle, "mkdir -p " + shellEscape(authDir), { cwd: sandboxHome });
  await this.runtime.uploadFile(handle, Buffer.from(payload), authDir + '/cloud-auth.json');
}

Call it in executeAgentStep right AFTER the credentialsToEnv line and BEFORE the preset assignment:

  const stepCredentials = buildStepCredentials(this.credentials, sandboxId);
  const stepEnv = credentialsToEnv(stepCredentials);
  await this.mountCloudAuthFile(handle, sandboxHome, stepEnv);  // ADD THIS LINE

## Important rules
- Use this.runtime.exec() for commands, NOT sandbox.process.executeCommand
- Use this.runtime.uploadFile() for file uploads, NOT sandbox.fs.uploadFile
- The RuntimeHandle type is already imported from '../runtime/types.js'
- The shellEscape function already exists at the bottom of the file
- Make ONLY the changes described above. Do not refactor other code.
- IMPORTANT: Write the changes to disk. Do NOT just output the code to stdout.`,
      verification: { type: 'exit_code' },
    })

    // ── Phase 2b: Verify edits actually landed ───────────────────────
    .step('verify-edits', {
      type: 'deterministic',
      dependsOn: ['implement-fixes'],
      command: [
        'set -e',
        'if git diff --quiet packages/core/src/executor/executor.ts; then echo "NOT MODIFIED — agent did not edit the file"; exit 1; fi',
        'grep -q "writeOpencodeRelaycastConfig" packages/core/src/executor/executor.ts || (echo "MISSING: writeOpencodeRelaycastConfig"; exit 1)',
        'grep -q "mountCloudAuthFile" packages/core/src/executor/executor.ts || (echo "MISSING: mountCloudAuthFile"; exit 1)',
        'grep -q "@relaycast/mcp" packages/core/src/executor/executor.ts || (echo "MISSING: @relaycast/mcp"; exit 1)',
        'grep -q ".agentworkforce/relay/cloud-auth.json" packages/core/src/executor/executor.ts || (echo "MISSING: canonical cloud-auth path"; exit 1)',
        'echo "All expected changes verified"',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ── Phase 3: Test-fix-rerun loop ─────────────────────────────────

    // 3a: First test run (allow failure — agent will fix)
    .step('run-tests', {
      type: 'deterministic',
      dependsOn: ['verify-edits'],
      command: 'npx tsx --test tests/orchestrator/executor.test.ts 2>&1 | tail -60',
      captureOutput: true,
      failOnError: false,
    })

    .step('typecheck', {
      type: 'deterministic',
      dependsOn: ['verify-edits'],
      command: 'npx tsc --noEmit --project packages/core/tsconfig.build.json 2>&1 | tail -40',
      captureOutput: true,
      failOnError: false,
    })

    // 3b: Agent reads failures, fixes, re-runs until green
    .step('fix-failures', {
      agent: 'impl',
      dependsOn: ['run-tests', 'typecheck'],
      task: `Check the test and typecheck output below. Fix any failures.

Test output:
{{steps.run-tests.output}}

Typecheck output:
{{steps.typecheck.output}}

If all tests passed AND typecheck passed, do nothing.
If there are failures:
1. Read the failing test file and the source file you edited
2. Fix the issues (could be in test expectations or source code)
3. Re-run both:
   npx tsc --noEmit --project packages/core/tsconfig.build.json
   npx tsx --test tests/orchestrator/executor.test.ts
4. Keep fixing until BOTH pass.

Common issues to watch for:
- The mock sandbox in tests returns { result: "ok", exitCode: 0 } for executeCommand
  but the runtime abstraction uses { output: "ok", exitCode: 0 } — check which one the test mocks use
- Missing method on mock objects (e.g. uploadFile needs to be on the mock)
- Import path issues with the runtime types`,
      verification: { type: 'exit_code' },
    })

    // 3c: Final deterministic test run — MUST pass (hard gate)
    .step('run-tests-final', {
      type: 'deterministic',
      dependsOn: ['fix-failures'],
      command: 'npx tsx --test tests/orchestrator/executor.test.ts 2>&1',
      captureOutput: true,
      failOnError: true,
    })

    .step('typecheck-final', {
      type: 'deterministic',
      dependsOn: ['fix-failures'],
      command: 'npx tsc --noEmit --project packages/core/tsconfig.build.json 2>&1',
      captureOutput: true,
      failOnError: true,
    })

    // ── Phase 4: Regression check ────────────────────────────────────
    .step('run-existing-tests', {
      type: 'deterministic',
      dependsOn: ['run-tests-final', 'typecheck-final'],
      command: 'npx tsx --test tests/orchestrator/*.test.ts 2>&1 | tail -40',
      captureOutput: true,
      failOnError: false,
    })

    .step('fix-regressions', {
      agent: 'impl',
      dependsOn: ['run-existing-tests'],
      task: `Check the full orchestrator test suite for regressions caused by our changes.

Test output:
{{steps.run-existing-tests.output}}

If all tests passed, do nothing.
If EXISTING tests broke, read the failing test and find what we broke.
Most likely cause: constructor signatures changed, new required fields added
without defaults, mock objects missing new methods we added, or import paths shifted.

Run: npx tsx --test tests/orchestrator/*.test.ts
Fix until all tests pass.`,
      verification: { type: 'exit_code' },
    })

    // Final regression gate
    .step('regression-gate', {
      type: 'deterministic',
      dependsOn: ['fix-regressions'],
      command: 'npx tsx --test tests/orchestrator/*.test.ts 2>&1',
      captureOutput: true,
      failOnError: true,
    })

    // ── Phase 5: Commit ──────────────────────────────────────────────
    .step('commit', {
      type: 'deterministic',
      dependsOn: ['regression-gate'],
      command: [
        'git add packages/core/src/executor/executor.ts',
        'git commit -m "fix(executor): wire opencode relaycast MCP + cloud auth for per-agent sandboxes\n\nAdds writeOpencodeRelaycastConfig to write opencode.json with relaycast\nMCP server config when spawning opencode agents in isolated sandboxes.\n\nAdds mountCloudAuthFile to write cloud-auth.json from CLOUD_API_* env\nvars so headless VMs don\'t hang on browser-based login.\n\nBoth are needed because the executor path bypasses the broker which\nnormally handles MCP wiring via configure_relaycast_mcp_with_token."',
      ].join(' && '),
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
