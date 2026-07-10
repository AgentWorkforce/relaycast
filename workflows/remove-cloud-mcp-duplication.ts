/**
 * Remove duplicated MCP wiring + relaycast-token lookup from
 * SandboxedStepExecutor; delegate to `agent-relay mcp-args --register`
 * (single source of truth in Rust).
 * ============================================================================
 *
 * Runtime context
 *   Run with: `agent-relay run workflows/remove-cloud-mcp-duplication.ts`
 *   Run LOCALLY — TypeScript edits + build/test; no cloud involvement.
 *
 * Pattern
 *   writing-agent-relay-workflows: claude plan → codex implement →
 *                                  claude review → commit + PR
 *   relay-80-100-workflow:         test-fix-rerun + build gate + probe
 *                                  dry-run + deterministic verdict gate.
 *
 * Prerequisite — DO NOT run this workflow until all of the following are true:
 *   1. AgentWorkforce/relay has merged the mcp-args subcommand PR
 *      (workflows/add-mcp-args-subcommand.ts in the relay repo). The
 *      subcommand must support --register + --existing-token.
 *   2. A new @agent-relay/sdk version has been published to npm that
 *      includes the agent-relay-broker binary exposing `mcp-args`
 *      with the --register flag (expected 4.0.32 or later).
 *   3. You know the target SDK version.
 *
 *   The workflow's verify-subcommand-available step will fail fast if
 *   1+2 haven't happened, so don't worry about wasting cycles.
 *
 * Problem being solved
 *   Cloud#226 replicated the broker's per-CLI MCP arg wiring inside
 *   SandboxedStepExecutor (claude --mcp-config, codex --config
 *   mcp_servers.relaycast.*, opencode.json + --agent relaycast). It
 *   also reused `resolveRelayfileTokenForAgent` — a RELAYFILE JWT
 *   lookup — as the RELAY_AGENT_TOKEN passed to the RELAYCAST MCP
 *   server. Two different identity systems, incompatible token
 *   formats. Agents saw the MCP server post-#226 but rejected every
 *   tool call with "no workspace available" / "Invalid token format".
 *
 *   The relay `agent-relay mcp-args --register` subcommand composes
 *   register_agent_token + configure_relaycast_mcp_with_token, handing
 *   back a fully-correct payload including a valid at_live_* agent
 *   token. Delegating to it lets us delete BOTH the TS wiring and the
 *   incorrect token-lookup flow.
 *
 * Acceptance contract
 *   After the fix:
 *     - SandboxedStepExecutor has NO cli-specific MCP branching.
 *     - SandboxedStepExecutor does NOT reference
 *       resolveRelayfileTokenForAgent when building relaycast MCP args
 *       (relayfile-mount itself still uses it — that's a separate
 *       subsystem).
 *     - SandboxedStepExecutor calls `agent-relay mcp-args --register
 *       --cli <cli> --agent-name <name> --api-key <key> --cwd <cwd>`,
 *       parses the JSON { args, sideEffectFiles, agentToken }, and
 *       splats args into the spawn command.
 *     - The writeClaudeMcpConfig / buildClaudeMcpConfigJson /
 *       buildCodexMcpArgs methods added by #226 are DELETED.
 *       writeOpencodeRelaycastConfig is DELETED if the subcommand
 *       handles opencode.json via --cwd (plan confirms).
 *     - Running \`agent-relay cloud run workflows/hi-interactive.ts\`
 *       on cloud shows each agent successfully posting to its
 *       relaycast channel (proves at_live_* token is valid).
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

const BRANCH = 'refactor/delegate-mcp-args-to-subcommand';
const CHANNEL = 'wf-remove-cloud-mcp-duplication';

async function main() {
  const result = await workflow('remove-cloud-mcp-duplication')
    .description(
      'Delete the #226 TypeScript MCP branching AND the relayfile-token-used-as-relaycast-token misuse in SandboxedStepExecutor; delegate to the new agent-relay mcp-args --register subcommand. Bumps @agent-relay/sdk. claude plan → codex implement → test-fix-rerun → claude review → PR.',
    )
    .pattern('dag')
    .channel(CHANNEL)
    .maxConcurrency(3)
    .timeout(3_600_000)

    .agent('planner', {
      cli: 'claude',
      model: ClaudeModels.OPUS,
      role: 'Architect — inventories all duplication + incorrect-token paths, specifies the subprocess-delegation shape.',
      retries: 1,
    })
    .agent('implementer', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      role: 'Implements the delegation; deletes the duplicated methods and the relaycast-token-from-relayfile misuse; iterates until build:core + orchestrator:test pass.',
      retries: 2,
    })
    .agent('reviewer', {
      cli: 'claude',
      model: ClaudeModels.OPUS,
      role: 'Strict reviewer — asserts net lines removed, no cli-specific branching, no relayfile-token-as-relaycast-token remaining, tests prove the subprocess path.',
      retries: 1,
    })

    // ─── Phase 0: Setup + SDK verification ─────────────────────────────
    .step('setup-branch', {
      type: 'deterministic',
      command: [
        'set -e',
        'git config user.email "agent@agent-relay.com"',
        'git config user.name "MCP Dedup Bot"',
        `git checkout -B ${BRANCH}`,
        'git log -1 --oneline',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('resolve-target-sdk-version', {
      type: 'deterministic',
      dependsOn: ['setup-branch'],
      command: [
        'set -e',
        'npm view @agent-relay/sdk version | tee /tmp/target-sdk-version.txt',
        'echo ---',
        'echo "current pin in cloud package.json:"',
        // The SDK lives in `dependencies` (root) and `packages/core` — NOT in
        // devDependencies. Read both and print the resolved version so the
        // operator can see whether an install is actually needed.
        'node -p "require(\'./package.json\').dependencies[\'@agent-relay/sdk\']"',
        'echo "current pin in packages/core/package.json:"',
        'node -p "require(\'./packages/core/package.json\').dependencies[\'@agent-relay/sdk\']"',
        'echo "currently installed @agent-relay/sdk:"',
        'node -p "require(\'./node_modules/@agent-relay/sdk/package.json\').version" 2>/dev/null || echo "not installed"',
      ].join('\n'),
      captureOutput: true,
      failOnError: true,
    })

    // Force a real upgrade to the latest published SDK. `npm install` with
    // the existing pins is a no-op when the lockfile already satisfies the
    // caret range (e.g. ^4.0.31 is "satisfied" by an installed 4.0.31 even
    // though 4.0.33 is the target). Explicitly install @latest so the new
    // broker binary — the one carrying the `mcp-args --register` flag —
    // actually lands in node_modules.
    .step('install-deps', {
      type: 'deterministic',
      dependsOn: ['resolve-target-sdk-version'],
      command: [
        'set -e',
        'TARGET=$(cat /tmp/target-sdk-version.txt | tr -d "[:space:]")',
        'echo "bumping @agent-relay/sdk + @agent-relay/config to ^${TARGET} (root + packages/core)"',
        // Root deps first.
        'npm install --save --save-prefix="^" --legacy-peer-deps --no-audit --no-fund "@agent-relay/sdk@${TARGET}" "@agent-relay/config@${TARGET}" 2>&1 | tail -10',
        // packages/core pins too — otherwise workspace hoisting fights the root pin.
        'npm install --workspace=packages/core --save --save-prefix="^" --legacy-peer-deps --no-audit --no-fund "@agent-relay/sdk@${TARGET}" "@agent-relay/config@${TARGET}" 2>&1 | tail -10',
        'INSTALLED=$(node -p "require(\'./node_modules/@agent-relay/sdk/package.json\').version")',
        'echo "installed @agent-relay/sdk version: ${INSTALLED}"',
        'if [ "$INSTALLED" != "$TARGET" ]; then echo "ERROR: installed ${INSTALLED} does not match target ${TARGET}"; exit 1; fi',
      ].join('\n'),
      captureOutput: true,
      failOnError: true,
    })

    // Hard gate: the installed broker must have `mcp-args` WITH --register.
    // If not, the relay PR hasn't shipped — abort before wasting claude+codex cycles.
    .step('verify-subcommand-available', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: [
        'set -e',
        'BROKER="node_modules/@agent-relay/sdk/bin/agent-relay-broker-$(uname -s | tr \'[:upper:]\' \'[:lower:]\')-$(uname -m | sed \'s/x86_64/x64/; s/aarch64/arm64/\')"',
        'if [ ! -x "$BROKER" ]; then echo "ERROR: broker binary not found at $BROKER"; exit 1; fi',
        '"$BROKER" mcp-args --help 2>&1 | tee /tmp/subcommand-help.txt',
        'if ! grep -q "mcp-args" /tmp/subcommand-help.txt; then echo "ERROR: installed @agent-relay/sdk version ($(cat /tmp/target-sdk-version.txt)) does not expose agent-relay mcp-args. Merge + release the relay PR first; then bump the SDK version in package.json and re-run."; exit 1; fi',
        'if ! grep -q -- "--register" /tmp/subcommand-help.txt; then echo "ERROR: mcp-args subcommand is missing the --register flag. The installed SDK version is missing agent-registration support — require the newer release."; exit 1; fi',
      ].join('\n'),
      captureOutput: true,
      failOnError: true,
    })

    // ─── Phase 1: Plan ─────────────────────────────────────────────────
    .step('plan', {
      agent: 'planner',
      dependsOn: ['verify-subcommand-available'],
      task: `Write PLAN.md at the repo root for replacing SandboxedStepExecutor's per-cli MCP branching AND the relayfile-token-misuse with a single subprocess call to \`agent-relay mcp-args --register\`.

Read these files:

  packages/core/src/executor/executor.ts
    - SandboxedStepExecutor class. Find every call site that branches
      on agentDef.cli for MCP-related wiring:
        - writeOpencodeRelaycastConfig + \`--agent relaycast\` rewrite
        - writeClaudeMcpConfig / buildClaudeMcpConfigJson (added by #226)
        - buildCodexMcpArgs (added by #226)
    - resolveRelayfileTokenForAgent (~line 752) — its callers for
      relaycast purposes specifically. Record file:line of each call.
      The method itself stays; we only remove the calls that were
      feeding RELAYFILE tokens into RELAYCAST MCP config.
    - executeAgentStep command assembly where the final shell command
      is built and executed.
  packages/core/src/runtime/daytona.ts
    - DaytonaRuntime.exec — how to run a one-shot command in the sandbox.
      The new code will run \`agent-relay mcp-args --register ...\`
      in the per-agent sandbox before the actual CLI command.
  node_modules/@agent-relay/sdk/bin/ — confirm the broker binary path
    and that \`agent-relay mcp-args\` is present and supports --register.

Your PLAN.md must cover:

  1. Duplication inventory (file:line) and what each does today.
  2. Design of the new getMcpConfigForAgent method:
       a) Resolve broker binary path in the sandbox filesystem.
       b) Invoke \`<broker> mcp-args --register --cli <cli>
          --agent-name <name> --api-key $RELAY_API_KEY
          --base-url <url> --cwd <cwd>\`.
       c) Parse JSON stdout → { args, sideEffectFiles, agentToken }.
       d) Failure handling: if the subprocess exits non-zero, log a
          structured warning + continue with no MCP args. The user sees
          the failure at task time (agent can't post) rather than a
          spawn crash. Record what error details surface in the log.
       e) Cache considerations: agents registered once per spawn. Idempotent
          registration on relaycast's end handles any retries.
  3. Deletions (explicit file:line list):
       - writeClaudeMcpConfig / buildClaudeMcpConfigJson
       - buildCodexMcpArgs
       - writeOpencodeRelaycastConfig (only if subcommand --cwd emits
         opencode.json; confirm by running the subcommand with --cli
         opencode --cwd /tmp/test and checking sideEffectFiles).
       - resolveRelayfileTokenForAgent CALLS within the per-cli switch
         that were feeding relayfile JWTs to relaycast. The method
         itself remains for relayfile-mount-related uses.
  4. Tests to update:
       - tests/orchestrator/executor.test.ts — swap "branches on cli
         and writes config" assertions for "invokes <broker> mcp-args
         with the correct flags, splats its returned args, applies
         sideEffectFiles". Mock sandbox whose executeCommand traps
         invocations matching /mcp-args/ and returns canned JSON
         (including a synthetic at_live_* agentToken).
       - Add a NEGATIVE test: the executor should NOT call
         resolveRelayfileTokenForAgent from the relaycast-wiring path.
         Easy to verify via a spy on the method.
  5. Tests to keep:
       - Per-CLI assertions — still useful as parity with the subcommand's
         canned output. Combined with the Rust parity test already in
         the relay PR, end-to-end wiring parity is proven.
  6. package.json @agent-relay/sdk pin: exact version to pin (written
     during the plan step from /tmp/target-sdk-version.txt).
  7. Expected line delta: net NEGATIVE. Probably 100+ lines removed
     from executor.ts.
  8. Probe: workflows/e2e-per-agent-sandbox.ts is still valid. No new
     probe needed. After merge + deploy + snapshot rebuild, running
     hi-interactive.ts on cloud should complete end-to-end — agents
     post to channels AND write intro files AND verify-intros passes
     (last part still depends on B2 landing).
  9. Residual risks:
       - Subcommand not available at runtime: caught by the workflow's
         verify-subcommand-available step + runtime fallback.
       - Broker binary not in sandbox: fallback-to-no-MCP message surfaces
         it clearly.
       - Relayfile-mount still uses RELAY_AGENT_TOKENS — don't remove
         that; it's a different system.

Do NOT modify code in this step.`,
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
      task: `Implement the plan. Delete the #226 duplication, remove the relayfile-token-as-relaycast-token misuse, add the subprocess call, update tests.

PLAN:
{{steps.read-plan.output}}

IMPORTANT:
  - Net lines MUST go down. You are DELETING cli-specific branching AND
    removing wrong-token-type calls. If you find yourself adding more
    lines than removing, reconsider — not leveraging the subcommand fully.
  - Do not touch relayfile-mount-related code paths. RELAY_AGENT_TOKENS
    serves relayfile for filesystem sync; that subsystem stays.
  - Do not touch the broker PTY / headless spawn paths in the relay SDK.
  - package.json @agent-relay/sdk needs pinning to a version that has
    the --register flag (per plan).

Iterate test-fix-rerun until green:
  1. npm run build:core
  2. npm run orchestrator:test 2>&1 | tail -60
  3. Fix failures. Tests certainly need updating for the new pattern.
  4. Repeat.

When green, write IMPL_SUMMARY.md listing each changed file with a
one-line note AND a line-delta summary (e.g. "executor.ts: net -174").
No commits.`,
      verification: { type: 'file_exists', value: 'IMPL_SUMMARY.md' },
      retries: 2,
    })

    // ─── Phase 3: Test-fix-rerun ───────────────────────────────────────
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
      task: `Test output below. Fix failures and re-run. If all passed, do nothing.

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

    // Line-delta sanity check — this is a dedup PR, not an addition.
    .step('assert-net-deletion', {
      type: 'deterministic',
      dependsOn: ['run-orchestrator-tests-final'],
      command: [
        'set -e',
        'ADDED=$(git diff HEAD --numstat -- packages/core/src/executor/executor.ts | awk \'{print $1}\')',
        'DELETED=$(git diff HEAD --numstat -- packages/core/src/executor/executor.ts | awk \'{print $2}\')',
        'echo "executor.ts: +${ADDED:-0} / -${DELETED:-0}"',
        'if [ "${ADDED:-0}" -ge "${DELETED:-0}" ]; then',
        '  echo "ERROR: executor.ts net lines went UP. Expected a deletion PR — the cli-specific wiring + wrong-token path should shrink."',
        '  exit 1',
        'fi',
      ].join('\n'),
      captureOutput: true,
      failOnError: true,
    })

    .step('dry-run-probe', {
      type: 'deterministic',
      dependsOn: ['assert-net-deletion'],
      command:
        'npx agent-relay run --dry-run workflows/e2e-per-agent-sandbox.ts 2>&1 | tail -15',
      captureOutput: true,
      failOnError: true,
    })

    // ─── Phase 4: Diff + review ────────────────────────────────────────
    .step('capture-diff', {
      type: 'deterministic',
      dependsOn: ['dry-run-probe'],
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

  [ ] SandboxedStepExecutor has NO cli-specific MCP branching remaining.
      Grep the diff for \`if (agentDef.cli === ...)\` / switch(agentDef.cli)
      patterns near MCP args — gone.
  [ ] writeClaudeMcpConfig / buildClaudeMcpConfigJson / buildCodexMcpArgs
      (or equivalents added by #226) are DELETED.
  [ ] writeOpencodeRelaycastConfig is either DELETED (because subcommand
      handles it via --cwd) or explicitly justified in REVIEW.md as
      still needed.
  [ ] resolveRelayfileTokenForAgent is NOT called from the relaycast
      MCP config build path. (The method itself may remain for
      relayfile-mount use.)
  [ ] The new subprocess-call method correctly:
      - Resolves the broker binary path
      - Invokes with --register
      - Parses JSON { args, sideEffectFiles, agentToken }
      - Handles failure gracefully (logs + continues, no crash)
  [ ] Tests now assert the subprocess-call pattern — mock sandbox traps
      mcp-args calls and returns canned JSON including a synthetic
      at_live_* agentToken.
  [ ] NEGATIVE test exists: executor does NOT call
      resolveRelayfileTokenForAgent from the relaycast-wiring path.
  [ ] Net lines on executor.ts are negative (confirmed by
      assert-net-deletion step).
  [ ] package.json @agent-relay/sdk pinned to a version with --register.
  [ ] No changes to broker spawn path / relay SDK files.
  [ ] No unrelated refactors.

Write REVIEW.md:
  VERDICT: APPROVE or REQUEST_CHANGES
  ## Checklist
  - [PASS|FAIL] <item>
  ## Findings
  1. <file>:<line> — <issue>

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
        'rm -f PLAN.md IMPL_SUMMARY.md REVIEW.md /tmp/target-sdk-version.txt /tmp/subcommand-help.txt',
        'git add -A',
        'git diff --cached --quiet && { echo "nothing to commit"; exit 1; } || true',
        'git commit -m "refactor(executor): delegate MCP identity + args to agent-relay mcp-args --register"',
        'git push -u origin HEAD',
        'gh pr create --title "refactor(executor): delegate MCP identity + args to agent-relay mcp-args --register" --body "Replaces the per-CLI MCP arg wiring introduced by #226 (writeClaudeMcpConfig, buildCodexMcpArgs, writeOpencodeRelaycastConfig) AND the incorrect \\`resolveRelayfileTokenForAgent\\` → relaycast MCP token flow with a single subprocess call to the Rust broker\\u0027s \\`agent-relay mcp-args --register\\` subcommand.\\n\\nThe subcommand composes register_agent_token + configure_relaycast_mcp_with_token (relay-side authority) and returns a fully-correct payload with a valid \\`at_live_*\\` relaycast agent token — fixing the \\`no workspace available\\` / \\`Invalid token format\\` errors seen post-#226 when relayfile JWTs were being passed to relaycast MCP.\\n\\nPer-CLI knowledge now lives in one place (relay/src/snippets.rs). Agent registration for relaycast now happens through one code path. Net lines on executor.ts go down.\\n\\nDepends on @agent-relay/sdk >= <version-with-mcp-args-register> (see package.json bump in this PR).\\n\\nGenerated by workflows/remove-cloud-mcp-duplication.ts."',
      ].join(' && '),
      failOnError: true,
    })

    .onError('fail-fast')
    .run({ cwd: process.cwd() });

  console.log('Workflow status:', result.status);
  console.log(`Branch: ${BRANCH}`);
  console.log('');
  console.log('After PR merges + Lambda deploy + snapshot rebuilds:');
  console.log('  agent-relay cloud run workflows/hi-interactive.ts');
  console.log('  → claude + codex + opencode all post to relaycast channel');
  console.log('  → intro-<cli>.md files appear in cloud sync patch');
  console.log('  → (verify-intros success depends on B2 landing too)');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
