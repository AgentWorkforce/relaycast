// Slack Conversational Agent Routing — Phase 2 (go-live: reply turn, thread
// stickiness, SST flag wiring)
//
// Spec: workflows/slack-conversational-routing-p2-SPEC.md (read it first — all
// task prompts reference SPEC sections). Builds on Phase 1 (PR #1894).
//
// Shape: Conversation (interactive lead + 3 codex implementer squads on a
// shared channel) with hard step timeouts and anti-deadlock fallbacks (Phase 1
// post-mortem: an unACK'd worker wedged the run for hours), then repairable
// deterministic gates, the deep-tier fresh-eyes review path (Claude then
// Codex, review/fix/final-review/final-fix), deterministic acceptance
// including drizzle-journal and secret-wiring gates, a scoped commit with a
// post-commit completeness gate (Phase 1 post-mortem: a scoped commit missed a
// new file the dispatcher imported), push, and PR.
//
// Run from a worktree of AgentWorkforce/cloud based on POST-Phase-1 main:
//   git fetch origin && git checkout main && git pull
//   ricky run workflows/slack-conversational-routing-p2.ts

import { workflow } from '@relayflows/core';
import { createGitHubStep } from '@agent-relay/sdk';
import { ClaudeModels, CodexModels } from '@agent-relay/config';
import { applyCloudRepoSetup } from './lib/cloud-repo-setup.ts';

const NAME = 'slack-conversational-routing-p2';
const REPO = 'AgentWorkforce/cloud';
const BRANCH = 'feat/slack-conversational-routing-p2';
const CHANNEL = 'wf-slack-conv-routing-p2';
const SPEC = 'workflows/slack-conversational-routing-p2-SPEC.md';
const ART = '.workflow-artifacts/slack-conv-routing-p2';
const BLOCKED = `${ART}/BLOCKED_NO_COMMIT.md`;

const TEST_DIR = 'tests/proactive-runtime/slack-conversation';
const CONV_DIR = 'packages/web/lib/integrations/slack-conversation';
const REPLY_MODULE = 'packages/web/lib/proactive-runtime/slack-conversation-terminal-reply.ts';
const TRIGGER_DELIVERY = 'packages/web/lib/proactive-runtime/deployment-trigger-delivery.ts';
const DISPATCHER = 'packages/web/lib/proactive-runtime/integration-watch-dispatcher.ts';
const RUNBOOK = 'docs/runbooks/slack-conversational-routing-golive.md';

// Comprehensive commit scope (SPEC §9: Phase 1 missed a new file under
// packages/web/lib/proactive-runtime/ because this list was too narrow).
const SCOPE_PATHS = [
  CONV_DIR,
  'packages/web/lib/proactive-runtime/slack-conversation-terminal-reply.ts',
  'packages/web/lib/proactive-runtime/slack-conversation-dispatch-finalize.ts',
  TRIGGER_DELIVERY,
  DISPATCHER,
  'packages/web/lib/db/schema.ts',
  'packages/web/drizzle',
  'packages/web/lib/boot/resource-check.ts',
  'infra/secrets.ts',
  'infra/web.ts',
  'infra/web-worker.ts',
  'scripts/set-secrets.sh',
  '.github/workflows/_deploy-cloud-stage.yml',
  '.github/workflows/preview.yml',
  '.github/scripts/seed-sst-secrets.sh',
  'docs/runbooks',
  TEST_DIR,
  'tests/proactive-runtime/capabilities.test.ts',
  SPEC,
  'workflows/slack-conversational-routing-p2.ts',
].join(' ');

const TARGETED_TESTS = `npx tsx --test ${TEST_DIR}/*.test.ts tests/proactive-runtime/capabilities.test.ts`;
const WIRING_GATES = 'npm run web:drizzle-journal:test && bash .github/scripts/validate-secret-wiring.sh';
const REGRESSION_TESTS = 'npx tsx --test tests/proactive-runtime/*.test.ts && npm run web:webhook-ingress:test && npm run web:proactive-runtime:test';
const ACCEPTANCE = `${TARGETED_TESTS} && npm run typecheck && ${WIRING_GATES} && ${REGRESSION_TESTS}`;

