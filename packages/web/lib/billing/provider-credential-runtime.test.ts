import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  createCredentialStoreS3Client: vi.fn(),
  credentialStoreConstructors: [] as unknown[][],
  retrieveCredential: vi.fn(),
  storeCredential: vi.fn(),
  optionalEnv: vi.fn(),
  tryResourceValue: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({ execute: mocks.execute }),
}));

vi.mock("@/lib/env", () => ({
  optionalEnv: mocks.optionalEnv,
  tryResourceValue: mocks.tryResourceValue,
}));

vi.mock("@/lib/storage", () => ({
  createCredentialStoreS3Client: mocks.createCredentialStoreS3Client,
}));

vi.mock("@cloud/core/auth/credential-store.js", () => ({
  createCredentialStore: () => ({
    retrieve: (...args: unknown[]) => mocks.retrieveCredential(...args),
    store: (...args: unknown[]) => mocks.storeCredential(...args),
  }),
  CredentialStore: class {
    constructor(...args: unknown[]) {
      mocks.credentialStoreConstructors.push(args);
    }
    retrieve(...args: unknown[]) {
      return mocks.retrieveCredential(...args);
    }
    store(...args: unknown[]) {
      return mocks.storeCredential(...args);
    }
  },
}));

vi.mock("sst", () => ({
  Resource: { WorkflowStorage: { bucketName: "workflow-storage-test" } },
}));

import {
  deriveCtxLlmEnvFromHarnessCredential,
  resolveDaytonaCredentialRuntimeEnv,
  resolveProviderCredentialRuntimeEnv,
  resolveProviderCredentialRuntimeEnvById,
  resolveSubscriptionFallbackEnv,
} from "./provider-credential-runtime";

const workspaceId = "00000000-0000-0000-0000-000000000002";
const userId = "00000000-0000-0000-0000-000000000001";

