/**
 * V5-06: Notion ingest hookup (cloud-side webhook handler + records client + UI)
 *
 * Hooks @relayfile/adapter-notion into cloud so that Nango sync webhook
 * notifications result in notion content landing in relayfile at the paths
 * sage's relayfile-reader already reads from. Also adds a bulk-ingest trigger
 * on the `auth:creation` event so a freshly-connected notion workspace is
 * populated immediately instead of waiting up to an hour for the first
 * scheduled sync.
 *
 * Full spec: workflows/v5-06-notion-ingest-spec.md
 *
 * Architecture summary:
 *   Path A (steady state):
 *     Nango scheduled sync → webhook to cloud (metadata only) →
 *     cloud fetches records via Nango /records API → writes via NotionAdapter
 *   Path B (cold start):
 *     Nango connection created → auth:creation webhook to cloud →
 *     cloud calls NotionAdapter.bulkIngest(workspaceId)
 *
 * Both paths converge on the same adapter-backed relayfile write path.
 * Cloud never polls Nango on a schedule — only pulls records in response
 * to a webhook push notification.
 *
 * 80-to-100 discipline baked in:
 *   - regression tests authored BEFORE impl, verified failing pre-impl
 *   - typecheck and test-first-run are PEERS of each other, not a chain,
 *     so a typecheck failure does not skip the test triplet
 *   - test-fix-rerun triplet with HARD gate only on test-rerun
 *   - 10 deterministic grep gates verify hard invariants
 *   - final-review by claude lead before commit
 *
 * Single-repo, single-PR. Cloud PR body documents the pre-merge requirement
 * to bump the @relayfile/adapter-notion dep from file: to published version.
 */

import { workflow } from '@relayflows/core';
import { ClaudeModels, CodexModels } from '@agent-relay/config';
import * as path from 'node:path';

const CLOUD = process.cwd();
const ROOT = path.resolve(CLOUD, '..');
const ADAPTER_REPO = path.join(ROOT, 'relayfile-adapters');
const ADAPTER_PKG = path.join(ADAPTER_REPO, 'packages/notion');
const SAGE = path.join(ROOT, 'sage');

const BRANCH = 'refactor/notion-ingest-hookup';
const BASE_BRANCH = 'workflows/v5-slack-e2e-github-clone';

// All impl, tests, commits, and PR opening happen inside a disposable git
// worktree at .claude/worktrees/v5-06-notion-ingest/. The main cloud checkout
// stays untouched. `.claude/worktrees/` is already gitignored.
const WORKTREE = path.join(CLOUD, '.claude/worktrees/v5-06-notion-ingest');

