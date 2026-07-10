import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildComposioConnectCallbackUrl,
  createComposioConnectCallbackState,
  handleComposioConnectCallback,
  parseComposioConnectCallbackState,
} from "./composio-connect-callback";
import type { WorkspaceIntegrationRecord } from "./workspace-integrations";

const TEST_SECRET = "test-secret";
type CallbackDepsForTest = NonNullable<Parameters<typeof handleComposioConnectCallback>[1]>;
let originalAuthSessionSecret: string | undefined;

beforeEach(() => {
  originalAuthSessionSecret = process.env.AUTH_SESSION_SECRET;
  process.env.AUTH_SESSION_SECRET = TEST_SECRET;
});

afterEach(() => {
  if (originalAuthSessionSecret === undefined) {
    delete process.env.AUTH_SESSION_SECRET;
  } else {
    process.env.AUTH_SESSION_SECRET = originalAuthSessionSecret;
  }
});

function buildDeps(overrides: Partial<CallbackDepsForTest> = {}) {
  const integration: WorkspaceIntegrationRecord = {
    id: "integration_123",
    workspaceId: "rw_12345678",
    provider: "github",
    connectionId: "ca_123",
    providerConfigKey: "github-composio-relay",
    installationId: null,
    metadata: {},
    createdAt: new Date("2026-05-08T00:00:00.000Z"),
    updatedAt: new Date("2026-05-08T00:00:00.000Z"),
  };

  return {
    getConnectedAccount: vi.fn(async () => ({
      id: "ca_123",
      status: "ACTIVE",
      toolkit: { slug: "github" },
      auth_config: { id: "ac_123" },
    })),
    upsertIntegration: vi.fn(async () => integration),
    markOAuthConnected: vi.fn(async () => undefined),
    markInitialSyncQueued: vi.fn(async () => undefined),
    markInitialSyncComplete: vi.fn(async () => undefined),
    markInitialSyncFailed: vi.fn(async () => undefined),
    upsertNangoBridgeConnection: vi.fn(async () => ({ ok: true as const })),
    triggerSyncs: vi.fn(async () => ({ ok: true as const })),
    ...overrides,
  };
}

describe("Composio connect callback state", () => {
  it("round-trips signed callback state", () => {
    const state = createComposioConnectCallbackState(
      {
        workspaceId: "rw_12345678",
        provider: "github",
        authConfigId: "ac_123",
        returnTo: "/integrations/github",
      },
      TEST_SECRET,
    );

    expect(parseComposioConnectCallbackState(state, TEST_SECRET)).toMatchObject({
      workspaceId: "rw_12345678",
      provider: "github",
      authConfigId: "ac_123",
      returnTo: "/integrations/github",
      version: 1,
    });
  });

  it("builds the callback URL Cloud should pass to Composio", () => {
    const callbackUrl = buildComposioConnectCallbackUrl({
      baseUrl: "https://app.relayfile.com",
      secret: TEST_SECRET,
      state: {
        workspaceId: "rw_12345678",
        provider: "notion",
      },
    });

    const url = new URL(callbackUrl);
    expect(url.pathname).toBe("/cloud/api/v1/webhooks/composio/connect/callback");
    expect(url.searchParams.get("state")).toBeTruthy();
  });

  it("round-trips dynamic Composio toolkit providers", () => {
    const state = createComposioConnectCallbackState(
      {
        workspaceId: "rw_12345678",
        provider: "dockerhub",
        authConfigId: "ac_dockerhub",
      },
      TEST_SECRET,
    );

    expect(parseComposioConnectCallbackState(state, TEST_SECRET)).toMatchObject({
      workspaceId: "rw_12345678",
      provider: "dockerhub",
      authConfigId: "ac_dockerhub",
    });
  });
});