describe("provider credential runtime resolution", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.credentialStoreConstructors.length = 0;
    mocks.createCredentialStoreS3Client.mockResolvedValue({ kind: "worker-aware-s3-client" });
    mocks.tryResourceValue.mockImplementation((name: string) => {
      if (name === "HouseAnthropicKey") {
        return "sk-ant-house";
      }
      if (name === "CredentialEncryptionKey") {
        return "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
      }
      return undefined;
    });
    mocks.optionalEnv.mockImplementation((name: string) =>
      name === "WORKFLOW_STORAGE_BUCKET" ? "workflow-storage-test" : undefined
    );
  });

  it("resolves relay-managed selections into provider API key env", async () => {
    mocks.execute.mockResolvedValueOnce({
      rows: [{
        id: "credential-managed",
        workspace_id: workspaceId,
        user_id: userId,
        model_provider: "anthropic",
        auth_type: "relay_managed",
        status: "connected",
      }],
    });

    await expect(resolveProviderCredentialRuntimeEnv({
      workspaceId,
      userId,
      credentialSelections: { anthropic: "credential-managed" },
    })).resolves.toEqual({
      env: { ANTHROPIC_API_KEY: "sk-ant-house" },
      credentials: [{
        provider: "anthropic",
        providerCredentialId: "credential-managed",
        authType: "relay_managed",
        envVar: "ANTHROPIC_API_KEY",
      }],
    });
    expect(mocks.retrieveCredential).not.toHaveBeenCalled();
  });

  it("decrypts selected BYOK credentials and exposes only provider API key env", async () => {
    mocks.execute.mockResolvedValueOnce({
      rows: [{
        id: "credential-byok",
        workspace_id: workspaceId,
        user_id: userId,
        model_provider: "anthropic",
        auth_type: "byo_api_key",
        status: "connected",
      }],
    });
    mocks.retrieveCredential.mockResolvedValueOnce(JSON.stringify({
      type: "api_key",
      modelProvider: "anthropic",
      key: "sk-ant-byok",
    }));

    await expect(resolveProviderCredentialRuntimeEnv({
      workspaceId,
      userId,
      credentialSelections: { anthropic: "credential-byok" },
    })).resolves.toEqual({
      env: { ANTHROPIC_API_KEY: "sk-ant-byok" },
      credentials: [{
        provider: "anthropic",
        providerCredentialId: "credential-byok",
        authType: "byo_api_key",
        envVar: "ANTHROPIC_API_KEY",
      }],
    });
    expect(mocks.retrieveCredential).toHaveBeenCalledWith(userId, "credential-byok");
  });

  it("resolves Daytona store credentials into narrow runtime env", async () => {
    mocks.retrieveCredential.mockResolvedValueOnce(JSON.stringify({
      provider: "daytona",
      accessToken: "daytona-access-token",
      refreshToken: "daytona-refresh-token",
      expiresAt: "2999-01-01T00:00:00.000Z",
      orgId: "org-123",
    }));

    await expect(resolveDaytonaCredentialRuntimeEnv({ userId })).resolves.toEqual({
      DAYTONA_ACCESS_TOKEN: "daytona-access-token",
      DAYTONA_ORG_ID: "org-123",
    });
    expect(mocks.retrieveCredential).toHaveBeenCalledWith(userId, "daytona");
    expect(mocks.storeCredential).not.toHaveBeenCalled();
  });

  it("rejects selected credentials owned by a different deployer", async () => {
    mocks.execute.mockResolvedValueOnce({
      rows: [{
        id: "credential-other-user",
        workspace_id: workspaceId,
        user_id: "00000000-0000-0000-0000-000000000099",
        model_provider: "anthropic",
        auth_type: "relay_managed",
        status: "connected",
      }],
    });

    await expect(resolveProviderCredentialRuntimeEnv({
      workspaceId,
      userId,
      credentialSelections: { anthropic: "credential-other-user" },
    })).rejects.toThrow("is not owned by the deploying user");
  });

  it("rejects BYOK payloads whose stored provider does not match the selection", async () => {
    mocks.execute.mockResolvedValueOnce({
      rows: [{
        id: "credential-byok",
        workspace_id: workspaceId,
        user_id: userId,
        model_provider: "anthropic",
        auth_type: "byo_api_key",
        status: "connected",
      }],
    });
    mocks.retrieveCredential.mockResolvedValueOnce(JSON.stringify({
      type: "api_key",
      modelProvider: "openai",
      key: "sk-test",
    }));

    await expect(resolveProviderCredentialRuntimeEnv({
      workspaceId,
      userId,
      credentialSelections: { anthropic: "credential-byok" },
    })).rejects.toThrow("provider mismatch");
  });
  it("resolves a setup-token (oauth_token) selection into CLAUDE_CODE_OAUTH_TOKEN env", async () => {
    mocks.execute.mockResolvedValueOnce({
      rows: [{
        id: "credential-setup-token",
        workspace_id: workspaceId,
        user_id: userId,
        model_provider: "anthropic",
        auth_type: "oauth_token",
        status: "connected",
      }],
    });
    // Setup-tokens are stored under the provider-NAME key, not the row UUID.
    mocks.retrieveCredential.mockResolvedValueOnce(JSON.stringify({
      type: "oauth_token",
      modelProvider: "anthropic",
      token: "sk-ant-oat01-setup",
    }));

    await expect(resolveProviderCredentialRuntimeEnv({
      workspaceId,
      userId,
      credentialSelections: { anthropic: "credential-setup-token" },
    })).resolves.toEqual({
      env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-setup" },
      credentials: [{
        provider: "anthropic",
        providerCredentialId: "credential-setup-token",
        authType: "oauth_token",
        envVar: "CLAUDE_CODE_OAUTH_TOKEN",
      }],
    });
    expect(mocks.retrieveCredential).toHaveBeenCalledWith(userId, "anthropic");
  });

  it("resolves an anthropic subscription (provider_oauth) selection into CLAUDE_CODE_OAUTH_TOKEN env", async () => {
    mocks.execute.mockResolvedValueOnce({
      rows: [{
        id: "credential-subscription",
        workspace_id: workspaceId,
        user_id: userId,
        model_provider: "anthropic",
        auth_type: "provider_oauth",
        status: "connected",
      }],
    });
    // Fresh blob (expiry far in the future) so the per-run refresh seam
    // no-ops; the access token is injected point-in-time.
    mocks.retrieveCredential.mockResolvedValueOnce(JSON.stringify({
      claudeAiOauth: {
        accessToken: "sk-ant-oauth-access",
        expiresAt: Date.now() + 8 * 60 * 60 * 1000,
      },
    }));

    await expect(resolveProviderCredentialRuntimeEnv({
      workspaceId,
      userId,
      credentialSelections: { anthropic: "credential-subscription" },
    })).resolves.toEqual({
      env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oauth-access" },
      credentials: [{
        provider: "anthropic",
        providerCredentialId: "credential-subscription",
        authType: "provider_oauth",
        envVar: "CLAUDE_CODE_OAUTH_TOKEN",
      }],
    });
    expect(mocks.retrieveCredential).toHaveBeenCalledWith(userId, "anthropic");
    expect(mocks.createCredentialStoreS3Client).toHaveBeenCalledWith({ userId });
    expect(mocks.credentialStoreConstructors).toEqual([
      [{
        bucket: "workflow-storage-test",
        prefix: "credentials",
        encryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        client: { kind: "worker-aware-s3-client" },
      }],
    ]);
  });

  it("resolves an openai subscription selection into structured CODEX_OAUTH_CREDENTIAL env", async () => {
    const codexCredential = JSON.stringify({
      tokens: {
        access_token: "chatgpt-access",
        refresh_token: "chatgpt-refresh",
        account_id: "account-123",
      },
      expires_at: "2999-01-01T00:00:00.000Z",
    });
    mocks.execute.mockResolvedValueOnce({
      rows: [{
        id: "credential-codex",
        workspace_id: workspaceId,
        user_id: userId,
        model_provider: "openai",
        auth_type: "provider_oauth",
        status: "connected",
      }],
    });
    // OpenAI subscription blobs are stored under the provider-NAME key and
    // must remain structured so the runtime can read tokens.account_id for the
    // codex/ChatGPT backend protocol.
    mocks.retrieveCredential.mockResolvedValueOnce(codexCredential);

    await expect(resolveProviderCredentialRuntimeEnv({
      workspaceId,
      userId,
      credentialSelections: { openai: "credential-codex" },
    })).resolves.toEqual({
      env: { CODEX_OAUTH_CREDENTIAL: codexCredential },
      credentials: [{
        provider: "openai",
        providerCredentialId: "credential-codex",
        authType: "provider_oauth",
        envVar: "CODEX_OAUTH_CREDENTIAL",
      }],
    });
    expect(mocks.retrieveCredential).toHaveBeenCalledWith(userId, "openai");
  });

  it("accepts openai subscription credentials with top-level account_id", async () => {
    const codexCredential = JSON.stringify({
      account_id: "account-123",
      tokens: {
        access_token: "chatgpt-access",
        refresh_token: "chatgpt-refresh",
      },
      expires_at: "2999-01-01T00:00:00.000Z",
    });
    mocks.execute.mockResolvedValueOnce({
      rows: [{
        id: "credential-codex",
        workspace_id: workspaceId,
        user_id: userId,
        model_provider: "openai",
        auth_type: "provider_oauth",
        status: "connected",
      }],
    });
    mocks.retrieveCredential.mockResolvedValueOnce(codexCredential);

    await expect(resolveProviderCredentialRuntimeEnv({
      workspaceId,
      userId,
      credentialSelections: { openai: "credential-codex" },
    })).resolves.toEqual({
      env: { CODEX_OAUTH_CREDENTIAL: codexCredential },
      credentials: [{
        provider: "openai",
        providerCredentialId: "credential-codex",
        authType: "provider_oauth",
        envVar: "CODEX_OAUTH_CREDENTIAL",
      }],
    });
    expect(mocks.retrieveCredential).toHaveBeenCalledWith(userId, "openai");
  });

  it("rejects malformed openai subscription blobs before runtime injection", async () => {
    mocks.execute.mockResolvedValueOnce({
      rows: [{
        id: "credential-codex",
        workspace_id: workspaceId,
        user_id: userId,
        model_provider: "openai",
        auth_type: "provider_oauth",
        status: "connected",
      }],
    });
    mocks.retrieveCredential.mockResolvedValueOnce(JSON.stringify({
      tokens: { access_token: "chatgpt-access" },
    }));

    await expect(resolveProviderCredentialRuntimeEnv({
      workspaceId,
      userId,
      credentialSelections: { openai: "credential-codex" },
    })).rejects.toThrow("missing account_id");
  });
});

