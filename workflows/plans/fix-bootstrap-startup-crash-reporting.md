# Bootstrap Startup Crash Reporting - Implementation Plan

## Overview

This plan implements the spec at `specs/bootstrap-startup-crash-reporting.md`, adding:
1. A two-layer bootstrap with a `node:*`-only wrapper that catches startup crashes
2. A stuck-run reaper cron that marks pending runs as failed after timeout

---

## 1. Evidence: Current Implementation

### 1.1 Single-File Bootstrap Generation Path

**File:** `packages/core/src/bootstrap/script-generator.ts`
- **Line 9:** `export function generateBootstrapScript(config: BootstrapConfig): string {`
- **Lines 14-1403:** Template literal returns a single string containing the entire bootstrap.mjs
- **Line 14:** Script starts with `#!/usr/bin/env node`
- **Lines 17-36:** NPM imports at top level (`@agent-relay/sdk`, `@daytonaio/sdk`, etc.)

The current design has all imports at module top-level, meaning a static import failure aborts execution before any error-reporting code runs.

### 1.2 Launcher Upload/Invocation of bootstrap.mjs

**File:** `packages/core/src/bootstrap/launcher.ts`
- **Lines 679-683:** Bootstrap script generation call:
  ```typescript
  const script = generateBootstrapScript({
    fileType,
    codeMountPath: "/project",
    interactive,
  });
  ```
- **Line 684:** Single-file upload:
  ```typescript
  await sandbox.fs.uploadFile(Buffer.from(script), `${home}/bootstrap.mjs`);
  ```
- **Lines 687-690:** Invocation via nohup:
  ```typescript
  await sandbox.process.executeCommand(
    `. ${home}/.bootstrap-env && nohup node ${home}/bootstrap.mjs > ${home}/runner.log 2>&1 &`,
    home
  );
  ```

### 1.3 Callback Route Acceptance of status='failed' + error

**File:** `packages/web/app/api/v1/workflows/callback/route.ts`
- **Lines 7-13:** `CallbackBody` type includes `error?: string`
- **Line 26:** Error validation: `(!("error" in body) || body.error === undefined || typeof body.error === "string")`
- **Lines 74-78:** Update with error payload:
  ```typescript
  await workflowStore.update(body.runId, {
    status: body.status,
    ...(Object.hasOwn(body, "result") ? { result: body.result } : {}),
    ...(body.error !== undefined ? { error: body.error } : {}),
  });
  ```
- **Line 80:** Checks for terminal statuses: `if (body.status === "completed" || body.status === "failed")`
- **Lines 81-90:** Token cleanup on terminal status

### 1.4 Current Workflow Store / Token Cleanup Path

**Workflow Store:**
- **File:** `packages/web/lib/workflows.ts`
- **Lines 127-144:** `workflowStore.update()` method handles status/result/error patches

**Token Cleanup:**
- **File:** `packages/web/lib/auth/api-token-store.ts`
- **Lines 327-338:** `revokeApiTokenSessionsForRun(runId, reason)` - marks all sessions for a run as revoked

**RelayAuth Cleanup:**
- **File:** `packages/web/app/api/v1/workflows/callback/route.ts`
- **Lines 81-88:** `revokeWorkflowIdentity()` on terminal status

### 1.5 Existing SST Cron Module Convention

**CORRECTION:** The spec mentions `infra/cron.ts`, but this file does not exist. This repo uses **dedicated infra module files** for crons.

**AWS Cron Pattern:**
- **File:** `infra/credential-refresh.ts:7-23` - `sst.aws.Cron("CredentialRefreshCron")`
- **File:** `infra/volume-cleanup.ts:3-11` - `sst.aws.Cron("VolumeCleanupCron")`

**Pattern Details:**
- Crons defined as exported constants in dedicated infra files
- Handler lives in `packages/core/src/<domain>/<handler>.ts` with `.handler` suffix
- Linked resources via `link: [appDatabase, ...]`
- Environment via `environment: { ... }`
- Imported via side-effect in `sst.config.ts:20`: `await import("./infra/credential-refresh")`

**Credential Sweep as Model for DB Access:**
- **File:** `packages/core/src/auth/credential-sweep.ts:39-100`
- **Lines 55-62:** Direct `pg` Client using `Resource.AppDatabase.*` for DB connection
- Uses raw SQL queries, not Drizzle ORM (which lives in `packages/web`)

---

## 2. Implementation Shape: Bootstrap Wrapper

### 2.1 Decision: Tiny Wrapper + Dynamic Import

**Approach:** `generateBootstrapScript` returns an object with two strings:
```typescript
{ wrapper: string; inner: string }
```

