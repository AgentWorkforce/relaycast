import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = ".github/scripts/delete-persona-compile-worker.sh";

test("persona compile worker delete allows pr stages", () => {
  const temp = mkdtempSync(join(tmpdir(), "persona-delete-guard-"));
  try {
    const bin = join(temp, "bin");
    mkdirSync(bin);
    const wrangler = join(bin, "wrangler");
    writeFileSync(
      wrangler,
      "#!/usr/bin/env bash\nprintf '%s\\n' \"$@\" > \"$WRANGLER_ARGS_FILE\"\n",
      { mode: 0o755 },
    );
    const argsFile = join(temp, "args.txt");

    const result = spawnSync("bash", [script], {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        SST_STAGE: "pr-123",
        WRANGLER_BIN: wrangler,
        WRANGLER_ARGS_FILE: argsFile,
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /deleting preview worker persona-compile-worker-pr-123/);
    assert.equal(readText(argsFile), "delete\npersona-compile-worker-pr-123\n--force\n");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("persona compile worker delete refuses non-preview stages before wrangler", () => {
  const temp = mkdtempSync(join(tmpdir(), "persona-delete-guard-"));
  try {
    const wrangler = join(temp, "missing-wrangler");
    const result = spawnSync("bash", [script], {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        SST_STAGE: "production",
        WRANGLER_BIN: wrangler,
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 2);
    assert.match(result.stderr, /refusing to delete non-preview persona compile worker/);
    assert.doesNotMatch(result.stderr, /wrangler binary not found/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

function readText(path) {
  return readFileSync(path, "utf8");
}
