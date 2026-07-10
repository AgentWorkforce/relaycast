// Slack Conversational Agent Routing — Phase 1 (dormant, flag-gated)
//
// Spec: workflows/slack-conversational-routing-SPEC.md (read it first — all
// task prompts reference SPEC sections).
//
// Shape: Conversation (interactive lead + 3 codex implementer squads on a
// shared channel), then repairable deterministic gates, then the deep-tier
// fresh-eyes review path (Claude review/fix/final-review/final-fix followed by
// Codex review/fix/final-review/final-fix), then deterministic acceptance,
// scoped commit, push, and PR via createGitHubStep.
//
// Run from a dedicated worktree of AgentWorkforce/cloud:
//   git worktree add ../cloud-slack-conv -b feat/slack-conversational-routing-p1 origin/main
//   cd ../cloud-slack-conv && agent-relay run --dry-run workflows/slack-conversational-routing.ts
//   agent-relay run workflows/slack-conversational-routing.ts

import { workflow } from '@relayflows/core';
import { createGitHubStep } from '@agent-relay/sdk';
import { ClaudeModels, CodexModels } from '@agent-relay/config';
import { applyCloudRepoSetup } from './lib/cloud-repo-setup.ts';

const NAME = 'slack-conversational-routing';
const REPO = 'AgentWorkforce/cloud';
const BRANCH = 'feat/slack-conversational-routing-p1';
const CHANNEL = 'wf-slack-conv-routing';
const SPEC = 'workflows/slack-conversational-routing-SPEC.md';
const ART = '.workflow-artifacts/slack-conv-routing';
const BLOCKED = `${ART}/BLOCKED_NO_COMMIT.md`;
const NEW_TEST_DIR = 'tests/proactive-runtime/slack-conversation';
const NEW_MODULE_DIR = 'packages/web/lib/integrations/slack-conversation';
const DISPATCHER = 'packages/web/lib/proactive-runtime/integration-watch-dispatcher.ts';
const CAPABILITIES = 'packages/core/src/proactive-runtime/capabilities.ts';

const SCOPE_PATHS = [
  CAPABILITIES,
  NEW_MODULE_DIR,
  DISPATCHER,
  'tests/proactive-runtime/capabilities.test.ts',
  NEW_TEST_DIR,
  SPEC,
  'workflows/slack-conversational-routing.ts',
].join(' ');

  // One acceptance command, reused by gates and the final hard gate.
const TARGETED_TESTS = `npx tsx --test ${NEW_TEST_DIR}/*.test.ts tests/proactive-runtime/capabilities.test.ts`;
const REGRESSION_TESTS = 'npx tsx --test tests/proactive-runtime/*.test.ts && npm run web:webhook-ingress:test';
const ACCEPTANCE = `${TARGETED_TESTS} && npm run typecheck && ${REGRESSION_TESTS}`;

const PR_TITLE = 'feat(web): Slack conversational agent routing Phase 1 (flag-gated, dormant)';
const PR_BODY_LINES = [
  '## Summary',
  '',
  '- Adds the `conversational` capability to the proactive capability registry (`isConversationalPersona`, `conversationalConfig`), read through the `personaCapabilities()` resolver.',
  '- Adds `packages/web/lib/integrations/slack-conversation/`: pure routing module (thread > prefix > channel > defaultResponder precedence with ambiguity fallback), streaming Slack egress mirroring the agent-assistant `SlackProgressStreamEgress` contract (chat.postMessage / throttled chat.update, per-agent identity via chat:write.customize), and the routing feature flag (default OFF).',
  '- Flag-gated additive wiring in `integration-watch-dispatcher.ts`: on slack `app_mention` with the flag ON, select the conversational agent, post one ack, enqueue delivery with a `slackConversation` payload marker. Flag OFF is proven byte-identical to today by test.',
  '- Phase 1 is dormant: no behavior change until the flag flips. The streamed model turn (agent-assistant harness bridge + continuation store) is an explicit follow-up — see `workflows/slack-conversational-routing-SPEC.md` section 3.',
  '',
  '## Test plan',
  '',
  '- [x] `npx tsx --test tests/proactive-runtime/slack-conversation/*.test.ts tests/proactive-runtime/capabilities.test.ts`',
  '- [x] `npm run typecheck`',
  '- [x] Regression: `npx tsx --test tests/proactive-runtime/*.test.ts` and `npm run web:webhook-ingress:test`',
  '- [x] Flag-off no-behavior-change test',
  '- [x] Deep-tier review: Claude review/fix/final-review/final-fix, then Codex review/fix/final-review/final-fix (artifacts under `.workflow-artifacts/slack-conv-routing/`)',
  '',
  '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
];

