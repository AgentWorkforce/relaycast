// WS-F1F2-HARDEN: this test is the canonical "Worker import safety" gate.
//
// History: PR #758 introduced both a shallow per-file substring scan and an
// esbuild metafile transitive bundle scan. The #762 outage (a pg-backed dedup
// store reached the Worker bundle via a transitive dynamic import that the
// shallow scan could not see) proved the shallow scan is structurally
// insufficient. WS-F1F2-HARDEN deletes the shallow scan and promotes the
// transitive esbuild metafile scan to the sole, authoritative bar.
//
// How it works:
//   * `entryPoints` enumerates every file that the deployed Cloudflare Worker
//     can reach. esbuild then follows every static and dynamic-string import
//     transitively. The `inputs` keys of the resulting metafile are the
//     exhaustive set of modules that would ship to the Worker.
//   * `platform: "browser"` makes esbuild refuse to resolve Node built-ins,
//     mimicking Cloudflare's runtime — except we explicitly mark as `external`
//     the Node built-ins that Cloudflare Workers actually support (via the
//     `nodejs_compat` flag). The result: any module that uses a real Node-only
//     built-in (`fs`, `net`, `dns`, `tls` as bare specifiers, etc.) makes the
//     build throw — this is exactly how `pg` is caught (see #762).
//   * `conditions: ["workerd", "worker", ...]` makes esbuild honour the
//     Cloudflare-style conditional exports map, and resolves the workspace
//     alias `@cloud/core/...js` to `packages/core/dist/...js`.
//   * After a successful bundle we then scan `metafile.inputs` against
//     `FORBIDDEN_INPUT_PATTERNS` so we also catch modules that bundle "cleanly"
//     under the externals but should never be in the Worker (e.g.
//     `@relayfile/sdk`, `@aws-sdk/*`).
//
// Non-vacuous proof: a second test below temporarily injects a `pg` import
// into a Worker-reachable module and asserts the bundle build rejects it. If
// someone ever weakens the externals list or `platform` such that pg can be
// bundled, that test breaks loudly.
//
// Important: this test requires `@cloud/core` to be built (`dist/`). CI runs
// `npm run -w @cloud/core build` before this test. Local runs without a built
// core will fail with an explicit "@cloud/core dist missing" hint.

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, it, before } from "node:test";
import path from "node:path";
import { build, type BuildOptions } from "esbuild";

// Worker entrypoints — anything reachable from these will be in the Worker
// bundle. `packages/webhook-worker/src/index.ts` is the actual Cloudflare
// Worker entry (see `packages/webhook-worker/wrangler.toml::main`). The
// remaining entries either feed into the Worker via dynamic import or are
// dormant code that will be wired into the consumer in upcoming PRs — gating
// them now keeps them Worker-safe pre-flip (the WS-OPTION-B `enabled` switch
// must never trip a #762-class regression).
const WORKER_ENTRYPOINTS = [
  // Real Worker entrypoint (fetch + queue handlers, declared in wrangler.toml)
  "packages/webhook-worker/src/index.ts",
  // Reached by `index.ts -> queue()`; explicitly listed for breadth so an
  // isolated regression in dedup/consumer wiring is caught even if some
  // future refactor moves the static import.
  "packages/webhook-worker/src/queue-consumer.ts",
  // Hot trap from #762 — pg-backed dedup store; explicit entry for safety.
  "packages/webhook-worker/src/dedup.ts",
  // NOTE: services/agent-gateway/src/worker.ts is intentionally NOT in this
  // aggregate entrypoint list. agent-gateway legitimately imports
  // @relayfile/adapter-* + transitively pulls @relayfile/sdk, which the
  // shared FORBIDDEN_INPUT_PATTERNS below correctly bans for the
  // webhook-worker bundle. agent-gateway gets its own scan with a
  // loosened forbidden list in the dedicated it() block further down.
  // Dormant @cloud/core sync surface that will be statically linked from
  // the consumer when per-provider `enabled` flips. Pre-scan keeps them
  // Worker-safe so an enable-flip cannot regress the bundle.
  "packages/core/src/sync/nango-sync-runtime.ts",
  "packages/core/src/sync/nango-provider-parity.ts",
  "packages/core/src/sync/nango-provider-registry.generated.ts",
  "packages/core/src/sync/provider-write-planner.ts",
  "packages/core/src/sync/relayfile-http-writer.ts",
  "packages/webhook-worker/src/d1-dedup.ts",
];

