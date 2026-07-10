# Web Handler Test Scaffold

This directory exists so `ws-inttest-impl` retries have a concrete target for
the `packages/web/test/...` deliverables referenced by the current step prompt.

The shared full-stack acceptance bootstrap still lives under
`packages/acceptance/`. This scaffold only removes the path-level mismatch that
previous retries treated as missing baseline state.

## Coverage Metadata

Each handler-suite wrapper file should declare the route paths it owns using one
or more leading comments:

```ts
// @handler /api/v1/workflows/run
// @handler /api/v1/workflows/callback
```

`scripts/check-handler-coverage.ts` reads those comments and compares them
against the stateful handler surface this layer-1 suite tracks.
