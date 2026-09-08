import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { PUBLISHED_PACKAGE_DIRS } from "./release-contract.mjs";

const workflow = readFileSync(
  new URL("../.github/workflows/publish-npm.yml", import.meta.url),
  "utf8",
);

describe("publish workflow safety contract", () => {
  it("offers lockstep publication only", () => {
    const packageInput = workflow.slice(
      workflow.indexOf("      package:"),
      workflow.indexOf("      version:"),
    );
    assert.match(packageInput, /options:\n\s+- all\n/);
    assert.doesNotMatch(
      packageInput,
      /- (?:a2a|types|engine|sdk-typescript|cli|mcp|react|openclaw)/,
    );
    assert.doesNotMatch(workflow, /^  publish-single:/m);
    assert.doesNotMatch(workflow, /needs\.publish-single/);
  });

  it("runs deterministic release checks before any publish job", () => {
    const tests = workflow.indexOf("npm run test:release");
    const validation = workflow.indexOf(
      'node scripts/check-release-contract.mjs --version "$NEW_VERSION"',
    );
    const publishJob = workflow.indexOf("  publish-packages:");
    assert.ok(tests > 0 && validation > tests && publishJob > validation);
  });

  it("carries generated source constants into the release commit", () => {
    for (const file of [
      "packages/sdk-typescript/src/version.ts",
      "packages/cli/src/version.ts",
    ]) {
      assert.equal(
        workflow.split(file).length - 1,
        2,
        `${file} must be uploaded and staged`,
      );
    }
  });

  it("publishes and releases only after the all-package matrix succeeds", () => {
    const matrixStart = workflow.indexOf("      matrix:\n        package:");
    const matrixEnd = workflow.indexOf("\n\n    steps:", matrixStart);
    const matrixPackages = [
      ...workflow
        .slice(matrixStart, matrixEnd)
        .matchAll(/^          - (\S+)$/gm),
    ].map((match) => match[1]);
    assert.deepEqual(matrixPackages, PUBLISHED_PACKAGE_DIRS);
    assert.match(workflow, /needs: \[build, publish-packages\]/);
    assert.match(workflow, /needs\.publish-packages\.result == 'success'/);
  });
});