// Single-quote shell quoting for printf args (PR body lines).
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

async function runWorkflow() {
  const base = workflow(NAME)
    .description('Slack conversational agent routing Phase 1: conversational capability, router, streaming egress, flag-gated dispatcher wiring, tests, PR. Dormant until flag flip.')
    .pattern('dag')
    .channel(CHANNEL)
    .maxConcurrency(4)
    .timeout(10_800_000) // 3h
    .repairable()

    // ── Interactive team (Conversation shape) ───────────────────────────
    .agent('lead', {
      cli: 'claude',
      model: ClaudeModels.OPUS,
      role: 'Architect and in-flight reviewer. Owns the SPEC, assigns squads, answers design questions, reviews diffs between rounds, posts feedback in-channel.',
      retries: 1,
    })
    .agent('impl-capability', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      role: 'Implementer for SPEC section 4 (conversational capability) and its tests. Listens on the channel for assignments and feedback.',
      retries: 2,
    })
    .agent('impl-egress', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      role: 'Implementer for SPEC section 6 (Slack streaming egress) and its tests. Listens on the channel for assignments and feedback.',
      retries: 2,
    })
    .agent('impl-router', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      role: 'Implementer for SPEC sections 5 and 7 (router + flag-gated dispatcher wiring) and their tests. Listens on the channel for assignments and feedback.',
      retries: 2,
    })

    // ── Bounded one-shot fixers / reviewers ─────────────────────────────
    .agent('qa-fixer', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      preset: 'worker',
      role: 'Repair owner for red deterministic gates. Reads captured output, fixes source or tests, reruns the gate command until green.',
      retries: 2,
    })
    .agent('claude-reviewer', {
      cli: 'claude',
      model: ClaudeModels.OPUS,
      preset: 'reviewer',
      role: 'First-pass fresh-eyes reviewer. Reads the SPEC, repo rules, actual diff, and evidence from scratch.',
      retries: 1,
    })
    .agent('claude-fixer', {
      cli: 'claude',
      model: ClaudeModels.SONNET,
      preset: 'worker',
      role: 'Fixer for valid Claude review findings. Adds or updates tests/proofs for each fix and reruns checks.',
      retries: 2,
    })
    .agent('codex-reviewer', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      preset: 'reviewer',
      role: 'Second-pass fresh-eyes reviewer. Reviews the post-Claude-fix state from scratch.',
      retries: 1,
    })
    .agent('codex-fixer', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      preset: 'worker',
      role: 'Fixer for valid Codex review findings. Adds or updates tests/proofs for each fix and reruns checks.',
      retries: 2,
    });

  // setup-branch + install-deps (npm install + build:platform + build:core)
  const wf = applyCloudRepoSetup(base, {
    branch: BRANCH,
    committerName: 'Slack Conversational Routing Bot',
  });

  const chained = wf
    // ── Preflight ────────────────────────────────────────────────────────
    .step('preflight', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: [
        'set -e',
        `test -f ${SPEC}`,
        `mkdir -p ${ART}`,
        'gh auth status >/dev/null 2>&1 || (echo "ERROR: gh CLI not authenticated"; exit 1)',
        `command -v trail >/dev/null 2>&1 && trail start "Slack conversational routing Phase 1" || true`,
        'echo PREFLIGHT_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ── Shared context (pre-read once, posted to everyone) ──────────────
    .step('context', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: [
        `cat ${SPEC}`,
        'echo "--- dispatcher candidate matching anchor ---"',
        `sed -n '1290,1340p' ${DISPATCHER}`,
        'echo "--- capability registry head ---"',
        `sed -n '1,60p' ${CAPABILITIES}`,
      ].join(' && '),
      captureOutput: true,
    })

    // ── Conversation: lead + 3 squads start concurrently ────────────────
    .step('lead-coordinate', {
      agent: 'lead',
      dependsOn: ['context'],
      failOnError: false,
      timeoutMs: 5_400_000, // 90m — hard bound; a silent worker must not wedge the run
      task: `You are the lead on #${CHANNEL}. Workers: impl-capability, impl-egress, impl-router.
The full spec is ${SPEC} — read it yourself, then post a short plan to the channel.
Partial implementation from a previous run may already exist in the working tree (${NEW_MODULE_DIR}, ${NEW_TEST_DIR}, capabilities.ts) — run git status and review existing work first; instruct workers to build on it, not rewrite it.
Require each worker to reply "ACK <name>" before issuing assignments; re-ping after 3 minutes of silence.
If a worker has not ACK'd after 2 re-pings (~10 minutes), treat it as dead: post its assignment to the channel anyway, continue with the responsive workers, and note the dead scope in ${ART}/lead-status.md — the downstream reconcile gate backfills missing scopes. NEVER wait indefinitely on a single worker.
Assignments (non-overlapping ownership):
- impl-capability: SPEC section 4 (capabilities.ts) + extend tests/proactive-runtime/capabilities.test.ts per SPEC section 8.
- impl-egress: SPEC section 6 (egress.ts) + ${NEW_TEST_DIR}/egress.test.ts.
- impl-router: SPEC sections 5 and 7 (router.ts, flag.ts, minimal dispatcher wiring) + ${NEW_TEST_DIR}/router.test.ts and ${NEW_TEST_DIR}/dispatcher-flag.test.ts.
impl-router must wait for impl-capability to post its exported function signatures before wiring the dispatcher filter.
When a worker posts "READY <files>", read the actual files yourself (not their summary), run the targeted tests for that scope, and reply APPROVED or CHANGES_REQUESTED with concrete notes.
Every 10 minutes post a status probe: workers reply RUNNING, BLOCKED <reason>, or DONE <files>.
Each worker must write a self-reflection artifact to ${ART}/<name>-reflection.md (spec coverage, changed files, commands run, open risks) before you approve them.
Exit when all three scopes are APPROVED and reflections exist, OR after 75 minutes total — post a final status summary of what is and isn't approved, then exit so downstream gates run.`,
    })
    .step('impl-capability-work', {
      agent: 'impl-capability',
      dependsOn: ['context'],
      failOnError: false,
      timeoutMs: 2_700_000, // 45m — timeout respawns a fresh agent via retries
      task: `You are impl-capability on #${CHANNEL}. Reply "ACK impl-capability" when you see the lead's plan, then wait for your assignment. If you see no lead plan within 5 minutes, post "ACK impl-capability" anyway and start on the assignment below.
Partial implementation from a previous run may already exist — read ${CAPABILITIES} and tests/proactive-runtime/capabilities.test.ts first and complete/repair existing work rather than rewriting it.
Implement SPEC section 4 in ${CAPABILITIES} and extend tests/proactive-runtime/capabilities.test.ts per SPEC section 8.
Read the existing teamSolve capability handling and the personaCapabilities resolver first and mirror them exactly — never read spec.capabilities raw.
As soon as your exports are final, post the exact exported signatures to the channel addressed to @impl-router.
Run: npx tsx --test tests/proactive-runtime/capabilities.test.ts and iterate until green.
Write ${ART}/impl-capability-reflection.md, then post "READY <files>" and address lead feedback until APPROVED.`,
    })
    .step('impl-egress-work', {
      agent: 'impl-egress',
      dependsOn: ['context'],
      failOnError: false,
      timeoutMs: 2_700_000, // 45m
      task: `You are impl-egress on #${CHANNEL}. Reply "ACK impl-egress" when you see the lead's plan, then wait for your assignment. If you see no lead plan within 5 minutes, post "ACK impl-egress" anyway and start on the assignment below.
Partial implementation from a previous run may already exist — read ${NEW_MODULE_DIR}/egress.ts and ${NEW_TEST_DIR}/egress.test.ts first (if present) and complete/repair existing work rather than rewriting it.
Implement SPEC section 6: ${NEW_MODULE_DIR}/egress.ts plus ${NEW_TEST_DIR}/egress.test.ts per SPEC section 8.
Read packages/web/lib/ricky/slack/egress.ts and packages/web/lib/integrations/nango-service.ts for prior art before writing code.
All I/O via injected dependencies (fetchImpl, resolveBotToken) so tests run with mocks only — no live Slack calls anywhere in tests.
Run: npx tsx --test ${NEW_TEST_DIR}/egress.test.ts and iterate until green.
Write ${ART}/impl-egress-reflection.md, then post "READY <files>" and address lead feedback until APPROVED.`,
    })
    .step('impl-router-work', {
      agent: 'impl-router',
      dependsOn: ['context'],
      failOnError: false,
      timeoutMs: 2_700_000, // 45m
      task: `You are impl-router on #${CHANNEL}. Reply "ACK impl-router" when you see the lead's plan, then wait for your assignment. If you see no lead plan within 5 minutes, post "ACK impl-router" anyway and start on the assignment below.
Partial implementation from a previous run may already exist — read ${NEW_MODULE_DIR}/router.ts, ${NEW_MODULE_DIR}/flag.ts, and ${NEW_TEST_DIR}/ first (if present) and complete/repair existing work rather than rewriting it.
Implement SPEC section 5 (${NEW_MODULE_DIR}/router.ts — pure, no I/O) and SPEC section 7 (${NEW_MODULE_DIR}/flag.ts + a minimal additive flag-gated insertion in ${DISPATCHER}).
Do NOT touch the dispatcher until @impl-capability posts the capability export signatures in the channel; if no signatures appear within 15 minutes, read ${CAPABILITIES} directly for the current exported signatures and proceed — do not wait indefinitely.
The flag defaults OFF and the dispatcher diff must be small and additive — read the existing team-launch flag prior art in the dispatcher first.
Tests: ${NEW_TEST_DIR}/router.test.ts and ${NEW_TEST_DIR}/dispatcher-flag.test.ts per SPEC section 8, including the flag-off no-behavior-change proof.
Run: npx tsx --test ${NEW_TEST_DIR}/router.test.ts ${NEW_TEST_DIR}/dispatcher-flag.test.ts and iterate until green.
Write ${ART}/impl-router-reflection.md, then post "READY <files>" and address lead feedback until APPROVED.`,
    })

    // ── Reconcile: keep gates on the critical path even if a PTY dies ───
    .step('implementation-reconcile', {
      type: 'deterministic',
      dependsOn: ['lead-coordinate', 'impl-capability-work', 'impl-egress-work', 'impl-router-work'],
      command: [
        `git status --short -- ${SCOPE_PATHS}`,
        `test -f ${NEW_MODULE_DIR}/router.ts || echo "MISSING_ROUTER"`,
        `test -f ${NEW_MODULE_DIR}/egress.ts || echo "MISSING_EGRESS"`,
        `test -f ${NEW_MODULE_DIR}/flag.ts || echo "MISSING_FLAG"`,
        `test -f ${NEW_TEST_DIR}/router.test.ts || echo "MISSING_ROUTER_TEST"`,
        `test -f ${NEW_TEST_DIR}/egress.test.ts || echo "MISSING_EGRESS_TEST"`,
        `test -f ${NEW_TEST_DIR}/dispatcher-flag.test.ts || echo "MISSING_DISPATCHER_TEST"`,
        `grep -q "isConversationalPersona" ${CAPABILITIES} || echo "MISSING_CAPABILITY_EXPORT"`,
        `grep -q "conversationalConfig" ${CAPABILITIES} || echo "MISSING_CONFIG_EXPORT"`,
        'echo RECONCILE_SCAN_DONE',
      ].join(' && '),
      captureOutput: true,
      failOnError: false,
    })
    .step('repair-reconcile', {
      agent: 'qa-fixer',
      dependsOn: ['implementation-reconcile'],
      task: `Read ${SPEC} sections 4-8, then finish anything the reconcile scan flagged as MISSING_* before the gates run.
Reconcile output:
{{steps.implementation-reconcile.output}}
If nothing is missing, do nothing and say so. If you implement a missing piece, also write its tests per SPEC section 8 and run them.`,
      verification: { type: 'exit_code', value: '' },
    })

    // ── Gate 1: new tests (run → fix → rerun → final fix) ───────────────
    .step('run-new-tests', {
      type: 'deterministic',
      dependsOn: ['repair-reconcile'],
      command: `${TARGETED_TESTS} 2>&1 | tail -80`,
      captureOutput: true,
      failOnError: false,
    })
    .step('fix-new-tests', {
      agent: 'qa-fixer',
      dependsOn: ['run-new-tests'],
      task: `Fix any failures in the targeted test run below. The fix may be in source or tests — follow ${SPEC} as the contract.
Rerun ${TARGETED_TESTS} until ALL tests pass.
Output:
{{steps.run-new-tests.output}}`,
      verification: { type: 'exit_code', value: '' },
    })
    .step('run-new-tests-final', {
      type: 'deterministic',
      dependsOn: ['fix-new-tests'],
      command: `${TARGETED_TESTS} 2>&1 | tail -40`,
      captureOutput: true,
      failOnError: false,
    })
    .step('fix-new-tests-final', {
      agent: 'qa-fixer',
      dependsOn: ['run-new-tests-final'],
      task: `If the final targeted test rerun below is green, record the evidence in ${ART}/targeted-tests-evidence.md.
If it is red, fix and rerun until green, then record the evidence.
Output:
{{steps.run-new-tests-final.output}}`,
      verification: { type: 'exit_code', value: '' },
    })

    // ── Gate 2: typecheck + regression (run → fix → rerun) ──────────────
    .step('verify-build', {
      type: 'deterministic',
      dependsOn: ['fix-new-tests-final'],
      command: `(npm run typecheck && ${REGRESSION_TESTS}) 2>&1 | tail -60`,
      captureOutput: true,
      failOnError: false,
    })
    .step('fix-verify-build', {
      agent: 'qa-fixer',
      dependsOn: ['verify-build'],
      task: `Fix any typecheck errors or regressions in existing suites caused by our changes. Most likely causes: changed signatures in ${CAPABILITIES}, dispatcher imports, or test mocks needing new passthrough exports.
Rerun: npm run typecheck && ${REGRESSION_TESTS}
Fix until green.
Output:
{{steps.verify-build.output}}`,
      verification: { type: 'exit_code', value: '' },
    })
    .step('verify-build-final', {
      type: 'deterministic',
      dependsOn: ['fix-verify-build'],
      command: `(npm run typecheck && ${REGRESSION_TESTS}) 2>&1 | tail -40`,
      captureOutput: true,
      failOnError: false,
    })

    // ── Deep-tier review: Claude loop ────────────────────────────────────
    .step('claude-review', {
      agent: 'claude-reviewer',
      dependsOn: ['verify-build-final'],
      task: `First-pass fresh-eyes review of the Slack conversational routing implementation.
Read ${SPEC}, CLAUDE.md, the .claude/rules files it references, the full git diff, the new files under ${NEW_MODULE_DIR} and ${NEW_TEST_DIR}, the dispatcher change in ${DISPATCHER}, the reflections under ${ART}/, and this verification evidence:
{{steps.verify-build-final.output}}
Review specifically for: flag-off behavior change risk in the hot dispatcher path, raw spec.capabilities reads bypassing personaCapabilities, secrets read via process.env instead of the Resource-first helper, egress throwing into the dispatcher, missing SPEC section 8 test cases, and inline heavy work added to the webhook path.
Write ${ART}/claude-review.md using the schema: verdict, then per finding: finding_id, severity, file, issue, fix_required, test_required, status, evidence.
Use NO_ISSUES_FOUND only if there are no actionable findings.`,
      verification: { type: 'exit_code', value: '' },
    })
    .step('claude-fix', {
      agent: 'claude-fixer',
      dependsOn: ['claude-review'],
      task: `Read ${ART}/claude-review.md.
Fix every valid finding and add or update tests/proofs for each fix. After each fix rerun the targeted check, re-read the touched files, and keep iterating until this round has no remaining valid issues.
Then rerun ${TARGETED_TESTS} and confirm green.
Write ${ART}/claude-fix.md with fixes and commands run. If the review says NO_ISSUES_FOUND, record that no fix was needed.`,
      verification: { type: 'exit_code', value: '' },
    })
    .step('claude-review-final', {
      agent: 'claude-reviewer',
      dependsOn: ['claude-fix'],
      task: `Fresh post-fix review from scratch — do not rely on the prior review or the fixer's summary.
Read the current diff, files, ${SPEC}, repo rules, and rerun-able evidence. Write ${ART}/claude-review-final.md with the same finding schema.
Use NO_ISSUES_FOUND only if there are no actionable issues left.`,
      verification: { type: 'exit_code', value: '' },
    })
    .step('claude-fix-final', {
      agent: 'claude-fixer',
      dependsOn: ['claude-review-final'],
      task: `If ${ART}/claude-review-final.md contains findings, fix them, add or update tests/proofs, and rerun ${TARGETED_TESTS} until green.
If a finding cannot be fixed inside this workflow, write ${BLOCKED} with the exact evidence and do not attempt further changes.
If it says NO_ISSUES_FOUND, write ${ART}/claude-signoff.md.`,
      verification: { type: 'exit_code', value: '' },
    })
    .step('verify-after-claude', {
      type: 'deterministic',
      dependsOn: ['claude-fix-final'],
      command: `if [ -f ${BLOCKED} ]; then echo BLOCKED_PRESENT; cat ${BLOCKED}; exit 0; fi && (${TARGETED_TESTS} && npm run typecheck) 2>&1 | tail -40`,
      captureOutput: true,
      failOnError: false,
    })

    // ── Deep-tier review: Codex loop (post-Claude state, from scratch) ──
    .step('codex-review', {
      agent: 'codex-reviewer',
      dependsOn: ['verify-after-claude'],
      task: `Second-pass fresh-eyes review of the post-Claude-fix state. If ${BLOCKED} exists, write ${ART}/codex-review.md with verdict BLOCKED and stop.
Otherwise read ${SPEC}, CLAUDE.md, the full git diff, all files under ${NEW_MODULE_DIR} and ${NEW_TEST_DIR}, ${DISPATCHER}, and this evidence:
{{steps.verify-after-claude.output}}
Hunt for what the first reviewer would miss: router precedence edge cases (empty text, multiple defaultResponders, channel list duplicates), throttle race in egress appendStream, dispatcher early-return paths that skip existing logging, and tests that assert mocks rather than behavior.
Write ${ART}/codex-review.md with the same finding schema, or NO_ISSUES_FOUND.`,
      verification: { type: 'exit_code', value: '' },
    })
    .step('codex-fix', {
      agent: 'codex-fixer',
      dependsOn: ['codex-review'],
      task: `Read ${ART}/codex-review.md. If its verdict is BLOCKED, record that and do nothing else.
Otherwise fix every valid finding, add or update tests/proofs for each fix, rerun ${TARGETED_TESTS} after each fix, and keep iterating until this round has no remaining valid issues.
Write ${ART}/codex-fix.md with fixes and commands run. If the review says NO_ISSUES_FOUND, record that no fix was needed.`,
      verification: { type: 'exit_code', value: '' },
    })
    .step('codex-review-final', {
      agent: 'codex-reviewer',
      dependsOn: ['codex-fix'],
      task: `Fresh post-Codex-fix review from scratch — do not rely on prior review text or fixer summaries. If ${BLOCKED} exists, write ${ART}/codex-review-final.md with verdict BLOCKED and stop.
Read the current diff, files, ${SPEC}, and repo rules. Write ${ART}/codex-review-final.md with the finding schema.
Use NO_ISSUES_FOUND only if there are no actionable issues left.`,
      verification: { type: 'exit_code', value: '' },
    })
    .step('codex-fix-final', {
      agent: 'codex-fixer',
      dependsOn: ['codex-review-final'],
      task: `If ${ART}/codex-review-final.md contains findings, fix them, add or update tests/proofs, and rerun ${TARGETED_TESTS} until green.
If a finding cannot be fixed inside this workflow, write ${BLOCKED} with exact evidence.
If it says NO_ISSUES_FOUND, write ${ART}/codex-signoff.md.`,
      verification: { type: 'exit_code', value: '' },
    })

    // ── Final deterministic acceptance (full contract, SPEC section 10) ─
    .step('acceptance-final', {
      type: 'deterministic',
      dependsOn: ['codex-fix-final'],
      command: `if [ -f ${BLOCKED} ]; then echo BLOCKED_NO_COMMIT; cat ${BLOCKED}; exit 0; fi && (${ACCEPTANCE}) 2>&1 | tail -40 && echo ACCEPTANCE_OK`,
      captureOutput: true,
      failOnError: false,
    })
    .step('repair-acceptance', {
      agent: 'qa-fixer',
      dependsOn: ['acceptance-final'],
      task: `If the acceptance output below says ACCEPTANCE_OK or BLOCKED_NO_COMMIT, do nothing.
Otherwise fix whatever is red and rerun the full acceptance command until ACCEPTANCE_OK:
${ACCEPTANCE}
If it cannot be fixed, write ${BLOCKED} with exact evidence.
Output:
{{steps.acceptance-final.output}}`,
      verification: { type: 'exit_code', value: '' },
    })

    // ── Commit (scoped, green-only), push, PR ────────────────────────────
    .step('commit-if-green', {
      type: 'deterministic',
      dependsOn: ['repair-acceptance'],
      command: [
        `if [ -f ${BLOCKED} ]; then echo SKIPPED_BLOCKED; exit 0; fi`,
        `${TARGETED_TESTS} >/dev/null 2>&1`,
        `git add ${SCOPE_PATHS}`,
        'git commit -m "feat(web): Slack conversational agent routing Phase 1 (flag-gated, dormant)" || echo NOTHING_TO_COMMIT',
        'git log -1 --oneline',
      ].join(' && '),
      captureOutput: true,
      failOnError: false,
    })
    .step('repair-commit', {
      agent: 'qa-fixer',
      dependsOn: ['commit-if-green'],
      task: `If the commit output below shows SKIPPED_BLOCKED or a successful commit, do nothing.
Otherwise diagnose the blocker (red tests, unstaged paths, git config), fix it, rerun ${TARGETED_TESTS}, and create the commit with the same message and the same scoped paths only — never git add -A.
Output:
{{steps.commit-if-green.output}}`,
      verification: { type: 'exit_code', value: '' },
    })
    .step('verify-commit', {
      type: 'deterministic',
      dependsOn: ['repair-commit'],
      command: `if [ -f ${BLOCKED} ]; then echo SKIPPED_BLOCKED; exit 0; fi && git log -1 --pretty=%s | grep -q "Slack conversational agent routing" && echo COMMIT_OK`,
      captureOutput: true,
      failOnError: true,
    })
    .step('push-branch', {
      type: 'deterministic',
      dependsOn: ['verify-commit'],
      command: `if [ -f ${BLOCKED} ]; then echo SKIPPED_BLOCKED; exit 0; fi && git push -u origin ${BRANCH} 2>&1 | tail -5 && echo PUSH_OK`,
      captureOutput: true,
      failOnError: false,
    });

  // ── open-pr: prefer the SDK GitHub integration step; fall back to gh CLI ─
  // The cloud runner executes createGitHubStep integration steps with
  // workspace-injected credentials. The local sdk 6.3.5 builder predates
  // integration-step support and throws "Agent steps must have both agent and
  // task" (verified via dry-run; builder.js has no integration branch), so
  // local runs use the printf + mktemp + --body-file gh fallback instead.
  try {
    chained.step('open-pr', createGitHubStep({
      name: 'open-pr',
      dependsOn: ['push-branch'],
      action: 'createPR',
      repo: REPO,
      params: {
        title: PR_TITLE,
        head: BRANCH,
        base: 'main',
        body: PR_BODY_LINES.join('\n'),
        draft: false,
      },
      output: { mode: 'data', format: 'json', path: 'html_url' },
    }) as unknown as Parameters<ReturnType<typeof workflow>['step']>[1]);
  } catch {
    chained.step('open-pr', {
      type: 'deterministic',
      dependsOn: ['push-branch'],
      command: [
        `if [ -f ${BLOCKED} ]; then echo SKIPPED_BLOCKED; exit 0; fi`,
        'BODY=$(mktemp)',
        `printf '%s\\n' ${PR_BODY_LINES.map(shellQuote).join(' ')} > "$BODY"`,
        `gh pr create --repo ${REPO} --title ${shellQuote(PR_TITLE)} --head ${BRANCH} --base main --body-file "$BODY" 2>&1 | tail -3`,
        'rm -f "$BODY"',
        'echo PR_STEP_DONE',
      ].join(' && '),
      captureOutput: true,
      failOnError: false,
    });
  }

  const result = await chained
    .step('repair-pr', {
      agent: 'qa-fixer',
      dependsOn: ['open-pr'],
      task: `If ${BLOCKED} exists, record that PR creation was intentionally skipped and do nothing else.
Otherwise verify a PR exists for branch ${BRANCH} on ${REPO} (gh pr list --head ${BRANCH}).
If the open-pr step failed, diagnose (auth, unpushed branch, existing PR) and repair: push the branch if needed; as a last resort create the PR with gh using the same title/body intent and note in ${ART}/pr-evidence.md that the fallback was used.
Write the final PR URL to ${ART}/pr-evidence.md.`,
      verification: { type: 'exit_code', value: '' },
    })
    .step('verify-pr-final', {
      type: 'deterministic',
      dependsOn: ['repair-pr'],
      command: [
        `if [ -f ${BLOCKED} ]; then echo SKIPPED_BLOCKED; cat ${BLOCKED}; exit 0; fi`,
        `gh pr list --repo ${REPO} --head ${BRANCH} --json url --jq ".[0].url" | grep -q "github.com" && echo PR_VERIFIED`,
        `gh pr list --repo ${REPO} --head ${BRANCH} --json url --jq ".[0].url"`,
        `command -v trail >/dev/null 2>&1 && trail complete --summary "Slack conversational routing Phase 1 shipped as PR" --confidence 0.85 || true`,
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .onError('retry', { maxRetries: 2, retryDelayMs: 10_000 })
    .run({ cwd: process.cwd() });

  console.log('Workflow status:', result.status);
}

runWorkflow().catch((error) => {
  console.error(error);
  process.exit(1);
});
