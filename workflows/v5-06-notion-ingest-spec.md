# V5-06 Spec — Hook Up Notion Ingest (Cloud side)

**Status:** Draft spec. Will become `workflows/v5-06-notion-ingest.ts` once approved.
**Pattern:** Follows `writing-agent-relay-workflows` + `relay-80-100-workflow` skills.
**Type:** Single-repo (cloud) integration glue + dashboard UI wiring.
**Dependency:** `@relayfile/adapter-notion@0.1.0` already exists at `../relayfile-adapters/packages/notion/`.

---

## 1. Goal

Wire `@relayfile/adapter-notion` into cloud so that:

1. Nango's notion sync events from `../sage/nango-integrations/notion` flow through cloud's webhook router and land in relayfile at `/notion/...` where sage's `relayfile-reader.ts` already knows how to read them.
2. The cloud `/dashboard/integrations` page shows a Notion section with Connect / Disconnect controls that match the existing slack/github UI pattern.
3. The ingest path is fully testable end-to-end without touching the real Notion API, mirroring the test strategy that worked for the slack proxy.

## 2. Non-goals

- **Do not modify `../sage/nango-integrations/notion`.** The sync scripts, models, and Nango integration config already exist and run on a schedule. Cloud consumes what they emit; cloud does not define or change them.
- **Do not write a bulk-ingest endpoint** like we did for github. Notion uses Nango sync → webhooks, not on-demand tarball pulls. There is no `POST /api/v1/notion/ingest` route in scope.
- **Do not handle Notion webhooks directly** (the Notion API webhook beta). All ingestion flows through Nango sync → cloud webhook router. Real Notion webhooks are out of scope.
- **Do not publish a new `@relayfile/adapter-notion` version.** Use `file:../../../relayfile-adapters/packages/notion` as the dep during workflow testing; the cloud PR body documents the pre-merge bump-to-published step.
- **Do not break existing slack or github integration UI** — dashboard surgery must be additive.

## 3. Context

### What exists today

- **Adapter (`@relayfile/adapter-notion` v0.1.0):** Full source at `../relayfile-adapters/packages/notion/src/`. Exports `NotionAdapter` (extends `IntegrationAdapter`, constructor takes `RelayFileClient` + optional `NotionConnectionProvider`), `bulkIngest(workspaceId)`, page/database/block/comment ingestion helpers, `computePath()`, `computeSemantics()`, and a `path-mapper` that knows the `/notion/...` VFS layout sage already reads.
- **Cloud providers registry:** `packages/web/lib/integrations/providers.ts` registers `"notion"` alongside `github` / `slack` / `linear`. UI dropdowns know about it.
- **Cloud integration setup route:** `app/api/v1/workspaces/[workspaceId]/integrations/notion/route.ts` is a 4-line stub using the generic `createIntegrationRouteHandlers("notion")` factory. It handles Nango connect/disconnect but does NOT trigger any ingest.
- **Cloud nango-webhook-router:** `packages/web/lib/integrations/nango-webhook-router.ts:592` has a `case "notion":` that logs `"Nango forward webhook received for provider with no cloud handler yet"` and returns. This is what we are replacing.
- **Sage nango-integrations/notion:** Three sync scripts — `content-metadata.ts` (every 1h, full sync), `fetch-databases.ts` (checkpoint-based), `fetch-pages.ts` (similar). They call `nango.batchSave(...)` / `batchDelete(...)` to emit records, and Nango POSTs those records to cloud's configured webhook URL.
- **Sage read path:** `sage/src/integrations/relayfile-reader.ts` has `readNotionPage(pageId)`, `NOTION_ROOT = '/notion'`, and path builders for standalone pages + database-scoped pages. Sage expects files at `/notion/pages/<pageId>.json` + `/notion/pages/<pageId>/content.md` (the "standalone" layout) or `/notion/databases/<databaseId>/pages/<pageId>.json` etc. — `relayfile-reader.ts:281-286, 670-690`.
- **Cloud dashboard:** `packages/web/app/dashboard/integrations/page.tsx` renders `<IntegrationsPageView />` from `../_components/dashboard-views.tsx`. Slack already has a `SlackConnectionControls.tsx` at `dashboard/integrations/SlackConnectionControls.tsx`.

### What is missing

1. **Sync record → relayfile write path.** When Nango POSTs a sync payload shaped like `{ type: 'sync', model, providerConfigKey, connectionId, records }`, nothing in cloud maps those records to adapter ingestion calls.
2. **`@relayfile/adapter-notion` is not a cloud dependency.** `packages/web/package.json` has no entry for it.
3. **Notion dashboard card** does not exist — no `NotionConnectionControls.tsx`, no notion card in `IntegrationsPageView`.
4. **End-to-end test coverage** for the ingest path is zero. There is no fixture for a Nango notion sync payload, no mock relayfile that verifies the adapter wrote the expected paths, no unit tests for the webhook handler's notion branch.
5. **Cloud slack_proxy_audit-style audit** for notion ingests does not exist. (Optional — see section 6.)

## 4. Architecture

Two trigger paths converge on the same adapter-backed write path. Both are **webhook-initiated** — cloud never polls Nango on a schedule. Nango itself polls Notion (that's what the "every 1h" frequency in sage's sync config does); cloud only reacts to Nango's push events.

### Path A — Scheduled sync (steady-state content refresh)

