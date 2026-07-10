/**
 * V5-01 (cloud side): Canonical Slack Proxy for Sage Egress (80-to-100 hardened)
 *
 * Pairs with sage/workflows/v5/01-sage-relayfile-migration.ts.
 *
 * Creates POST /api/v1/proxy/slack — the single ingress point sage's
 * CloudProxyProvider calls for chat.postMessage / reactions / thread history.
 * Cloud owns:
 *   1. Service-to-service Bearer auth (constant-time compare).
 *   2. Workspace → Slack connection resolution via PR #155 canonical helpers.
 *   3. Closed allow-list of Slack endpoints.
 *   4. Per-channel + per-workspace sliding-window rate limit.
 *   5. Structured audit logging (never logs message payloads).
 *   6. Stable error envelope so SlackEgress can map failures.
 *
 * 80-to-100 hardening (vs original draft):
 *   - Regression-test-author writes a PGlite-backed wire-format contract
 *     test BEFORE any impl runs. Tests exercise real Request/Response and
 *     real Postgres (in-memory) — no SDK-level mocks, no typed-object
 *     shortcuts that skip serialization.
 *   - Every impl step is followed by a verify-<wave> deterministic gate
 *     that greps for required AND forbidden substrings (literal strings,
 *     not `\s`) and asserts git diff is non-empty on expected files.
 *   - The test gate is a test-fix-rerun triplet, not single-shot.
 *   - Additional global gates: no plain-string token compare,
 *     no logging of data/params/body payloads, no wildcard allow-list.
 *
 * Repos touched:  cloud/packages/web
 * Requires before: PR #155 merged (canonical Slack team_id metadata).
 * Unblocks:       sage v5-01 migration (it calls this route).
 */

import { workflow } from '@relayflows/core';

const READ_GLOBS = [
  'packages/web/app/api/v1/**',
  'packages/web/lib/integrations/**',
  'packages/web/lib/auth/**',
  'packages/web/lib/**',
  'packages/web/tests/**',
  'tests/**',
  'packages/web/package.json',
  'packages/web/tsconfig.json',
  '../sage-slack-envelope/workflows/v5/01-sage-relayfile-migration.ts',
  '../sage-slack-envelope/src/integrations/**',
  '../relayfile/packages/sdk/typescript/src/connection.ts',
];

const DENY_GLOBS = [
  '.env*',
  'packages/web/.next/**',
  'packages/web/.open-next/**',
  '../sage-slack-envelope/src/proactive/**',
  '../relayfile/**',
  '../relay-cloud/**',
];

