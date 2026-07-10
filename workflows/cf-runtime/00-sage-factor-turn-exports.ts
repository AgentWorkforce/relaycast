// W0: sage repo — factor Slack handling into parseSlackWebhook + runSageTurn
// exports, remove local SlackEventDedupGate (use upstream @agent-assistant/
// surfaces instead — but since cf-runtime ingress now owns dedup, sage just
// stops deduping altogether).
//
// Target repo: ../sage
// Branch: feat/factor-turn-exports
// Base: main
// Publishes: @agentworkforce/sage@1.5.0 (after merge, human-driven npm publish)
//
// Runs in parallel with W1 and W4 — no cross-repo dependency.

import { workflow } from '@relayflows/core';
import { applyWorktreeSetup, inWorktree, pushAndOpenPrStep } from './lib/worktree-setup.ts';

const REPO_PATH = '/Users/khaliqgant/Projects/AgentWorkforce/sage';
const BRANCH = 'feat/factor-turn-exports';
const REPO_SLUG = 'AgentWorkforce/sage';
const WORKTREE_PATH = `${REPO_PATH}/../.cf-runtime-worktrees/sage-feat-factor-turn-exports`;

async function runWorkflow() {
  let wf = workflow('cf-runtime-00-sage-factor-turn-exports')
    .description('Sage repo: split src/index.ts exports into parseSlackWebhook (ingress) and runSageTurn (consumer). Remove local SlackEventDedupGate — ingress layer owns dedup now. Backward-compat default { fetch, scheduled } kept. Bump 1.5.0. Open PR.')
    .pattern('dag')
    .channel('wf-cf-runtime-00')
    .maxConcurrency(4)
    .timeout(3_600_000)

    .agent('lead', {
      cli: 'claude',
      role: 'Architecture lead. Owns the ingress/turn split. Rejects any design where runSageTurn implicitly schedules work via waitUntil. Enforces that the two new exports are composable — default.fetch must be a pure composition of them.',
      retries: 1,
    })
    .agent('impl-factor', {
      cli: 'codex',
      role: 'Performs the core refactor: extracts the turn-dispatch body from src/app/slack-webhooks.ts into a standalone runSageTurn function; extracts the parse/verify/rate-limit path into parseSlackWebhook. Removes the local SlackEventDedupGate invocation.',
      retries: 2,
    })
    .agent('impl-exports', {
      cli: 'codex',
      role: 'Wires the new exports in src/index.ts; updates src/app/slack-webhooks.ts to compose them behind the default.fetch path. Bumps package.json to 1.5.0.',
      retries: 2,
    })
    .agent('tester', {
      cli: 'claude',
      preset: 'worker',
      role: 'Writes tests for the new exports AND ensures existing tests still pass. Specifically: a test that runSageTurn does NOT dedup (caller responsibility), a test that default.fetch still dedups (composition), and the existing slack-webhooks.test.ts suite.',
      retries: 2,
    })
    .agent('reviewer', {
      cli: 'claude',
      preset: 'reviewer',
      role: 'Reviews full diff. Verifies backward-compat path, export signatures match SPEC, dedup removal does not introduce a regression in default.fetch. Writes VERDICT-00.md.',
      retries: 1,
    });

  wf = applyWorktreeSetup(wf, {
    repoLabel: 'sage',
    repoPath: REPO_PATH,
    branch: BRANCH,
    worktreePath: WORKTREE_PATH,
    extraSetupCommands: [
      'cd "$WT" && npm run build 2>&1 | tail -10 || true',
    ],
    expectedDirty: [
      'src/index.ts',
      'src/app/slack-webhooks.ts',
      'src/app/slack-state.ts',
      'src/app/sage-turn-descriptor.ts',
      'src/app/slack-webhooks.test.ts',
      'src/app/sage-turn-descriptor.test.ts',
      'package.json',
      'package-lock.json',
      'dist/',
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
    .step('read-current-sage', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: inWorktree(
        WORKTREE_PATH,
        [
          'echo "=== src/index.ts ===" && cat src/index.ts',
          'echo "=== src/app/slack-webhooks.ts ===" && cat src/app/slack-webhooks.ts',
          'echo "=== src/app/slack-state.ts ===" && cat src/app/slack-state.ts',
          'echo "=== package.json ===" && cat package.json',
        ].join(' && '),
      ),
      captureOutput: true,
      failOnError: true,
    });

  const leadTask = [
    'You are the lead on #wf-cf-runtime-00. Workers: impl-factor, impl-exports, tester.',
    '',
    `Worktree: ${WORKTREE_PATH}.`,
    '',
    'Split sage\'s Slack handling into two separately-callable exports and remove the',
    'sage-local dedup copy.',
    '',
    'The production bug context: cloud\'s sage-worker currently calls sage.fetch and',
    'sage\'s own `ctx.executionCtx.waitUntil` dispatches turn work. That waitUntil is',
    'cancelled ~30s after HTTP 200, silencing any long turn. Wrapping sage with a replay-',
    'fake-ctx pattern would hit sage\'s own dedup and no-op. The fix is the split.',
    '',
    'Target exports in src/index.ts:',
    '  export interface SageTurnDescriptor {',
    '    slackEvent: NormalizedSlackEvent;',
    '    workspaceId: string;',
    '    cloudWorkspaceId?: string;',
    '    slackBotUserId: string;',
    '    receivedAt: string;',
    '  }',
    '',
    '  export async function parseSlackWebhook(req: Request, env: SageBindings): Promise<',
    '    | { kind: "ack"; response: Response }         // rate-limit, challenge, irrelevant',
    '    | { kind: "dispatch"; response: Response; turn: SageTurnDescriptor }',
    '  >',
    '',
    '  export async function runSageTurn(',
    '    turn: SageTurnDescriptor,',
    '    env: SageBindings,',
    '    ctx: ExecutionContext,',
    '  ): Promise<void>',
    '',
    'Behavior:',
    '  - parseSlackWebhook: verify signature, parse event, handle Slack URL verification',
    '    challenge, apply rate limit, apply thread-gate / mention-gate. Do NOT dedup. Do',
    '    NOT enqueue. Return either ack-only or a turn descriptor.',
    '  - runSageTurn: run the harness turn synchronously relative to the caller. Internal',
    '    `ctx.waitUntil` for genuinely out-of-band work (e.g. "eyes" reaction) is fine',
    '    IF the caller passes a real ctx. When called from cloud\'s queue consumer, the',
    '    caller will pass a fake ctx that awaits pending before returning.',
    '  - The core turn logic currently lives inside `c.executionCtx.waitUntil((async () => ...)())`',
    '    at src/app/slack-webhooks.ts:682. That inner async body becomes runSageTurn.',
    '',
    'Dedup removal:',
    '  - src/app/slack-state.ts contains the local SlackEventDedupGate (a copy of what',
    '    now lives in @agent-assistant/surfaces). Delete the sage-local gate class, or',
    '    keep the store adapter if it\'s reused elsewhere but delete the gate invocation',
    '    in slack-webhooks.ts. Dedup is now the caller\'s responsibility (cloud\'s',
    '    wrapCloudflareWorker does it at ingress using the same primitive from surfaces).',
    '  - default { fetch } must still work for local dev / standalone deploys. It should',
    '    compose parseSlackWebhook + runSageTurn + an inline dedup (using the same',
    '    @agent-assistant/surfaces SlackEventDedupGate against env.DEDUP). This preserves',
    '    backward compatibility for anyone who uses the default export.',
    '',
    'Version bump: package.json 1.4.20 → 1.5.0 (minor — new exports, no breaking changes).',
    '',
    'Review impl-factor\'s diff between rounds. Critical checks:',
    '  - runSageTurn does not call dedup.',
    '  - parseSlackWebhook does not dispatch the turn.',
    '  - default.fetch path still does dedup + dispatch (so local dev keeps working).',
    '  - The extracted runSageTurn body is IDENTICAL in semantics to the old waitUntil',
    '    body — no silent feature drop.',
    '',
    'SPEC:',
    '{{steps.read-spec.output}}',
    '',
    'Current sage state:',
    '{{steps.read-current-sage.output}}',
  ].join('\n');

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('lead-coordinate', {
      agent: 'lead',
      dependsOn: ['read-spec', 'read-current-sage'],
      task: leadTask,
    });

  const implFactorTask = [
    'You are impl-factor on #wf-cf-runtime-00.',
    '',
    `Worktree: ${WORKTREE_PATH}.`,
    '',
    'Perform the core refactor:',
    '',
    '1. Create src/app/sage-turn-descriptor.ts exporting the SageTurnDescriptor type.',
    '',
    '2. In src/app/slack-webhooks.ts:',
    '   - Extract the inner `waitUntil((async () => { ... })())` body into a standalone',
    '     async function `runSageTurnFromHandler(turn, env, ctx, slack, options)`.',
    '   - Extract the verify + parse + rate-limit + thread-gate path into a standalone',
    '     async function `parseSlackWebhookFromHandler(req, env, options): Promise<AckOrDispatch>`.',
    '   - REMOVE the SlackEventDedupGate invocation. Do not replace it inline in',
    '     parseSlackWebhook — dedup is the caller\'s responsibility.',
    '   - Rewrite the existing createSageApp() Slack route to compose the two internally',
    '     WITH an inline dedup step so default.fetch stays behavior-equivalent for',
    '     standalone callers.',
    '',
    '3. In src/app/slack-state.ts:',
    '   - If nothing else in sage uses SlackEventDedupGate (grep to confirm), delete it',
    '     entirely. Otherwise leave only the store adapter used by other code.',
    '',
    'Run `npm run build && npm test 2>&1 | tail -40` after each material change.',
    'Post "IMPL_FACTOR_DONE" when done.',
    '',
    'Do NOT touch src/index.ts yet — impl-exports will wire the top-level exports.',
    '',
    'SPEC:',
    '{{steps.read-spec.output}}',
  ].join('\n');

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('impl-factor-work', {
      agent: 'impl-factor',
      dependsOn: ['read-spec', 'read-current-sage'],
      task: implFactorTask,
    });

  const implExportsTask = [
    'You are impl-exports on #wf-cf-runtime-00. Wait for impl-factor to finish the',
    'refactor (they will post "IMPL_FACTOR_DONE" on channel).',
    '',
    `Worktree: ${WORKTREE_PATH}.`,
    '',
    'Wire the two new exports in src/index.ts:',
    '',
    '  export { parseSlackWebhook, runSageTurn } from "./app/slack-webhooks.js";',
    '  export type { SageTurnDescriptor } from "./app/sage-turn-descriptor.js";',
    '',
    'If parseSlackWebhook and runSageTurn are not yet exported from slack-webhooks.ts,',
    'add the exports there (re-exporting the standalone functions impl-factor created).',
    '',
    'Bump package.json: "version": "1.4.20" → "1.5.0".',
    '',
    'Run `npm run build` and check dist/index.d.ts contains the new exports.',
    '',
    'Post "IMPL_EXPORTS_DONE" when done.',
    '',
    'SPEC:',
    '{{steps.read-spec.output}}',
  ].join('\n');

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('impl-exports-work', {
      agent: 'impl-exports',
      dependsOn: ['impl-factor-work'],
      task: implExportsTask,
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('verify-files', {
      type: 'deterministic',
      dependsOn: ['impl-exports-work'],
      command: inWorktree(
        WORKTREE_PATH,
        [
          'set -e',
          'test -f src/app/sage-turn-descriptor.ts || (echo "MISSING: sage-turn-descriptor.ts"; exit 1)',
          'grep -q "parseSlackWebhook" src/index.ts || (echo "MISSING export: parseSlackWebhook"; exit 1)',
          'grep -q "runSageTurn" src/index.ts || (echo "MISSING export: runSageTurn"; exit 1)',
          'grep -q "SageTurnDescriptor" src/index.ts || (echo "MISSING export: SageTurnDescriptor"; exit 1)',
          'grep -q "\\"1.5.0\\"" package.json || (echo "Version not bumped to 1.5.0"; exit 1)',
          'echo ALL_FILES_PRESENT',
        ].join(' && '),
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
      command: inWorktree(WORKTREE_PATH, 'npm run build 2>&1 | tail -40; echo EXIT: $?'),
      captureOutput: true,
      failOnError: false,
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('fix-typecheck', {
      agent: 'impl-factor',
      dependsOn: ['typecheck'],
      task: [
        'Fix build errors. Output:',
        '{{steps.typecheck.output}}',
        `Worktree: ${WORKTREE_PATH}.`,
      ].join('\n'),
      verification: { type: 'exit_code' },
    });

  // Tests — both new tests for the split AND regression for existing suite.
  const writeTestsTask = [
    'Write tests for the new exports and run the full existing test suite.',
    '',
    `Worktree: ${WORKTREE_PATH}.`,
    '',
    'Create src/app/sage-turn-descriptor.test.ts with:',
    '  - parseSlackWebhook: valid signature + new event → {kind:"dispatch", turn}',
    '  - parseSlackWebhook: invalid signature → {kind:"ack"} with 401 response',
    '  - parseSlackWebhook: Slack URL verification challenge → {kind:"ack"} with 200 + challenge',
    '  - parseSlackWebhook: rate-limited user → {kind:"ack"} with 200 (rate-limit message posted)',
    '  - parseSlackWebhook does NOT dedup (call twice with same event-id, both return dispatch)',
    '  - runSageTurn with a stubbed harness returns after all internal work completes',
    '  - runSageTurn uses ctx.waitUntil only for the "eyes" reaction (or similar out-of-band),',
    '    not for the turn itself — assert the returned promise has completed the dispatch',
    '    before the function returns.',
    '  - default.fetch path still dedups (call twice with same event-id, second is skipped)',
    '',
    'Also update src/app/slack-webhooks.test.ts if the refactor changed any observable behavior',
    'of the legacy path.',
    '',
    'Run the full suite: `npm test 2>&1 | tail -60`. Fix until green.',
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
      command: inWorktree(WORKTREE_PATH, 'npm test 2>&1 | tail -80'),
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
        'Iterate until green. Do NOT weaken the no-dedup assertion on runSageTurn.',
        `Worktree: ${WORKTREE_PATH}.`,
      ].join('\n'),
      verification: { type: 'exit_code' },
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('run-tests-final', {
      type: 'deterministic',
      dependsOn: ['fix-tests'],
      command: inWorktree(WORKTREE_PATH, 'npm test'),
      captureOutput: true,
      failOnError: true,
    });

  const reviewTask = [
    'Review the sage refactor.',
    '',
    `Worktree: ${WORKTREE_PATH}.`,
    '',
    'Run:',
    `  cd ${WORKTREE_PATH} && git diff origin/main...HEAD`,
    `  cat ${WORKTREE_PATH}/src/index.ts`,
    `  cat ${WORKTREE_PATH}/src/app/slack-webhooks.ts`,
    '',
    'Verify:',
    '  [exports] parseSlackWebhook, runSageTurn, SageTurnDescriptor exported from index.',
    '  [no dedup in parse] parseSlackWebhook does not call SlackEventDedupGate.',
    '  [no dedup in run] runSageTurn does not call SlackEventDedupGate.',
    '  [dedup in default] default.fetch path still dedups (composition behavior preserved).',
    '  [no fire-and-forget of turn] runSageTurn\'s main body is awaited, not scheduled via',
    '       ctx.waitUntil. ctx.waitUntil is acceptable ONLY for out-of-band work.',
    '  [version] package.json is 1.5.0.',
    '  [no feature drop] All slack-webhooks behavior (mention gate, rate limit, proactive',
    '       scheduling, reaction) is present in the new code paths.',
    '',
    'Write VERDICT-00.md with # Verdict: KEEP | PAUSE + sections.',
  ].join('\n');

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('review', {
      agent: 'reviewer',
      dependsOn: ['run-tests-final'],
      task: reviewTask,
      verification: { type: 'file_exists', value: `${WORKTREE_PATH}/VERDICT-00.md` },
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('verify-verdict', {
      type: 'deterministic',
      dependsOn: ['review'],
      command: [
        `cd ${JSON.stringify(WORKTREE_PATH)}`,
        'grep -Eqi "(^|[*#[:space:]])verdict:?[[:space:]]*keep" VERDICT-00.md || (cat VERDICT-00.md; exit 1)',
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
          'git add src package.json package-lock.json',
          'MSG=$(mktemp)',
          'printf "%s\\n" "feat: split Slack handling into parseSlackWebhook + runSageTurn 1.5.0" "" "- new exports parseSlackWebhook ingress side and runSageTurn consumer side" "- SageTurnDescriptor type published" "- removed sage-local SlackEventDedupGate; dedup now owned by the ingress layer" "- default fetch + scheduled preserved as a composition for backward compat" "" "Motivation: cloud sage-worker migration needs to run turns inside a queue" "consumer with a full 15-min budget instead of the 30s waitUntil window." "Wrapping sage.fetch would have hit sage own dedup and silently skipped replays;" "this split makes the two phases separately callable." "" "See AgentWorkforce/cloud workflows/cf-runtime/SPEC.md." > "$MSG"',
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
      title: 'feat: split Slack handling into parseSlackWebhook + runSageTurn (1.5.0)',
      dependsOn: ['commit'],
      labels: ['cf-runtime', 'publish-to-npm-after-merge'],
      bodyLines: [
        '## Summary',
        'Splits sage\'s Slack handling into two separately-callable exports so the cloud-side cf-runtime migration (AgentWorkforce/cloud W6) can run turns inside a queue consumer with a full 15-min budget instead of the 30s `waitUntil` window that\'s silencing long Sage turns in production today.',
        '',
        '## New exports',
        '- `parseSlackWebhook(req, env)` — ingress: verify + parse + rate-limit + thread-gate. Does NOT dedup. Returns an ack-only response or a `SageTurnDescriptor` ready to enqueue.',
        '- `runSageTurn(descriptor, env, ctx)` — consumer: runs the harness turn synchronously relative to the caller. Internal `ctx.waitUntil` is only for genuinely out-of-band work (eyes reaction).',
        '- `SageTurnDescriptor` type.',
        '',
        '## Dedup ownership',
        'Local `SlackEventDedupGate` removed from sage. Ingress dedup is now the caller\'s responsibility — cloud\'s `wrapCloudflareWorker` uses the upstream primitive (`@agent-assistant/surfaces`\'s `SlackEventDedupGate`, which was originally ported FROM sage and has since diverged). The `default { fetch, scheduled }` export still works for local dev / standalone deploys; it composes the split internally with an inline dedup.',
        '',
        '## Why not wrap from outside?',
        'Earlier plan: wrap sage\'s default export, replay the webhook inside the queue consumer with a fake `ctx`. That hits sage\'s own dedup and no-ops — would have shipped the same silent bug. This split is the root-cause fix.',
        '',
        '## Publishing',
        'Version bumped to 1.5.0 (minor — new exports, no breaking changes). After merge, run `npm publish` from this repo so cloud\'s cf-runtime workflow bundle can consume the new exports.',
        '',
        '## Test evidence',
        '- `npm test` all green.',
        '- New test suite `src/app/sage-turn-descriptor.test.ts` asserts: `parseSlackWebhook` does NOT dedup; `runSageTurn` does NOT dedup; `default.fetch` DOES dedup (backward compat).',
        '- VERDICT-00.md: KEEP.',
        '',
        '## Rollback',
        'Unpublish 1.5.0 from npm and revert the merge. Cloud continues on 1.4.20 as today. No runtime risk until cloud actually consumes the new exports in W6.',
      ],
    }));

  const result = await wf.run({ cwd: process.cwd() });
  console.log('Workflow status:', result.status);
}

runWorkflow().catch((error) => {
  console.error(error);
  process.exit(1);
});
