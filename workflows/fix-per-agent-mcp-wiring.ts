/**
 * Fix: per-agent Daytona sandboxes don't have relaycast MCP wired for
 * claude / codex (opencode was wired in PR #115).
 * ============================================================================
 *
 * Runtime context
 *   Recommended: `agent-relay run workflows/fix-per-agent-mcp-wiring.ts`
 *   Run LOCALLY — cloud sync is still ACL-blocked for workflow-runs.jsonl
 *   and any agent output files, so running this on cloud risks losing the
 *   generated PR. Fix B2 addresses that; run this locally until B2 lands.
 *
 * Pattern
 *   writing-agent-relay-workflows: claude plan → codex implement →
 *                                  claude review → commit + PR
 *   relay-80-100-workflow:         test-fix-rerun, build gate,
 *                                  regression gate, deterministic gate.
 *
 * Problem being fixed
 *   After cloud#224 landed the per-agent sandbox wiring, hi-interactive
 *   agents started failing with:
 *     claude-hi: "Relaycast MCP tools are not available in this environment"
 *     codex-hi:  "The relaycast message-post MCP tool is not available"
 *     opencode-hi: ran further (wiring exists) but still file-verified FAIL
 *
 *   Root cause: SandboxedStepExecutor only wires MCP for opencode
 *   (writeOpencodeRelaycastConfig + `--agent relaycast`, landed in PR
 *   #115). Claude and codex per-agent sandboxes get NO MCP.
 *
 *   For comparison, the broker's pty path (src/worker.rs in the relay
 *   repo) calls configure_relaycast_mcp_with_token which branches on cli:
 *     - claude:  --mcp-config <json> arg with relaycast MCP server
 *     - codex:   --config mcp_servers.relaycast.command="npx" etc
 *     - opencode: writes opencode.json + --agent relaycast
 *     - gemini:   equivalent --config
 *
 *   SandboxedStepExecutor needs the same branching for non-opencode clis.
 *
 * Acceptance contract
 *   After the fix, running workflows/e2e-per-agent-sandbox.ts on cloud
 *   shows each agent successfully using relaycast_* MCP tools (agents
 *   can post to the channel and call other relaycast verbs). Locally,
 *   behavior unchanged.
 */

process.env.RUST_LOG =
  process.env.RUST_LOG ??
  [
    'relay_broker::snippets=debug',
    'relay_broker::worker=debug',
    'relay_broker=info',
  ].join(',');

import { workflow } from '@relayflows/core';
import { ClaudeModels, CodexModels } from '@agent-relay/config';
import { applyCloudRepoSetup } from './lib/cloud-repo-setup';

const BRANCH = 'fix/per-agent-mcp-wiring-claude-codex';
const CHANNEL = 'wf-fix-per-agent-mcp-wiring';

