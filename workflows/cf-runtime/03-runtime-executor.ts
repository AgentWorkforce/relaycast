// W3: CfTurnExecutor + TurnExecutorDO base class + CfDeliveryAdapter +
// CfSpecialistClient + replay harness regression test.
//
// This is the workflow that proves the end-to-end fix works. It adds the
// queue consumer that assembles the continuation runtime from the pieces
// delivered by W1 and W2, plus the replay harness test that is the direct
// regression test for the production bug.
//
// Target repo: agent-assistant
// Branch: feat/cf-runtime-executor
// Base: feat/cf-runtime-continuation-adapters (W2) — which itself branches
// from W1.

import { workflow } from '@relayflows/core';
import { applyWorktreeSetup, inWorktree, pushAndOpenPrStep } from './lib/worktree-setup.ts';

const REPO_PATH = '/Users/khaliqgant/Projects/AgentWorkforce/agent-assistant';
const BRANCH = 'feat/cf-runtime-executor';
const BASE_BRANCH = 'feat/cf-runtime-continuation-adapters';
const REPO_SLUG = 'AgentWorkforce/agent-assistant';
const WORKTREE_PATH = `${REPO_PATH}/../.cf-runtime-worktrees/feat-cf-runtime-executor`;

async function runWorkflow() {
  let wf = workflow('cf-runtime-03-executor')
    .description('Wire CfTurnExecutor + TurnExecutorDO base class + delivery adapter + specialist client + replay harness regression test.')
    .pattern('dag')
    .channel('wf-cf-runtime-03')
    .maxConcurrency(5)
    .timeout(3_600_000)

    .agent('lead', {
      cli: 'claude',
      role: 'Architecture lead. Owns the executor integration. Rejects any design where a suspended turn loses continuation state, or where the DO is not the single writer for its conversation.',
      retries: 1,
    })
    .agent('impl-executor', {
      cli: 'codex',
      role: 'Implements CfTurnExecutor — the queue() handler that composes ingress messages, continuation runtime, and delivery adapter.',
      retries: 2,
    })
    .agent('impl-do', {
      cli: 'codex',
      role: 'Implements TurnExecutorDO abstract base class — per-conversation serializer with alarm handler and fetch() RPC for same-DO resume.',
      retries: 2,
    })
    .agent('impl-delivery', {
      cli: 'codex',
      role: 'Implements CfDeliveryAdapter (Slack/GitHub/a2a-callback delivery) and CfSpecialistClient (fire-and-trigger-on-result).',
      retries: 2,
    })
    .agent('tester', {
      cli: 'claude',
      preset: 'worker',
      role: 'Writes tests AND the replay harness regression test — a real harness turn that suspends twice, completes under the fake ctx, and delivers a reply. This is the direct regression test for the Slack-silence bug.',
      retries: 2,
    })
    .agent('reviewer', {
      cli: 'claude',
      preset: 'reviewer',
      role: 'Reviews the full diff. Verifies every SPEC invariant. Verifies the replay harness test proves the bug is fixed.',
      retries: 1,
    });

  wf = applyWorktreeSetup(wf, {
    repoLabel: 'agent-assistant',
    repoPath: REPO_PATH,
    branch: BRANCH,
    base: BASE_BRANCH,
    worktreePath: WORKTREE_PATH,
    extraSetupCommands: [
      'cd "$WT" && npm run build --workspaces --if-present 2>&1 | tail -20 || true',
    ],
    expectedDirty: [
      'packages/cloudflare-runtime/src/executor/cf-turn-executor.ts',
      'packages/cloudflare-runtime/src/executor/replay-harness.test.ts',
      'packages/cloudflare-runtime/src/do/turn-executor-do.ts',
      'packages/cloudflare-runtime/src/adapters/cf-delivery-adapter.ts',
      'packages/cloudflare-runtime/src/adapters/cf-specialist-client.ts',
      'packages/cloudflare-runtime/src/index.ts',
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
    .step('read-continuation-runtime', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: inWorktree(
        WORKTREE_PATH,
        'echo "=== continuation.ts ===" && cat packages/continuation/src/continuation.ts && echo "=== types.ts ===" && cat packages/continuation/src/types.ts',
      ),
      captureOutput: true,
      failOnError: true,
    });

  // The lead is running interactively and coordinates all four impl agents + tester on channel.
  const leadTask = [
    'You are the lead on #wf-cf-runtime-03. Workers: impl-executor, impl-do, impl-delivery, tester.',
    '',
    'This is the workflow where the production bug is actually fixed end-to-end. The',
    'replay harness test that tester writes is the regression test — if it passes, the',
    'Sage silence bug will not recur.',
    '',
    'Critical integration points:',
    '  - CfTurnExecutor.queue() composes: CfContinuationStore (W2) + CfContinuationScheduler (W2)',
    '    + CfDeliveryAdapter + createContinuationRuntime from @agent-assistant/continuation.',
    '  - Queue message types from SPEC §"Queue message schema". Webhook messages route into',
    '    harness start; resume messages route into continuation.resume(); specialist_result',
    '    into continuation.resume() with the matching trigger.',
    '  - TurnExecutorDO is abstract — the persona (sage, specialist) subclasses it in the',
    '    cloud repo. The base class owns: fetch() RPC entry, alarm() handler that fans out',
    '    `alarm-queue` storage into continuation.resume() calls, and the fake ExecutionContext',
    '    pattern (W1) wrapping every invocation.',
    '',
    'Review worker diffs between rounds. The only way to catch a silent waitUntil leak is',
    'to read the code — demand that every async op inside the queue handler is either:',
    '  (a) awaited directly, or',
    '  (b) pushed into the fake ctx\'s pending array, which the handler awaits before returning.',
    '',
    `Worktree: ${WORKTREE_PATH}`,
    `Branch: ${BRANCH} off ${BASE_BRANCH}`,
    '',
    'SPEC:',
    '{{steps.read-spec.output}}',
    '',
    'Upstream continuation runtime:',
    '{{steps.read-continuation-runtime.output}}',
  ].join('\n');

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('lead-coordinate', {
      agent: 'lead',
      dependsOn: ['read-spec', 'read-continuation-runtime'],
      task: leadTask,
    });

  const implExecutorTask = [
    'You are impl-executor on #wf-cf-runtime-03.',
    '',
    `Worktree: ${WORKTREE_PATH}.`,
    '',
    'Create:',
    '  packages/cloudflare-runtime/src/executor/cf-turn-executor.ts',
    '',
    'Exports:',
    '  export interface CfTurnExecutorOptions<Env, HarnessAdapter> {',
    '    harnessAdapter: (env: Env) => HarnessAdapter;',
    '    deliveryAdapter: (env: Env) => ContinuationDeliveryAdapter;',
    '    buildStore: (env: Env, conversationId: string) => ContinuationStore;',
    '    buildScheduler: (env: Env, conversationId: string) => ContinuationSchedulerAdapter;',
    '    resolveConversationId: (msg: TurnQueueMessage) => string;',
    '  }',
    '  export function handleCfQueue<Env, HA>(',
    '    batch: MessageBatch<TurnQueueMessage>,',
    '    env: Env,',
    '    ctx: ExecutionContext,',
    '    opts: CfTurnExecutorOptions<Env, HA>,',
    '  ): Promise<void>;',
    '',
    'Behavior:',
    '  For each message in batch.messages:',
    '    - Wrap in try/catch. Any throw → msg.retry(). Terminal poison → batch writes to DLQ',
    '      via the queue\'s configured dead-letter (configured at SST level, not here).',
    '    - Create a fake ExecutionContext (import from W1) — collect waitUntil promises.',
    '    - Resolve conversationId via opts.resolveConversationId.',
    '    - Build store + scheduler scoped to that conversation.',
    '    - Build continuation runtime: createContinuationRuntime({ store, scheduler,',
    '      delivery: opts.deliveryAdapter(env), harness: opts.harnessAdapter(env) }).',
    '    - Dispatch by msg.type:',
    '      * "webhook": parse provider event, call runtime.start({ ... }). The runtime',
    '        runs the harness; if it suspends, a continuation is written via store.create',
    '        and scheduler.schedule is called. If it completes, delivery is called.',
    '      * "resume": runtime.resume({ continuationId, trigger }).',
    '      * "specialist_call": route through a specialist harness entry point',
    '        (same runtime, different harness tier). On complete, fire the callback trigger',
    '        via an outbound resume message (cross-DO queue send).',
    '      * "specialist_result": runtime.resume({ ..., trigger }) — this is the sage-side',
    '        side of the async bridge.',
    '    - After dispatch returns, await fakeCtx.waitForPending() (SPEC Invariant #1).',
    '    - msg.ack().',
    '',
    'Post "IMPL_EXECUTOR_DONE" when done.',
    '',
    'SPEC: {{steps.read-spec.output}}',
  ].join('\n');

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('impl-executor-work', {
      agent: 'impl-executor',
      dependsOn: ['read-spec', 'read-continuation-runtime'],
      task: implExecutorTask,
    });

  const implDoTask = [
    'You are impl-do on #wf-cf-runtime-03.',
    '',
    `Worktree: ${WORKTREE_PATH}.`,
    '',
    'Create:',
    '  packages/cloudflare-runtime/src/do/turn-executor-do.ts',
    '',
    'Exports an ABSTRACT class `TurnExecutorDO<Env>` with:',
    '  - constructor(state: DurableObjectState, env: Env)',
    '  - abstract getExecutorOptions(): CfTurnExecutorOptions<Env, any>',
    '  - fetch(req: Request): Promise<Response>  — RPC entry for same-DO resume, expects',
    '    POST /resume with { continuationId, trigger } JSON body; runs the runtime\'s resume.',
    '  - alarm(): Promise<void>  — reads alarm-queue from state.storage, fans out to',
    '    continuation.resume() calls, clears queue, sets next alarm to earliest remaining.',
    '',
    'The class is abstract because the persona (sage, specialist) supplies getExecutorOptions().',
    'The concrete subclass lives in cloud/packages/cloudflare-agent-bindings in W5.',
    '',
    'IMPORTANT: The DO class may not import cloudflare:workers at module level because',
    'this package is platform-agnostic. Type `DurableObject` and `DurableObjectState` come',
    'from @cloudflare/workers-types (devDep). If runtime requires extending the',
    'cloudflare:workers DurableObject class, expose the subclass API via a structural type',
    'and let the concrete subclass do `extends DurableObject`. Document this clearly.',
    '',
    'Post "IMPL_DO_DONE" when done.',
    '',
    'SPEC: {{steps.read-spec.output}}',
  ].join('\n');

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('impl-do-work', {
      agent: 'impl-do',
      dependsOn: ['read-spec', 'read-continuation-runtime'],
      task: implDoTask,
    });

  const implDeliveryTask = [
    'You are impl-delivery on #wf-cf-runtime-03.',
    '',
    `Worktree: ${WORKTREE_PATH}.`,
    '',
    'Create:',
    '  packages/cloudflare-runtime/src/adapters/cf-delivery-adapter.ts',
    '  packages/cloudflare-runtime/src/adapters/cf-specialist-client.ts',
    '',
    'cf-delivery-adapter.ts:',
    '  - Implements ContinuationDeliveryAdapter.',
    '  - Switches on target.kind:',
    '      "slack": POST to Slack Web API chat.postMessage with the workspace bot token',
    '        (read from env). Handles chunking via MAX_REPLY_CHARS (import constant from',
    '        @agent-assistant/webhook-runtime if exported, otherwise define).',
    '      "github": POST a comment via GitHub App token (workspace-resolved).',
    '      "a2a-callback": POST to target.callbackUrl (specialist result flow). Prefer',
    '        service binding if env has one; else fetch.',
    '  - Returns ContinuationDeliveryResult with deliveryStatus. Maps HTTP 429/5xx to retry;',
    '    4xx (non-429) to fail-permanent.',
    '',
    'cf-specialist-client.ts:',
    '  - export function createCfSpecialistClient(deps: { binding: Fetcher; queue: Queue<TurnQueueMessage> }): ',
    '    { callSpecialist(opts: { turnId, capability, input, callbackTrigger }): Promise<void> }',
    '  - callSpecialist enqueues a specialist_call message rather than making a synchronous',
    '    HTTP call. This is the async bridge: sage suspends waiting on the trigger, specialist',
    '    runs, posts specialist_result back, sage resumes.',
    '',
    'Post "IMPL_DELIVERY_DONE" when done.',
    '',
    'SPEC: {{steps.read-spec.output}}',
  ].join('\n');

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('impl-delivery-work', {
      agent: 'impl-delivery',
      dependsOn: ['read-spec', 'read-continuation-runtime'],
      task: implDeliveryTask,
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('verify-files', {
      type: 'deterministic',
      dependsOn: ['impl-executor-work', 'impl-do-work', 'impl-delivery-work'],
      command: inWorktree(
        WORKTREE_PATH,
        [
          'missing=0',
          'for f in packages/cloudflare-runtime/src/executor/cf-turn-executor.ts packages/cloudflare-runtime/src/do/turn-executor-do.ts packages/cloudflare-runtime/src/adapters/cf-delivery-adapter.ts packages/cloudflare-runtime/src/adapters/cf-specialist-client.ts; do',
          '  if [ ! -f "$f" ]; then echo "MISSING: $f"; missing=$((missing+1)); fi',
          'done',
          'if [ $missing -gt 0 ]; then echo "$missing files missing"; exit 1; fi',
          'echo ALL_FILES_PRESENT',
        ].join('; '),
      ),
      captureOutput: true,
      failOnError: true,
    });

  // Wire index.ts to export the full public surface.
  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('wire-index', {
      agent: 'impl-executor',
      dependsOn: ['verify-files'],
      task: [
        `In ${WORKTREE_PATH}/packages/cloudflare-runtime/src/index.ts export the full public`,
        'surface:',
        '  wrapCloudflareWorker, handleCfQueue, TurnExecutorDO,',
        '  createCfContinuationStore, createCfContinuationScheduler,',
        '  createCfDeliveryAdapter, createCfSpecialistClient,',
        '  createFakeExecutionContext, verifySlackSignature, verifyGitHubSignature,',
        '  and every exported type from types.ts.',
        '',
        'Run `cd packages/cloudflare-runtime && npx tsc --noEmit` and ensure it is clean.',
      ].join('\n'),
      verification: { type: 'exit_code' },
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('typecheck', {
      type: 'deterministic',
      dependsOn: ['wire-index'],
      command: inWorktree(WORKTREE_PATH, 'cd packages/cloudflare-runtime && npx tsc --noEmit 2>&1 | tail -40; echo EXIT: $?'),
      captureOutput: true,
      failOnError: false,
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('fix-typecheck', {
      agent: 'impl-executor',
      dependsOn: ['typecheck'],
      task: [
        'Fix typecheck errors if any. Output:',
        '{{steps.typecheck.output}}',
        `Worktree: ${WORKTREE_PATH}.`,
      ].join('\n'),
      verification: { type: 'exit_code' },
    });

  // Unit tests for each adapter/executor/do.
  const writeUnitTestsTask = [
    'Write vitest unit tests for executor + DO + delivery + specialist client.',
    '',
    `Worktree: ${WORKTREE_PATH}.`,
    '',
    'Tests required (one file each, colocated):',
    '  src/executor/cf-turn-executor.test.ts',
    '    - webhook dispatches to runtime.start',
    '    - resume dispatches to runtime.resume with correct trigger',
    '    - specialist_result dispatches to runtime.resume',
    '    - exception => msg.retry called',
    '    - fake ctx pending is awaited (assert by adding a delayed waitUntil inside a',
    '      mock harness and verifying the pending counter drops to 0 before ack)',
    '',
    '  src/do/turn-executor-do.test.ts',
    '    - fetch POST /resume invokes runtime.resume',
    '    - alarm() drains alarm-queue storage',
    '    - alarm() re-arms next alarm when more are pending',
    '',
    '  src/adapters/cf-delivery-adapter.test.ts',
    '    - slack target: posts to chat.postMessage with correct body (mock fetch)',
    '    - slack 429: returns retry result',
    '    - slack 4xx: returns fail-permanent',
    '    - github target: posts to comments API',
    '    - a2a-callback: POST to callback URL',
    '',
    '  src/adapters/cf-specialist-client.test.ts',
    '    - callSpecialist enqueues specialist_call (does NOT make HTTP fetch)',
    '    - callbackTrigger is included in message body',
    '',
    'Run: `cd packages/cloudflare-runtime && npx vitest run`. Fix until green.',
  ].join('\n');

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('write-unit-tests', {
      agent: 'tester',
      dependsOn: ['fix-typecheck'],
      task: writeUnitTestsTask,
      verification: { type: 'exit_code' },
    });

  // THE replay harness test — the direct regression test for the production bug.
  const writeReplayHarnessTask = [
    'Write the REPLAY HARNESS regression test. This is the test that proves the fix works.',
    '',
    `Worktree: ${WORKTREE_PATH}.`,
    '',
    'Create: packages/cloudflare-runtime/src/executor/replay-harness.test.ts',
    '',
    'Setup:',
    '  - Use fake DO storage (from W2) + fake KV + fake Queue.',
    '  - Build a real createContinuationRuntime with those fakes.',
    '  - Provide a *real-feeling* fake harness adapter that:',
    '      * Takes a turn input.',
    '      * Step 1: calls specialist (suspends with trigger "specialist_result:1").',
    '      * Step 2: after resume, calls approval (suspends with trigger "approval:1").',
    '      * Step 3: after resume, returns "final reply to slack".',
    '  - Use a fake delivery adapter that records deliveries into an array.',
    '',
    'Scenario:',
    '  1. Deliver a webhook message via handleCfQueue. Expect:',
    '     - store.create called once (continuation for specialist_result:1).',
    '     - scheduler.schedule called (or queue.send for specialist_call).',
    '     - fakeCtx.pendingCount() == 0 after handleCfQueue returns.',
    '     - no delivery calls yet.',
    '  2. Simulate specialist result: deliver a specialist_result message with the callback',
    '     trigger. Expect:',
    '     - store.update moves continuation to approval-waiting.',
    '     - no delivery yet.',
    '  3. Simulate approval: deliver a resume message for the approval trigger. Expect:',
    '     - store.update moves continuation to terminal.',
    '     - deliveryAdapter.deliver called exactly once with "final reply to slack".',
    '',
    'Regression assertion:',
    '     - At every step, fakeCtx.pendingCount() returns to 0 before the consumer returns.',
    '       This directly asserts SPEC Invariant #1. If this assertion passes, the',
    '       production Slack-silence bug cannot recur in this code path.',
    '',
    'Run: `cd packages/cloudflare-runtime && npx vitest run src/executor/replay-harness.test.ts`.',
    'Fix until green.',
  ].join('\n');

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('write-replay-harness', {
      agent: 'tester',
      dependsOn: ['write-unit-tests'],
      task: writeReplayHarnessTask,
      verification: { type: 'file_exists', value: `${WORKTREE_PATH}/packages/cloudflare-runtime/src/executor/replay-harness.test.ts` },
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('run-tests', {
      type: 'deterministic',
      dependsOn: ['write-replay-harness'],
      command: inWorktree(WORKTREE_PATH, 'cd packages/cloudflare-runtime && npx vitest run 2>&1 | tail -100'),
      captureOutput: true,
      failOnError: false,
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('fix-tests', {
      agent: 'tester',
      dependsOn: ['run-tests'],
      task: [
        'Fix test failures. Output:',
        '{{steps.run-tests.output}}',
        'Iterate until ALL tests pass, including the replay harness test.',
        `Worktree: ${WORKTREE_PATH}.`,
      ].join('\n'),
      verification: { type: 'exit_code' },
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('run-tests-final', {
      type: 'deterministic',
      dependsOn: ['fix-tests'],
      command: inWorktree(WORKTREE_PATH, 'cd packages/cloudflare-runtime && npx vitest run'),
      captureOutput: true,
      failOnError: true,
    });

  // Reviewer reads the replay harness test carefully — this is the regression-proof artifact.
  const reviewTask = [
    'Review the executor integration. This is the PR that proves the production fix works.',
    '',
    `Worktree: ${WORKTREE_PATH}.`,
    '',
    'Read the full diff:',
    `  cd ${WORKTREE_PATH} && git diff origin/${BASE_BRANCH}...HEAD -- packages/cloudflare-runtime/`,
    '',
    'Then read the replay harness test closely:',
    `  cat packages/cloudflare-runtime/src/executor/replay-harness.test.ts`,
    '',
    'Verify:',
    '  [#1 replay] The replay harness test asserts fakeCtx.pendingCount() == 0 before ack',
    '       at every step. This is the direct regression test for the Slack-silence bug.',
    '       If this assertion is missing or weak, REJECT.',
    '  [#1 code] Grep for `ctx.waitUntil(` inside cf-turn-executor.ts — every occurrence',
    '       must be either (a) absent because we await directly, or (b) followed by a',
    '       matching `await fakeCtx.waitForPending()` before message ack.',
    '  [#2] Continuation create/update happens before the consumer returns — no fire-and-',
    '       forget store writes.',
    '  [#4] Ingress dedup (from W1) covers Slack retries; the executor trusts the queue.',
    '  [#5] DO is single writer — scheduler routes resume messages through the correct DO',
    '       via queue delayed-delivery.',
    '  [specialist async] CfSpecialistClient.callSpecialist does NOT use fetch — it enqueues.',
    '       This decouples sage from specialist\'s request budget.',
    '  [delivery] Delivery adapter handles 429/5xx as retry; 4xx as fail-permanent.',
    '',
    'Write VERDICT to packages/cloudflare-runtime/VERDICT-03.md with KEEP | PAUSE + sections',
    'Invariants checked / Replay harness evidence / Residual risks.',
  ].join('\n');

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('review', {
      agent: 'reviewer',
      dependsOn: ['run-tests-final'],
      task: reviewTask,
      verification: { type: 'file_exists', value: `${WORKTREE_PATH}/packages/cloudflare-runtime/VERDICT-03.md` },
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('verify-verdict', {
      type: 'deterministic',
      dependsOn: ['review'],
      command: [
        `cd ${JSON.stringify(WORKTREE_PATH)}`,
        'grep -Eqi "(^|[*#[:space:]])verdict:?[[:space:]]*keep" packages/cloudflare-runtime/VERDICT-03.md || (cat packages/cloudflare-runtime/VERDICT-03.md; exit 1)',
        'echo VERDICT_KEEP',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('commit', {
      type: 'deterministic',
      dependsOn: ['verify-verdict'],
      command: inWorktree(
        WORKTREE_PATH,
        [
          'set -e',
          'git add packages/cloudflare-runtime',
          'git add package.json package-lock.json',
          'MSG=$(mktemp)',
          'printf "%s\\n" "feat(cloudflare-runtime): executor + DO base + delivery + replay harness test" "" "- CfTurnExecutor: queue consumer composing continuation runtime + fake ctx" "- TurnExecutorDO: abstract per-conversation DO (personas subclass)" "- CfDeliveryAdapter: Slack/GitHub/a2a-callback delivery" "- CfSpecialistClient: async specialist bridge via queue enqueue" "- replay-harness.test.ts: direct regression test for Slack-silence bug" "" "The replay harness test asserts ctx.pendingCount() == 0 before ack on every" "turn, proving SPEC Invariant #1 holds end-to-end. This is the test to read if" "you are not sure whether the production bug can recur." > "$MSG"',
          'git commit -F "$MSG"',
          'rm -f "$MSG"',
        ].join(' && '),
      ),
      captureOutput: true,
      failOnError: true,
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('open-pr', pushAndOpenPrStep({
      worktreePath: WORKTREE_PATH,
      branch: BRANCH,
      baseBranch: BASE_BRANCH,
      repoSlug: REPO_SLUG,
      title: 'feat(cloudflare-runtime): executor + DO base + delivery + replay harness test',
      dependsOn: ['commit'],
      labels: ['cf-runtime', 'ready-to-publish-after-merge'],
      bodyLines: [
        '## Summary',
        'W3 of 4. Wires the queue consumer (`CfTurnExecutor`), the abstract per-conversation DO (`TurnExecutorDO`), the delivery adapter, and the async specialist client. Adds the **replay harness regression test** that directly proves the production Slack-silence bug cannot recur in this code path.',
        '',
        '## The replay harness test',
        'A real `createContinuationRuntime` is built with fakes for DO storage, KV, Queue, and delivery. A fake harness suspends twice (specialist → approval) and delivers a final Slack reply. The test asserts:',
        '1. Each queue invocation completes with `fakeCtx.pendingCount() === 0` before ack (SPEC Invariant #1).',
        '2. Continuation records reach terminal state.',
        '3. Delivery is called exactly once with the final payload.',
        '',
        'If this test stays green, the Sage silence bug cannot recur.',
        '',
        '## SPEC invariants verified',
        '- #1: `waitUntil` never orphans. Replay harness is the continuous assertion.',
        '- #2: continuation writes are synchronous on suspend.',
        '- #5: DO is single writer.',
        '- specialist async: no synchronous HTTP call from sage to specialist during a turn.',
        '',
        '## Order',
        'Depends on W2 (`feat/cf-runtime-continuation-adapters`). Do not merge until W2 is in.',
        '',
        '## Next (after W1/W2/W3/W4 all merge)',
        '1. Publish `@agent-assistant/cloudflare-runtime@0.1.0` and (if needed) `@agent-assistant/webhook-runtime@<bump>` to npm.',
        '2. Start Wave D in cloud repo: `workflows/cf-runtime/05-cloud-agent-persona-factory.ts`.',
      ],
    }));

  const result = await wf.run({ cwd: process.cwd() });
  console.log('Workflow status:', result.status);
}

runWorkflow().catch((error) => {
  console.error(error);
  process.exit(1);
});
