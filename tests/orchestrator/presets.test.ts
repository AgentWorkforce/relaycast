import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getPresetFlags, buildAgentCommand } from "../../packages/core/src/executor/presets.js";

describe("getPresetFlags", () => {
  it("claude:lead returns empty args and no env", () => {
    const flags = getPresetFlags("claude", "lead");
    assert.deepEqual(flags.args, []);
    assert.equal(flags.env, undefined);
  });

  it("claude:worker returns empty args and DISABLE_RELAY", () => {
    // SDK's buildNonInteractiveCommand adds --print/--dangerously-skip-permissions
    const flags = getPresetFlags("claude", "worker");
    assert.deepEqual(flags.args, []);
    assert.deepEqual(flags.env, { DISABLE_RELAY: "1" });
  });

  it("claude:reviewer returns empty args and DISABLE_RELAY", () => {
    const flags = getPresetFlags("claude", "reviewer");
    assert.deepEqual(flags.args, []);
    assert.deepEqual(flags.env, { DISABLE_RELAY: "1" });
  });

  it("claude:analyst returns empty args and DISABLE_RELAY", () => {
    const flags = getPresetFlags("claude", "analyst");
    assert.deepEqual(flags.args, []);
    assert.deepEqual(flags.env, { DISABLE_RELAY: "1" });
  });

  it("codex:worker returns empty args and DISABLE_RELAY", () => {
    const flags = getPresetFlags("codex", "worker");
    assert.deepEqual(flags.args, []);
    assert.deepEqual(flags.env, { DISABLE_RELAY: "1" });
  });

  it("unknown combo returns empty args and no env", () => {
    const flags = getPresetFlags("gemini" as any, "lead");
    assert.deepEqual(flags.args, []);
    assert.equal(flags.env, undefined);
  });
});

describe("buildAgentCommand", () => {
  it("produces a command string for claude worker", async () => {
    const result = await buildAgentCommand("claude", "worker", "Fix the bug in auth.ts", "worker-1");
    assert.equal(typeof result.command, "string");
    assert.ok(result.command.length > 0);
    assert.deepEqual(result.env, { DISABLE_RELAY: "1" });
  });

  it("includes the task in the command", async () => {
    const result = await buildAgentCommand("claude", "worker", "Write tests", "agent-1");
    assert.ok(result.command.includes("Write tests") || result.command.includes("'Write tests'"));
  });

  it("shell-escapes special characters", async () => {
    const result = await buildAgentCommand("claude", "worker", "Fix the 'bug' in auth.ts", "agent-1");
    // Should not have unescaped single quotes that break the shell
    assert.ok(!result.command.includes("'bug'") || result.command.includes("\\'"));
  });
});
