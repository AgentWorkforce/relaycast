// W1: @agent-assistant/cloudflare-runtime — package skeleton, CfIngress,
// Slack signature verifier, GitHub signature verifier, fake ExecutionContext.
//
// Produces a new package in the agent-assistant monorepo at
// packages/cloudflare-runtime/ with the ingress surface. Downstream workflows
// (W2, W3) add continuation adapters and the executor on top.
//
// Target repo: ../agent-assistant (relative to this file's running cwd)
// Branch: feat/cf-runtime-core
// Final artifact: open PR in AgentWorkforce/agent-assistant
//
// Human gate after W1/W2/W3/W4 merge: publish @agent-assistant/cloudflare-runtime to npm.

import { workflow } from '@relayflows/core';
import { applyWorktreeSetup, inWorktree, pushAndOpenPrStep } from './lib/worktree-setup.ts';

const REPO_PATH = '/Users/khaliqgant/Projects/AgentWorkforce/agent-assistant';
const BRANCH = 'feat/cf-runtime-core';
const REPO_SLUG = 'AgentWorkforce/agent-assistant';
const WORKTREE_PATH = `${REPO_PATH}/../.cf-runtime-worktrees/feat-cf-runtime-core`;

const SPEC_REF_LINES = [
  'Package layout — SPEC.md §"Package layout" / cloudflare-runtime.',
  'Invariants 1–5 — SPEC.md §"Invariants". Specifically #1 (fake ctx awaits waitUntil inline)',
  'and #3 (signature verification at ingress edge).',
];

