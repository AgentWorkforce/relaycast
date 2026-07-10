// W7: migrate specialist-worker onto the new runtime.
//
// Unlike sage, specialist is already a Hono app in this repo (not an external
// npm package). The migration is slightly different: we wrap the existing
// Hono app with `wrapCloudflareWorker` and add queue-consumer capability, so
// sage can enqueue specialist_call messages instead of making HTTP fetches.
// The existing /a2a/rpc HTTP endpoint stays — callers that still use HTTP
// (e.g. external integrations) continue to work. The queue path is the new,
// budget-unbounded call path.
//
// Target repo: cloud
// Branch: feat/specialist-on-cf-runtime

import { workflow } from '@relayflows/core';
import { applyWorktreeSetup, inWorktree, pushAndOpenPrStep } from './lib/worktree-setup.ts';

const REPO_PATH = '/Users/khaliqgant/Projects/AgentWorkforce/cloud';
const BRANCH = 'feat/specialist-on-cf-runtime';
const REPO_SLUG = 'AgentWorkforce/cloud';
const WORKTREE_PATH = `${REPO_PATH}/../.cf-runtime-worktrees/cloud-feat-specialist-on-cf-runtime`;

async function runWorkflow() {
  let wf = workflow('cf-runtime-07-specialist-migration')
    .description('Migrate specialist-worker onto @agent-assistant/cloudflare-runtime. Keeps existing /a2a/rpc HTTP endpoint (backward-compat); adds queue-consumer path so sage can enqueue long specialist calls without hitting edge-HTTP timeouts.')
    .pattern('dag')
    .channel('wf-cf-runtime-07')
    .maxConcurrency(4)
    .timeout(3_600_000)

    .agent('lead', {
      cli: 'claude',
      role: 'Lead. Enforces backward compatibility of /a2a/rpc and specialist capabilities. No drops, no renames.',
      retries: 1,
    })
    .agent('impl-worker', {
      cli: 'codex',
      role: 'Wraps the existing Hono app with wrapCloudflareWorker; adds queue() handler that dispatches specialist_call messages.',
      retries: 2,
    })
    .agent('impl-infra', {
      cli: 'codex',
      role: 'Refactors infra/specialist-worker.ts to use defineAgentPersona while preserving existing resources.',
      retries: 2,
    })
    .agent('tester', {
      cli: 'claude',
      preset: 'worker',
      role: 'Writes a local-run test that delivers a specialist_call queue message, runs a stub specialist harness, and asserts a specialist_result message is enqueued back for the sage side. Regression gate: pendingCount == 0.',
      retries: 2,
    })
    .agent('reviewer', {
      cli: 'claude',
      preset: 'reviewer',
      role: 'Reviews diff; verifies HTTP endpoint and capability list are intact; writes VERDICT.',
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
      'packages/specialist-worker/src/index.ts',
      'packages/specialist-worker/src/queue-consumer.ts',
      'packages/specialist-worker/src/specialist-harness-adapter.ts',
      'packages/specialist-worker/package.json',
      'packages/specialist-worker/tests/local-queue-run.test.ts',
      'infra/specialist-worker.ts',
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
    .step('verify-factory-available', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: inWorktree(
        WORKTREE_PATH,
        [
          'set -e',
          'test -f infra/agent-persona.ts || (echo "ERROR: W5 not merged"; exit 1)',
          'test -d node_modules/@agent-assistant/cloudflare-runtime || (echo "ERROR: runtime not installed"; exit 1)',
          'echo FACTORY_AVAILABLE',
        ].join(' && '),
      ),
      captureOutput: true,
      failOnError: true,
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('read-current-specialist', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: inWorktree(
        WORKTREE_PATH,
        [
          'echo "=== packages/specialist-worker/src/index.ts ===" && cat packages/specialist-worker/src/index.ts',
          'echo "=== packages/specialist-worker/src/routes.ts (head) ===" && head -120 packages/specialist-worker/src/routes.ts',
          'echo "=== infra/specialist-worker.ts ===" && cat infra/specialist-worker.ts',
          'echo "=== package.json ===" && cat packages/specialist-worker/package.json',
        ].join(' && '),
      ),
      captureOutput: true,
      failOnError: true,
    });

  const leadTask = [
    'You are the lead on #wf-cf-runtime-07.',
    '',
    `Worktree: ${WORKTREE_PATH}.`,
    '',
    'Migrate specialist-worker to the new runtime. Specialist is DIFFERENT from sage:',
    '  - Specialist is a Hono app in THIS repo (not an npm import).',
    '  - Existing callers use HTTP /a2a/rpc. Keep this working.',
    '  - New path: sage enqueues a `specialist_call` queue message, specialist\'s queue()',
    '    consumer runs the specialist harness, specialist enqueues a `specialist_result`',
    '    message back (or calls the a2a-callback delivery target). Sage resumes.',
    '',
    'Workers:',
    '  - impl-worker: wraps the existing Hono app as `inner` in wrapCloudflareWorker.',
    '    Adds a queue() handler that dispatches specialist_call messages via handleCfQueue.',
    '    Adds specialist-harness-adapter.ts that delegates into the existing specialist',
    '    code (packages/specialist-worker/src/specialist/agentic-specialist.ts etc).',
    '',
    '  - impl-infra: refactors infra/specialist-worker.ts to defineAgentPersona. Adds turn',
    '    queue, DLQ, continuations KV, DO namespace. Preserves existing secrets + domain.',
    '',
    'Capability preservation is critical:',
    '  - The agent-card (GET /.well-known/agent.json) must list the same capabilities.',
    '  - /a2a/rpc response schema must be unchanged.',
    '  - Any existing integration endpoints (GitHub clone-on-demand, etc.) must remain.',
    '',
    'SPEC:',
    '{{steps.read-spec.output}}',
    '',
    'Current specialist:',
    '{{steps.read-current-specialist.output}}',
  ].join('\n');

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('lead-coordinate', {
      agent: 'lead',
      dependsOn: ['read-spec', 'verify-factory-available', 'read-current-specialist'],
      task: leadTask,
    });

  const implWorkerTask = [
    'You are impl-worker on #wf-cf-runtime-07.',
    '',
    `Worktree: ${WORKTREE_PATH}.`,
    '',
    'Edit packages/specialist-worker/src/index.ts to compose the runtime. Target shape:',
    '',
    '  import specialistApp from "./routes.js";   // existing Hono app default export',
    '  import {',
    '    wrapCloudflareWorker,',
    '    handleCfQueue,',
    '  } from "@agent-assistant/cloudflare-runtime";',
    '  import { createTurnExecutorDoClass } from "@cloud/cloudflare-agent-bindings";',
    '  import { createSpecialistHarnessAdapter } from "./specialist-harness-adapter.js";',
    '  import { handleSpecialistQueueMessage } from "./queue-consumer.js";',
    '',
    '  export const SpecialistTurnExecutor = createTurnExecutorDoClass({',
    '    name: "SpecialistTurnExecutor",',
    '    buildExecutorOptions: (env) => ({ /* store/scheduler/delivery/harness */ }),',
    '  });',
    '',
    '  const wrapped = wrapCloudflareWorker({',
    '    inner: { fetch: specialistApp.fetch },',
    '    webhookRoutes: {},  // specialist has no webhooks; all ingress is /a2a/rpc or queue',
    '    queueBinding: "TURN_QUEUE",',
    '  });',
    '',
    '  export default {',
    '    ...wrapped,',
    '    queue: (batch, env, ctx) => handleCfQueue(batch, env, ctx, /* opts */),',
    '  };',
    '',
    '  export * from "./specialist/agent-card.js";',
    '  export * from "./specialist/agentic-specialist.js";',
    '  // ...keep all existing re-exports',
    '',
    'Create packages/specialist-worker/src/queue-consumer.ts exporting',
    '`handleSpecialistQueueMessage` that:',
    '  - For a `specialist_call` message: look up the capability, invoke the matching',
    '    specialist (github or linear) with the input, await its result.',
    '  - On success: send `specialist_result` back to the callbackTrigger on the same',
    '    TURN_QUEUE (sage\'s side will consume it).',
    '  - On failure: send `specialist_result` with error.',
    '',
    'Create packages/specialist-worker/src/specialist-harness-adapter.ts that builds the',
    'harness adapter object the runtime expects, delegating into the existing specialist',
    'code in packages/specialist-worker/src/specialist/.',
    '',
    'Update packages/specialist-worker/package.json dependencies to add the runtime + bindings.',
    '',
    'Run `cd packages/specialist-worker && npx tsc --noEmit` after each edit. Post',
    '"IMPL_WORKER_DONE" when done.',
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
    'You are impl-infra on #wf-cf-runtime-07.',
    '',
    `Worktree: ${WORKTREE_PATH}.`,
    '',
    'Refactor infra/specialist-worker.ts to use defineAgentPersona. Preserve:',
    '  - Existing secrets (specialistOpenrouterApiKey, relayJwtSecret, etc).',
    '  - Existing domain (specialistDomain / specialistUrl).',
    '  - Worker script name `workerScriptName("specialist-worker")` or whatever current value is.',
    '',
    'Add:',
    '  - Turn queue, DLQ, continuations KV, SpecialistTurnExecutor DO namespace.',
    '  - Link the sage worker\'s TURN_QUEUE so specialist can enqueue specialist_result',
    '    messages back to sage (or keep them on a shared TURN_QUEUE if that\'s simpler).',
    '',
    'Run `npx tsc --noEmit -p tsconfig.infra.json || true` after edits.',
    '',
    'Post "IMPL_INFRA_DONE".',
    '',
    'SPEC: {{steps.read-spec.output}}',
    '',
    'Current infra/specialist-worker.ts:',
    '{{steps.read-current-specialist.output}}',
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
          'for f in packages/specialist-worker/src/index.ts packages/specialist-worker/src/queue-consumer.ts packages/specialist-worker/src/specialist-harness-adapter.ts infra/specialist-worker.ts; do',
          '  if [ ! -f "$f" ]; then echo "MISSING: $f"; missing=$((missing+1)); fi',
          'done',
          'if [ $missing -gt 0 ]; then echo "$missing missing"; exit 1; fi',
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
          'cd packages/specialist-worker && npx tsc --noEmit 2>&1 | tail -40 && echo SPECIALIST_TSC_OK',
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
        'Fix typecheck errors. Output:',
        '{{steps.typecheck.output}}',
        `Worktree: ${WORKTREE_PATH}.`,
      ].join('\n'),
      verification: { type: 'exit_code' },
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('backward-compat-check', {
      type: 'deterministic',
      dependsOn: ['fix-typecheck'],
      command: inWorktree(
        WORKTREE_PATH,
        [
          'set -e',
          'echo "=== agent-card route still registered? ==="',
          'grep -n "/.well-known/agent" packages/specialist-worker/src/routes.ts',
          'echo "=== /a2a/rpc route still registered? ==="',
          'grep -n "/a2a/rpc\\|handleA2aRpc" packages/specialist-worker/src/routes.ts',
          'echo "=== specialist capabilities still re-exported from index.ts? ==="',
          'grep -n "agent-card\\|agentic-specialist\\|github-specialist\\|linear-specialist" packages/specialist-worker/src/index.ts',
          'echo BACKWARD_COMPAT_OK',
        ].join(' && '),
      ),
      captureOutput: true,
      failOnError: true,
    });

  const writeLocalQueueTestTask = [
    'Write the local-queue 80-to-100 validation test.',
    '',
    `Worktree: ${WORKTREE_PATH}.`,
    '',
    'Create packages/specialist-worker/tests/local-queue-run.test.ts.',
    '',
    'Setup:',
    '  - Import the default worker.',
    '  - Build a fake CfAgentEnv + fake queue.',
    '  - Stub the underlying specialist harness to return "stub-github-result" for a',
    '    specialist_call with capability=github.',
    '',
    'Scenario:',
    '  1. Deliver a specialist_call queue message via worker.queue.',
    '  2. Assert exactly ONE specialist_result message was enqueued.',
    '  3. Assert the result payload contains "stub-github-result".',
    '  4. Assert fakeCtx.pendingCount() === 0 after queue() returns (regression gate).',
    '',
    'Also add one quick HTTP backward-compat test:',
    '  - Deliver GET /.well-known/agent.json to worker.fetch; expect 200 and a body with',
    '    a "capabilities" field.',
    '',
    'Run: `cd packages/specialist-worker && npx vitest run tests/local-queue-run.test.ts`.',
    'Fix until green.',
  ].join('\n');

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('write-local-test', {
      agent: 'tester',
      dependsOn: ['backward-compat-check'],
      task: writeLocalQueueTestTask,
      verification: { type: 'file_exists', value: `${WORKTREE_PATH}/packages/specialist-worker/tests/local-queue-run.test.ts` },
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('run-local-test', {
      type: 'deterministic',
      dependsOn: ['write-local-test'],
      command: inWorktree(WORKTREE_PATH, 'cd packages/specialist-worker && npx vitest run tests/local-queue-run.test.ts 2>&1 | tail -80'),
      captureOutput: true,
      failOnError: false,
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('fix-local-test', {
      agent: 'tester',
      dependsOn: ['run-local-test'],
      task: [
        'Fix test failures. Output:',
        '{{steps.run-local-test.output}}',
        'Iterate until green. Do NOT weaken the pendingCount assertion.',
        `Worktree: ${WORKTREE_PATH}.`,
      ].join('\n'),
      verification: { type: 'exit_code' },
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('run-local-test-final', {
      type: 'deterministic',
      dependsOn: ['fix-local-test'],
      command: inWorktree(WORKTREE_PATH, 'cd packages/specialist-worker && npx vitest run tests/local-queue-run.test.ts'),
      captureOutput: true,
      failOnError: true,
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('run-existing-specialist-tests', {
      type: 'deterministic',
      dependsOn: ['run-local-test-final'],
      command: inWorktree(WORKTREE_PATH, 'cd packages/specialist-worker && npx vitest run 2>&1 | tail -80 || true'),
      captureOutput: true,
      failOnError: false,
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('fix-regressions', {
      agent: 'impl-worker',
      dependsOn: ['run-existing-specialist-tests'],
      task: [
        'Fix regressions in existing specialist tests. Output:',
        '{{steps.run-existing-specialist-tests.output}}',
        `Worktree: ${WORKTREE_PATH}.`,
      ].join('\n'),
      verification: { type: 'exit_code' },
    });

  const reviewTask = [
    'Review the specialist migration.',
    '',
    `Worktree: ${WORKTREE_PATH}.`,
    '',
    'Run:',
    `  cd ${WORKTREE_PATH} && git diff origin/main...HEAD`,
    `  cat ${WORKTREE_PATH}/packages/specialist-worker/src/index.ts`,
    `  cat ${WORKTREE_PATH}/packages/specialist-worker/tests/local-queue-run.test.ts`,
    '',
    'Verify:',
    '  [http backward compat] /a2a/rpc and /.well-known/agent.json are still wired.',
    '  [capability set] No specialist capability was dropped — grep the agent-card body.',
    '  [queue path] queue() handler dispatches specialist_call; result goes back via',
    '       specialist_result message (not blocking HTTP).',
    '  [regression gate] local-queue-run.test.ts asserts pendingCount === 0.',
    '  [resource preservation] Existing secrets, domain, script name intact.',
    '',
    'Write VERDICT-07.md with KEEP | PAUSE.',
  ].join('\n');

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('review', {
      agent: 'reviewer',
      dependsOn: ['fix-regressions'],
      task: reviewTask,
      verification: { type: 'file_exists', value: `${WORKTREE_PATH}/VERDICT-07.md` },
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('verify-verdict', {
      type: 'deterministic',
      dependsOn: ['review'],
      command: [
        `cd ${JSON.stringify(WORKTREE_PATH)}`,
        'grep -Eqi "(^|[*#[:space:]])verdict:?[[:space:]]*keep" VERDICT-07.md || (cat VERDICT-07.md; exit 1)',
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
          'git add packages/specialist-worker infra/specialist-worker.ts',
          'git add package.json package-lock.json',
          'MSG=$(mktemp)',
          'printf "%s\\n" "feat(specialist): migrate specialist-worker onto @agent-assistant/cloudflare-runtime" "" "- wrap existing Hono app with wrapCloudflareWorker (keeps /a2a/rpc)" "- add queue() consumer: handles specialist_call messages from sage" "- specialist_result messages enqueued back to sage (async bridge)" "- infra/specialist-worker.ts uses defineAgentPersona; preserves secrets +" "  domain + script name" "- local-queue-run.test.ts: pendingCount == 0 regression gate" "" "No change to /a2a/rpc response schema or agent-card capabilities." > "$MSG"',
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
      title: 'feat(specialist): migrate specialist-worker onto @agent-assistant/cloudflare-runtime',
      dependsOn: ['commit'],
      labels: ['cf-runtime', 'specialist', 'deploy-to-sage-stage-first'],
      bodyLines: [
        '## Summary',
        'Migrates `specialist-worker` onto the new runtime. Adds a queue-consumer path so sage can call specialists without being bound by the ~100s HTTP edge timeout; `/a2a/rpc` stays wired for backward compatibility.',
        '',
        '## Regression gate',
        '`packages/specialist-worker/tests/local-queue-run.test.ts` asserts `pendingCount === 0` and `specialist_result` enqueueback.',
        '',
        '## Backward compatibility',
        '- `/a2a/rpc` response schema unchanged.',
        '- `/.well-known/agent.json` capability list preserved.',
        '- Existing HTTP callers continue to work. Queue path is the NEW path sage uses after W6.',
        '',
        '## Deploy plan',
        '1. Merge this PR. CI deploys to sage stage.',
        '2. Confirm no change in /a2a/rpc behavior (existing integration tests).',
        '3. After W6 also merges, end-to-end smoke: Slack message → sage → specialist_call → specialist_result → sage reply.',
        '4. Watch `wrangler tail specialist-worker` for errors.',
        '5. Promote to prod via CI after 24h stable.',
        '',
        '## Rollback',
        'Revert this commit. sage will fall back to HTTP call path (W6 supports both queue + HTTP for the first release).',
      ],
    }));

  const result = await wf.run({ cwd: process.cwd() });
  console.log('Workflow status:', result.status);
}

runWorkflow().catch((error) => {
  console.error(error);
  process.exit(1);
});