// Node built-ins available on Cloudflare Workers when the
// `nodejs_compat` compatibility flag is set (see
// `packages/webhook-worker/wrangler.toml`). These are marked `external`
// so the bundle scan does not falsely flag legitimate, Worker-supported
// usage. Anything NOT on this list — `fs`, `child_process`,
// `@parcel/watcher`, `pg`, etc. — is reported by esbuild as a resolve
// error and surfaces as a test failure.
const WORKER_COMPATIBLE_EXTERNALS = [
  "node:assert",
  "node:async_hooks",
  "node:buffer",
  "node:crypto",
  "node:diagnostics_channel",
  "node:dns",
  "node:fs",
  "node:fs/promises",
  "node:events",
  "node:net",
  "node:path",
  "node:process",
  "node:querystring",
  "node:stream",
  "node:string_decoder",
  "node:timers",
  "node:tls",
  "node:url",
  "node:util",
  "node:zlib",
  "cloudflare:workers",
  // Bare-specifier aliases that the `nodejs_compat` flag also resolves.
  "assert",
  "async_hooks",
  "buffer",
  "crypto",
  "events",
  "fs",
  "fs/promises",
  "stream",
  "util",
  "url",
  "querystring",
  "path",
  "process",
];

// Modules that, even if esbuild could bundle them, must not appear in the
// Worker — either because they are pure Lambda glue (`aws-lambda`,
// `@aws-sdk/*`) or because they require a Node runtime we don't have on
// Workers even with `nodejs_compat` (`@parcel/watcher`, `pg`, `postgres`,
// `@relayfile/sdk`, ...). The first defence is esbuild's resolver under
// `platform: "browser"`; this list catches the rest.
const FORBIDDEN_INPUT_PATTERNS: RegExp[] = [
  /@aws-sdk\//,
  /aws-lambda/,
  /@relayfile\/sdk/,
  /@relayfile\/adapter-/,
  /@parcel\/watcher/,
  /(^|[\\/])pg([\\/]|$)/,
  /(^|[\\/])pg-/,
  /(^|[\\/])postgres([\\/]|$)/,
  /node_modules[\\/]pg[\\/]/,
  /node_modules[\\/]postgres[\\/]/,
];

// `@cloud/core` is a workspace package. esbuild needs the conditional
// exports map to resolve Worker imports such as
// `@cloud/core/observability/structured-log.js` to
// `packages/core/dist/observability/structured-log.js`. We require that dist
// exists so the resolution is deterministic; otherwise the bundle scan would
// silently stub the alias and miss transitive content.
const CORE_DIST_MARKER = "packages/core/dist/observability/structured-log.js";

function bundleOptions(extraEntryContents?: Record<string, string>): BuildOptions {
  return {
    entryPoints: WORKER_ENTRYPOINTS.map((file) => path.resolve(file)),
    bundle: true,
    format: "esm",
    metafile: true,
    outdir: "out",
    platform: "browser",
    write: false,
    target: "es2022",
    logLevel: "silent",
    external: WORKER_COMPATIBLE_EXTERNALS,
    // workerd/worker first so `@cloud/core` exports resolve to dist.
    conditions: ["workerd", "worker", "browser", "import", "default"],
    // No esbuild plugin needed: workspace symlink in node_modules/@cloud/core
    // points at packages/core, and its package.json `exports` map resolves
    // `@cloud/core/sync/*.js` to `./dist/sync/*.js`.
    ...(extraEntryContents ?? {}),
  };
}