// Post-commit completeness gate (SPEC §9): after the scoped commit, no
// source-like file may remain dirty or untracked outside log/artifact dirs.
const COMPLETENESS_GATE = [
  `LEFT=$(git status --porcelain | grep -E '\\.(ts|sql|json|sh|yml|md)$' | grep -vE '(\\.logs/|\\.workflow-artifacts/|\\.agent-relay/|\\.agentworkforce/|\\.trajectories/|node_modules/|tsbuildinfo)' || true)`,
  'if [ -n "$LEFT" ]; then echo "COMPLETENESS_FAIL:"; echo "$LEFT"; exit 1; fi',
  'echo COMPLETENESS_OK',
].join(' && ');

const PR_TITLE = 'feat(web): Slack conversational routing Phase 2 — terminal reply, thread stickiness, SST flag wiring (go-live)';
const PR_BODY_LINES = [
  '## Summary',
  '',
  'Phase 2 of Slack conversational agent routing (Phase 1: #1894). Closes the three go-live gaps:',
  '',
  '- **Terminal reply** — `slack-conversation-terminal-reply.ts` consumes the `slackConversation` delivery marker at every terminal poll path and posts the run outcome into the Slack thread via the Phase 1 egress (flag-gated, never throws into the drain).',
  '- **Thread stickiness** — `slack_conversation_threads` table (+ migration + journal), real `threadOwnerLookup`, owner recorded after each successful routed dispatch; follow-up mentions in a thread route to the same agent.',
  '- **SST flag wiring** — `SlackConversationRoutingEnabled` registered across all seven places (secrets.ts, web + web-worker links, set-secrets.sh, stage deploy workflow, preview seed, boot check). Secret value stays unset: the feature remains OFF at merge.',
  '- Go-live runbook: `docs/runbooks/slack-conversational-routing-golive.md`.',
  '',
  '## Dormant proof',
  '',
  '- Flag default OFF; secret unset everywhere → dispatch arm, terminal reply, and thread recording are all unreachable.',
  '- Phase 1 flag-off byte-identical dispatch test untouched and green.',
  '',
  '## Test plan',
  '',
  '- [x] `npx tsx --test tests/proactive-runtime/slack-conversation/*.test.ts tests/proactive-runtime/capabilities.test.ts`',
  '- [x] `npm run typecheck`',
  '- [x] `npm run web:drizzle-journal:test`',
  '- [x] `bash .github/scripts/validate-secret-wiring.sh`',
  '- [x] Regression: `npx tsx --test tests/proactive-runtime/*.test.ts`, `npm run web:webhook-ingress:test`, `npm run web:proactive-runtime:test`',
  '- [x] Deep-tier review: Claude review/fix/final-review/final-fix, then Codex review/fix/final-review/final-fix (artifacts under `.workflow-artifacts/slack-conv-routing-p2/`)',
  '',
  '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
];

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

