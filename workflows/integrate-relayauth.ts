/**
 * integrate-relayauth.ts
 *
 * Integrates relayauth into relaycast: replace opaque token auth with
 * relayauth JWT verification. Agents authenticated via relayauth get
 * scoped access to channels, DMs, commands based on their token scopes.
 *
 * Depends on: @relayauth/sdk (TokenVerifier, ScopeChecker)
 *
 * Changes:
 *   - Auth middleware: verify relayauth JWTs via JWKS
 *   - Scope enforcement: map relaycast operations to relayauth scopes
 *   - Backwards compat: existing rk_live_ tokens still work (fallback)
 *   - Agent identity: relay agent maps to relayauth identity
 *
 * Run: agent-relay run workflows/integrate-relayauth.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYAUTH = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';

async function main() {
const result = await workflow('integrate-relayauth-relaycast')
  .description('Replace relaycast auth with relayauth JWT verification')
  .pattern('dag')
  .channel('wf-relaycast-relayauth')
  .maxConcurrency(4)
  .timeout(3_600_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design the integration, review code, fix issues',
    cwd: RELAYCAST,
  })
  .agent('auth-dev', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement auth middleware changes',
    cwd: RELAYCAST,
  })
  .agent('scope-dev', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement scope mapping and enforcement',
    cwd: RELAYCAST,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write integration tests',
    cwd: RELAYCAST,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review implementation for security and backwards compatibility',
    cwd: RELAYCAST,
  })

  // ── Phase 1: Read existing code ────────────────────────────────────

  .step('read-auth-middleware', {
    type: 'deterministic',
    command: `cat ${RELAYCAST}/packages/server/src/middleware/auth.ts`,
    captureOutput: true,
  })

  .step('read-worker', {
    type: 'deterministic',
    command: `cat ${RELAYCAST}/packages/server/src/worker.ts`,
    captureOutput: true,
  })

  .step('read-env', {
    type: 'deterministic',
    command: `cat ${RELAYCAST}/packages/server/src/env.ts`,
    captureOutput: true,
  })

  .step('read-relayauth-sdk', {
    type: 'deterministic',
    command: `cat ${RELAYAUTH}/packages/sdk/src/verify.ts && echo "=== SCOPES ===" && cat ${RELAYAUTH}/packages/sdk/src/scopes.ts && echo "=== TYPES ===" && cat ${RELAYAUTH}/packages/types/src/token.ts && echo "=== SCOPE TYPES ===" && cat ${RELAYAUTH}/packages/types/src/scope.ts`,
    captureOutput: true,
  })

  .step('read-relayauth-errors', {
    type: 'deterministic',
    command: `cat ${RELAYAUTH}/packages/sdk/src/errors.ts`,
    captureOutput: true,
  })

  .step('read-existing-tests', {
    type: 'deterministic',
    command: `cat ${RELAYCAST}/packages/server/src/__tests__/test-helpers.ts`,
    captureOutput: true,
  })

  // ── Phase 2: Write tests first (TDD) + Implement ──────────────────

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-auth-middleware', 'read-relayauth-sdk', 'read-existing-tests'],
    task: `Write integration tests for relaycast + relayauth.

Current auth middleware:
{{steps.read-auth-middleware.output}}

RelayAuth SDK:
{{steps.read-relayauth-sdk.output}}

Existing test helpers:
{{steps.read-existing-tests.output}}

Create ${RELAYCAST}/packages/server/src/__tests__/relayauth-integration.test.ts:

Tests:
1. Valid relayauth JWT → request succeeds, identity attached to context
2. Expired relayauth JWT → 401
3. Revoked relayauth JWT → 401
4. JWT with relaycast:channel:read scope → can read channels
5. JWT without relaycast:channel:read scope → 403 on channel read
6. JWT with relaycast:dm:send scope → can send DMs
7. JWT without relaycast:dm:send scope → 403 on DM send
8. Legacy rk_live_ token → still works (backwards compat)
9. No token → 401
10. Malformed token → 401
11. Token with sponsorChain → sponsorChain accessible in request context

Use node:test. Mock JWKS endpoint returning a test public key.
Write to disk.`,
    verification: { type: 'exit_code' },
  })

  .step('implement-auth', {
    agent: 'auth-dev',
    dependsOn: ['read-auth-middleware', 'read-relayauth-sdk', 'read-env', 'write-tests'],
    task: `Update relaycast auth middleware to accept relayauth JWTs.

Current auth middleware:
{{steps.read-auth-middleware.output}}

Current env bindings:
{{steps.read-env.output}}

RelayAuth SDK (TokenVerifier):
{{steps.read-relayauth-sdk.output}}

Changes:

1. Add @relayauth/sdk as a dependency in ${RELAYCAST}/packages/server/package.json

2. Add to env.ts bindings:
   RELAYAUTH_JWKS_URL?: string;  // e.g. "https://relayauth.dev/.well-known/jwks.json"
   RELAYAUTH_ISSUER?: string;    // e.g. "https://relayauth.dev"

3. Update auth middleware (${RELAYCAST}/packages/server/src/middleware/auth.ts):
   - Import { TokenVerifier } from '@relayauth/sdk'
   - Create a lazy-initialized TokenVerifier instance
   - On each request:
     a. Extract Bearer token from Authorization header
     b. Try relayauth JWT verification first (if RELAYAUTH_JWKS_URL is set)
     c. If JWT verification succeeds: extract identity, scopes, sponsor from claims
     d. If JWT verification fails (not a JWT or invalid): fall back to existing rk_live_ token auth
     e. Attach identity info to Hono context: c.set('authIdentity', { id, scopes, sponsor, sponsorChain })

4. Keep existing auth working — this is additive, not a replacement.

Write changes to disk.`,
    verification: { type: 'exit_code' },
  })

  .step('implement-scopes', {
    agent: 'scope-dev',
    dependsOn: ['read-auth-middleware', 'read-relayauth-sdk', 'implement-auth'],
    task: `Add scope enforcement to relaycast routes.

RelayAuth SDK (ScopeChecker):
{{steps.read-relayauth-sdk.output}}

Create ${RELAYCAST}/packages/server/src/middleware/relayauth-scopes.ts:

1. Import { ScopeChecker } from '@relayauth/sdk'

2. Define relaycast scope mapping using the actual route paths:
   const ROUTE_SCOPES: Record<string, string> = {
     'GET /channels': 'relaycast:channel:read:*',
     'POST /channels': 'relaycast:channel:create:*',
     'POST /channels/:name/messages': 'relaycast:message:write:*',
     'GET /channels/:name/messages': 'relaycast:message:read:*',
     'POST /dm': 'relaycast:dm:send:*',
     'GET /dm/conversations': 'relaycast:dm:read:*',
     'GET /dm/:conversation_id/messages': 'relaycast:dm:read:*',
     'POST /commands/:command/invoke': 'relaycast:command:invoke:*',
     'GET /agents': 'relaycast:agent:read:*',
     'POST /agents': 'relaycast:agent:create:*',
   };

3. Create middleware: requireScope(scope: string)
   - If request was authenticated via relayauth JWT: check scope against token scopes
   - If request was authenticated via legacy token: allow (legacy tokens have full access)
   - If scope check fails: return 403 with InsufficientScopeError

4. Export for use in route files.

Write to disk.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement-auth', 'implement-scopes', 'write-tests'],
    command: `cd ${RELAYCAST} && ls -la packages/server/src/middleware/relayauth-scopes.ts packages/server/src/__tests__/relayauth-integration.test.ts 2>&1 && echo "Files present" || echo "MISSING FILES"`,
    failOnError: true,
    captureOutput: true,
  })

  // ── Phase 3: Review + Fix ─────────────────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `bash -lc 'cd ${RELAYCAST} && set -o pipefail && npx turbo typecheck 2>&1 | tail -15'`,
    captureOutput: true,
    failOnError: false,
  })

  .step('review', {
    agent: 'reviewer',
    dependsOn: ['run-tests'],
    task: `Review the relayauth integration.

Typecheck results:
{{steps.run-tests.output}}

Read the changed files:
- cat ${RELAYCAST}/packages/server/src/middleware/auth.ts
- cat ${RELAYCAST}/packages/server/src/middleware/relayauth-scopes.ts
- cat ${RELAYCAST}/packages/server/src/__tests__/relayauth-integration.test.ts

Verify:
1. Backwards compatibility: legacy rk_live_ tokens still work
2. Security: JWT verification uses JWKS, not a shared secret
3. Scope enforcement is correct for each route
4. No hardcoded secrets or URLs
5. SponsorChain is accessible in request context
6. Error responses follow existing relaycast error format`,
    verification: { type: 'exit_code' },
  })

  .step('fix', {
    agent: 'architect',
    dependsOn: ['review'],
    task: `Fix any issues from the review and typecheck.

Typecheck: {{steps.run-tests.output}}
Review: {{steps.review.output}}

Fix all issues. Run typecheck again to verify.`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: RELAYCAST,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\nRelaycast + RelayAuth integration: ${result.status}`);
}

main().catch(console.error);