async function main() {
  const result = await workflow('cloud-v5-01-slack-proxy')
    .description('Add canonical POST /api/v1/proxy/slack for sage egress (80-to-100 hardened)')
    .pattern('dag')
    .channel('wf-cloud-v5-01')
    .maxConcurrency(4)
    .timeout(5_400_000) // 90 min — adds regression tests + verify gates + test-fix-rerun

    // ----- agents --------------------------------------------------------

    .agent('lead', {
      cli: 'claude',
      role: 'Architect: specs the proxy route, auth model, allow-list, and review gate',
      preset: 'lead',
      retries: 1,
      permissions: {
        access: 'readonly',
        files: { read: READ_GLOBS, write: [], deny: DENY_GLOBS },
        exec: ['git diff *', 'git status', 'cat *', 'ls *', 'grep *'],
      },
    })

    .agent('regression-author', {
      cli: 'codex',
      role: 'Writes a PGlite-backed wire-format contract test BEFORE impl lands',
      preset: 'worker',
      retries: 2,
      permissions: {
        access: 'restricted',
        files: {
          read: READ_GLOBS,
          write: ['tests/slack-proxy-contract.test.ts', 'tests/helpers/**'],
          deny: DENY_GLOBS,
        },
        exec: [],
      },
    })

    .agent('route-impl', {
      cli: 'codex',
      role: 'Implements the Next.js route handler, request/response schemas, and auth gate',
      preset: 'worker',
      retries: 2,
      permissions: {
        access: 'restricted',
        files: {
          read: READ_GLOBS,
          write: [
            'packages/web/app/api/v1/proxy/slack/route.ts',
            'packages/web/lib/integrations/slack-proxy-schema.ts',
            'packages/web/lib/integrations/slack-proxy-auth.ts',
          ],
          deny: DENY_GLOBS,
        },
        exec: [],
      },
    })

    .agent('ratelimit-impl', {
      cli: 'codex',
      role: 'Builds the per-channel + per-workspace rate limiter module',
      preset: 'worker',
      retries: 2,
      permissions: {
        access: 'restricted',
        files: {
          read: READ_GLOBS,
          write: ['packages/web/lib/integrations/slack-proxy-ratelimit.ts'],
          deny: DENY_GLOBS,
        },
        exec: [],
      },
    })

    .agent('audit-impl', {
      cli: 'codex',
      role: 'Builds the audit logger invoked on every proxied Slack call',
      preset: 'worker',
      retries: 2,
      permissions: {
        access: 'restricted',
        files: {
          read: READ_GLOBS,
          write: ['packages/web/lib/integrations/slack-proxy-audit.ts'],
          deny: DENY_GLOBS,
        },
        exec: [],
      },
    })

    .agent('test-impl', {
      cli: 'codex',
      role: 'Writes unit + integration tests for the route + auth + allow-list + rate limiter + audit',
      preset: 'worker',
      retries: 2,
      permissions: {
        access: 'restricted',
        files: {
          read: READ_GLOBS,
          write: [
            'tests/slack-proxy-route.test.ts',
            'tests/slack-proxy-ratelimit.test.ts',
            'tests/slack-proxy-audit.test.ts',
          ],
          deny: DENY_GLOBS,
        },
        exec: [],
      },
    })

    .agent('test-fixer', {
      cli: 'codex',
      role: 'Reads a failing test run and fixes ONLY test wiring (not product code)',
      preset: 'worker',
      retries: 2,
      permissions: {
        access: 'restricted',
        files: {
          read: READ_GLOBS,
          write: ['tests/**'],
          deny: DENY_GLOBS,
        },
        exec: [],
      },
    })

    // ----- read context --------------------------------------------------

    .step('read-slack-identity', {
      type: 'deterministic',
      command: 'cat packages/web/lib/integrations/slack-identity.ts 2>/dev/null || echo "(not yet merged — requires PR #155)"',
      captureOutput: true,
      failOnError: false,
    })

    .step('read-workspace-integrations', {
      type: 'deterministic',
      command: 'cat packages/web/lib/integrations/workspace-integrations.ts',
      captureOutput: true,
      failOnError: true,
    })

    .step('read-nango-slack-helper', {
      type: 'deterministic',
      command: 'cat packages/web/lib/integrations/nango-slack.ts',
      captureOutput: true,
      failOnError: true,
    })

    .step('read-nango-service', {
      type: 'deterministic',
      command: 'cat packages/web/lib/integrations/nango-service.ts 2>/dev/null || echo "NOT_FOUND"',
      captureOutput: true,
      failOnError: false,
    })

    .step('read-webhook-router', {
      type: 'deterministic',
      command: 'cat packages/web/lib/integrations/nango-webhook-router.ts',
      captureOutput: true,
      failOnError: true,
    })

    .step('read-nango-webhook-route', {
      type: 'deterministic',
      command: 'cat packages/web/app/api/v1/webhooks/nango/route.ts',
      captureOutput: true,
      failOnError: true,
    })

    .step('read-request-auth', {
      type: 'deterministic',
      command: 'cat packages/web/lib/auth/request-auth.ts 2>/dev/null || echo "NOT_FOUND"',
      captureOutput: true,
      failOnError: false,
    })

    .step('read-example-v1-route', {
      type: 'deterministic',
      command: 'cat packages/web/app/api/v1/webhooks/github/route.ts 2>/dev/null | head -120 || echo "NOT_FOUND"',
      captureOutput: true,
      failOnError: false,
    })

    .step('read-existing-test-pattern', {
      type: 'deterministic',
      command: [
        'echo "=== test runner + PGlite pattern in existing tests ==="',
        'head -30 tests/slack-identity.test.ts 2>/dev/null || echo "NOT_FOUND"',
        'echo "---"',
        'grep -rln "pglite\\|PGlite\\|@electric-sql/pglite" tests packages/web/tests 2>/dev/null || echo "(no PGlite yet)"',
        'echo "---"',
        'grep -rln "helpers/test-db\\|test-db\\|setup-db" tests packages/web/tests 2>/dev/null || echo "(no test-db helper yet)"',
      ].join(' && '),
      captureOutput: true,
      failOnError: false,
    })

    .step('read-sage-cloud-proxy-provider', {
      type: 'deterministic',
      command: 'grep -A 30 "CloudProxyProvider" ../sage-slack-envelope/workflows/v5/01-sage-relayfile-migration.ts 2>/dev/null || echo "(sage workflow not accessible)"',
      captureOutput: true,
      failOnError: false,
    })

    // ----- lead: architecture spec ---------------------------------------

    .step('spec', {
      agent: 'lead',
      dependsOn: [
        'read-slack-identity',
        'read-workspace-integrations',
        'read-nango-slack-helper',
        'read-nango-service',
        'read-webhook-router',
        'read-nango-webhook-route',
        'read-request-auth',
        'read-example-v1-route',
        'read-existing-test-pattern',
        'read-sage-cloud-proxy-provider',
      ],
      task: `Design POST /api/v1/proxy/slack for the cloud Next.js app.

Goal: a hardened, service-to-service Slack proxy that sage calls from
Cloudflare Workers. Sage sends { workspaceId, endpoint, method, data }.
Cloud resolves the Slack connection via the canonical team_id metadata
introduced in PR #155, then forwards to Nango. Sage never sees
providerConfigKey or connectionId — that is a hard invariant of the sage
migration pairing this workflow.

Existing helpers you must reuse:

  slack-identity.ts (PR #155):
  {{steps.read-slack-identity.output}}

  workspace-integrations.ts (PR #155):
  {{steps.read-workspace-integrations.output}}

  nango-slack.ts (proxyRequest helper):
  {{steps.read-nango-slack-helper.output}}

  nango-service.ts:
  {{steps.read-nango-service.output}}

  nango-webhook-router.ts (Slack event plumbing pattern):
  {{steps.read-webhook-router.output}}

  Existing nango webhook route (pattern to follow):
  {{steps.read-nango-webhook-route.output}}

  Request auth helper:
  {{steps.read-request-auth.output}}

  v1 webhook route example:
  {{steps.read-example-v1-route.output}}

  Existing test runner + PGlite availability:
  {{steps.read-existing-test-pattern.output}}

  Sage CloudProxyProvider (caller — wire format):
  {{steps.read-sage-cloud-proxy-provider.output}}

Produce a spec covering:

1. Route shape (packages/web/app/api/v1/proxy/slack/route.ts)
   - POST only. Export async function POST(request: Request): Promise<Response>.
   - Request schema (Zod):
       workspaceId: string (cloud workspace UUID — sage sends this, not team_id),
       endpoint: string (Slack Web API path, e.g. '/chat.postMessage'),
       method: 'GET' | 'POST',
       data?: Record<string, unknown>,
       params?: Record<string, string>
   - Response envelope:
       success: { ok: true, data: <Slack response> }
       error:   { ok: false, error: string, code: Code, retryAfterMs?: number }
     where Code = 'unauthorized' | 'forbidden' | 'rate_limited' | 'not_found' | 'slack_error' | 'upstream_error' | 'bad_request'
   - Status codes: 200 for ok OR Slack-level errors (business-level), 400 on bad schema, 401 on missing auth, 403 on wrong token or disallowed endpoint, 404 on missing workspace, 429 on local rate limit (+ Retry-After header), 502 on Nango failure.

2. Auth (packages/web/lib/integrations/slack-proxy-auth.ts)
   - Require header "Authorization: Bearer <token>".
   - Token compared with env.CLOUD_API_TOKEN via crypto.timingSafeEqual on equal-length Buffers.
   - Missing header → 401 code='unauthorized'.
   - Wrong token → 403 code='unauthorized' (not 'forbidden' — reserve 'forbidden' for allow-list rejections).
   - Log every auth failure via slack-proxy-audit.

3. Workspace resolution
   - workspaceId is the cloud workspace UUID.
   - Use workspace-integrations.ts to look up the Slack integration row.
   - If canonical team_id metadata missing, attempt self-heal via slack-identity.ts (same pattern as nango-webhook-router.ts).
   - If still missing → 404 code='not_found'.
   - Cache resolution for 60s keyed on workspaceId.

4. Allow-list (packages/web/lib/integrations/slack-proxy-schema.ts)
   - Exact allowed endpoints:
       /chat.postMessage
       /chat.postEphemeral
       /reactions.add
       /reactions.remove
       /conversations.replies
       /conversations.history
       /auth.test
   - Method per endpoint: postMessage/postEphemeral/reactions.* → POST, conversations.* → GET, auth.test → POST.
   - Anything else → 403 code='forbidden'.
   - Export the allow-list as a readonly const array so tests can import it.

5. Rate limiting (packages/web/lib/integrations/slack-proxy-ratelimit.ts)
   - Per (workspaceId, channel): 1 request / 1.1s sliding window.
   - Per workspaceId global: 50 requests / 60s.
   - In-memory Map singleton, per-Node-instance. Documented limitation.
   - Signature:
       checkSlackProxyRateLimit({ workspaceId, channel?, now? }): { ok: true } | { ok: false, retryAfterMs, scope: 'channel'|'workspace' }
       resetSlackProxyRateLimit(): void  // for tests
   - 'channel' extracted from data.channel for POST calls, params.channel for GET.

6. Audit logging (packages/web/lib/integrations/slack-proxy-audit.ts)
   - Entry schema (exported):
       { workspaceId, endpoint, method, channel?, httpStatus, slackOk?, errorCode?, latencyMs, reason }
   - reason ∈ 'ok' | 'unauthorized' | 'forbidden' | 'rate_limited' | 'not_found' | 'slack_error' | 'upstream_error' | 'bad_request'
   - Function: recordSlackProxyCall(entry).
   - Use the dominant logger pattern already in packages/web.
   - NEVER include data, params, text, blocks, attachments, or any payload field in the audit entry.
   - For auth failures where the body wasn't parsed yet, log workspaceId='(unknown)'.

7. Forwarding logic
   - After auth + allow-list + resolution + rate-limit, call proxyRequest from nango-slack.ts with { method, endpoint, providerConfigKey, connectionId, params?, data? } — providerConfigKey and connectionId are pulled from the resolved integration row, never from the request body.
   - Wrap in try/catch, map thrown errors to code='upstream_error' with 502.
   - If Slack returns { ok: false, error }, return 200 with { ok: false, error, code: 'slack_error' } — do not pass through raw Slack error bodies.

8. Regression test (tests/slack-proxy-contract.test.ts — written FIRST by regression-author)
   Spec the test file before impl. It exercises the REAL route handler with
   a real Request object and a real in-memory Postgres (PGlite if available,
   otherwise a strict inline fake of just workspace-integrations used by the
   route). The test mocks ONLY the proxyRequest network call via vi.fn().

   Required cases:
     1. 'happy path: postMessage returns { ok: true, data }'
        - seed workspace + slack integration row
        - POST with Bearer CLOUD_API_TOKEN, endpoint /chat.postMessage, data { channel, text }
        - expect 200, { ok: true, data: { ok: true, channel, ts } }
        - expect proxyRequest called with exactly { method:'POST', endpoint:'/chat.postMessage', providerConfigKey, connectionId, data: { channel, text } }
     2. 'missing Authorization → 401 unauthorized'
     3. 'wrong bearer token → 403 unauthorized'
     4. 'disallowed endpoint /users.list → 403 forbidden'
     5. 'unknown workspace → 404 not_found'
     6. 'rate limited → 429 rate_limited with retryAfterMs'
     7. 'slack ok:false passthrough → 200 { ok: false, code: slack_error }'
     8. 'nango throws → 502 { code: upstream_error }'
     9. 'audit entry never contains data.text or params'
     10. 'plain-string token equality is not used (defense grep)'

9. Tests (written by test-impl in Wave B)
   - tests/slack-proxy-route.test.ts — Zod bad-request edge cases, method-method mismatch cases, self-heal path.
   - tests/slack-proxy-ratelimit.test.ts — same-channel window, independent-channel parallelism, workspace-global window, resetSlackProxyRateLimit clears state.
   - tests/slack-proxy-audit.test.ts — records success, records failure with reason, omits data/params, omits data.text.

10. Wave plan:
    Wave 0 (after spec): regression test authoring (regression-author agent)
    Wave A (all parallel, after verify-regression-test):
      - impl-route
      - impl-ratelimit
      - impl-audit
    Wave B (after all Wave A verifies pass):
      - impl-tests
    Wave C (after impl-tests):
      - typecheck
      - run-tests triplet (first-run, fix, rerun)
      - verify-allow-list, verify-auth-safety, verify-audit-no-leak
    Wave D: final-review

For each worker, list exact files it writes and exported symbols other
workers import. Be explicit about cross-worker contracts.

End with: SPEC_COMPLETE`,
      verification: { type: 'output_contains', value: 'SPEC_COMPLETE' },
    })

    // ----- Wave 0: regression test first (tests before impl) -------------

    .step('write-regression-tests', {
      agent: 'regression-author',
      dependsOn: ['spec'],
      task: `Write the wire-format contract test per the spec.

Spec:
{{steps.spec.output}}

Create: tests/slack-proxy-contract.test.ts

This test MUST exercise the REAL route handler at
packages/web/app/api/v1/proxy/slack/route.ts by importing POST from it
and calling it with a real Request object (new Request(url, { method, headers, body })).

Database access:
  - If PGlite or a test-db helper already exists (see existing-test-pattern
    read step), use it. Seed a workspace row + slack integration row with
    canonical team_id metadata.
  - If neither exists, create tests/helpers/slack-proxy-db.ts that exports
    createTestWorkspaceDb() returning an object with the minimum surface
    the route's workspace-integrations helper uses. Then monkey-patch the
    module via vi.mock if that's the dominant pattern in this repo
    (check tests/slack-identity.test.ts first).

Mock only proxyRequest from nango-slack — everything else should be real.

Required cases (use these EXACT test names):

  1. 'happy path: postMessage returns ok true with wire shape'
  2. 'missing Authorization header returns 401 unauthorized'
  3. 'wrong bearer token returns 403 unauthorized'
  4. 'disallowed endpoint users.list returns 403 forbidden'
  5. 'unknown workspace returns 404 not_found'
  6. 'rate limited returns 429 rate_limited with retryAfterMs'
  7. 'slack ok false is passed through as slack_error'
  8. 'nango throw maps to 502 upstream_error'
  9. 'audit entry never contains data.text'
  10. 'route source uses timingSafeEqual not plain equality'

Case 10 reads packages/web/lib/integrations/slack-proxy-auth.ts from disk
via node:fs and asserts:
  - the file includes the substring 'timingSafeEqual'
  - the file does NOT include a direct plain-string comparison of the
    token (no '=== process.env.CLOUD_API_TOKEN' and no 'token === ')

Case 9 imports the audit module, calls recordSlackProxyCall with an entry
whose incoming body had { data: { text: 'secret' } }, then asserts the
serialized log line (or captured logger output) does NOT contain 'secret'.

Rules:
  - The test file MUST fail until impl lands (tests-first).
  - Use vitest style if tests/slack-identity.test.ts uses vitest; otherwise
    node:test — match the existing pattern exactly.
  - Do NOT create any source files outside tests/.

Write to disk. Do NOT print file contents to stdout.`,
      verification: { type: 'file_exists', value: 'tests/slack-proxy-contract.test.ts' },
    })

    .step('verify-regression-test', {
      type: 'deterministic',
      dependsOn: ['write-regression-tests'],
      command: [
        'test -f tests/slack-proxy-contract.test.ts',
        'grep -q "happy path: postMessage returns ok true with wire shape" tests/slack-proxy-contract.test.ts',
        'grep -q "missing Authorization header returns 401 unauthorized" tests/slack-proxy-contract.test.ts',
        'grep -q "wrong bearer token returns 403 unauthorized" tests/slack-proxy-contract.test.ts',
        'grep -q "disallowed endpoint users.list returns 403 forbidden" tests/slack-proxy-contract.test.ts',
        'grep -q "unknown workspace returns 404 not_found" tests/slack-proxy-contract.test.ts',
        'grep -q "rate limited returns 429 rate_limited with retryAfterMs" tests/slack-proxy-contract.test.ts',
        'grep -q "slack ok false is passed through as slack_error" tests/slack-proxy-contract.test.ts',
        'grep -q "nango throw maps to 502 upstream_error" tests/slack-proxy-contract.test.ts',
        'grep -q "audit entry never contains data.text" tests/slack-proxy-contract.test.ts',
        'grep -q "route source uses timingSafeEqual not plain equality" tests/slack-proxy-contract.test.ts',
        'echo REGRESSION_TEST_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ----- Wave A (parallel) ---------------------------------------------

    .step('impl-route', {
      agent: 'route-impl',
      dependsOn: ['verify-regression-test'],
      task: `Implement the route + schema + auth per the spec.

Spec:
{{steps.spec.output}}

Create:
  packages/web/app/api/v1/proxy/slack/route.ts
  packages/web/lib/integrations/slack-proxy-schema.ts
  packages/web/lib/integrations/slack-proxy-auth.ts

Hard rules (verified by a gate after this step):
  - route.ts: exports async function POST(request: Request): Promise<Response>.
  - route.ts: imports from '@/lib/integrations/slack-identity'.
  - route.ts: imports from '@/lib/integrations/workspace-integrations'.
  - route.ts: imports from '@/lib/integrations/nango-slack'.
  - route.ts: imports checkSlackProxyRateLimit from './...slack-proxy-ratelimit'.
  - route.ts: imports recordSlackProxyCall from './...slack-proxy-audit'.
  - slack-proxy-auth.ts: contains 'timingSafeEqual' from 'node:crypto'.
  - slack-proxy-auth.ts: does NOT contain 'token ===' or '=== process.env.CLOUD_API_TOKEN' or similar plain-string compare.
  - slack-proxy-schema.ts: exports SLACK_PROXY_ALLOW_LIST as readonly const array.
  - slack-proxy-schema.ts: does NOT contain 'users.list', 'admin.', '*', or 'files.upload'.

Rules:
  - Zod validates the request body; reject malformed with 400 code='bad_request'.
  - Use existing @/lib/integrations/nango-slack proxyRequest helper.
  - No new runtime deps. Check packages/web/package.json first.
  - Do NOT touch nango-slack.ts, slack-identity.ts, workspace-integrations.ts, or the webhook router.

Write to disk. Do NOT print file contents to stdout.`,
      verification: { type: 'file_exists', value: 'packages/web/app/api/v1/proxy/slack/route.ts' },
    })

    .step('verify-route', {
      type: 'deterministic',
      dependsOn: ['impl-route'],
      command: [
        'test -f packages/web/app/api/v1/proxy/slack/route.ts',
        'test -f packages/web/lib/integrations/slack-proxy-schema.ts',
        'test -f packages/web/lib/integrations/slack-proxy-auth.ts',
        'grep -q "export async function POST" packages/web/app/api/v1/proxy/slack/route.ts',
        'grep -q "slack-identity" packages/web/app/api/v1/proxy/slack/route.ts',
        'grep -q "workspace-integrations" packages/web/app/api/v1/proxy/slack/route.ts',
        'grep -q "nango-slack" packages/web/app/api/v1/proxy/slack/route.ts',
        'grep -q "slack-proxy-ratelimit" packages/web/app/api/v1/proxy/slack/route.ts',
        'grep -q "slack-proxy-audit" packages/web/app/api/v1/proxy/slack/route.ts',
        'grep -q "timingSafeEqual" packages/web/lib/integrations/slack-proxy-auth.ts',
        'grep -q "node:crypto\\|from \\"crypto\\"" packages/web/lib/integrations/slack-proxy-auth.ts',
        'grep -q "SLACK_PROXY_ALLOW_LIST\\|allowList\\|ALLOW_LIST" packages/web/lib/integrations/slack-proxy-schema.ts',
        '! grep -q "users.list" packages/web/lib/integrations/slack-proxy-schema.ts',
        '! grep -q "admin\\." packages/web/lib/integrations/slack-proxy-schema.ts',
        '! grep -q "files.upload" packages/web/lib/integrations/slack-proxy-schema.ts',
        'grep -q "/chat.postMessage" packages/web/lib/integrations/slack-proxy-schema.ts',
        'grep -q "/reactions.add" packages/web/lib/integrations/slack-proxy-schema.ts',
        'grep -q "/conversations.replies" packages/web/lib/integrations/slack-proxy-schema.ts',
        'echo ROUTE_VERIFY_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('impl-ratelimit', {
      agent: 'ratelimit-impl',
      dependsOn: ['verify-regression-test'],
      task: `Implement the rate limiter per the spec.

Spec:
{{steps.spec.output}}

Create: packages/web/lib/integrations/slack-proxy-ratelimit.ts

Required exports (route-impl imports these exact names):
  export type RateLimitResult = { ok: true } | { ok: false; retryAfterMs: number; scope: 'channel' | 'workspace' };
  export function checkSlackProxyRateLimit(input: { workspaceId: string; channel?: string; now?: number }): RateLimitResult;
  export function resetSlackProxyRateLimit(): void;

Rules:
  - Pure in-memory Map-based sliding window.
  - Per (workspaceId, channel): 1 request / 1100ms.
  - Per workspaceId global: 50 requests / 60000ms.
  - Module-level singleton state.
  - No external deps.
  - Deterministic: now parameter lets tests pin time.

Write to disk. Do NOT print file contents to stdout.`,
      verification: { type: 'file_exists', value: 'packages/web/lib/integrations/slack-proxy-ratelimit.ts' },
    })

    .step('verify-ratelimit', {
      type: 'deterministic',
      dependsOn: ['impl-ratelimit'],
      command: [
        'test -f packages/web/lib/integrations/slack-proxy-ratelimit.ts',
        'grep -q "checkSlackProxyRateLimit" packages/web/lib/integrations/slack-proxy-ratelimit.ts',
        'grep -q "resetSlackProxyRateLimit" packages/web/lib/integrations/slack-proxy-ratelimit.ts',
        'grep -q "RateLimitResult" packages/web/lib/integrations/slack-proxy-ratelimit.ts',
        'grep -q "1100\\|1_100" packages/web/lib/integrations/slack-proxy-ratelimit.ts',
        'grep -q "60000\\|60_000" packages/web/lib/integrations/slack-proxy-ratelimit.ts',
        '! grep -q "require.*redis\\|from.*redis\\|ioredis" packages/web/lib/integrations/slack-proxy-ratelimit.ts',
        'echo RATELIMIT_VERIFY_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('impl-audit', {
      agent: 'audit-impl',
      dependsOn: ['verify-regression-test'],
      task: `Implement the audit logger per the spec.

Spec:
{{steps.spec.output}}

Create: packages/web/lib/integrations/slack-proxy-audit.ts

Required exports (route-impl imports these exact names):
  export interface SlackProxyAuditEntry {
    workspaceId: string;
    endpoint: string;
    method: 'GET' | 'POST';
    channel?: string;
    httpStatus: number;
    slackOk?: boolean;
    errorCode?: string;
    latencyMs: number;
    reason: 'ok' | 'unauthorized' | 'forbidden' | 'rate_limited' | 'not_found' | 'slack_error' | 'upstream_error' | 'bad_request';
  }
  export function recordSlackProxyCall(entry: SlackProxyAuditEntry): void;

Rules:
  - Use the dominant logger pattern already in packages/web. Grep for
    "logger" / "pino" / "console.info" and match.
  - NEVER include data, params, text, blocks, attachments, or any body
    payload in the audit entry or the log line.
  - The function MUST NOT accept arbitrary extra fields via a spread —
    take only SlackProxyAuditEntry, nothing else.
  - For auth failures where workspaceId is unknown, callers pass
    workspaceId='(unknown)'.
  - No new runtime deps.

Write to disk. Do NOT print file contents to stdout.`,
      verification: { type: 'file_exists', value: 'packages/web/lib/integrations/slack-proxy-audit.ts' },
    })

    .step('verify-audit', {
      type: 'deterministic',
      dependsOn: ['impl-audit'],
      command: [
        'test -f packages/web/lib/integrations/slack-proxy-audit.ts',
        'grep -q "SlackProxyAuditEntry" packages/web/lib/integrations/slack-proxy-audit.ts',
        'grep -q "recordSlackProxyCall" packages/web/lib/integrations/slack-proxy-audit.ts',
        '! grep -q "data.text\\|body.data\\|data\\.params\\|data\\.blocks\\|data\\.attachments" packages/web/lib/integrations/slack-proxy-audit.ts',
        '! grep -q "\\.\\.\\.entry\\|\\.\\.\\.rest\\|\\.\\.\\.args" packages/web/lib/integrations/slack-proxy-audit.ts',
        'echo AUDIT_VERIFY_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ----- Wave B (after all of Wave A) ----------------------------------

    .step('impl-tests', {
      agent: 'test-impl',
      dependsOn: ['verify-route', 'verify-ratelimit', 'verify-audit'],
      task: `Write unit + integration tests for the new proxy surface.

Spec:
{{steps.spec.output}}

Create:
  tests/slack-proxy-route.test.ts
  tests/slack-proxy-ratelimit.test.ts
  tests/slack-proxy-audit.test.ts

Use the test runner pattern from tests/slack-identity.test.ts (head -5
gives you the runner). Mock proxyRequest from nango-slack; mock
workspace-integrations lookup if needed.

route.test.ts must cover (in addition to what the contract test covers):
  1. Zod reject: body missing workspaceId → 400 bad_request.
  2. Zod reject: endpoint not a string → 400 bad_request.
  3. Wrong method for endpoint (e.g. GET /chat.postMessage) → 403 forbidden.
  4. Self-heal happy path: row missing team_id metadata, slack-identity heals, call proceeds.
  5. Self-heal failure: slack-identity returns null, → 404 not_found.

ratelimit.test.ts must cover:
  1. Same (workspace, channel) twice within 1100ms → second rejected with scope='channel'.
  2. Different channels in same workspace → both pass.
  3. 51st request in 60000ms for same workspace → rejected with scope='workspace'.
  4. resetSlackProxyRateLimit clears state.
  5. now parameter pins time deterministically.

audit.test.ts must cover:
  1. Records on success (reason='ok').
  2. Records on every failure reason.
  3. Does NOT include data.text in the logged output.
  4. Does NOT include params in the logged output.
  5. workspaceId='(unknown)' path for auth failures.

Write files to disk. Do NOT print contents to stdout.`,
      verification: { type: 'file_exists', value: 'tests/slack-proxy-route.test.ts' },
    })

    .step('verify-tests-present', {
      type: 'deterministic',
      dependsOn: ['impl-tests'],
      command: [
        'test -f tests/slack-proxy-route.test.ts',
        'test -f tests/slack-proxy-ratelimit.test.ts',
        'test -f tests/slack-proxy-audit.test.ts',
        'test -f tests/slack-proxy-contract.test.ts',
        'echo TESTS_PRESENT_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ----- verification gates --------------------------------------------

    .step('typecheck', {
      type: 'deterministic',
      dependsOn: ['verify-tests-present'],
      command: 'npx tsc -p packages/web/tsconfig.json --noEmit',
      captureOutput: true,
      failOnError: true,
    })

    // ----- test-fix-rerun triplet ----------------------------------------

    .step('test-first-run', {
      type: 'deterministic',
      dependsOn: ['typecheck'],
      command: 'mkdir -p .logs && npx tsx --test tests/slack-proxy-contract.test.ts tests/slack-proxy-route.test.ts tests/slack-proxy-ratelimit.test.ts tests/slack-proxy-audit.test.ts tests/slack-identity.test.ts 2>&1 | tee .logs/v5-01-cloud-test-first-run.log',
      captureOutput: true,
      failOnError: false,
    })

    .step('test-fix', {
      agent: 'test-fixer',
      dependsOn: ['test-first-run'],
      task: `Read the test first-run output below. If all tests passed,
print "NO_FIX_NEEDED" and do nothing. If any test failed, decide whether
the failure is TEST WIRING (import path, mock shape, PGlite setup,
assertion wording) or PRODUCT CODE.

  - If the failure points at product code, DO NOT fix it. Print
    "PRODUCT_BUG: <file>:<line> <reason>" and stop. The rerun will fail
    loudly, which is the correct outcome — we don't paper over bugs in
    product code by patching tests.
  - If the failure is test wiring only, fix the test file(s) in place.
    Print "FIXED: <files>".
  - You may edit only files under tests/. You may NOT edit anything under
    packages/web/.

Vitest first-run output:
{{steps.test-first-run.output}}

Write fixes to disk. Do NOT print full file contents to stdout.`,
      verification: { type: 'exit_code' },
    })

    .step('test-rerun', {
      type: 'deterministic',
      dependsOn: ['test-fix'],
      command: 'npx tsx --test tests/slack-proxy-contract.test.ts tests/slack-proxy-route.test.ts tests/slack-proxy-ratelimit.test.ts tests/slack-proxy-audit.test.ts tests/slack-identity.test.ts',
      captureOutput: true,
      failOnError: true,
    })

    // ----- global safety gates -------------------------------------------

    .step('verify-allow-list', {
      type: 'deterministic',
      dependsOn: ['test-rerun'],
      command: [
        'echo "=== allow-list must be closed ==="',
        '! grep -q "users.list" packages/web/lib/integrations/slack-proxy-schema.ts',
        '! grep -q "admin\\." packages/web/lib/integrations/slack-proxy-schema.ts',
        '! grep -q "files.upload" packages/web/lib/integrations/slack-proxy-schema.ts',
        '! grep -q "wildcard" packages/web/lib/integrations/slack-proxy-schema.ts',
        'grep -q "/chat.postMessage" packages/web/lib/integrations/slack-proxy-schema.ts',
        'grep -q "/chat.postEphemeral" packages/web/lib/integrations/slack-proxy-schema.ts',
        'grep -q "/reactions.add" packages/web/lib/integrations/slack-proxy-schema.ts',
        'grep -q "/reactions.remove" packages/web/lib/integrations/slack-proxy-schema.ts',
        'grep -q "/conversations.replies" packages/web/lib/integrations/slack-proxy-schema.ts',
        'grep -q "/conversations.history" packages/web/lib/integrations/slack-proxy-schema.ts',
        'grep -q "/auth.test" packages/web/lib/integrations/slack-proxy-schema.ts',
        'echo ALLOW_LIST_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('verify-auth-safety', {
      type: 'deterministic',
      dependsOn: ['verify-allow-list'],
      command: [
        'echo "=== token comparison must use timingSafeEqual ==="',
        'grep -q "timingSafeEqual" packages/web/lib/integrations/slack-proxy-auth.ts',
        'echo "=== no plain-string token compare ==="',
        '! grep -q "token ===" packages/web/lib/integrations/slack-proxy-auth.ts',
        '! grep -q "token !==" packages/web/lib/integrations/slack-proxy-auth.ts',
        '! grep -q "=== process.env.CLOUD_API_TOKEN" packages/web/lib/integrations/slack-proxy-auth.ts',
        'echo "=== auth module imports from node:crypto ==="',
        'grep -q "node:crypto\\|from \\"crypto\\"" packages/web/lib/integrations/slack-proxy-auth.ts',
        'echo AUTH_SAFETY_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('verify-audit-no-leak', {
      type: 'deterministic',
      dependsOn: ['verify-auth-safety'],
      command: [
        'echo "=== audit module must not reference payload fields ==="',
        '! grep -q "data\\.text" packages/web/lib/integrations/slack-proxy-audit.ts',
        '! grep -q "data\\.blocks" packages/web/lib/integrations/slack-proxy-audit.ts',
        '! grep -q "data\\.attachments" packages/web/lib/integrations/slack-proxy-audit.ts',
        '! grep -q "body\\.data" packages/web/lib/integrations/slack-proxy-audit.ts',
        '! grep -q "params" packages/web/lib/integrations/slack-proxy-audit.ts',
        'echo "=== audit function must not take spread args ==="',
        '! grep -q "\\.\\.\\.entry\\|\\.\\.\\.rest\\|\\.\\.\\.args" packages/web/lib/integrations/slack-proxy-audit.ts',
        'echo AUDIT_NO_LEAK_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('verify-no-new-deps', {
      type: 'deterministic',
      dependsOn: ['verify-audit-no-leak'],
      command: [
        'echo "=== package.json diff (new runtime deps?) ==="',
        'git diff main -- packages/web/package.json || true',
        'git diff --quiet main -- packages/web/package.json || (echo "WARN: packages/web/package.json changed — verify no new runtime deps were added" && git diff main -- packages/web/package.json)',
        'echo NO_NEW_DEPS_CHECK_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: false,
    })

    // ----- final review --------------------------------------------------

    .step('final-review', {
      agent: 'lead',
      dependsOn: ['verify-no-new-deps'],
      task: `Review the cloud Slack proxy landing.

Typecheck:
{{steps.typecheck.output}}

Test first-run:
{{steps.test-first-run.output}}

Test fix outcome:
{{steps.test-fix.output}}

Test rerun:
{{steps.test-rerun.output}}

Allow-list gate:
{{steps.verify-allow-list.output}}

Auth safety gate:
{{steps.verify-auth-safety.output}}

Audit no-leak gate:
{{steps.verify-audit-no-leak.output}}

Dep diff:
{{steps.verify-no-new-deps.output}}

Run these verifications yourself and report:
  git diff --stat main
  git diff main -- packages/web/app/api/v1/proxy/slack/route.ts
  git diff main -- packages/web/lib/integrations/slack-proxy-*.ts
  grep -rn "slack-proxy" packages/web/
  grep -n "timingSafeEqual" packages/web/lib/integrations/slack-proxy-auth.ts

For each invariant, report PASS or FAIL with file:line evidence:
  1. POST /api/v1/proxy/slack exists and is gated on Bearer CLOUD_API_TOKEN.
  2. Token comparison uses crypto.timingSafeEqual (not ===).
  3. Endpoint allow-list is closed (no wildcards, users.list, admin.*, files.upload).
  4. Method-per-endpoint enforcement is in place.
  5. Workspace resolution uses slack-identity.ts canonical helpers from PR #155.
  6. Self-heal path exists for rows missing team_id metadata.
  7. Rate limiter enforces per-channel AND per-workspace windows.
  8. Audit logger records every outcome path (ok, unauthorized, forbidden, rate_limited, not_found, slack_error, upstream_error, bad_request).
  9. Audit logger never logs data.text / data.blocks / data.attachments / params.
  10. No new runtime deps in packages/web/package.json.
  11. Typecheck passes.
  12. Wire-format regression test passes (tests/slack-proxy-contract.test.ts).
  13. All three unit/integration test files pass.
  14. Response envelope matches what sage CloudProxyProvider expects:
      { ok: true, data } | { ok: false, error, code, retryAfterMs? }

If all pass, end with: PROXY_READY_FOR_SAGE`,
      verification: { type: 'output_contains', value: 'PROXY_READY_FOR_SAGE' },
    })

    .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
    .run({ cwd: process.cwd() });

  console.log('Workflow status:', result.status);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
