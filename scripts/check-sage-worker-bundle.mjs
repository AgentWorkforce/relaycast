/**
 * Cloudflare Workers surfaces error 10021 when a module crashes during upload-time
 * validation, before any request handler can run.
 * One common trigger is Node-oriented top-level code such as createRequire(import.meta.url)
 * surviving bundling and then evaluating with an unsupported or missing import.meta.url.
 * That looks like an upload problem, but the real failure is module initialization.
 * This probe bundles the Sage worker with worker-friendly esbuild conditions,
 * imports the emitted bundle locally under Node, and then exercises /health.
 * It provides a fast reproduction path for both validator-style module-init failures
 * and handler/runtime failures without wrangler, Miniflare, or Cloudflare API calls.
 */

import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptFile = fileURLToPath(import.meta.url);
const scriptsDir = dirname(scriptFile);
const repoRoot = dirname(scriptsDir);
const entryPoint = join(repoRoot, "packages", "sage-worker", "src", "worker.ts");
const tmpDir = join(repoRoot, "tmp");
const outfile = join(tmpDir, "sage-worker.probe.mjs");

mkdirSync(tmpDir, { recursive: true });

try {
  await build({
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    format: "esm",
    target: "es2022",
    // platform: 'node' auto-externalizes all node built-ins (both "node:*"
    // and bare-name forms like "path", "assert"). In a real deploy those
    // are resolved at runtime by workerd's nodejs_compat layer; in this
    // probe they're resolved by Node itself. Either way, the bundle only
    // needs to keep the import specifiers intact.
    platform: "node",
    mainFields: ["module", "main"],
    conditions: ["worker", "browser", "import"],
    nodePaths: [
      join(repoRoot, "node_modules"),
      join(repoRoot, "packages", "sage-worker", "node_modules"),
    ],
    // esbuild's CJS->ESM wrapper emits a __require2 stub that delegates to
    // a runtime `require` if one exists, and throws otherwise. Some CJS
    // dependencies (form-data, combined-stream, ...) call require() at
    // evaluation time, so the stub needs a real require. Workerd with
    // nodejs_compat provides one natively; in this probe we synthesize it
    // via createRequire(import.meta.url), which Node supports.
    banner: {
      js: "import { createRequire as __sageProbeCreateRequire } from 'node:module'; const require = __sageProbeCreateRequire(import.meta.url);",
    },
    logLevel: "error",
    logOverride: {
      "empty-import-meta": "silent",
    },
  });
} catch (err) {
  console.error("FAIL: module init");
  console.error(err?.stack ?? String(err));
  process.exit(1);
}

let mod;

try {
  mod = await import(pathToFileURL(outfile).href);
} catch (err) {
  console.error("FAIL: module init");
  console.error(err?.stack ?? String(err));
  process.exit(1);
}

try {
  if (typeof mod.default?.fetch !== "function") {
    throw new Error("Bundled module default export is missing a fetch handler");
  }

  const req = new Request("http://probe.local/health");
  // Mirror the production runtime-binding set documented in
  // services/sage/README.md. assertRuntimeBindings (Sage's global
  // middleware) has two equivalent code paths:
  //
  //   (1) production — CLOUD_API_URL + CLOUD_API_TOKEN are both set
  //       and Slack/GitHub connection IDs are resolved dynamically
  //       via the cloud web app. NANGO_SLACK_CONNECTION_ID is NOT
  //       set in the deployed Worker.
  //   (2) local single-tenant dev — CLOUD_API_URL and CLOUD_API_TOKEN
  //       are both unset and NANGO_SLACK_CONNECTION_ID acts as a
  //       static fallback.
  //
  // We stub the production path. CLOUD_API_URL + CLOUD_API_TOKEN must
  // be set together or unset together (assertRuntimeBindings throws on
  // a pair-consistency violation). /health itself never reads any
  // binding value — the middleware only checks existence/pairing —
  // so the actual strings are irrelevant. DEDUP and THREADS are KV
  // namespace handles in the deployed Worker; the middleware just
  // checks truthiness, so empty objects suffice.
  const env = {
    NANGO_SECRET_KEY: "probe-nango-key",
    OPENROUTER_API_KEY: "probe-openrouter-key",
    SUPERMEMORY_API_KEY: "probe-supermemory-key",
    CLOUD_API_URL: "https://probe.local/cloud",
    CLOUD_API_TOKEN: "probe-cloud-api-token",
    DEDUP: {},
    THREADS: {},
  };
  const ctx = {
    waitUntil: () => {},
    passThroughOnException: () => {},
  };

  const res = await mod.default.fetch(req, env, ctx);

  if (res.status !== 200) {
    throw new Error(`Expected /health to return 200, received ${res.status}`);
  }

  const body = await res.json();

  if (body?.status !== "ok") {
    throw new Error(
      `Expected /health body.status to be "ok", received ${JSON.stringify(body)}`,
    );
  }
} catch (err) {
  console.error("FAIL: /health");
  console.error(err?.stack ?? String(err));
  process.exit(1);
}

console.log("OK: sage worker bundle initialized cleanly and /health returned 200");