```
  Notion API
     │
     ▼  every 1h (Nango sync schedule from sage/nango-integrations/notion)
  Nango runs the sync → collects changed pages/databases → persists records internally
     │   responseResults: { added: N, updated: M, deleted: K }
     ▼  HTTPS POST to cloud webhook URL
  Cloud /api/v1/webhooks/nango/route.ts  ← already exists, generic parser
     │   parses envelope, routes by type + provider
     ▼
  lib/integrations/nango-webhook-router.ts :: case 'notion', type 'sync'
     │   resolves connectionId + providerConfigKey → workspaceId via existing helper
     ▼
  lib/integrations/notion-ingest-handler.ts :: handleNotionSyncNotification()
     │   IMPORTANT: the sync webhook body does NOT carry records. It carries a
     │   notification: { syncName, model, modifiedAfter, responseResults }.
     │   To get the actual records, the handler calls Nango's /records API.
     ▼
  lib/integrations/notion-records-client.ts  ← NEW
     │   GET https://api.nango.dev/records?model=...&sync_name=...&modified_after=...
     │   with connectionId + providerConfigKey + Authorization: Bearer NANGO_SECRET_KEY
     │   Paginates through cursor-based responses.
     ▼  returns [{ ...record, _nango_metadata: { last_action: 'ADDED'|'UPDATED'|'DELETED' } }, ...]
  handleNotionSyncNotification (continued)
     │   per-record:
     │     - ADDED/UPDATED → NotionAdapter.ingestPage / ingestDatabase / ingestContentMetadata
     │     - DELETED → drop with audit entry 'delete-dropped' (see §12 risk 5) OR
     │                  adapter.deleteByPath(computePathFromId(model, id)) if the adapter exposes it
     │   emits PII-safe audit entry with { action, model, count, errorCount, durationMs }
     ▼
  RelayFile VFS at /notion/pages/*, /notion/databases/*, /notion/pages/*/content.md
     │
     ▼  reads
  Sage :: relayfile-reader.readNotionPage(pageId)
```

### Path B — Bulk ingest on first connection (cold-start UX fix)

Nango's scheduled sync runs every 1h. A brand-new notion connection would sit empty for up to an hour before any content appeared in relayfile. To avoid that dead window, cloud listens for the `type: 'auth', operation: 'creation'` event Nango fires the moment a workspace completes OAuth:

```
User completes Notion OAuth in cloud dashboard
     │
     ▼
  Nango creates connection → POSTs auth webhook to cloud
     │   { type: 'auth', operation: 'creation', provider, providerConfigKey, connectionId, endUser }
     ▼
  Cloud /api/v1/webhooks/nango/route.ts
     ▼
  lib/integrations/nango-webhook-router.ts :: case 'notion', type 'auth', operation 'creation'
     │   resolves workspaceId (may need to match on endUser.endUserId if the
     │   workspace_integrations row isn't written until *after* this event fires —
     │   the router handles the race by deferring bulk ingest behind a small delay
     │   or by reading endUser tags for workspaceId)
     ▼
  lib/integrations/notion-ingest-handler.ts :: handleNotionBulkIngest()
     │   instantiates NotionAdapter with injected RelayFileClient + NangoProvider
     │   calls adapter.bulkIngest(workspaceId)
     │   emits PII-safe audit entry with { trigger: 'auth-creation', filesWritten, durationMs }
     ▼
  RelayFile VFS (fully populated from the start)
```

### Key architectural decisions

- **No polling in cloud.** Nango runs the syncs; cloud is webhook-consumer only. The only "fetching" cloud does is calling Nango's `/records` API *in response to* a webhook notification — a pull-in-response-to-push, not a polling loop.
- **Idempotent writes.** Every record carries a `last_edited_time` from Notion. The handler writes unconditionally; the adapter's `writeFile` uses CAS via `baseRevision` (same pattern as the github clone orchestrator).
- **Connection resolution via `workspace_integrations`.** The webhook envelope has `connectionId` + `providerConfigKey`; the router looks up the matching row in `workspace_integrations` to get `workspaceId`, same pattern the slack proxy uses. **Match on `providerConfigKey` not `provider`** — the config key is environment-scoped (`notion-stage` vs `notion-prod`), the provider is generic.
- **Partial-failure tolerance.** One bad record in a batch does not abort the whole batch. Each record is try/catch-wrapped and accumulates a per-path error list for the audit entry.
- **Two handler entry points, one adapter.** `handleNotionSyncNotification` (steady state) and `handleNotionBulkIngest` (cold start) both delegate to `NotionAdapter` for the actual writes. Split at the I/O boundary (records fetch vs bulk walk) but converge on the same relayfile write path.
- **Test uses in-process mock Nango server + mock relayfile server**, not real Notion. Zero external network calls at test time. Mock Nango must handle BOTH the `/records` endpoint (for path A) AND the webhook POST endpoint (inbound simulation for both paths).

## 5. Deliverables

### 5a. Product code (cloud)

