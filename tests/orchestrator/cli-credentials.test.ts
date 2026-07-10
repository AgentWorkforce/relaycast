import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CLI_AUTH_CONFIG } from "@agent-relay/config/cli-auth-config";
import { CredentialStore } from "../../packages/core/src/auth/credential-store.js";
import {
  getKnownCredentialMountPaths,
  listConnectedProviders,
  mountCliCredentials,
  resolveDeclaredCliCredentialProvider,
  resolveProxyCredentialEnv,
  resolveCredentialProvider,
  resolveCredentialProviderFromCli,
} from "../../packages/core/src/auth/cli-credentials.js";

function createMockSandbox() {
  const commands: string[] = [];
  const uploads: { path: string; content: string }[] = [];

  return {
    process: {
      executeCommand: async (command: string) => {
        commands.push(command);
      },
    },
    fs: {
      uploadFile: async (content: Buffer, path: string) => {
        uploads.push({ path, content: content.toString() });
      },
    },
    commands,
    uploads,
  };
}

function makeProviderTargetPath(home: string, provider: string): string {
  const config = CLI_AUTH_CONFIG[provider as keyof typeof CLI_AUTH_CONFIG];
  return `${home}/${config.credentialPath!.replace("~/", "")}`;
}

describe("resolveCredentialProviderFromCli", () => {
  it("maps known providers", () => {
    assert.equal(resolveCredentialProviderFromCli("claude"), "anthropic");
    assert.equal(resolveCredentialProviderFromCli("codex"), "openai");
    assert.equal(resolveCredentialProviderFromCli("gemini"), "google");
  });

  it("defaults unknown providers to anthropic", () => {
    assert.equal(resolveCredentialProviderFromCli("mystery-bot"), "anthropic");
  });

  it("supports JSON payload based provider resolution", () => {
    const workflowConfig = JSON.stringify({
      agents: [{ cli: "opencode" }],
    });
    assert.equal(resolveCredentialProvider(workflowConfig), "opencode");
  });
});

describe("resolveDeclaredCliCredentialProvider", () => {
  it("maps declared member harnesses without changing legacy workflow defaults", () => {
    assert.equal(resolveDeclaredCliCredentialProvider("claude"), "anthropic");
    assert.equal(resolveDeclaredCliCredentialProvider(" codex "), "openai");
    assert.equal(resolveDeclaredCliCredentialProvider("gemini"), "google");
  });

  it("returns null for harness-less or unsupported team members", () => {
    assert.equal(resolveDeclaredCliCredentialProvider(undefined), null);
    assert.equal(resolveDeclaredCliCredentialProvider(null), null);
    assert.equal(resolveDeclaredCliCredentialProvider("   "), null);
    assert.equal(resolveDeclaredCliCredentialProvider("mystery-bot"), null);
  });
});

describe("resolveProxyCredentialEnv", () => {
  it("maps claude to anthropic proxy env vars", () => {
    assert.deepEqual(resolveProxyCredentialEnv("claude", "https://proxy.example.com/", "jwt-token"), {
      CREDENTIAL_PROXY_URL: "https://proxy.example.com",
      CREDENTIAL_PROXY_TOKEN: "jwt-token",
      ANTHROPIC_BASE_URL: "https://proxy.example.com",
      ANTHROPIC_API_KEY: "jwt-token",
    });
  });

  it("maps aider to OPENAI_API_BASE", () => {
    // aider reads OPENAI_API_BASE (not OPENAI_BASE_URL); SDK's proxy-env
    // registry reflects that, so we don't set the OPENAI_BASE_URL alias here.
    assert.deepEqual(resolveProxyCredentialEnv("aider", "https://proxy.example.com", "jwt-token"), {
      CREDENTIAL_PROXY_URL: "https://proxy.example.com",
      CREDENTIAL_PROXY_TOKEN: "jwt-token",
      OPENAI_API_BASE: "https://proxy.example.com",
      OPENAI_API_KEY: "jwt-token",
    });
  });

  it("rejects blank proxy inputs", () => {
    assert.throws(() => resolveProxyCredentialEnv("claude", "   ", "jwt-token"), {
      message: "proxyUrl is required",
    });
    assert.throws(() => resolveProxyCredentialEnv("claude", "https://proxy.example.com", "   "), {
      message: "proxyToken is required",
    });
  });
});

describe("getKnownCredentialMountPaths", () => {
  it("returns deduplicated absolute credential targets", () => {
    const paths = getKnownCredentialMountPaths("/home/daytona");

    assert.ok(paths.includes("/home/daytona/.claude/.credentials.json"));
    assert.ok(paths.includes("/home/daytona/.claude.json"));
    assert.ok(paths.includes("/home/daytona/.codex/auth.json"));
    assert.ok(paths.includes("/home/daytona/.config/gemini/credentials.json"));
    assert.equal(new Set(paths).size, paths.length);
  });
});