describe("resolveProviderCredentialRuntimeEnvById", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.tryResourceValue.mockImplementation((name: string) => {
      if (name === "HouseAnthropicKey") {
        return "sk-ant-house";
      }
      if (name === "CredentialEncryptionKey") {
        return "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
      }
      return undefined;
    });
    mocks.optionalEnv.mockImplementation((name: string) =>
      name === "WORKFLOW_STORAGE_BUCKET" ? "workflow-storage-test" : undefined
    );
  });

  it("resolves a relay-managed credential id into provider API key env", async () => {
    mocks.execute.mockResolvedValueOnce({
      rows: [{
        id: "credential-managed",
        workspace_id: workspaceId,
        user_id: userId,
        model_provider: "anthropic",
        auth_type: "relay_managed",
        status: "connected",
      }],
    });

    await expect(resolveProviderCredentialRuntimeEnvById({
      workspaceId,
      userId,
      providerCredentialId: " credential-managed ",
    })).resolves.toEqual({
      env: { ANTHROPIC_API_KEY: "sk-ant-house" },
      credential: {
        provider: "anthropic",
        providerCredentialId: "credential-managed",
        authType: "relay_managed",
        envVar: "ANTHROPIC_API_KEY",
      },
      modelProvider: "anthropic",
    });
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.retrieveCredential).not.toHaveBeenCalled();
  });

  it("decrypts a BYOK credential id and exposes only provider API key env", async () => {
    mocks.execute.mockResolvedValueOnce({
      rows: [{
        id: "credential-byok",
        workspace_id: workspaceId,
        user_id: userId,
        model_provider: "anthropic",
        auth_type: "byo_api_key",
        status: "connected",
      }],
    });
    mocks.retrieveCredential.mockResolvedValueOnce(JSON.stringify({
      type: "api_key",
      modelProvider: "anthropic",
      key: "sk-ant-byok",
    }));

    await expect(resolveProviderCredentialRuntimeEnvById({
      workspaceId,
      userId,
      providerCredentialId: "credential-byok",
    })).resolves.toEqual({
      env: { ANTHROPIC_API_KEY: "sk-ant-byok" },
      credential: {
        provider: "anthropic",
        providerCredentialId: "credential-byok",
        authType: "byo_api_key",
        envVar: "ANTHROPIC_API_KEY",
      },
      modelProvider: "anthropic",
    });
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.retrieveCredential).toHaveBeenCalledWith(userId, "credential-byok");
  });

  it("rejects empty provider credential ids", async () => {
    await expect(resolveProviderCredentialRuntimeEnvById({
      workspaceId,
      userId,
      providerCredentialId: "   ",
    })).rejects.toThrow("Invalid provider credential id");
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("rejects missing credential rows", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [] });

    await expect(resolveProviderCredentialRuntimeEnvById({
      workspaceId,
      userId,
      providerCredentialId: "credential-missing",
    })).rejects.toThrow("Provider credential credential-missing was not found");
  });

  it("rejects credential ids that are not connected", async () => {
    mocks.execute.mockResolvedValueOnce({
      rows: [{
        id: "credential-error",
        workspace_id: workspaceId,
        user_id: userId,
        model_provider: "anthropic",
        auth_type: "relay_managed",
        status: "error",
      }],
    });

    await expect(resolveProviderCredentialRuntimeEnvById({
      workspaceId,
      userId,
      providerCredentialId: "credential-error",
    })).rejects.toThrow("Provider credential credential-error is not connected");
  });

  it("rejects credential ids owned by a different deployer", async () => {
    mocks.execute.mockResolvedValueOnce({
      rows: [{
        id: "credential-other-user",
        workspace_id: workspaceId,
        user_id: "00000000-0000-0000-0000-000000000099",
        model_provider: "anthropic",
        auth_type: "relay_managed",
        status: "connected",
      }],
    });

    await expect(resolveProviderCredentialRuntimeEnvById({
      workspaceId,
      userId,
      providerCredentialId: "credential-other-user",
    })).rejects.toThrow("Provider credential credential-other-user is not owned by the deploying user");
  });

  it("rejects credential ids for unsupported providers", async () => {
    mocks.execute.mockResolvedValueOnce({
      rows: [{
        id: "credential-unsupported",
        workspace_id: workspaceId,
        user_id: userId,
        model_provider: "cohere",
        auth_type: "relay_managed",
        status: "connected",
      }],
    });

    await expect(resolveProviderCredentialRuntimeEnvById({
      workspaceId,
      userId,
      providerCredentialId: "credential-unsupported",
    })).rejects.toThrow("Unsupported provider credential selection for cohere");
  });
});