**Rationale:**
- Keeps the wrapper and inner script generation together in one function
- Avoids proliferating separate helper functions
- Clear API for the launcher to upload both files

### 2.2 Wrapper Script Design

The wrapper must use ONLY `node:*` imports (no npm deps). It will:
1. Try `await import('./bootstrap-inner.mjs')`
2. On catch: POST `{ runId, callbackToken, status: 'failed', error: ... }` to callback URL
3. Exit with code 1

Key constraints:
- Use native `fetch()` (Node 18+)
- 5-second timeout via `AbortController`
- Cap error body at 4KB
- Log failure to stdout/stderr (captured by runner.log)

### 2.3 Launcher Changes

**`launcher.ts:684`** becomes two uploads:
```typescript
await sandbox.fs.uploadFile(Buffer.from(scripts.wrapper), `${home}/bootstrap.mjs`);
await sandbox.fs.uploadFile(Buffer.from(scripts.inner), `${home}/bootstrap-inner.mjs`);
```

**`launcher.ts:687-690`** remains unchanged - still invokes `bootstrap.mjs`.

---

## 3. Package Boundaries: Reaper DB Access

### 3.1 Decision: Mirror Credential-Sweep Style

The reaper lives in `packages/core` and must access `workflow_runs` without importing `packages/web/lib/workflows.ts` (which pulls in Next.js/Drizzle dependencies).

**Pattern:** Use raw `pg` client with SST Resource links (like `credential-sweep.ts:55-62`):

```typescript
import { Resource } from "sst";
import { Client } from "pg";

const client = new Client({
  host: Resource.AppDatabase.host,
  port: Resource.AppDatabase.port,
  database: Resource.AppDatabase.database,
  user: Resource.AppDatabase.username,
  password: Resource.AppDatabase.password,
  ssl: { rejectUnauthorized: false },
});
```

**Why not import from packages/web?**
- `packages/web` uses Drizzle ORM with Next.js-specific db client
- Lambda handlers in `packages/core` use raw `pg` + SST Resource links
- This is the established pattern for cross-package DB access

### 3.2 Token Cleanup from Reaper

The reaper also needs to revoke API token sessions. Options:
1. **Inline SQL:** Write the revoke query directly in the reaper
2. **Shared helper:** Extract a raw-SQL token revoke function in `packages/core`

**Decision:** Inline SQL in reaper - simpler, single-use, mirrors credential-sweep approach.

---

## 4. File List by Wave

### Wave A: Bootstrap Files

| File | Action | Description |
|------|--------|-------------|
| `packages/core/src/bootstrap/script-generator.ts` | **Edit** | Return `{ wrapper: string; inner: string }` instead of `string`. Wrapper is node:*-only with try/catch around dynamic import. |
| `packages/core/src/bootstrap/launcher.ts:684` | **Edit** | Upload both `bootstrap.mjs` (wrapper) and `bootstrap-inner.mjs` (inner). |

### Wave B: Reaper / Infra Files

| File | Action | Description |
|------|--------|-------------|
| `packages/core/src/sync/stuck-run-reaper.ts` | **Create** | Lambda handler that marks pending runs > 5 min as failed, revokes tokens. |
| `infra/stuck-run-reaper.ts` | **Create** | SST `sst.aws.Cron("StuckRunReaper")` with 1-minute schedule, linked to `appDatabase`. |
| `sst.config.ts:20` | **Edit** | Add `await import("./infra/stuck-run-reaper")` after other cron imports. |

### Wave C: Tests + Optional Probe Workflow

| File | Action | Description |
|------|--------|-------------|
| `tests/orchestrator/script-generator.test.ts` | **Edit** | Add tests for wrapper generation, error reporting structure. |
| `tests/orchestrator/launcher.test.ts` | **Edit** | Add test for dual-file upload expectation. |
| `tests/reaper/stuck-run-reaper.test.ts` | **Create** | PGlite-based tests for stuck run detection and cleanup. |
| `workflows/probe-bootstrap-crash.ts` | **Create** (optional) | Test workflow that imports a nonexistent package for manual validation. |

---

## 5. Detailed Test Specifications

### 5.1 Bootstrap Wrapper Generation Test (`tests/orchestrator/script-generator.test.ts`)

