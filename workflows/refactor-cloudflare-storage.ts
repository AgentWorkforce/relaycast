/**
 * refactor-cloudflare-storage.ts
 *
 * Break apart the 1810-line cloudflare.ts storage adapter into
 * focused modules and add comprehensive test coverage.
 *
 * Current: one massive file with identity, revocation, role, policy,
 * audit, and webhook storage all mixed together.
 *
 * Target:
 *   storage/cloudflare/index.ts          — factory function
 *   storage/cloudflare/identities.ts     — IdentityDO-backed identity storage
 *   storage/cloudflare/revocation.ts     — KV-backed token revocation
 *   storage/cloudflare/roles.ts          — D1-backed role CRUD
 *   storage/cloudflare/policies.ts       — D1-backed policy CRUD
 *   storage/cloudflare/audit.ts          — D1-backed audit logging + queries
 *   storage/cloudflare/webhooks.ts       — D1-backed audit webhook storage
 *   storage/cloudflare/__tests__/        — tests for each module
 *
 * Codex-only workers.
 *
 * Run: agent-relay run workflows/refactor-cloudflare-storage.ts
 */

import { workflow } from '@relayflows/core';
import { Models } from '@agent-relay/sdk';

const CLOUD = '/Users/khaliqgant/Projects/AgentWorkforce/cloud';