| File | Change | Purpose |
|---|---|---|
| `packages/web/package.json` | ADD dep | `"@relayfile/adapter-notion": "file:../../../relayfile-adapters/packages/notion"` (placeholder for published version pre-merge) |
| `packages/web/lib/integrations/notion-records-client.ts` | NEW | Wraps Nango's `GET /records` endpoint. Exports `fetchNangoRecords({ connectionId, providerConfigKey, model, syncName, modifiedAfter, nangoBaseUrl, nangoSecretKey, signal? }) → AsyncIterable<NangoRecord>`. Paginates via cursor. **Never logs the records themselves or the Authorization header.** Uses cloud's existing Nango env resolver for `nangoSecretKey` — the handler does not read it directly. |
| `packages/web/lib/integrations/notion-ingest-handler.ts` | NEW | Two exported functions (split at the I/O boundary): <br/>• `handleNotionSyncNotification({ workspaceId, relayfile, adapter, recordsClient, model, syncName, modifiedAfter }) → { written, deleted, errors }` — fetches records via `recordsClient`, iterates, dispatches per-record to the adapter, accumulates errors per path, never throws on per-record failures. <br/>• `handleNotionBulkIngest({ workspaceId, relayfile, adapter }) → { filesWritten, errors }` — one-shot delegation to `adapter.bulkIngest(workspaceId)`. <br/>Neither function touches `workspace_integrations` — workspaceId is resolved by the caller (the router). |
| `packages/web/lib/integrations/notion-ingest-audit.ts` | NEW | Typed `NotionIngestAuditEntry` interface with **zero payload fields** — PII-safe per the slack proxy pattern. Allowed fields: `workspaceId`, `connectionId`, `providerConfigKey`, `trigger: 'sync' \| 'auth-creation'`, `syncName?`, `model?`, `filesWritten`, `deletesDropped`, `errorCount`, `durationMs`, `outcome`. Forbidden fields (must NOT appear in the interface): `records`, `content`, `properties`, `payload`, `title`, `body`. Exports `recordNotionIngest(entry)` via whatever logger the slack proxy audit uses (match the existing pattern — do not invent a new logger path). |
| `packages/web/lib/integrations/notion-ingest-schema.ts` | NEW | Zod schemas for: <br/>• The Nango webhook envelope type discriminator (`auth` vs `sync`) <br/>• The `auth` creation event payload (`{ type: 'auth', operation: 'creation', provider, providerConfigKey, connectionId, endUser?, ... }`) <br/>• The `sync` notification event payload (`{ type: 'sync', syncName, model, providerConfigKey, connectionId, modifiedAfter, responseResults: { added, updated, deleted } }`) <br/>• Per-model record schemas (`NotionDatabase`, `NotionPage`, `NotionContentMetadata`) derived from Nango's published webhook types (import from `nango` package types via `import type { NangoWebhookBody } from 'nango'` if available; if not, add `nango` as a devDependency of packages/web or mirror the relevant type aliases inline with a citation comment). |
| `packages/web/lib/integrations/nango-webhook-router.ts` | UPDATE | Replace the existing `case 'notion':` stub with a branch that: <br/>1. Parses the envelope via `notion-ingest-schema`. <br/>2. Resolves `workspaceId` from `{ connectionId, providerConfigKey }` using the existing workspace integration helper (match on `providerConfigKey`, not `provider`). <br/>3. If the envelope is `{ type: 'sync' }` → instantiates the adapter + records client and calls `handleNotionSyncNotification`. <br/>4. If the envelope is `{ type: 'auth', operation: 'creation' }` AND the `providerConfigKey` resolves to a notion row in `workspace_integrations` → calls `handleNotionBulkIngest`. <br/>5. Emits a `NotionIngestAuditEntry` after either path completes. <br/>6. Other auth operations (`refresh`, `update`, `deletion`) fall through to existing behavior. |

### 5b. Dashboard UI (cloud)

| File | Change | Purpose |
|---|---|---|
| `packages/web/app/dashboard/integrations/NotionConnectionControls.tsx` | NEW | Mirror `SlackConnectionControls.tsx` — Connect / Disconnect buttons using `useSession` + `/api/v1/workspaces/[id]/integrations/notion` route. |
| `packages/web/app/dashboard/_components/dashboard-views.tsx` | UPDATE | In `IntegrationsPageView`, add a Notion card alongside the existing Slack / GitHub cards. Reuse existing card layout. Hidden if `NEXT_PUBLIC_NOTION_ENABLED !== 'true'` (safe default false; flip during rollout). |
| `packages/web/app/dashboard/integrations/notion/page.tsx` | NEW (optional) | If the slack integration has a detail subpage, mirror it for notion. Otherwise skip. |

### 5c. Tests