describe("mountCliCredentials", () => {
  it("writes anthropic credentials to claude locations", async () => {
    const sandbox: ReturnType<typeof createMockSandbox> = createMockSandbox() as any;

    await mountCliCredentials(sandbox as any, "/home/daytona", "token", "anthropic");

    assert.deepEqual(sandbox.commands, ["mkdir -p /home/daytona/.claude"]);
    assert.equal(sandbox.uploads.length, 2);
    assert.equal(sandbox.uploads[0]?.path, "/home/daytona/.claude/.credentials.json");
    assert.equal(sandbox.uploads[1]?.path, "/home/daytona/.claude.json");
    assert.match(sandbox.uploads[0]?.content, /token/);
  });

  it("writes openai credentials to codex path", async () => {
    const sandbox: ReturnType<typeof createMockSandbox> = createMockSandbox() as any;

    await mountCliCredentials(sandbox as any, "/home/daytona", "openai-token", "openai");

    assert.deepEqual(sandbox.commands, ["mkdir -p /home/daytona/.codex"]);
    assert.equal(sandbox.uploads.length, 1);
    assert.equal(sandbox.uploads[0]?.path, "/home/daytona/.codex/auth.json");
    assert.equal(sandbox.uploads[0]?.content, "openai-token");
  });

  it("writes google credentials to configured path", async () => {
    const sandbox: ReturnType<typeof createMockSandbox> = createMockSandbox() as any;

    await mountCliCredentials(sandbox as any, "/home/daytona", "google-token", "google");

    assert.deepEqual(sandbox.commands, ["mkdir -p /home/daytona/.config/gemini"]);
    assert.equal(sandbox.uploads.length, 1);
    assert.equal(sandbox.uploads[0]?.path, "/home/daytona/.config/gemini/credentials.json");
    assert.equal(sandbox.uploads[0]?.content, "google-token");
  });

  it("writes opencode credentials to ~/.claude/.credentials.json", async () => {
    const sandbox: ReturnType<typeof createMockSandbox> = createMockSandbox() as any;

    await mountCliCredentials(sandbox as any, "/home/daytona", "opencode-token", "opencode" as any);

    assert.deepEqual(sandbox.commands, ["mkdir -p /home/daytona/.claude"]);
    assert.equal(sandbox.uploads.length, 1);
    assert.equal(sandbox.uploads[0]?.path, "/home/daytona/.claude/.credentials.json");
    assert.equal(sandbox.uploads[0]?.content, "opencode-token");
  });

  it("writes provider-specific paths for default providers", async () => {
    const sandbox: ReturnType<typeof createMockSandbox> = createMockSandbox() as any;
    const provider = "cursor";
    const expectedPath = makeProviderTargetPath("/home/daytona", provider);

    await mountCliCredentials(sandbox as any, "/home/daytona", "droid-token", provider as any);

    assert.deepEqual(sandbox.commands, [`mkdir -p $(dirname ${expectedPath})`]);
    assert.equal(sandbox.uploads.length, 1);
    assert.equal(sandbox.uploads[0]?.path, expectedPath);
  });

  it("throws on unsupported providers", async () => {
    const sandbox: ReturnType<typeof createMockSandbox> = createMockSandbox() as any;

    await assert.rejects(
      async () => mountCliCredentials(sandbox as any, "/home/daytona", "token", "bogus" as any),
      { message: /Unsupported credential provider/ }
    );
  });
});

describe("listConnectedProviders", () => {
  it("returns all CLI_AUTH_CONFIG provider keys present in metadata", async (t) => {
    const originalBucket = process.env.CREDENTIAL_S3_BUCKET;
    process.env.CREDENTIAL_S3_BUCKET = "test-bucket";
    t.after(() => {
      if (originalBucket === undefined) {
        delete process.env.CREDENTIAL_S3_BUCKET;
      } else {
        process.env.CREDENTIAL_S3_BUCKET = originalBucket;
      }
    });

    t.mock.method(CredentialStore.prototype, "getMetadata", async () => ({
      providers: {
        anthropic: { authenticatedAt: "2026-01-01T00:00:00Z", provider: "anthropic" },
        openai: { authenticatedAt: "2026-01-01T00:00:00Z", provider: "openai" },
        google: { authenticatedAt: "2026-01-01T00:00:00Z", provider: "google" },
      },
      lastUpdated: "2026-01-01T00:00:00Z",
    }));

    const result = await listConnectedProviders("user-1", "test-key");

    assert.deepEqual(result, ["anthropic", "openai", "google"]);
  });

  it("filters out unknown/stale providers not in CLI_AUTH_CONFIG", async (t) => {
    const originalBucket = process.env.CREDENTIAL_S3_BUCKET;
    process.env.CREDENTIAL_S3_BUCKET = "test-bucket";
    t.after(() => {
      if (originalBucket === undefined) {
        delete process.env.CREDENTIAL_S3_BUCKET;
      } else {
        process.env.CREDENTIAL_S3_BUCKET = originalBucket;
      }
    });

    t.mock.method(CredentialStore.prototype, "getMetadata", async () => ({
      providers: {
        anthropic: { authenticatedAt: "2026-01-01T00:00:00Z", provider: "anthropic" },
        unknown_provider: {
          authenticatedAt: "2026-01-01T00:00:00Z",
          provider: "unknown_provider",
        },
        also_fake: { authenticatedAt: "2026-01-01T00:00:00Z", provider: "also_fake" },
      },
      lastUpdated: "2026-01-01T00:00:00Z",
    }));

    const result = await listConnectedProviders("user-1", "test-key");

    assert.deepEqual(result, ["anthropic"]);
  });

  it("returns [] when getMetadata resolves to null/undefined", async (t) => {
    const originalBucket = process.env.CREDENTIAL_S3_BUCKET;
    process.env.CREDENTIAL_S3_BUCKET = "test-bucket";
    t.after(() => {
      if (originalBucket === undefined) {
        delete process.env.CREDENTIAL_S3_BUCKET;
      } else {
        process.env.CREDENTIAL_S3_BUCKET = originalBucket;
      }
    });

    t.mock.method(CredentialStore.prototype, "getMetadata", async () => null);
    assert.deepEqual(await listConnectedProviders("user-1", "test-key"), []);

    t.mock.method(CredentialStore.prototype, "getMetadata", async () => undefined as any);
    assert.deepEqual(await listConnectedProviders("user-1", "test-key"), []);
  });
});