```typescript
describe("generateBootstrapScript wrapper", () => {
  it("returns an object with wrapper and inner strings", () => {
    const result = generateBootstrapScript({ fileType: "yaml" });
    assert.ok(typeof result.wrapper === "string");
    assert.ok(typeof result.inner === "string");
  });

  it("wrapper only imports from node:* namespace", () => {
    const { wrapper } = generateBootstrapScript({ fileType: "yaml" });
    const imports = wrapper.match(/import\s+.*from\s+['"]([^'"]+)['"]/g) || [];
    for (const imp of imports) {
      assert.ok(imp.includes("node:"), `Unexpected non-node: import: ${imp}`);
    }
  });

  it("wrapper dynamically imports bootstrap-inner.mjs", () => {
    const { wrapper } = generateBootstrapScript({ fileType: "yaml" });
    assert.ok(wrapper.includes("import('./bootstrap-inner.mjs')"));
  });

  it("wrapper catches errors and POSTs to CALLBACK_URL", () => {
    const { wrapper } = generateBootstrapScript({ fileType: "yaml" });
    assert.ok(wrapper.includes("catch"));
    assert.ok(wrapper.includes("fetch(CALLBACK_URL"));
    assert.ok(wrapper.includes("status: 'failed'"));
  });

  it("wrapper caps error message at 4000 bytes", () => {
    const { wrapper } = generateBootstrapScript({ fileType: "yaml" });
    assert.ok(wrapper.includes("4000") || wrapper.includes("ERROR_BODY_LIMIT"));
  });

  it("inner retains all existing bootstrap imports and logic", () => {
    const { inner } = generateBootstrapScript({ fileType: "yaml" });
    assert.ok(inner.includes("import { WorkflowRunner }"));
    assert.ok(inner.includes("import { Daytona }"));
    assert.ok(inner.includes("Reporter"));
  });
});
```

### 5.2 Stuck Run Reaper Test (`tests/reaper/stuck-run-reaper.test.ts`)

Uses PGlite for real SQL execution:

