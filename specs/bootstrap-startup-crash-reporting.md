# Spec: Bootstrap Startup Crash Reporting

## Problem

When a workflow run is launched via `agent-relay cloud run`, the orchestrator
sandbox boots and executes `bootstrap.mjs` (generated per-run by
`packages/core/src/bootstrap/script-generator.ts`). If anything in the boot
sequence throws — a missing npm dep, a bad env var, a corrupted upload —
**the run silently sits in `pending` forever** and the CLI shows no useful
information.

The bootstrap's only mechanism for surfacing state to the web app is
`Reporter`, which is constructed *inside* the bootstrap *after* all the
imports have resolved. If any of those imports fail (the failure mode of
the 2026-04-22 `@agent-relay/credential-proxy` incident, PR #273), the
Reporter never instantiates, no callback ever fires, and the only
diagnostic available to the user is `daytona sandbox exec ... cat ~/runner.log`
— which requires Daytona credentials and ad-hoc shell access.

**Evidence** (2026-04-22 incident, run `84533132-fe27-4ca9-9ee2-7e722132a327`,
sandbox `61a65b00-32b9-4a2f-9688-80be89de0827`):

- Sandbox `STARTED` at 12:07:35 UTC, no callback ever arrived.
- Run sat in `pending` for >10 minutes.
- Diagnosing required: switching AWS profiles, switching Daytona orgs,
  exec'ing into the sandbox, and reading `runner.log` — about 15 minutes
  of inspection to surface a one-line `ERR_MODULE_NOT_FOUND`.
- The CLI's only feedback during this period was a status poll loop showing
  `pending`.

## Goals

1. **Any uncaught failure during sandbox bootstrap surfaces in the CLI within
   ~5 seconds**, with the error message and a useful chunk of the stack.
2. The fix must work even when the failure is **a static import error**
   (resolved by Node before any of our code executes).
3. Backwards-compatible with the existing callback contract — no schema
   changes to `/api/v1/workflows/callback`.
4. Defense in depth: even if the in-sandbox reporter fails (network blip,
   callback URL unreachable), the run should not stay in `pending` forever.

## Non-goals

- Streaming bootstrap logs in real time. Out of scope; today's `runner.log`
  S3 flusher (`script-generator.ts:67`) is sufficient for post-mortem review
  once the run is no longer stuck.
- Fixing the underlying cause of any specific bootstrap crash. This spec is
  about **surfacing** failures, not eliminating them. (Eliminating dep drift
  is the job of PR #273.)
- Replacing the `Reporter` class. Once bootstrap reaches a working state,
  Reporter remains the runtime status channel.

## Architecture

### Two-layer bootstrap

Today, `script-generator.ts:9` generates a single `bootstrap.mjs` whose
top-level imports include orchestrator deps (`@agent-relay/sdk`,
`./lib/...`, etc.). A static import failure aborts execution before any
of our code runs.

Split that into a **tiny outer wrapper** that has *only* `node:*` imports,
plus a **dynamic import** of the inner bootstrap:

```
bootstrap.mjs (wrapper)              ← Node builtins only; cannot fail-on-import
  ├─ try { await import('./bootstrap-inner.mjs') }
  ├─ catch (err) { POST callback with status:"failed", error:err.stack }
  └─ exit

bootstrap-inner.mjs (current logic)  ← Existing imports, existing flow
  └─ Reporter instantiates here; everything works as today
```

`script-generator.ts` produces both files at launch time and `launcher.ts`
uploads them together. The launcher's `node` invocation runs `bootstrap.mjs`
as today; the only behavior change is the new try/catch boundary.

### Wrapper script (sketch)

```js
#!/usr/bin/env node
// Outer bootstrap wrapper. Reports startup failures to the callback URL
// before exiting so workflow runs don't silently stick in `pending` when
// the inner bootstrap crashes during module load.
//
// CRITICAL: this file must only import from `node:*`. Adding any npm dep
// here defeats the purpose — that dep would be the next thing to fail
// statically and crash the wrapper itself.

const CALLBACK_URL = process.env.CALLBACK_URL;
const CALLBACK_TOKEN = process.env.CALLBACK_TOKEN;
const RUN_ID = process.env.RUN_ID;
const ERROR_BODY_LIMIT = 4000;  // bytes; callback body is small for a reason

async function reportStartupFailure(err) {
  if (!CALLBACK_URL || !CALLBACK_TOKEN || !RUN_ID) {
    console.error('[bootstrap-wrapper] missing callback env, cannot report');
    return;
  }
  const message = (err?.stack ?? err?.message ?? String(err)).slice(0, ERROR_BODY_LIMIT);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch(CALLBACK_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-callback-token': CALLBACK_TOKEN,
      },
      body: JSON.stringify({
        runId: RUN_ID,
        callbackToken: CALLBACK_TOKEN,
        status: 'failed',
        error: `bootstrap startup crash: ${message}`,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error(`[bootstrap-wrapper] callback returned ${res.status}`);
    }
  } catch (postErr) {
    console.error('[bootstrap-wrapper] failed to POST callback:', postErr);
  } finally {
    clearTimeout(timeout);
  }
}

try {
  await import('./bootstrap-inner.mjs');
} catch (err) {
  console.error('[bootstrap-wrapper] inner bootstrap crashed:', err);
  await reportStartupFailure(err);
  process.exit(1);
}
```

The callback handler at `packages/web/app/api/v1/workflows/callback/route.ts:40`
already accepts `{ status: "failed", error: string }` (see lines 26, 77),
so no API changes are required.

### Defense in depth: web-side stuck-run reaper

Even with the wrapper, the failure mode of "wrapper itself crashes before
running" or "network unreachable" still exists. Add a periodic reaper that
flips runs stuck in `pending` for >`STUCK_RUN_TIMEOUT_MINUTES` (default 5)
to `failed` with `error: "bootstrap_timeout"`.

Likely shape:

- New cron handler at `packages/core/src/sync/stuck-run-reaper.ts`,
  scheduled via SST `Cron` in `infra/cron.ts` every 1 minute.
- Query: `SELECT runId FROM workflow_runs WHERE status = 'pending' AND createdAt < NOW() - INTERVAL '5 minutes'`.
- For each: `workflowStore.update(runId, { status: 'failed', error: 'bootstrap_timeout — sandbox never reported' })`.
- Also revoke the API token session (mirroring the callback handler's
  cleanup path, `route.ts:90`).

Keep the timeout generous (5 min, not 2) because legitimate sandbox cold
starts plus large code uploads can legitimately take 60-90s before the
inner bootstrap reports `running`.

## Implementation steps

1. **Refactor `script-generator.ts`** to emit two files per launch:
   - `bootstrap.mjs` — the wrapper (above).
   - `bootstrap-inner.mjs` — what `generateBootstrapScript` currently
     returns, renamed.
   - Update the function signature to return both, e.g.
     `{ wrapper: string; inner: string }`, or have callers request each
     separately.

2. **Update `launcher.ts:644`** (where `generateBootstrapScript` is called)
   and the upload step (`launcher.ts:482`-ish) to write both files to
   `/home/daytona/`.

3. **Confirm the `node` invocation at `launcher.ts:672`-ish** still points
   at `bootstrap.mjs` (no change required, since the wrapper takes that
   filename).

4. **Test paths to validate manually before merge:**

   a. **Happy path:** Run a working workflow against the dev stage. Confirm
      the run reaches `running` and `completed` as today. (Wrapper adds
      one extra await + dynamic import; latency cost is negligible.)

   b. **Synthetic startup crash:** Patch `bootstrap-inner.mjs` to
      `import 'definitely-not-a-package'` at the top, deploy to dev, run
      a workflow, and verify the CLI sees `Status: failed — bootstrap
      startup crash: Error [ERR_MODULE_NOT_FOUND]: Cannot find package
      'definitely-not-a-package'` within 5 seconds.

   c. **Callback unreachable:** Patch the wrapper's `CALLBACK_URL` to a
      black hole (e.g. `https://10.255.255.1/`), trigger a startup crash,
      verify the run still gets reaped within 5 minutes by the new cron
      and shows `error: "bootstrap_timeout"`.

5. **Add reaper:**
   - `packages/core/src/sync/stuck-run-reaper.ts` (new file).
   - Wire into `infra/cron.ts` as 1-minute schedule.
   - Add `STUCK_RUN_TIMEOUT_MINUTES` to env config (default 5).

## Edge cases

- **Wrapper is invoked from a stage that doesn't set `CALLBACK_URL`** (local
  dev `agent-relay run`, not `agent-relay cloud run`). The wrapper logs
  and skips the POST — no behavior change vs today.
- **Multiple startup failures in fast succession** (retries from the CLI
  side). Each launches a separate sandbox with a separate `RUN_ID` and
  callback token, so they don't collide.
- **Inner bootstrap throws *after* it has already reported `running`.**
  The reaper doesn't apply (status is no longer `pending`). The wrapper's
  catch block still fires and POSTs `status: "failed"`, which the callback
  handler accepts. Result: status flips from `running` to `failed` with
  the wrapper's error — slightly noisier than the existing `Reporter`
  path but correct.
- **Error message contains secrets.** The startup crash should not leak
  credentials, but the stack trace might include env var names or URL
  fragments. Cap the body at 4 KB and rely on the existing log scrubber
  (if any) on the callback receive side. Future hardening: add a
  redaction pass before POST.
- **Callback token leak in logs.** The wrapper logs `callback returned ${res.status}`
  but never logs the token. Stack traces in `runner.log` should not
  include the token because it's never substituted into a string the
  inner code constructs.

## Rollout

1. Land PR with wrapper + reaper behind a single env-gated flag
   (`BOOTSTRAP_WRAPPER_ENABLED`, default `true`). Flag exists only as a
   safety lever in case the wrapper itself misbehaves; remove it after
   one week of clean operation in production.
2. Deploy to dev, run synthetic crash test (step 4b above), confirm CLI
   sees the failure within 5 seconds.
3. Promote to staging, deploy, repeat synthetic test.
4. Promote to production. Watch CloudWatch for any spike in
   `status: "failed"` runs over the first 24 hours — a spike would
   indicate the wrapper is catching real failures that previously stuck.

## Followups (out of scope here)

- **Snapshot smoke test in CI**: after `Rebuild Daytona Snapshot` completes,
  launch a trivial no-op workflow and assert it reaches `running` within
  60s. Catches dep drift at build time even when the bootstrap can self-
  report (they're complementary).
- **CLI auto-follow on launch**: `agent-relay cloud run` could `--follow`
  by default, surfacing `runner.log` lines and final status without a
  second invocation.
- **Bundle the orchestrator into a self-contained artifact** (the "Option A"
  path discussed in the 2026-04-22 incident review). Eliminates the entire
  class of "snapshot doesn't have the dep" failures by construction. This
  spec's wrapper is still useful as defense in depth even if bundling
  lands later.
