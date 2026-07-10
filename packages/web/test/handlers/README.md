# Handler integration tests (Layer 2)

In-process integration tests that boot the Next.js route module, drive
it with realistic dependencies (PGlite for Postgres, LocalStack for AWS
services, mocked Nango / Slack / Cloudflare), and assert on the actual
`NextResponse`.

These run on every PR via the `phase0-tests` job in
`.github/workflows/ci.yml`. They're fully offline — no network calls,
no real cloud resources — so they're cheap to run and safe on any
branch.

## How to run locally

```bash
# From repo root
node ./node_modules/vitest/vitest.mjs run \
  --dir packages/web/test/handlers \
  --reporter=default
```

Filter to one file:

```bash
node ./node_modules/vitest/vitest.mjs run \
  packages/web/test/handlers/waitlist.test.ts
```

A single test by name:

```bash
node ./node_modules/vitest/vitest.mjs run \
  --dir packages/web/test/handlers \
  -t "returns 400 for malformed JSON bodies"
```

## How to add a test for a new route

There are two patterns in use:

### 1. In-file vitest test (preferred for new routes)

Create `packages/web/test/handlers/<route-name>.test.ts` and put the
test in the file directly:

```ts
// @handler /api/v1/foo/[bar]
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/auth/request-auth", () => ({
  resolveRequestAuth: vi.fn().mockResolvedValue({ userId: "u1", workspaceId: "ws1" }),
  requireAuthScope: vi.fn().mockReturnValue(true),
}));

import { POST } from "../../app/api/v1/foo/[bar]/route";

describe("POST /api/v1/foo/[bar]", () => {
  it("rejects malformed bodies", async () => {
    const response = await POST(
      new Request("http://localhost/api/v1/foo/123", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
      { params: Promise.resolve({ bar: "123" }) },
    );
    expect(response.status).toBe(400);
  });
});
```

The first line **must** be `// @handler /api/v1/...`. The
handler-coverage gate maps tests to routes via this marker.

### 2. Re-export of an existing test (legacy)

Several existing handler tests are 2-line re-exports of test files
under `tests/` (top-level) or `packages/web/app/api/.../route.test.ts`:

```ts
// @handler /api/v1/foo/[bar]
import "../../app/api/v1/foo/[bar]/route.test.ts";
```

This is supported, but the underlying test file **must** use vitest
(not `node:test`), and **must** import or dynamic-import a file under
the claimed route's directory. The coverage gate verifies both:
re-exports that point at node:test suites or at tests that never touch
the route module fail the gate.

## What gets enforced

`scripts/check-handler-coverage.ts` runs on every PR and:

1. Walks `packages/web/app/api/**/route.ts` and identifies "stateful"
   routes — exported `POST`, `PUT`, `PATCH`, `DELETE`, or `GET` handlers
   that fetch / insert / update / delete. Factory-pattern routes (e.g.
   `export const { POST } = createHandlers(...)`) count too.
2. Walks `packages/web/test/handlers/*.test.ts`, collects every
   `// @handler /api/...` claim, and validates each claim by walking
   the file's import graph (static + dynamic + bare-string-literal
   route paths):
   - At least one reachable file must import vitest. (node:test suites
     are invisible to the handler-suite runner.)
   - At least one reachable file must live under the claimed route's
     directory (so we know the test actually touches the route module).
3. Reports any stateful route with neither a real-covered handler test
   nor an entry in `scripts/route-coverage-allowlist.json`.

Allowlist entries require `route`, `method`, `reason`, AND `issue`
fields. Missing any is a gate failure.

## When tests fail in CI

1. **`Test timed out`** — a test ran longer than its timeout. PGlite
   bring-up under parallel load can easily exceed the 5s default.
   Bump the timeout: `it("...", { timeout: 30_000 }, async () => {...})`.
   See `tests/workflow-run-response-pushed-to.test.ts` for the pattern.
2. **`No "X" export is defined on the "@/lib/db/schema" mock`** — a
   handler reaches into the schema for a column / table that the test's
   mock didn't include. Either add the missing export to the `vi.mock`
   call, or partially mock with `importOriginal()`.
3. **`Cannot find module`** under a route re-export — the underlying
   test file was moved or deleted. Either update the import path or
   delete the re-export and allowlist the route with a tracking issue.
4. **Coverage gate fails with "no transitive import from vitest"** —
   you re-exported a node:test file. Either port it to vitest or
   replace the re-export with a real in-file vitest test.

## Open follow-ups

- **#638** — 4 routes whose only test lives in node:test suites
  (`/api/v1/github/clone`, `/api/v1/agents/deploy`,
  `/api/v1/workspaces/[workspaceId]/secrets`,
  `/api/v1/workspaces/[workspaceId]/secrets/[secretName]`). They're
  allowlisted. Porting them to vitest is tracked in #638.
- **Migration-vs-schema parity check** — handler tests depend on
  `@cloud/core/db/schema.ts`. If a future migration adds a column
  without updating the schema TS, the build breaks. We hit this with
  `writebackDispatchVia` in May 2026. A "migration ↔ schema parity"
  check would catch this earlier. Not filed yet.