describe("resolveSubscriptionFallbackEnv", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.tryResourceValue.mockImplementation((name: string) =>
      name === "CredentialEncryptionKey"
        ? "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        : undefined,
    );
    mocks.optionalEnv.mockImplementation((name: string) =>
      name === "WORKFLOW_STORAGE_BUCKET" ? "workflow-storage-test" : undefined,
    );
  });

  const activeRow = (overrides: Record<string, unknown>) => ({
    id: "credential-active",
    workspace_id: workspaceId,
    user_id: userId,
    model_provider: "anthropic",
    auth_type: "provider_oauth",
    status: "connected",
    ...overrides,
  });

  it("resolves the active anthropic subscription into CLAUDE_CODE_OAUTH_TOKEN env (linear shape)", async () => {
    // The exact production shape this fallback exists for: useSubscription
    // persona deployed without selections, deploying user has one active
    // anthropic subscription row.
    mocks.execute.mockResolvedValueOnce({ rows: [activeRow({})] });
    mocks.retrieveCredential.mockResolvedValueOnce(JSON.stringify({
      claudeAiOauth: {
        accessToken: "sk-ant-fallback-access",
        expiresAt: Date.now() + 8 * 60 * 60 * 1000,
      },
    }));

    await expect(resolveSubscriptionFallbackEnv({
      workspaceId,
      userId,
      personaModel: "gpt-5.5",
    })).resolves.toEqual({
      env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-fallback-access" },
      credentials: [{
        provider: "anthropic",
        providerCredentialId: "credential-active",
        authType: "provider_oauth",
        envVar: "CLAUDE_CODE_OAUTH_TOKEN",
      }],
    });
    expect(mocks.retrieveCredential).toHaveBeenCalledWith(userId, "anthropic");
  });

  it("prefers an active openai subscription for gpt personas through CODEX_OAUTH_CREDENTIAL", async () => {
    const codexCredential = JSON.stringify({
      tokens: {
        access_token: "chatgpt-fallback-access",
        refresh_token: "chatgpt-refresh",
        account_id: "account-123",
      },
      expires_at: "2999-01-01T00:00:00.000Z",
    });
    mocks.execute.mockResolvedValueOnce({
      rows: [activeRow({ id: "credential-codex", model_provider: "openai" })],
    });
    mocks.retrieveCredential.mockResolvedValueOnce(codexCredential);

    await expect(resolveSubscriptionFallbackEnv({
      workspaceId,
      userId,
      personaModel: "gpt-5.5",
    })).resolves.toEqual({
      env: { CODEX_OAUTH_CREDENTIAL: codexCredential },
      credentials: [{
        provider: "openai",
        providerCredentialId: "credential-codex",
        authType: "provider_oauth",
        envVar: "CODEX_OAUTH_CREDENTIAL",
      }],
    });
    expect(mocks.retrieveCredential).toHaveBeenCalledWith(userId, "openai");
  });

  it("uses the codex harness as the fallback family hint when the persona model is absent", async () => {
    const codexCredential = JSON.stringify({
      tokens: {
        access_token: "chatgpt-fallback-access",
        refresh_token: "chatgpt-refresh",
        account_id: "account-123",
      },
      expires_at: "2999-01-01T00:00:00.000Z",
    });
    mocks.execute.mockResolvedValueOnce({
      rows: [
        activeRow({}),
        activeRow({ id: "credential-codex", model_provider: "openai" }),
      ],
    });
    mocks.retrieveCredential.mockResolvedValueOnce(codexCredential);

    await expect(resolveSubscriptionFallbackEnv({
      workspaceId,
      userId,
      personaModel: null,
      personaHarness: "codex",
    })).resolves.toEqual({
      env: { CODEX_OAUTH_CREDENTIAL: codexCredential },
      credentials: [{
        provider: "openai",
        providerCredentialId: "credential-codex",
        authType: "provider_oauth",
        envVar: "CODEX_OAUTH_CREDENTIAL",
      }],
    });
    expect(mocks.retrieveCredential).toHaveBeenCalledWith(userId, "openai");
  });

  it("prefers the persona model family over the harness hint", async () => {
    mocks.execute.mockResolvedValueOnce({
      rows: [
        activeRow({}),
        activeRow({ id: "credential-codex", model_provider: "openai" }),
      ],
    });
    mocks.retrieveCredential.mockResolvedValueOnce(JSON.stringify({
      claudeAiOauth: {
        accessToken: "sk-ant-fallback-access",
        expiresAt: Date.now() + 8 * 60 * 60 * 1000,
      },
    }));

    await expect(resolveSubscriptionFallbackEnv({
      workspaceId,
      userId,
      personaModel: "claude-haiku-4-5-20251001",
      personaHarness: "codex",
    })).resolves.toEqual({
      env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-fallback-access" },
      credentials: [{
        provider: "anthropic",
        providerCredentialId: "credential-active",
        authType: "provider_oauth",
        envVar: "CLAUDE_CODE_OAUTH_TOKEN",
      }],
    });
    expect(mocks.retrieveCredential).toHaveBeenCalledWith(userId, "anthropic");
  });

  it("keeps anthropic as the deterministic fallback when model and harness are absent", async () => {
    mocks.execute.mockResolvedValueOnce({
      rows: [
        activeRow({}),
        activeRow({ id: "credential-codex", model_provider: "openai" }),
      ],
    });
    mocks.retrieveCredential.mockResolvedValueOnce(JSON.stringify({
      claudeAiOauth: {
        accessToken: "sk-ant-fallback-access",
        expiresAt: Date.now() + 8 * 60 * 60 * 1000,
      },
    }));

    await expect(resolveSubscriptionFallbackEnv({
      workspaceId,
      userId,
      personaModel: null,
    })).resolves.toEqual({
      env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-fallback-access" },
      credentials: [{
        provider: "anthropic",
        providerCredentialId: "credential-active",
        authType: "provider_oauth",
        envVar: "CLAUDE_CODE_OAUTH_TOKEN",
      }],
    });
    expect(mocks.retrieveCredential).toHaveBeenCalledWith(userId, "anthropic");
  });

  it("prefers the persona model family when that row is resolvable", async () => {
    // gpt persona + active openai BYOK + active anthropic oauth → openai BYOK
    // (family match wins over the anthropic fallback ordering).
    mocks.execute.mockResolvedValueOnce({
      rows: [
        activeRow({}),
        activeRow({ id: "credential-openai-byok", model_provider: "openai", auth_type: "byo_api_key" }),
      ],
    });
    mocks.retrieveCredential.mockResolvedValueOnce(JSON.stringify({
      type: "api_key",
      modelProvider: "openai",
      key: "sk-openai-byok",
    }));

    await expect(resolveSubscriptionFallbackEnv({
      workspaceId,
      userId,
      personaModel: "gpt-5.5",
    })).resolves.toEqual({
      env: { OPENAI_API_KEY: "sk-openai-byok" },
      credentials: [{
        provider: "openai",
        providerCredentialId: "credential-openai-byok",
        authType: "byo_api_key",
        envVar: "OPENAI_API_KEY",
      }],
    });
    expect(mocks.retrieveCredential).toHaveBeenCalledWith(userId, "credential-openai-byok");
  });

  it("treats openrouter-prefixed models as openrouter even when the route contains claude", async () => {
    mocks.execute.mockResolvedValueOnce({
      rows: [
        activeRow({}),
        activeRow({
          id: "credential-openrouter-byok",
          model_provider: "openrouter",
          auth_type: "byo_api_key",
        }),
      ],
    });
    mocks.retrieveCredential.mockResolvedValueOnce(JSON.stringify({
      type: "api_key",
      modelProvider: "openrouter",
      key: "sk-openrouter-byok",
    }));

    await expect(resolveSubscriptionFallbackEnv({
      workspaceId,
      userId,
      personaModel: "openrouter/anthropic/claude-sonnet-4.6",
    })).resolves.toEqual({
      env: { OPENROUTER_API_KEY: "sk-openrouter-byok" },
      credentials: [{
        provider: "openrouter",
        providerCredentialId: "credential-openrouter-byok",
        authType: "byo_api_key",
        envVar: "OPENROUTER_API_KEY",
      }],
    });
    expect(mocks.retrieveCredential).toHaveBeenCalledWith(userId, "credential-openrouter-byok");
  });

  it("recognizes o-series persona models as openai for fallback preference", async () => {
    mocks.execute.mockResolvedValueOnce({
      rows: [
        activeRow({}),
        activeRow({ id: "credential-openai-byok", model_provider: "openai", auth_type: "byo_api_key" }),
      ],
    });
    mocks.retrieveCredential.mockResolvedValueOnce(JSON.stringify({
      type: "api_key",
      modelProvider: "openai",
      key: "sk-openai-byok",
    }));

    await expect(resolveSubscriptionFallbackEnv({
      workspaceId,
      userId,
      personaModel: "o3-mini",
    })).resolves.toEqual({
      env: { OPENAI_API_KEY: "sk-openai-byok" },
      credentials: [{
        provider: "openai",
        providerCredentialId: "credential-openai-byok",
        authType: "byo_api_key",
        envVar: "OPENAI_API_KEY",
      }],
    });
    expect(mocks.retrieveCredential).toHaveBeenCalledWith(userId, "credential-openai-byok");
  });

  it("falls back to a deterministic provider order when the persona family is unknown", async () => {
    mocks.execute.mockResolvedValueOnce({
      rows: [
        activeRow({ id: "credential-google-byok", model_provider: "google", auth_type: "byo_api_key" }),
        activeRow({ id: "credential-openrouter-byok", model_provider: "openrouter", auth_type: "byo_api_key" }),
      ],
    });
    mocks.retrieveCredential.mockResolvedValueOnce(JSON.stringify({
      type: "api_key",
      modelProvider: "google",
      key: "sk-google-byok",
    }));

    await expect(resolveSubscriptionFallbackEnv({
      workspaceId,
      userId,
      personaModel: "unknown-family-model",
    })).resolves.toEqual({
      env: { GOOGLE_API_KEY: "sk-google-byok" },
      credentials: [{
        provider: "google",
        providerCredentialId: "credential-google-byok",
        authType: "byo_api_key",
        envVar: "GOOGLE_API_KEY",
      }],
    });
    expect(mocks.retrieveCredential).toHaveBeenCalledWith(userId, "credential-google-byok");
  });

  it("returns empty when the user has no active connected rows", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [] });
    await expect(resolveSubscriptionFallbackEnv({
      workspaceId,
      userId,
      personaModel: "claude-sonnet-4-6",
    })).resolves.toEqual({ env: {}, credentials: [] });
  });
});

