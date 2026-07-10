import type { NextConfig } from "next";

const openNextEmptyShim =
  "../../node_modules/@opennextjs/cloudflare/dist/cli/templates/shims/empty.js";

const nextConfig: NextConfig = {
  basePath: "/cloud",
  transpilePackages: ["@agent-relay/dashboard"],
  serverExternalPackages: [
    "@cloud/core",
    "@daytonaio/sdk",
    "@aws-sdk/client-sts",
    "@aws-sdk/client-s3",
    // Keep SST external through Next's server chunking and OpenNext's first
    // bundle pass. The deploy wrapper imports `sst` too; Wrangler must resolve
    // both app and wrapper references in one final bundle so Resource uses one
    // request-populated proxy instance on Cloudflare Workers.
    "sst",
    // Keep @agent-relay/sdk external — it transitively pulls ssh2's
    // native binding (ssh2/lib/protocol/crypto.js), which Turbopack
    // refuses to place in an ESM chunk ("non-ecmascript placeable
    // asset"). Externalizing keeps it as a runtime `require` instead
    // of bundling. Removing this from the externals list breaks
    // `next build` immediately.
    "@agent-relay/sdk",
    "@agent-relay/config",
    "pg",
    "pg-cloudflare",
    "tar",
    "ignore",
    // esbuild ships a per-platform native binary + a README the bundler
    // can't parse ("Unknown module type README.md"). Keep it external for
    // server paths that still use esbuild at request/build time so
    // Turbopack/Next never tries to bundle the native package.
    "esbuild",
    "@nangohq/node",
    "@relayfile/sdk",
    // NOTE: `@agentworkforce/persona-kit` is NO LONGER a `web` dependency.
    // Persona-spec validation now routes through
    // `@cloud/core/proactive-runtime/persona-spec.js` (cloud#2192), and
    // `@cloud/core` is already external (above). So persona-kit is reached
    // only as a transitive dependency of the external core — `web`'s own
    // Next bundle no longer contains persona-kit at all.
    //
    // The historical `@parcel/watcher` hazard is also gone at the source:
    // persona-kit `>= 4.x` DEFERS the `@relayfile/local-mount` →
    // `@parcel/watcher` native import to a dynamic `import()` inside
    // `applyPersonaMount`'s call site (persona-kit `src/mount.ts`), so the
    // barrel no longer eagerly evaluates the native binding. The
    // validation path never mounts, so the binding is never loaded on
    // either OpenNext target (AWS Lambda or the Cloudflare Worker).
    //
    // The `@parcel/watcher` → empty-shim alias below is kept as
    // defense-in-depth for any remaining edge Next itself bundles; it is
    // no longer load-bearing for the persona deploy path.
  ],
  // The Cloudflare Worker never uses @agent-relay/cloud's interactive SSH
  // runtime, but the @agent-relay/sdk workflow barrel re-exports cloud
  // scheduling helpers through @agent-relay/cloud. Next's file tracer follows
  // that package edge into ssh2 and cpu-features, and OpenNext's Worker esbuild
  // pass then fails trying to bundle cpu-features' native .node binding.
  //
  // The trace excludes keep native package files out of the standalone output;
  // the aliases cover @agent-relay/cloud's dynamic import path when OpenNext
  // bundles the Worker.
  outputFileTracingExcludes: {
    "/*": [
      "next.config.ts",
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/*.spec.ts",
      "**/*.spec.tsx",
      "../../node_modules/ssh2/**/*",
      "../../node_modules/cpu-features/**/*",
    ],
  },
  turbopack: {
    resolveAlias: {
      ssh2: openNextEmptyShim,
      "cpu-features": openNextEmptyShim,
      // Defense-in-depth: persona-kit `>= 4.x` already defers the
      // @parcel/watcher native import (see serverExternalPackages note),
      // and persona-kit is now reached only through external @cloud/core.
      // Shim @parcel/watcher anyway so no native binding can enter the
      // bundle through any other edge.
      "@parcel/watcher": openNextEmptyShim,
    },
  },
  webpack: (config) => {
    config.resolve ??= {};
    config.resolve.alias = {
      ...config.resolve.alias,
      ssh2: openNextEmptyShim,
      "cpu-features": openNextEmptyShim,
      "@parcel/watcher": openNextEmptyShim,
    };
    return config;
  },
  // The deploy POST's `@parcel/watcher` prebuild + persona-kit/local-mount
  // tracing-include block that used to live here is gone: persona-kit is no
  // longer a web dependency (validation routes through external @cloud/core,
  // cloud#2192) and persona-kit >= 4.x defers the @parcel/watcher native
  // import, so there is no native prebuild to force into the standalone for
  // either build. The remaining include is unrelated (pg-cloudflare for the
  // DB driver).
  outputFileTracingIncludes: {
    "/*": [
      "../../node_modules/pg-cloudflare/**/*",
    ],
  },
};

export default nextConfig;