async function main() {
  const result = await workflow('v5-06-notion-ingest')
    .description(
      'Hook up notion ingest in cloud via Nango sync webhooks + auth-creation bulk ingest, add dashboard UI card, 80-to-100 validated'
    )
    .pattern('dag')
    .channel('wf-v5-06-notion-ingest')
    .maxConcurrency(4)
    .timeout(4_500_000) // 75 min — single-repo, no dual-PR plumbing

    // ───────── Agents ─────────

    .agent('lead', {
      cli: 'claude',
      model: ClaudeModels.OPUS,
      role:
        'Senior architect and reviewer. Produces the implementation spec up front from Wave 0 reads, reviews the full diff at the end, signs off PORT_APPROVED or rejects PORT_REJECTED.',
      retries: 1,
    })

    .agent('regression-author', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      preset: 'worker',
      role:
        'Authors the 4 new test files + fixtures BEFORE any implementation exists. Tests must be structurally runnable with node:test via tsx but FAIL at execution because notion-ingest-handler.ts does not yet exist.',
      retries: 2,
    })

    .agent('audit-impl', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      preset: 'worker',
      role:
        'Writes notion-ingest-audit.ts — PII-safe audit type with zero payload fields, matches the slack proxy audit pattern.',
      retries: 2,
    })

    .agent('schema-impl', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      preset: 'worker',
      role:
        'Writes notion-ingest-schema.ts — Zod schemas for Nango auth and sync envelopes plus per-model record schemas, derived from Nango TypeScript types and sage nango-integrations models.',
      retries: 2,
    })

    .agent('records-client-impl', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      preset: 'worker',
      role:
        'Writes notion-records-client.ts — wraps Nango GET /records with async-iterable pagination, Bearer auth, retry on 5xx, zero logging of records or Authorization.',
      retries: 2,
    })

    .agent('handler-impl', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      preset: 'worker',
      role:
        'Writes notion-ingest-handler.ts — both handleNotionSyncNotification and handleNotionBulkIngest, delegates to NotionAdapter, partial-failure tolerant, never touches workspace_integrations directly.',
      retries: 2,
    })

    .agent('router-impl', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      preset: 'worker',
      role:
        'Updates nango-webhook-router.ts case notion branch. Resolves workspaceId from connectionId+providerConfigKey, dispatches to handler by envelope type, handles the auth-creation race with retry.',
      retries: 2,
    })

    .agent('ui-impl', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      preset: 'worker',
      role:
        'Writes NotionConnectionControls.tsx + updates IntegrationsPageView to add a notion card behind NEXT_PUBLIC_NOTION_ENABLED feature flag. Mirrors the existing slack UI pattern exactly.',
      retries: 2,
    })

    .agent('test-fixer', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      preset: 'worker',
      role:
        'Diagnoses cloud-test-first-run failures after the impl waves and fixes them. No-op (prints NO_FIX_NEEDED) when tests already pass.',
      retries: 2,
    })

    .agent('peer-reviewer', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      preset: 'reviewer',
      role:
        'Codex peer-review pass before the claude final-review. Reads the full diff and the test + safety-gate outputs, looks for bugs the grep gates missed (logic errors, race conditions, unused code, drift from spec), signs off PEER_APPROVED or returns a concrete list of concerns for the final-reviewer to consider.',
      retries: 1,
    })

    // ───────── Wave 0: Preflight (deterministic reads) ─────────

    .step('check-adapter-package-exists', {
      type: 'deterministic',
      command: `test -f ${ADAPTER_PKG}/package.json && test -d ${ADAPTER_PKG}/src && echo ADAPTER_PKG_OK`,
      captureOutput: true,
      failOnError: true,
    })

    // Tear down any stale worktree left by a prior aborted run, then create a
    // fresh one at .claude/worktrees/v5-06-notion-ingest/ branched off the base.
    // This isolates the workflow from the user's main cloud checkout — nothing
    // we write can clobber their in-progress work.
    .step('reset-worktree', {
      type: 'deterministic',
      command: [
        `cd ${CLOUD}`,
        `(git worktree remove --force ${WORKTREE} 2>/dev/null || true)`,
        `(git branch -D ${BRANCH} 2>/dev/null || true)`,
        `rm -rf ${WORKTREE}`,
        `echo WORKTREE_RESET`,
      ].join(' && '),
      captureOutput: true,
      failOnError: false,
    })

    .step('create-worktree', {
      type: 'deterministic',
      command: `cd ${CLOUD} && git worktree add -b ${BRANCH} ${WORKTREE} ${BASE_BRANCH} 2>&1 && cd ${WORKTREE} && git rev-parse --abbrev-ref HEAD && echo WORKTREE_READY`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['check-adapter-package-exists', 'reset-worktree'],
    })

    // Adapter references
    .step('read-adapter-index', {
      type: 'deterministic',
      command: `cat ${ADAPTER_PKG}/src/index.ts`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['create-worktree'],
    })
    .step('read-adapter-class', {
      type: 'deterministic',
      command: `cat ${ADAPTER_PKG}/src/adapter.ts`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['create-worktree'],
    })
    .step('read-adapter-sync', {
      type: 'deterministic',
      command: `cat ${ADAPTER_PKG}/src/sync.ts`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['create-worktree'],
    })
    .step('read-adapter-types', {
      type: 'deterministic',
      command: `cat ${ADAPTER_PKG}/src/types.ts`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['create-worktree'],
    })

    // Sage nango-integrations references — source of truth for record shapes
    .step('read-sage-notion-models', {
      type: 'deterministic',
      command: `test -f ${SAGE}/nango-integrations/models.ts && cat ${SAGE}/nango-integrations/models.ts || echo "MISSING: ${SAGE}/nango-integrations/models.ts"`,
      captureOutput: true,
      failOnError: false,
      dependsOn: ['create-worktree'],
    })
    .step('read-sage-sync-content', {
      type: 'deterministic',
      command: `cat ${SAGE}/nango-integrations/notion/syncs/content-metadata.ts`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['create-worktree'],
    })
    .step('read-sage-sync-databases', {
      type: 'deterministic',
      command: `cat ${SAGE}/nango-integrations/notion/syncs/fetch-databases.ts`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['create-worktree'],
    })
    .step('read-sage-sync-pages', {
      type: 'deterministic',
      command: `cat ${SAGE}/nango-integrations/notion/syncs/fetch-pages.ts`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['create-worktree'],
    })

    // Nango webhook type resolution — try multiple locations, fail loudly if unresolved
    .step('read-nango-webhook-types', {
      type: 'deterministic',
      command: [
        `(`,
        `find ${SAGE}/nango-integrations/node_modules/nango -name "*.d.ts" 2>/dev/null | xargs grep -l -E "WebhookBody|NangoWebhook|NangoWebhookType" 2>/dev/null | head -3 | xargs -I {} sh -c 'echo "=== {} ==="; cat "{}"'`,
        `|| find ${ADAPTER_REPO}/node_modules/nango -name "*.d.ts" 2>/dev/null | xargs grep -l -E "WebhookBody|NangoWebhook|NangoWebhookType" 2>/dev/null | head -3 | xargs -I {} sh -c 'echo "=== {} ==="; cat "{}"'`,
        `|| find ${CLOUD}/node_modules/nango -name "*.d.ts" 2>/dev/null | xargs grep -l -E "WebhookBody|NangoWebhook|NangoWebhookType" 2>/dev/null | head -3 | xargs -I {} sh -c 'echo "=== {} ==="; cat "{}"'`,
        `) 2>&1; if [ -z "$(find ${SAGE}/nango-integrations/node_modules/nango ${ADAPTER_REPO}/node_modules/nango ${CLOUD}/node_modules/nango -name '*.d.ts' 2>/dev/null)" ]; then echo NANGO_TYPES_UNRESOLVED; exit 1; fi`,
      ].join(' '),
      captureOutput: true,
      failOnError: true,
      dependsOn: ['create-worktree'],
    })

    // Cloud references — existing structure the impl must mirror
    .step('read-cloud-webhook-router', {
      type: 'deterministic',
      command: `cat ${WORKTREE}/packages/web/lib/integrations/nango-webhook-router.ts`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['create-worktree'],
    })
    .step('read-cloud-slack-audit', {
      type: 'deterministic',
      command: `cat ${WORKTREE}/packages/web/lib/integrations/slack-proxy-audit.ts`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['create-worktree'],
    })
    .step('read-cloud-slack-proxy-route', {
      type: 'deterministic',
      command: `cat ${WORKTREE}/packages/web/app/api/v1/proxy/slack/route.ts`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['create-worktree'],
    })
    .step('read-cloud-workspace-integrations-helper', {
      type: 'deterministic',
      command: `cat ${WORKTREE}/packages/web/lib/integrations/workspace-integrations.ts 2>/dev/null || find ${WORKTREE}/packages/web/lib/integrations -name "workspace-integration*.ts" -exec cat {} \\;`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['create-worktree'],
    })
    .step('read-cloud-slack-controls', {
      type: 'deterministic',
      command: `cat ${WORKTREE}/packages/web/app/dashboard/integrations/SlackConnectionControls.tsx`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['create-worktree'],
    })
    .step('read-cloud-dashboard-views', {
      type: 'deterministic',
      command: `cat ${WORKTREE}/packages/web/app/dashboard/_components/dashboard-views.tsx`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['create-worktree'],
    })
    .step('read-cloud-mock-relayfile-helper', {
      type: 'deterministic',
      command: `cat ${WORKTREE}/tests/helpers/mock-relayfile-server.ts`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['create-worktree'],
    })
    .step('read-cloud-mock-nango-helper', {
      type: 'deterministic',
      command: `cat ${WORKTREE}/tests/helpers/mock-nango-proxy-server.ts 2>/dev/null || echo "NO_EXISTING_MOCK_NANGO"`,
      captureOutput: true,
      failOnError: false,
      dependsOn: ['create-worktree'],
    })

    // ───────── Wave 1: Spec refinement (claude lead) ─────────

    .step('spec', {
      agent: 'lead',
      dependsOn: [
        'read-adapter-index',
        'read-adapter-class',
        'read-adapter-sync',
        'read-adapter-types',
        'read-sage-notion-models',
        'read-sage-sync-content',
        'read-sage-sync-databases',
        'read-sage-sync-pages',
        'read-nango-webhook-types',
        'read-cloud-webhook-router',
        'read-cloud-slack-audit',
        'read-cloud-slack-proxy-route',
        'read-cloud-workspace-integrations-helper',
        'read-cloud-slack-controls',
        'read-cloud-dashboard-views',
        'read-cloud-mock-relayfile-helper',
        'read-cloud-mock-nango-helper',
      ],
      task: `You are the architect for this notion ingest hookup. Produce a crisp implementation spec that the worker agents will follow. Do NOT write any product code — only a spec document.

## Full spec reference
${WORKTREE}/workflows/v5-06-notion-ingest-spec.md (already authored; your job is to TRANSLATE section 5 of that spec into concrete code targets informed by the actual source files below).

## Adapter references

@relayfile/adapter-notion public surface:
{{steps.read-adapter-index.output}}

NotionAdapter class:
{{steps.read-adapter-class.output}}

Adapter sync helpers:
{{steps.read-adapter-sync.output}}

Adapter types:
{{steps.read-adapter-types.output}}

## Sage nango-integrations references (source of truth for record shapes)

models.ts:
{{steps.read-sage-notion-models.output}}

content-metadata sync:
{{steps.read-sage-sync-content.output}}

fetch-databases sync:
{{steps.read-sage-sync-databases.output}}

fetch-pages sync:
{{steps.read-sage-sync-pages.output}}

## Nango webhook type definitions (resolved at Wave 0)

{{steps.read-nango-webhook-types.output}}

## Cloud existing structure

nango-webhook-router.ts (you will update its case 'notion' branch):
{{steps.read-cloud-webhook-router.output}}

slack-proxy-audit.ts (PII-safe pattern you will mirror):
{{steps.read-cloud-slack-audit.output}}

slack proxy route.ts (reference for auth + envelope patterns):
{{steps.read-cloud-slack-proxy-route.output}}

workspace-integrations helper (reference for connectionId → workspaceId lookup):
{{steps.read-cloud-workspace-integrations-helper.output}}

SlackConnectionControls.tsx (UI pattern to mirror):
{{steps.read-cloud-slack-controls.output}}

IntegrationsPageView in dashboard-views.tsx:
{{steps.read-cloud-dashboard-views.output}}

Existing mock-relayfile-server helper (you will reuse):
{{steps.read-cloud-mock-relayfile-helper.output}}

Existing mock-nango-proxy-server helper (you will extend with a /records endpoint):
{{steps.read-cloud-mock-nango-helper.output}}

## Your deliverable — an impl spec with these sections, in order

### 1. Exact file paths
List every file the impl agents will create or modify, with absolute paths, and for each file the EXACT list of top-level exported symbols.

### 2. Envelope shapes
From the Nango type definitions above + sage's models + the examples in the spec file, write out the exact Zod schemas for:
  - Nango webhook envelope discriminator (auth | sync | forward | action)
  - auth creation event: what fields are required, what are optional
  - sync notification event: what fields are required, what are optional
  - NotionDatabase record (derived from sage fetch-databases zod schema)
  - NotionPage record
  - NotionContentMetadata record

State explicitly: does the sync webhook body include a records array, or only metadata like syncName + modifiedAfter + responseResults? The impl wave MUST get this right.

### 3. NotionAdapter method choices
Based on the adapter source above, which adapter methods does the sync path call per model? Example:
  - NotionPage record (ADDED) → adapter.????
  - NotionDatabase record (UPDATED) → adapter.????
  - NotionContentMetadata record (ADDED) → adapter.????

If the adapter does NOT expose a public per-record ingest method for a given model, call this out as ADAPTER_API_INSUFFICIENT and list which private/lower-level methods the handler would have to call, OR recommend adding a new method to the adapter (which would require a separate adapter PR — not in this workflow's scope).

For path B (bulk ingest on auth creation), confirm adapter.bulkIngest(workspaceId) exists and describe its return shape.

### 4. Handler function signatures
Write the exact TypeScript signatures for:
  - handleNotionSyncNotification(args): Promise<{ written, deleted, errors }>
  - handleNotionBulkIngest(args): Promise<{ filesWritten, errors }>

Include every parameter, every field, every type. The impl agent will paste these into the handler file verbatim.

### 5. Records client signature
Write the exact TypeScript signature for fetchNangoRecords(). Cover: pagination cursor handling, retry policy (on 5xx only, max 3, exponential backoff), timeout, abort signal propagation, the shape of the returned AsyncIterable element type.

### 6. Router dispatch logic
Pseudocode for the updated case 'notion' in nango-webhook-router.ts. Cover: envelope discrimination, workspaceId resolution, auth-creation race retry (per spec §12 risk 4), error handling, response shape. Does NOT need to be runnable code — just the control flow.

### 7. Test file layout
For each of the 4 new test files, list:
  - The describe() names
  - The it() names within each describe
  - What fixture each test loads
  - What mock server each test spins up

### 8. Fixture shapes
For sync-notification.json, auth-creation.json, records-response.json — write out the exact JSON content the regression-author will commit. Derive from Nango types — no hand-waving.

### 9. Audit entry allowed-fields list
From the spec's invariant 2: exact field names in NotionIngestAuditEntry. Confirm that none of the forbidden fields (records, content, properties, payload, title, body) appear.

### 10. Wiring checklist
What edit does the router impl agent make to nango-webhook-router.ts to replace the existing no-op case 'notion' branch? List the line range to replace, the new code's top-level shape, and the imports to add.

End with exactly: SPEC_COMPLETE`,
      verification: { type: 'output_contains', value: 'SPEC_COMPLETE' },
      retries: 1,
    })

    // ───────── Wave 2: Regression tests (codex worker) ─────────

    .step('write-notion-regression-tests', {
      agent: 'regression-author',
      dependsOn: ['spec'],
      task: `Write the adapter-side regression tests for notion ingest BEFORE any production code exists. Tests MUST fail on execution (ERR_MODULE_NOT_FOUND or "no test suite found") against the current state because notion-ingest-handler.ts and the other new files do not yet exist.

## Spec you are implementing
{{steps.spec.output}}

## Working directory
Work inside ${WORKTREE} on branch ${BRANCH} (this is a git worktree — your main cloud checkout is untouched).

## Files to create

### Test files (node:test + tsx, matching the github-clone test pattern)
- tests/notion-ingest-handler.test.ts
- tests/notion-records-client.test.ts
- tests/notion-ingest-audit.test.ts
- tests/notion-webhook-router.test.ts

### Fixtures (JSON)
- tests/fixtures/notion/sync-notification.json — Nango sync webhook body (no records, just metadata)
- tests/fixtures/notion/auth-creation.json — Nango auth creation event for a notion connection
- tests/fixtures/notion/records-response.json — Canned /records API response: 1 NotionDatabase + 2 NotionPage + 1 NotionContentMetadata + 1 DELETED record, cursor null (single page)

### Test helpers
- tests/helpers/mock-nango-server.ts — Extends the existing mock-nango-proxy-server (or creates a new one if the existing one doesn't exist). MUST handle BOTH: the existing proxy endpoints from the github clone tests AND a new GET /records endpoint that returns records-response.json when queried with appropriate params.
- tests/helpers/mock-nango-webhook-poster.ts — Tiny http helper that POSTs a fixture body at cloud's webhook URL

### Style rules
- Every test file starts with \`import { describe, it } from 'node:test'; import assert from 'node:assert/strict';\`
- Import production modules with relative paths and NO .js extensions (Next.js turbopack + tsx both resolve extensionless imports)
- Each test file header comment: \`// Regression test for v5-06 notion ingest — authored before impl per 80-to-100 pattern. Fails until the port lands.\`

### Test cases to cover
From spec section 5c:

notion-ingest-handler.test.ts:
  describe "handleNotionSyncNotification":
    - writes all 3 supported models from a fixture records batch
    - ADDED/UPDATED records dispatch to the correct adapter method per model
    - DELETED records are dropped with an audit entry (do not throw)
    - empty records batch is a no-op
    - adapter exception on one record does not abort the rest (partial-failure tolerance)
    - second call with the same payload is idempotent (relayfile writes replace)
  describe "handleNotionBulkIngest":
    - calls NotionAdapter.bulkIngest with the given workspaceId
    - audit entry records trigger: 'auth-creation'
    - adapter exception is caught, audit entry records outcome: 'failed'

notion-records-client.test.ts:
  describe "fetchNangoRecords":
    - paginates via next_cursor until null
    - sets Authorization: Bearer <secret> header
    - passes model + sync_name + modified_after as query params
    - retries on 5xx (max 3, exponential backoff)
    - does NOT retry on 4xx
    - never logs records or Authorization header (grep the test output for leaks)
    - propagates AbortSignal

notion-ingest-audit.test.ts:
  describe "NotionIngestAuditEntry":
    - has allowed fields only — structural/type-level assertion
    - forbidden fields do NOT exist on the type — compile-time guard
  describe "recordNotionIngest":
    - calls the underlying logger with a serializable payload
    - audit entry serializes to JSON without errors
    - no PII field ever appears in the serialized output

notion-webhook-router.test.ts:
  describe "nango-webhook-router case 'notion'":
    - type:'sync' notion envelope → handleNotionSyncNotification called with resolved workspaceId
    - type:'auth', operation:'creation' notion → handleNotionBulkIngest called with resolved workspaceId
    - type:'auth', operation:'creation' github → falls through, notion handler not called
    - type:'auth', operation:'refresh' notion → falls through, no ingest fires
    - unknown model on sync → rejected with audit entry 'unsupported_model', 200 response
    - workspace_unresolved on auth-creation → retries 3x then drops with audit entry

## DO NOT
- Write any production code (no notion-ingest-handler.ts, no notion-records-client.ts, no notion-ingest-audit.ts, no notion-ingest-schema.ts, no NotionConnectionControls.tsx, no changes to nango-webhook-router.ts or dashboard-views.tsx)
- Skip any test — every test must be present and structurally runnable
- Hand-wave fixture shapes — derive them from the Nango types and the spec above

When done, print exactly: REGRESSION_TESTS_WRITTEN`,
      verification: { type: 'output_contains', value: 'REGRESSION_TESTS_WRITTEN' },
      retries: 2,
    })

    .step('verify-notion-regression-fails', {
      type: 'deterministic',
      // Expected to fail — tests exist but imports resolve to non-existent files.
      // failOnError: false — we WANT failure as proof the regression gate works.
      command: `cd ${WORKTREE} &&(npx tsx --test tests/notion-ingest-handler.test.ts tests/notion-records-client.test.ts tests/notion-ingest-audit.test.ts tests/notion-webhook-router.test.ts 2>&1 || true) | tail -20 && echo REGRESSION_FAILED_AS_EXPECTED`,
      captureOutput: true,
      failOnError: false,
      dependsOn: ['write-notion-regression-tests'],
    })

    // ───────── Wave 3: Backend implementation (parallel after regression) ─────────

    .step('impl-audit', {
      agent: 'audit-impl',
      dependsOn: ['verify-notion-regression-fails'],
      task: `Write packages/web/lib/integrations/notion-ingest-audit.ts matching the slack proxy audit pattern exactly.

## Spec
{{steps.spec.output}}

## Reference — slack-proxy-audit.ts pattern to mirror
{{steps.read-cloud-slack-audit.output}}

## Hard requirements
1. Export a typed \`NotionIngestAuditEntry\` interface with the allowed fields only (see spec §9).
2. Forbidden fields must NOT appear in the interface: \`records\`, \`content\`, \`properties\`, \`payload\`, \`title\`, \`body\`. TypeScript structural guard is what protects PII.
3. Export \`recordNotionIngest(entry: NotionIngestAuditEntry): Promise<void>\` (or sync — match the slack proxy pattern).
4. Use the same logger import path that slack-proxy-audit.ts uses. Do not invent a new path.
5. No ".js" extensions on relative imports.

Write ONLY this one file. Do not modify the handler, schema, records client, router, or tests.

When done, print exactly: AUDIT_IMPL_COMPLETE`,
      verification: { type: 'output_contains', value: 'AUDIT_IMPL_COMPLETE' },
      retries: 2,
    })

    .step('impl-schema', {
      agent: 'schema-impl',
      dependsOn: ['verify-notion-regression-fails'],
      task: `Write packages/web/lib/integrations/notion-ingest-schema.ts with Zod schemas for Nango webhook envelopes + notion record types.

## Spec
{{steps.spec.output}}

## Nango webhook type definitions
{{steps.read-nango-webhook-types.output}}

## Sage notion record schemas
models.ts:
{{steps.read-sage-notion-models.output}}

fetch-databases:
{{steps.read-sage-sync-databases.output}}

fetch-pages:
{{steps.read-sage-sync-pages.output}}

content-metadata:
{{steps.read-sage-sync-content.output}}

## Hard requirements
1. Export Zod schemas for: NangoWebhookEnvelopeSchema (discriminated union on type), NangoAuthCreationEventSchema, NangoSyncNotificationEventSchema.
2. Export per-model record schemas: NotionDatabaseRecordSchema, NotionPageRecordSchema, NotionContentMetadataRecordSchema. Derive fields from sage's zod schemas above.
3. Export a helper \`discriminateNotionEvent(envelope)\` that returns \`{ kind: 'sync', payload } | { kind: 'auth-creation', payload } | { kind: 'ignore' }\`.
4. Do NOT add \`nango\` as a devDep unless strictly necessary — if the Nango types can be mirrored inline with a comment citing the source file, prefer that. If you do add it, state so in a comment at the top of the file.
5. No ".js" extensions on relative imports.
6. Zero runtime side effects (no http calls, no fs reads at module load).

Write ONLY this one file.

When done, print exactly: SCHEMA_IMPL_COMPLETE`,
      verification: { type: 'output_contains', value: 'SCHEMA_IMPL_COMPLETE' },
      retries: 2,
    })

    .step('impl-records-client', {
      agent: 'records-client-impl',
      dependsOn: ['verify-notion-regression-fails'],
      task: `Write packages/web/lib/integrations/notion-records-client.ts — a thin Nango /records API wrapper with pagination.

## Spec
{{steps.spec.output}}

## Reference — slack proxy route (for auth + http + retry patterns)
{{steps.read-cloud-slack-proxy-route.output}}

## Hard requirements
1. Export async generator \`fetchNangoRecords(args): AsyncGenerator<NangoRecord>\` (or async iterable — either works; match what the handler needs).
2. Args shape: \`{ connectionId, providerConfigKey, model, syncName, modifiedAfter, nangoBaseUrl, nangoSecretKey, signal? }\`. The caller injects nangoSecretKey — the client NEVER reads \`process.env.NANGO_SECRET_KEY\` directly.
3. Pagination: follow cursor from \`next_cursor\` field until null. Use the same Nango records API shape that other integrations use — check the slack proxy or adapter source if unclear.
4. Retry: on 5xx only, max 3 attempts, exponential backoff (250ms → 500ms → 1s). No retry on 4xx. Respect the AbortSignal.
5. ZERO logging of records or Authorization. No \`console.log(records)\`, no \`logger.info({records})\`. Grep gate will verify.
6. No ".js" extensions on relative imports.
7. No http library dep — use native \`fetch\` (Node 20+).

Write ONLY this one file.

When done, print exactly: RECORDS_CLIENT_IMPL_COMPLETE`,
      verification: { type: 'output_contains', value: 'RECORDS_CLIENT_IMPL_COMPLETE' },
      retries: 2,
    })

    .step('impl-handler', {
      agent: 'handler-impl',
      dependsOn: ['impl-audit', 'impl-schema', 'impl-records-client'],
      task: `Write packages/web/lib/integrations/notion-ingest-handler.ts with BOTH handler entry points. The three upstream files (audit, schema, records-client) now exist — read them from disk yourself as needed.

## Spec
{{steps.spec.output}}

## Dependencies you can import from
- ./notion-ingest-audit (types + recordNotionIngest)
- ./notion-ingest-schema (Zod schemas + discriminateNotionEvent helper)
- ./notion-records-client (fetchNangoRecords async generator)
- @relayfile/adapter-notion (NotionAdapter class)
- @relayfile/sdk (RelayFileClient type)

## Hard requirements
1. Export \`handleNotionSyncNotification(args)\` with the exact signature from spec §4.
   - Fetches records via fetchNangoRecords async iterator
   - Per-record dispatch by model (NotionDatabase | NotionPage | NotionContentMetadata)
   - ADDED/UPDATED → adapter ingestion method
   - DELETED → drop with audit entry, increment deletesDropped counter, do not throw
   - try/catch EVERY per-record call, accumulate errors, never throw on per-record failures
   - Emits a NotionIngestAuditEntry at the end with { written, deleted, errors, durationMs }
   - workspaceId is a parameter — handler does NOT touch workspace_integrations
2. Export \`handleNotionBulkIngest(args)\` with the exact signature from spec §4.
   - One-shot delegation to adapter.bulkIngest(workspaceId)
   - Wraps in try/catch, emits audit entry with trigger: 'auth-creation'
   - Returns { filesWritten, errors }
3. Both functions are pure-ish — no workspace_integrations reads, no env var reads, everything injected.
4. No ".js" extensions on relative imports.
5. Model allow-list: exactly NotionDatabase, NotionPage, NotionContentMetadata. Unknown models → drop with audit entry 'unsupported_model'.

Write ONLY this one file.

When done, print exactly: HANDLER_IMPL_COMPLETE`,
      verification: { type: 'output_contains', value: 'HANDLER_IMPL_COMPLETE' },
      retries: 2,
    })

    .step('impl-router-update', {
      agent: 'router-impl',
      dependsOn: ['impl-handler'],
      task: `Update packages/web/lib/integrations/nango-webhook-router.ts — replace the existing \`case 'notion':\` no-op branch with a real implementation that dispatches to the handler.

## Spec
{{steps.spec.output}}

## Current router content
{{steps.read-cloud-webhook-router.output}}

## Workspace integration helper (for connectionId → workspaceId lookup)
{{steps.read-cloud-workspace-integrations-helper.output}}

## Hard requirements
1. Replace ONLY the \`case 'notion':\` branch. Do not touch any other case. Do not refactor the surrounding switch.
2. Parse the envelope via the schema helpers from ./notion-ingest-schema.
3. Resolve \`workspaceId\` from \`connectionId + providerConfigKey\` using the existing workspace integration helper. Match on providerConfigKey, not on the generic \`provider\` field.
4. Dispatch:
   - discriminateNotionEvent returns \`kind: 'sync'\` → instantiate NotionAdapter + records client, call handleNotionSyncNotification
   - discriminateNotionEvent returns \`kind: 'auth-creation'\` → call handleNotionBulkIngest (no records client needed for bulk path)
   - discriminateNotionEvent returns \`kind: 'ignore'\` → log and return, no ingest fires
5. On auth-creation path, implement the workspace-resolution race retry (spec §12 risk 4): 3 attempts, 250ms → 500ms → 1s backoff. If still unresolved, drop with audit entry \`workspace_unresolved_on_creation\`.
6. Any error → audit entry with outcome: 'failed' and a reason code. Always return 200 — webhook acceptance is separate from successful processing.
7. No ".js" extensions on relative imports.
8. Add imports at the top of the file for the new modules — do not duplicate existing imports.

Write ONLY the router edit. Do not create new files.

When done, print exactly: ROUTER_UPDATE_COMPLETE`,
      verification: { type: 'output_contains', value: 'ROUTER_UPDATE_COMPLETE' },
      retries: 2,
    })

    // ───────── Wave 4: Dashboard UI (parallel with Wave 3) ─────────

    .step('impl-ui', {
      agent: 'ui-impl',
      dependsOn: ['spec'],
      task: `Add the notion card to the integrations dashboard page, matching the existing slack pattern exactly.

## Spec
{{steps.spec.output}}

## Reference — SlackConnectionControls.tsx to mirror
{{steps.read-cloud-slack-controls.output}}

## Reference — dashboard-views.tsx (IntegrationsPageView location)
{{steps.read-cloud-dashboard-views.output}}

## Files to write

1. \`packages/web/app/dashboard/integrations/NotionConnectionControls.tsx\` — NEW.
   - Mirror SlackConnectionControls.tsx in structure, styling, error states, fetch calls.
   - Connect button hits \`/api/v1/workspaces/[workspaceId]/integrations/notion\` (the existing route).
   - Disconnect button same endpoint, DELETE method.
   - Use whatever hooks/stores the slack controls use.

2. \`packages/web/app/dashboard/_components/dashboard-views.tsx\` — UPDATE.
   - Add a Notion card inside \`IntegrationsPageView\`, alongside the existing Slack and GitHub cards.
   - Wrap the notion card in \`process.env.NEXT_PUBLIC_NOTION_ENABLED === 'true'\` — default off means the card is hidden.
   - Import \`NotionConnectionControls\` from the new file.
   - Do NOT modify the slack or github cards.
   - Do NOT reorder existing cards.

## Hard requirements
- No ".js" extensions on relative imports.
- Feature flag is \`NEXT_PUBLIC_NOTION_ENABLED\` exactly — spelling matters for the grep gate.
- UI is purely additive — diff on the slack card should be zero.

When done, print exactly: UI_IMPL_COMPLETE`,
      verification: { type: 'output_contains', value: 'UI_IMPL_COMPLETE' },
      retries: 2,
    })

    // ───────── Wave 5: Install + typecheck + test triplet ─────────

    .step('add-adapter-dep', {
      type: 'deterministic',
      command: `cd ${WORKTREE} && node -e "const fs = require('fs'); const path = 'packages/web/package.json'; const pkg = JSON.parse(fs.readFileSync(path, 'utf8')); pkg.dependencies ||= {}; pkg.dependencies['@relayfile/adapter-notion'] = 'file:../../../relayfile-adapters/packages/notion'; fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\\n'); console.log('DEP_ADDED');"`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['impl-router-update', 'impl-ui'],
    })

    .step('cloud-npm-install', {
      type: 'deterministic',
      command: `cd ${WORKTREE} && npm install --workspaces 2>&1 | tail -30`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['add-adapter-dep'],
    })

    // Typecheck and test-first-run are PEERS of each other — this is the key
    // structural difference from v5-03. If typecheck fails, test-first-run STILL
    // runs, and the test-fix agent gets visibility into BOTH problems.
    .step('cloud-typecheck', {
      type: 'deterministic',
      command: `cd ${WORKTREE} &&(npm run typecheck 2>&1 || true) | tail -40`,
      captureOutput: true,
      failOnError: false,
      dependsOn: ['cloud-npm-install'],
    })

    .step('cloud-test-first-run', {
      type: 'deterministic',
      // Uses ; not && so both runners execute regardless of first exit status
      command: `cd ${WORKTREE} &&(npx vitest run tests/slack-proxy-*.test.ts 2>&1 || true; echo "---"; npx tsx --test tests/github-clone-*.test.ts tests/github-tarball-walker.test.ts tests/notion-*.test.ts 2>&1 || true) | tail -80`,
      captureOutput: true,
      failOnError: false,
      dependsOn: ['cloud-npm-install'],
    })

    .step('cloud-test-fix', {
      agent: 'test-fixer',
      dependsOn: ['cloud-typecheck', 'cloud-test-first-run'],
      task: `Review the typecheck and test output below. If both are green, print NO_FIX_NEEDED and exit without touching files. Otherwise, fix the failures.

## Typecheck output
{{steps.cloud-typecheck.output}}

## Test output (vitest slack + tsx github + tsx notion)
{{steps.cloud-test-first-run.output}}

## Working directory
${WORKTREE} on branch ${BRANCH} (git worktree — main cloud checkout untouched)

## Fix scope
- Stale imports in notion-*.ts files
- Wrong exported names vs what the tests expect
- Typecheck errors in the handler or router (missing baseRevision, wrong generic types, etc.)
- Test expectations that drifted from the actual implementation
- Import-extension issues (\`.js\` on relative imports)
- Missing test fixtures
- Mock server route mismatches

## Do not
- Re-implement any production file from scratch — make surgical fixes only
- Skip or xfail any test
- Touch the adapter package in ../relayfile-adapters
- Touch ../sage or any other sibling repo
- Bump dependencies
- Modify slack-proxy or github-clone files unless the diff is strictly necessary to keep their tests green

When done, print exactly one of: CLOUD_TESTS_FIXED or NO_FIX_NEEDED`,
      verification: { type: 'output_contains', value: 'CLOUD_TESTS' },
      retries: 1,
    })

    .step('cloud-typecheck-rerun', {
      type: 'deterministic',
      command: `cd ${WORKTREE} && npm run typecheck 2>&1 | tail -20`,
      captureOutput: true,
      failOnError: true, // HARD GATE — typecheck must be clean after fix
      dependsOn: ['cloud-test-fix'],
    })

    .step('cloud-test-rerun', {
      type: 'deterministic',
      command: `cd ${WORKTREE} && npx vitest run tests/slack-proxy-*.test.ts 2>&1 | tail -15 && echo "---" && npx tsx --test tests/github-clone-*.test.ts tests/github-tarball-walker.test.ts tests/notion-*.test.ts 2>&1 | tail -25`,
      captureOutput: true,
      failOnError: true, // HARD GATE — all cloud tests must pass
      dependsOn: ['cloud-test-fix'],
    })

    // ───────── Wave 6: Global safety gates ─────────

    .step('verify-model-allow-list', {
      type: 'deterministic',
      command: `cd ${WORKTREE} && grep -q "NotionDatabase" packages/web/lib/integrations/notion-ingest-handler.ts && grep -q "NotionPage" packages/web/lib/integrations/notion-ingest-handler.ts && grep -q "NotionContentMetadata" packages/web/lib/integrations/notion-ingest-handler.ts && echo MODEL_ALLOW_LIST_OK`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['cloud-test-rerun'],
    })

    .step('verify-audit-no-pii', {
      type: 'deterministic',
      command: `cd ${WORKTREE} && if grep -E "records:|content:|properties:|payload:|title:|body:" packages/web/lib/integrations/notion-ingest-audit.ts; then echo AUDIT_LEAKS_PII; exit 1; else echo AUDIT_NO_PII_OK; fi`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['cloud-test-rerun'],
    })

    .step('verify-no-nango-secret', {
      type: 'deterministic',
      command: `cd ${WORKTREE} && if grep -rn "NANGO_SECRET_KEY" packages/web/lib/integrations/notion-*.ts 2>/dev/null; then echo LEAK_RISK; exit 1; else echo NO_HARDCODED_SECRET; fi`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['cloud-test-rerun'],
    })

    .step('verify-no-polling', {
      type: 'deterministic',
      command: `cd ${WORKTREE} && if grep -rnE "setInterval|setTimeout.*[0-9]+|\\bcron\\b" packages/web/lib/integrations/notion-*.ts 2>/dev/null; then echo POLLING_DETECTED; exit 1; else echo NO_POLLING_OK; fi`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['cloud-test-rerun'],
    })

    .step('verify-records-client-no-leak', {
      type: 'deterministic',
      command: `cd ${WORKTREE} && if grep -E "console\\.log.*records|logger\\..*records|Authorization.*\\\${" packages/web/lib/integrations/notion-records-client.ts 2>/dev/null; then echo RECORDS_LEAK_RISK; exit 1; else echo RECORDS_CLIENT_CLEAN; fi`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['cloud-test-rerun'],
    })

    .step('verify-feature-flag', {
      type: 'deterministic',
      command: `cd ${WORKTREE} && grep -q "NEXT_PUBLIC_NOTION_ENABLED" packages/web/app/dashboard/_components/dashboard-views.tsx && echo FEATURE_FLAG_OK`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['cloud-test-rerun'],
    })

    .step('verify-one-new-dep', {
      type: 'deterministic',
      command: `cd ${WORKTREE} && added=$(git diff ${BASE_BRANCH}..HEAD -- packages/web/package.json | grep -cE '^\\+.*"@relayfile/adapter-notion"') && [ "$added" = "1" ] && echo ONE_NEW_DEP_OK`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['cloud-test-rerun'],
    })

    .step('verify-router-not-noop', {
      type: 'deterministic',
      command: `cd ${WORKTREE} && if grep -q 'no cloud handler yet' packages/web/lib/integrations/nango-webhook-router.ts; then echo ROUTER_STILL_NOOP; exit 1; else echo ROUTER_UPDATED_OK; fi`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['cloud-test-rerun'],
    })

    // ───────── Wave 7a: Codex peer-review (before claude final-review) ─────────

    .step('peer-review', {
      agent: 'peer-reviewer',
      dependsOn: [
        'verify-model-allow-list',
        'verify-audit-no-pii',
        'verify-no-nango-secret',
        'verify-no-polling',
        'verify-records-client-no-leak',
        'verify-feature-flag',
        'verify-one-new-dep',
        'verify-router-not-noop',
      ],
      task: `You are the codex peer-reviewer. The safety gates passed and tests are green — now read the full diff and look for concerns that the grep-based gates cannot catch. Your review runs BEFORE the claude final-reviewer, so be direct and concrete.

## What to read

Run these from ${WORKTREE}:
  git diff --stat ${BASE_BRANCH}..HEAD -- packages/web/ tests/
  git diff ${BASE_BRANCH}..HEAD -- packages/web/lib/integrations/notion-ingest-handler.ts
  git diff ${BASE_BRANCH}..HEAD -- packages/web/lib/integrations/notion-records-client.ts
  git diff ${BASE_BRANCH}..HEAD -- packages/web/lib/integrations/nango-webhook-router.ts
  git diff ${BASE_BRANCH}..HEAD -- packages/web/lib/integrations/notion-ingest-schema.ts
  git diff ${BASE_BRANCH}..HEAD -- packages/web/lib/integrations/notion-ingest-audit.ts
  git diff ${BASE_BRANCH}..HEAD -- packages/web/app/dashboard/integrations/NotionConnectionControls.tsx
  git diff ${BASE_BRANCH}..HEAD -- packages/web/app/dashboard/_components/dashboard-views.tsx

## What to check (things a grep gate cannot catch)

1. **Logic bugs in the sync-notification handler**: off-by-one cursor pagination, missed iterations, try/catch swallowing errors silently, accidental await-in-loop that serializes parallel work, incorrect Map key collisions.
2. **Race conditions in auth-creation path**: is the retry loop exponential as spec says? Does it handle AbortSignal? Does it actually retry on missing row vs. throw on first miss?
3. **Adapter API misuse**: the handler should call \`adapter.ingestPage(workspaceId, record.id)\` — confirm the impl isn't accidentally re-fetching records that Nango already delivered, OR if it is, confirm that's the deliberate v5-06 choice (acceptable per spec §12 risk 2). Flag if the handler bypasses the adapter class and calls lower-level primitives.
4. **Schema drift**: the Zod schemas should match Nango's published webhook types. If the impl agent inlined type mirrors, confirm the comments cite the Nango source file.
5. **Unused exports or dead code** in any of the new files.
6. **Test coverage gaps**: are there test cases for empty batches, 4xx responses, malformed envelopes, provider mismatch (auth-creation event for a non-notion provider)?
7. **Drift from spec §10 final review criteria**: spec lists 9 criteria; walk through them and note any that look weak.
8. **PR body accuracy**: does commit-cloud's commit message accurately describe the shipped changes? Does the draft PR body's "Test plan" match the actual test evidence?
9. **Imports that shouldn't be there**: did the impl accidentally import from \`../sage\` or \`../relayfile-adapters\` directly (should only use \`@relayfile/adapter-notion\`)? Any \`.js\` extensions on relative imports?
10. **Feature flag correctness**: does the UI card actually get hidden when \`NEXT_PUBLIC_NOTION_ENABLED !== 'true'\`? Is the check on a client-visible env var (must be \`NEXT_PUBLIC_\`-prefixed at Next.js build time)?

## Output format

Two sections, in order:

### Findings
A bulleted list. Each finding cites \`file:line\` and quotes the offending snippet. If no findings, write "No concrete concerns found." — but only after actually reading the diffs, not a rubber stamp.

### Recommendation
Exactly one of:
  PEER_APPROVED
  PEER_APPROVED_WITH_CONCERNS: <one-line summary for the final reviewer>
  PEER_REJECTED: <one-line reason>

If you return PEER_APPROVED_WITH_CONCERNS, list the top 1-3 concerns in the Findings section so the claude final-reviewer knows what to weigh. A PEER_REJECTED means the claude reviewer will likely reject too — only use it when you find a concrete bug that would break production.

Do not modify any files. You are a reviewer, not a fixer.`,
      verification: { type: 'output_contains', value: 'PEER_' },
      retries: 1,
    })

    // ───────── Wave 7b: Claude final-review ─────────

    .step('final-review', {
      agent: 'lead',
      dependsOn: [
        'peer-review',
      ],
      task: `Perform the final review of v5-06. You are the claude lead, reviewing AFTER the codex peer-reviewer. Decide PORT_APPROVED or PORT_REJECTED.

## Codex peer-reviewer findings

{{steps.peer-review.output}}

Take these into account. If the peer-reviewer returned PEER_APPROVED_WITH_CONCERNS or PEER_REJECTED, you must either explicitly address each concern in your review (and decide if it's blocking) or escalate by matching the peer's verdict.

## What to check

Run these from ${WORKTREE}:
  git diff --stat ${BASE_BRANCH}..HEAD -- packages/web/ tests/
  git diff ${BASE_BRANCH}..HEAD -- packages/web/lib/integrations/nango-webhook-router.ts

## Safety gate outputs

{{steps.verify-model-allow-list.output}}
{{steps.verify-audit-no-pii.output}}
{{steps.verify-no-nango-secret.output}}
{{steps.verify-no-polling.output}}
{{steps.verify-records-client-no-leak.output}}
{{steps.verify-feature-flag.output}}
{{steps.verify-one-new-dep.output}}
{{steps.verify-router-not-noop.output}}

## Test rerun output
{{steps.cloud-test-rerun.output}}

## Approve only if ALL hold
1. All 8 safety gates printed OK.
2. Cloud test rerun shows: 31/31 slack proxy tests pass, 29 github clone tests pass with 3 skips, all new notion tests pass with zero skips.
3. Typecheck is clean (cloud-typecheck-rerun was a hard gate upstream).
4. Diff touches only packages/web/lib/integrations/notion-*.ts, nango-webhook-router.ts (notion branch only), app/dashboard/integrations/NotionConnectionControls.tsx, _components/dashboard-views.tsx (notion card only), package.json (one dep added), and tests/notion-*.ts + fixtures + helpers.
5. No stray edits in packages/core, infra, sst.config.ts, slack/github integration files.
6. No changes in ../sage, ../relayfile-adapters, ../workforce.
7. Adapter is consumed via @relayfile/adapter-notion import, not local files.
8. The three route-handler-pattern tests (the unit-level notion webhook router tests) pass cleanly — no skips.

## Reject if
- Any safety gate failed
- Any test was skipped without documented reason
- The handler touches workspace_integrations directly (router must own that)
- The records client reads NANGO_SECRET_KEY from env
- The UI card is not gated behind the feature flag
- Audit entry has any forbidden PII field

## Output
Write a two-paragraph review:
- Paragraph 1: what shipped (sync path, auth-creation path, UI card, test coverage)
- Paragraph 2: residual concerns for the reviewer to know about (delete-drop behavior, auth-creation race retry, feature flag default off, pre-merge dep bump requirement)

End with exactly one of:
  PORT_APPROVED
  PORT_REJECTED: <one-line reason>`,
      verification: { type: 'output_contains', value: 'PORT_' },
      retries: 1,
    })

    // ───────── Wave 8: Commit + push + open draft PR ─────────

    .step('commit-cloud', {
      type: 'deterministic',
      command: [
        `cd ${WORKTREE}`,
        `git add packages/web/ tests/`,
        `git status`,
        `git commit -m "feat(notion): wire up notion ingest via nango sync webhooks + auth-creation bulk" 2>&1`,
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
      dependsOn: ['final-review'],
    })

    .step('push-cloud', {
      type: 'deterministic',
      command: `cd ${WORKTREE} && git push -u origin ${BRANCH} 2>&1`,
      captureOutput: true,
      failOnError: true,
      dependsOn: ['commit-cloud'],
    })

    .step('open-cloud-pr', {
      type: 'deterministic',
      command: [
        `cd ${WORKTREE}`,
        `gh pr create --draft --repo AgentWorkforce/cloud --base ${BASE_BRANCH} --head ${BRANCH} --title "feat(notion): wire up notion ingest via nango sync webhooks + auth-creation bulk" --body "## Summary

Hooks @relayfile/adapter-notion into cloud so that scheduled Nango sync events from \\\`../sage/nango-integrations/notion\\\` flow into relayfile at the paths sage's \\\`relayfile-reader.ts\\\` already reads. Also adds a bulk-ingest trigger on the \\\`auth:creation\\\` event so a freshly-connected notion workspace is populated immediately instead of waiting up to an hour for the first scheduled sync.

### What this adds

- \\\`packages/web/lib/integrations/notion-ingest-handler.ts\\\` — two entry points: \\\`handleNotionSyncNotification\\\` (steady state via /records fetch) and \\\`handleNotionBulkIngest\\\` (cold start via adapter.bulkIngest)
- \\\`packages/web/lib/integrations/notion-records-client.ts\\\` — wraps Nango GET /records with cursor pagination, retry on 5xx, zero record/auth logging
- \\\`packages/web/lib/integrations/notion-ingest-audit.ts\\\` — PII-safe audit type, structural guard against payload fields in the interface
- \\\`packages/web/lib/integrations/notion-ingest-schema.ts\\\` — Zod schemas for Nango auth + sync envelopes and per-model record types
- \\\`packages/web/lib/integrations/nango-webhook-router.ts\\\` — replaces the \\\`case 'notion':\\\` no-op with real dispatch
- \\\`packages/web/app/dashboard/integrations/NotionConnectionControls.tsx\\\` — dashboard UI mirroring slack pattern
- \\\`packages/web/app/dashboard/_components/dashboard-views.tsx\\\` — notion card added to IntegrationsPageView behind \\\`NEXT_PUBLIC_NOTION_ENABLED\\\` feature flag
- 4 test files + 3 fixtures + 2 mock server helpers

### Architecture

Cloud never polls Nango on a schedule. Path A (steady state): Nango's scheduled sync POSTs a webhook notification to cloud → cloud calls Nango's \\\`/records\\\` API to fetch the actual records → writes via NotionAdapter. Path B (cold start): Nango connection creation fires an \\\`auth:creation\\\` webhook → cloud calls \\\`NotionAdapter.bulkIngest(workspaceId)\\\` once. Both paths converge on the same adapter-backed relayfile write path.

## MERGE BLOCKER

\\\`packages/web/package.json\\\` declares:

    \\\"@relayfile/adapter-notion\\\": \\\"file:../../../relayfile-adapters/packages/notion\\\"

This is a sibling file path — works locally but will break CI. **DO NOT MERGE** until:

1. \\\`cd ../relayfile-adapters/packages/notion && npm version minor && npm publish --access public\\\`
2. In THIS PR: change the package.json dep from \\\`file:...\\\` to the published version (e.g. \\\`\\\"^0.2.0\\\"\\\`)
3. Re-run cloud CI to confirm tests still pass against the published adapter
4. THEN merge

## Feature flag rollout

The notion dashboard card is hidden by default. To enable in production:
  NEXT_PUBLIC_NOTION_ENABLED=true

Recommend flipping this ONLY after the published adapter version is live AND at least one manual notion connection has been tested end-to-end.

## Residual risks (spec §12)

- DELETED records from Nango's /records API are dropped with an audit entry rather than deleted from relayfile. Next full sync overwrites stale rows, bounded by the 1h sync frequency. Acceptable for now; revisit if drift becomes visible.
- Auth-creation race: if cloud writes the workspace_integrations row AFTER the Nango connect call (rather than before), the router may receive the webhook before the row exists. Handler retries workspace resolution 3x with exponential backoff on the auth-creation path specifically.
- Nango sync webhook body contains only metadata (syncName, model, modifiedAfter, responseResults) — NOT the records themselves. Cloud fetches records separately via the /records API. This is well-documented in Nango's type definitions.

## Test plan

- [x] npm run typecheck — clean
- [x] npx vitest run tests/slack-proxy-*.test.ts — 31/31
- [x] npx tsx --test tests/github-clone-*.test.ts tests/github-tarball-walker.test.ts — 29 pass, 3 skip
- [x] npx tsx --test tests/notion-*.test.ts — new suites green
- [ ] post-publish: re-run against published adapter version

Generated from V5 refactor workflow (v5-06).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"`,
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
      dependsOn: ['push-cloud'],
    })

    .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
    .run({ cwd: process.cwd() });

  console.log('Workflow status:', result.status);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