describe("deriveCtxLlmEnvFromHarnessCredential", () => {
  it("derives CLAUDE_CODE_OAUTH_TOKEN from an anthropic subscription blob", () => {
    const blob = JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oauth-access" } });
    expect(deriveCtxLlmEnvFromHarnessCredential({ provider: "anthropic", credentialJson: blob }))
      .toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oauth-access" });
  });

  it("derives CLAUDE_CODE_OAUTH_TOKEN from an anthropic setup-token blob", () => {
    const blob = JSON.stringify({ type: "oauth_token", modelProvider: "anthropic", token: "sk-ant-oat01" });
    expect(deriveCtxLlmEnvFromHarnessCredential({ provider: "anthropic", credentialJson: blob }))
      .toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01" });
  });

  it("ships the structured codex blob in CODEX_OAUTH_CREDENTIAL — never OPENAI_API_KEY", () => {
    const blob = JSON.stringify({ tokens: { access_token: "chatgpt-access", account_id: "acct-1" } });
    const env = deriveCtxLlmEnvFromHarnessCredential({ provider: "openai", credentialJson: blob });
    expect(env).toEqual({ CODEX_OAUTH_CREDENTIAL: blob });
    // Security invariant: a ChatGPT OAuth bearer must NOT be emitted as an
    // OpenAI platform API key.
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("accepts a top-level account_id on the codex blob", () => {
    const blob = JSON.stringify({ account_id: "acct-9", tokens: { access_token: "chatgpt-access" } });
    expect(deriveCtxLlmEnvFromHarnessCredential({ provider: "openai", credentialJson: blob }))
      .toEqual({ CODEX_OAUTH_CREDENTIAL: blob });
  });

  it("returns empty for a codex blob missing the account_id", () => {
    const blob = JSON.stringify({ tokens: { access_token: "chatgpt-access" } });
    expect(deriveCtxLlmEnvFromHarnessCredential({ provider: "openai", credentialJson: blob })).toEqual({});
  });

  it("returns empty for non-llm providers, empty input, and malformed JSON", () => {
    expect(deriveCtxLlmEnvFromHarnessCredential({ provider: "google", credentialJson: "{}" })).toEqual({});
    expect(deriveCtxLlmEnvFromHarnessCredential({ provider: "anthropic", credentialJson: "" })).toEqual({});
    expect(deriveCtxLlmEnvFromHarnessCredential({ provider: "openai", credentialJson: "not-json" })).toEqual({});
  });
});