async function runWorkflow() {
  const base = workflow(NAME)
    .description('Slack conversational routing Phase 2: terminal Slack reply hook, thread-stickiness table + lookup, seven-place SST flag registration, runbook, tests, PR. Dormant until the secret is set.')
    .pattern('dag')
    .channel(CHANNEL)
    .maxConcurrency(4)
    .timeout(10_800_000) // 3h global
    .repairable()

    // ── Interactive team (Conversation shape) ───────────────────────────
    .agent('lead', {
      cli: 'claude',
      model: ClaudeModels.OPUS,
      role: 'Architect and in-flight reviewer. Owns the SPEC, assigns squads, answers design questions, reviews diffs between rounds, posts feedback in-channel.',
      retries: 1,
    })
    .agent('impl-reply', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      role: 'Implementer for SPEC section 4 (terminal Slack reply hook) and its tests. Listens on the channel for assignments and feedback.',
      retries: 2,
    })
    .agent('impl-threads', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      role: 'Implementer for SPEC section 5 (thread stickiness: migration + journal + module + dispatcher wiring) and its tests. Listens on the channel for assignments and feedback.',
      retries: 2,
    })
    .agent('impl-flip', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      role: 'Implementer for SPEC sections 6 and 7 (seven-place SST secret wiring + go-live runbook). Listens on the channel for assignments and feedback.',
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
        // Phase 1 must be merged: the egress + dispatch modules are the base we build on.
        `test -f ${CONV_DIR}/egress.ts || (echo "ERROR: Phase 1 not on this base — merge PR #1894 first"; exit 1)`,
        `test -f ${CONV_DIR}/dispatch.ts || (echo "ERROR: Phase 1 dispatch module missing"; exit 1)`,
        `command -v trail >/dev/null 2>&1 && trail start "Slack conversational routing Phase 2 go-live" || true`,
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
        'echo "--- terminal hook prior art (postLinearAgentSessionTerminalWriteback call sites) ---"',
        `grep -n "postLinearAgentSessionTerminalWriteback" ${TRIGGER_DELIVERY} | head -10`,
        'echo "--- dispatcher conversational arm ---"',
        `grep -n "maybeDispatchSlackConversationalAppMention\\|finalizeSlackConversationDispatchResult\\|threadOwnerLookup" ${DISPATCHER} ${CONV_DIR}/dispatch.ts | head -15`,
        'echo "--- latest drizzle migration + journal tail ---"',
        'ls packages/web/drizzle/*.sql | tail -3',
        'tail -12 packages/web/drizzle/meta/_journal.json',
        'echo "--- boot check secrets list ---"',
        'grep -n "SHARED_SST_SECRETS" -A 6 packages/web/lib/boot/resource-check.ts | head -12',
      ].join(' && '),
      captureOutput: true,
    })

    // ── Conversation: lead + 3 squads start concurrently ────────────────
    .step('lead-coordinate', {
      agent: 'lead',
      dependsOn: ['context'],
      failOnError: false,
      timeoutMs: 5_400_000, // 90m — a silent worker must not wedge the run
      task: `You are the lead on #${CHANNEL}. Workers: impl-reply, impl-threads, impl-flip.
The full spec is ${SPEC} — read it yourself, then post a short plan to the channel.
Require each worker to reply "ACK <name>" before issuing assignments; re-ping after 3 minutes of silence.
If a worker has not ACK'd after 2 re-pings (~10 minutes), treat it as dead: post its assignment to the channel anyway, continue with the responsive workers, and note the dead scope in ${ART}/lead-status.md — the downstream reconcile gate backfills missing scopes. NEVER wait indefinitely on a single worker.
Assignments (non-overlapping ownership):
- impl-reply: SPEC §4 — ${REPLY_MODULE} + hook calls in ${TRIGGER_DELIVERY} + ${TEST_DIR}/terminal-reply.test.ts and the hook-site coverage (SPEC §8).
- impl-threads: SPEC §5 — migration + packages/web/drizzle/meta/_journal.json + schema.ts table + ${CONV_DIR}/threads.ts + dispatcher threadOwnerLookup/record wiring + ${TEST_DIR}/threads.test.ts + dispatcher-flag.test.ts extension. The journal MUST be updated in the same change (npm run web:drizzle-journal:test).
- impl-flip: SPEC §6 and §7 — the seven-place SlackConversationRoutingEnabled wiring + ${RUNBOOK}. Gate: bash .github/scripts/validate-secret-wiring.sh.
Ownership boundary: ONLY impl-threads touches ${DISPATCHER} and ${CONV_DIR}/dispatch.ts; ONLY impl-reply touches ${TRIGGER_DELIVERY}. impl-flip touches no production TypeScript outside packages/web/lib/boot/resource-check.ts.
When a worker posts "READY <files>", read the actual files yourself (not their summary), run the targeted tests for that scope, and reply APPROVED or CHANGES_REQUESTED with concrete notes. Verify the diffs to ${TRIGGER_DELIVERY} and ${DISPATCHER} are additive and small — reject restructuring.
Every 10 minutes post a status probe: workers reply RUNNING, BLOCKED <reason>, or DONE <files>.
Each worker must post the COMPLETE list of files it created or modified to the channel (SPEC §9 commit-completeness rule) and write a self-reflection artifact to ${ART}/<name>-reflection.md (spec coverage, changed files, commands run, open risks) before you approve them.
Exit when all three scopes are APPROVED and reflections exist, OR after 75 minutes total — post a final status summary of what is and isn't approved, then exit so downstream gates run.`,
    })
    .step('impl-reply-work', {
      agent: 'impl-reply',
      dependsOn: ['context'],
      failOnError: false,
      timeoutMs: 2_700_000, // 45m — timeout respawns a fresh agent via retries
      task: `You are impl-reply on #${CHANNEL}. Reply "ACK impl-reply" when you see the lead's plan, then wait for your assignment. If you see no lead plan within 5 minutes, post "ACK impl-reply" anyway and start on the assignment below.
Implement SPEC §4: ${REPLY_MODULE} (mirror postLinearAgentSessionTerminalWriteback's call discipline) and wire one additive hook call into EVERY terminal path of pollDeploymentTriggerRun in ${TRIGGER_DELIVERY} that calls postLinearAgentSessionTerminalWriteback (grep for the call sites — line numbers in the SPEC may have drifted).
Hard rules: flag-gated via isSlackConversationRoutingEnabled; defensive marker extraction (unknown payload, missing marker → no-op); 3,900-char truncation; never throw into the poll path; the diff to ${TRIGGER_DELIVERY} is hook calls only, no restructuring.
Consume the Phase 1 egress from ${CONV_DIR}/egress.ts as-is — it is type-bound to @agent-assistant/surfaces; do not fork or re-mirror it.
Tests: ${TEST_DIR}/terminal-reply.test.ts per SPEC §8. Run: npx tsx --test ${TEST_DIR}/terminal-reply.test.ts and iterate until green, then run npm run typecheck.
Post the COMPLETE list of files you created/modified to the channel. Write ${ART}/impl-reply-reflection.md, then post "READY <files>" and address lead feedback until APPROVED.`,
    })
    .step('impl-threads-work', {
      agent: 'impl-threads',
      dependsOn: ['context'],
      failOnError: false,
      timeoutMs: 2_700_000, // 45m
      task: `You are impl-threads on #${CHANNEL}. Reply "ACK impl-threads" when you see the lead's plan, then wait for your assignment. If you see no lead plan within 5 minutes, post "ACK impl-threads" anyway and start on the assignment below.
Implement SPEC §5: the slack_conversation_threads migration (next free number — check ls packages/web/drizzle/*.sql), the _journal.json entry IN THE SAME CHANGE (next idx, strictly increasing when; npm run web:drizzle-journal:test must pass), the schema.ts table, ${CONV_DIR}/threads.ts (fail-open lookup + upsert record), and the additive dispatcher wiring (real threadOwnerLookup + fire-and-forget owner recording after a successful routed dispatch with threadTs = event.threadTs ?? ackTs).
Ownership: you are the ONLY worker touching ${DISPATCHER} and ${CONV_DIR}/dispatch.ts — keep those diffs additive and minimal.
Tests: ${TEST_DIR}/threads.test.ts + extend ${TEST_DIR}/dispatcher-flag.test.ts per SPEC §8 (owner recorded; recording failure does not fail dispatch; sticky thread routes via "thread"; flag OFF untouched).
Run: npx tsx --test ${TEST_DIR}/threads.test.ts ${TEST_DIR}/dispatcher-flag.test.ts && npm run web:drizzle-journal:test and iterate until green, then npm run typecheck.
Post the COMPLETE list of files you created/modified to the channel. Write ${ART}/impl-threads-reflection.md, then post "READY <files>" and address lead feedback until APPROVED.`,
    })
    .step('impl-flip-work', {
      agent: 'impl-flip',
      dependsOn: ['context'],
      failOnError: false,
      timeoutMs: 2_700_000, // 45m
      task: `You are impl-flip on #${CHANNEL}. Reply "ACK impl-flip" when you see the lead's plan, then wait for your assignment. If you see no lead plan within 5 minutes, post "ACK impl-flip" anyway and start on the assignment below.
Implement SPEC §6: register SlackConversationRoutingEnabled in all seven places — infra/secrets.ts declaration, link from BOTH infra/web.ts and infra/web-worker.ts, scripts/set-secrets.sh (env var CLOUD_SLACK_CONVERSATION_ROUTING_ENABLED), .github/workflows/_deploy-cloud-stage.yml (inputs.secrets AND deploy job env), .github/workflows/preview.yml + .github/scripts/seed-sst-secrets.sh (non-empty "disabled" placeholder), and the SHARED_SST_SECRETS entry in packages/web/lib/boot/resource-check.ts. Mirror how an existing secret (e.g. NangoSecretKey) appears in EACH file.
Then SPEC §7: write ${RUNBOOK}.
Do NOT set any secret VALUE anywhere — wiring only; the feature stays dark.
Gate: bash .github/scripts/validate-secret-wiring.sh must pass; also grep each of the eight files for SlackConversationRoutingEnabled (or its env var) and show the matches.
Post the COMPLETE list of files you created/modified to the channel. Write ${ART}/impl-flip-reflection.md, then post "READY <files>" and address lead feedback until APPROVED.`,
    })

    // ── Reconcile: keep gates on the critical path even if a PTY dies ───
    .step('implementation-reconcile', {
      type: 'deterministic',
      dependsOn: ['lead-coordinate', 'impl-reply-work', 'impl-threads-work', 'impl-flip-work'],
      command: [
        `git status --short -- ${SCOPE_PATHS} | head -40`,
        `test -f ${REPLY_MODULE} || echo "MISSING_REPLY_MODULE"`,
        `grep -q "postSlackConversationTerminalReply" ${TRIGGER_DELIVERY} || echo "MISSING_REPLY_HOOK"`,
        `test -f ${CONV_DIR}/threads.ts || echo "MISSING_THREADS_MODULE"`,
        `ls packages/web/drizzle/*slack_conversation_threads*.sql >/dev/null 2>&1 || echo "MISSING_MIGRATION"`,
        `grep -q "slack_conversation_threads" packages/web/drizzle/meta/_journal.json || echo "MISSING_JOURNAL_ENTRY"`,
        `grep -q "slackConversationThreads\\|slack_conversation_threads" packages/web/lib/db/schema.ts || echo "MISSING_SCHEMA_TABLE"`,
        `grep -q "SlackConversationRoutingEnabled" infra/secrets.ts || echo "MISSING_SECRET_DECL"`,
        `grep -q "SlackConversationRoutingEnabled" infra/web.ts || echo "MISSING_WEB_LINK"`,
        `grep -q "SlackConversationRoutingEnabled" infra/web-worker.ts || echo "MISSING_WORKER_LINK"`,
        `grep -q "CLOUD_SLACK_CONVERSATION_ROUTING_ENABLED" scripts/set-secrets.sh || echo "MISSING_SET_SECRETS"`,
        `grep -q "CLOUD_SLACK_CONVERSATION_ROUTING_ENABLED" .github/workflows/_deploy-cloud-stage.yml || echo "MISSING_DEPLOY_WF"`,
        `grep -q "CLOUD_SLACK_CONVERSATION_ROUTING_ENABLED" .github/scripts/seed-sst-secrets.sh || echo "MISSING_PREVIEW_SEED"`,
        `grep -q "SlackConversationRoutingEnabled" packages/web/lib/boot/resource-check.ts || echo "MISSING_BOOT_CHECK"`,
        `test -f ${RUNBOOK} || echo "MISSING_RUNBOOK"`,
        `test -f ${TEST_DIR}/terminal-reply.test.ts || echo "MISSING_REPLY_TEST"`,
        `test -f ${TEST_DIR}/threads.test.ts || echo "MISSING_THREADS_TEST"`,
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
If nothing is missing, do nothing and say so. If you implement a missing piece, also write its tests per SPEC §8 and run them.`,
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

    // ── Gate 2: typecheck + wiring gates + regression ────────────────────
    .step('verify-build', {
      type: 'deterministic',
      dependsOn: ['fix-new-tests-final'],
      command: `(npm run typecheck && ${WIRING_GATES} && ${REGRESSION_TESTS}) 2>&1 | tail -60`,
      captureOutput: true,
      failOnError: false,
    })
    .step('fix-verify-build', {
      agent: 'qa-fixer',
      dependsOn: ['verify-build'],
      task: `Fix any typecheck errors, drizzle-journal failures, secret-wiring drift, or regressions caused by our changes. Likely causes: journal idx/when mismatch, a secret env var missing from one of the four wiring files, dispatcher/test mock signature drift, exactOptionalPropertyTypes violations (use conditional spreads).
Rerun: npm run typecheck && ${WIRING_GATES} && ${REGRESSION_TESTS}
Fix until green.
Output:
{{steps.verify-build.output}}`,
      verification: { type: 'exit_code', value: '' },
    })
    .step('verify-build-final', {
      type: 'deterministic',
      dependsOn: ['fix-verify-build'],
      command: `(npm run typecheck && ${WIRING_GATES} && ${REGRESSION_TESTS}) 2>&1 | tail -40`,
      captureOutput: true,
      failOnError: false,
    })

    // ── Deep-tier review: Claude loop ────────────────────────────────────
    .step('claude-review', {
      agent: 'claude-reviewer',
      dependsOn: ['verify-build-final'],
      task: `First-pass fresh-eyes review of the Slack conversational routing Phase 2 implementation.
Read ${SPEC}, CLAUDE.md, the .claude/rules files it references (especially sst-secrets.md and sst-resource-registration.md), the full git diff, ${REPLY_MODULE}, ${CONV_DIR}/threads.ts, the diffs to ${TRIGGER_DELIVERY} and ${DISPATCHER}, the migration + journal, all seven secret-wiring files, the reflections under ${ART}/, and this verification evidence:
{{steps.verify-build-final.output}}
Review specifically for: the terminal-reply hook throwing into the poll path or running when the flag is off; non-additive restructuring of ${TRIGGER_DELIVERY} or ${DISPATCHER}; the migration/journal mismatch class (idx/when/tag); a secret-wiring place missed (compare against the seven-place checklist in CLAUDE.md); thread recording blocking dispatch; fail-open violations in threads.ts; and any new code path reachable with the flag OFF.
Write ${ART}/claude-review.md using the schema: verdict, then per finding: finding_id, severity, file, issue, fix_required, test_required, status, evidence.
Use NO_ISSUES_FOUND only if there are no actionable findings.`,
      verification: { type: 'exit_code', value: '' },
    })
    .step('claude-fix', {
      agent: 'claude-fixer',
      dependsOn: ['claude-review'],
      task: `Read ${ART}/claude-review.md.
Fix every valid finding and add or update tests/proofs for each fix. After each fix rerun the targeted check, re-read the touched files, and keep iterating until this round has no remaining valid issues.
Then rerun ${TARGETED_TESTS} && ${WIRING_GATES} and confirm green.
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
      command: `if [ -f ${BLOCKED} ]; then echo BLOCKED_PRESENT; cat ${BLOCKED}; exit 0; fi && (${TARGETED_TESTS} && npm run typecheck && ${WIRING_GATES}) 2>&1 | tail -40`,
      captureOutput: true,
      failOnError: false,
    })

    // ── Deep-tier review: Codex loop (post-Claude state, from scratch) ──
    .step('codex-review', {
      agent: 'codex-reviewer',
      dependsOn: ['verify-after-claude'],
      task: `Second-pass fresh-eyes review of the post-Claude-fix state. If ${BLOCKED} exists, write ${ART}/codex-review.md with verdict BLOCKED and stop.
Otherwise read ${SPEC}, CLAUDE.md, the full git diff, ${REPLY_MODULE}, ${CONV_DIR}/threads.ts, ${TRIGGER_DELIVERY}, ${DISPATCHER}, the migration/journal, the secret-wiring files, and this evidence:
{{steps.verify-after-claude.output}}
Hunt for what the first reviewer would miss: truncation edge cases (multibyte, exact-boundary), the reply hook firing twice for one delivery (poll retry paths), upsert races in threads.ts, threadTs ?? ackTs precedence inverted, the preview seed placeholder being truthy ("disabled" must evaluate OFF via truthyFlag), journal when-collision with a concurrently merged migration, and tests that assert mocks rather than behavior.
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

    // ── Final deterministic acceptance (full contract, SPEC §10) ────────
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

    // ── Commit (scoped, green-only) + completeness gate, push, PR ────────
    .step('commit-if-green', {
      type: 'deterministic',
      dependsOn: ['repair-acceptance'],
      command: [
        `if [ -f ${BLOCKED} ]; then echo SKIPPED_BLOCKED; exit 0; fi`,
        `${TARGETED_TESTS} >/dev/null 2>&1`,
        `git add ${SCOPE_PATHS}`,
        'git commit -m "feat(web): Slack conversational routing Phase 2 — terminal reply, thread stickiness, SST flag wiring (go-live)" || echo NOTHING_TO_COMMIT',
        'git log -1 --oneline',
      ].join(' && '),
      captureOutput: true,
      failOnError: false,
    })
    // SPEC §9 completeness gate: nothing source-like may be left out of the commit.
    .step('verify-commit-complete', {
      type: 'deterministic',
      dependsOn: ['commit-if-green'],
      command: `if [ -f ${BLOCKED} ]; then echo SKIPPED_BLOCKED; exit 0; fi && ${COMPLETENESS_GATE}`,
      captureOutput: true,
      failOnError: false,
    })
    .step('repair-commit', {
      agent: 'qa-fixer',
      dependsOn: ['verify-commit-complete'],
      task: `If the output below shows SKIPPED_BLOCKED or COMPLETENESS_OK and the commit exists, do nothing.
If it shows COMPLETENESS_FAIL with leftover files: those files were created/modified by the implementation but missed by the scoped git add — THIS EXACT BUG shipped a broken Phase 1 PR (a committed module imported an uncommitted file). For each leftover, decide: production/test/infra source that belongs to this feature → git add it and amend the commit (git commit --amend --no-edit); incidental junk (logs, local artifacts) → leave it and say why.
If the commit itself failed, diagnose (red tests, git config), fix, rerun ${TARGETED_TESTS}, and create the commit with the same message. Never git add -A.
Finish by rerunning: ${COMPLETENESS_GATE}
Output:
{{steps.verify-commit-complete.output}}`,
      verification: { type: 'exit_code', value: '' },
    })
    .step('verify-commit', {
      type: 'deterministic',
      dependsOn: ['repair-commit'],
      command: `if [ -f ${BLOCKED} ]; then echo SKIPPED_BLOCKED; exit 0; fi && git log -1 --pretty=%s | grep -q "Slack conversational routing Phase 2" && echo COMMIT_OK`,
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
        `command -v trail >/dev/null 2>&1 && trail complete --summary "Slack conversational routing Phase 2 go-live shipped as PR" --confidence 0.85 || true`,
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .onError('retry', { maxRetries: 2, retryDelayMs: 10_000 })
    .run({ cwd: process.cwd() });

  console.log('Workflow status:', result.status);
}

runWorkflow().catch((error) => {
  console.error('Workflow failed:', error);
  process.exit(1);
});
