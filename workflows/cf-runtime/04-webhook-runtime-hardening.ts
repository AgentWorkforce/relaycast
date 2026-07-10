// W4: harden @agent-assistant/webhook-runtime for multi-persona use, AND
// formalize the persona contract (parse<Surface>Webhook + run<Persona>Turn)
// + confirm SlackEventDedupGate's home and export story.
//
// Runs in parallel with W1. Scope: small-medium. Goals:
//   1. Ensure the Slack parser in webhook-runtime can be consumed by both
//      the Node HTTP runtime AND the new CF cloudflare-runtime package.
//   2. Document the persona contract (parse/run two-function shape) in the
//      webhook-runtime README as the sanctioned pattern for sage, nightcto,
//      my-senior-dev, and future personas.
//   3. Confirm (or relocate) the home of SlackEventDedupGate. Today it lives
//      in @agent-assistant/surfaces; evaluate whether webhook-runtime is a
//      better home. Either way, leave a re-export so the cloudflare-runtime
//      import path is stable.
//
// Target repo: agent-assistant
// Branch: chore/webhook-runtime-multipersona
// Base: main (W4 is independent of W0-W3).

import { workflow } from '@relayflows/core';
import { applyWorktreeSetup, inWorktree, pushAndOpenPrStep } from './lib/worktree-setup.ts';

const REPO_PATH = '/Users/khaliqgant/Projects/AgentWorkforce/agent-assistant';
const BRANCH = 'chore/webhook-runtime-multipersona';
const REPO_SLUG = 'AgentWorkforce/agent-assistant';
const WORKTREE_PATH = `${REPO_PATH}/../.cf-runtime-worktrees/chore-webhook-runtime-multipersona`;

