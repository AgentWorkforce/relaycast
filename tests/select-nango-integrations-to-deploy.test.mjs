import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = new URL("..", import.meta.url);
const selector = new URL("../scripts/select-nango-integrations-to-deploy.mjs", import.meta.url);
const nangoConfig = new URL("../nango-integrations/.nango/nango.json", import.meta.url);

const allIntegrations = JSON.parse(readFileSync(nangoConfig, "utf8"))
  .map((entry) => entry?.providerConfigKey)
  .filter((value) => typeof value === "string" && value.length > 0);

describe("select-nango-integrations-to-deploy", () => {
  it("treats an empty manual value as absent on push runs", () => {
    const output = runSelector([
      "--event",
      "push",
      "--before",
      "0000000000000000000000000000000000000000",
      "--after",
      "d0b130eee0c7a7cf937e2da5d767fdad8f506f1b",
      "--manual",
      "",
    ]);

    assert.deepEqual(output, allIntegrations);
  });

  it("resolves manual aliases when a manual integration is provided", () => {
    const output = runSelector(["--event", "workflow_dispatch", "--manual", "github"]);

    assert.deepEqual(output, ["github-relay"]);
  });

  it("keeps parsing flags after an empty manual value", () => {
    const output = runSelector([
      "--event",
      "push",
      "--manual",
      "",
      "--before",
      "0000000000000000000000000000000000000000",
      "--after",
      "d0b130eee0c7a7cf937e2da5d767fdad8f506f1b",
    ]);

    assert.deepEqual(output, allIntegrations);
  });

  it("deploys all integrations when the push diff range is unavailable", () => {
    const output = runSelector([
      "--event",
      "push",
      "--before",
      "09a2ebeda40dea58b0fe3f925b99e379b8847bad",
      "--after",
      "d0b130eee0c7a7cf937e2da5d767fdad8f506f1b",
      "--manual",
      "",
    ]);

    assert.deepEqual(output, allIntegrations);
  });

  it("deploys all integrations when post-deploy verification scripts change", () => {
    withFakeGitDiff(
      "scripts/assert-nango-webhook-subscriptions.mjs\nscripts/refresh-nango-webhook-syncs.mjs\n",
      (env) => {
        const output = runSelector(
          [
            "--event",
            "push",
            "--before",
            "1111111111111111111111111111111111111111",
            "--after",
            "2222222222222222222222222222222222222222",
          ],
          env,
        );

        assert.deepEqual(output, allIntegrations);
      },
    );
  });
});

function runSelector(args, env = process.env) {
  return execFileSync(process.execPath, [selector.pathname, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  })
    .split("\n")
    .filter(Boolean);
}

function withFakeGitDiff(output, callback) {
  const tempDir = mkdtempSync(path.join(tmpdir(), "nango-selector-git-"));
  const fakeGit = path.join(tempDir, "git");
  writeFileSync(fakeGit, `#!/usr/bin/env bash\nprintf '%b' ${JSON.stringify(output)}\n`, { mode: 0o755 });

  try {
    callback({
      ...process.env,
      PATH: `${tempDir}${path.delimiter}${process.env.PATH}`,
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
