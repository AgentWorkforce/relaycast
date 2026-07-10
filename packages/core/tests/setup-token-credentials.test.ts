import test from "node:test";
import assert from "node:assert/strict";

import {
  applyAnthropicOauthTokenEnv,
  extractAnthropicOauthToken,
  extractAnthropicOauthTokenFromBundle,
  mountCliCredentials,
} from "../src/auth/cli-credentials.js";

// --- extractAnthropicOauthToken: detect the setup-token shape only ---

test("extractAnthropicOauthToken returns the token for the setup-token shape", () => {
  const json = JSON.stringify({
    type: "oauth_token",
    modelProvider: "anthropic",
    token: "sk-ant-oat-abc123",
  });
  assert.equal(extractAnthropicOauthToken(json), "sk-ant-oat-abc123");
});

test("extractAnthropicOauthToken returns null for the legacy claudeAiOauth shape", () => {
  const json = JSON.stringify({
    claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt: 123 },
  });
  assert.equal(extractAnthropicOauthToken(json), null);
});

test("extractAnthropicOauthToken returns null for non-JSON, empty token, or other types", () => {
  assert.equal(extractAnthropicOauthToken("not json"), null);
  assert.equal(
    extractAnthropicOauthToken(
      JSON.stringify({ type: "oauth_token", token: "" }),
    ),
    null,
  );
  assert.equal(
    extractAnthropicOauthToken(JSON.stringify({ type: "api_key", key: "x" })),
    null,
  );
  assert.equal(
    extractAnthropicOauthToken(
      JSON.stringify({ type: "oauth_token", modelProvider: "openai", token: "not-anthropic" }),
    ),
    null,
  );
});

test("extractAnthropicOauthTokenFromBundle detects bundled anthropic setup-tokens only", () => {
  const anthropic = JSON.stringify({
    type: "oauth_token",
    modelProvider: "anthropic",
    token: "sk-ant-oat-bundled",
  });
  const openai = JSON.stringify({ tokens: { access_token: "openai-token" } });

  assert.equal(
    extractAnthropicOauthTokenFromBundle(JSON.stringify({ anthropic, openai })),
    "sk-ant-oat-bundled",
  );
  assert.equal(extractAnthropicOauthTokenFromBundle(JSON.stringify({ openai })), null);
});

test("applyAnthropicOauthTokenEnv injects Claude OAuth env without disturbing other env", () => {
  const env = { RUN_ID: "run-1" };
  applyAnthropicOauthTokenEnv(
    env,
    JSON.stringify({
      type: "oauth_token",
      modelProvider: "anthropic",
      token: "sk-ant-oat-env",
    }),
  );
  assert.deepEqual(env, {
    RUN_ID: "run-1",
    CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-env",
  });
});

// --- mountCliCredentials: skip the .credentials.json mount for setup-tokens ---

function makeMockSandbox() {
  const uploads: Array<{ path: string; content: string }> = [];
  const commands: string[] = [];
  const sandbox = {
    process: {
      executeCommand: async (cmd: string) => {
        commands.push(cmd);
        return { exitCode: 0, result: "" };
      },
    },
    fs: {
      uploadFile: async (buf: Buffer, path: string) => {
        uploads.push({ path, content: buf.toString() });
      },
    },
  };
  return { sandbox, uploads, commands };
}

type MountSandbox = Parameters<typeof mountCliCredentials>[0];

test("mountCliCredentials skips the .credentials.json mount for a setup-token", async () => {
  const { sandbox, uploads } = makeMockSandbox();
  const cred = JSON.stringify({
    type: "oauth_token",
    modelProvider: "anthropic",
    token: "sk-ant-oat-abc123",
  });

  await mountCliCredentials(
    sandbox as unknown as MountSandbox,
    "/home/daytona",
    cred,
    "anthropic",
  );

  const paths = uploads.map((u) => u.path);
  assert.ok(
    !paths.some((p) => p.endsWith("/.claude/.credentials.json")),
    "setup-token must NOT mount .credentials.json — the launcher injects CLAUDE_CODE_OAUTH_TOKEN instead",
  );
  // onboarding config is still written so the genuine binary skips first-run setup
  assert.ok(
    paths.some((p) => p.endsWith("/.claude.json")),
    "onboarding config (.claude.json) should still be written",
  );
});

test("mountCliCredentials still mounts .credentials.json for legacy provider_oauth", async () => {
  const { sandbox, uploads } = makeMockSandbox();
  const cred = JSON.stringify({
    claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt: 123 },
  });

  await mountCliCredentials(
    sandbox as unknown as MountSandbox,
    "/home/daytona",
    cred,
    "anthropic",
  );

  const paths = uploads.map((u) => u.path);
  assert.ok(
    paths.some((p) => p.endsWith("/.claude/.credentials.json")),
    "legacy provider_oauth must still mount .credentials.json",
  );
});
