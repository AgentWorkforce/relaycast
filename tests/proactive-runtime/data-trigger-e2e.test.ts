import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ANSI_ESCAPE_PATTERN = /\x1B\[[0-9;]*m/g;

function stripAnsi(value: string): string {
  return value.replaceAll(ANSI_ESCAPE_PATTERN, "");
}

function withoutVitestEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitizedEnv: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(sanitizedEnv)) {
    if (key === "VITEST" || key.startsWith("VITEST_")) {
      delete sanitizedEnv[key];
    }
  }
  sanitizedEnv.NO_COLOR = "1";
  sanitizedEnv.FORCE_COLOR = "0";
  return sanitizedEnv;
}

test("M2 data trigger E2E wrapper: runs the real gateway watch-boundary test in services/agent-gateway/tests/data-trigger-e2e.test.ts", async () => {
  const vitestEntrypoint = new URL("../../node_modules/vitest/vitest.mjs", import.meta.url);

  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [
      vitestEntrypoint.pathname,
      "run",
      "--config",
      "services/agent-gateway/vitest.config.ts",
      "services/agent-gateway/tests/data-trigger-e2e.test.ts",
    ],
    {
      cwd: new URL("../..", import.meta.url),
      env: withoutVitestEnv(process.env),
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  const combinedOutput = stripAnsi(`${stdout}\n${stderr}`);
  assert.match(combinedOutput, /Tests[^0-9]+1 passed/);
});
