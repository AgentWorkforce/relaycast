import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRemoteAuthCommand } from "../src/auth/sandbox-auth.js";

const HOME = "/home/daytona";

test("codex uses the device-code login flow (no inbound callback) and no runtime version pin", () => {
  // Daytona's managed SSH gateway does not forward TCP into the sandbox, so
  // codex's default loopback OAuth callback (codex login) can never be
  // reached and login hangs. The device-code flow needs no callback, so codex
  // must be launched with `--device-auth`. Also: the codex version is governed
  // by the Daytona snapshot (the pre-baked codex lives in a root-owned nvm
  // prefix the sandbox user cannot overwrite — EACCES — and the `command -v`
  // guard skips the install when codex is present), so no cloud-side version
  // pin is injected.
  const cmd = buildRemoteAuthCommand({
    provider: "openai",
    providerConfig: {
      command: "codex",
      args: ["login"],
      deviceFlowArgs: ["login", "--device-auth"],
      supportsDeviceFlow: true,
      installCommand: "npm install -g @openai/codex",
    },
    home: HOME,
  });

  // Device-code flow, not the loopback callback flow.
  assert.match(cmd, /exec codex login --device-auth$/);
  // No hardcoded version is forced onto the install command.
  assert.doesNotMatch(cmd, /@openai\/codex@\d+\.\d+\.\d+/);
  // The provider's own (guarded) install is preserved as a fallback.
  assert.match(cmd, /command -v codex >\/dev\/null 2>&1 \|\| npm install -g @openai\/codex;/);
});

test("codex falls back to standard login args when device flow is not declared", () => {
  const cmd = buildRemoteAuthCommand({
    provider: "openai",
    providerConfig: {
      command: "codex",
      args: ["login"],
      installCommand: "npm install -g @openai/codex",
    },
    home: HOME,
  });

  assert.match(cmd, /exec codex login$/);
  assert.doesNotMatch(cmd, /--device-auth/);
});

test("grok uses the device-code login flow and the official installer fallback", () => {
  // grok login's default flow starts a loopback OAuth callback, which dies at
  // the Daytona SSH gateway exactly like codex's — so grok also gets the
  // device-code flow (`grok login --device-auth`).
  const cmd = buildRemoteAuthCommand({
    provider: "xai",
    providerConfig: {
      command: "grok",
      args: ["login"],
      deviceFlowArgs: ["login", "--device-auth"],
      supportsDeviceFlow: true,
      installCommand:
        "curl -fsSL https://x.ai/cli/install.sh | GROK_BIN_DIR=$HOME/.local/bin bash",
    },
    home: HOME,
  });

  assert.match(cmd, /exec grok login --device-auth$/);
  assert.match(cmd, /command -v grok >\/dev\/null 2>&1 \|\| curl -fsSL https:\/\/x\.ai\/cli\/install\.sh/);
});

test("device flow is scoped to codex and grok — other device-flow CLIs keep their standard args", () => {
  const cmd = buildRemoteAuthCommand({
    provider: "copilot",
    providerConfig: {
      command: "copilot",
      args: ["auth", "login"],
      deviceFlowArgs: ["auth", "login", "--device"],
      supportsDeviceFlow: true,
    },
    home: HOME,
  });

  assert.match(cmd, /exec copilot auth login$/);
  assert.doesNotMatch(cmd, /--device/);
});

test("non-codex providers keep their own install command untouched", () => {
  const cmd = buildRemoteAuthCommand({
    provider: "anthropic",
    providerConfig: {
      command: "claude",
      args: [],
      installCommand: "npm install -g @anthropic-ai/claude-code",
    },
    home: HOME,
  });

  assert.match(cmd, /npm install -g @anthropic-ai\/claude-code/);
  assert.doesNotMatch(cmd, /@openai\/codex/);
});

test("providers without an install command are unchanged", () => {
  const cmd = buildRemoteAuthCommand({
    provider: "google",
    providerConfig: { command: "gemini", args: [] },
    home: HOME,
  });

  assert.doesNotMatch(cmd, /npm install/);
  assert.match(cmd, /exec gemini$/);
});

test("provider auth env is exported before running the login command", () => {
  const cmd = buildRemoteAuthCommand({
    provider: "custom",
    providerConfig: {
      command: "custom-auth",
      args: ["login"],
      env: { CUSTOM_AUTH_CALLBACK_PORT: "1455" },
    },
    home: HOME,
  });

  assert.match(
    cmd,
    /^export PATH=\/home\/daytona\/\.local\/bin:\/home\/workspace\/\.local\/bin:\$PATH; export CUSTOM_AUTH_CALLBACK_PORT=1455; exec custom-auth login$/,
  );
});
