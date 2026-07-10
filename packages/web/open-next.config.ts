// AWS adapter config for `@opennextjs/aws build`.
// Cloudflare adapter uses `open-next.config.cloudflare.ts` (see CI
// build step which passes `--openNextConfigPath` to point at it).
//
// Why no `middleware` block: `@opennextjs/aws@4.0.2`'s
// `generateOutput.js:61-71` writes `edgeFunctions.middleware = {...}`
// whenever `config.middleware?.external` is truthy — regardless of
// `override.wrapper` / `override.converter`. SST's `aws/nextjs.ts:640`
// then throws `Lambda@Edge runtime is deprecated` on any non-empty
// `edgeFunctions`. PRs #672 (regions:), #676 (split configs +
// middleware.external), #678 (default.override), and #679 (explicit
// wrapper/converter) all layered configuration on a branch that
// cannot empty `edgeFunctions` while `external` stays `true` — none of
// them produced a green prod deploy. The last successful Cloud deploy
// (commit 86ec8b66, 2026-05-14 16:09Z) predates this config file
// existing at all, i.e. the OpenNext default (`external: false`).
//
// Omitting the `middleware` block leaves `external` at its default
// (`false`), which bundles middleware into the regional server
// Lambda. Cold-start cost (~50-150ms vs Lambda@Edge for users outside
// us-east-1) is an accepted trade — most /cloud/* traffic moves to
// the CF Worker (CloudWebWorker) which serves at the edge globally,
// and the few Lambda-only routes are not latency-sensitive enough to
// need middleware-at-edge.
//
// No type annotation: the `open-next/types/open-next` package is not
// a direct dep here (transitive via @opennextjs/aws) and the type
// isn't surfaced in a path that `tsc --noEmit` can resolve. The
// OpenNext-AWS adapter reads this file at build time as plain
// JSON-shaped data — no compile-time validation needed.
export default {
  // We do not use ISR/tag revalidation for the AWS Lambda path. Leaving the
  // OpenNext tag cache enabled makes SST run a deploy-time RevalidationSeed
  // Lambda on every production deploy; recent runs spent 15+ minutes there.
  dangerous: {
    disableTagCache: true,
  },
  // `default` is required by @opennextjs/aws even if empty (validator
  // rejects with "config.default cannot be empty"). The `override: {}`
  // inside it is the documented "no overrides — use library defaults"
  // shape per https://opennext.js.org/config#configuration-file.
  default: {
    override: {},
  },
};