```typescript
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";

describe("stuck-run-reaper", () => {
  let db: PGlite;

  before(async () => {
    db = new PGlite();
    // Create minimal workflow_runs table
    await db.exec(`
      CREATE TABLE workflow_runs (
        id UUID PRIMARY KEY,
        status TEXT NOT NULL,
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `);
    // Create minimal api_token_sessions table
    await db.exec(`
      CREATE TABLE api_token_sessions (
        id UUID PRIMARY KEY,
        run_id UUID,
        revoked_at TIMESTAMPTZ,
        revoked_reason TEXT,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `);
  });

  after(async () => {
    await db.close();
  });

  it("marks runs pending > 5 minutes as failed with bootstrap_timeout", async () => {
    const runId = crypto.randomUUID();
    const oldTime = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    await db.exec(`
      INSERT INTO workflow_runs (id, status, created_at, updated_at)
      VALUES ('${runId}', 'pending', '${oldTime}', '${oldTime}')
    `);

    // Execute reaper logic
    await db.exec(`
      UPDATE workflow_runs
      SET status = 'failed', error = 'bootstrap_timeout', updated_at = NOW()
      WHERE status = 'pending' AND created_at < NOW() - INTERVAL '5 minutes'
    `);

    const result = await db.query(`SELECT status, error FROM workflow_runs WHERE id = '${runId}'`);
    assert.equal(result.rows[0].status, "failed");
    assert.equal(result.rows[0].error, "bootstrap_timeout");
  });

  it("does not affect runs pending < 5 minutes", async () => {
    const runId = crypto.randomUUID();
    const recentTime = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    await db.exec(`
      INSERT INTO workflow_runs (id, status, created_at, updated_at)
      VALUES ('${runId}', 'pending', '${recentTime}', '${recentTime}')
    `);

    await db.exec(`
      UPDATE workflow_runs
      SET status = 'failed', error = 'bootstrap_timeout', updated_at = NOW()
      WHERE status = 'pending' AND created_at < NOW() - INTERVAL '5 minutes'
    `);

    const result = await db.query(`SELECT status FROM workflow_runs WHERE id = '${runId}'`);
    assert.equal(result.rows[0].status, "pending");
  });

  it("revokes API token sessions for reaped runs", async () => {
    const runId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const oldTime = new Date(Date.now() - 6 * 60 * 1000).toISOString();

    await db.exec(`
      INSERT INTO workflow_runs (id, status, created_at, updated_at)
      VALUES ('${runId}', 'pending', '${oldTime}', '${oldTime}')
    `);
    await db.exec(`
      INSERT INTO api_token_sessions (id, run_id, updated_at)
      VALUES ('${sessionId}', '${runId}', '${oldTime}')
    `);

    // Reaper marks run failed
    const reaped = await db.query(`
      UPDATE workflow_runs
      SET status = 'failed', error = 'bootstrap_timeout', updated_at = NOW()
      WHERE status = 'pending' AND created_at < NOW() - INTERVAL '5 minutes'
      RETURNING id
    `);

    // Revoke tokens for reaped runs
    for (const row of reaped.rows) {
      await db.exec(`
        UPDATE api_token_sessions
        SET revoked_at = NOW(), revoked_reason = 'bootstrap_timeout', updated_at = NOW()
        WHERE run_id = '${row.id}' AND revoked_at IS NULL
      `);
    }

    const session = await db.query(`SELECT revoked_reason FROM api_token_sessions WHERE id = '${sessionId}'`);
    assert.equal(session.rows[0].revoked_reason, "bootstrap_timeout");
  });
});
```

### 5.3 Launcher Dual-File Upload Test (`tests/orchestrator/launcher.test.ts`)

```typescript
it("expects generateBootstrapScript to return wrapper and inner", () => {
  const result = generateBootstrapScript({ fileType: "yaml" });
  assert.ok(
    typeof result === "object" && "wrapper" in result && "inner" in result,
    "generateBootstrapScript must return { wrapper, inner } object"
  );
});
```

---

## 6. Manual Validation Section

### 6.1 Happy Path

**Objective:** Confirm wrapper + inner split doesn't break normal workflow execution.

**Steps:**
1. Deploy to dev stage: `npx sst deploy --stage dev`
2. Run a working workflow: `agent-relay cloud run ./workflows/hello-world.yaml`
3. **PASS:** Run reaches `running`, then `completed` within expected time
4. **PASS:** CLI shows status updates normally

### 6.2 Synthetic Startup Crash

**Objective:** Verify wrapper catches import failures and reports to callback.

**Steps:**
1. Create a test workflow that imports a nonexistent package:
   ```yaml
   version: "1.0"
   swarm:
     agents:
       - name: crasher
         model: claude-3-5-sonnet-20241022
   ```
   And a companion TS file with `import 'definitely-not-a-package';` at top.
2. Run: `agent-relay cloud run ./test-crash-workflow.ts`
3. **PASS:** Within 5 seconds, CLI shows `Status: failed — bootstrap startup crash: Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'definitely-not-a-package'`
4. **PASS:** runner.log in sandbox contains wrapper error output

### 6.3 Callback Unreachable / Reaper Fallback

**Objective:** Verify reaper catches runs when wrapper can't POST callback.

**Steps:**
1. Temporarily patch CALLBACK_URL in bootstrap env to `https://10.255.255.1/` (black hole)
2. Trigger a startup crash (same as 6.2)
3. Wait 5 minutes
4. **PASS:** Run status flips to `failed` with error `bootstrap_timeout`
5. **PASS:** API token sessions for the run are revoked

---

## 7. Acceptance Checklist

| # | Criterion | PASS Condition | FAIL Condition |
|---|-----------|----------------|----------------|
| 1 | `generateBootstrapScript` returns `{ wrapper, inner }` | Return type is object with both string properties | Returns single string or missing property |
| 2 | Wrapper imports only `node:*` modules | All `import ... from` statements reference `node:*` prefix | Any import from npm package or relative path with npm deps |
| 3 | Wrapper catches errors from inner import | `try { await import('./bootstrap-inner.mjs') } catch { ... }` present | No try/catch around dynamic import |
| 4 | Wrapper POSTs to CALLBACK_URL on error | `fetch(CALLBACK_URL, { method: 'POST', ... status: 'failed' ... })` present | Missing or incorrect fetch call |
| 5 | Launcher uploads both files | `sandbox.fs.uploadFile` called for both `bootstrap.mjs` and `bootstrap-inner.mjs` | Single upload or incorrect filenames |
| 6 | Reaper marks pending runs > 5 min as failed | SQL query with `WHERE status = 'pending' AND created_at < NOW() - INTERVAL '5 minutes'` updates to `failed` | Wrong timeout, wrong status check, or no update |
| 7 | Reaper revokes API token sessions | Tokens for reaped runs have `revoked_at` set | Tokens remain active |
| 8 | Reaper cron wired in infra | `infra/stuck-run-reaper.ts` exports `sst.aws.Cron` with 1-minute schedule, imported in `sst.config.ts` | Missing cron, wrong schedule, or not imported |
| 9 | Happy path works | Normal workflow reaches `completed` | Regression in normal flow |
| 10 | Synthetic crash shows error in CLI | CLI shows `failed — bootstrap startup crash` within 5 seconds | Silent failure or timeout |
| 11 | Reaper fallback works | Run reaped after 5 min when callback unreachable | Run stuck in pending indefinitely |
| 12 | Tests pass | `npm test` passes for script-generator, launcher, and reaper tests | Any test failure |

---

## 8. Rollout Notes (from spec)

1. Land PR with wrapper + reaper behind env flag `BOOTSTRAP_WRAPPER_ENABLED` (default `true`)
2. Deploy to dev, run synthetic crash test
3. Promote to staging, repeat test
4. Promote to production, monitor for spike in `status: "failed"` runs