| File | Type | Target |
|---|---|---|
| `tests/notion-ingest-handler.test.ts` | `node:test` + `tsx` | Exercises BOTH handler functions: <br/>• `handleNotionSyncNotification` — uses a mock `recordsClient` that returns a canned `AsyncIterable<NangoRecord>`, asserts every expected path is written via mock relayfile, errors accumulate without aborting, idempotent on second call. <br/>• `handleNotionBulkIngest` — stubs `NotionAdapter.bulkIngest` and asserts it's called with the right workspaceId and the audit entry records `trigger: 'auth-creation'`. <br/>Covers: all 3 supported models on the sync path, `DELETED` action drops with audit entry not throw, empty batch is a no-op, adapter exception on one record doesn't abort the rest. |
| `tests/notion-records-client.test.ts` | `node:test` + `tsx` | Unit tests for `fetchNangoRecords`. Uses the mock Nango server (new endpoint `/records`). Asserts: pagination follows cursors, Authorization header is Bearer + the secret, `model` + `modified_after` query params are set, retries on 5xx, never logs records or Authorization. Does NOT exercise the handler — pure client-side unit test. |
| `tests/notion-ingest-audit.test.ts` | `node:test` + `tsx` | Structural/compile test. Asserts the `NotionIngestAuditEntry` interface has the expected allowed fields and does NOT have any of the forbidden fields (`records`, `content`, `properties`, `payload`, `title`, `body`). Implemented as a type-level assertion using a negative-match helper so the test fails at compile time if the interface drifts. |
| `tests/notion-webhook-router.test.ts` | `node:test` + `tsx` | Integration test that posts fixture webhook bodies at the updated router and asserts the correct handler function is called, with the correct arguments, for each of: <br/>• `type: 'sync'` notion notification → `handleNotionSyncNotification` <br/>• `type: 'auth', operation: 'creation'` notion → `handleNotionBulkIngest` <br/>• `type: 'auth', operation: 'creation'` github → falls through (not notion, unchanged existing behavior) <br/>• `type: 'auth', operation: 'refresh'` notion → falls through (unchanged existing behavior; no ingest fires on refresh) <br/>• Unknown model on sync → rejects with `unsupported_model` audit and 400 response |
| `tests/fixtures/notion/sync-notification.json` | fixture | A Nango webhook envelope body with `type: 'sync'` for notion. Derived from Nango's webhook type definitions — the impl agent resolves the exact shape from `node_modules/nango` (or `@nangohq/node`) and uses those types to author this fixture. No runtime records inside — just the notification metadata. |
| `tests/fixtures/notion/auth-creation.json` | fixture | A Nango `type: 'auth', operation: 'creation'` body for a notion connection. The impl agent derives the shape from the same Nango types plus the example the user shared in spec review. |
| `tests/fixtures/notion/records-response.json` | fixture | A canned Nango `/records` API response containing: 1 `NotionDatabase` + 2 `NotionPage` + 1 `NotionContentMetadata` + 1 record with `_nango_metadata.last_action = 'DELETED'`. Cursor terminator `null` so pagination ends in one page. |
| `tests/helpers/mock-nango-webhook-poster.ts` | helper | Tiny http helper that POSTs a fixture body at cloud's webhook route URL with the Nango webhook signing header. |
| `tests/helpers/mock-nango-server.ts` | helper | Expands the existing mock-nango-proxy-server (from the github clone test helpers) to ALSO handle `GET /records`. When queried with `{ model, sync_name, modified_after }`, returns the canned `records-response.json` fixture. Cleanly shut-downable. |
| `tests/helpers/mock-relayfile-server.ts` | helper | REUSE the existing mock relayfile server. No changes needed — the notion write paths fit the existing API surface. |

### 5d. Seed + E2E (optional for v5-06; strongly recommended follow-up)

Extend `scripts/e2e/seed.sh` to add a `workspace_integrations` row for `provider='notion'` so the full docker compose E2E can drive a notion sync webhook through the stack. Not blocking for v5-06 merge.

## 6. Hard invariants

These are the grep-verifiable gates the workflow's final-review step will check literally.

1. **Closed model allow-list.** The handler accepts only `NotionDatabase`, `NotionPage`, `NotionContentMetadata` — the three models sage's current syncs actually emit (`fetch-databases.ts`, `fetch-pages.ts`, `content-metadata.ts`). Any other model → rejected with audit entry `unsupported_model` and a 200 response (webhook accepted, not acted on). If sage later adds a sync for comments or blocks, the impl agent extends this allow-list as a follow-up, not speculatively.
2. **Payload never logged.** `notion-ingest-audit.ts`'s `NotionIngestAuditEntry` interface MUST NOT have `records`, `content`, `properties`, `payload`, `title`, or `body` fields. TypeScript-enforced structural PII guard — test asserts this at compile time.
3. **Workspace resolution via canonical helper.** Connection-to-workspace lookup uses cloud's existing workspace integration helper, matching on `providerConfigKey` (environment-scoped), not on the generic `provider` field. Same pattern the slack proxy uses.
4. **Partial-failure tolerance.** Both handler entry points wrap every per-record call in try/catch, accumulate errors, and never throw on per-record failures. Unit tests prove this for both `handleNotionSyncNotification` and `handleNotionBulkIngest`.
5. **Idempotent writes.** Every `writeFile` call passes `baseRevision` (current revision or `"0"` on new). No bare `writeFile` without baseRevision — same pattern as the github clone orchestrator post-fix.
6. **No raw `NANGO_SECRET_KEY` read in `notion-*.ts` files.** The secret flows through cloud's existing Nango env resolver via dependency injection, the same way the slack proxy gets it. Grep gate: `grep -rn 'NANGO_SECRET_KEY' packages/web/lib/integrations/notion-*.ts` returns nothing.
7. **No polling on a schedule from cloud.** Cloud never starts a background interval / cron / setTimeout loop that calls Nango. The only network calls out of cloud-side notion code are: (a) `fetchNangoRecords` in response to a sync webhook, and (b) adapter API calls inside `bulkIngest`. Grep gate checks for `setInterval\|setTimeout\|cron` in `notion-*.ts` and fails if found.
8. **Records client never logs records or Authorization header.** `notion-records-client.ts` has no `console.log`, `logger.info`, or audit entry that includes the records array or the Authorization header value. Grep gate ensures neither appears in the records-client file.
9. **Feature flag gates UI.** Notion card in `IntegrationsPageView` is wrapped in `NEXT_PUBLIC_NOTION_ENABLED === 'true'` check. Default off. Slack and github cards unaffected.
10. **One and only one new runtime dep in packages/web/package.json.** Only `@relayfile/adapter-notion` added. If the impl agent needs Nango types and chooses to add `nango` as a devDependency, that's acceptable (doesn't count against this invariant — dev-only). Grep gate: `git diff main..HEAD -- packages/web/package.json` shows exactly one `+.*"@relayfile/adapter-notion"` line in the `dependencies` block.
11. **No changes outside cloud.** No edits to `../sage`, `../relayfile-adapters`, `../workforce`, or anywhere else. The workflow agent operates only on files under `${CLOUD}/`. Grep gate: `git diff main..HEAD` outside the cloud repo returns nothing (verified via a repo-boundary check).
12. **Slack and github integration tests stay green.** The cloud test rerun wave runs the full vitest + tsx suite, including the 31 slack proxy tests and the 29 passing + 3 skipped github clone tests, and all of them must still pass exactly as baseline.
13. **Webhook router notion branch is no longer a no-op.** Grep gate: `grep 'no cloud handler yet' packages/web/lib/integrations/nango-webhook-router.ts` returns nothing.

