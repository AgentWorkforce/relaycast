/**
 * Unit tests for buildRemoteAuthCommand — regression guard for PATH-propagation bug.
 *
 * Run: npx tsx --test tests/build-remote-auth-command.unit.ts
 *
 * Context: `VAR=value cmd` in bash only scopes VAR to the immediately-following
 * simple command. The old code used `PATH=... command -v codex; codex login`,
 * which meant PATH was NOT set when `codex login` ran. The fix uses
 * `export PATH=...; exec codex login` so every subsequent command inherits it.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildRemoteAuthCommand } from "../packages/core/src/auth/sandbox-auth.js";

describe("buildRemoteAuthCommand", () => {
  it("1. anthropic — no install guard, uses export PATH= prefix, execs claude", () => {
    const cmd = buildRemoteAuthCommand({
      provider: "anthropic",
      providerConfig: { command: "claude", args: [] },
      home: "/home/daytona",
    });

    // Must start with 'export PATH=' not the old inline-prefix form
    assert.ok(
      cmd.startsWith("export PATH=/home/daytona/.local/bin:/home/workspace/.local/bin:$PATH"),
      `Expected cmd to start with 'export PATH=...', got: ${cmd}`
    );

    // Must exec the CLI
    assert.ok(cmd.includes("exec claude"), `Expected 'exec claude' in: ${cmd}`);

    // Anti-regression: must NOT use old VAR=value prefix form (only scopes to next command)
    assert.equal(
      cmd.includes("PATH=/home/daytona/.local/bin:/home/workspace/.local/bin:$PATH command -v"),
      false,
      `Must not use single-command PATH= prefix form — got: ${cmd}`
    );
    assert.equal(
      cmd.includes("PATH=/home/daytona/.local/bin:/home/workspace/.local/bin:$PATH claude"),
      false,
      `Must not use single-command PATH= prefix form — got: ${cmd}`
    );
  });

  it("2. openai — PATH propagation regression test (the bug this fix addresses)", () => {
    const cmd = buildRemoteAuthCommand({
      provider: "openai",
      providerConfig: {
        command: "codex",
        args: ["login"],
        installCommand: "npm install -g @openai/codex",
      },
      home: "/home/daytona",
    });

    // PATH is exported as a top-level shell statement
    assert.ok(
      cmd.startsWith("export PATH="),
      `Expected cmd to start with 'export PATH=', got: ${cmd}`
    );

    // Install guard present
    assert.ok(
      cmd.includes("command -v codex"),
      `Expected install guard 'command -v codex' in: ${cmd}`
    );
    assert.ok(
      cmd.includes("npm install -g @openai/codex"),
      `Expected install command in: ${cmd}`
    );

    // CRITICAL: codex login must be reached AFTER the install guard and exec'd
    assert.ok(
      cmd.includes("exec codex login"),
      `Expected 'exec codex login' in: ${cmd}`
    );

    // Anti-regression: the broken form had 'PATH=... command -v codex' as a
    // prefix, which only scoped PATH to the test and not to codex login itself.
    assert.equal(
      /PATH=[^;\n]+\s+command -v codex/.test(cmd),
      false,
      `Remote command must not use single-command PATH= prefix form — got: ${cmd}`
    );
  });

  it("3. cursor — fallback to cursor-agent is preserved", () => {
    const cmd = buildRemoteAuthCommand({
      provider: "cursor",
      providerConfig: { command: "agent", args: ["login"] },
      home: "/home/daytona",
    });

    assert.ok(
      cmd.includes("command -v agent"),
      `Expected 'command -v agent' in: ${cmd}`
    );
    assert.ok(
      cmd.includes("cursor-agent login"),
      `Expected 'cursor-agent login' fallback in: ${cmd}`
    );
  });

  it("4. home dir is substituted literally into PATH", () => {
    const cmd = buildRemoteAuthCommand({
      provider: "anthropic",
      providerConfig: { command: "claude", args: [] },
      home: "/root",
    });

    assert.ok(
      cmd.includes("/root/.local/bin"),
      `Expected '/root/.local/bin' in PATH, got: ${cmd}`
    );
  });

  it("5. provider with args — args are shell-escaped and passed through", () => {
    const cmd = buildRemoteAuthCommand({
      provider: "openai",
      providerConfig: {
        command: "codex",
        args: ["login", "--no-browser"],
        installCommand: "npm install -g @openai/codex",
      },
      home: "/home/daytona",
    });

    assert.ok(
      cmd.includes("exec codex login --no-browser"),
      `Expected 'exec codex login --no-browser' in: ${cmd}`
    );
  });

  it("6. provider without installCommand does not include install guard", () => {
    const cmd = buildRemoteAuthCommand({
      provider: "anthropic",
      providerConfig: { command: "claude", args: [] },
      home: "/home/daytona",
    });

    assert.equal(
      cmd.includes("command -v claude"),
      false,
      `Provider without installCommand should not have install guard — got: ${cmd}`
    );
  });
});