async function main() {
  const baseWf = workflow('fix-per-agent-mcp-wiring')
    .description(
      'Extend SandboxedStepExecutor to wire relaycast MCP for claude + codex per-agent sandboxes, matching the broker-side pty path. claude plan → codex implement → test-fix-rerun → claude review → PR.',
    )
    .pattern('dag')
    .channel(CHANNEL)
    .maxConcurrency(3)
    .timeout(3_600_000)

    .agent('planner', {
      cli: 'claude',
      model: ClaudeModels.OPUS,
      role: 'Architect — cross-references relay/src/snippets.rs broker-side MCP wiring with cloud executor.ts to specify the parity fix.',
      retries: 1,
    })
    .agent('implementer', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      role: 'Implements the plan; iterates until build:core + orchestrator:test green.',
      retries: 2,
    })
    .agent('reviewer', {
      cli: 'claude',
      model: ClaudeModels.OPUS,
      role: 'Strict reviewer — verifies claude AND codex per-agent sandboxes now get MCP, opencode wiring is unaffected, broker-path unchanged.',
      retries: 1,
    });

  // ─── Phase 0: Setup (shared helper) ─────────────────────────────────
  const wf = applyCloudRepoSetup(baseWf, {
    branch: BRANCH,
    committerName: 'Per-Agent MCP Fix Bot',
  });

  const result = await wf
    // ─── Phase 1: Plan ─────────────────────────────────────────────────
    .step('plan', {
      agent: 'planner',
      dependsOn: ['install-deps'],
      task: `Produce a plan to wire relaycast MCP for claude and codex in
per-agent Daytona sandboxes. Write PLAN.md at the repo root.

Read in this order:

  1. packages/core/src/executor/executor.ts
     Find the existing per-agent opencode MCP wiring: search for
     "writeOpencodeRelaycastConfig" and the command rewrite that adds
     "--agent relaycast". This is the template — claude and codex need
     analogous wiring, not identical.

  2. For reference, if the relay SDK source is on the agent's machine at
     ../relay or /relay or similar, read:
       ../relay/src/snippets.rs — look for \`configure_relaycast_mcp_with_token\`.
         The function branches on cli:
           - is_claude: pushes --mcp-config <json>
             (json is a relaycast MCP server entry with RELAY_API_KEY,
             RELAY_AGENT_NAME, RELAY_AGENT_TOKEN in env)
           - is_codex:  pushes --config mcp_servers.relaycast.command="npx"
             --config mcp_servers.relaycast.args=["-y","@relaycast/mcp"]
             --config mcp_servers.relaycast.env.RELAY_API_KEY="..."
             (codex --config accepts TOML-style k=v pairs)
           - is_opencode: writes opencode.json + --agent relaycast (already
             mirrored in cloud's SandboxedStepExecutor)
     If the relay source is not accessible, describe the expected shape
     from memory / the PR descriptions of cloud#115, relay#583, relay#723.

  3. packages/core/src/auth/credentials.ts / related — where per-agent
     creds are mounted (already exists).

  4. packages/core/src/runtime/daytona.ts — DaytonaRuntime.launch() for
     context on per-agent sandbox lifecycle.

Your PLAN.md must cover:

  1. Evidence. file:line citations for:
     a) Existing opencode wiring in SandboxedStepExecutor.
     b) The broker-side wiring sites per cli (claude mcp-config, codex
        --config pairs) — or the spec if relay src isn't readable.
  2. Root cause, one paragraph: SandboxedStepExecutor branches on opencode
     only; other clis hit the else-path and get no MCP.
  3. Fix shape:
     - New methods on SandboxedStepExecutor (or a single method that
       branches by cli): writeClaudeMcpConfig / addCodexMcpArgs.
     - Modify executeAgentStep (or equivalent) to call them before
       spawning the agent command.
     - Command rewrites: claude gets --mcp-config <json> appended; codex
       gets --config mcp_servers.relaycast.* appended.
  4. Env + scope:
     - RELAY_API_KEY: already propagated via stepEnv.
     - RELAY_AGENT_NAME / RELAY_AGENT_TOKEN: per-agent, already computed
       by the executor for opencode — reuse the same values.
     - Credentials: non-changed. Already mounted via mountCloudAuthFile.
  5. Exact file list to change (likely just packages/core/src/executor/executor.ts).
  6. Test plan:
     - Unit: extend tests/orchestrator/ (or executor-specific tests)
       with mocks asserting that for agentDef.cli === 'claude' the
       resulting command includes --mcp-config, and for 'codex' it
       includes --config mcp_servers.relaycast.
     - E2E probe: reuse workflows/e2e-per-agent-sandbox.ts — after the
       fix, claude and codex agents should be able to call a relaycast
       MCP tool (e.g. message-post) as part of the probe.
  7. Acceptance contract: rerun e2e-per-agent-sandbox.ts on cloud;
     each agent calls a relaycast tool without error.
  8. Residual risks / out-of-scope:
     - Fix B2 (file propagation from per-agent sandboxes to orchestrator)
       is separate.
     - gemini wiring is out-of-scope unless trivially mirroring codex.

Do NOT edit source code in this step.`,
      verification: { type: 'file_exists', value: 'PLAN.md' },
    })

    .step('read-plan', {
      type: 'deterministic',
      dependsOn: ['plan'],
      command: 'cat PLAN.md',
      captureOutput: true,
      failOnError: true,
    })

    // ─── Phase 2: Implement ────────────────────────────────────────────
    .step('implement', {
      agent: 'implementer',
      dependsOn: ['read-plan'],
      task: `Implement the plan. Edit only files the plan names.

PLAN:
{{steps.read-plan.output}}

IMPORTANT:
  - Opencode wiring must stay untouched. Do not change its behavior.
  - Broker-side pty path: unrelated, don't touch (lives in the relay SDK).
  - Local agent-relay run (no Daytona per-agent sandboxes): no path
    change — the executor is only used in cloud orchestrator context.

After each meaningful edit:
  npm run build:core

Then iterate test-fix-rerun until clean:
  1. npm run build:core
  2. npm run orchestrator:test 2>&1 | tail -60
  3. fix the right side (source for regressions, test for bad asserts)
  4. repeat

Add a focused unit test asserting:
  - agentDef.cli === 'claude' results in --mcp-config being in the
    spawned command args, with relaycast server config in the JSON.
  - agentDef.cli === 'codex' results in --config mcp_servers.relaycast.*
    entries being in the spawned command args.
  - agentDef.cli === 'opencode' still writes opencode.json + --agent
    relaycast (regression guard).

When green, write IMPL_SUMMARY.md listing changed files. No commits.`,
      verification: { type: 'file_exists', value: 'IMPL_SUMMARY.md' },
      retries: 2,
    })

    // ─── Phase 3: Test-fix-rerun loop ──────────────────────────────────
    .step('run-orchestrator-tests', {
      type: 'deterministic',
      dependsOn: ['implement'],
      command: 'npm run build:core && npm run orchestrator:test 2>&1 | tail -80',
      captureOutput: true,
      failOnError: false,
    })

    .step('fix-test-failures', {
      agent: 'implementer',
      dependsOn: ['run-orchestrator-tests'],
      task: `Test output below. Fix any failures and re-run
\`npm run build:core && npm run orchestrator:test\` until green. If all
passed, do nothing.

{{steps.run-orchestrator-tests.output}}

No commits.`,
      verification: { type: 'exit_code' },
      retries: 1,
    })

    .step('run-orchestrator-tests-final', {
      type: 'deterministic',
      dependsOn: ['fix-test-failures'],
      command: 'npm run build:core && npm run orchestrator:test 2>&1 | tail -40',
      captureOutput: true,
      failOnError: true,
    })

    // ─── Phase 4: Diff + review ────────────────────────────────────────
    .step('capture-diff', {
      type: 'deterministic',
      dependsOn: ['run-orchestrator-tests-final'],
      command: 'git diff HEAD --stat && echo --- FULL DIFF --- && git diff HEAD',
      captureOutput: true,
      failOnError: true,
    })

    .step('review', {
      agent: 'reviewer',
      dependsOn: ['capture-diff'],
      task: `Review against PLAN.md + IMPL_SUMMARY.md. Diff:

{{steps.capture-diff.output}}

Acceptance checklist — mark PASS or FAIL. Any FAIL = REQUEST_CHANGES.

  [ ] SandboxedStepExecutor now branches on claude: pushes --mcp-config
      with a relaycast MCP server JSON (at minimum: command=npx,
      args=["-y","@relaycast/mcp" or equivalent], env with
      RELAY_API_KEY and RELAY_AGENT_NAME/TOKEN).
  [ ] SandboxedStepExecutor now branches on codex: pushes --config
      mcp_servers.relaycast.command="npx" + args + env, using the same
      agent identity values as claude.
  [ ] Opencode wiring unchanged — writeOpencodeRelaycastConfig call
      and --agent relaycast command rewrite still present and
      unmodified.
  [ ] Unit tests cover all three clis (claude, codex, opencode).
  [ ] No changes to broker-side / pty code paths (nothing in relay repo
      or non-cloud-executor files).
  [ ] No unrelated refactors.

Write REVIEW.md:
  VERDICT: APPROVE or REQUEST_CHANGES
  ## Checklist
  - [PASS|FAIL] <item>
  ## Findings
  <file>:<line> — <issue>

Do NOT edit code.`,
      verification: { type: 'file_exists', value: 'REVIEW.md' },
    })

    .step('gate-on-verdict', {
      type: 'deterministic',
      dependsOn: ['review'],
      command: 'grep -q "VERDICT: APPROVE" REVIEW.md',
      failOnError: true,
    })

    // ─── Phase 5: Commit + PR ──────────────────────────────────────────
    .step('commit-and-pr', {
      type: 'deterministic',
      dependsOn: ['gate-on-verdict'],
      command: [
        'rm -f PLAN.md IMPL_SUMMARY.md REVIEW.md',
        'git add -A',
        'git diff --cached --quiet && { echo "nothing to commit"; exit 1; } || true',
        'git commit -m "fix(executor): wire relaycast MCP for claude + codex in per-agent sandboxes"',
        'git push -u origin HEAD',
        'gh pr create --title "fix(executor): wire relaycast MCP for claude + codex in per-agent sandboxes" --body "SandboxedStepExecutor only wired relaycast MCP for opencode (PR #115). Claude and codex per-agent Daytona sandboxes got no MCP, so after cloud#224 landed per-agent sandboxing, hi-interactive agents failed with \\`Relaycast MCP tools are not available in this environment\\`. This adds claude (\\`--mcp-config <json>\\`) and codex (\\`--config mcp_servers.relaycast.*\\`) wiring that matches the broker-side pty path in relay/src/snippets.rs::configure_relaycast_mcp_with_token. Opencode wiring unchanged. Generated by workflows/fix-per-agent-mcp-wiring.ts (claude plan → codex implement → test-fix-rerun → claude review)."',
      ].join(' && '),
      failOnError: true,
    })

    .onError('fail-fast')
    .run({ cwd: process.cwd() });

  console.log('Workflow status:', result.status);
  console.log(`Branch: ${BRANCH}`);
  console.log('');
  console.log('After PR merges + snapshot rebuild, verify:');
  console.log('  agent-relay cloud run workflows/e2e-per-agent-sandbox.ts');
  console.log('  (claude and codex agents should successfully call relaycast MCP tools)');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