describe("handleComposioConnectCallback", () => {
  it("persists the Composio connection and triggers configured Nango syncs", async () => {
    const state = createComposioConnectCallbackState(
      {
        workspaceId: "rw_12345678",
        provider: "github",
      },
      TEST_SECRET,
    );
    const url = new URL(
      `https://app.relayfile.com/api/v1/webhooks/composio/connect/callback?status=success&connected_account_id=ca_123&state=${encodeURIComponent(state)}`,
    );
    const deps = buildDeps();

    const result = await handleComposioConnectCallback(url, deps);

    expect(result).toMatchObject({
      ok: true,
      workspaceId: "rw_12345678",
      provider: "github",
      connectionId: "ca_123",
      providerConfigKey: "github-composio-relay",
      syncTriggered: true,
      syncs: ["fetch-repos", "fetch-open-prs", "fetch-open-issues"],
    });
    expect(deps.upsertIntegration).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "rw_12345678",
        provider: "github",
        connectionId: "ca_123",
        providerConfigKey: "github-composio-relay",
        metadata: expect.objectContaining({
          backend: "composio",
          composio: expect.objectContaining({
            connectedAccountId: "ca_123",
            authConfigId: "ac_123",
            toolkitSlug: "github",
          }),
        }),
      }),
    );
    expect(deps.upsertNangoBridgeConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "rw_12345678",
        provider: "github",
        connectionId: "ca_123",
        providerConfigKey: "github-composio-relay",
      }),
    );
    expect(deps.triggerSyncs).toHaveBeenCalledWith({
      providerConfigKey: "github-composio-relay",
      connectionId: "ca_123",
      syncs: ["fetch-repos", "fetch-open-prs", "fetch-open-issues"],
      syncMode: "incremental",
    });
  });

  it("rejects inactive Composio accounts before writing Cloud state", async () => {
    const state = createComposioConnectCallbackState(
      {
        workspaceId: "rw_12345678",
        provider: "github",
      },
      TEST_SECRET,
    );
    const url = new URL(
      `https://app.relayfile.com/api/v1/webhooks/composio/connect/callback?status=success&connectedAccountId=ca_123&state=${encodeURIComponent(state)}`,
    );
    const deps = buildDeps({
      getConnectedAccount: vi.fn(async () => ({ id: "ca_123", status: "INITIATED" })),
    });

    await expect(handleComposioConnectCallback(url, deps)).rejects.toThrow(
      "connected_account_not_active:INITIATED",
    );
    expect(deps.upsertIntegration).not.toHaveBeenCalled();
    expect(deps.triggerSyncs).not.toHaveBeenCalled();
  });

  it("uses generated Nango bridge keys for dynamic Composio providers", async () => {
    const state = createComposioConnectCallbackState(
      {
        workspaceId: "rw_12345678",
        provider: "dockerhub",
      },
      TEST_SECRET,
    );
    const url = new URL(
      `https://app.relayfile.com/api/v1/webhooks/composio/connect/callback?status=success&connected_account_id=ca_dockerhub&state=${encodeURIComponent(state)}`,
    );
    const deps = buildDeps({
      getConnectedAccount: vi.fn(async () => ({
        id: "ca_dockerhub",
        status: "ACTIVE",
        toolkit: { slug: "dockerhub" },
        auth_config: { id: "ac_dockerhub" },
      })),
      upsertIntegration: vi.fn(async () => ({
        id: "wsi-composio-test",
        workspaceId: "rw_12345678",
        provider: "dockerhub",
        connectionId: "ca_dockerhub",
        providerConfigKey: "dockerhub-composio-relay",
        installationId: null,
        metadata: {},
        createdAt: new Date("2026-05-08T00:00:00.000Z"),
        updatedAt: new Date("2026-05-08T00:00:00.000Z"),
      })),
    });

    const result = await handleComposioConnectCallback(url, deps);

    expect(result).toMatchObject({
      ok: true,
      provider: "dockerhub",
      providerConfigKey: "dockerhub-composio-relay",
      syncTriggered: false,
      syncs: [],
    });
    expect(deps.upsertNangoBridgeConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "rw_12345678",
        provider: "dockerhub",
        connectionId: "ca_dockerhub",
        providerConfigKey: "dockerhub-composio-relay",
      }),
    );
    expect(deps.triggerSyncs).not.toHaveBeenCalled();
    expect(deps.markInitialSyncComplete).toHaveBeenCalledWith({
      workspaceId: "rw_12345678",
      provider: "dockerhub",
      syncName: null,
    });
  });

  it("writes Docker Hub username to Nango bridge metadata.namespace", async () => {
    const state = createComposioConnectCallbackState(
      {
        workspaceId: "rw_12345678",
        provider: "docker_hub",
        toolkitSlug: "docker_hub",
        dockerHubUsername: "khaliqgant",
      },
      TEST_SECRET,
    );
    const url = new URL(
      `https://app.relayfile.com/api/v1/webhooks/composio/connect/callback?status=success&connected_account_id=ca_dockerhub&state=${encodeURIComponent(state)}`,
    );
    const deps = buildDeps({
      getConnectedAccount: vi.fn(async () => ({
        id: "ca_dockerhub",
        status: "ACTIVE",
        toolkit: { slug: "docker_hub" },
        auth_config: { id: "ac_docker_hub" },
      })),
      upsertIntegration: vi.fn(async () => ({
        id: "wsi-composio-test",
        workspaceId: "rw_12345678",
        provider: "docker_hub",
        connectionId: "ca_dockerhub",
        providerConfigKey: "docker_hub-composio-relay",
        installationId: null,
        metadata: {},
        createdAt: new Date("2026-05-08T00:00:00.000Z"),
        updatedAt: new Date("2026-05-08T00:00:00.000Z"),
      })),
    });

    await handleComposioConnectCallback(url, deps);

    expect(deps.upsertNangoBridgeConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "rw_12345678",
        provider: "docker_hub",
        connectionId: "ca_dockerhub",
        providerConfigKey: "docker_hub-composio-relay",
        metadata: expect.objectContaining({
          namespace: "khaliqgant",
        }),
      }),
    );
  });

  it("rejects Composio accounts without an active status before writing Cloud state", async () => {
    const state = createComposioConnectCallbackState(
      {
        workspaceId: "rw_12345678",
        provider: "github",
      },
      TEST_SECRET,
    );
    const url = new URL(
      `https://app.relayfile.com/api/v1/webhooks/composio/connect/callback?status=success&connectedAccountId=ca_123&state=${encodeURIComponent(state)}`,
    );
    const deps = buildDeps({
      getConnectedAccount: vi.fn(async () => ({ id: "ca_123" })),
    });

    await expect(handleComposioConnectCallback(url, deps)).rejects.toThrow(
      "connected_account_not_active:UNKNOWN",
    );
    expect(deps.upsertIntegration).not.toHaveBeenCalled();
    expect(deps.triggerSyncs).not.toHaveBeenCalled();
  });
});
