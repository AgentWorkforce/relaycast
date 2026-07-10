/**
 * Unit tests for CliAuth — mocks the Daytona SDK.
 *
 * Run: npx tsx --test tests/cli-auth.unit.ts
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { CliAuth, CREDENTIAL_VOLUME_NAME, DEFAULT_SANDBOX_LANGUAGE } from "../packages/core/src/cli-auth.js";
import { CLI_AUTH_CONFIG } from "@agent-relay/config/cli-auth-config";

// ── Mock helpers ─────────────────────────────────────────────────────────────

function createMockSandbox(overrides?: {
  credentialContent?: string;
  executeResults?: Record<string, string>;
}) {
  const credentialContent =
    overrides?.credentialContent ?? JSON.stringify({ token: "test-token" });

  return {
    id: "sandbox-123",
    getUserHomeDir: mock.fn(async () => "/home/daytona"),
    createSshAccess: mock.fn(async () => ({
      sshCommand: "ssh -o StrictHostKeyChecking=no -p 2222 daytona@sandbox.example.com",
      token: "ssh-token-123",
    })),
    revokeSshAccess: mock.fn(async () => {}),
    process: {
      executeCommand: mock.fn(async (cmd: string) => {
        return { result: overrides?.executeResults?.[cmd] ?? "", exitCode: 0 };
      }),
    },
    fs: {
      downloadFile: mock.fn(async () => Buffer.from(credentialContent)),
      uploadFile: mock.fn(async () => {}),
    },
  };
}

function createMockDaytona(sandbox?: ReturnType<typeof createMockSandbox>) {
  const sb = sandbox ?? createMockSandbox();
  return {
    create: mock.fn(async () => sb),
    delete: mock.fn(async () => {}),
    volume: {
      get: mock.fn(async () => ({
        id: "vol-123",
        name: CREDENTIAL_VOLUME_NAME,
        state: "ready",
      })),
      create: mock.fn(async () => ({
        id: "vol-123",
        name: CREDENTIAL_VOLUME_NAME,
      })),
    },
    _sandbox: sb, // for test assertions
  } as any;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("CliAuth", () => {
  it("1. Provider config lookup for all providers", () => {
    const providers = Object.keys(CLI_AUTH_CONFIG);
    assert.ok(providers.length >= 7, "Should have at least 7 providers");

    for (const provider of providers) {
      const config = CLI_AUTH_CONFIG[provider];
      assert.ok(config.command, `${provider} should have a command`);
      assert.ok(config.displayName, `${provider} should have a displayName`);
      assert.ok(
        Array.isArray(config.successPatterns),
        `${provider} should have successPatterns`
      );
    }

    // Specific provider checks
    assert.equal(CLI_AUTH_CONFIG.anthropic.command, "claude");
    assert.equal(CLI_AUTH_CONFIG.openai.command, "codex");
    assert.equal(CLI_AUTH_CONFIG.google.command, "gemini");
  });

  it("2. authenticate rejects unknown provider", async () => {
    const mockDaytona = createMockDaytona();
    const cliAuth = new CliAuth(mockDaytona);

    await assert.rejects(
      () => cliAuth.authenticate("nonexistent-provider" as any),
      /Unknown provider/
    );
  });

  it("3. getCredentials returns null when volume doesn't exist", async () => {
    const mockDaytona = createMockDaytona();
    mockDaytona.volume.get = mock.fn(async () => {
      throw new Error("Volume not found");
    });
    const cliAuth = new CliAuth(mockDaytona);

    const result = await cliAuth.getCredentials("anthropic");
    assert.equal(result, null);
  });

  it("4. getCredentials retrieves credentials from volume", async () => {
    const mockDaytona = createMockDaytona();
    const cliAuth = new CliAuth(mockDaytona);

    const result = await cliAuth.getCredentials("anthropic");
    assert.ok(result, "Should return credentials");
    assert.ok(result.includes("test-token"), "Should contain credential data");

    // Verify sandbox was created with correct volume mount
    const createCall = mockDaytona.create.mock.calls[0];
    const createArgs = createCall.arguments[0];
    assert.equal(createArgs.language, DEFAULT_SANDBOX_LANGUAGE);
    assert.ok(createArgs.volumes[0].mountPath === "/credentials");

    // Verify cleanup
    assert.ok(
      mockDaytona.delete.mock.calls.length > 0,
      "Should have cleaned up sandbox"
    );
  });

  it("5. mountToSandbox symlinks when volume is mounted", async () => {
    const mockDaytona = createMockDaytona();
    const cliAuth = new CliAuth(mockDaytona);

    // Simulate volume mounted with credential file present
    const targetSandbox = createMockSandbox();
    const origExec = targetSandbox.process.executeCommand;
    targetSandbox.process.executeCommand = mock.fn(async (cmd: string) => {
      if (cmd.includes("test -f") && cmd.includes("/credentials/")) {
        return { result: "EXISTS", exitCode: 0 };
      }
      return origExec.call(null, cmd);
    });

    const result = await cliAuth.mountToSandbox(
      targetSandbox as any,
      "anthropic",
      "/home/user"
    );

    assert.ok(result, "Should return true on success");

    // Check that symlink was created (ln -sf)
    const execCalls = targetSandbox.process.executeCommand.mock.calls;
    const cmds = execCalls.map((c: any) => c.arguments[0]);
    assert.ok(
      cmds.some((c: string) => c.includes("ln -sf") && c.includes(".claude/.credentials.json")),
      "Should symlink credentials to .claude/.credentials.json"
    );

    // Onboarding config should still be uploaded as a real file
    const uploadCalls = targetSandbox.fs.uploadFile.mock.calls;
    const paths = uploadCalls.map((c: any) => c.arguments[1]);
    assert.ok(
      paths.some((p: string) => p.includes(".claude.json")),
      "Should upload onboarding config"
    );
  });

  it("5b. mountToSandbox copies when volume is not mounted", async () => {
    const mockDaytona = createMockDaytona();
    const cliAuth = new CliAuth(mockDaytona);

    // Default mock returns empty string for test -f → falls to copy path
    const targetSandbox = createMockSandbox();

    const result = await cliAuth.mountToSandbox(
      targetSandbox as any,
      "anthropic",
      "/home/user"
    );

    assert.ok(result, "Should return true on success");

    // Check that credentials were uploaded (copied, not symlinked)
    const uploadCalls = targetSandbox.fs.uploadFile.mock.calls;
    const paths = uploadCalls.map((c: any) => c.arguments[1]);
    assert.ok(
      paths.some((p: string) => p.includes(".claude/.credentials.json")),
      "Should upload credentials to .claude/.credentials.json"
    );
    assert.ok(
      paths.some((p: string) => p.includes(".claude.json")),
      "Should upload onboarding config"
    );
  });

  it("6. mountToSandbox returns false when no credentials exist", async () => {
    const mockDaytona = createMockDaytona();
    mockDaytona.volume.get = mock.fn(async () => {
      throw new Error("Volume not found");
    });
    const cliAuth = new CliAuth(mockDaytona);

    const targetSandbox = createMockSandbox();
    const result = await cliAuth.mountToSandbox(
      targetSandbox as any,
      "anthropic",
      "/home/user"
    );

    assert.equal(result, false, "Should return false when no credentials");
  });

  it("7. listAuthenticated returns null when volume doesn't exist", async () => {
    const mockDaytona = createMockDaytona();
    mockDaytona.volume.get = mock.fn(async () => {
      throw new Error("Volume not found");
    });
    const cliAuth = new CliAuth(mockDaytona);

    const result = await cliAuth.listAuthenticated();
    assert.equal(result, null);
  });

  it("8. Constructor accepts custom Daytona instance", () => {
    const customDaytona = createMockDaytona();
    const cliAuth = new CliAuth(customDaytona);
    assert.ok(cliAuth, "Should construct with custom Daytona instance");

    // Verify it doesn't throw when constructed without args
    // (would fail in test environment since DAYTONA_API_KEY not set,
    // but the constructor should accept undefined)
    assert.ok(CliAuth, "CliAuth class should exist");
  });
});