async function main() {
const result = await workflow('refactor-cloudflare-storage')
  .description('Break 1810-line cloudflare.ts into focused modules with test coverage')
  .pattern('dag')
  .channel('wf-cf-storage')
  .maxConcurrency(5)
  .timeout(1_800_000)

  .agent('split-worker', {
    cli: 'codex',
    preset: 'worker',
    model: Models.Codex.GPT_5_4,
    role: 'Splits cloudflare.ts into per-domain modules',
    cwd: CLOUD,
  })
  .agent('identity-test-worker', {
    cli: 'codex',
    preset: 'worker',
    model: Models.Codex.GPT_5_4,
    role: 'Writes tests for identity + revocation storage',
    cwd: CLOUD,
  })
  .agent('rbac-test-worker', {
    cli: 'codex',
    preset: 'worker',
    model: Models.Codex.GPT_5_4,
    role: 'Writes tests for role + policy storage',
    cwd: CLOUD,
  })
  .agent('audit-test-worker', {
    cli: 'codex',
    preset: 'worker',
    model: Models.Codex.GPT_5_4,
    role: 'Writes tests for audit + webhook storage',
    cwd: CLOUD,
  })

  // ═══════════════════════════════════════════════════════════════
  // PHASE 1: Read context
  // ═══════════════════════════════════════════════════════════════

  .step('read-cloudflare-ts', {
    type: 'deterministic',
    command: `cat ${CLOUD}/packages/relayauth/src/storage/cloudflare.ts`,
    captureOutput: true,
  })

  .step('read-storage-interface', {
    type: 'deterministic',
    command: `cat /Users/khaliqgant/Projects/AgentWorkforce/relayauth/packages/server/src/storage/interface.ts`,
    captureOutput: true,
  })

  .step('read-identity-do', {
    type: 'deterministic',
    command: `head -100 ${CLOUD}/packages/relayauth/src/durable-objects/identity-do.ts 2>/dev/null || echo "NO DO FILE"`,
    captureOutput: true,
  })

  // ═══════════════════════════════════════════════════════════════
  // PHASE 2: Split first, then tests in parallel
  // ═══════════════════════════════════════════════════════════════

  .step('impl-split', {
    agent: 'split-worker',
    dependsOn: ['read-cloudflare-ts', 'read-storage-interface'],
    task: `Split the monolithic cloudflare.ts into per-domain modules.

CURRENT CLOUDFLARE.TS (1810 lines):
{{steps.read-cloudflare-ts.output}}

STORAGE INTERFACE:
{{steps.read-storage-interface.output}}

Create directory: ${CLOUD}/packages/relayauth/src/storage/cloudflare/

Split into these files:

1. cloudflare/index.ts — factory + re-exports:
   export function createCloudflareStorage(bindings): AuthStorage { ... }
   export type { CloudflareStorageBindings } from './types.js';
   (Move the createCloudflareStorage function here)

2. cloudflare/types.ts — shared types:
   export interface CloudflareStorageBindings { DB, REVOCATION_KV, IDENTITY_DO, SIGNING_KEY, ... }
   (Extract the bindings interface)

3. cloudflare/identities.ts — CloudflareIdentityStorage class:
   All identity CRUD via Durable Object fetch calls.
   Implements IdentityStorage interface.

4. cloudflare/revocation.ts — CloudflareRevocationStorage class:
   KV-backed revoke() and isRevoked().
   Implements RevocationStorage interface.

5. cloudflare/roles.ts — CloudflareRoleStorage class:
   D1-backed role CRUD.
   Implements RoleStorage interface.

6. cloudflare/policies.ts — CloudflarePolicyStorage class:
   D1-backed policy CRUD.
   Implements PolicyStorage interface.

7. cloudflare/audit.ts — CloudflareAuditStorage class:
   D1-backed audit log + query.
   Implements AuditStorage interface.

8. cloudflare/webhooks.ts — CloudflareAuditWebhookStorage class:
   D1-backed webhook CRUD.
   Implements AuditWebhookStorage interface.

Each file should:
- Import types from @relayauth/server (StorageError, interface types)
- Import types from @relayauth/types
- Export a single class implementing one storage interface
- Have clear JSDoc on the class

After splitting, DELETE the original cloudflare.ts and update the
parent import to use the new directory:

${CLOUD}/packages/relayauth/src/storage/cloudflare.ts → DELETE
${CLOUD}/packages/relayauth/src/entrypoints/cloudflare.ts:
  Update import from "../storage/cloudflare.js" to "../storage/cloudflare/index.js"

IMPORTANT: Write ALL files to disk. Do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  .step('impl-identity-tests', {
    agent: 'identity-test-worker',
    dependsOn: ['impl-split', 'read-identity-do'],
    task: `Write tests for identity + revocation storage.

IDENTITY DO:
{{steps.read-identity-do.output}}

Create ${CLOUD}/packages/relayauth/src/storage/cloudflare/__tests__/identities.test.ts:

Mock the Durable Object stub (fetch calls to /internal/*).
Use vitest.

Tests:
1. create() — sends POST /internal/create, returns identity
2. get() — sends GET /internal/get, returns identity or null
3. update() — sends PATCH /internal/update with patch
4. suspend() — sends POST /internal/suspend with reason
5. retire() — sends POST /internal/retire
6. reactivate() — sends POST /internal/reactivate
7. delete() — sends DELETE /internal/delete
8. get() returns null for non-existent identity (404 from DO)
9. create() with missing sponsorId throws

Create ${CLOUD}/packages/relayauth/src/storage/cloudflare/__tests__/revocation.test.ts:

Mock KV namespace.

Tests:
1. revoke() — calls KV.put with jti and expiration
2. isRevoked() — returns true when KV.get returns a value
3. isRevoked() — returns false when KV.get returns null

IMPORTANT: Write to disk. Do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  .step('impl-rbac-tests', {
    agent: 'rbac-test-worker',
    dependsOn: ['impl-split'],
    task: `Write tests for role + policy storage.

Create ${CLOUD}/packages/relayauth/src/storage/cloudflare/__tests__/roles.test.ts:

Mock D1 database (prepare/bind/all/run).
Use vitest.

Tests:
1. create() — inserts role, returns it
2. get() — selects by id, returns role or null
3. list() — selects by org_id, returns array
4. list() with workspaceId filter
5. update() — updates fields, returns updated role
6. delete() — deletes by id

Create ${CLOUD}/packages/relayauth/src/storage/cloudflare/__tests__/policies.test.ts:

Same pattern as roles:
1. create(), get(), list(), update(), delete()
2. list() filters by org_id and optional workspace_id
3. Policies have priority field — verify it's stored/returned

IMPORTANT: Write to disk. Do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  .step('impl-audit-tests', {
    agent: 'audit-test-worker',
    dependsOn: ['impl-split'],
    task: `Write tests for audit + webhook storage.

Create ${CLOUD}/packages/relayauth/src/storage/cloudflare/__tests__/audit.test.ts:

Mock D1 database.
Use vitest.

Tests:
1. log() — inserts audit entry with all fields
2. query() — filters by orgId
3. query() — filters by action type
4. query() — filters by time range (from/to)
5. query() — pagination with cursor + limit
6. export() — returns all entries for org in time range

Create ${CLOUD}/packages/relayauth/src/storage/cloudflare/__tests__/webhooks.test.ts:

Tests:
1. create() — inserts webhook, returns id
2. list() — returns all webhooks for org
3. delete() — removes webhook by id
4. create() with event filter — stores events array

IMPORTANT: Write to disk. Do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  // ═══════════════════════════════════════════════════════════════
  // PHASE 3: Verify
  // ═══════════════════════════════════════════════════════════════

  .step('verify', {
    type: 'deterministic',
    dependsOn: ['impl-identity-tests', 'impl-rbac-tests', 'impl-audit-tests'],
    command: `echo "=== MODULE COUNT ===" && ls ${CLOUD}/packages/relayauth/src/storage/cloudflare/*.ts 2>/dev/null | wc -l && echo "files in cloudflare/" && echo "=== OLD FILE GONE ===" && test -f ${CLOUD}/packages/relayauth/src/storage/cloudflare.ts && echo "STILL EXISTS (bad)" || echo "DELETED (good)" && echo "=== TEST COUNT ===" && ls ${CLOUD}/packages/relayauth/src/storage/cloudflare/__tests__/*.test.ts 2>/dev/null | wc -l && echo "test files" && echo "=== BUILD ===" && cd ${CLOUD} && npx tsc --noEmit 2>&1 | tail -10; echo "BUILD: $?" && echo "=== TESTS ===" && npx vitest run packages/relayauth/src/storage/cloudflare/__tests__/ --reporter=verbose 2>&1 | tail -15; echo "TESTS: $?"`,
    captureOutput: true,
    failOnError: false,
  })

  .step('fix-build', {
    agent: 'split-worker',
    dependsOn: ['verify'],
    task: `Fix any build or test failures.

VERIFY:
{{steps.verify.output}}

If the old cloudflare.ts still exists, delete it.
If build fails, fix import paths.
If tests fail, fix the mocks.

cd ${CLOUD} && npx tsc --noEmit && npx vitest run packages/relayauth/src/storage/cloudflare/__tests__/

IMPORTANT: Write fixes to disk. Do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 2, retryDelayMs: 10_000 })
  .run({
    cwd: CLOUD,
    onEvent: (e) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\nRefactor Cloudflare Storage: ${result.status}`);
}

main().catch(console.error);
