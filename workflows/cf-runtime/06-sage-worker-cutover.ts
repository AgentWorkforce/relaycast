/**
 * Wave D / Step 06 — sage-worker cutover to @agent-assistant/cloudflare-runtime.
 *
 * Run from cloud repo root:
 *   agent-relay run --dry-run workflows/cf-runtime/06-sage-worker-cutover.ts
 *   agent-relay run workflows/cf-runtime/06-sage-worker-cutover.ts
 *
 * The full design lives in the sibling SPEC file:
 *   workflows/cf-runtime/06-sage-worker-cutover-SPEC.md
 *
 * Team:
 *   - lead         — Claude Opus, coordinates on the channel + posts the
 *                    assignment + issues the final OWNER_DECISION.
 *   - impl-worker  — Codex GPT-5.4, owns packages/sage-worker/src/worker.ts.
 *                    Self-reviews its diff before handing off to peer review.
 *   - impl-infra   — Codex GPT-5.4, owns infra/sage.ts. Self-reviews its diff
 *                    before handing off to peer review.
 *   - reviewer     — Claude Opus (preset: reviewer, non-interactive). Peer-
 *                    reviews each impl's diff against the SPEC + cf-runtime
 *                    contract. Returns PEER_REVIEW: PASS or fixes needed.
 *
 * Quality phases:
 *   read → edit → self-review → deterministic-verify → peer-review → typecheck
 *   → bundle → regression-tests → bundle-probe → commit → push → PR.
 *   Every agent edit has a deterministic `git diff --quiet` + grep gate
 *   immediately after. Each downstream gate (typecheck, bundle,
 *   regression-tests) is a single deterministic step with failOnError: true
 *   — if it fails, the workflow halts and the operator inspects the captured
 *   output. The earlier self-review + peer-review + verify phases already
 *   validated the agent edits, so a tester-agent fix loop on top would just
 *   thrash codex spawn cycles when there's nothing to fix (and time out on
 *   passing gates — see run d5419360 for that failure mode).
 *
 * Resume semantics: this is a one-shot DAG. Re-running from scratch is safe
 * (every edit step reads the file fresh, so re-runs converge). There is no
 * `--wave` or `--resume` support.
 */

import { workflow } from '@relayflows/core';
import { ClaudeModels, CodexModels } from '@agent-relay/config';

const SPEC_PATH = 'workflows/cf-runtime/06-sage-worker-cutover-SPEC.md';
const WORKER_TS = 'packages/sage-worker/src/worker.ts';
const INFRA_TS = 'infra/sage.ts';
const SAGE_WORKER_PKG = 'packages/sage-worker';
const CHANNEL = 'wf-cf-runtime-sage-cutover';

