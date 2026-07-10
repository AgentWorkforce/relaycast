# Agent guide — `@cloud/acceptance`

For humans, see [`README.md`](./README.md). This file is the
agent-specific playbook for working inside `packages/acceptance/`.

## What this package is

Layer 1 black-box contract tests. They make real HTTP calls against
`ACCEPTANCE_BASE_URL` and assert on the response. They run against any
candidate runtime (Lambda today, Worker / Fargate tomorrow), so they
must not depend on internal mocks or in-process state.

## Contract Conventions

- Per route, write one happy-path contract test plus every error case
  the handler actually returns. Do **not** invent status codes — `curl`
  the route first to see what it really returns.
- Assert status, stable response headers (`content-type`), and response
  body shape.
- Parse every non-empty JSON response with a co-located `zod` schema.
- Use `vitest` in node mode. No Playwright. No DOM.
- Tolerate `429` and `503` automatically — `helpers/server.ts:request()`
  already retries both. Don't add ad-hoc retry loops in tests.

## Route-coverage marker

Every test file's **first** non-import line must be a comment:

```ts
// @route POST /api/v1/foo/[bar]
```

Multiple `// @route` lines are allowed when one test exercises more than
one route (e.g. start + complete halves of an OAuth flow).

`scripts/check-route-coverage.mjs` parses these markers to map tests to
routes; without them the gate sees zero coverage for the file.

## Fixture Conventions

- Store external payload fixtures under `packages/acceptance/fixtures/`.
- Recorded payloads must be redacted, not hand-written.
- Replace secrets with `[REDACTED:N]`, where `N` is the original length.
- For webhook tests, compute signatures dynamically from the redacted
  body with `process.env.ACCEPTANCE_WEBHOOK_SECRET`.

## Auth And Environment

- `ACCEPTANCE_BASE_URL` defaults to `https://agentrelay.com/cloud`.
- `ACCEPTANCE_CLI_TOKEN`, `ACCEPTANCE_SESSION_COOKIE`,
  `ACCEPTANCE_WORKSPACE_ID`, `ACCEPTANCE_USER_ID` selectively unlock
  credentialed tests via `it.skip` guards.
- Shared auth helpers live under `packages/acceptance/helpers/`.

## Coverage gate

- `scripts/check-route-coverage.mjs` is the route coverage gate. It
  walks `packages/web/app/api/**/route.ts` (and prefers
  `packages/web/.next/types/routes.d.ts` if present) and demands every
  exported method has a matching `// @route` marker somewhere in
  `packages/acceptance/src/**`.
- Deferrals go in `scripts/route-coverage-allowlist.json`. Each entry
  **must** have `route`, `method`, `reason`, and `issue` keys. Missing
  any is a gate failure.

## When tests fail against prod

The retry helper already absorbs throttle / transient errors. If you're
still seeing flakes:

1. Run `curl` against the failing route to see what prod actually
   returns. The test's expected status is the most common drift.
2. Check `aws --profile 131935618863_ReadOnlyAccess --region us-east-1 lambda get-function-url-config --function-name clou-production-AgentRelayCloudWebServerUseast1Function-... --query AuthType`.
   When abuse is active and OAC isn't hardened, `AuthType` is `NONE`;
   when hardened it returns `AWS_IAM`.
3. Don't silently `it.skip` flaky tests. Either fix the assertion to
   match reality, file a tracking issue and skip with the issue number
   in the message, or allowlist the route with an issue ref. Quiet
   skips are how the suite stops being a gate.

## Don't do

- Don't add per-test retry loops. The helper handles 429 + 503.
- Don't assert on exact error message strings unless the message is part
  of a documented contract. `expect(body.error).toBe("Unauthorized")` is
  fine; `expect(body.error).toContain("specific phrasing X")` is brittle.
- Don't import from `@/lib/...` or `packages/web/...` — acceptance tests
  are black-box. If you need a contract type, copy it locally or zod-
  parse the response.
- Don't run the suite in parallel without thinking. `vitest.config.ts`
  already sets `fileParallelism: false` so workspaces-creating tests
  don't race each other.
