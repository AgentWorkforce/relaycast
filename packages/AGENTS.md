# cloud/packages

Most packages in this directory deploy to **Cloudflare Workers** with `nodejs_compat` (sage-worker, specialist-worker, relayfile, relayauth, credential-proxy, router, relaycron, cataloging-agent-*). Packages that run in a Worker are subject to a specific runtime gotcha:

## Cloudflare Workers: never use bare `fetch()`

Under `nodejs_compat`, esbuild can hoist bare `fetch(url, init)` identifiers in a way that detaches them from `globalThis`, producing:

```
TypeError: Illegal invocation: function called with incorrect `this` reference.
```

**Always** call `globalThis.fetch(...)` (inline) or go through a tiny `callFetch` helper in the module. Do **not** use a module-level `fetch.bind(globalThis)` — it breaks `vi.stubGlobal("fetch", ...)` in tests.

### When a third-party SDK has the same bug

Some SDKs (e.g. `@relayauth/sdk`'s `_request`) call bare `fetch` internally. In a Worker bundle, that triggers the same `Illegal invocation`. Mitigations:

1. Pin an SDK version known to use `globalThis.fetch`, or
2. Inline the handful of REST calls you need (skip the SDK transport) — see the `relayfile-jwt.ts` migration in sage for a worked example.

### Test posture

Use `vi.stubGlobal("fetch", fetchMock)` in vitest tests. Your production code must call `globalThis.fetch(...)` at the call site (not a snapshotted reference) for the stub to take effect.

### Full rule

`.claude/rules/workers-fetch.md` (path-scoped to every Worker package in this directory).

### Incident history

- sage#108 → sage#110 hotfix (first time this pattern bit production)
- cloud#322 — specialist-worker follow-up pending at time of writing