## 7. Test strategy (80-to-100)

The v5-03 autonomous run shipped broken tests because the test-first-run → fix → rerun triplet never executed (typecheck was an upstream dep and blocked everything). This workflow MUST avoid that shape.

### Key structural fixes over v5-03

- **Typecheck is a PEER of the test triplet, not an upstream dependency.** Both typecheck and test-first-run run in parallel after the impl wave, both depend on impl but not on each other. If typecheck fails, the test triplet still runs (and will probably also fail, but informatively). Neither blocks the test-fix step.
- **Test-fix agent always runs** even when first-run was green — it becomes a no-op that prints `NO_FIX_NEEDED`. That way test-rerun always has a clean upstream.
- **Hard gate is ONLY on test-rerun** with `failOnError: true`. If rerun passes, the wave is green.
- **Regression tests are authored in a separate wave BEFORE any implementation** and a `verify-regression-fails` gate proves they fail against pre-impl code.
- **Pre-read large files deterministically and inject via `{{steps.X.output}}`** so the impl agent doesn't have to discover sources. This avoids interactive-agent PTY pollution on stdout chaining.

### Coverage targets

- Unit tests on `handleNotionSyncBatch` with a real mock relayfile — every one of the 4 supported models has at least one passing case and one error case.
- Structural test that `NotionIngestAuditEntry` doesn't have PII fields.
- A contract test that round-trips a fixture Nango payload through the full handler path: webhook router → parse → resolve workspaceId → adapter ingest → mock relayfile receives expected write batch.
- Existing slack proxy tests (`tests/slack-proxy-*.test.ts`, 31 tests) and github clone tests (`tests/github-clone-*.test.ts`, 29 passing + 3 skipped) must stay green — the final wave's cloud-test-rerun runs ALL cloud tests, not just notion.

## 8. Wave plan

Mirrors v5-05's shape but single-repo. Target timeout: 75 min.

**Wave 0 — Preflight (deterministic)**
- `check-cloud-clean` — current branch has no uncommitted product changes
- `check-adapter-package-exists` — `../relayfile-adapters/packages/notion/package.json` present
- `branch-cloud` — create `refactor/notion-ingest-hookup` off the current base branch
- `read-adapter-index` — cat `../relayfile-adapters/packages/notion/src/index.ts`
- `read-adapter-class` — cat `../relayfile-adapters/packages/notion/src/adapter.ts`
- `read-adapter-sync` — cat `../relayfile-adapters/packages/notion/src/sync.ts` (for the buildSyncFilterPayload helper and any existing sync types)
- `read-sage-notion-models` — cat `../sage/nango-integrations/models.ts` to learn exact zod shapes for `NotionDatabase`, `NotionPage`, `NotionContentMetadata`
- `read-sage-notion-sync-content` — cat `../sage/nango-integrations/notion/syncs/content-metadata.ts` (frequency, model, schema reference)
- `read-sage-notion-sync-databases` — cat `../sage/nango-integrations/notion/syncs/fetch-databases.ts`
- `read-sage-notion-sync-pages` — cat `../sage/nango-integrations/notion/syncs/fetch-pages.ts`
- `read-nango-webhook-types` — check for Nango's webhook envelope types. Try in this order: (a) `find ../sage/nango-integrations/node_modules/nango -name "*.d.ts" | xargs grep -l -E "WebhookBody|NangoWebhook"`, (b) `find ../relayfile-adapters -name "*.d.ts" | xargs grep -l -E "WebhookBody|NangoWebhook"`, (c) fall back to reading Nango docs text via a web fetch. Whichever succeeds first, cat the matching file so the impl agent has the exact type definitions. If none of the three work, emit a clear error: `NANGO_TYPES_UNRESOLVED` and fail the wave — the impl agent cannot author a correct webhook parser without a canonical type reference.
- `read-cloud-webhook-router` — cat `packages/web/lib/integrations/nango-webhook-router.ts` (need the surrounding structure)
- `read-cloud-workspace-integration-helper` — find and cat whichever helper the slack proxy uses to resolve `connectionId + providerConfigKey → workspaceId`. Start by grepping `packages/web/lib/integrations/slack-proxy-*.ts` for calls to helpers ending in `Integration` or `WorkspaceIntegration`, then cat the resolved source file.
- `read-cloud-slack-audit` — cat `packages/web/lib/integrations/slack-proxy-audit.ts` (reuse its PII-safe pattern exactly)
- `read-cloud-slack-connection-controls` — cat `packages/web/app/dashboard/integrations/SlackConnectionControls.tsx` (mirror its UI shape)
- `read-cloud-dashboard-views` — cat `packages/web/app/dashboard/_components/dashboard-views.tsx` (IntegrationsPageView definition + its current card layout)
- `read-cloud-mock-relayfile-helper` — cat `tests/helpers/mock-relayfile-server.ts`
- `read-cloud-mock-nango-helper` — cat `tests/helpers/mock-nango-proxy-server.ts` (the helper used by github clone tests — the notion mock Nango server will be an extension of this, adding a `/records` endpoint)