describe("B1 Worker import safety (transitive bundle scan)", () => {
  before(() => {
    assert.ok(
      existsSync(path.resolve(CORE_DIST_MARKER)),
      `@cloud/core dist missing — run \`npm run -w @cloud/core build\` before this test. ` +
        `The bundle scan cannot follow @cloud/core dynamic imports without it.`,
    );
  });

  it("bundles every Worker entrypoint without resolving Worker-incompatible Node built-ins", async () => {
    const result = await build(bundleOptions());
    assert.ok(result.metafile, "esbuild must produce a metafile");
    // If build() returned without throwing, no Node-only built-in was needed.
    // (Resolve-time failures are how `pg` / `fs` / `child_process` / etc. are
    // caught — they throw from `build()` and surface as test failures.)
  });

  it("Worker bundle inputs contain no forbidden modules", async () => {
    const result = await build(bundleOptions());
    const inputs = Object.keys(result.metafile?.inputs ?? {});
    assert.ok(inputs.length > 0, "esbuild must report at least one input");
    // Sanity: the Worker entry's @cloud/core import must have been followed —
    // proves the workspace alias resolved into core dist (not stubbed
    // external). Without this, a future regression that accidentally
    // externalises @cloud/core would render the scan vacuous.
    assert.ok(
      inputs.some((input) => input.includes(CORE_DIST_MARKER)),
      `Worker bundle must transitively include ${CORE_DIST_MARKER} ` +
        `(proves @cloud/core resolved into dist, not external-stubbed). ` +
        `Got inputs: ${inputs.slice(0, 20).join(", ")}`,
    );
    for (const input of inputs) {
      for (const forbidden of FORBIDDEN_INPUT_PATTERNS) {
        assert.equal(
          forbidden.test(input),
          false,
          `Worker bundle must not include ${input} (matched forbidden pattern ${forbidden})`,
        );
      }
    }
  });

  // ----- agent-gateway: separate scan with its own bar ------------------
  // agent-gateway (services/agent-gateway/) is a distinct CF Worker deployed
  // via SST (infra/agent-gateway.ts, issue #827). It legitimately uses
  // @relayfile/adapter-* packages for thread/summary expansion + reaches
  // @relayfile/sdk transitively via @agent-relay/events → @agent-relay/sdk.
  // It must therefore allow patterns the webhook-worker scan rightly forbids.
  //
  // Known runtime fragility documented here:
  //   - @relayfile/sdk@0.7.15 (transitive via @agent-relay/sdk) re-exports
  //     dist/mount-launcher.js and dist/cloud-login.js from its index.js with
  //     `export *`. Those files use node:child_process which is NOT
  //     Worker-compatible (even with nodejs_compat). Because the SDK's
  //     package.json has sideEffects: null, esbuild cannot tree-shake them
  //     out of the bundle. agent-gateway never CALLS those exports at
  //     runtime, so it works — but if any future code path does call them,
  //     it WILL crash on the Worker. Externalize node:child_process here so
  //     the bundle-scan can complete; track the proper fix
  //     (@relayfile/sdk splits CLI code into a subpath export) at a
  //     follow-up issue.
  //   - node:http is genuinely Worker-safe under nodejs_compat (used by
  //     other transitive deps of @relayfile/sdk); it just isn't in the
  //     shared externals list.
  const AGENT_GATEWAY_ENTRYPOINT = "services/agent-gateway/src/worker.ts";
  const AGENT_GATEWAY_ADDITIONAL_EXTERNALS = [
    "node:http",
    "http",
    "node:child_process",
    "child_process",
  ];
  const AGENT_GATEWAY_FORBIDDEN_PATTERNS: RegExp[] = [
    /@aws-sdk\//,
    /aws-lambda/,
    /@parcel\/watcher/,
    /(^|[\\/])pg([\\/]|$)/,
    /(^|[\\/])pg-/,
    /(^|[\\/])postgres([\\/]|$)/,
    /node_modules[\\/]pg[\\/]/,
    /node_modules[\\/]postgres[\\/]/,
    // Intentionally NOT /@relayfile\/sdk/ or /@relayfile\/adapter-/ — those
    // are legitimate for agent-gateway, see comment block above.
  ];
  function agentGatewayBundleOptions(): BuildOptions {
    return {
      entryPoints: [path.resolve(AGENT_GATEWAY_ENTRYPOINT)],
      bundle: true,
      format: "esm",
      metafile: true,
      outdir: "out",
      platform: "browser",
      write: false,
      target: "es2022",
      logLevel: "silent",
      external: [...WORKER_COMPATIBLE_EXTERNALS, ...AGENT_GATEWAY_ADDITIONAL_EXTERNALS],
      conditions: ["workerd", "worker", "browser", "import", "default"],
    };
  }

  it("agent-gateway bundle resolves without Worker-incompatible Node built-ins (after documented tolerated externals)", async () => {
    const result = await build(agentGatewayBundleOptions());
    assert.ok(result.metafile, "esbuild must produce a metafile for agent-gateway");
  });

  it("agent-gateway bundle inputs contain no forbidden modules (loosened-list)", async () => {
    const result = await build(agentGatewayBundleOptions());
    const inputs = Object.keys(result.metafile?.inputs ?? {});
    assert.ok(inputs.length > 0, "esbuild must report at least one input for agent-gateway");
    for (const input of inputs) {
      for (const forbidden of AGENT_GATEWAY_FORBIDDEN_PATTERNS) {
        assert.equal(
          forbidden.test(input),
          false,
          `agent-gateway bundle must not include ${input} (matched forbidden pattern ${forbidden})`,
        );
      }
    }
  });

  // ----- nango-sync-workflow: CF Workflow entrypoint scan ---------------
  // NangoSyncWorkflow is a Cloudflare Workflow class that must never pull pg
  // into the bundle. Before the provider-readiness-core split, importing
  // markProviderInitialSync* from provider-readiness.ts dragged in db/client.ts
  // → pg — a #762-class regression. This dedicated scan catches any future
  // regression on that path while tolerating @relayfile/sdk (which the main
  // webhook-worker scan rightly forbids, but the workflow legitimately uses).
  const NANGO_SYNC_WORKFLOW_ENTRYPOINT =
    "packages/core/src/sync/nango-sync-workflow.ts";
  const NANGO_SYNC_WORKFLOW_ADDITIONAL_EXTERNALS = [
    "node:os",
    "os",
    "node:https",
    "https",
    "node:http",
    "http",
    "node:child_process",
    "child_process",
    "node:module",
    "module",
    "node:dns/promises",
  ];
  const NANGO_SYNC_WORKFLOW_FORBIDDEN_PATTERNS: RegExp[] = [
    /@aws-sdk\//,
    /aws-lambda/,
    /@parcel\/watcher/,
    // Catch the `pg` npm package itself (node_modules/pg/).
    /node_modules[\\/]pg[\\/]/,
    // Catch pg-* npm packages (pg-types, pg-protocol, …) at the top-level of
    // node_modules. Use node_modules/ prefix to avoid false-positives on
    // `drizzle-orm/pg-core` which is a safe schema-builder with no pg dep.
    /node_modules[\\/]pg-/,
    /node_modules[\\/]postgres[\\/]/,
    // Intentionally NOT /@relayfile\/sdk/ — the workflow uses it legitimately.
    // Intentionally NOT /(^|[\\/])pg-/ — too broad; matches drizzle-orm/pg-core.
  ];
  function nangoSyncWorkflowBundleOptions(): BuildOptions {
    return {
      entryPoints: [path.resolve(NANGO_SYNC_WORKFLOW_ENTRYPOINT)],
      bundle: true,
      format: "esm",
      metafile: true,
      outdir: "out",
      platform: "browser",
      write: false,
      target: "es2022",
      logLevel: "silent",
      external: [
        ...WORKER_COMPATIBLE_EXTERNALS,
        ...NANGO_SYNC_WORKFLOW_ADDITIONAL_EXTERNALS,
      ],
      conditions: ["workerd", "worker", "browser", "import", "default"],
    };
  }

  it("nango-sync-workflow bundle resolves without Worker-incompatible Node built-ins", async () => {
    const result = await build(nangoSyncWorkflowBundleOptions());
    assert.ok(
      result.metafile,
      "esbuild must produce a metafile for nango-sync-workflow",
    );
  });

  it("nango-sync-workflow bundle inputs contain no forbidden modules (pg-free assertion)", async () => {
    const result = await build(nangoSyncWorkflowBundleOptions());
    const inputs = Object.keys(result.metafile?.inputs ?? {});
    assert.ok(
      inputs.length > 0,
      "esbuild must report at least one input for nango-sync-workflow",
    );
    for (const input of inputs) {
      for (const forbidden of NANGO_SYNC_WORKFLOW_FORBIDDEN_PATTERNS) {
        assert.equal(
          forbidden.test(input),
          false,
          `nango-sync-workflow bundle must not include ${input} (matched forbidden pattern ${forbidden})`,
        );
      }
    }
  });

  // ----- Non-vacuous self-test (F0-rigor) -------------------------------
  // Temporarily inject a `pg` import into a Worker-reachable file and assert
  // that the bundle scan rejects it. This guards against future weakening of
  // the externals list / platform / entrypoints that would make the scan
  // pass-by-default. If this test goes green WITHOUT a real failure, the
  // hardening has regressed.
  it("self-test: an induced transitive `pg` import in a Worker file makes the bundle scan fail", async () => {
    const target = path.resolve("packages/webhook-worker/src/dedup.ts");
    const original = readFileSync(target, "utf8");
    const injected = `import pg from "pg";\nvoid pg;\n` + original;
    let buildThrew = false;
    let errorMessage = "";
    try {
      writeFileSync(target, injected);
      try {
        await build(bundleOptions());
      } catch (err) {
        buildThrew = true;
        errorMessage = String((err as Error)?.message ?? err);
      }
    } finally {
      writeFileSync(target, original);
    }
    assert.ok(
      buildThrew,
      "Inducing `import 'pg'` in a Worker entrypoint must make the bundle scan throw, " +
        "but it did not. The scan has been weakened — investigate the externals " +
        "list / platform setting / entrypoints.",
    );
    // Spot-check the failure mode matches the #762 detection signature.
    assert.match(
      errorMessage,
      /Could not resolve "(fs|net|dns|tls)"/,
      `Bundle scan threw, but error did not mention the expected pg-driver Node-only ` +
        `built-ins (fs/net/dns/tls). Got: ${errorMessage.slice(0, 400)}`,
    );
  });
});