async function runWorkflow() {
  let wf = workflow('cf-runtime-04-webhook-runtime-hardening')
    .description('Audit @agent-assistant/webhook-runtime for sage-specific coupling and factor so the new cloudflare-runtime package can reuse parseSlackEvent and types cleanly. Small patch release.')
    .pattern('dag')
    .channel('wf-cf-runtime-04')
    .maxConcurrency(3)
    .timeout(1_800_000)

    .agent('lead', {
      cli: 'claude',
      role: 'Lead. Audits webhook-runtime for persona-specific coupling. Drives small, surgical fixes only — this is a patch release, not a redesign.',
      retries: 1,
    })
    .agent('impl', {
      cli: 'codex',
      role: 'Implementer. Applies the surgical fixes the lead identifies. One file per edit step.',
      retries: 2,
    })
    .agent('tester', {
      cli: 'claude',
      preset: 'worker',
      role: 'Runs existing tests, adds any new test the lead says is needed.',
      retries: 2,
    })
    .agent('reviewer', {
      cli: 'claude',
      preset: 'reviewer',
      role: 'Reviews diff for scope creep. Rejects anything beyond what the audit called for.',
      retries: 1,
    });

  wf = applyWorktreeSetup(wf, {
    repoLabel: 'agent-assistant',
    repoPath: REPO_PATH,
    branch: BRANCH,
    worktreePath: WORKTREE_PATH,
    expectedDirty: [
      'packages/webhook-runtime/src/slack-parser.ts',
      'packages/webhook-runtime/src/types.ts',
      'packages/webhook-runtime/src/index.ts',
      'packages/webhook-runtime/package.json',
      'package.json',
      'package-lock.json',
    ],
  });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('read-spec', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: 'cat workflows/cf-runtime/SPEC.md',
      captureOutput: true,
      failOnError: true,
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('read-webhook-runtime', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: inWorktree(
        WORKTREE_PATH,
        [
          'echo "=== package.json ===" && cat packages/webhook-runtime/package.json',
          'echo "=== src tree ===" && find packages/webhook-runtime/src -type f',
          'echo "=== slack-parser.ts ===" && cat packages/webhook-runtime/src/slack-parser.ts',
          'echo "=== types.ts ===" && cat packages/webhook-runtime/src/types.ts',
          'echo "=== index.ts ===" && cat packages/webhook-runtime/src/index.ts',
          'echo "=== specialist-bridge.ts head ===" && head -60 packages/webhook-runtime/src/specialist-bridge.ts',
        ].join(' && '),
      ),
      captureOutput: true,
      failOnError: true,
    });

  // Lead audits and writes AUDIT.md.
  const auditTask = [
    'You are the lead on #wf-cf-runtime-04.',
    '',
    `Worktree: ${WORKTREE_PATH}.`,
    '',
    'Audit @agent-assistant/webhook-runtime for multi-persona fitness and write',
    'AUDIT-04.md with sections:',
    '  ## Findings',
    '  ## Recommended surgical fixes',
    '  ## Out of scope (explicitly)',
    '  ## Persona contract doc',
    '  ## SlackEventDedupGate home decision',
    '',
    'Specifically look for:',
    '  [reusability] sage-specific constants (MAX_REPLY_CHARS, channel naming) that should',
    '     be parameterized; Node-only API assumptions that block Workers reuse; parseSlackEvent',
    '     signature — does it accept raw body + headers, or does it assume Hono context?',
    '  [persona contract] Can multiple personas share the same webhook-runtime primitives?',
    '     Does NormalizedWebhook carry enough persona identity? The contract we want to',
    '     formalize: each persona package exports',
    '        parse<Surface>Webhook(req, env): Promise<ParseResult>',
    '        run<Persona>Turn(descriptor, env, ctx): Promise<void>',
    '     and a TurnDescriptor type. Document this contract in',
    '     packages/webhook-runtime/README.md as the sanctioned pattern. Reference sage\'s',
    '     W0 change (the sage repo is getting parseSlackWebhook + runSageTurn) as the',
    '     first example.',
    '  [dedup home] SlackEventDedupGate is at packages/surfaces/src/slack-event-dedup.ts',
    '     today. Decide: stay there + re-export from webhook-runtime (simplest, backward',
    '     compat); or move to webhook-runtime + re-export stub from surfaces with',
    '     deprecation note (cleaner home, surfaces is arguably the wrong layer). Write',
    '     the decision and a tiny migration plan in the "SlackEventDedupGate home',
    '     decision" section. If the decision is "relocate," the surgical fix is in scope.',
    '     If the decision is "stay," the only change is a re-export from webhook-runtime',
    '     (trivial).',
    '',
    'Keep fixes SMALL. This is a patch release, not a redesign. If a fix is >50 LOC or needs',
    'an API break, put it in "Out of scope" and note it requires a separate workflow.',
    '',
    'Source:',
    '{{steps.read-webhook-runtime.output}}',
    '',
    'SPEC:',
    '{{steps.read-spec.output}}',
  ].join('\n');

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('audit', {
      agent: 'lead',
      dependsOn: ['read-spec', 'read-webhook-runtime'],
      task: auditTask,
      verification: { type: 'file_exists', value: `${WORKTREE_PATH}/AUDIT-04.md` },
    });

  // Verify audit landed.
  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('verify-audit', {
      type: 'deterministic',
      dependsOn: ['audit'],
      command: inWorktree(WORKTREE_PATH, 'test -f AUDIT-04.md && grep -Eq "Findings|Recommended" AUDIT-04.md && cat AUDIT-04.md | head -60'),
      captureOutput: true,
      failOnError: true,
    });

  // Implementer applies the surgical fixes.
  const implTask = [
    'You are impl on #wf-cf-runtime-04.',
    '',
    `Worktree: ${WORKTREE_PATH}.`,
    '',
    `Read AUDIT-04.md in the worktree and apply ONLY the "Recommended surgical fixes" section.`,
    'Do NOT touch anything in "Out of scope".',
    '',
    'Rules:',
    '  - One file per commit-step. Verify with git diff after each edit.',
    '  - If a fix would go beyond patch-scope (~50 LOC or an API break), stop and post',
    '    on channel — the lead will decide whether to expand scope.',
    '  - Bump packages/webhook-runtime/package.json version patch (e.g. 0.1.3 -> 0.1.4).',
    '',
    'Run `cd packages/webhook-runtime && npx tsc --noEmit` and `npx vitest run` after each',
    'edit to catch regressions immediately.',
    '',
    'When done, post "IMPL_04_DONE" on channel with the diff summary.',
  ].join('\n');

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('implement', {
      agent: 'impl',
      dependsOn: ['verify-audit'],
      task: implTask,
      verification: { type: 'exit_code' },
    });

  // Guard: if no fixes were needed, allow commit-less no-op path.
  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('check-changes', {
      type: 'deterministic',
      dependsOn: ['implement'],
      command: inWorktree(
        WORKTREE_PATH,
        'if [ -z "$(git status --porcelain)" ]; then echo NO_CHANGES_NEEDED; else git status --porcelain; echo HAS_CHANGES; fi',
      ),
      captureOutput: true,
      failOnError: true,
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('typecheck', {
      type: 'deterministic',
      dependsOn: ['check-changes'],
      command: inWorktree(WORKTREE_PATH, 'cd packages/webhook-runtime && npx tsc --noEmit 2>&1 | tail -40; echo EXIT: $?'),
      captureOutput: true,
      failOnError: false,
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('fix-typecheck', {
      agent: 'impl',
      dependsOn: ['typecheck'],
      task: [
        'Fix typecheck errors. Output:',
        '{{steps.typecheck.output}}',
        `Worktree: ${WORKTREE_PATH}.`,
      ].join('\n'),
      verification: { type: 'exit_code' },
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('run-tests', {
      type: 'deterministic',
      dependsOn: ['fix-typecheck'],
      command: inWorktree(WORKTREE_PATH, 'cd packages/webhook-runtime && npx vitest run 2>&1 | tail -60'),
      captureOutput: true,
      failOnError: false,
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('fix-tests', {
      agent: 'tester',
      dependsOn: ['run-tests'],
      task: [
        'Fix test failures and add regression tests for any behavior we changed.',
        'Output:',
        '{{steps.run-tests.output}}',
        '',
        `Worktree: ${WORKTREE_PATH}. Only edit packages/webhook-runtime/.`,
        'Read AUDIT-04.md to understand what changed and why.',
      ].join('\n'),
      verification: { type: 'exit_code' },
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('run-tests-final', {
      type: 'deterministic',
      dependsOn: ['fix-tests'],
      command: inWorktree(WORKTREE_PATH, 'cd packages/webhook-runtime && npx vitest run'),
      captureOutput: true,
      failOnError: true,
    });

  const reviewTask = [
    'Review the webhook-runtime diff. Enforce NO SCOPE CREEP.',
    '',
    `Worktree: ${WORKTREE_PATH}.`,
    '',
    'Run:',
    `  cd ${WORKTREE_PATH} && git diff origin/main...HEAD -- packages/webhook-runtime/`,
    `  cat ${WORKTREE_PATH}/AUDIT-04.md`,
    '',
    'Verify:',
    '  - Every diff line maps to a "Recommended surgical fix" in AUDIT-04.md.',
    '  - No changes to anything in the "Out of scope" section.',
    '  - Package version is bumped.',
    '  - Existing tests still pass; new tests exist for new behavior.',
    '',
    'Write VERDICT-04.md with KEEP | PAUSE. If the diff is empty (no fixes needed), still',
    'write VERDICT-04.md with KEEP + a note "no changes required".',
  ].join('\n');

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('review', {
      agent: 'reviewer',
      dependsOn: ['run-tests-final'],
      task: reviewTask,
      verification: { type: 'file_exists', value: `${WORKTREE_PATH}/VERDICT-04.md` },
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('verify-verdict', {
      type: 'deterministic',
      dependsOn: ['review'],
      command: [
        `cd ${JSON.stringify(WORKTREE_PATH)}`,
        'grep -Eqi "(^|[*#[:space:]])verdict:?[[:space:]]*keep" VERDICT-04.md || (cat VERDICT-04.md; exit 1)',
        'echo VERDICT_KEEP',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    });

  // Commit + PR — but skip if no changes.
  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('commit-or-skip', {
      type: 'deterministic',
      dependsOn: ['verify-verdict'],
      command: inWorktree(
        WORKTREE_PATH,
        [
          'set -e',
          'if [ -z "$(git diff --cached --stat)" ] && [ -z "$(git status --porcelain packages/webhook-runtime)" ]; then echo NO_CHANGES_TO_COMMIT; exit 0; fi',
          'git add packages/webhook-runtime',
          'git add package.json package-lock.json 2>/dev/null || true',
          'MSG=$(mktemp)',
          'printf "%s\\n" "chore(webhook-runtime): harden for multi-persona reuse" "" "Small surgical fixes from the cf-runtime audit (AUDIT-04.md) so the new" "@agent-assistant/cloudflare-runtime package can reuse parseSlackEvent and" "types without sage-specific coupling." "" "No API breaks. Patch release." > "$MSG"',
          'git commit -F "$MSG"',
          'rm -f "$MSG"',
        ].join(' && '),
      ),
      captureOutput: true,
      failOnError: true,
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('open-pr-or-skip', {
      type: 'deterministic',
      dependsOn: ['commit-or-skip'],
      command: inWorktree(
        WORKTREE_PATH,
        [
          'set -e',
          'if ! git log origin/main..HEAD --oneline | grep -q .; then echo NO_PR_NEEDED; exit 0; fi',
          `git push -u origin ${JSON.stringify(BRANCH)}`,
          'BODY=$(mktemp)',
          `printf "%s\\n" "## Summary" "W4 of the cf-runtime bundle. Small audit-driven fixes to @agent-assistant/webhook-runtime so the new cloudflare-runtime package can reuse it cleanly across sage / nightcto / future personas." "" "Scope is intentionally tiny — audit-driven patches only. See AUDIT-04.md on the branch for the full list." "" "## Test evidence" "- \\\`npx vitest run\\\` in packages/webhook-runtime/ — all green." "- VERDICT-04.md: KEEP." "" "## Order" "Independent of W1/W2/W3 — any merge order is fine." > "$BODY"`,
          `gh pr create --repo ${JSON.stringify(REPO_SLUG)} --base main --head ${JSON.stringify(BRANCH)} --title "chore(webhook-runtime): harden for multi-persona reuse" --body-file "$BODY" --label cf-runtime | tee /tmp/pr-url-04.txt`,
          'rm -f "$BODY"',
          'echo "PR opened:"; cat /tmp/pr-url-04.txt',
        ].join(' && '),
      ),
      captureOutput: true,
      failOnError: true,
    });

  const result = await wf.run({ cwd: process.cwd() });
  console.log('Workflow status:', result.status);
}

runWorkflow().catch((error) => {
  console.error(error);
  process.exit(1);
});
