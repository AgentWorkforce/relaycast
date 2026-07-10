import { describe, expect, it } from "vitest";
import { build } from "esbuild";

const LAUNCH_WORKER_INIT_FORBIDDEN_INPUTS = [
  "packages/web/lib/integrations/github-proxy-pull-request.ts",
  "packages/web/lib/integrations/nango-service.ts",
];
const LAUNCH_WORKER_LAZY_RUNTIME_INPUTS = [
  "packages/web/lib/integrations/github-proxy-pull-request.ts",
  "packages/web/lib/integrations/nango-service.ts",
];

function expectNoStaticLaunchWorkerInitImports(
  inputs: Record<string, { imports?: Array<{ path: string; kind: string }> }>,
) {
  const launchWorker = inputs["packages/web/lib/workflows/launch-worker.ts"];
  const staticForbiddenImports = launchWorker?.imports?.filter(
    (entry) =>
      entry.kind === "import-statement" &&
      LAUNCH_WORKER_INIT_FORBIDDEN_INPUTS.includes(entry.path),
  );
  expect(staticForbiddenImports).toEqual([]);
}

function expectLazyRuntimeImportBundled(
  inputs: Record<string, { imports?: Array<{ path: string; kind: string }> }>,
) {
  const launchWorker = inputs["packages/web/lib/workflows/launch-worker.ts"];
  expect(launchWorker?.imports).toContainEqual(
    expect.objectContaining({
      path: "packages/web/lib/integrations/github-proxy-pull-request.ts",
      kind: "dynamic-import",
    }),
  );
  for (const runtimeInput of LAUNCH_WORKER_LAZY_RUNTIME_INPUTS) {
    expect(Object.keys(inputs).some((input) => input.endsWith(runtimeInput))).toBe(true);
  }
}

function expectNoForbiddenLaunchWorkerInitInputs(inputs: string[]) {
  for (const forbiddenInput of LAUNCH_WORKER_INIT_FORBIDDEN_INPUTS) {
    expect(inputs.some((input) => input.endsWith(forbiddenInput))).toBe(false);
  }
}

describe("workflow launch worker bundle", () => {
  it("defers GitHub comment integration until the failure-comment path", async () => {
    const result = await build({
      entryPoints: ["packages/web/lib/workflows/launch-worker.ts"],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      write: false,
      metafile: true,
      logLevel: "silent",
      external: [
        "@cloud/core/*",
        "cpu-features",
        "ssh2",
        "sst",
      ],
    });

    const output = result.outputFiles[0]?.text ?? "";
    const inputs = result.metafile?.inputs ?? {};
    const bundledInputs = Object.keys(inputs);

    expectNoStaticLaunchWorkerInitImports(inputs);
    expectLazyRuntimeImportBundled(inputs);
    expect(bundledInputs.filter((input) => input.includes("server-only"))).toEqual([]);
    expect(output).not.toContain("node_modules/server-only/index.js");
    expect(output).not.toContain('from "server-only"');
    expect(output).not.toContain("from 'server-only'");
    expect(output).not.toContain('import("server-only")');
    expect(output).not.toContain("import('server-only')");
  });

  it("keeps the DLQ worker bundle free of server-only too", async () => {
    const result = await build({
      entryPoints: ["packages/web/lib/workflows/launch-dlq-worker.ts"],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      write: false,
      metafile: true,
      logLevel: "silent",
      external: [
        "@cloud/core/*",
        "sst",
      ],
    });

    const output = result.outputFiles[0]?.text ?? "";
    const bundledInputs = Object.keys(result.metafile?.inputs ?? {});

    expectNoForbiddenLaunchWorkerInitInputs(bundledInputs);
    expect(bundledInputs.filter((input) => input.includes("server-only"))).toEqual([]);
    expect(output).not.toContain("node_modules/server-only/index.js");
    expect(output).not.toContain('require("server-only")');
    expect(output).not.toContain("require('server-only')");
    expect(output).not.toContain('from "server-only"');
    expect(output).not.toContain("from 'server-only'");
    expect(output).not.toContain('import("server-only")');
    expect(output).not.toContain("import('server-only')");
  });
});
