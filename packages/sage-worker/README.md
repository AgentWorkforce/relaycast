# @cloud/sage-worker

This is a thin Cloudflare Worker glue package that re-exports `@agentworkforce/sage`. The pinned Sage version lives in this package's `package.json`, and updates flow through `npm install` followed by an SST redeploy.

## Workers-target constraint

Sage runs on the `workerd` runtime, so any new or bumped dependency must not execute Node-only APIs at module top level.
- `createRequire(import.meta.url)`
- `fs` / `child_process` / `node:sqlite`
- any code that reads `import.meta.url` synchronously

These fail at Cloudflare upload time with error `10021` because `import.meta.url` is undefined in the bundled script, which is why the failure slipped past CI in `#139`.

## Pre-merge check

Before merging any `@agent-relay/*` or `@agentworkforce/sage` bump, run:
    node scripts/check-sage-worker-bundle.mjs
That script is wired into `.github/workflows/ci.yml` and `deploy.yml` as a regression guard. It esbuilds the Sage worker with Workers-friendly conditions, imports the bundle in Node, and invokes `default.fetch()` with a stub `Request` for `/health`, so module-init crashes like the one in `v1.0.2` and handler-level failures surface in under 10 seconds without touching Cloudflare, `wrangler`, or `miniflare`. No external tools required.

## Related

- `workflows/fix-sage-workers-cloud.ts` (this fix)
- `workflows/fix-sage-workers-upstream.ts` (upstream SDK fix)

