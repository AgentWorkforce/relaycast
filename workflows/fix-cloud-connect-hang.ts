/**
 * Fix Cloud Connect Hang (Regression Guard)
 *
 * ## Problem
 *
 * `agent-relay cloud connect anthropic` and `agent-relay cloud connect openai`
 * both hang after printing "Starting interactive authentication..." against
 * production cloud.
 *
 * Observed:
 * - **anthropic**: hangs with zero further output.
 * - **openai**:   prints `added 2 packages in 4s` (from `npm install -g @openai/codex`)
 *                 and then hangs — `codex login` never produces any output.
 *
 * ## Root cause (openai case — concretely testable)
 *
 * `packages/core/src/auth/sandbox-auth.ts` builds the remote command as:
 *
 *     PATH=${home}/.local/bin:/home/workspace/.local/bin:$PATH
 *       command -v codex >/dev/null 2>&1 || (npm install -g @openai/codex);
 *       codex login
 *
 * In bash, the `VAR=value command` prefix only applies to the **immediate next
 * simple command** (`command -v codex`). It does NOT propagate to the subshell
 * running `npm install -g`, nor to the trailing `codex login` after the `;`.
 *
 * Consequence: after `npm install -g @openai/codex` drops the binary into
 * `/home/daytona/.local/bin/codex`, the subsequent `codex login` runs under
 * the daytona user's default PATH, which does not include that directory, so
 * the shell can't find `codex` (or finds an old/wrong one). The TUI never
 * starts and the SSH channel sits idle until it times out.
 *
 * ## Fix
 *
 * Export PATH once inside the command so every subsequent command — including
 * the subshell and the final CLI invocation — inherits it, and `exec` the CLI
 * so there's no shell-teardown race:
 *
 *     export PATH=${home}/.local/bin:/home/workspace/.local/bin:$PATH;
 *     command -v codex >/dev/null 2>&1 || npm install -g @openai/codex;
 *     exec codex login
 *
 * ## Also checks (anthropic case)
 *
 * Claude is preinstalled on the Daytona base image, so the PATH bug doesn't
 * apply there. The hang for claude is likely a separate TUI/PTY rendering
 * issue in relay/src/cli/lib/ssh-interactive.ts. This workflow does NOT fix
 * that — but it adds an investigation step that captures findings for a
 * follow-up PR against the relay repo.
 *
 * ## Regression guard
 *
 * This workflow extracts the command-building logic out of `createAuthSandbox`
 * into a pure, exported `buildRemoteAuthCommand` function, and adds unit tests
 * that assert:
 *   - PATH is exported (not just prefixed to one command)
 *   - the install guard chains into the final CLI invocation
 *   - `codex login` is reachable after the install guard runs
 *   - anthropic command still works without an install guard
 *   - cursor's `agent`/`cursor-agent` fallback is preserved
 *
 * These tests would have caught the bug. Keep them as a regression guard so
 * the working-state this restores doesn't silently regress again.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workflow } from '@relayflows/core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLOUD_CWD = path.resolve(__dirname, '..');
const RELAY_CWD = path.resolve(__dirname, '../../relay');

const SANDBOX_AUTH_PATH = 'packages/core/src/auth/sandbox-auth.ts';
const NEW_TEST_PATH = 'tests/build-remote-auth-command.unit.ts';

async function main() {
  const result = await workflow('fix-cloud-connect-hang')
    .description(
      'Fix PATH-propagation bug in sandbox-auth remote command builder + add regression tests'
    )
    .pattern('dag')
    .channel('wf-fix-cloud-connect-hang')
    .maxConcurrency(3)
    .timeout(2_700_000)

    .agent('impl', {
      cli: 'claude',
      role: 'Implementer — refactors sandbox-auth.ts and writes the fix',
      model: 'sonnet',
      retries: 2,
    })
    .agent('tester', {
      cli: 'claude',
      role: 'Test author — writes unit tests and iterates until green',
      model: 'sonnet',
      retries: 2,
    })
    .agent('investigator', {
      cli: 'codex',
      role: 'Investigator — reads relay/src/cli/lib/ssh-interactive.ts and reports claude-hang hypotheses',
      model: 'o3',
      retries: 1,
    })

    // ── Phase 0: Read state ──────────────────────────────────────────
    .step('read-sandbox-auth', {
      type: 'deterministic',
      command: `cat ${SANDBOX_AUTH_PATH}`,
      captureOutput: true,
    })

    .step('read-ssh-interactive', {
      type: 'deterministic',
      command: `cat ${RELAY_CWD}/src/cli/lib/ssh-interactive.ts || echo "RELAY_NOT_PRESENT"`,
      captureOutput: true,
    })

    // ── Phase 1: Investigate claude-hang (relay side) — advisory only ─
    .step('investigate-claude-hang', {
      agent: 'investigator',
      dependsOn: ['read-ssh-interactive'],
      timeoutMs: 300_000,
      task: `Post to #wf-fix-cloud-connect-hang.

Context: \`agent-relay cloud connect anthropic\` prints "Starting interactive authentication..." and then hangs with ZERO further output. Claude is preinstalled on the Daytona base image so the PATH-prefix bug does NOT apply.

Read \`${RELAY_CWD}/src/cli/lib/ssh-interactive.ts\` (especially the sshClient.shell() callback around line 180) and identify up to 3 concrete hypotheses for why the claude TUI emits no data. Consider:
  1. Order of stream.write('cmd; exit $?\\n') vs attaching stream.on('data')
  2. Whether ssh2 ClientChannel buffers data before a 'data' listener is attached
  3. PTY dimensions / TERM env not matching what Ink-based TUIs expect
  4. Bash prompt race: command written before shell is ready to process it

For each hypothesis, suggest a concrete diagnostic patch (extra logging, or a small code change) that could be applied in a follow-up PR against the relay repo.

This investigation is advisory. We are NOT changing relay in this workflow. End with HYPOTHESES and a numbered list. The follow-up PR against relay will reference this output.`,
      verification: { type: 'output_contains', value: 'HYPOTHESES' },
    })

    // ── Phase 2: Extract buildRemoteAuthCommand ──────────────────────
    .step('extract-builder', {
      agent: 'impl',
      dependsOn: ['read-sandbox-auth'],
      timeoutMs: 600_000,
      task: `Edit \`${SANDBOX_AUTH_PATH}\`.

Current remote-command building logic (inside \`createAuthSandbox\`, around lines 167-178):

\`\`\`ts
const primaryCmd = [providerConfig.command, ...providerConfig.args]
  .map(shellEscape)
  .join(" ");
const fallbackCmd =
  provider === "cursor"
    ? \`command -v agent >/dev/null 2>&1 && \${primaryCmd} || cursor-agent \${providerConfig.args.map(shellEscape).join(" ")}\`
    : primaryCmd;
const installGuard = providerConfig.installCommand
  ? \`command -v \${providerConfig.command} >/dev/null 2>&1 || (\${providerConfig.installCommand}); \`
  : "";
const remoteCommand = \`PATH=\${home}/.local/bin:/home/workspace/.local/bin:$PATH \${installGuard}\${fallbackCmd}\`;
\`\`\`

Bug: \`VAR=value cmd\` only applies to the immediately-following simple command. So PATH is set for \`command -v codex\` but NOT for \`(npm install -g @openai/codex)\` or the trailing \`codex login\`.

Required changes:
1. Add a new exported pure function at module top-level (above createAuthSandbox):
   \`\`\`ts
   export interface BuildRemoteAuthCommandOptions {
     provider: string;
     providerConfig: {
       command: string;
       args: readonly string[];
       installCommand?: string;
     };
     home: string;
   }

   export function buildRemoteAuthCommand(options: BuildRemoteAuthCommandOptions): string {
     // implementation — see contract below
   }
   \`\`\`

2. Contract (IMPORTANT — the tests will check these exact properties):
   - Must \`export PATH=<home>/.local/bin:/home/workspace/.local/bin:$PATH\` as the FIRST statement
     using \`export PATH=...\` (not \`PATH=... cmd\` prefix form).
   - Must chain statements with \`; \` (or \`&&\`) so PATH propagates.
   - For providers WITH installCommand: \`command -v <cmd> >/dev/null 2>&1 || <installCommand>; exec <fallbackCmd>\`
   - For providers WITHOUT installCommand: just \`exec <fallbackCmd>\`
   - \`exec\` replaces the shell process with the CLI so no trailing shell-exit race.
   - Preserve the existing cursor fallback (\`command -v agent ... && ... || cursor-agent ...\`).
   - Use the existing shellEscape helper where relevant.

3. Replace the inline logic in \`createAuthSandbox\` with a single call:
   \`\`\`ts
   const remoteCommand = buildRemoteAuthCommand({
     provider,
     providerConfig,
     home,
   });
   \`\`\`

4. Do NOT change any other function or type. Do not add logging. Keep the diff small.

Write the edit now. When done, end your message with EDIT_DONE.`,
      verification: { type: 'output_contains', value: 'EDIT_DONE' },
    })

    .step('verify-extract', {
      type: 'deterministic',
      dependsOn: ['extract-builder'],
      command: [
        `git diff --quiet ${SANDBOX_AUTH_PATH} && (echo "NOT MODIFIED"; exit 1) || true`,
        `grep -q 'export function buildRemoteAuthCommand' ${SANDBOX_AUTH_PATH} || (echo "MISSING buildRemoteAuthCommand export"; exit 1)`,
        `grep -q 'buildRemoteAuthCommand(' ${SANDBOX_AUTH_PATH} || (echo "NOT CALLED from createAuthSandbox"; exit 1)`,
        `grep -q 'export PATH=' ${SANDBOX_AUTH_PATH} || (echo "MISSING export PATH= — still using prefix form"; exit 1)`,
        `echo OK`,
      ].join('\n'),
      failOnError: true,
      captureOutput: true,
    })

    // ── Phase 3: Write regression tests ──────────────────────────────
    .step('write-tests', {
      agent: 'tester',
      dependsOn: ['verify-extract'],
      timeoutMs: 600_000,
      task: `Create a new unit test file at \`${NEW_TEST_PATH}\`.

Import the new exported function:
\`\`\`ts
import { buildRemoteAuthCommand } from '../packages/core/src/auth/sandbox-auth.js';
\`\`\`

Use Node's built-in test runner (\`node:test\` + \`node:assert/strict\`). Pattern to match existing tests/cli-auth.unit.ts.

Write these test cases. Each one asserts literal substrings — do NOT use \\s in greps; use literal strings.

1. **anthropic** (no install guard):
   \`\`\`ts
   const cmd = buildRemoteAuthCommand({
     provider: 'anthropic',
     providerConfig: { command: 'claude', args: [] },
     home: '/home/daytona',
   });
   assert.ok(cmd.startsWith('export PATH=/home/daytona/.local/bin:/home/workspace/.local/bin:$PATH'));
   assert.ok(cmd.includes('exec claude'));
   // Must NOT use the old prefix form
   assert.equal(cmd.includes('PATH=/home/daytona/.local/bin:/home/workspace/.local/bin:$PATH command -v'), false);
   assert.equal(cmd.includes('PATH=/home/daytona/.local/bin:/home/workspace/.local/bin:$PATH claude'), false);
   \`\`\`

2. **openai — PATH propagation regression test** (this one catches the bug):
   \`\`\`ts
   const cmd = buildRemoteAuthCommand({
     provider: 'openai',
     providerConfig: {
       command: 'codex',
       args: ['login'],
       installCommand: 'npm install -g @openai/codex',
     },
     home: '/home/daytona',
   });
   // PATH is exported as a top-level shell statement
   assert.ok(cmd.startsWith('export PATH='));
   // Install guard present
   assert.ok(cmd.includes('command -v codex'));
   assert.ok(cmd.includes('npm install -g @openai/codex'));
   // CRITICAL: codex login must be reached AFTER the install guard and
   // the final CLI is exec'd (so it inherits the exported PATH)
   assert.ok(cmd.includes('exec codex login'));
   // Anti-regression: the broken form had 'PATH=... command -v codex' as a
   // prefix, which only scoped PATH to the test and not to codex login itself.
   assert.equal(
     /PATH=[^;\\n]+\\s+command -v codex/.test(cmd),
     false,
     'remote command must not use single-command PATH= prefix form',
   );
   \`\`\`

3. **cursor fallback preserved**:
   \`\`\`ts
   const cmd = buildRemoteAuthCommand({
     provider: 'cursor',
     providerConfig: { command: 'agent', args: ['login'] },
     home: '/home/daytona',
   });
   assert.ok(cmd.includes('command -v agent'));
   assert.ok(cmd.includes('cursor-agent login'));
   \`\`\`

4. **home dir is substituted literally**:
   \`\`\`ts
   const cmd = buildRemoteAuthCommand({
     provider: 'anthropic',
     providerConfig: { command: 'claude', args: [] },
     home: '/root',
   });
   assert.ok(cmd.includes('/root/.local/bin'));
   \`\`\`

Write the file now. End your message with TESTS_WRITTEN.`,
      verification: { type: 'file_exists', value: NEW_TEST_PATH },
    })

    .step('verify-tests-written', {
      type: 'deterministic',
      dependsOn: ['write-tests'],
      command: [
        `test -f ${NEW_TEST_PATH} || (echo "MISSING test file"; exit 1)`,
        `grep -q 'buildRemoteAuthCommand' ${NEW_TEST_PATH} || (echo "test file does not import builder"; exit 1)`,
        `grep -q 'exec codex login' ${NEW_TEST_PATH} || (echo "missing exec codex login assertion"; exit 1)`,
        `grep -q 'export PATH=' ${NEW_TEST_PATH} || (echo "missing export PATH= assertion"; exit 1)`,
        `echo OK`,
      ].join('\n'),
      failOnError: true,
      captureOutput: true,
    })

    // ── Phase 4: Test-fix-rerun loop ─────────────────────────────────
    .step('run-tests', {
      type: 'deterministic',
      dependsOn: ['verify-tests-written'],
      command: `npx tsx --test ${NEW_TEST_PATH} 2>&1 | tail -80`,
      captureOutput: true,
      failOnError: false,
    })

    .step('fix-tests', {
      agent: 'impl',
      dependsOn: ['run-tests'],
      timeoutMs: 600_000,
      task: `Test output from \`npx tsx --test ${NEW_TEST_PATH}\`:

{{steps.run-tests.output}}

If ALL tests passed, do nothing and end your message with ALL_GREEN.

If there are failures, decide whether the bug is in:
  (a) the builder function in ${SANDBOX_AUTH_PATH}, or
  (b) the test assertions in ${NEW_TEST_PATH}.

The openai test is a regression test for the real bug — if it fails because the command doesn't contain \`exec codex login\` or doesn't start with \`export PATH=\`, the builder is wrong. Fix the builder, not the test.

Re-run: \`npx tsx --test ${NEW_TEST_PATH}\`
Iterate until every test passes. End with ALL_GREEN when done.`,
      verification: { type: 'exit_code' },
    })

    .step('run-tests-final', {
      type: 'deterministic',
      dependsOn: ['fix-tests'],
      command: `npx tsx --test ${NEW_TEST_PATH} 2>&1`,
      captureOutput: true,
      failOnError: true,
    })

    // ── Phase 5: Typecheck + regression check ────────────────────────
    .step('typecheck', {
      type: 'deterministic',
      dependsOn: ['run-tests-final'],
      command: `npx tsc --noEmit 2>&1 | tail -40; echo "EXIT: $?"`,
      captureOutput: true,
      failOnError: false,
    })

    .step('fix-typecheck', {
      agent: 'impl',
      dependsOn: ['typecheck'],
      timeoutMs: 600_000,
      task: `Type check output:
{{steps.typecheck.output}}

If EXIT: 0, do nothing and end with TYPECHECK_OK.
If there are type errors in files we touched (${SANDBOX_AUTH_PATH} or ${NEW_TEST_PATH}), fix them. Do NOT touch unrelated files. Re-run \`npx tsc --noEmit\` to confirm. End with TYPECHECK_OK.`,
      verification: { type: 'exit_code' },
    })

    .step('typecheck-final', {
      type: 'deterministic',
      dependsOn: ['fix-typecheck'],
      command: `npx tsc --noEmit 2>&1 | tail -40`,
      captureOutput: true,
      failOnError: true,
    })

    .step('existing-unit-tests', {
      type: 'deterministic',
      dependsOn: ['typecheck-final'],
      command: `npx tsx --test tests/cli-auth.unit.ts 2>&1 | tail -40`,
      captureOutput: true,
      failOnError: false,
    })

    .step('fix-regressions', {
      agent: 'impl',
      dependsOn: ['existing-unit-tests'],
      timeoutMs: 600_000,
      task: `Existing CliAuth unit test output:
{{steps.existing-unit-tests.output}}

If all existing tests still pass, do nothing and end with NO_REGRESSIONS.
If we broke something with the refactor, fix it. Most likely: import/export drift, or we accidentally changed a type. End with NO_REGRESSIONS.`,
      verification: { type: 'exit_code' },
    })

    .step('existing-unit-tests-final', {
      type: 'deterministic',
      dependsOn: ['fix-regressions'],
      command: `npx tsx --test tests/cli-auth.unit.ts 2>&1`,
      captureOutput: true,
      failOnError: true,
    })

    // ── Phase 6: Summary ─────────────────────────────────────────────
    .step('summary', {
      type: 'deterministic',
      dependsOn: ['existing-unit-tests-final'],
      command: [
        `echo "=== Files changed ==="`,
        `git status --short ${SANDBOX_AUTH_PATH} ${NEW_TEST_PATH}`,
        `echo ""`,
        `echo "=== Diff summary ==="`,
        `git diff --stat ${SANDBOX_AUTH_PATH} ${NEW_TEST_PATH}`,
        `echo ""`,
        `echo "All tests green. Review the diff, then commit and open a PR."`,
      ].join('\n'),
      captureOutput: true,
      failOnError: false,
    })

    .onError('retry', { maxRetries: 1, retryDelayMs: 5_000 })
    .run({ cwd: CLOUD_CWD });

  console.log('Workflow status:', result.status);
  console.log('Steps completed:', Object.keys(result.steps || {}));
  process.exit(result.status === 'completed' ? 0 : 1);
}

main().catch((error) => {
  console.error('Workflow failed:', error);
  process.exit(1);
});