**Wave 1 — Spec refinement (claude lead)**
- `spec` agent step — claude lead reads all of Wave 0's captured output and produces a detailed impl spec: exact file paths, exact exported symbols, exact audit shape, exact test cases. This is NOT designing — it's translating section 5 of this document into concrete code targets. Output ends with `SPEC_COMPLETE`. Note: task body must NOT enumerate downstream step names to avoid the deadlock validator (same bug v5-01/v5-03 originally had).

**Wave 2 — Regression tests (codex worker)**
- `write-notion-regression-tests` — codex worker writes the 2 new test files + the fixture payload + the mock-nango-webhook-poster helper. Tests must be structurally runnable with node:test via tsx but FAIL on execution because `notion-ingest-handler.ts` doesn't exist yet.
- `verify-notion-regression-fails` — deterministic step runs the new tests, captures output (expected: `ERR_MODULE_NOT_FOUND` or similar), `failOnError: false`. Pass-through.

**Wave 3 — Backend implementation (codex workers)**
- `impl-audit` — writes `notion-ingest-audit.ts` (PII-safe type + recorder). Depends on `verify-notion-regression-fails`. Spec injected via template.
- `impl-schema` — writes `notion-ingest-schema.ts` (Zod schemas for auth + sync envelopes + per-model records derived from Nango types + sage's zod models). Depends on `verify-notion-regression-fails`.
- `impl-records-client` — writes `notion-records-client.ts` (`fetchNangoRecords` async iterator + pagination). Depends on `verify-notion-regression-fails`. Parallel with audit + schema.
- `impl-handler` — writes `notion-ingest-handler.ts` with both `handleNotionSyncNotification` and `handleNotionBulkIngest`. **DAG-depends on `impl-audit` + `impl-schema` + `impl-records-client`** (waits for files to exist on disk). The handler agent reads the three files from disk itself — no `{{steps.X.output}}` chaining from agent steps per the 80-to-100 skill's "never chain from interactive agents" rule.
- `impl-router-update` — updates `nango-webhook-router.ts` case `'notion'` branch. DAG-depends on `impl-handler`. The router owns workspace_integrations resolution and branches on `type`:
  - `type: 'sync'` → instantiate `NotionAdapter` + records client, call `handleNotionSyncNotification`
  - `type: 'auth', operation: 'creation'` → call `handleNotionBulkIngest`
  - `type: 'auth', operation: 'refresh' | 'update' | 'deletion'` → fall through (unchanged existing behavior)
  - unknown → emit audit entry `unknown_nango_event` and return 200 (cloud accepts but doesn't act on unknown envelopes)

**Wave 4 — Dashboard UI (codex worker)**
- `impl-notion-controls` — writes `NotionConnectionControls.tsx` mirroring `SlackConnectionControls.tsx`. Depends on `spec` + `read-cloud-slack-connection-controls` (to match the style). NOT dependent on regression tests or backend impls — UI has no test coverage in this PR and can run in parallel with Wave 3.
- `impl-integrations-card` — updates `dashboard-views.tsx` to add notion card behind `NEXT_PUBLIC_NOTION_ENABLED`. Depends on `spec` + `read-cloud-dashboard-views`. Parallel with Wave 3.

**Wave 5 — Cloud install + typecheck + test triplet**
- `cloud-npm-install` — runs `npm install --workspaces` to wire up the file: dep for @relayfile/adapter-notion
- `cloud-typecheck` — runs `npm run typecheck`, `failOnError: true`, PARALLEL with test-first-run (not upstream of it)
- `cloud-test-first-run` — runs `(npx vitest run tests/slack-proxy-*.test.ts 2>&1 || true; echo "---"; npx tsx --test tests/github-clone-*.test.ts tests/notion-*.test.ts 2>&1 || true) | tail -80`, `failOnError: false`. Uses `;` not `&&` so both runners execute regardless of the first's exit status, and both outputs are captured for the test-fix agent to diagnose.
- `cloud-test-fix` — codex worker fixes anything broken; prints `NO_FIX_NEEDED` if already green
- `cloud-test-rerun` — reruns same command, `failOnError: true` — HARD GATE

Both `cloud-typecheck` and `cloud-test-first-run` depend on Waves 3 + 4's impls. `cloud-test-fix` depends on both. `cloud-test-rerun` depends on `cloud-test-fix`.

**Wave 6 — Safety gates (deterministic grep)**
All depend on `cloud-test-rerun`. All `failOnError: true`.

- `verify-model-allow-list` — grep handler for `'NotionDatabase'`, `'NotionPage'`, `'NotionContentMetadata'`, `'NotionComment'` allow-list
- `verify-audit-no-pii` — grep `notion-ingest-audit.ts` for forbidden fields (`records|content|properties|payload`), must find none
- `verify-base-revision` — grep handler for `baseRevision:`
- `verify-no-nango-secret-read` — grep handler files for `NANGO_SECRET_KEY`, must find none
- `verify-feature-flag` — grep `dashboard-views.tsx` for `NEXT_PUBLIC_NOTION_ENABLED`
- `verify-single-new-dep` — `git diff main..HEAD -- packages/web/package.json` must show exactly one added dep
- `verify-sage-untouched` — `git diff main..HEAD -- ../sage/` returns nothing (workflow scoped to cloud only; but since we're in cloud repo, this just verifies no stray `../sage` paths in the diff)

**Wave 7 — Final review (claude lead)**
- `final-review` — claude reads the full diff, verifies all 10 hard invariants, signs off `PORT_APPROVED` or rejects `PORT_REJECTED: <reason>`. Depends on all Wave 6 gates.

**Wave 8 — Commit, push, open draft PR (deterministic)**
- `commit-cloud` — `git add packages/web/ tests/ && git commit -m "feat(notion): wire up notion ingest via nango sync webhooks"`
- `push-cloud` — `git push -u origin refactor/notion-ingest-hookup`
- `open-cloud-pr` — `gh pr create --draft` with a body that lists the merge blocker (bump `@relayfile/adapter-notion` from file: to published version before merge), the 10 invariants checked, test evidence, and the feature flag rollout plan

## 9. Safety gates (literal grep patterns)

Copy these verbatim into the workflow's Wave 6 deterministic steps:

```bash
# 1. Model allow-list (exactly the 3 models sage currently syncs — not speculative)
grep -q "NotionDatabase" packages/web/lib/integrations/notion-ingest-handler.ts
grep -q "NotionPage" packages/web/lib/integrations/notion-ingest-handler.ts
grep -q "NotionContentMetadata" packages/web/lib/integrations/notion-ingest-handler.ts

# 2. Audit entry has no PII fields. Use literal substrings per feedback_bsd_grep_verify_gates.
! grep -E "records:|content:|properties:|payload:|title:|body:" packages/web/lib/integrations/notion-ingest-audit.ts

# 3. baseRevision passed to every writeFile. Adapter handles this internally, so this
#    check applies only if the handler directly calls relayfile.writeFile (unlikely,
#    but defended). If there are no direct writeFile calls in the handler, this is
#    vacuously true.
if grep -q "writeFile(" packages/web/lib/integrations/notion-ingest-handler.ts; then
  [ "$(grep -c 'baseRevision:' packages/web/lib/integrations/notion-ingest-handler.ts)" -ge "$(grep -c 'writeFile(' packages/web/lib/integrations/notion-ingest-handler.ts)" ]
fi

# 4. No raw Nango secret read in any notion-*.ts file
! grep -rn "NANGO_SECRET_KEY" packages/web/lib/integrations/notion-*.ts

# 5. No polling loops in any notion-*.ts file
! grep -rnE "setInterval|setTimeout|\\bcron\\b" packages/web/lib/integrations/notion-*.ts

# 6. Records client never logs records or Authorization
! grep -E "console\\.log.*records|logger\\..*records|Authorization.*\\$\\{" packages/web/lib/integrations/notion-records-client.ts

# 7. Feature flag on the UI card
grep -q "NEXT_PUBLIC_NOTION_ENABLED" packages/web/app/dashboard/_components/dashboard-views.tsx

# 8. Exactly one new runtime dep in dependencies block (adapter-notion). A devDep
#    for `nango` is acceptable and doesn't count.
[ "$(git diff main..HEAD -- packages/web/package.json | grep -cE '^\\+.*\"@relayfile/adapter-notion\"')" = "1" ]

# 9. Webhook router notion branch is not a no-op anymore
! grep -q 'no cloud handler yet' packages/web/lib/integrations/nango-webhook-router.ts

# 10. No changes outside cloud (repo-boundary defense)
[ -z "$(git diff main..HEAD --name-only | grep -E '^\\.\\./')" ]
```

Per the `bsd_grep_verify_gates` feedback rule, all patterns use literal substrings or POSIX character classes. No `\s` metacharacters in BSD-grep sensitive contexts.

## 10. Final review criteria

The final-review step signs off `PORT_APPROVED` only if ALL of these are true:

1. All 10 hard invariants from Section 6 hold, verified by grep.
2. `npm run typecheck` is green.
3. `cloud-test-rerun` is green:
   - 31/31 slack proxy tests pass
   - 29 github clone tests pass + 3 documented skips (unchanged from baseline)
   - New notion ingest tests pass (all of them, no skips)
4. The diff touches only these paths:
   - `packages/web/lib/integrations/notion-*.ts` (new files)
   - `packages/web/lib/integrations/nango-webhook-router.ts` (updated branch)
   - `packages/web/app/dashboard/integrations/NotionConnectionControls.tsx` (new)
   - `packages/web/app/dashboard/integrations/notion/page.tsx` (optional new)
   - `packages/web/app/dashboard/_components/dashboard-views.tsx` (notion card added)
   - `packages/web/package.json` (one dep added)
   - `tests/notion-*.test.ts` + `tests/fixtures/notion/` + `tests/helpers/mock-nango-webhook-poster.ts`
5. No changes in `packages/web/lib/integrations/` to files other than `notion-*` and `nango-webhook-router.ts`.
6. No changes outside `packages/web/` (no stray edits in `packages/core`, `infra/`, `sst.config.ts`).
7. `../sage/nango-integrations/` is untouched.
8. `NotionConnectionControls.tsx` uses the same patterns as `SlackConnectionControls.tsx` (fetch helper, error states, optimistic UI) — reviewer spot-checks diff.
9. The draft PR body includes:
   - The merge blocker (file: → published version bump)
   - The feature flag rollout plan (set `NEXT_PUBLIC_NOTION_ENABLED=true` in production env after adapter is published)
   - Test evidence (test counts, grep outputs from Wave 6)

## 11. Branch + PR plan

- **Branch:** `refactor/notion-ingest-hookup` off `workflows/v5-slack-e2e-github-clone` (the current base, since #160 hasn't merged yet; retarget to main after #160 merges).
- **Single repo:** cloud only. No adapter changes. No sage changes.
- **PR state:** draft. Cloud PR body declares the merge blocker: must bump `@relayfile/adapter-notion` in `packages/web/package.json` from `file:` to the real published version before merge.
- **Adjacent work NOT in this PR:**
  - E2E seed schema fix for `slack_proxy_audit` (separate follow-up)
  - Running the v5-05 github clone refactor workflow (separate follow-up)
  - Extending `scripts/e2e/seed.sh` with a notion workspace integration row (follow-up)

## 12. Known risks / residual uncertainties

1. **Nango webhook envelope shapes (RESOLVED, but impl must verify).** The impl agent resolves the exact shapes at Wave 0 by reading Nango's TypeScript types from whichever `node_modules/nango` (or `@nangohq/node`) is installed in a sibling repo. If that lookup fails the workflow aborts with `NANGO_TYPES_UNRESOLVED` — the impl must not guess. The sync webhook body carries notification metadata only (`{ type, syncName, model, modifiedAfter, responseResults }`) — **not** the records. Records are fetched separately via Nango's `/records` API, which is what `notion-records-client.ts` wraps.
2. **`NotionAdapter` ingestion API — CONFIRMED READY.** Verified at spec review time. Public methods exist: `bulkIngest(workspaceId)` for path B (auth-creation), `ingestDatabase(workspaceId, databaseId)` for `NotionDatabase` records, `ingestPage(workspaceId, pageId, databaseId?)` for `NotionPage` records. `NotionContentMetadata` records → dispatch to `ingestPage` with the referenced page_id for a content refresh. Caveat: the sync path pays a double-fetch cost because `ingestPage` takes an ID and re-fetches the full page object from Notion's API internally via `retrievePage`, even though Nango already delivered the full record. At the default 1h sync frequency with hundreds of pages, this adds ~10s per sync — acceptable. If the cost becomes visible, a follow-up optimization can either (a) call the lower-level `ingestPageArtifacts(adapter.api, page, ctx)` with the full record (bypasses the refetch, costs cloud having to also write `NotionVfsFile[]` itself), or (b) add a `NotionAdapter.writeRecordDirect(workspaceId, record)` method to the adapter (separate adapter PR, not v5-06). v5-06 ships with option A — use the public class methods — as the default.
3. **Delete events.** Nango's `/records` API annotates each record with `_nango_metadata.last_action` which includes `DELETED`. For v5-06, the handler drops `DELETED` records with an audit entry `delete-dropped` and a count in `deletesDropped`. Justification: notion content is eventually consistent via the scheduled sync (full-sync replaces stale rows), and resolving `(model, id) → path` without a prior cached record requires either an adapter path-from-id helper (not guaranteed to exist) or a relayfile scan (too expensive). Drift is bounded by the sync frequency (1h). If drift becomes a problem in practice, a follow-up PR can add the path-from-id helper to the adapter and enable real deletes. The spec's feature flag gives production an off-switch if any of this behaves badly.
4. **Workspace resolution race on auth creation.** The `auth` creation event fires the instant Nango creates the connection. If cloud writes its `workspace_integrations` row AFTER calling Nango's connect endpoint (vs. pre-writing + updating), the router may receive the auth-creation webhook before the row exists. Mitigation: the router should retry the workspace_integrations lookup up to 3 times with exponential backoff (250ms → 500ms → 1s) on the auth-creation path specifically. If still not found, drop with audit entry `workspace_unresolved_on_creation` (the next scheduled sync will pick it up anyway). The impl agent should verify cloud's current connect flow — if the row is written BEFORE the OAuth redirect, the race doesn't exist and the retry is unnecessary. Preflight reads the slack proxy's workspace-integration lookup helper to see whether it does retries already; the notion handler matches that behavior.
5. **Feature flag default.** Shipping with `NEXT_PUBLIC_NOTION_ENABLED` default off is safest. Reviewer decides whether production gets the flag flipped immediately or waits for post-merge verification in dev.
6. **Audit table schema.** `notion-ingest-audit.ts` writes via the same structured logger pattern slack proxy uses — no new postgres table. If you later want a dedicated `notion_ingest_audit` table (same shape as `slack_proxy_audit`), that's a follow-up migration. Not in scope for v5-06.
7. **Nango types package dep.** If the impl agent chooses to `import type { NangoWebhookBody } from 'nango'`, cloud needs `nango` as a devDependency of `packages/web`. Adding a devDep is acceptable per Invariant 10. If the agent prefers to mirror the types inline (with a citation comment pointing at the Nango type definition file), that also satisfies the invariant and is actually safer long-term because it removes a version-coupling to an external package. Either is fine — document the choice in the PR body.

---

## Next step

Review this spec. When approved, translate to `workflows/v5-06-notion-ingest.ts` following the wave plan in Section 8. The translation is mechanical — every wave maps to a set of `.step()` calls, every gate is a deterministic `type: 'deterministic'` step, every agent section becomes an `.agent()` definition. Expect ~700 lines of TypeScript (similar to v5-05's 1,012 lines but smaller because this is single-repo and has no dual-PR plumbing).

When ready to author the workflow, run:

```bash
agent-relay run --dry-run workflows/v5-06-notion-ingest.ts
```

Validate against the deadlock detector and topology checker before any real run.
