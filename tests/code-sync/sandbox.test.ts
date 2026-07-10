import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { exec } from "../../packages/core/src/code-sync/sandbox.js";
import { SandboxCommandError } from "../../packages/core/src/code-sync/errors.js";
import { createMockSandbox } from "./helpers.js";

describe("exec helper", () => {
  it("returns result on success", async () => {
    const { sandbox } = createMockSandbox();
    sandbox.process.executeCommand = async () => ({ exitCode: 0, result: "ok" });

    const result = await exec(sandbox, "echo hi");
    assert.equal(result.exitCode, 0);
    assert.equal(result.result, "ok");
  });

  it("throws SandboxCommandError on failure", async () => {
    const { sandbox } = createMockSandbox();
    sandbox.process.executeCommand = async () => ({ exitCode: 1, result: "error output" });

    await assert.rejects(
      () => exec(sandbox, "bad-cmd"),
      (err: unknown) => {
        assert.ok(err instanceof SandboxCommandError);
        assert.equal(err.exitCode, 1);
        assert.equal(err.command, "bad-cmd");
        assert.equal(err.output, "error output");
        return true;
      }
    );
  });

  it("passes cwd correctly", async () => {
    const { sandbox, commands } = createMockSandbox();

    await exec(sandbox, "ls", "/workspace");
    assert.equal(commands[0].cwd, "/workspace");
  });
});
