import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ANSI_ESCAPE_PATTERN = /\x1B\[[0-9;]*m/g;
const REPO_ROOT = new URL("../..", import.meta.url);

function stripAnsi(value: string): string {
  return value.replaceAll(ANSI_ESCAPE_PATTERN, "");
}

function withoutNestedTestEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitizedEnv: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(sanitizedEnv)) {
    if (
      key === "VITEST"
      || key.startsWith("VITEST_")
      || key === "NODE_TEST_CONTEXT"
      || key.startsWith("NODE_TEST_")
    ) {
      delete sanitizedEnv[key];
    }
  }
  sanitizedEnv.NO_COLOR = "1";
  sanitizedEnv.FORCE_COLOR = "0";
  return sanitizedEnv;
}

test("deploy manager hosted-agent integration bundles and persists trigger metadata", async () => {
  const vitestEntrypoint = new URL("../../node_modules/vitest/vitest.mjs", import.meta.url);
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [
      vitestEntrypoint.pathname,
      "run",
      "--reporter=verbose",
      "--config",
      "tests/proactive-runtime/vitest/vitest.config.ts",
      "tests/proactive-runtime/vitest/deploy-manager.integration.test.ts",
    ],
    {
      cwd: REPO_ROOT,
      env: withoutNestedTestEnv(process.env),
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  const combinedOutput = stripAnsi(`${stdout}\n${stderr}`);
  assert.match(
    combinedOutput,
    /bundles, provisions, uploads, and persists a hosted agent deployment with trigger metadata/,
  );
});