async function runWorkflow() {
  let wf = workflow('cf-runtime-01-core')
    .description('Create @agent-assistant/cloudflare-runtime package with ingress + signature verifiers + fake ExecutionContext + tests. Open PR in agent-assistant repo.')
    .pattern('dag')
    .channel('wf-cf-runtime-01')
    .maxConcurrency(4)
    .timeout(3_600_000)

    .agent('lead', {
      cli: 'claude',
      role: 'Architecture lead. Reads SPEC.md, enforces invariants, rejects shortcuts. Reviews implementer diffs between rounds. Posts feedback on channel. Decides when work is shippable.',
      retries: 1,
    })
    .agent('impl-pkg', {
      cli: 'codex',
      role: 'Implementer for package scaffolding: package.json, tsconfig.json, vitest.config.ts, README.md, src/index.ts, src/types.ts.',
      retries: 2,
    })
    .agent('impl-ingress', {
      cli: 'codex',
      role: 'Implementer for CfIngress: src/ingress/cf-ingress.ts and fake-execution-context.ts. Must implement Invariant #1 exactly (see SPEC.md).',
      retries: 2,
    })
    .agent('impl-sig', {
      cli: 'codex',
      role: 'Implementer for signature verifiers: src/ingress/signature/slack.ts and github.ts. Constant-time HMAC SHA-256, 5-min replay window for Slack.',
      retries: 2,
    })
    .agent('tester', {
      cli: 'claude',
      preset: 'worker',
      role: 'Writes vitest tests for every src file and runs the test-fix-rerun loop.',
      retries: 2,
    })
    .agent('reviewer', {
      cli: 'claude',
      preset: 'reviewer',
      role: 'Post-implementation reviewer. Reads full diff, verifies every SPEC invariant, writes KEEP/PAUSE verdict to VERDICT.md in worktree.',
      retries: 1,
    });

  wf = applyWorktreeSetup(wf, {
    repoLabel: 'agent-assistant',
    repoPath: REPO_PATH,
    branch: BRANCH,
    worktreePath: WORKTREE_PATH,
    extraSetupCommands: [
      'cd "$WT" && npm run build --workspaces --if-present 2>&1 | tail -20 || true',
    ],
    expectedDirty: [
      'packages/cloudflare-runtime/package.json',
      'packages/cloudflare-runtime/tsconfig.json',
      'packages/cloudflare-runtime/vitest.config.ts',
      'packages/cloudflare-runtime/src/index.ts',
      'packages/cloudflare-runtime/src/types.ts',
      'packages/cloudflare-runtime/src/ingress/cf-ingress.ts',
      'packages/cloudflare-runtime/src/ingress/fake-execution-context.ts',
      'packages/cloudflare-runtime/src/ingress/signature/slack.ts',
      'packages/cloudflare-runtime/src/ingress/signature/github.ts',
      'package.json',
      'package-lock.json',
    ],
  });

  // Read SPEC.md from the cloud repo so agents can quote from it.
  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('read-spec', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: [
        'set -e',
        'cat workflows/cf-runtime/SPEC.md',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    });

  // Lead reviews the SPEC and posts a build plan on-channel.
  const leadPlanTask = [
    'You are the lead on #wf-cf-runtime-01. Workers: impl-pkg, impl-ingress, impl-sig, tester.',
    '',
    'Read the SPEC carefully (inlined below) and post a concise build plan on channel:',
    '  1. File-by-file assignments across impl-pkg / impl-ingress / impl-sig.',
    '  2. Restate Invariant #1 and #3 in your own words so the workers understand them.',
    '  3. Describe the fake ExecutionContext contract: `waitUntil(p)` must push `p` onto',
    '     an internal array; the consumer shell awaits them before returning. That is the',
    '     direct fix for the production bug.',
    '  4. Describe the Slack signature verification: sha256 HMAC, constant-time compare,',
    '     `X-Slack-Request-Timestamp` must be within 5 min.',
    '',
    'While workers implement, read their diffs between rounds. If you see waitUntil fire-',
    'and-forget, or a non-constant-time string compare on signatures, push back on channel.',
    '',
    `Worktree path: ${WORKTREE_PATH}`,
    `Branch: ${BRANCH}`,
    '',
    'SPEC:',
    '{{steps.read-spec.output}}',
  ].join('\n');

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('lead-coordinate', {
      agent: 'lead',
      dependsOn: ['read-spec'],
      task: leadPlanTask,
    });

  // impl-pkg: package scaffolding.
  const implPkgTask = [
    'You are impl-pkg on #wf-cf-runtime-01. The lead will post a plan; follow it.',
    '',
    `Worktree path: ${WORKTREE_PATH}. cd into it for every command.`,
    '',
    'Create these files (no others):',
    '  packages/cloudflare-runtime/package.json',
    '  packages/cloudflare-runtime/tsconfig.json',
    '  packages/cloudflare-runtime/vitest.config.ts',
    '  packages/cloudflare-runtime/README.md',
    '  packages/cloudflare-runtime/src/index.ts',
    '  packages/cloudflare-runtime/src/types.ts',
    '',
    'Rules:',
    '- package.json: name "@agent-assistant/cloudflare-runtime", type "module",',
    '  version "0.1.0", main "dist/index.js", types "dist/index.d.ts".',
    '- dependencies: "@agent-assistant/continuation": "workspace:*",',
    '  "@agent-assistant/webhook-runtime": "workspace:*",',
    '  "@agent-assistant/surfaces": "workspace:*"   (for SlackEventDedupGate).',
    '- devDependencies: "@cloudflare/workers-types": latest available, "vitest",',
    '  "typescript", "@types/node".',
    '- scripts: build "tsc", test "vitest run", test:watch "vitest".',
    '- tsconfig: ESM, strict, target ES2022, moduleResolution "bundler", outDir "dist".',
    '- src/index.ts: placeholder re-exports — leave exports for downstream steps.',
    '- src/types.ts: define `CfBindingsShape` interface (Queue, KVNamespace, DurableObjectNamespace',
    '  bindings we will depend on later — use generic types from @cloudflare/workers-types).',
    '  Also define `TurnQueueMessage` as the union in SPEC §"Queue message schema".',
    '',
    `Also update ${REPO_PATH}/package.json workspaces to include packages/cloudflare-runtime.`,
    '',
    'When done, post "IMPL_PKG_DONE" on channel with the file list. If the lead posts',
    'feedback, read it and fix.',
    '',
    'SPEC:',
    '{{steps.read-spec.output}}',
  ].join('\n');

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('impl-pkg-work', {
      agent: 'impl-pkg',
      dependsOn: ['read-spec'],
      task: implPkgTask,
    });

  // impl-ingress: CfIngress + fake execution context.
  const implIngressTask = [
    'You are impl-ingress on #wf-cf-runtime-01. The lead will post a plan; follow it.',
    '',
    `Worktree path: ${WORKTREE_PATH}.`,
    '',
    'Create these files (no others):',
    '  packages/cloudflare-runtime/src/ingress/cf-ingress.ts',
    '  packages/cloudflare-runtime/src/ingress/fake-execution-context.ts',
    '',
    'cf-ingress.ts must export:',
    '  // Persona-owned parse. Verifies signature + parses + applies persona policy',
    '  // (rate-limit, mention gate). Does NOT dedup — dedup is cf-runtime\'s job.',
    '  export interface ParseResult {',
    '    kind: "ack" | "dispatch";',
    '    response: Response;                          // always present, returned to caller',
    '    turn?: unknown;                              // present only when kind === "dispatch"',
    '    dedupKey?: { eventId?: string; ts?: string };',
    '  }',
    '  export interface WebhookRouteConfig<Env> {',
    '    provider: "slack" | "github" | "nango";',
    '    parse: (req: Request, env: Env) => Promise<ParseResult>;',
    '  }',
    '  export interface CfIngressOptions<Env> {',
    '    webhookRoutes: Record<string, WebhookRouteConfig<Env>>;',
    '    inner?: { fetch?: ExportedHandlerFetchHandler<Env> };  // fallback for non-webhook routes',
    '    queueBinding: keyof Env & string;',
    '    dedupBinding?: keyof Env & string;           // KV for ingress dedup',
    '    dedupTtlSeconds?: number;                     // default 600',
    '    continuationBinding?: keyof Env & string;',
    '    turnExecutorDoBinding?: keyof Env & string;',
    '  }',
    '  export function wrapCloudflareWorker<Env>(opts: CfIngressOptions<Env>): ExportedHandler<Env>;',
    '',
    'Behavior of fetch(req, env, ctx):',
    '  1. Match req.url to a webhookRoute.',
    '  2. If matched: call route.parse(req, env).',
    '     a. kind === "ack" → return result.response (Slack challenge, rate-limit, etc).',
    '     b. kind === "dispatch":',
    '        - Run INGRESS DEDUP using the upstream primitive from',
    '          @agent-assistant/surfaces:',
    '            import {',
    '              SlackEventDedupGate, getSlackDeduplicationKey,',
    '            } from "@agent-assistant/surfaces";',
    '          Construct a `SlackEventDedupGate` with a small inline adapter that',
    '          implements SlackEventDedupStore over KVNamespace at env[dedupBinding]',
    '          (use put with expirationTtl for markProcessed, get for hasBeenProcessed).',
    '          Derive the key from result.dedupKey.',
    '          For GitHub provider: use the `x-github-delivery` header as dedup key;',
    '          the same adapter works.',
    '        - If dedup decision says skip: return 200 OK without enqueueing.',
    '        - Otherwise: await env[queueBinding].send({ type: "webhook", provider,',
    '          turn: result.turn, receivedAt }) and return result.response.',
    '  3. If not matched: call opts.inner?.fetch?.(req, env, ctx); else 404.',
    '',
    'queue(batch, env): placeholder `handleCfQueue` that throws',
    '"executor not wired — see W3". Full wiring lands in W3.',
    '',
    'fake-execution-context.ts must export:',
    '  export function createFakeExecutionContext(): {',
    '    ctx: ExecutionContext;',
    '    waitForPending(): Promise<void>;',
    '    pendingCount(): number;',
    '  }',
    '',
    'Contract (SPEC Invariant #1): `ctx.waitUntil(p)` pushes p onto an internal array.',
    '`waitForPending()` awaits Promise.allSettled(pending). passThroughOnException is a',
    'no-op. This is the DIRECT fix for the production Slack-silence bug.',
    '',
    'Ownership (SPEC Invariants #3, #4, #6, #7):',
    '  - Personas own signature verification (inside their parse function).',
    '  - cf-runtime owns ingress dedup (this file).',
    '  - Personas expose (parse, run) as a two-function contract; cf-runtime consumes it.',
    '',
    'When done, post "IMPL_INGRESS_DONE" on channel.',
    '',
    'SPEC:',
    '{{steps.read-spec.output}}',
  ].join('\n');

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('impl-ingress-work', {
      agent: 'impl-ingress',
      dependsOn: ['read-spec'],
      task: implIngressTask,
    });

  // impl-sig: signature verifiers (HELPERS — called by personas inside their parse).
  const implSigTask = [
    'You are impl-sig on #wf-cf-runtime-01.',
    '',
    `Worktree path: ${WORKTREE_PATH}.`,
    '',
    'Signature verifiers are HELPERS that personas import and call inside their own',
    'parse<Surface>Webhook functions (where they own the signing secret lookup).',
    'cf-ingress does NOT invoke these directly — it just delegates to route.parse.',
    '',
    'Create these files (no others):',
    '  packages/cloudflare-runtime/src/ingress/signature/slack.ts',
    '  packages/cloudflare-runtime/src/ingress/signature/github.ts',
    '',
    'slack.ts exports:',
    '  export async function verifySlackSignature(req: Request, env: { SLACK_SIGNING_SECRET: string })',
    '    : Promise<boolean>',
    '',
    'Rules:',
    '  - Use Web Crypto (crypto.subtle) — no Node crypto, this runs in Workers.',
    '  - Read X-Slack-Request-Timestamp, reject if older than 5 min or newer than 1 min in future.',
    '  - Read X-Slack-Signature, format "v0=<hex>".',
    '  - Base string: `v0:${timestamp}:${rawBody}`.',
    '  - HMAC-SHA256 with env.SLACK_SIGNING_SECRET.',
    '  - Constant-time compare (implement a byte-wise xor loop — do not use `===` on the hex).',
    '  - Return false on any parse error, never throw.',
    '  - CRITICAL: Request body can only be read once. The caller (cf-ingress.ts) must',
    '    re-clone the request before forwarding. Document this as a JSDoc contract on verify.',
    '',
    'github.ts exports:',
    '  export async function verifyGitHubSignature(req: Request, env: { GITHUB_WEBHOOK_SECRET: string })',
    '    : Promise<boolean>',
    '',
    'Rules:',
    '  - Header is X-Hub-Signature-256, format "sha256=<hex>".',
    '  - Base string = raw body.',
    '  - Same constant-time compare helper — factor into a private helper in a sibling file',
    '    `signature/constant-time.ts` if clean.',
    '',
    'When done, post "IMPL_SIG_DONE" on channel.',
    '',
    'SPEC:',
    '{{steps.read-spec.output}}',
  ].join('\n');

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('impl-sig-work', {
      agent: 'impl-sig',
      dependsOn: ['read-spec'],
      task: implSigTask,
    });

  // Verify every expected file was created.
  const verifyFilesCmd = inWorktree(
    WORKTREE_PATH,
    [
      'missing=0',
      'for f in packages/cloudflare-runtime/package.json packages/cloudflare-runtime/tsconfig.json packages/cloudflare-runtime/vitest.config.ts packages/cloudflare-runtime/README.md packages/cloudflare-runtime/src/index.ts packages/cloudflare-runtime/src/types.ts packages/cloudflare-runtime/src/ingress/cf-ingress.ts packages/cloudflare-runtime/src/ingress/fake-execution-context.ts packages/cloudflare-runtime/src/ingress/signature/slack.ts packages/cloudflare-runtime/src/ingress/signature/github.ts; do',
      '  if [ ! -f "$f" ]; then echo "MISSING: $f"; missing=$((missing+1)); fi',
      'done',
      'if [ $missing -gt 0 ]; then echo "$missing files missing"; exit 1; fi',
      'echo "ALL_FILES_PRESENT"',
    ].join('; '),
  );

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('verify-files', {
      type: 'deterministic',
      dependsOn: ['impl-pkg-work', 'impl-ingress-work', 'impl-sig-work'],
      command: verifyFilesCmd,
      captureOutput: true,
      failOnError: true,
    });

  // Install new workspace dep (may need a re-install after adding cloudflare-runtime to workspaces)
  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('reinstall-deps', {
      type: 'deterministic',
      dependsOn: ['verify-files'],
      command: inWorktree(WORKTREE_PATH, 'npm install --legacy-peer-deps --no-audit --no-fund 2>&1 | tail -10'),
      captureOutput: true,
      failOnError: true,
    });

  // Typecheck the new package.
  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('typecheck', {
      type: 'deterministic',
      dependsOn: ['reinstall-deps'],
      command: inWorktree(
        WORKTREE_PATH,
        'cd packages/cloudflare-runtime && npx tsc --noEmit 2>&1 | tail -40; echo "EXIT: $?"',
      ),
      captureOutput: true,
      failOnError: false,
    });

  // Fix typecheck failures if any.
  const fixTypecheckTask = [
    'Check the typecheck output and fix any errors.',
    '',
    'Typecheck output:',
    '{{steps.typecheck.output}}',
    '',
    `Worktree path: ${WORKTREE_PATH}. Only edit files under packages/cloudflare-runtime/.`,
    '',
    'If EXIT is 0 or output has no errors, do nothing.',
    'If there are errors, fix and re-run: `cd packages/cloudflare-runtime && npx tsc --noEmit`.',
    'Iterate until clean.',
  ].join('\n');

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('fix-typecheck', {
      agent: 'impl-ingress',
      dependsOn: ['typecheck'],
      task: fixTypecheckTask,
      verification: { type: 'exit_code' },
    });

  // Tester writes unit tests for ingress + signature verifiers + fake ctx.
  const writeTestsTask = [
    'Write vitest tests for the cloudflare-runtime package.',
    '',
    `Worktree path: ${WORKTREE_PATH}. Work only in packages/cloudflare-runtime/.`,
    '',
    'Required tests (one file each, under src/ next to its target):',
    '  ingress/fake-execution-context.test.ts',
    '    - waitUntil(p) pushes onto pending',
    '    - pendingCount reflects outstanding count',
    '    - waitForPending awaits all pending, including rejected (no throw)',
    '    - passThroughOnException is a no-op',
    '',
    '  ingress/signature/slack.test.ts',
    '    - Known-good signature passes',
    '    - Timestamp older than 5 min fails',
    '    - Timestamp from 2 min in future fails',
    '    - Tampered body fails',
    '    - Missing header fails (false, no throw)',
    '    - Constant-time property: two wrong signatures of same length both return false in',
    '      similar time. A loose assertion (non-flaky) is fine.',
    '',
    '  ingress/signature/github.test.ts',
    '    - Known-good sha256 signature passes',
    '    - Tampered body fails',
    '    - Missing header fails',
    '',
    '  ingress/cf-ingress.test.ts',
    '    - route.parse returns kind:"dispatch" → turn is enqueued; 200 returned.',
    '    - route.parse returns kind:"ack" (e.g. rate-limit, challenge) → response returned,',
    '      queue NOT called.',
    '    - Non-webhook route → opts.inner?.fetch called and its response returned.',
    '    - Ingress dedup: second delivery with same eventId is NOT enqueued (SlackEventDedupGate',
    '      from @agent-assistant/surfaces is the real gate; use its adapter interface against',
    '      a Map-backed fake KVNamespace).',
    '    - GitHub webhook: x-github-delivery header is used as dedup key.',
    '    - The enqueued message matches TurnQueueMessage schema from types.ts.',
    '',
    'Use vi.fn() for queue/kv/inner mocks. Derive known-good signatures with a small',
    'helper that uses crypto.subtle so the test works in the same runtime.',
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

  // First test run (failOnError: false) — captures output for the fix-tests agent.
  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('run-tests', {
      type: 'deterministic',
      dependsOn: ['write-tests'],
      command: inWorktree(
        WORKTREE_PATH,
        'cd packages/cloudflare-runtime && npx vitest run 2>&1 | tail -80',
      ),
      captureOutput: true,
      failOnError: false,
    });

  // Fix loop — agent iterates until green.
  const fixTestsTask = [
    'Check the test output and fix any failures.',
    '',
    'Test output:',
    '{{steps.run-tests.output}}',
    '',
    `Worktree path: ${WORKTREE_PATH}.`,
    '',
    'If all tests pass, do nothing.',
    'If there are failures:',
    '  1. Read the failing test file and the source under test.',
    '  2. Fix the issue (could be test OR source — use judgment, SPEC is source of truth).',
    '  3. Re-run: `cd packages/cloudflare-runtime && npx vitest run`.',
    '  4. Iterate until ALL tests pass.',
    '',
    'Do NOT disable tests to make them pass.',
  ].join('\n');

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('fix-tests', {
      agent: 'tester',
      dependsOn: ['run-tests'],
      task: fixTestsTask,
      verification: { type: 'exit_code' },
    });

  // Hard gate — tests MUST pass.
  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('run-tests-final', {
      type: 'deterministic',
      dependsOn: ['fix-tests'],
      command: inWorktree(
        WORKTREE_PATH,
        'cd packages/cloudflare-runtime && npx vitest run',
      ),
      captureOutput: true,
      failOnError: true,
    });

  // Reviewer reads the full diff and writes a verdict.
  const reviewTask = [
    'Review the full diff of this change and verify SPEC invariants.',
    '',
    `Worktree path: ${WORKTREE_PATH}.`,
    '',
    'Run and read:',
    `  cd ${WORKTREE_PATH} && git diff origin/main...HEAD -- packages/cloudflare-runtime/`,
    `  cd ${WORKTREE_PATH} && cat packages/cloudflare-runtime/src/ingress/fake-execution-context.ts`,
    `  cd ${WORKTREE_PATH} && cat packages/cloudflare-runtime/src/ingress/cf-ingress.ts`,
    `  cd ${WORKTREE_PATH} && cat packages/cloudflare-runtime/src/ingress/signature/slack.ts`,
    `  cd ${WORKTREE_PATH} && cat packages/cloudflare-runtime/src/ingress/signature/github.ts`,
    '',
    'Verify:',
    '  [#1] fake ctx: waitUntil does NOT fire-and-forget; promises are collected and',
    '       waitForPending awaits them. This is the direct production-bug fix — if this',
    '       is wrong, everything downstream breaks.',
    '  [#3] Slack signature: constant-time compare; 5-min replay window; reads body once;',
    '       cf-ingress clones the request before forwarding.',
    '  [api] wrapCloudflareWorker signature matches SPEC §"Package layout".',
    '  [tests] Every public function has at least one test; edge cases covered.',
    '  [no shortcuts] No `any` sprinkled in for convenience; no "TODO implement later"',
    '       in files this workflow is responsible for.',
    '',
    'Write your verdict to packages/cloudflare-runtime/VERDICT.md in the worktree with',
    'sections:',
    '  # Verdict: KEEP | PAUSE',
    '  ## Invariants checked',
    '  ## Residual risks',
    '  ## Notes for reviewers',
    '',
    'KEEP means "merge this". PAUSE means "something above is wrong, do not merge".',
    'If PAUSE, list the specific violations so the impl agents can fix.',
  ].join('\n');

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('review', {
      agent: 'reviewer',
      dependsOn: ['run-tests-final'],
      task: reviewTask,
      verification: { type: 'file_exists', value: `${WORKTREE_PATH}/packages/cloudflare-runtime/VERDICT.md` },
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('verify-verdict', {
      type: 'deterministic',
      dependsOn: ['review'],
      command: [
        `cd ${JSON.stringify(WORKTREE_PATH)}`,
        'grep -Eqi "(^|[*#[:space:]])verdict:?[[:space:]]*keep" packages/cloudflare-runtime/VERDICT.md || (echo "VERDICT not KEEP:"; cat packages/cloudflare-runtime/VERDICT.md; exit 1)',
        'echo VERDICT_KEEP',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    });

  // Commit (deterministic — never let agents commit).
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
          'printf "%s\\n" "feat(cloudflare-runtime): package skeleton + ingress + signature verifiers" "" "Adds @agent-assistant/cloudflare-runtime with:" "- wrapCloudflareWorker(opts): webhook intercept + dedup + enqueue" "- createFakeExecutionContext(): collects waitUntil, awaits before return" "  (direct fix for the Slack-silence / waitUntil-cancelled production bug)" "- verifySlackSignature / verifyGitHubSignature (constant-time, Web Crypto)" "" "Does NOT yet implement the queue consumer or continuation adapters —" "those land in W2 and W3 of the cf-runtime workflow bundle." "" "See workflows/cf-runtime/SPEC.md in the cloud repo." > "$MSG"',
          'git commit -F "$MSG"',
          'rm -f "$MSG"',
        ].join(' && '),
      ),
      captureOutput: true,
      failOnError: true,
    });

  // Push + open PR.
  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('open-pr', pushAndOpenPrStep({
      worktreePath: WORKTREE_PATH,
      branch: BRANCH,
      repoSlug: REPO_SLUG,
      title: 'feat(cloudflare-runtime): package skeleton + ingress + signature verifiers',
      dependsOn: ['commit'],
      labels: ['cf-runtime', 'no-merge-without-w2-w3'],
      bodyLines: [
        '## Summary',
        'First of four agent-assistant PRs landing the `@agent-assistant/cloudflare-runtime` package.',
        '',
        'This PR adds: package scaffolding, `wrapCloudflareWorker` ingress, `createFakeExecutionContext`, and Slack/GitHub signature verifiers. It **does not** yet wire the queue consumer — that is W3.',
        '',
        '## Why this fixes production today',
        "The production bug (Slack silence on any Sage turn that needs time to 'cook') is caused by `ctx.waitUntil(harnessWork)` being cancelled ~30s after the webhook 200s. `createFakeExecutionContext` in this PR is the direct fix — used by the queue consumer (W3), it collects `waitUntil` promises and awaits them inline before the consumer returns, giving the harness the full queue-consumer wall budget (15 min) instead of 30s.",
        '',
        '## Workflow context',
        'Generated by `workflows/cf-runtime/01-runtime-core.ts` in AgentWorkforce/cloud. See that directory\'s README.md for the full dependency graph and run order.',
        '',
        ...SPEC_REF_LINES.map((l) => `- ${l}`),
        '',
        '## Test evidence',
        '- `npx vitest run` — all green in `packages/cloudflare-runtime/`.',
        '- Reviewer VERDICT: KEEP (see `packages/cloudflare-runtime/VERDICT.md`).',
        '',
        '## Rollback',
        'Revert this commit. No runtime consumers yet; zero blast radius.',
        '',
        '## Follow-up',
        'W2 (continuation adapters) + W3 (executor) + W4 (webhook-runtime hardening) are open in parallel or queued behind this PR. Do not publish `@agent-assistant/cloudflare-runtime` to npm until all four are merged.',
      ],
    }));

  const result = await wf.run({ cwd: process.cwd() });
  console.log('Workflow status:', result.status);
}

runWorkflow().catch((error) => {
  console.error(error);
  process.exit(1);
});
