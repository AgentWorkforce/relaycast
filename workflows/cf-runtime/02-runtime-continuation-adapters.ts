// W2: CfContinuationStore + CfContinuationScheduler.
//
// Adds the two continuation adapters that back the runtime. Depends on W1
// being merged (or at minimum W1's branch being the starting point).
//
// Target repo: agent-assistant
// Branch: feat/cf-runtime-continuation-adapters
// Base branch: feat/cf-runtime-core (W1). If W1 has already merged into main,
// rebase this branch on main before opening the PR.

import { workflow } from '@relayflows/core';
import { applyWorktreeSetup, inWorktree, pushAndOpenPrStep } from './lib/worktree-setup.ts';

const REPO_PATH = '/Users/khaliqgant/Projects/AgentWorkforce/agent-assistant';
const BRANCH = 'feat/cf-runtime-continuation-adapters';
const BASE_BRANCH = 'feat/cf-runtime-core';
const REPO_SLUG = 'AgentWorkforce/agent-assistant';
const WORKTREE_PATH = `${REPO_PATH}/../.cf-runtime-worktrees/feat-cf-runtime-continuation-adapters`;

async function runWorkflow() {
  let wf = workflow('cf-runtime-02-continuation-adapters')
    .description('Implement CfContinuationStore (DO+KV) and CfContinuationScheduler (Queue+alarm) for @agent-assistant/cloudflare-runtime. Open PR in agent-assistant.')
    .pattern('dag')
    .channel('wf-cf-runtime-02')
    .maxConcurrency(4)
    .timeout(3_600_000)

    .agent('lead', {
      cli: 'claude',
      role: 'Architecture lead. Enforces SPEC Invariants #2, #4, #5. Rejects KV-only storage shortcuts for per-conversation state.',
      retries: 1,
    })
    .agent('impl-store', {
      cli: 'codex',
      role: 'Implements CfContinuationStore — DO storage primary, KV secondary for trigger index.',
      retries: 2,
    })
    .agent('impl-scheduler', {
      cli: 'codex',
      role: 'Implements CfContinuationScheduler — DO alarm for same-DO wakeups, Queue delayed delivery for cross-DO.',
      retries: 2,
    })
    .agent('tester', {
      cli: 'claude',
      preset: 'worker',
      role: 'Writes vitest tests — including DO storage fake (in-memory Map with same API) — and runs fix loop.',
      retries: 2,
    })
    .agent('reviewer', {
      cli: 'claude',
      preset: 'reviewer',
      role: 'Reviews diff against SPEC; writes VERDICT.md.',
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
      'packages/cloudflare-runtime/src/adapters/cf-continuation-store.ts',
      'packages/cloudflare-runtime/src/adapters/cf-continuation-scheduler.ts',
      'packages/cloudflare-runtime/src/adapters/fakes/fake-do-storage.ts',
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
    .step('read-continuation-interfaces', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: inWorktree(
        WORKTREE_PATH,
        'echo "=== ContinuationStore ===" && find packages/continuation/src -name "*.ts" -not -name "*.test.ts" -exec cat {} + | head -400',
      ),
      captureOutput: true,
      failOnError: true,
    });

  const leadTask = [
    'You are the lead on #wf-cf-runtime-02. Workers: impl-store, impl-scheduler, tester.',
    '',
    'Read the SPEC and the upstream ContinuationStore / ContinuationSchedulerAdapter',
    'interfaces (inlined below), then post assignments.',
    '',
    'Critical points for this workflow:',
    '  - SPEC Invariant #2: on suspend, the continuation record MUST be written to the store',
    '    before the consumer returns. If the write happens inside a ctx.waitUntil that is',
    '    replaced by our fake ctx, great — but the adapter must NOT rely on fire-and-forget.',
    '  - SPEC Invariant #5: per-conversation DO is the single writer for that conversation. KV',
    '    is an eventually-consistent trigger index only. Enforce this in code comments and tests.',
    '  - Alarm semantics: CF DO alarms support ONE pending alarm per DO. If we need multiple',
    '    simultaneous wakeups, the scheduler picks the soonest and re-sets on each wakeup.',
    '    Document this and make sure the test suite covers it.',
    '',
    `Worktree: ${WORKTREE_PATH}`,
    `Branch: ${BRANCH} off ${BASE_BRANCH}`,
    '',
    'While impl-store and impl-scheduler work, review their diffs between rounds.',
    '',
    'SPEC:',
    '{{steps.read-spec.output}}',
    '',
    'Upstream continuation interfaces:',
    '{{steps.read-continuation-interfaces.output}}',
  ].join('\n');

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('lead-coordinate', {
      agent: 'lead',
      dependsOn: ['read-spec', 'read-continuation-interfaces'],
      task: leadTask,
    });

  const implStoreTask = [
    'You are impl-store on #wf-cf-runtime-02.',
    '',
    `Worktree: ${WORKTREE_PATH}.`,
    '',
    'Create:',
    '  packages/cloudflare-runtime/src/adapters/cf-continuation-store.ts',
    '  packages/cloudflare-runtime/src/adapters/fakes/fake-do-storage.ts',
    '',
    'cf-continuation-store.ts exports:',
    '  export interface CfContinuationStoreDeps {',
    '    doStorage: DurableObjectStorage;            // the current DO\'s storage',
    '    triggerIndexKv: KVNamespace;                // account-wide trigger lookup',
    '  }',
    '  export function createCfContinuationStore(deps: CfContinuationStoreDeps): ContinuationStore;',
    '',
    'Implementation rules:',
    '  - Primary state lives in DO storage at key `cont:<id>`.',
    '  - Secondary trigger index lives in KV at key `trigger:<triggerKey>` -> <continuation id>.',
    '    (triggerKey = `${target.kind}:${target.id}` from ContinuationResumeTrigger.)',
    '  - create(record): transactionally write DO storage + KV index. Use',
    '    doStorage.transaction if available, otherwise write DO first, KV second; on KV',
    '    failure, do NOT rollback DO — log and surface an error (SPEC Invariant #5 says DO is',
    '    authoritative).',
    '  - get(id): DO storage read.',
    '  - update(id, patch): DO transaction — read, apply patch, write. If the record moved',
    '    to a terminal state, also delete the KV trigger index entry.',
    '  - delete(id): DO storage delete + KV trigger index delete.',
    '  - findByTrigger(trigger): KV get -> continuation id; then getContinuation(id). Returns',
    '    null if KV misses or DO record is terminal/missing.',
    '  - NEVER read state from KV except the trigger index; NEVER write state to KV.',
    '',
    'fake-do-storage.ts exports a FakeDurableObjectStorage class implementing the subset of',
    'DurableObjectStorage used by the store (get, put, delete, list, transaction). In-memory Map.',
    'This is for tests.',
    '',
    'Post "IMPL_STORE_DONE" when finished.',
    '',
    'SPEC:',
    '{{steps.read-spec.output}}',
    '',
    'Upstream ContinuationStore interface:',
    '{{steps.read-continuation-interfaces.output}}',
  ].join('\n');

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('impl-store-work', {
      agent: 'impl-store',
      dependsOn: ['read-spec', 'read-continuation-interfaces'],
      task: implStoreTask,
    });

  const implSchedulerTask = [
    'You are impl-scheduler on #wf-cf-runtime-02.',
    '',
    `Worktree: ${WORKTREE_PATH}.`,
    '',
    'Create:',
    '  packages/cloudflare-runtime/src/adapters/cf-continuation-scheduler.ts',
    '',
    'Exports:',
    '  export interface CfContinuationSchedulerDeps {',
    '    doStorage: DurableObjectStorage;',
    '    turnQueue: Queue<TurnQueueMessage>;',
    '    // Returns the DurableObjectStub for the target conversation\'s executor DO, so',
    '    // scheduler can fire resume messages to the right DO. For same-DO wakeups, not needed.',
    '    resolveTargetDo?: (conversationId: string) => DurableObjectStub;',
    '  }',
    '  export function createCfContinuationScheduler(deps: CfContinuationSchedulerDeps):',
    '    ContinuationSchedulerAdapter;',
    '',
    'Behavior:',
    '  - schedule({ continuationId, at, conversationId }):',
    '      * If conversationId matches the current DO (we are running inside it), set a DO alarm:',
    '        read existing alarm time, set to min(existing, at). Record the pending',
    '        continuations in DO storage at key `alarm-queue` so the alarm handler can fan out.',
    '      * Otherwise, compute delaySeconds = max(0, at - now). Call turnQueue.send(',
    '        { type: "resume", continuationId, trigger }, { delaySeconds }).',
    '  - cancel(continuationId): remove from `alarm-queue` if present; cannot cancel in-flight',
    '    queue messages but the consumer will look up the continuation, find it terminal, and',
    '    skip.',
    '',
    'Important:',
    '  - CF DO alarms support ONE pending alarm per DO. Always set to the earliest pending',
    '    continuation wakeup time.',
    '  - The alarm handler is NOT this file — it lives in the DO base class in W3. This file',
    '    just populates the `alarm-queue` and calls setAlarm.',
    '',
    'Post "IMPL_SCHEDULER_DONE" when done.',
    '',
    'SPEC:',
    '{{steps.read-spec.output}}',
    '',
    'Upstream ContinuationSchedulerAdapter interface:',
    '{{steps.read-continuation-interfaces.output}}',
  ].join('\n');

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('impl-scheduler-work', {
      agent: 'impl-scheduler',
      dependsOn: ['read-spec', 'read-continuation-interfaces'],
      task: implSchedulerTask,
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('verify-files', {
      type: 'deterministic',
      dependsOn: ['impl-store-work', 'impl-scheduler-work'],
      command: inWorktree(
        WORKTREE_PATH,
        [
          'missing=0',
          'for f in packages/cloudflare-runtime/src/adapters/cf-continuation-store.ts packages/cloudflare-runtime/src/adapters/cf-continuation-scheduler.ts packages/cloudflare-runtime/src/adapters/fakes/fake-do-storage.ts; do',
          '  if [ ! -f "$f" ]; then echo "MISSING: $f"; missing=$((missing+1)); fi',
          'done',
          'if [ $missing -gt 0 ]; then echo "$missing files missing"; exit 1; fi',
          'echo ALL_FILES_PRESENT',
        ].join('; '),
      ),
      captureOutput: true,
      failOnError: true,
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('typecheck', {
      type: 'deterministic',
      dependsOn: ['verify-files'],
      command: inWorktree(WORKTREE_PATH, 'cd packages/cloudflare-runtime && npx tsc --noEmit 2>&1 | tail -40; echo EXIT: $?'),
      captureOutput: true,
      failOnError: false,
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('fix-typecheck', {
      agent: 'impl-store',
      dependsOn: ['typecheck'],
      task: [
        'Fix typecheck errors if any. Output:',
        '{{steps.typecheck.output}}',
        `Worktree: ${WORKTREE_PATH}. Only edit packages/cloudflare-runtime/.`,
      ].join('\n'),
      verification: { type: 'exit_code' },
    });

  const writeTestsTask = [
    'Write vitest tests for the continuation adapters.',
    '',
    `Worktree: ${WORKTREE_PATH}. Only edit files under packages/cloudflare-runtime/.`,
    '',
    'Required tests:',
    '  src/adapters/cf-continuation-store.test.ts',
    '    - Use FakeDurableObjectStorage and a fake KV (Map-based).',
    '    - create writes DO + KV trigger index; get returns record.',
    '    - update with terminal status deletes KV index.',
    '    - findByTrigger: KV miss returns null; KV hit + DO miss returns null; both present returns record.',
    '    - delete removes both.',
    '    - create then transaction fails halfway — DO has record, KV does not, subsequent',
    '      findByTrigger returns null, get by id still works, and errors are logged.',
    '',
    '  src/adapters/cf-continuation-scheduler.test.ts',
    '    - Fake DO storage + fake Queue (collects { body, opts } into array).',
    '    - Same-DO schedule: sets alarm to min of existing and new; appends to alarm-queue storage.',
    '    - Cross-DO schedule: enqueues resume message with correct delaySeconds.',
    '    - cancel removes from alarm-queue; does not attempt to cancel queue message.',
    '',
    'Run: `cd packages/cloudflare-runtime && npx vitest run`. Fix until green.',
  ].join('\n');

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('write-tests', {
      agent: 'tester',
      dependsOn: ['fix-typecheck'],
      task: writeTestsTask,
      verification: { type: 'exit_code' },
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('run-tests', {
      type: 'deterministic',
      dependsOn: ['write-tests'],
      command: inWorktree(WORKTREE_PATH, 'cd packages/cloudflare-runtime && npx vitest run 2>&1 | tail -80'),
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
        'Iterate until all tests pass. Do NOT disable tests.',
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

  const reviewTask = [
    'Review the adapters diff.',
    '',
    `Worktree: ${WORKTREE_PATH}.`,
    '',
    'Verify (these map to SPEC invariants):',
    '  [#2] On suspend flow: create writes to DO storage synchronously (no fire-and-forget).',
    '  [#5] DO is single writer for conversation state; KV is trigger index only; no',
    '       continuation payload ever written to KV.',
    '  [alarm] Scheduler handles single-alarm-per-DO correctly; alarm-queue tracks pending.',
    '  [cross-DO] resume messages carry enough info to route correctly.',
    '  [tests] Failure paths covered (transaction half-fail, terminal state, cancel).',
    '',
    'Write VERDICT to packages/cloudflare-runtime/VERDICT-02.md. Use KEEP | PAUSE.',
  ].join('\n');

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('review', {
      agent: 'reviewer',
      dependsOn: ['run-tests-final'],
      task: reviewTask,
      verification: { type: 'file_exists', value: `${WORKTREE_PATH}/packages/cloudflare-runtime/VERDICT-02.md` },
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('verify-verdict', {
      type: 'deterministic',
      dependsOn: ['review'],
      command: [
        `cd ${JSON.stringify(WORKTREE_PATH)}`,
        'grep -Eqi "(^|[*#[:space:]])verdict:?[[:space:]]*keep" packages/cloudflare-runtime/VERDICT-02.md || (cat packages/cloudflare-runtime/VERDICT-02.md; exit 1)',
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
          'printf "%s\\n" "feat(cloudflare-runtime): continuation store + scheduler adapters" "" "- CfContinuationStore: DO storage primary, KV secondary for trigger index" "- CfContinuationScheduler: DO alarm for same-DO, Queue-with-delay for cross-DO" "- FakeDurableObjectStorage for tests" "" "Implements SPEC Invariants #2 (sync store write on suspend) and #5 (DO is" "single writer, KV is eventually-consistent index only)." > "$MSG"',
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
      title: 'feat(cloudflare-runtime): continuation store + scheduler adapters',
      dependsOn: ['commit'],
      labels: ['cf-runtime', 'no-merge-without-w3'],
      bodyLines: [
        '## Summary',
        'W2 of 4 in the `@agent-assistant/cloudflare-runtime` bundle. Adds:',
        '- `CfContinuationStore` — implements `ContinuationStore` with DO storage (authoritative) + KV trigger index (secondary).',
        '- `CfContinuationScheduler` — implements `ContinuationSchedulerAdapter` with DO alarms (same-DO) and Queue delayed delivery (cross-DO).',
        '- `FakeDurableObjectStorage` fixture for tests.',
        '',
        '## SPEC invariants enforced',
        '- #2: continuation records written synchronously on suspend.',
        '- #5: DO is the single writer; KV is trigger index only.',
        '',
        '## Test evidence',
        '- `npx vitest run` — all green. Covers transaction half-fail, terminal-state index cleanup, cross-DO delayed delivery, alarm single-pending semantics.',
        '- VERDICT-02.md: KEEP.',
        '',
        '## Order',
        'Depends on W1 (`feat/cf-runtime-core`). Do not merge until W1 is in; base branch will be moved to `main` after W1 merges.',
        '',
        '## Follow-up',
        'W3 (executor + DO base class + delivery adapter + specialist client) sits on top of this.',
      ],
    }));

  const result = await wf.run({ cwd: process.cwd() });
  console.log('Workflow status:', result.status);
}

runWorkflow().catch((error) => {
  console.error(error);
  process.exit(1);
});
