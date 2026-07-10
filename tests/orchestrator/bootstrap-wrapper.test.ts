import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateBootstrapScript } from "../../packages/core/src/bootstrap/script-generator.js";
import {
  BOOTSTRAP_INNER_TEMPLATE,
  BOOTSTRAP_WRAPPER_TEMPLATE,
} from "../../packages/core/src/bootstrap/templates.generated.js";

type BootstrapScripts = {
  wrapper: string;
  inner: string;
};

function generateScripts(): BootstrapScripts {
  const result = generateBootstrapScript({ fileType: "yaml" }) as unknown;

  if (typeof result !== "object" || result === null) {
    throw new TypeError("generateBootstrapScript must return an object");
  }
  assert.equal(
    typeof result,
    "object",
    "generateBootstrapScript must return { wrapper, inner }, not a single script string",
  );
  assert.ok(result !== null, "generateBootstrapScript must return an object");
  assert.ok(result !== undefined, "generateBootstrapScript must return an object");
  assert.ok("wrapper" in result, "generateBootstrapScript result must include wrapper");
  assert.ok("inner" in result, "generateBootstrapScript result must include inner");

  const scripts = result as Partial<BootstrapScripts>;
  assert.equal(typeof scripts.wrapper, "string", "wrapper must be a string");
  assert.equal(typeof scripts.inner, "string", "inner must be a string");
  return scripts as BootstrapScripts;
}

describe("bootstrap startup crash wrapper", () => {
  it("returns separate wrapper and inner bootstrap scripts", () => {
    const scripts = generateScripts();

    assert.ok(scripts.wrapper.startsWith("#!/usr/bin/env node"));
    assert.ok(scripts.inner.startsWith("#!/usr/bin/env node"));
    assert.notEqual(scripts.wrapper, scripts.inner);
  });

  it("keeps npm and local package imports out of the wrapper", () => {
    const { wrapper } = generateScripts();
    const staticImports = [...wrapper.matchAll(/import\s+[^;]*?\s+from\s+['"]([^'"]+)['"]/g)];

    for (const match of staticImports) {
      assert.ok(
        match[1].startsWith("node:"),
        `bootstrap wrapper static imports must be node:* only, got ${match[1]}`,
      );
    }

    assert.ok(!wrapper.includes("@agent-relay/"), "wrapper must not import npm packages");
    assert.ok(!wrapper.includes("@daytonaio/"), "wrapper must not import npm packages");
    assert.ok(!wrapper.includes("./lib/"), "wrapper must not import generated local library files");
  });

  it("loads the inner bootstrap through a guarded dynamic import", () => {
    const { wrapper } = generateScripts();

    assert.match(
      wrapper,
      /try\s*{[\s\S]*await\s+import\(['"]\.\/bootstrap-inner\.mjs['"]\)[\s\S]*}\s*catch\s*\(/,
      "wrapper must catch failures from importing bootstrap-inner.mjs",
    );
  });

  it("reports startup import crashes to the workflow callback before exiting", () => {
    const { wrapper } = generateScripts();

    assert.ok(wrapper.includes("CALLBACK_URL"), "wrapper must read CALLBACK_URL from env");
    assert.ok(wrapper.includes("CALLBACK_TOKEN"), "wrapper must read CALLBACK_TOKEN from env");
    assert.ok(wrapper.includes("RUN_ID"), "wrapper must include RUN_ID in the callback payload");
    assert.match(wrapper, /fetch\(\s*CALLBACK_URL\s*,/, "wrapper must POST to CALLBACK_URL");
    assert.match(wrapper, /method:\s*['"]POST['"]/, "callback request must use POST");
    assert.match(wrapper, /status:\s*['"]failed['"]/, "callback payload must mark the run failed");
    assert.match(
      wrapper,
      /bootstrap startup crash/i,
      "reported error should identify the failure as a bootstrap startup crash",
    );
    assert.match(wrapper, /process\.exit(?:Code\s*=\s*1|\(1\))/, "wrapper must exit non-zero");
  });

  it("bounds callback reporting latency and error payload size", () => {
    const { wrapper } = generateScripts();

    assert.ok(wrapper.includes("AbortController"), "wrapper must abort callback POSTs");
    assert.match(wrapper, /5_?000/, "wrapper callback timeout must be 5 seconds");
    assert.match(wrapper, /4_?000/, "wrapper must cap the reported error body at 4KB");
  });

  it("keeps the existing bootstrap imports and runner logic in the inner script", () => {
    const { inner } = generateScripts();

    assert.ok(inner.includes("import { WorkflowRunner }"), "inner script must run workflows");
    assert.ok(inner.includes("import { Daytona }"), "inner script must keep Daytona integration");
    assert.ok(inner.includes("import { Reporter }"), "inner script must keep callback reporting");
    assert.ok(inner.includes("Bootstrap fatal error"), "inner script must retain runtime fatal handling");
  });

  it("keeps embedded bootstrap templates in sync with source files", () => {
    assert.equal(
      BOOTSTRAP_WRAPPER_TEMPLATE,
      readFileSync(
        new URL("../../packages/core/src/bootstrap/templates/bootstrap-wrapper.mjs", import.meta.url),
        "utf8",
      ),
    );
    assert.equal(
      BOOTSTRAP_INNER_TEMPLATE,
      readFileSync(
        new URL("../../packages/core/src/bootstrap/templates/bootstrap-inner.mjs", import.meta.url),
        "utf8",
      ),
    );
  });

  it("generates bootstrap scripts that parse as plain JavaScript", () => {
    const dir = mkdtempSync(join(tmpdir(), "cloud-bootstrap-check-"));
    try {
      for (const templateName of ["bootstrap-wrapper.mjs", "bootstrap-inner.mjs"]) {
        execFileSync(
          process.execPath,
          [
            "--check",
            new URL(
              `../../packages/core/src/bootstrap/templates/${templateName}`,
              import.meta.url,
            ).pathname,
          ],
          { stdio: "pipe" },
        );
      }
      for (const fileType of ["yaml", "typescript", "python", "config"] as const) {
        const scripts = generateBootstrapScript({ fileType });
        const wrapperPath = join(dir, `${fileType}-bootstrap.mjs`);
        const innerPath = join(dir, `${fileType}-bootstrap-inner.mjs`);
        writeFileSync(wrapperPath, scripts.wrapper, "utf8");
        writeFileSync(innerPath, scripts.inner, "utf8");

        execFileSync(process.execPath, ["--check", wrapperPath], { stdio: "pipe" });
        execFileSync(process.execPath, ["--check", innerPath], { stdio: "pipe" });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("launcher uploads both bootstrap wrapper and inner script files", () => {
    const launcherSource = readFileSync(
      new URL("../../packages/core/src/bootstrap/launcher.ts", import.meta.url),
      "utf8",
    );

    assert.match(
      launcherSource,
      /uploadFile\(\s*Buffer\.from\([^)]*\.wrapper\)\s*,\s*`\$\{home\}\/bootstrap\.mjs`/,
      "launcher must upload the wrapper to bootstrap.mjs",
    );
    assert.match(
      launcherSource,
      /uploadFile\(\s*Buffer\.from\([^)]*\.inner\)\s*,\s*`\$\{home\}\/bootstrap-inner\.mjs`/,
      "launcher must upload the inner script to bootstrap-inner.mjs",
    );
    assert.match(
      launcherSource,
      /nohup node \$\{home\}\/bootstrap\.mjs/,
      "launcher should still execute the wrapper entrypoint",
    );
  });
});