async function runWorkflow() {
  const result = await workflow('cf-runtime-sage-cutover')
    .description(
      'Migrate cloud/packages/sage-worker off ctx.waitUntil(...) and onto ' +
        '@agent-assistant/cloudflare-runtime queue+DO, killing the production ' +
        'Slack-silence bug. Includes self-review + peer-review per impl.',
    )
    .pattern('dag')
    .channel(CHANNEL)
    .maxConcurrency(5)
    .timeout(3_600_000)

    // ──────────────────── Agents ────────────────────
    .agent('lead', {
      cli: 'claude',
      model: ClaudeModels.OPUS,
      role:
        'Architect and channel coordinator. Reads the SPEC, posts the assignment ' +
        'to the channel, watches both impl agents, and issues the final ' +
        'OWNER_DECISION when typecheck + build + tests + peer reviews are all green.',
      retries: 1,
    })
    .agent('impl-worker', {
      cli: 'codex',
      model: CodexModels.GPT_5_5,
      role:
        `Implementer for ${WORKER_TS}. Rewrites the sage-worker entrypoint to ` +
        'use wrapCloudflareWorker + handleCfQueue + TurnExecutorDO from ' +
        '@agent-assistant/cloudflare-runtime. Self-reviews its own diff before ' +
        'handing off to peer review.',
      retries: 2,
    })
    .agent('impl-infra', {
      cli: 'codex',
      model: CodexModels.GPT_5_5,
      role:
        `Implementer for ${INFRA_TS}. Adds Queue + DO bindings + DO migration JSON ` +
        'to the sage worker SST config. Self-reviews its own diff before handing ' +
        'off to peer review.',
      retries: 2,
    })
    .agent('reviewer', {
      cli: 'claude',
      model: ClaudeModels.OPUS,
      preset: 'reviewer',
      role:
        'Peer reviewer. Reads each impl\'s diff (post-self-review) and verifies ' +
        'it against the SPEC and cf-runtime exported contract. Returns ' +
        'PEER_REVIEW: PASS or specific fixes needed. Distinct from `lead` so ' +
        'the channel-coordinator and the reviewer eyes are different.',
      retries: 1,
    })

    // ──────────────────────────────────────────────────────────────────
    // Phase 0 — Read context (deterministic, parallel)
    // ──────────────────────────────────────────────────────────────────

    .step('read-spec', {
      type: 'deterministic',
      command: `cat ${SPEC_PATH}`,
      captureOutput: true,
      failOnError: true,
    })

    .step('read-cf-runtime-index', {
      type: 'deterministic',
      command:
        'cat ../agent-assistant/packages/cloudflare-runtime/src/index.ts 2>/dev/null || ' +
        'gh api repos/AgentWorkforce/agent-assistant/contents/packages/cloudflare-runtime/src/index.ts ' +
        '--jq .content | base64 -d',
      captureOutput: true,
      failOnError: true,
    })

    .step('read-cf-runtime-types', {
      type: 'deterministic',
      command:
        'cat ../agent-assistant/packages/cloudflare-runtime/src/types.ts 2>/dev/null || ' +
        'gh api repos/AgentWorkforce/agent-assistant/contents/packages/cloudflare-runtime/src/types.ts ' +
        '--jq .content | base64 -d',
      captureOutput: true,
      failOnError: true,
    })

    .step('read-cf-runtime-ingress', {
      type: 'deterministic',
      command:
        'cat ../agent-assistant/packages/cloudflare-runtime/src/ingress/cf-ingress.ts 2>/dev/null || ' +
        'gh api repos/AgentWorkforce/agent-assistant/contents/packages/cloudflare-runtime/src/ingress/cf-ingress.ts ' +
        '--jq .content | base64 -d',
      captureOutput: true,
      failOnError: true,
    })

    .step('read-cf-runtime-executor', {
      type: 'deterministic',
      command:
        'cat ../agent-assistant/packages/cloudflare-runtime/src/executor/cf-turn-executor.ts 2>/dev/null || ' +
        'gh api repos/AgentWorkforce/agent-assistant/contents/packages/cloudflare-runtime/src/executor/cf-turn-executor.ts ' +
        '--jq .content | base64 -d',
      captureOutput: true,
      failOnError: true,
    })

    .step('read-cf-runtime-do', {
      type: 'deterministic',
      command:
        'cat ../agent-assistant/packages/cloudflare-runtime/src/do/turn-executor-do.ts 2>/dev/null || ' +
        'gh api repos/AgentWorkforce/agent-assistant/contents/packages/cloudflare-runtime/src/do/turn-executor-do.ts ' +
        '--jq .content | base64 -d',
      captureOutput: true,
      failOnError: true,
    })

    .step('read-sage-exports', {
      type: 'deterministic',
      command:
        'echo "--- sage parseSlackWebhook + runSageTurn signatures ---"; ' +
        'grep -n "export async function parseSlackWebhook\\|export async function runSageTurn\\|export type AckOrDispatch\\|export type SageBindings\\|interface AckOrDispatch" ' +
        '../sage/src/app/slack-webhooks.ts ../sage/src/app/sage-turn-descriptor.ts ../sage/src/index.ts 2>/dev/null | head -40; ' +
        'echo "--- sage published .d.ts (npm) ---"; ' +
        'cat node_modules/@agentworkforce/sage/dist/index.d.ts 2>/dev/null | head -40',
      captureOutput: true,
      failOnError: false,
    })

    .step('read-current-worker', {
      type: 'deterministic',
      command: `cat ${WORKER_TS}`,
      captureOutput: true,
      failOnError: true,
    })

    .step('read-current-infra', {
      type: 'deterministic',
      command: `cat ${INFRA_TS}`,
      captureOutput: true,
      failOnError: true,
    })

    // Convenience: a combined "context" pseudo-step, just so the lead +
    // impls + reviewers all gate on the same pre-read fan-out without
    // restating the same eight dependsOn lines.
    .step('context', {
      type: 'deterministic',
      dependsOn: [
        'read-spec',
        'read-cf-runtime-index',
        'read-cf-runtime-types',
        'read-cf-runtime-ingress',
        'read-cf-runtime-executor',
        'read-cf-runtime-do',
        'read-sage-exports',
        'read-current-worker',
        'read-current-infra',
      ],
      command: 'echo "context-ready"',
      captureOutput: true,
      failOnError: true,
    })

    // Always work on a dedicated cutover branch off the current HEAD so
    // `gh pr create` at the end opens a fresh PR independent of whichever
    // branch the operator launched from. `-B` is idempotent — creates or
    // resets the branch to HEAD without touching the working tree, so the
    // SPEC + this workflow file (already committed on the launch branch)
    // are carried into the new branch as ancestor commits.
    .step('checkout-cutover-branch', {
      type: 'deterministic',
      dependsOn: ['context'],
      command:
        'git checkout -B feat/sage-worker-cf-runtime-cutover && ' +
        'git rev-parse --abbrev-ref HEAD',
      captureOutput: true,
      failOnError: true,
    })

    // ──────────────────────────────────────────────────────────────────
    // Phase 1 — Lead posts assignment (parallel start with both impls)
    // ──────────────────────────────────────────────────────────────────

    .step('lead-coordinate', {
      agent: 'lead',
      dependsOn: ['checkout-cutover-branch'],
      task: [
        `You are the lead on #${CHANNEL}. Workers: impl-worker, impl-infra.`,
        '',
        'The full design is in the SPEC. Read it carefully:',
        '',
        '{{steps.read-spec.output}}',
        '',
        'cf-runtime public surface (treat as the source of truth):',
        '',
        '{{steps.read-cf-runtime-index.output}}',
        '',
        'cf-runtime queue message types:',
        '',
        '{{steps.read-cf-runtime-types.output}}',
        '',
        'cf-runtime ingress contract:',
        '',
        '{{steps.read-cf-runtime-ingress.output}}',
        '',
        'cf-runtime executor + DO:',
        '',
        '{{steps.read-cf-runtime-executor.output}}',
        '',
        '{{steps.read-cf-runtime-do.output}}',
        '',
        'Sage 1.5.x exports we will compose with:',
        '',
        '{{steps.read-sage-exports.output}}',
        '',
        `Current ${WORKER_TS} (impl-worker will rewrite):`,
        '',
        '{{steps.read-current-worker.output}}',
        '',
        `Current ${INFRA_TS} (impl-infra will extend):`,
        '',
        '{{steps.read-current-infra.output}}',
        '',
        'Your job:',
        '1. Post a one-message assignment to the channel covering:',
        '   - the SPEC architecture in 4-6 lines',
        `   - the exact contract impl-worker must match (parse adapter, runTurn adapter, what to export from ${WORKER_TS})`,
        `   - the exact SST changes for ${INFRA_TS} that impl-infra owns`,
        '   - that no file outside the two we own may be edited',
        '2. Watch for impl-worker and impl-infra completion announcements + their self-review verdicts.',
        '3. Watch for the reviewer agent\'s peer-review verdicts. If reviewer flags a problem, relay it to the right impl on the channel and ask for a fix.',
        '4. Once both peer reviews pass and tester confirms the deterministic gates, post `OWNER_DECISION: COMPLETE` and exit.',
      ].join('\n'),
      retries: 1,
    })

    // ──────────────────────────────────────────────────────────────────
    // Phase 2 — Implementation (parallel)
    // ──────────────────────────────────────────────────────────────────

    .step('edit-worker-ts', {
      agent: 'impl-worker',
      dependsOn: ['checkout-cutover-branch'],
      task: [
        `You are impl-worker on #${CHANNEL}. Wait for the lead's assignment, then:`,
        '',
        `Rewrite ${WORKER_TS} so the sage worker uses @agent-assistant/cloudflare-runtime instead of re-exporting @agentworkforce/sage's default Hono app.`,
        '',
        'Required surface in the new file:',
        '- import wrapCloudflareWorker, handleCfQueue, TurnExecutorDO from @agent-assistant/cloudflare-runtime',
        '- import parseSlackWebhook, runSageTurn (and the AckOrDispatch + SageBindings types) from @agentworkforce/sage',
        '- compose an Env type that extends SageBindings with TURN_QUEUE, DEAD_LETTER_QUEUE (optional), TURN_EXECUTOR_DO',
        '- export default { fetch, queue } where:',
        '   - fetch is wrapCloudflareWorker(...).fetch with a /api/webhooks/slack route whose `parse` adapter calls sage.parseSlackWebhook and returns the cf-runtime ParseResult shape (lift dedupKey from result.turn.slackEvent if present)',
        '   - queue is handleCfQueue(...) configured to invoke sage.runSageTurn for `webhook` messages',
        '- export { TurnExecutorDO } so SST can bind it as a Durable Object class',
        '',
        'Hard rules:',
        '- IMPORTANT: write the file to disk. Do NOT print the file body to stdout.',
        '- Only edit this one file.',
        '- The exact handleCfQueue / TurnExecutorDO contract is in the executor + DO source the lead just shared. Match what is actually exported, not what the SPEC sketches.',
        '- If the cf-runtime ParseResult `turn` field is `unknown`, pass through whatever sage returns — do not re-shape it.',
        '- Do not change any other file in this step.',
        '',
        'When done, post a one-line completion to the channel: "edit-worker-ts: done — ready for self-review".',
      ].join('\n'),
      verification: { type: 'exit_code' },
      retries: 2,
    })

    .step('self-review-worker-ts', {
      agent: 'impl-worker',
      dependsOn: ['edit-worker-ts'],
      task: [
        `You just edited ${WORKER_TS}. Now self-review your own work before handing off to peer review.`,
        '',
        `Run: \`git diff ${WORKER_TS}\` and read your full diff.`,
        '',
        'Verify against this checklist:',
        '1. The file imports `wrapCloudflareWorker`, `handleCfQueue`, and `TurnExecutorDO` from `@agent-assistant/cloudflare-runtime`.',
        '2. The file imports `parseSlackWebhook` and `runSageTurn` from `@agentworkforce/sage`.',
        '3. The default export has both `fetch` and `queue` properties.',
        '4. The `parse` adapter passed to `wrapCloudflareWorker` returns the actual cf-runtime `ParseResult` shape — `kind`, `response`, optional `turn`, optional `dedupKey` — and lifts `dedupKey` from the sage result\'s `slackEvent` if available.',
        '5. The queue consumer calls `sage.runSageTurn` for webhook messages (you may need to adapt the descriptor type).',
        '6. `TurnExecutorDO` is re-exported as a named export (so SST can bind it).',
        '7. The file does NOT call `ctx.waitUntil(...)` anywhere — that was the whole point of this rewrite.',
        '8. No `import { default } from "@agentworkforce/sage"` re-export remains.',
        '',
        'If anything is wrong, edit the file to fix it, run `git diff` again, and re-check. Loop until the checklist holds.',
        '',
        'When you are satisfied, post on the channel:',
        '`SELF_REVIEW (impl-worker): PASS`',
        '',
        'If you cannot satisfy the checklist after 2 fix attempts, post:',
        '`SELF_REVIEW (impl-worker): NEEDS_HELP — <one-line reason>`',
        'and stop. The lead will engage.',
      ].join('\n'),
      verification: { type: 'exit_code' },
      retries: 1,
    })

    .step('verify-worker-ts', {
      type: 'deterministic',
      dependsOn: ['self-review-worker-ts'],
      command: [
        `if git diff --quiet ${WORKER_TS}; then echo "NOT MODIFIED"; exit 1; fi`,
        `grep -q "wrapCloudflareWorker" ${WORKER_TS} || (echo "MISSING wrapCloudflareWorker import"; exit 1)`,
        `grep -q "handleCfQueue" ${WORKER_TS} || (echo "MISSING handleCfQueue import"; exit 1)`,
        `grep -q "TurnExecutorDO" ${WORKER_TS} || (echo "MISSING TurnExecutorDO export"; exit 1)`,
        `grep -q "parseSlackWebhook" ${WORKER_TS} || (echo "MISSING parseSlackWebhook usage"; exit 1)`,
        `grep -q "runSageTurn" ${WORKER_TS} || (echo "MISSING runSageTurn usage"; exit 1)`,
        `! grep -q "ctx.waitUntil" ${WORKER_TS} || (echo "STILL CALLING ctx.waitUntil — defeats the cutover"; exit 1)`,
        'echo "OK"',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('edit-infra-ts', {
      agent: 'impl-infra',
      dependsOn: ['checkout-cutover-branch'],
      task: [
        `You are impl-infra on #${CHANNEL}. Wait for the lead's assignment, then:`,
        '',
        `Update ${INFRA_TS} to add the Queue + DO bindings the new sage-worker entrypoint needs.`,
        '',
        'Required additions:',
        '1. A new `sst.cloudflare.Queue("SageTurnQueue", { ... })` bound onto the Sage worker as `TURN_QUEUE`.',
        '2. A dead-letter queue: `sst.cloudflare.Queue("SageTurnDeadLetterQueue")` bound as `DEAD_LETTER_QUEUE`.',
        '3. Wire the same worker as a queue consumer of `TURN_QUEUE` — not a separate consumer worker.',
        '4. Register a Durable Object class binding `TURN_EXECUTOR_DO` that points at the `TurnExecutorDO` class exported by `packages/sage-worker/src/worker.ts`.',
        '5. Add the first DO migration: `{ tag: "v1", new_classes: ["TurnExecutorDO"] }`. Forward-only — the class name must match impl-worker\'s export exactly.',
        '',
        'Hard rules:',
        '- IMPORTANT: write the file to disk. Do NOT print it to stdout.',
        '- Only edit this one file.',
        '- Preserve every existing binding, secret, and KV namespace exactly. The new bindings ADD; nothing existing changes name or shape.',
        '- Match the project\'s existing SST conventions (study how DEDUP / THREADS / PREFS KVs are wired in the same file and follow that pattern for the Queue + DO).',
        '',
        'When done, post a one-line completion to the channel: "edit-infra-ts: done — ready for self-review".',
      ].join('\n'),
      verification: { type: 'exit_code' },
      retries: 2,
    })

    .step('self-review-infra-ts', {
      agent: 'impl-infra',
      dependsOn: ['edit-infra-ts'],
      task: [
        `You just edited ${INFRA_TS}. Now self-review before handing off.`,
        '',
        `Run: \`git diff ${INFRA_TS}\` and read your full diff.`,
        '',
        'Verify against this checklist:',
        '1. A new `sst.cloudflare.Queue` is declared and bound onto the Sage worker as `TURN_QUEUE`.',
        '2. A dead-letter queue is declared and bound as `DEAD_LETTER_QUEUE`.',
        '3. The Sage worker is registered as the queue consumer of `TURN_QUEUE` — not a separate consumer worker.',
        '4. A Durable Object class binding `TURN_EXECUTOR_DO` exists and references the `TurnExecutorDO` class name (must match what impl-worker exports).',
        '5. A DO migration entry exists with `new_classes: ["TurnExecutorDO"]` and a tag (e.g. `"v1"`).',
        '6. No existing bindings (DEDUP, THREADS, PREFS, SIGNALS, QUIET_HOURS, secrets) had their names or shapes changed.',
        '7. SST conventions in the file match how the existing KV namespaces are wired (no copy-paste from another project\'s style).',
        '',
        'If anything is wrong, edit the file to fix it, re-`git diff`, and re-check. Loop until the checklist holds.',
        '',
        'When satisfied, post on the channel:',
        '`SELF_REVIEW (impl-infra): PASS`',
        '',
        'If stuck after 2 fix attempts, post:',
        '`SELF_REVIEW (impl-infra): NEEDS_HELP — <one-line reason>`',
        'and stop.',
      ].join('\n'),
      verification: { type: 'exit_code' },
      retries: 1,
    })

    .step('verify-infra-ts', {
      type: 'deterministic',
      dependsOn: ['self-review-infra-ts'],
      command: [
        `if git diff --quiet ${INFRA_TS}; then echo "NOT MODIFIED"; exit 1; fi`,
        `grep -q "TURN_QUEUE" ${INFRA_TS} || (echo "MISSING TURN_QUEUE binding"; exit 1)`,
        `grep -q "TURN_EXECUTOR_DO" ${INFRA_TS} || (echo "MISSING TURN_EXECUTOR_DO binding"; exit 1)`,
        `grep -q "TurnExecutorDO" ${INFRA_TS} || (echo "MISSING TurnExecutorDO class reference"; exit 1)`,
        `grep -q "DEAD_LETTER_QUEUE\\|DeadLetter" ${INFRA_TS} || (echo "MISSING DEAD_LETTER_QUEUE binding"; exit 1)`,
        `grep -E -q "new_classes.*TurnExecutorDO|new_classes.*\\[" ${INFRA_TS} || (echo "MISSING DO migration new_classes"; exit 1)`,
        'echo "OK"',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ──────────────────────────────────────────────────────────────────
    // Phase 3 — Peer review (parallel; non-interactive Claude reviewer)
    // ──────────────────────────────────────────────────────────────────

    .step('diff-worker-ts', {
      type: 'deterministic',
      dependsOn: ['verify-worker-ts'],
      command: `git diff ${WORKER_TS}`,
      captureOutput: true,
      failOnError: false,
    })

    .step('peer-review-worker-ts', {
      agent: 'reviewer',
      dependsOn: ['diff-worker-ts'],
      task: [
        `Peer-review the diff for ${WORKER_TS}. You are a fresh pair of eyes — distinct from the impl agent that wrote it.`,
        '',
        'SPEC (architecture you must verify the diff matches):',
        '{{steps.read-spec.output}}',
        '',
        'cf-runtime public exports (the contract impl must match):',
        '{{steps.read-cf-runtime-index.output}}',
        '',
        'cf-runtime ingress + executor + DO source:',
        '{{steps.read-cf-runtime-ingress.output}}',
        '{{steps.read-cf-runtime-executor.output}}',
        '{{steps.read-cf-runtime-do.output}}',
        '',
        `The diff to review (output of \`git diff ${WORKER_TS}\`):`,
        '{{steps.diff-worker-ts.output}}',
        '',
        'Review checklist:',
        '1. Does the new file actually wire wrapCloudflareWorker, handleCfQueue, and TurnExecutorDO together correctly per the cf-runtime exports above?',
        '2. Is the parse adapter signature `(req, env) => Promise<ParseResult>` and does it return the right `kind` / `response` / `turn` / `dedupKey` shape?',
        '3. Does the queue consumer actually invoke `sage.runSageTurn`, not some other path?',
        '4. Is `TurnExecutorDO` re-exported by name (matching what infra/sage.ts will bind)?',
        '5. Any dead `ctx.waitUntil` left in the file? (Would defeat the cutover.)',
        '6. Any imports that won\'t resolve at build time (e.g. wrong package paths, types-only imports used at runtime)?',
        '',
        'Reply with EXACTLY ONE of:',
        '- `PEER_REVIEW (worker.ts): PASS` — and a one-paragraph summary of what you verified.',
        '- `PEER_REVIEW (worker.ts): CHANGES_NEEDED` — followed by a numbered list of specific fixes (file/line + the fix).',
        '',
        'Do not edit any file. Reading-and-judging only.',
      ].join('\n'),
      verification: {
        type: 'output_contains',
        value: 'PEER_REVIEW (worker.ts): PASS',
      },
      retries: 1,
    })

    .step('diff-infra-ts', {
      type: 'deterministic',
      dependsOn: ['verify-infra-ts'],
      command: `git diff ${INFRA_TS}`,
      captureOutput: true,
      failOnError: false,
    })

    .step('peer-review-infra-ts', {
      agent: 'reviewer',
      dependsOn: ['diff-infra-ts'],
      task: [
        `Peer-review the diff for ${INFRA_TS}. You are a fresh pair of eyes — distinct from the impl agent that wrote it.`,
        '',
        'SPEC (the architecture and SST changes you must verify the diff matches):',
        '{{steps.read-spec.output}}',
        '',
        `Pre-edit ${INFRA_TS} (so you can see what existed):`,
        '{{steps.read-current-infra.output}}',
        '',
        `The diff to review (output of \`git diff ${INFRA_TS}\`):`,
        '{{steps.diff-infra-ts.output}}',
        '',
        'Review checklist:',
        '1. Are all existing bindings (DEDUP, THREADS, PREFS, SIGNALS, QUIET_HOURS, secrets) preserved exactly — same names, same shapes?',
        '2. Is `TURN_QUEUE` declared and bound onto the Sage worker?',
        '3. Is the dead-letter queue declared and bound as `DEAD_LETTER_QUEUE`?',
        '4. Is the same worker registered as the queue consumer (not a separate consumer worker)?',
        '5. Is the DO binding `TURN_EXECUTOR_DO` declared and pointing at the class name `TurnExecutorDO`?',
        '6. Is the DO migration entry present with `new_classes: ["TurnExecutorDO"]` and a tag?',
        '7. Does the SST style match how existing KV namespaces are wired in this same file?',
        '',
        'Reply with EXACTLY ONE of:',
        '- `PEER_REVIEW (infra/sage.ts): PASS` — and a one-paragraph summary.',
        '- `PEER_REVIEW (infra/sage.ts): CHANGES_NEEDED` — followed by a numbered list of fixes.',
        '',
        'Do not edit any file. Reading-and-judging only.',
      ].join('\n'),
      verification: {
        type: 'output_contains',
        value: 'PEER_REVIEW (infra/sage.ts): PASS',
      },
      retries: 1,
    })

    // ──────────────────────────────────────────────────────────────────
    // Phase 4 — Deterministic gates (single-shot, fail-fast)
    //
    // Earlier versions of this file used a test-fix-rerun triplet for each
    // gate (run → fix-with-tester-agent → final-rerun). That backfired when
    // a gate passed first try: the tester agent still got spawned to "fix"
    // a passing gate, took 2 min just to confirm there was nothing to do,
    // and on bundle the codex spawn timed out across 2 retries killing the
    // whole run (see run d5419360 for the failure mode).
    //
    // The self-review + peer-review + deterministic-verify earlier in the
    // workflow already validate the agent edits. By the time we reach a
    // gate, the work is either correct (most common case, gate passes
    // immediately) or genuinely broken (gate hard-fails and a human
    // inspects, which is faster than thrashing through codex spawn cycles
    // when a deterministic step has already told us what's wrong).
    //
    // So each gate here is a single deterministic step with
    // failOnError: true. If a gate fails, the workflow halts at that
    // step; the operator reads the captured output, makes the fix
    // manually, and either resumes or re-runs.
    // ──────────────────────────────────────────────────────────────────

    .step('typecheck', {
      type: 'deterministic',
      dependsOn: ['peer-review-worker-ts', 'peer-review-infra-ts'],
      command: `npx tsc -p ${SAGE_WORKER_PKG}/tsconfig.json --noEmit 2>&1`,
      captureOutput: true,
      failOnError: true,
    })

    // The actual workspace name is `@cloud/sage-worker` and it has no
    // `build` script, so we substitute a direct esbuild bundle. Same
    // command impl-worker uses for self-validation; catches missing
    // imports / wrong package paths / runtime-only references that
    // escape typecheck.
    .step('bundle', {
      type: 'deterministic',
      dependsOn: ['typecheck'],
      command:
        `npx esbuild ${SAGE_WORKER_PKG}/src/worker.ts --bundle --platform=node --format=esm ` +
        '--outfile=/tmp/sage-worker-bundle.js 2>&1',
      captureOutput: true,
      failOnError: true,
    })

    // ──────────────────────────────────────────────────────────────────
    // Phase 5 — Regression: existing cloud tests still green
    // ──────────────────────────────────────────────────────────────────

    .step('regression-tests', {
      type: 'deterministic',
      dependsOn: ['bundle'],
      command: 'npm test 2>&1',
      captureOutput: true,
      failOnError: true,
    })

    // ──────────────────────────────────────────────────────────────────
    // Phase 6 — Existing CI bundle probe (best-effort)
    // ──────────────────────────────────────────────────────────────────

    .step('sage-worker-bundle-probe', {
      type: 'deterministic',
      dependsOn: ['regression-tests'],
      command:
        'if [ -f scripts/probe-sage-worker-bundle.mjs ]; then ' +
        'node scripts/probe-sage-worker-bundle.mjs; ' +
        'else echo "no bundle probe script — skipping"; fi',
      captureOutput: true,
      failOnError: true,
    })

    // ──────────────────────────────────────────────────────────────────
    // Phase 7 — Commit, push, PR
    // ──────────────────────────────────────────────────────────────────

    .step('commit', {
      type: 'deterministic',
      dependsOn: ['sage-worker-bundle-probe'],
      command:
        `git add ${WORKER_TS} ${INFRA_TS} ${SPEC_PATH} workflows/cf-runtime/06-sage-worker-cutover.ts && ` +
        'git commit -m "feat(sage-worker): cut over to @agent-assistant/cloudflare-runtime queue+DO ' +
        '(closes silent-Slack-reply bug)"',
      captureOutput: true,
      failOnError: true,
    })

    .step('push', {
      type: 'deterministic',
      dependsOn: ['commit'],
      command:
        'git push -u origin "$(git rev-parse --abbrev-ref HEAD)" 2>&1 | tail -10',
      captureOutput: true,
      failOnError: true,
    })

    .step('open-pr', {
      type: 'deterministic',
      dependsOn: ['push'],
      command: [
        'gh pr create --repo AgentWorkforce/cloud',
        ' --title "feat(sage-worker): cut over to cloudflare-runtime queue+DO (kills silent-Slack-reply bug)"',
        ` --body-file ${SPEC_PATH}`,
        ' > pr-url.txt 2>&1',
        ' && echo "PR: $(cat pr-url.txt)"',
      ].join(''),
      captureOutput: true,
      failOnError: true,
    })

    .onError('retry', { maxRetries: 2, retryDelayMs: 10_000 })
    .run({ cwd: process.cwd() });

  console.log('Workflow status:', result.status);
  // Only fail the script on an explicit failure status. In --dry-run mode
  // result.status comes back undefined (no actual run happened), and
  // exiting 1 there would falsely signal a broken workflow file.
  if (result.status === 'failed' || result.status === 'failure' || result.status === 'error') {
    process.exit(1);
  }
}

runWorkflow().catch((error) => {
  console.error(error);
  process.exit(1);
});
