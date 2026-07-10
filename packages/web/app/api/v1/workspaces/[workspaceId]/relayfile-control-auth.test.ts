import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  relayfileClaims: null as null | {
    sub: string;
    wks: string;
    org: string;
    scopes: string[];
    metadata?: { agentName?: string };
  },
  resolveApiTokenSession: vi.fn(),
  readSessionFromRequest: vi.fn(),
  getIntegrationBackend: vi.fn(),
  selectIntegrationBackend: vi.fn(),
  insertUserIntegrationIfAbsent: vi.fn(),
  insertWorkspaceIntegrationIfAbsent: vi.fn(),
  findSlackIntegrationByTeamId: vi.fn(),
  getWorkspaceIntegration: vi.fn(),
  getWorkspaceIntegrationByName: vi.fn(),
  looksLikeSlackTeamId: vi.fn(),
  upsertWorkspaceIntegration: vi.fn(),
  getNangoClient: vi.fn(),
  getNangoSecretKey: vi.fn(),
  setMetadata: vi.fn(),
  adoptIntegrationConnection: vi.fn(),
  disconnectIntegrationBackend: vi.fn(),
  mintRelayfileToken: vi.fn(),
  replayOp: vi.fn(),
}));

vi.mock("sst", () => ({
  Resource: {
    AuthSessionSecret: { value: "test-session-secret" },
    CatalogingCloudApiToken: { value: "cataloging-service-token" },
    CredentialEncryptionKey: { value: "test-credential-key" },
    SageCloudApiToken: { value: "sage-service-token" },
    WorkflowStorage: { bucketName: "workflow-storage-test" },
  },
}));

vi.mock("@relayauth/sdk", () => ({
  TokenVerifier: class {
    async verifyOrNull() {
      return mocks.relayfileClaims;
    }
  },
}));

vi.mock("@/lib/auth/session", () => ({
  readSessionFromRequest: mocks.readSessionFromRequest,
}));

vi.mock("@/lib/auth/api-token-store", () => ({
  resolveApiTokenSession: mocks.resolveApiTokenSession,
}));

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

vi.mock("@/lib/storage", () => ({
  createCredentialStoreS3Client: vi.fn(),
}));

vi.mock("@cloud/core/auth/credential-store.js", () => ({
  CredentialStore: class {
    exists = vi.fn(async () => false);
  },
}));

