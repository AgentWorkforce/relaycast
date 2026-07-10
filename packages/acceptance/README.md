# `@cloud/acceptance`

Layer 1 of the Phase 0 migration gate: black-box API contract tests that
run against any deployed environment (Lambda today, Fargate / Worker
tomorrow) via `ACCEPTANCE_BASE_URL`. The same suite gates every
candidate runtime, so behavior parity is provable from one place.

The suite is built around two ideas:

1. **No mocks, no in-process surgery.** Every test fires a real HTTP
   request against the configured base URL and asserts on the response.
   If it passes here, the route works in production.
2. **Authenticated tests are gated by env vars.** Unauth contracts (401
   rejections, public endpoints, malformed-body 400s) always run.
   Credentialed tests `it.skip` cleanly when their env vars are unset so
   the suite is safe to run from any branch, with or without secrets.

## Layout

- `src/api/` — top-level API contracts (health, public, protected)
- `src/auth/` — auth and invite route contracts
- `src/integrations/` — integrations, webhook, proxy, GitHub/Linear/Notion/Slack route contracts
- `src/runtime/` — workflows, workers, ricky, deployment, sandbox route contracts
- `src/workspaces/` — workspace CRUD, secrets, deployments, integrations route contracts
- `fixtures/` — redacted recorded payloads used by some integration tests
- `helpers/` — shared request, auth, env helpers
  - `helpers/server.ts` — `request(method, route, init)` with 429 + 503 retry
  - `helpers/env.ts` — strongly-typed `acceptanceEnv()` reader
  - `helpers/auth.ts` — cookie/bearer helpers

## How to run locally

```bash
# Unauthenticated subset against prod (no secrets needed)
export ACCEPTANCE_BASE_URL=https://agentrelay.com/cloud
node ./node_modules/vitest/vitest.mjs run \
  --config packages/acceptance/vitest.config.ts \
  --reporter=default
```

Or, from inside the package:

```bash
cd packages/acceptance
ACCEPTANCE_BASE_URL=https://agentrelay.com/cloud npm test
```

To run the credentialed subset, populate these env vars (any subset
selectively unlocks the relevant `it`s):

| Env var                    | Effect                                  |
| -------------------------- | --------------------------------------- |
| `ACCEPTANCE_BASE_URL`      | Defaults to `https://agentrelay.com/cloud`. |
| `ACCEPTANCE_CLI_TOKEN`     | Unlocks `auth: "cli"` tests.            |
| `ACCEPTANCE_SESSION_COOKIE`| Unlocks `auth: "session"` tests.        |
| `ACCEPTANCE_WORKSPACE_ID`  | Workspace UUID used by workspace tests. |
| `ACCEPTANCE_USER_ID`       | User UUID for tests that need one.      |

You can also target a preview environment:

```bash
ACCEPTANCE_BASE_URL=https://pr-633.agentrelay.com/cloud npm test
```

## How to add a test for a new route

1. Pick the right folder: `src/api/`, `src/auth/`, `src/integrations/`,
   `src/runtime/`, or `src/workspaces/`.
2. Create `<route-name>.test.ts`. Use this template:

   ```ts
   // @route POST /api/v1/foo/[bar]
   import { z } from "zod";
   import { describe, expect, it } from "vitest";
   import { request } from "../../helpers/server";

   const errorSchema = z.object({ error: z.string().min(1) }).passthrough();

   describe("/api/v1/foo/[bar] contracts", () => {
     it("POST /api/v1/foo/[bar] rejects unauthenticated requests", async () => {
       const response = await request("POST", "/api/v1/foo/123", {
         headers: { "content-type": "application/json" },
         body: JSON.stringify({}),
       });

       expect([401, 429]).toContain(response.status);
       if (response.status === 401) {
         errorSchema.parse(await response.json());
       }
     });
   });
   ```

3. The first line **must** be a `// @route METHOD /api/...` comment.
   The route-coverage gate (`scripts/check-route-coverage.mjs`) uses
   this marker to map tests to routes. Multiple `// @route` lines are
   allowed for tests that exercise more than one route.
4. Run the suite locally: `npm test`.
5. Run the coverage gate: `node scripts/check-route-coverage.mjs`.

## What gets enforced

Two gates run on every PR via the `phase0-tests` job in `.github/workflows/ci.yml`:

- **Route coverage** (`scripts/check-route-coverage.mjs`): every route
  exported by `packages/web/app/api/**/route.ts` must be claimed by at
  least one `// @route` comment in `packages/acceptance/src/**`, or it
  must be in `scripts/route-coverage-allowlist.json`.
- **Allowlist contract**: every allowlist entry requires `route`,
  `method`, `reason`, AND `issue` keys. A missing tracking issue fails
  the gate. This keeps deferrals honest — every gap is a filed,
  triagable bug rather than a quiet TODO.

## When tests fail in CI

Triage in this order:

1. **Is the failure a 503 / timeout?** The helper retries 429 + 503 with
   exponential backoff. If many tests fail with 5xx anyway, the deployed
   environment is degraded. Check `aws lambda get-function-configuration`
   for the production function or look at CloudWatch for the time window.
2. **Is the failure a contract mismatch (e.g. 401 vs 403)?** Check what
   the route actually returns with `curl` and compare to the assertion.
   If the route changed behavior, the test needs updating; if the route
   regressed, file a bug and the test caught it correctly.
3. **Is the failure a schema validation error?** The test's zod schema
   didn't match the response body. Either the route's response shape
   changed (update the schema) or there's a real bug.
4. **Is the failure a test that requires credentials?** If the env vars
   are unset, the test should `it.skip`. If it doesn't, the test is
   missing its env-var guard. Wrap with `(hasUserAuth() ? it : it.skip)`
   or the equivalent helper.

## What's intentionally NOT tested

- **Full happy-path with real side effects.** Tests that create
  workspaces, fire webhooks, or push to Slack are gated behind env
  vars and not run from PR builders. They can leak state if a
  test forgets to clean up; the workspaces/* tests use
  `createWorkspace`/`destroyWorkspace` helpers but the gate doesn't
  enforce teardown — be vigilant.
- **Internal handler logic.** That's Layer 2 (handler tests,
  `packages/web/test/handlers/`) — those run in-process with PGlite +
  LocalStack and don't go through HTTP.
- **Replay-equivalence between two runtimes.** That's Layer 3
  (`packages/replay-harness/`) — it captures responses from Runtime A
  and re-asserts the same request against Runtime B.

## Open follow-ups

- See issue **#639** for the 10 routes added post-Phase 0 (digest
  functions, gitlab integrations, relayfile audit/batch) that still need
  acceptance tests. They're allowlisted today.
- See issue **#638** for the 4 routes whose only test lives in node:test
  suites (invisible to the vitest handler runner).
