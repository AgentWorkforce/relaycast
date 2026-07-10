// W6: migrate sage-worker onto the new CF runtime. Consumes sage's NEW
// split exports (parseSlackWebhook + runSageTurn, landed in W0 and
// published as @agentworkforce/sage@1.5.0). No replay, no fake-ctx-over-
// sage.fetch wrapping — direct composition.
//
// Target repo: cloud
// Branch: feat/sage-on-cf-runtime
// Base: main (after W5 merges)

import { workflow } from '@relayflows/core';
import { applyWorktreeSetup, inWorktree, pushAndOpenPrStep } from './lib/worktree-setup.ts';

const REPO_PATH = '/Users/khaliqgant/Projects/AgentWorkforce/cloud';
const BRANCH = 'feat/sage-on-cf-runtime';
const REPO_SLUG = 'AgentWorkforce/cloud';
const WORKTREE_PATH = `${REPO_PATH}/../.cf-runtime-worktrees/cloud-feat-sage-on-cf-runtime`;

async function runWorkflow() {
  let wf = workflow('cf-runtime-06-sage-migration')
    .description('Migrate sage-worker onto @agent-assistant/cloudflare-runtime by consuming @agentworkforce/sage@1.5.0 split exports. Single dedup at ingress (SlackEventDedupGate). Turn runs in queue consumer inside a fake ctx. Local-run test is the 80-to-100 regression gate.')
    .pattern('dag')
    .channel('wf-cf-runtime-06')
    .maxConcurrency(4)
    .timeout(3_600_000)

    .agent('lead', {
      cli: 'claude',
      role: 'Lead. Rejects any drop of existing sage functionality, any return of per-persona dedup, any synchronous HTTP call from sage turn to specialist. Ensures pendingCount == 0 regression gate is enforced.',
      retries: 1,
    })
    .agent('impl-worker', {
      cli: 'codex',
      role: 'Rewrites packages/sage-worker/src/worker.ts to compose wrapCloudflareWorker + TurnExecutorDO from @agent-assistant/cloudflare-runtime, consuming parseSlackWebhook + runSageTurn from @agentworkforce/sage@1.5.0.',
      retries: 2,
    })
    .agent('impl-infra', {
      cli: 'codex',
      role: 'Refactors infra/sage.ts to call defineAgentPersona. Must preserve every existing resource so SST sees MOVES not REPLACES.',
      retries: 2,
    })
    .agent('tester', {
      cli: 'claude',
      preset: 'worker',
      role: 'Writes local-run validation test: deliver synthetic Slack event, assert exactly one turn enqueued (and second delivery deduped), queue consumer delivers reply, pendingCount == 0 at end. Direct regression test for the production Slack-silence bug.',
      retries: 2,
    })
    .agent('reviewer', {
      cli: 'claude',
      preset: 'reviewer',
      role: 'Reviews diff; verifies no resource loss; confirms new split exports are used (no black-box sage.fetch call); writes VERDICT.',
      retries: 1,
    });

  wf = applyWorktreeSetup(wf, {
    repoLabel: 'cloud',
    repoPath: REPO_PATH,
    branch: BRANCH,
    worktreePath: WORKTREE_PATH,
    extraSetupCommands: [
      'cd "$WT" && npm run build:platform 2>&1 | tail -5 || true',
      'cd "$WT" && npm run build:core 2>&1 | tail -5 || true',
    ],
    expectedDirty: [
      'packages/sage-worker/src/worker.ts',
      'packages/sage-worker/package.json',
      'packages/sage-worker/tests/local-run.test.ts',
      'infra/sage.ts',
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
    .step('verify-prereqs', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: inWorktree(
        WORKTREE_PATH,
        [
          'set -e',
          'test -f infra/agent-persona.ts || (echo "ERROR: W5 not merged — infra/agent-persona.ts missing"; exit 1)',
          'test -d packages/cloudflare-agent-bindings || (echo "ERROR: W5 not merged — cloudflare-agent-bindings missing"; exit 1)',
          'test -d node_modules/@agent-assistant/cloudflare-runtime || (echo "ERROR: runtime package not installed"; exit 1)',
          'SAGE_VERSION=$(node -p "require(\\"./node_modules/@agentworkforce/sage/package.json\\").version")',
          'echo "Sage version: $SAGE_VERSION"',
          'node -e "import(\\"@agentworkforce/sage\\").then(m => { const ok = m.parseSlackWebhook && m.runSageTurn; if (!ok) { console.error(\\"Missing parseSlackWebhook or runSageTurn — W0 not merged/published\\"); process.exit(1); } console.log(\\"sage exports OK\\"); })"',
          'echo PREREQS_OK',
        ].join(' && '),
      ),
      captureOutput: true,
      failOnError: true,
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('read-current-sage', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: inWorktree(
        WORKTREE_PATH,
        [
          'echo "=== packages/sage-worker/src/worker.ts ===" && cat packages/sage-worker/src/worker.ts',
          'echo "=== packages/sage-worker/package.json ===" && cat packages/sage-worker/package.json',
          'echo "=== infra/sage.ts ===" && cat infra/sage.ts',
        ].join(' && '),
      ),
      captureOutput: true,
      failOnError: true,
    });

  const leadTask = [
    'You are the lead on #wf-cf-runtime-06.',
    '',
    `Worktree: ${WORKTREE_PATH}.`,
    '',
    'Migrate sage-worker to run on the new cf-runtime. Because sage 1.5.0 now exports',
    'parseSlackWebhook + runSageTurn, the migration is DIRECT composition — no replay',
    'trick, no fake-ctx-over-sage.fetch.',
    '',
    'Invariants (SPEC):',
    '  #1 waitUntil never orphans (fake ctx awaits pending before consumer returns).',
    '  #2 Continuation writes sync on suspend.',
    '  #3 Sage owns signature verify (inside parseSlackWebhook).',
    '  #4 cf-runtime owns ingress dedup (exactly once). Sage 1.5.0 no longer dedups.',
    '  #6/#7 Two-function persona contract: parseSlackWebhook + runSageTurn.',
    '',
    'Workers:',
    '  - impl-worker: rewrites packages/sage-worker/src/worker.ts to compose',
    '    wrapCloudflareWorker + TurnExecutorDO, plugging in sage\'s new exports.',
    '  - impl-infra: rewrites infra/sage.ts to use defineAgentPersona. CRITICAL: preserve',
    '    existing 5 KVs (dedup/threads/prefs/signals/quiet-hours) by exact name so SST',
    '    matches them; renames would destroy state.',
    '',
    'Validation:',
    '  - Local-run test (tester) is the 80-to-100 gate: two scenarios (ingress dedup,',
    '    consumer pendingCount).',
    '',
    `Worktree: ${WORKTREE_PATH}`,
    '',
    'SPEC:',
    '{{steps.read-spec.output}}',
    '',
    'Current sage worker + infra:',
    '{{steps.read-current-sage.output}}',
  ].join('\n');

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('lead-coordinate', {
      agent: 'lead',
      dependsOn: ['read-spec', 'verify-prereqs', 'read-current-sage'],
      task: leadTask,
    });

  const implWorkerTask = [
    'You are impl-worker on #wf-cf-runtime-06.',
    '',
    `Worktree: ${WORKTREE_PATH}.`,
    '',
    'Rewrite packages/sage-worker/src/worker.ts. Target shape:',
    '',
    '  import {',
    '    parseSlackWebhook,',
    '    runSageTurn,',
    '    type SageTurnDescriptor,',
    '  } from "@agentworkforce/sage";',
    '  import {',
    '    wrapCloudflareWorker,',
    '    handleCfQueue,',
    '    createCfContinuationStore,',
    '    createCfContinuationScheduler,',
    '    createCfDeliveryAdapter,',
    '  } from "@agent-assistant/cloudflare-runtime";',
    '  import {',
    '    createTurnExecutorDoClass,',
    '    type CfAgentEnv,',
    '  } from "@cloud/cloudflare-agent-bindings";',
    '',
    '  // Build the executor options once — shared by the DO and the top-level queue()',
    '  // handler. Factor into a small helper to avoid drift between them.',
    '  function buildSageExecutorOptions(env: CfAgentEnv, doStorage?: DurableObjectStorage) {',
    '    return {',
    '      harnessAdapter: () => ({',
    '        runTurn: (descriptor: SageTurnDescriptor, ctx: ExecutionContext) =>',
    '          runSageTurn(descriptor, env as any, ctx),',
    '      }),',
    '      deliveryAdapter: () => createCfDeliveryAdapter(env),',
    '      buildStore: () =>',
    '        createCfContinuationStore({',
    '          doStorage: doStorage!,   // present when called from DO',
    '          triggerIndexKv: env.CONTINUATIONS,',
    '        }),',
    '      buildScheduler: () =>',
    '        createCfContinuationScheduler({',
    '          doStorage: doStorage!,',
    '          turnQueue: env.TURN_QUEUE,',
    '        }),',
    '      resolveConversationId: (msg: any) => {',
    '        if (msg.type === "webhook") {',
    '          const d = msg.turn as SageTurnDescriptor;',
    '          return `${d.workspaceId}:${d.slackEvent.threadTs ?? d.slackEvent.ts}`;',
    '        }',
    '        return msg.conversationId;',
    '      },',
    '    };',
    '  }',
    '',
    '  export const SageTurnExecutor = createTurnExecutorDoClass<CfAgentEnv>({',
    '    name: "SageTurnExecutor",',
    '    buildExecutorOptions: (env, doStorage) => buildSageExecutorOptions(env, doStorage),',
    '  });',
    '',
    '  const wrapped = wrapCloudflareWorker<CfAgentEnv>({',
    '    webhookRoutes: {',
    '      "/api/webhooks/slack": {',
    '        provider: "slack",',
    '        parse: (req, env) => parseSlackWebhook(req, env as any),',
    '      },',
    '    },',
    '    queueBinding: "TURN_QUEUE",',
    '    dedupBinding: "DEDUP",',
    '    continuationBinding: "CONTINUATIONS",',
    '    turnExecutorDoBinding: "SAGE_TURN_EXECUTOR",',
    '  });',
    '',
    '  export default {',
    '    fetch: wrapped.fetch,',
    '    queue: (batch, env, ctx) =>',
    '      handleCfQueue(batch, env, ctx, buildSageExecutorOptions(env)),',
    '  } satisfies ExportedHandler<CfAgentEnv>;',
    '',
    'Update packages/sage-worker/package.json dependencies:',
    '  - "@agentworkforce/sage": "^1.5.0"',
    '  - "@agent-assistant/cloudflare-runtime": "^0.1.0"',
    '  - "@cloud/cloudflare-agent-bindings": "workspace:*"',
    '',
    'Run `cd packages/sage-worker && npx tsc --noEmit` after each edit.',
    '',
    'Post "IMPL_WORKER_DONE" when done.',
    '',
    'SPEC: {{steps.read-spec.output}}',
  ].join('\n');

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('impl-worker-work', {
      agent: 'impl-worker',
      dependsOn: ['lead-coordinate'],
      task: implWorkerTask,
    });

  const implInfraTask = [
    'You are impl-infra on #wf-cf-runtime-06.',
    '',
    `Worktree: ${WORKTREE_PATH}.`,
    '',
    'Rewrite infra/sage.ts to use defineAgentPersona (landed in W5).',
    '',
    'CRITICAL resource preservation (wrong here = destroyed Slack dedup/thread state):',
    '  - Existing 5 KVs keep exact title with stageSuffix:',
    '      sage-dedup${suffix}, sage-threads${suffix}, sage-prefs${suffix},',
    '      sage-signals${suffix}, sage-quiet-hours${suffix}.',
    '  - workerScriptName("sage") unchanged.',
    '  - sageDomain unchanged.',
    '  - All secrets and env vars preserved.',
    '',
    'New resources this migration adds:',
    '  - Turn queue: `sage-turn-queue${stageSuffix}`.',
    '  - Turn DLQ: `sage-turn-dlq${stageSuffix}`.',
    '  - Continuations KV: `sage-continuations${stageSuffix}`.',
    '  - DO namespace: class name SageTurnExecutor.',
    '',
    'Run `npx tsc --noEmit -p tsconfig.infra.json` (or equivalent) after each edit.',
    '',
    'Post "IMPL_INFRA_DONE" when done.',
    '',
    'Current infra/sage.ts:',
    '{{steps.read-current-sage.output}}',
  ].join('\n');

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('impl-infra-work', {
      agent: 'impl-infra',
      dependsOn: ['lead-coordinate'],
      task: implInfraTask,
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('verify-files', {
      type: 'deterministic',
      dependsOn: ['impl-worker-work', 'impl-infra-work'],
      command: inWorktree(
        WORKTREE_PATH,
        [
          'missing=0',
          'for f in packages/sage-worker/src/worker.ts infra/sage.ts; do',
          '  if [ ! -f "$f" ]; then echo "MISSING: $f"; missing=$((missing+1)); fi',
          'done',
          'if [ $missing -gt 0 ]; then echo "$missing files missing"; exit 1; fi',
          'grep -q "parseSlackWebhook" packages/sage-worker/src/worker.ts || (echo "ERROR: sage-worker does not import parseSlackWebhook"; exit 1)',
          'grep -q "runSageTurn" packages/sage-worker/src/worker.ts || (echo "ERROR: sage-worker does not import runSageTurn"; exit 1)',
          'if grep -q "sage\\.fetch" packages/sage-worker/src/worker.ts; then',
          '  echo "ERROR: sage-worker still calls sage.fetch — should use parseSlackWebhook + runSageTurn instead";',
          '  exit 1;',
          'fi',
          'echo ALL_FILES_PRESENT',
        ].join('; '),
      ),
      captureOutput: true,
      failOnError: true,
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('reinstall-deps', {
      type: 'deterministic',
      dependsOn: ['verify-files'],
      command: inWorktree(WORKTREE_PATH, 'npm install --legacy-peer-deps --no-audit --no-fund 2>&1 | tail -10'),
      captureOutput: true,
      failOnError: true,
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('typecheck', {
      type: 'deterministic',
      dependsOn: ['reinstall-deps'],
      command: inWorktree(
        WORKTREE_PATH,
        [
          'cd packages/sage-worker && npx tsc --noEmit 2>&1 | tail -40 && echo SAGE_TSC_OK',
          'cd - >/dev/null',
          'npx tsc --noEmit -p tsconfig.infra.json 2>&1 | tail -40 || true',
          'echo TYPECHECK_ATTEMPTED',
        ].join(' && '),
      ),
      captureOutput: true,
      failOnError: false,
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('fix-typecheck', {
      agent: 'impl-worker',
      dependsOn: ['typecheck'],
      task: [
        'Fix typecheck errors if any. Output:',
        '{{steps.typecheck.output}}',
        `Worktree: ${WORKTREE_PATH}.`,
      ].join('\n'),
      verification: { type: 'exit_code' },
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('resource-drift-check', {
      type: 'deterministic',
      dependsOn: ['fix-typecheck'],
      command: inWorktree(
        WORKTREE_PATH,
        [
          'set -e',
          'git diff origin/main -- infra/sage.ts | grep -E "^-\\s*.*(sage-dedup|sage-threads|sage-prefs|sage-signals|sage-quiet-hours|workerScriptName).*$" && {',
          '  echo "ERROR: existing resource names appear to be removed. infra/sage.ts diff is unsafe.";',
          '  exit 1;',
          '} || true',
          'echo DRIFT_OK',
        ].join('; '),
      ),
      captureOutput: true,
      failOnError: true,
    });

  const writeLocalRunTestTask = [
    'Write the local-run 80-to-100 validation test.',
    '',
    `Worktree: ${WORKTREE_PATH}.`,
    '',
    'Create packages/sage-worker/tests/local-run.test.ts (vitest).',
    '',
    'Setup:',
    '  - Import the default worker export.',
    '  - Build a fake CfAgentEnv:',
    '    * Map-backed KVs for DEDUP, CONTINUATIONS, THREADS, PREFS, SIGNALS, QUIET_HOURS.',
    '    * Fake TURN_QUEUE: { send } pushes into an array with { body, opts }.',
    '    * Fake SAGE_TURN_EXECUTOR DO namespace that in-process constructs the DO class',
    '      with a fake DurableObjectStorage (in-memory Map-backed).',
    '    * Slack signing secret for a known test value.',
    '    * Test-only dependency injection for the harness: override the runTurn adapter',
    '      by calling handleCfQueue with a different opts object that stubs runTurn to',
    '      return "hello from stub" and record the descriptor. This keeps the real sage',
    '      runSageTurn out of the test (it would need workspace secrets).',
    '  - Synthetic Slack app_mention Request with valid signature for the test secret.',
    '',
    'Scenario 1 — ingress + dedup:',
    '  1. Deliver webhook via worker.fetch. Expect 200.',
    '  2. Expect exactly 1 turn message enqueued.',
    '  3. Deliver the SAME webhook again. Expect 200.',
    '  4. Expect still 1 enqueue total (dedup works — regression gate for SPEC #4).',
    '',
    'Scenario 2 — consumer + pendingCount:',
    '  5. Drain the queue by calling worker.queue(batch, env, ctx) for the message,',
    '     passing test-only executor opts that stub runTurn.',
    '  6. Assert delivery adapter was called with a chat.postMessage body containing "hello".',
    '  7. Assert fakeCtx.pendingCount() === 0 after queue returns. This is the direct',
    '     regression test for the production Slack-silence bug (SPEC Invariant #1).',
    '',
    'Run: `cd packages/sage-worker && npx vitest run tests/local-run.test.ts`. Fix until green.',
  ].join('\n');

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('write-local-run-test', {
      agent: 'tester',
      dependsOn: ['resource-drift-check'],
      task: writeLocalRunTestTask,
      verification: { type: 'file_exists', value: `${WORKTREE_PATH}/packages/sage-worker/tests/local-run.test.ts` },
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('run-local-run-test', {
      type: 'deterministic',
      dependsOn: ['write-local-run-test'],
      command: inWorktree(WORKTREE_PATH, 'cd packages/sage-worker && npx vitest run tests/local-run.test.ts 2>&1 | tail -80'),
      captureOutput: true,
      failOnError: false,
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('fix-local-run-test', {
      agent: 'tester',
      dependsOn: ['run-local-run-test'],
      task: [
        'Fix local-run test failures. Output:',
        '{{steps.run-local-run-test.output}}',
        'Iterate until green. Do NOT weaken the dedup or pendingCount assertions.',
        `Worktree: ${WORKTREE_PATH}.`,
      ].join('\n'),
      verification: { type: 'exit_code' },
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('run-local-run-test-final', {
      type: 'deterministic',
      dependsOn: ['fix-local-run-test'],
      command: inWorktree(WORKTREE_PATH, 'cd packages/sage-worker && npx vitest run tests/local-run.test.ts'),
      captureOutput: true,
      failOnError: true,
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('run-existing-tests', {
      type: 'deterministic',
      dependsOn: ['run-local-run-test-final'],
      command: inWorktree(WORKTREE_PATH, 'npm run test 2>&1 | tail -60 || true'),
      captureOutput: true,
      failOnError: false,
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('fix-regressions', {
      agent: 'impl-worker',
      dependsOn: ['run-existing-tests'],
      task: [
        'Fix regressions in existing cloud tests. Output:',
        '{{steps.run-existing-tests.output}}',
        `Worktree: ${WORKTREE_PATH}.`,
      ].join('\n'),
      verification: { type: 'exit_code' },
    });

  const reviewTask = [
    'Review the sage migration.',
    '',
    `Worktree: ${WORKTREE_PATH}.`,
    '',
    'Run:',
    `  cd ${WORKTREE_PATH} && git diff origin/main...HEAD`,
    `  cat ${WORKTREE_PATH}/packages/sage-worker/src/worker.ts`,
    `  cat ${WORKTREE_PATH}/packages/sage-worker/tests/local-run.test.ts`,
    '',
    'Verify:',
    '  [new exports used] sage-worker imports { parseSlackWebhook, runSageTurn } from',
    '       @agentworkforce/sage — not sage.default.fetch. Grep rejects "sage.fetch".',
    '  [dedup in runtime] dedup in wrapCloudflareWorker; Scenario 1 asserts second delivery',
    '       of same event is skipped.',
    '  [pendingCount gate] Scenario 2 asserts fakeCtx.pendingCount() === 0 after queue.',
    '  [no drop] No existing KV binding, secret, or env var removed.',
    '  [resource match] sage worker script name + KV titles match pre-migration.',
    '  [infra move-not-replace] infra/sage.ts diff does not remove any existing resource.',
    '  [tests] Existing cloud tests still pass.',
    '',
    'Write VERDICT-06.md with KEEP | PAUSE + sections.',
  ].join('\n');

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('review', {
      agent: 'reviewer',
      dependsOn: ['fix-regressions'],
      task: reviewTask,
      verification: { type: 'file_exists', value: `${WORKTREE_PATH}/VERDICT-06.md` },
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('verify-verdict', {
      type: 'deterministic',
      dependsOn: ['review'],
      command: [
        `cd ${JSON.stringify(WORKTREE_PATH)}`,
        'grep -Eqi "(^|[*#[:space:]])verdict:?[[:space:]]*keep" VERDICT-06.md || (cat VERDICT-06.md; exit 1)',
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
          'git add packages/sage-worker infra/sage.ts',
          'git add package.json package-lock.json',
          'MSG=$(mktemp)',
          'printf "%s\\n" "feat(sage): migrate sage-worker onto @agent-assistant/cloudflare-runtime" "" "- consume @agentworkforce/sage@1.5.0 split exports (parseSlackWebhook" "  + runSageTurn). Turn work runs in queue consumer inside a fake ctx" "  that awaits waitUntil before ack, giving the harness the full 15-min" "  consumer budget instead of the 30s waitUntil window that silences long" "  turns in prod today." "- ingress dedup owned by wrapCloudflareWorker (SlackEventDedupGate from" "  @agent-assistant/surfaces). Sage 1.5.0 no longer dedups." "- infra/sage.ts uses defineAgentPersona; adds turn queue + DLQ +" "  continuations KV + SageTurnExecutor DO namespace; preserves all" "  existing KVs + worker script name for zero-drift deploy." "- local-run.test.ts: ingress dedup scenario + consumer pendingCount == 0" "  scenario are direct regression gates for the Slack-silence bug." "" "No change in sage prompts, bot identity, or user-visible features." > "$MSG"',
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
      repoSlug: REPO_SLUG,
      title: 'feat(sage): migrate sage-worker onto @agent-assistant/cloudflare-runtime',
      dependsOn: ['commit'],
      labels: ['cf-runtime', 'sage', 'deploy-to-sage-stage-first'],
      bodyLines: [
        '## Summary',
        'Migrates `sage-worker` onto `@agent-assistant/cloudflare-runtime`. Consumes `@agentworkforce/sage@1.5.0` split exports (`parseSlackWebhook` + `runSageTurn`) directly. No replay, no black-box `sage.fetch`. Slack webhooks ACK fast; turn work runs in a queue consumer with a full 15-min budget instead of the 30s `waitUntil` window that silences long Sage turns in production.',
        '',
        '## Regression gates (local-run.test.ts)',
        '- Scenario 1: second delivery of same Slack event-id is NOT enqueued (ingress dedup, SPEC #4).',
        '- Scenario 2: `fakeCtx.pendingCount() === 0` at end of queue invocation (SPEC #1 — the direct regression test for the production bug).',
        '',
        '## SST resource preservation',
        '- All 5 existing sage KVs keep their exact names → SST matches, not replaces.',
        '- New resources: turn queue, DLQ, continuations KV, SageTurnExecutor DO namespace.',
        '',
        '## Prerequisites (workflow preflight enforces)',
        '- W0 merged in sage; `@agentworkforce/sage@1.5.0` published.',
        '- W1–W4 merged in agent-assistant; `@agent-assistant/cloudflare-runtime@0.1.0` published.',
        '- W5 merged in this repo (factory + bindings).',
        '',
        '## Deploy plan',
        '1. Merge → CI deploys to `sage` stage.',
        '2. Smoke: Slack message that needs Notion + specialist routing. Previously silent; now replies.',
        '3. `wrangler tail sage`: expect zero `waitUntil cancelled` warnings.',
        '4. 24h stable on sage stage → promote to prod via CI.',
        '',
        '## Rollback',
        'Revert this commit; CI redeploys previous sage version. Queue messages drain; continuation records TTL out.',
      ],
    }));

  const result = await wf.run({ cwd: process.cwd() });
  console.log('Workflow status:', result.status);
}

runWorkflow().catch((error) => {
  console.error(error);
  process.exit(1);
});