vi.mock("@cloud/core/provider-readiness.js", () => ({
  buildLegacyConnectedReadiness: vi.fn(),
  buildPendingProviderMetadata: vi.fn(() => ({})),
  readProviderReadiness: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("@/lib/integrations/backend", () => ({
  BackendPolicyError: class BackendPolicyError extends Error {
    code: string;
    backend: string | null;

    constructor(code: string, message: string, backend: string | null = null) {
      super(message);
      this.code = code;
      this.backend = backend;
    }
  },
  getIntegrationBackend: mocks.getIntegrationBackend,
  selectIntegrationBackend: mocks.selectIntegrationBackend,
}));

vi.mock("@/lib/integrations/backend-config", () => ({
  BackendNotConfiguredError: class BackendNotConfiguredError extends Error {},
}));

vi.mock("@/lib/integrations/composio-service", () => ({
  resolveComposioToolkit: vi.fn(),
}));

vi.mock("@/lib/integrations/disconnect-integration-backend", () => ({
  disconnectIntegrationBackend: mocks.disconnectIntegrationBackend,
}));

vi.mock("@/lib/integrations/adopt-integration", () => ({
  adoptIntegrationConnection: mocks.adoptIntegrationConnection,
}));

vi.mock("@/lib/integrations/github-installation-centric-flag", () => ({
  isGithubInstallationCentricEnabled: vi.fn(() => false),
}));

vi.mock("@/lib/integrations/nango-service", () => ({
  getNangoClient: mocks.getNangoClient,
  getNangoConnection: vi.fn(),
  getNangoSecretKey: mocks.getNangoSecretKey,
  getNangoSyncScheduleStatuses: vi.fn(),
  getProviderConfigKey: vi.fn((provider: string) => `${provider}-relay`),
  triggerNangoSyncs: vi.fn(),
}));

vi.mock("@/lib/integrations/provider-status", () => ({
  deriveProviderState: vi.fn(),
  fetchWorkspaceProviderSyncStatus: vi.fn(),
  liveNangoInitialSyncSucceeded: vi.fn(),
  summarizeProviderInitialSync: vi.fn(),
  summarizeWritebackHealth: vi.fn(),
}));

vi.mock("@/lib/integrations/providers", () => ({
  getBackendIntegrationId: vi.fn((provider: string) => `${provider}-relay`),
  getProviderConfigKey: vi.fn((provider: string) => `${provider}-relay`),
  getWorkspaceIntegrationProviderDefinition: vi.fn((provider: string) => ({
    id: provider,
    displayName: provider,
    vfsRoot: `/${provider}`,
  })),
  isWorkspaceIntegrationProvider: vi.fn(
    (provider: unknown) => typeof provider === "string",
  ),
  listWorkspaceIntegrationCatalogEntries: vi.fn(() => []),
  resolveWorkspaceIntegrationProvider: vi.fn((provider: string) => provider),
}));

vi.mock("@/lib/integrations/user-integrations", () => ({
  getUserIntegration: vi.fn(),
  insertUserIntegrationIfAbsent: mocks.insertUserIntegrationIfAbsent,
}));

vi.mock("@/lib/integrations/workspace-integrations", () => ({
  findSlackIntegrationByTeamId: mocks.findSlackIntegrationByTeamId,
  getWorkspaceIntegration: mocks.getWorkspaceIntegration,
  getWorkspaceIntegrationByName: mocks.getWorkspaceIntegrationByName,
  insertWorkspaceIntegrationIfAbsent: mocks.insertWorkspaceIntegrationIfAbsent,
  looksLikeSlackTeamId: mocks.looksLikeSlackTeamId,
  upsertWorkspaceIntegration: mocks.upsertWorkspaceIntegration,
}));

vi.mock("@/lib/workspaces/relay-workspace-binding", () => ({
  isAppWorkspaceId: vi.fn(() => false),
  isRelayWorkspaceId: vi.fn(() => false),
  readAppWorkspaceRelayBinding: vi.fn(),
  resolveAppWorkspaceByRelayWorkspaceId: vi.fn(),
}));

vi.mock("@cloud/core/relayfile/client.js", () => ({
  mintRelayfileToken: mocks.mintRelayfileToken,
}));

vi.mock("@relayfile/sdk", () => ({
  RelayFileApiError: class RelayFileApiError extends Error {
    status: number;

    constructor(message: string, status = 500) {
      super(message);
      this.status = status;
    }
  },
  RelayFileClient: class {
    replayOp = mocks.replayOp;
  },
}));

vi.mock("@/lib/relayfile", () => ({
  resolveRelayfileConfig: vi.fn(() => ({
    relayfileUrl: "https://relayfile.test",
    relayAuthUrl: "https://relayauth.test",
    relayAuthApiKey: "relay_ws_parent",
  })),
}));

import { POST as connectSessionPost } from "./integrations/connect-session/route";
import { POST as adoptPost } from "./integrations/[provider]/adopt/route";
import { PUT as metadataPut } from "./integrations/[provider]/metadata/route";
import { DELETE as statusDelete } from "./integrations/[provider]/status/route";
import { POST as replayPost } from "./ops/[opId]/replay/route";
import {
  createIntegrationRouteHandlers,
} from "@/lib/integrations/integration-route-handler";

const WORKSPACE_ID = "rw_1234abcd";
const providerRouteHandlers = createIntegrationRouteHandlers("github");

type TestRequestInit = {
  body?: BodyInit | null;
  headers?: HeadersInit;
  method?: string;
};

function relayfileRequest(
  path: string,
  init: TestRequestInit = {},
): NextRequest {
  return new NextRequest(`https://agentrelay.test${path}`, {
    ...init,
    headers: {
      Authorization: "Bearer relay_pa_path_token",
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

function workspaceContext() {
  return { params: Promise.resolve({ workspaceId: WORKSPACE_ID }) };
}

function providerContext(provider = "github") {
  return { params: Promise.resolve({ workspaceId: WORKSPACE_ID, provider }) };
}

function replayContext() {
  return {
    params: Promise.resolve({ workspaceId: WORKSPACE_ID, opId: "op_123" }),
  };
}

describe("relayfile path tokens on cloud control-plane mutation routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.relayfileClaims = {
      sub: "relayfile-agent",
      wks: WORKSPACE_ID,
      org: "org_123",
      scopes: ["relayfile:fs:read:/github/*", "relayfile:fs:write:/github/*"],
      metadata: { agentName: "relayfile-agent" },
    };
    mocks.readSessionFromRequest.mockReturnValue(null);
    mocks.resolveApiTokenSession.mockResolvedValue(null);
    mocks.getNangoSecretKey.mockReturnValue("nango-secret");
    mocks.looksLikeSlackTeamId.mockReturnValue(false);
    mocks.getNangoClient.mockReturnValue({
      getConnection: vi.fn(),
      setMetadata: mocks.setMetadata,
    });
    mocks.getWorkspaceIntegration.mockResolvedValue({
      workspaceId: WORKSPACE_ID,
      provider: "github",
      connectionId: "conn_github",
      providerConfigKey: "github-relay",
      installationId: null,
      metadata: {},
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
  });

  it("rejects connect-session before creating any setup session", async () => {
    const response = await connectSessionPost(
      relayfileRequest(
        `/api/v1/workspaces/${WORKSPACE_ID}/integrations/connect-session`,
        {
          method: "POST",
          body: JSON.stringify({ allowedIntegrations: ["github"] }),
        },
      ),
      workspaceContext(),
    );

    expect(response.status).toBe(403);
    expect(mocks.selectIntegrationBackend).not.toHaveBeenCalled();
    expect(mocks.getIntegrationBackend).not.toHaveBeenCalled();
    expect(mocks.insertWorkspaceIntegrationIfAbsent).not.toHaveBeenCalled();
  });

  it("rejects adopt before adopting an integration connection", async () => {
    const response = await adoptPost(
      relayfileRequest(
        `/api/v1/workspaces/${WORKSPACE_ID}/integrations/github/adopt`,
        {
          method: "POST",
          body: JSON.stringify({ connectionId: "conn_github" }),
        },
      ),
      providerContext("github"),
    );

    expect(response.status).toBe(403);
    expect(mocks.adoptIntegrationConnection).not.toHaveBeenCalled();
  });

  it("rejects metadata writes before reading or mutating provider metadata", async () => {
    const response = await metadataPut(
      relayfileRequest(
        `/api/v1/workspaces/${WORKSPACE_ID}/integrations/github/metadata`,
        {
          method: "PUT",
          body: JSON.stringify({ metadata: { cloudId: "cloud-1" } }),
        },
      ),
      providerContext("github"),
    );

    expect(response.status).toBe(403);
    expect(mocks.getWorkspaceIntegration).not.toHaveBeenCalled();
    expect(mocks.setMetadata).not.toHaveBeenCalled();
  });

  it("rejects disconnect before disconnecting an integration backend", async () => {
    const response = await statusDelete(
      relayfileRequest(
        `/api/v1/workspaces/${WORKSPACE_ID}/integrations/github/status`,
        { method: "DELETE" },
      ),
      providerContext("github"),
    );

    expect(response.status).toBe(403);
    expect(mocks.disconnectIntegrationBackend).not.toHaveBeenCalled();
  });

  it("rejects ops replay before minting a replay token or replaying the op", async () => {
    const response = await replayPost(
      relayfileRequest(`/api/v1/workspaces/${WORKSPACE_ID}/ops/op_123/replay`, {
        method: "POST",
      }),
      replayContext(),
    );

    expect(response.status).toBe(403);
    expect(mocks.mintRelayfileToken).not.toHaveBeenCalled();
    expect(mocks.replayOp).not.toHaveBeenCalled();
  });

  it("rejects provider-route upserts before writing integration rows", async () => {
    const response = await providerRouteHandlers.POST(
      relayfileRequest(`/api/v1/workspaces/${WORKSPACE_ID}/integrations/github`, {
        method: "POST",
        body: JSON.stringify({
          connectionId: "conn_github",
          providerConfigKey: "github-relay",
        }),
      }),
      workspaceContext(),
    );

    expect(response.status).toBe(403);
    expect(mocks.upsertWorkspaceIntegration).not.toHaveBeenCalled();
  });

  it("rejects provider-route deletes before disconnecting integration backends", async () => {
    const response = await providerRouteHandlers.DELETE(
      relayfileRequest(`/api/v1/workspaces/${WORKSPACE_ID}/integrations/github`, {
        method: "DELETE",
      }),
      workspaceContext(),
    );

    expect(response.status).toBe(403);
    expect(mocks.getWorkspaceIntegration).not.toHaveBeenCalled();
    expect(mocks.disconnectIntegrationBackend).not.toHaveBeenCalled();
  });
});
