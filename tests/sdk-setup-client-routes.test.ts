import { generateKeyPairSync } from "node:crypto";
import { NextRequest } from "next/server";
import type { RelayAuthTokenClaims } from "@relayauth/types";
import {
  keyIdFromPublicJwk,
  signRs256,
} from "../node_modules/@relayauth/server/dist/lib/sign-rs256.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const PROVIDER = "github";
const RELAYAUTH_URL = "https://api.relayauth.test";
const RELAYAUTH_ISSUER = "https://relayauth.test";
const JWKS_URL = `${RELAYAUTH_URL}/.well-known/jwks.json`;

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 3072,
});
const PRIVATE_KEY_PEM = privateKey.export({
  type: "pkcs8",
  format: "pem",
}).toString();
const PUBLIC_JWK = publicKey.export({ format: "jwk" }) as JsonWebKey;

const {
  createConnectSessionMock,
  deleteNangoConnectionMock,
  deleteWorkspaceIntegrationMock,
  fetchWorkspaceProviderSyncStatusMock,
  findWorkspaceIntegrationByConnectionMock,
  createComposioAuthConfigMock,
  createComposioConnectionLinkMock,
  getAuthContextMock,
  getComposioConnectedAccountMock,
  getNangoConnectionMock,
  getWorkspaceIntegrationMock,
  insertWorkspaceIntegrationIfAbsentMock,
  listComposioAuthConfigsMock,
  resolveComposioToolkitMock,
  listWorkspaceIntegrationsMock,
  mintRelayfileTokenMock,
  readSessionFromRequestMock,
  replayOpMock,
  resolveApiTokenSessionMock,
  upsertWorkspaceIntegrationMock,
} = vi.hoisted(() => ({
  createConnectSessionMock: vi.fn(),
  deleteNangoConnectionMock: vi.fn(),
  deleteWorkspaceIntegrationMock: vi.fn(),
  fetchWorkspaceProviderSyncStatusMock: vi.fn(),
  findWorkspaceIntegrationByConnectionMock: vi.fn().mockResolvedValue(null),
  createComposioAuthConfigMock: vi.fn(),
  createComposioConnectionLinkMock: vi.fn(),
  getAuthContextMock: vi.fn(),
  getComposioConnectedAccountMock: vi.fn(),
  getNangoConnectionMock: vi.fn(),
  getWorkspaceIntegrationMock: vi.fn(),
  insertWorkspaceIntegrationIfAbsentMock: vi
    .fn()
    .mockResolvedValue({ inserted: true }),
  listComposioAuthConfigsMock: vi.fn(),
  resolveComposioToolkitMock: vi.fn(),
  listWorkspaceIntegrationsMock: vi.fn(),
  mintRelayfileTokenMock: vi.fn(),
  readSessionFromRequestMock: vi.fn(),
  replayOpMock: vi.fn(),
  resolveApiTokenSessionMock: vi.fn(),
  upsertWorkspaceIntegrationMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("sst", () => ({
  Resource: {
    AuthSessionSecret: { value: "test-auth-session-secret" },
  },
}));

vi.mock("@/lib/auth/api-token-store", () => ({
  readBearerToken(authHeader: string | null): string | null {
    if (!authHeader) {
      return null;
    }

    const trimmed = authHeader.trim();
    if (!trimmed.toLowerCase().startsWith("bearer ")) {
      return null;
    }

    const token = trimmed.slice(7).trim();
    return token.length > 0 ? token : null;
  },
  resolveApiTokenSession: (...args: unknown[]) =>
    resolveApiTokenSessionMock(...args),
}));

vi.mock("@/lib/auth/session", () => ({
  readSessionFromRequest: (...args: unknown[]) =>
    readSessionFromRequestMock(...args),
}));

vi.mock("../packages/web/lib/auth/auth-api.ts", () => ({
  getAuthContext: (...args: unknown[]) => getAuthContextMock(...args),
}));

vi.mock("@/lib/integrations/nango-service", () => ({
  createConnectSession: (...args: unknown[]) =>
    createConnectSessionMock(...args),
  deleteNangoConnection: (...args: unknown[]) =>
    deleteNangoConnectionMock(...args),
  getNangoConnection: (...args: unknown[]) => getNangoConnectionMock(...args),
  getNangoSecretKey: () => "test-nango-secret-key",
  triggerNangoSyncs: vi.fn(async () => ({ ok: true })),
  upsertNangoComposioBridgeConnection: vi.fn(async () => ({ ok: true })),
  getProviderConfigKey(provider: string): string {
    switch (provider) {
      case "github":
        return "github-relay";
      case "notion":
        return "notion-relay";
      case "linear":
        return "linear-relay";
      case "slack":
        return "slack-relay";
      default:
        return provider;
    }
  },
}));

vi.mock("@/lib/integrations/composio-service", () => ({
  createComposioAuthConfig: (...args: unknown[]) =>
    createComposioAuthConfigMock(...args),
  createComposioConnectionLink: (...args: unknown[]) =>
    createComposioConnectionLinkMock(...args),
  deleteComposioConnectedAccount: vi.fn(async () => true),
  getComposioConnectedAccount: (...args: unknown[]) =>
    getComposioConnectedAccountMock(...args),
  listComposioAuthConfigs: (...args: unknown[]) =>
    listComposioAuthConfigsMock(...args),
  resolveComposioToolkit: (...args: unknown[]) =>
    resolveComposioToolkitMock(...args),
}));

class FakeRelayFileApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, payload?: { code?: string; message?: string }) {
    super(payload?.message ?? "relayfile error");
    this.status = status;
    this.code = payload?.code ?? "relayfile_error";
  }
}

vi.mock("@relayfile/sdk", () => ({
  RelayFileApiError: FakeRelayFileApiError,
  RelayFileClient: class {
    constructor(_options: unknown) {}
    async replayOp(workspaceId: string, opId: string, correlationId?: string) {
      return replayOpMock(workspaceId, opId, correlationId);
    }
  },
}));

vi.mock("@cloud/core/relayfile/client.js", () => ({
  mintRelayfileToken: (...args: unknown[]) => mintRelayfileTokenMock(...args),
  mintScopedRelayfileToken: (...args: unknown[]) => mintRelayfileTokenMock(...args),
}));

vi.mock("@/lib/relayfile", () => ({
  resolveRelayfileConfig: () => ({
    relayfileUrl: "https://relayfile.test",
    relayAuthUrl: "https://relayauth.test",
    relayAuthApiKey: "test-relayauth-key",
  }),
}));

vi.mock("@/lib/integrations/workspace-integrations", () => ({
  deleteWorkspaceIntegration: (...args: unknown[]) =>
    deleteWorkspaceIntegrationMock(...args),
  findWorkspaceIntegrationByConnection: (...args: unknown[]) =>
    findWorkspaceIntegrationByConnectionMock(...args),
  getWorkspaceIntegration: (...args: unknown[]) =>
    getWorkspaceIntegrationMock(...args),
  insertWorkspaceIntegrationIfAbsent: (...args: unknown[]) =>
    insertWorkspaceIntegrationIfAbsentMock(...args),
  listWorkspaceIntegrations: (...args: unknown[]) =>
    listWorkspaceIntegrationsMock(...args),
  upsertWorkspaceIntegration: (...args: unknown[]) =>
    upsertWorkspaceIntegrationMock(...args),
}));

vi.mock("@/lib/integrations/provider-status", () => ({
  fetchWorkspaceProviderSyncStatus: (...args: unknown[]) =>
    fetchWorkspaceProviderSyncStatusMock(...args),
  deriveProviderState(input: {
    initialSync: { state: string };
    writeback: { state: string; lagSeconds: number | null };
  }): string {
    const { initialSync, writeback } = input;
    if (initialSync.state === "failed" || writeback.state === "error") {
      return "error";
    }
    if (initialSync.state === "complete") {
      if (
        writeback.state === "lagging" &&
        writeback.lagSeconds !== null &&
        writeback.lagSeconds > 600
      ) {
        return "degraded";
      }
      if (writeback.state === "paused") {
        return "degraded";
      }
      return "ready";
    }
    if (initialSync.state === "running") {
      return "syncing";
    }
    return "pending";
  },
  summarizeWritebackHealth(providerStatus: {
    status?: string;
    lagSeconds?: number;
    watermarkTs?: string | null;
    lastError?: string | null;
    deadLetteredEnvelopes?: number;
    deadLetteredOps?: number;
    failureCodes?: Record<string, number>;
    webhookHealthy?: boolean;
  } | null) {
    if (!providerStatus) {
      return {
        state: "unknown",
        lagSeconds: null,
        watermarkTs: null,
        lastError: null,
        deadLetteredEnvelopes: 0,
        deadLetteredOps: 0,
        failureCodes: {},
        webhookHealthy: null,
      };
    }

    const deadLetteredEnvelopes = providerStatus.deadLetteredEnvelopes ?? 0;
    const deadLetteredOps = providerStatus.deadLetteredOps ?? 0;
    let state = "healthy";
    if (providerStatus.status === "paused") {
      state = "paused";
    } else if (providerStatus.status === "error" || deadLetteredOps > 0 || providerStatus.lastError) {
      state = "error";
    } else if (providerStatus.status === "lagging" || deadLetteredEnvelopes > 0) {
      state = "lagging";
    }

    return {
      state,
      lagSeconds: providerStatus.lagSeconds ?? null,
      watermarkTs: providerStatus.watermarkTs ?? null,
      lastError: providerStatus.lastError ?? null,
      deadLetteredEnvelopes,
      deadLetteredOps,
      failureCodes: providerStatus.failureCodes ?? {},
      webhookHealthy:
        typeof providerStatus.webhookHealthy === "boolean"
          ? providerStatus.webhookHealthy
          : null,
    };
  },
}));

type ConnectSessionRouteModule = {
  POST: (
    request: Request,
    context: { params: Promise<{ workspaceId: string }> },
  ) => Promise<Response>;
};

type CliConnectLinkRouteModule = {
  POST: (request: Request) => Promise<Response>;
};

type StatusRouteModule = {
  DELETE: (
    request: NextRequest,
    context: { params: Promise<{ workspaceId: string; provider: string }> },
  ) => Promise<Response>;
  GET: (
    request: NextRequest,
    context: { params: Promise<{ workspaceId: string; provider: string }> },
  ) => Promise<Response>;
};

type IntegrationsListRouteModule = {
  GET: (
    request: NextRequest,
    context: { params: Promise<{ workspaceId: string }> },
  ) => Promise<Response>;
};

type WorkspaceSyncRouteModule = {
  GET: (
    request: NextRequest,
    context: { params: Promise<{ workspaceId: string }> },
  ) => Promise<Response>;
};

type OpReplayRouteModule = {
  POST: (
    request: NextRequest,
    context: { params: Promise<{ workspaceId: string; opId: string }> },
  ) => Promise<Response>;
};

function encodeBase64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function connectSessionContext(workspaceId = WORKSPACE_ID) {
  return {
    params: Promise.resolve({ workspaceId }),
  };
}

function statusContext(workspaceId = WORKSPACE_ID, provider = PROVIDER) {
  return {
    params: Promise.resolve({ workspaceId, provider }),
  };
}

async function loadConnectSessionRoute(): Promise<ConnectSessionRouteModule> {
  return import(
    new URL(
      "../packages/web/app/api/v1/workspaces/[workspaceId]/integrations/connect-session/route.ts",
      import.meta.url,
    ).href
  ) as Promise<ConnectSessionRouteModule>;
}

async function loadStatusRoute(): Promise<StatusRouteModule> {
  return import(
    new URL(
      "../packages/web/app/api/v1/workspaces/[workspaceId]/integrations/[provider]/status/route.ts",
      import.meta.url,
    ).href
  ) as Promise<StatusRouteModule>;
}

async function loadIntegrationsListRoute(): Promise<IntegrationsListRouteModule> {
  return import(
    new URL(
      "../packages/web/app/api/v1/workspaces/[workspaceId]/integrations/route.ts",
      import.meta.url,
    ).href
  ) as Promise<IntegrationsListRouteModule>;
}

async function loadWorkspaceSyncRoute(): Promise<WorkspaceSyncRouteModule> {
  return import(
    new URL(
      "../packages/web/app/api/v1/workspaces/[workspaceId]/sync/route.ts",
      import.meta.url,
    ).href
  ) as Promise<WorkspaceSyncRouteModule>;
}

async function loadOpReplayRoute(): Promise<OpReplayRouteModule> {
  return import(
    new URL(
      "../packages/web/app/api/v1/workspaces/[workspaceId]/ops/[opId]/replay/route.ts",
      import.meta.url,
    ).href
  ) as Promise<OpReplayRouteModule>;
}

async function loadCliConnectLinkRoute(): Promise<CliConnectLinkRouteModule> {
  return import(
    new URL(
      "../packages/web/app/api/v1/integrations/nango/connect-link/route.ts",
      import.meta.url,
    ).href
  ) as Promise<CliConnectLinkRouteModule>;
}

function buildConnectSessionRequest(
  workspaceId = WORKSPACE_ID,
  token?: string,
  body: Record<string, unknown> = {},
): Request {
  const headers = new Headers({
    "Content-Type": "application/json",
  });
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return new Request(
    `https://cloud.test/api/v1/workspaces/${workspaceId}/integrations/connect-session`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
  );
}

function buildStatusRequest(
  method: "GET" | "DELETE",
  {
    workspaceId = WORKSPACE_ID,
    provider = PROVIDER,
    token,
    connectionId,
  }: {
    workspaceId?: string;
    provider?: string;
    token?: string;
    connectionId?: string;
  } = {},
): NextRequest {
  const url = new URL(
    `https://cloud.test/api/v1/workspaces/${workspaceId}/integrations/${provider}/status`,
  );
  if (connectionId !== undefined) {
    url.searchParams.set("connectionId", connectionId);
  }

  const headers = new Headers();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  return new NextRequest(url, {
    method,
    headers,
  });
}

function integrationsListContext(workspaceId = WORKSPACE_ID) {
  return {
    params: Promise.resolve({ workspaceId }),
  };
}

function buildIntegrationsListRequest(
  {
    workspaceId = WORKSPACE_ID,
    token,
  }: {
    workspaceId?: string;
    token?: string;
  } = {},
): NextRequest {
  const url = new URL(
    `https://cloud.test/api/v1/workspaces/${workspaceId}/integrations`,
  );
  const headers = new Headers();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return new NextRequest(url, { method: "GET", headers });
}

function workspaceSyncContext(workspaceId = WORKSPACE_ID) {
  return {
    params: Promise.resolve({ workspaceId }),
  };
}

function buildWorkspaceSyncRequest(
  {
    workspaceId = WORKSPACE_ID,
    token,
  }: {
    workspaceId?: string;
    token?: string;
  } = {},
): NextRequest {
  const url = new URL(`https://cloud.test/api/v1/workspaces/${workspaceId}/sync`);
  const headers = new Headers();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return new NextRequest(url, { method: "GET", headers });
}

function opReplayContext(
  workspaceId = WORKSPACE_ID,
  opId = "op_test_123",
) {
  return {
    params: Promise.resolve({ workspaceId, opId }),
  };
}

function buildOpReplayRequest(
  {
    workspaceId = WORKSPACE_ID,
    opId = "op_test_123",
    token,
  }: {
    workspaceId?: string;
    opId?: string;
    token?: string;
  } = {},
): NextRequest {
  const url = new URL(
    `https://cloud.test/api/v1/workspaces/${workspaceId}/ops/${opId}/replay`,
  );
  const headers = new Headers();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return new NextRequest(url, { method: "POST", headers });
}

function buildCliConnectLinkRequest(
  token: string | undefined,
  body: Record<string, unknown>,
): Request {
  const headers = new Headers({
    "Content-Type": "application/json",
  });
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return new Request("https://cloud.test/api/v1/integrations/nango/connect-link", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function mockCliTokenSession(workspaceId = WORKSPACE_ID): string {
  resolveApiTokenSessionMock.mockResolvedValue({
    id: "api-session-1",
    userId: "user-cli",
    workspaceId,
    organizationId: "org-test",
    scopes: ["cli:auth"],
    subjectType: "user",
    runId: null,
  });
  return "cli-access-token";
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function installJwksFetchMock(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) !== JWKS_URL) {
        throw new Error(`Unexpected fetch: ${String(input)}`);
      }

      const kid = await keyIdFromPublicJwk(PUBLIC_JWK);
      return jsonResponse({
        keys: [
          {
            ...PUBLIC_JWK,
            kid,
            use: "sig",
            alg: "RS256",
          },
        ],
      });
    }),
  );
}

async function mintRelayfileToken(workspaceId: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const kid = await keyIdFromPublicJwk(PUBLIC_JWK);
  const claims: RelayAuthTokenClaims = {
    sub: "agent-test",
    org: "org-test",
    wks: workspaceId,
    workspace_id: workspaceId,
    agent_name: "agent-test",
    scopes: ["fs:read", "fs:write"],
    sponsorId: "user-test",
    sponsorChain: ["user-test", "agent-test"],
    token_type: "access",
    iss: RELAYAUTH_ISSUER,
    aud: ["relayfile"],
    exp: now + 3600,
    iat: now,
    jti: `tok-${workspaceId}`,
  };

  return signRs256(claims, PRIVATE_KEY_PEM, kid);
}

async function mintExpiredRelayfileToken(workspaceId: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const kid = await keyIdFromPublicJwk(PUBLIC_JWK);
  const claims: RelayAuthTokenClaims = {
    sub: "agent-test",
    org: "org-test",
    wks: workspaceId,
    workspace_id: workspaceId,
    agent_name: "agent-test",
    scopes: ["fs:read", "fs:write"],
    sponsorId: "user-test",
    sponsorChain: ["user-test", "agent-test"],
    token_type: "access",
    iss: RELAYAUTH_ISSUER,
    aud: ["relayfile"],
    exp: now - 60,
    iat: now - 120,
    jti: `tok-expired-${workspaceId}`,
  };

  return signRs256(claims, PRIVATE_KEY_PEM, kid);
}

function mintUnsignedRelayfileToken(workspaceId: string): string {
  const now = Math.floor(Date.now() / 1000);
  return [
    encodeBase64UrlJson({ alg: "none", typ: "JWT" }),
    encodeBase64UrlJson({
      sub: "agent-test",
      org: "org-test",
      wks: workspaceId,
      scopes: ["fs:read"],
      sponsorId: "user-test",
      sponsorChain: ["user-test", "agent-test"],
      token_type: "access",
      iss: RELAYAUTH_ISSUER,
      aud: ["relayfile"],
      exp: now + 3600,
      iat: now,
      jti: `unsigned-${workspaceId}`,
    }),
    "",
  ].join(".");
}

beforeEach(() => {
  vi.doUnmock("@/lib/auth/request-auth");
  createConnectSessionMock.mockReset();
  createComposioAuthConfigMock.mockReset();
  createComposioConnectionLinkMock.mockReset();
  deleteWorkspaceIntegrationMock.mockReset();
  getAuthContextMock.mockReset();
  getComposioConnectedAccountMock.mockReset();
  getNangoConnectionMock.mockReset();
  getWorkspaceIntegrationMock.mockReset();
  insertWorkspaceIntegrationIfAbsentMock.mockReset();
  listComposioAuthConfigsMock.mockReset();
  resolveComposioToolkitMock.mockReset();
  listWorkspaceIntegrationsMock.mockReset();
  mintRelayfileTokenMock.mockReset();
  replayOpMock.mockReset();
  readSessionFromRequestMock.mockReset();
  resolveApiTokenSessionMock.mockReset();
  fetchWorkspaceProviderSyncStatusMock.mockReset();

  createConnectSessionMock.mockResolvedValue({
    token: "nango-session-token",
    expiresAt: "2026-04-30T12:00:00.000Z",
    connectLink: "https://nango.test/connect",
  });
  createComposioConnectionLinkMock.mockResolvedValue({
    link_token: "composio-link-token",
    redirect_url: "https://composio.test/connect",
    connected_account_id: "ca_github_123",
  });
  listComposioAuthConfigsMock.mockResolvedValue([
    { id: "ac_github", toolkit: { slug: "github" } },
  ]);
  resolveComposioToolkitMock.mockImplementation(async (slug: string) => ({
    slug: slug === "dockerhub" ? "docker_hub" : slug,
    name: slug === "dockerhub" || slug === "docker_hub" ? "Docker Hub" : "GitHub",
  }));
  getComposioConnectedAccountMock.mockResolvedValue({
    id: "ca_github_123",
    status: "ACTIVE",
  });
  deleteNangoConnectionMock.mockResolvedValue(true);
  getNangoConnectionMock.mockResolvedValue({
    backend: "nango",
    connectionId: "conn_github_123",
    status: "active",
  });
  deleteWorkspaceIntegrationMock.mockResolvedValue(undefined);
  findWorkspaceIntegrationByConnectionMock.mockResolvedValue(null);
  upsertWorkspaceIntegrationMock.mockResolvedValue(undefined);
  insertWorkspaceIntegrationIfAbsentMock.mockResolvedValue({ inserted: true });
  getWorkspaceIntegrationMock.mockResolvedValue(null);
  listWorkspaceIntegrationsMock.mockResolvedValue([]);
  mintRelayfileTokenMock.mockResolvedValue("relayfile-test-token");
  replayOpMock.mockResolvedValue({ status: "queued", id: "queued-id" });
  readSessionFromRequestMock.mockReturnValue(null);
  resolveApiTokenSessionMock.mockResolvedValue(null);
  fetchWorkspaceProviderSyncStatusMock.mockResolvedValue(null);

  vi.stubEnv("RELAYAUTH_URL", RELAYAUTH_URL);
  vi.stubEnv("RELAYAUTH_ISSUER", RELAYAUTH_ISSUER);
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://cloud.test/cloud");
});

afterEach(() => {
  vi.doUnmock("@/lib/auth/request-auth");
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.resetModules();
});

describe("sdk setup client cloud routes", () => {
  it("accepts a verified relayfile JWT on connect-session and returns the workspace polling connectionId", async () => {
    installJwksFetchMock();
    const token = await mintRelayfileToken(WORKSPACE_ID);
    const { POST } = await loadConnectSessionRoute();

    const response = await POST(
      buildConnectSessionRequest(WORKSPACE_ID, token),
      connectSessionContext(WORKSPACE_ID),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      token: "nango-session-token",
      expiresAt: "2026-04-30T12:00:00.000Z",
      connectLink: "https://nango.test/connect",
      connectionId: WORKSPACE_ID,
    });
    expect(createConnectSessionMock).toHaveBeenCalledWith({
      endUserId: WORKSPACE_ID,
      endUserEmail: null,
      allowedIntegrations: undefined,
    });
  });

  it("accepts SDK provider names and existing Nango config keys on connect-session", async () => {
    // Backward-compat regression test: older Ricky CLI / SDK clients pass
    // legacy `-sage` config keys directly. We must keep accepting them
    // (passing them through unmodified) until clients move to `-relay`.
    // Bare provider names like "github" continue to resolve to the current
    // `defaultConfigKey`, which is now `github-relay`.
    installJwksFetchMock();
    const token = await mintRelayfileToken(WORKSPACE_ID);
    const { POST } = await loadConnectSessionRoute();

    const response = await POST(
      buildConnectSessionRequest(WORKSPACE_ID, token, {
        allowedIntegrations: ["github", "github-sage", "notion-sage"],
      }),
      connectSessionContext(WORKSPACE_ID),
    );

    expect(response.status).toBe(200);
    expect(createConnectSessionMock).toHaveBeenCalledWith({
      endUserId: WORKSPACE_ID,
      endUserEmail: null,
      // "github" resolved via provider id → new default `github-relay`.
      // "github-sage" / "notion-sage" passed through as legacy config keys.
      allowedIntegrations: ["github-relay", "github-sage", "notion-sage"],
    });
  });

  it("accepts the new `-relay` Nango config keys directly on connect-session", async () => {
    // Forward-compat: clients can already pass the new `-relay` keys before
    // we drop legacy compatibility. They're recognized as the catalog's
    // current defaultConfigKey set and pass through unmodified.
    installJwksFetchMock();
    const token = await mintRelayfileToken(WORKSPACE_ID);
    const { POST } = await loadConnectSessionRoute();

    const response = await POST(
      buildConnectSessionRequest(WORKSPACE_ID, token, {
        allowedIntegrations: ["github-relay", "notion-relay", "linear-relay"],
      }),
      connectSessionContext(WORKSPACE_ID),
    );

    expect(response.status).toBe(200);
    expect(createConnectSessionMock).toHaveBeenCalledWith({
      endUserId: WORKSPACE_ID,
      endUserEmail: null,
      allowedIntegrations: ["github-relay", "notion-relay", "linear-relay"],
    });
  });

  it("accepts notion on connect-session and preserves an upstream connectionId when provided", async () => {
    installJwksFetchMock();
    const token = await mintRelayfileToken(WORKSPACE_ID);
    createConnectSessionMock.mockResolvedValue({
      token: "nango-session-token",
      expiresAt: "2026-04-30T12:00:00.000Z",
      connectLink: "https://nango.test/connect",
      connectionId: "conn_notion_456",
    });
    const { POST } = await loadConnectSessionRoute();

    const response = await POST(
      buildConnectSessionRequest(WORKSPACE_ID, token, {
        allowedIntegrations: ["notion"],
      }),
      connectSessionContext(WORKSPACE_ID),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      backend: "nango",
      backendIntegrationId: "notion-relay",
      token: "nango-session-token",
      sessionToken: "nango-session-token",
      expiresAt: "2026-04-30T12:00:00.000Z",
      connectLink: "https://nango.test/connect",
      connectionId: "conn_notion_456",
      providers: [
        {
          id: "notion",
          backend: "nango",
          backendIntegrationId: "notion-relay",
          backendMetadata: {},
          configKey: "notion-relay",
          displayName: "Notion",
          providerConfigKey: "notion-relay",
          vfsRoot: "/notion",
        },
      ],
    });
    expect(createConnectSessionMock).toHaveBeenCalledWith({
      endUserId: WORKSPACE_ID,
      endUserEmail: null,
      allowedIntegrations: ["notion-relay"],
    });
  });

  it("rejects an unsigned relayfile JWT on connect-session", async () => {
    installJwksFetchMock();
    const token = mintUnsignedRelayfileToken(WORKSPACE_ID);
    const { POST } = await loadConnectSessionRoute();

    const response = await POST(
      buildConnectSessionRequest(WORKSPACE_ID, token),
      connectSessionContext(WORKSPACE_ID),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(createConnectSessionMock).not.toHaveBeenCalled();
  });

  it("rejects an expired relayfile JWT on connect-session", async () => {
    installJwksFetchMock();
    const token = await mintExpiredRelayfileToken(WORKSPACE_ID);
    const { POST } = await loadConnectSessionRoute();

    const response = await POST(
      buildConnectSessionRequest(WORKSPACE_ID, token),
      connectSessionContext(WORKSPACE_ID),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(createConnectSessionMock).not.toHaveBeenCalled();
  });

  it("rejects relayfile JWT workspace mismatch on connect-session", async () => {
    installJwksFetchMock();
    const token = await mintRelayfileToken(OTHER_WORKSPACE_ID);
    const { POST } = await loadConnectSessionRoute();

    const response = await POST(
      buildConnectSessionRequest(WORKSPACE_ID, token),
      connectSessionContext(WORKSPACE_ID),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden" });
  });

  it("rejects missing auth on connect-session", async () => {
    const { POST } = await loadConnectSessionRoute();

    const response = await POST(
      buildConnectSessionRequest(WORKSPACE_ID),
      connectSessionContext(WORKSPACE_ID),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("rejects unsupported allowedIntegrations values", async () => {
    installJwksFetchMock();
    const token = await mintRelayfileToken(WORKSPACE_ID);
    const { POST } = await loadConnectSessionRoute();

    const response = await POST(
      buildConnectSessionRequest(WORKSPACE_ID, token, {
        allowedIntegrations: ["github", "bogus-provider"],
      }),
      connectSessionContext(WORKSPACE_ID),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "unknown_provider",
    });
    expect(createConnectSessionMock).not.toHaveBeenCalled();
  });

  it("rejects a backend preference that workspace policy does not allow", async () => {
    installJwksFetchMock();
    const token = await mintRelayfileToken(WORKSPACE_ID);
    const { POST } = await loadConnectSessionRoute();

    const response = await POST(
      buildConnectSessionRequest(WORKSPACE_ID, token, {
        allowedIntegrations: ["notion"],
        requestedBackend: "composio",
      }),
      connectSessionContext(WORKSPACE_ID),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "backend_not_allowed",
    });
    expect(createConnectSessionMock).not.toHaveBeenCalled();
  });

  it("creates a Composio connect link when requested for an opted-in provider", async () => {
    installJwksFetchMock();
    const token = await mintRelayfileToken(WORKSPACE_ID);
    const { POST } = await loadConnectSessionRoute();

    const response = await POST(
      buildConnectSessionRequest(WORKSPACE_ID, token, {
        allowedIntegrations: ["github-relay"],
        requestedBackend: "composio",
      }),
      connectSessionContext(WORKSPACE_ID),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      backend: "composio",
      backendIntegrationId: "github",
      connectLink: "https://composio.test/connect",
      token: "composio-link-token",
      sessionToken: "composio-link-token",
      connectionId: "ca_github_123",
      backendMetadata: {
        authConfigId: "ac_github",
        toolkitSlug: "github",
      },
      providers: [
        expect.objectContaining({
          id: "github",
          backend: "composio",
          backendIntegrationId: "github",
        }),
      ],
    });
    expect(listComposioAuthConfigsMock).toHaveBeenCalledWith("github");
    expect(createComposioConnectionLinkMock).toHaveBeenCalledWith({
      userId: WORKSPACE_ID,
      authConfigId: "ac_github",
      callbackUrl: expect.stringContaining(
        "https://cloud.test/cloud/api/v1/webhooks/composio/connect/callback?state=",
      ),
      connectionData: {
        workspaceId: WORKSPACE_ID,
        provider: "github",
        backendIntegrationId: "github",
      },
    });
    expect(createConnectSessionMock).not.toHaveBeenCalled();
  });

  it("creates a Composio connect link for a dynamic toolkit slug", async () => {
    installJwksFetchMock();
    const token = await mintRelayfileToken(WORKSPACE_ID);
    const { POST } = await loadConnectSessionRoute();
    listComposioAuthConfigsMock.mockResolvedValueOnce([
      { id: "ac_dockerhub", toolkit: { slug: "docker_hub" } },
    ]);

    const response = await POST(
      buildConnectSessionRequest(WORKSPACE_ID, token, {
        allowedIntegrations: ["dockerhub"],
        requestedBackend: "composio",
      }),
      connectSessionContext(WORKSPACE_ID),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      backend: "composio",
      backendIntegrationId: "docker_hub",
      connectLink: "https://composio.test/connect",
      providers: [
        expect.objectContaining({
          id: "docker_hub",
          displayName: "Docker Hub",
          backend: "composio",
          backendIntegrationId: "docker_hub",
          providerConfigKey: "docker_hub-composio-relay",
        }),
      ],
    });
    expect(resolveComposioToolkitMock).toHaveBeenCalledWith("dockerhub");
    expect(createComposioConnectionLinkMock).toHaveBeenCalledWith(
      expect.objectContaining({
        authConfigId: "ac_dockerhub",
        connectionData: {
          workspaceId: WORKSPACE_ID,
          provider: "docker_hub",
          backendIntegrationId: "docker_hub",
        },
      }),
    );
    expect(createConnectSessionMock).not.toHaveBeenCalled();
  });

  it("creates a workspace-scoped Nango connect link for Ricky CLI integration requests", async () => {
    const token = mockCliTokenSession(WORKSPACE_ID);
    const { POST } = await loadCliConnectLinkRoute();

    const response = await POST(
      buildCliConnectLinkRequest(token, {
        integration: "slack",
        provider: "slack",
        workspaceId: WORKSPACE_ID,
        workspace: { workspaceId: WORKSPACE_ID },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      // Provider id is now `slack` (renamed from the legacy `slack-sage`,
      // which remains as a backwards-compat alias), and the config key is
      // `slack-relay` per the `<integration>-relay` convention.
      provider: "slack",
      providerConfigKey: "slack-relay",
      workspaceId: WORKSPACE_ID,
      connectUrl: "https://nango.test/connect",
      connectLink: "https://nango.test/connect",
      url: "https://nango.test/connect",
      connectionId: WORKSPACE_ID,
    });
    expect(createConnectSessionMock).toHaveBeenCalledWith({
      endUserId: WORKSPACE_ID,
      endUserEmail: null,
      allowedIntegrations: ["slack-relay"],
    });
  });

  it("eagerly writes a workspace_integrations row on CLI connect-link so the auth webhook is no longer load-bearing", async () => {
    const token = mockCliTokenSession(WORKSPACE_ID);
    const { POST } = await loadCliConnectLinkRoute();

    const response = await POST(
      buildCliConnectLinkRequest(token, {
        provider: "linear",
        workspaceId: WORKSPACE_ID,
      }),
    );

    expect(response.status).toBe(200);
    // Atomic INSERT ... ON CONFLICT DO NOTHING keyed on (workspaceId,
    // provider) — closes the read-then-upsert race the auth webhook
    // could otherwise slip into.
    expect(insertWorkspaceIntegrationIfAbsentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        provider: "linear",
        connectionId: WORKSPACE_ID,
        // Renamed from `linear-relay` to `linear-relay` per the new
        // `<integration>-relay` Nango integration naming convention.
        providerConfigKey: "linear-relay",
        installationId: null,
      }),
    );
    // The placeholder write must not go through the upsert path — that
    // path runs an unconditional conflict-update which would clobber a
    // live row written concurrently by the auth webhook.
    expect(upsertWorkspaceIntegrationMock).not.toHaveBeenCalled();
    // Placeholder rows now seed pending readiness so status routes don't
    // misread the empty-metadata row as a "legacy connected" integration.
    const insertCall =
      insertWorkspaceIntegrationIfAbsentMock.mock.calls[0][0] as {
        metadata: Record<string, unknown>;
      };
    const readiness = (insertCall.metadata as Record<string, unknown>)[
      "_relayfileProviderReadiness"
    ] as { initialSync: { state: string } };
    expect(readiness.initialSync.state).toBe("queued");
  });

  it("does not overwrite an existing workspace_integrations row on repeat CLI connect-link calls", async () => {
    // The helper reports a conflict — the existing row stays as-is and
    // we never fall through to upsertWorkspaceIntegration. This is the
    // happy-path "row already there" case (e.g. repeat connect-link
    // before OAuth completes).
    insertWorkspaceIntegrationIfAbsentMock.mockResolvedValue({
      inserted: false,
      existing: {
        workspaceId: WORKSPACE_ID,
        provider: "linear",
        connectionId: "real-nango-connection-id",
        providerConfigKey: "linear-relay",
        installationId: null,
        metadata: {},
      },
    });

    const token = mockCliTokenSession(WORKSPACE_ID);
    const { POST } = await loadCliConnectLinkRoute();

    const response = await POST(
      buildCliConnectLinkRequest(token, {
        provider: "linear",
        workspaceId: WORKSPACE_ID,
      }),
    );

    expect(response.status).toBe(200);
    expect(insertWorkspaceIntegrationIfAbsentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        provider: "linear",
      }),
    );
    expect(upsertWorkspaceIntegrationMock).not.toHaveBeenCalled();
  });

  it("does not clobber a live row when the auth webhook wins the connect-link race", async () => {
    // Race regression: simulate the helper reporting that a real
    // (workspaceId, provider) row already exists at INSERT time — i.e.
    // the auth webhook landed in the window between the connect-link
    // call and the eager placeholder write. The route must never call
    // upsertWorkspaceIntegration in this state, or the conflict-update
    // path would overwrite the live connectionId/installationId/
    // readiness blob with the placeholder values.
    insertWorkspaceIntegrationIfAbsentMock.mockResolvedValue({
      inserted: false,
      existing: {
        workspaceId: WORKSPACE_ID,
        provider: "linear",
        connectionId: "real-nango-connection-id",
        providerConfigKey: "linear-relay",
        installationId: "linear-installation-42",
        metadata: { _relayfileProviderReadiness: { initialSync: { state: "complete" } } },
      },
    });

    const token = mockCliTokenSession(WORKSPACE_ID);
    const { POST } = await loadCliConnectLinkRoute();

    const response = await POST(
      buildCliConnectLinkRequest(token, {
        provider: "linear",
        workspaceId: WORKSPACE_ID,
      }),
    );

    expect(response.status).toBe(200);
    expect(insertWorkspaceIntegrationIfAbsentMock).toHaveBeenCalledTimes(1);
    // The whole point of the fix: the placeholder must not reach the
    // upsert's conflict-update path under contention.
    expect(upsertWorkspaceIntegrationMock).not.toHaveBeenCalled();
  });

  it("accepts the nested workspace body shape Ricky sends for CLI connect links", async () => {
    const token = mockCliTokenSession(WORKSPACE_ID);
    const { POST } = await loadCliConnectLinkRoute();

    const response = await POST(
      buildCliConnectLinkRequest(token, {
        provider: "github",
        workspace: { workspaceId: WORKSPACE_ID },
      }),
    );

    expect(response.status).toBe(200);
    expect(createConnectSessionMock).toHaveBeenCalledWith({
      endUserId: WORKSPACE_ID,
      endUserEmail: null,
      allowedIntegrations: ["github-relay"],
    });
  });

  it("rejects CLI connect-link requests outside the authenticated workspace", async () => {
    const token = mockCliTokenSession(OTHER_WORKSPACE_ID);
    const { POST } = await loadCliConnectLinkRoute();

    const response = await POST(
      buildCliConnectLinkRequest(token, {
        provider: "notion",
        workspaceId: WORKSPACE_ID,
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden" });
    expect(createConnectSessionMock).not.toHaveBeenCalled();
  });

  it("rejects unsupported CLI connect-link providers", async () => {
    const token = mockCliTokenSession(WORKSPACE_ID);
    const { POST } = await loadCliConnectLinkRoute();

    const response = await POST(
      buildCliConnectLinkRequest(token, {
        provider: "dropbox",
        workspaceId: WORKSPACE_ID,
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "provider or integration must be one of: slack, github, notion, linear",
    });
    expect(createConnectSessionMock).not.toHaveBeenCalled();
  });

  it("returns ready false before the integration row exists when connectionId is omitted", async () => {
    installJwksFetchMock();
    const token = await mintRelayfileToken(WORKSPACE_ID);
    const { GET } = await loadStatusRoute();

    const response = await GET(
      buildStatusRequest("GET", { token }),
      statusContext(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ready: false,
      provider: PROVIDER,
      oauth: { connected: false },
      initialSync: { state: "unknown" },
      writeback: { state: "unknown" },
    });
    expect(getWorkspaceIntegrationMock).toHaveBeenCalledWith(WORKSPACE_ID, PROVIDER);
  });

  it("returns ready true when the integration row exists and connectionId is omitted", async () => {
    installJwksFetchMock();
    const token = await mintRelayfileToken(WORKSPACE_ID);
    getWorkspaceIntegrationMock.mockResolvedValue({
      workspaceId: WORKSPACE_ID,
      provider: PROVIDER,
      connectionId: "conn_github_123",
      providerConfigKey: "github-sage",
      installationId: null,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const { GET } = await loadStatusRoute();

    const response = await GET(
      buildStatusRequest("GET", { token }),
      statusContext(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ready: true,
      provider: PROVIDER,
      configKey: "github-sage",
      oauth: { connected: true },
      initialSync: { state: "complete" },
      writeback: { state: "unknown" },
    });
  });

  it("returns ready true when connectionId equals the workspaceId sentinel", async () => {
    installJwksFetchMock();
    const token = await mintRelayfileToken(WORKSPACE_ID);
    getWorkspaceIntegrationMock.mockResolvedValue({
      workspaceId: WORKSPACE_ID,
      provider: PROVIDER,
      connectionId: "conn_github_123",
      providerConfigKey: "github-sage",
      installationId: null,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const { GET } = await loadStatusRoute();

    const response = await GET(
      buildStatusRequest("GET", {
        token,
        connectionId: WORKSPACE_ID,
      }),
      statusContext(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ready: true,
      connectionMatched: true,
    });
  });

  it("returns ready true when the explicit actual connectionId matches the stored integration", async () => {
    installJwksFetchMock();
    const token = await mintRelayfileToken(WORKSPACE_ID);
    getWorkspaceIntegrationMock.mockResolvedValue({
      workspaceId: WORKSPACE_ID,
      provider: PROVIDER,
      connectionId: "conn_github_123",
      providerConfigKey: "github-sage",
      installationId: null,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const { GET } = await loadStatusRoute();

    const response = await GET(
      buildStatusRequest("GET", {
        token,
        connectionId: "conn_github_123",
      }),
      statusContext(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ready: true,
      connectionMatched: true,
      currentConnectionId: "conn_github_123",
    });
  });

  it("reports queued initial sync and unhealthy writeback separately from OAuth connection", async () => {
    installJwksFetchMock();
    const token = await mintRelayfileToken(WORKSPACE_ID);
    getWorkspaceIntegrationMock.mockResolvedValue({
      workspaceId: WORKSPACE_ID,
      provider: PROVIDER,
      connectionId: "conn_github_123",
      providerConfigKey: "github-sage",
      installationId: null,
      metadata: {
        _relayfileProviderReadiness: {
          oauthConnectedAt: "2026-05-02T10:00:00.000Z",
          lastAuthAt: "2026-05-02T10:00:00.000Z",
          connectionId: "conn_github_123",
          providerConfigKey: "github-sage",
          updatedAt: "2026-05-02T10:00:01.000Z",
          initialSync: {
            state: "queued",
            enqueuedAt: "2026-05-02T10:00:01.000Z",
            startedAt: null,
            completedAt: null,
            failedAt: null,
            lastError: null,
            syncName: "fetch-repos",
            model: "Repo",
            modifiedAfter: "2026-05-02T10:00:00.000Z",
          },
        },
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    fetchWorkspaceProviderSyncStatusMock.mockResolvedValue({
      provider: PROVIDER,
      status: "error",
      lagSeconds: 91,
      watermarkTs: "2026-05-02T10:00:03.000Z",
      lastError: "dead lettered writeback",
      deadLetteredEnvelopes: 1,
      deadLetteredOps: 2,
      failureCodes: { writeback_failed: 2 },
    });
    const { GET } = await loadStatusRoute();

    const response = await GET(
      buildStatusRequest("GET", { token }),
      statusContext(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ready: false,
      oauth: {
        connected: true,
        connectedAt: "2026-05-02T10:00:00.000Z",
      },
      initialSync: {
        state: "queued",
        syncName: "fetch-repos",
      },
      writeback: {
        state: "error",
        deadLetteredOps: 2,
        lagSeconds: 91,
      },
    });
  });

  it("returns an enriched notion status when the workspace polling key is used", async () => {
    installJwksFetchMock();
    const token = await mintRelayfileToken(WORKSPACE_ID);
    getWorkspaceIntegrationMock.mockResolvedValue({
      workspaceId: WORKSPACE_ID,
      provider: "notion",
      connectionId: "conn_notion_123",
      providerConfigKey: "notion-sage",
      installationId: null,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const { GET } = await loadStatusRoute();

    const response = await GET(
      buildStatusRequest("GET", {
        provider: "notion",
        token,
      }),
      statusContext(WORKSPACE_ID, "notion"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ready: true,
      provider: "notion",
      currentConnectionId: "conn_notion_123",
      state: "ready",
      vfsRoot: "/notion",
      oauth: {
        connected: true,
      },
      initialSync: {
        state: "complete",
      },
    });
  });

  it("returns an enriched ready notion status while ignoring legacy sync metadata", async () => {
    installJwksFetchMock();
    const token = await mintRelayfileToken(WORKSPACE_ID);
    getWorkspaceIntegrationMock.mockResolvedValue({
      workspaceId: WORKSPACE_ID,
      provider: "notion",
      connectionId: "conn_notion_123",
      providerConfigKey: "notion-sage",
      installationId: null,
      metadata: {
        mountedPath: "/notion",
        sync: {
          state: "failed",
          error: "Initial sync failed",
          startedAt: "2026-04-30T12:00:00.000Z",
        },
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const { GET } = await loadStatusRoute();

    const response = await GET(
      buildStatusRequest("GET", {
        provider: "notion",
        token,
        connectionId: "conn_notion_123",
      }),
      statusContext(WORKSPACE_ID, "notion"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ready: true,
      provider: "notion",
      currentConnectionId: "conn_notion_123",
      requestedConnectionId: "conn_notion_123",
      state: "ready",
      vfsRoot: "/notion",
      oauth: {
        connected: true,
      },
      initialSync: {
        state: "complete",
      },
    });
  });

  it("handles dynamic Composio providers on status GET and DELETE", async () => {
    installJwksFetchMock();
    const token = await mintRelayfileToken(WORKSPACE_ID);
    const { DELETE, GET } = await loadStatusRoute();

    const getResponse = await GET(
      buildStatusRequest("GET", { provider: "dockerhub", token }),
      statusContext(WORKSPACE_ID, "dockerhub"),
    );
    const deleteResponse = await DELETE(
      buildStatusRequest("DELETE", { provider: "dockerhub", token }),
      statusContext(WORKSPACE_ID, "dockerhub"),
    );

    expect(getResponse.status).toBe(200);
    await expect(getResponse.json()).resolves.toMatchObject({
      ready: false,
      provider: "docker_hub",
      backend: "composio",
      backendIntegrationId: "docker_hub",
      configKey: "docker_hub",
      vfsRoot: "/docker_hub",
      oauth: { connected: false },
    });
    expect(deleteResponse.status).toBe(200);
    await expect(deleteResponse.json()).resolves.toEqual({ success: true });
    expect(resolveComposioToolkitMock).toHaveBeenCalledWith("dockerhub");
  });

  it("rejects unknown dynamic providers that are not Composio toolkits", async () => {
    installJwksFetchMock();
    const token = await mintRelayfileToken(WORKSPACE_ID);
    resolveComposioToolkitMock.mockResolvedValueOnce(null);
    const { GET } = await loadStatusRoute();

    const response = await GET(
      buildStatusRequest("GET", { provider: "not-a-toolkit", token }),
      statusContext(WORKSPACE_ID, "not-a-toolkit"),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Integration provider not found",
      code: "unknown_provider",
    });
  });

  it("rejects missing auth on integration status GET and DELETE", async () => {
    const { DELETE, GET } = await loadStatusRoute();

    const getResponse = await GET(buildStatusRequest("GET"), statusContext());
    const deleteResponse = await DELETE(
      buildStatusRequest("DELETE"),
      statusContext(),
    );

    expect(getResponse.status).toBe(401);
    await expect(getResponse.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(deleteResponse.status).toBe(401);
    await expect(deleteResponse.json()).resolves.toEqual({
      error: "Unauthorized",
    });
  });

  it("rejects relayfile JWT workspace mismatch on integration status GET and DELETE", async () => {
    installJwksFetchMock();
    const token = await mintRelayfileToken(OTHER_WORKSPACE_ID);
    const { DELETE, GET } = await loadStatusRoute();

    const getResponse = await GET(
      buildStatusRequest("GET", { token }),
      statusContext(),
    );
    const deleteResponse = await DELETE(
      buildStatusRequest("DELETE", { token }),
      statusContext(),
    );

    expect(getResponse.status).toBe(403);
    await expect(getResponse.json()).resolves.toEqual({ error: "Forbidden" });
    expect(deleteResponse.status).toBe(403);
    await expect(deleteResponse.json()).resolves.toEqual({
      error: "Forbidden",
    });
  });

  it("returns 403 for a cloud session that lacks access to the workspace", async () => {
    vi.doMock("@/lib/auth/request-auth", () => ({
      resolveRequestAuth: vi.fn(async () => ({
        userId: "user-session",
        workspaceId: "workspace-local",
        organizationId: "org-test",
        source: "session",
        context: {
          user: { id: "user-session" },
          currentWorkspace: { id: "workspace-local" },
          currentOrganization: { id: "org-test" },
          workspaces: [{ id: OTHER_WORKSPACE_ID }],
        },
      })),
    }));
    const { GET } = await loadStatusRoute();

    const response = await GET(
      buildStatusRequest("GET"),
      statusContext(WORKSPACE_ID, PROVIDER),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden" });
    vi.doUnmock("@/lib/auth/request-auth");
    vi.resetModules();
  });

  it("disconnects integrations through DELETE and remains idempotent", async () => {
    vi.doUnmock("@/lib/auth/request-auth");
    vi.resetModules();
    installJwksFetchMock();
    const token = await mintRelayfileToken(WORKSPACE_ID);
    getWorkspaceIntegrationMock
      .mockResolvedValueOnce({
        workspaceId: WORKSPACE_ID,
        provider: PROVIDER,
        connectionId: "conn_github_123",
        providerConfigKey: "github-sage",
        installationId: null,
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .mockResolvedValueOnce(null);
    const { DELETE } = await loadStatusRoute();

    const first = await DELETE(
      buildStatusRequest("DELETE", { token }),
      statusContext(),
    );
    const second = await DELETE(
      buildStatusRequest("DELETE", { token }),
      statusContext(),
    );

    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({ success: true });
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toEqual({ success: true });
    expect(deleteNangoConnectionMock).toHaveBeenCalledWith(
      "conn_github_123",
      "github-sage",
    );
    expect(deleteWorkspaceIntegrationMock).toHaveBeenCalledTimes(1);
    expect(deleteWorkspaceIntegrationMock).toHaveBeenCalledWith(
      WORKSPACE_ID,
      PROVIDER,
    );
  });

  it("returns an empty array when no integrations are connected", async () => {
    installJwksFetchMock();
    const token = await mintRelayfileToken(WORKSPACE_ID);
    listWorkspaceIntegrationsMock.mockResolvedValue([]);
    const { GET } = await loadIntegrationsListRoute();

    const response = await GET(
      buildIntegrationsListRequest({ token }),
      integrationsListContext(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([]);
    expect(listWorkspaceIntegrationsMock).toHaveBeenCalledWith(WORKSPACE_ID);
  });

  it("lists connected integrations with writeback status and webhookHealthy", async () => {
    installJwksFetchMock();
    const token = await mintRelayfileToken(WORKSPACE_ID);
    listWorkspaceIntegrationsMock.mockResolvedValue([
      {
        workspaceId: WORKSPACE_ID,
        provider: "github",
        connectionId: "conn_github_123",
        providerConfigKey: "github-sage",
        installationId: null,
        metadata: {
          _relayfileProviderReadiness: {
            connectionId: "conn_github_123",
            providerConfigKey: "github-sage",
            initialSync: { state: "complete" },
          },
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        workspaceId: WORKSPACE_ID,
        provider: "notion",
        connectionId: "conn_notion_456",
        providerConfigKey: "notion-sage",
        installationId: null,
        metadata: {
          _relayfileProviderReadiness: {
            connectionId: "conn_notion_456",
            providerConfigKey: "notion-sage",
            initialSync: { state: "queued" },
          },
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    fetchWorkspaceProviderSyncStatusMock.mockImplementation(
      async (_workspaceId: string, provider: string) => {
        if (provider === "github") {
          return {
            provider: "github",
            status: "healthy",
            lagSeconds: 4,
            watermarkTs: "2026-05-02T10:00:03.000Z",
            webhookHealthy: true,
          };
        }
        if (provider === "notion") {
          return {
            provider: "notion",
            status: "lagging",
            lagSeconds: 78,
            watermarkTs: "2026-05-02T09:58:00.000Z",
            webhookHealthy: false,
          };
        }
        return null;
      },
    );
    const { GET } = await loadIntegrationsListRoute();

    const response = await GET(
      buildIntegrationsListRequest({ token }),
      integrationsListContext(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      {
        provider: "github",
        status: "ready",
        lagSeconds: 4,
        lastEventAt: "2026-05-02T10:00:03.000Z",
        connectionId: "conn_github_123",
        webhookHealthy: true,
      },
      {
        provider: "notion",
        status: "pending",
        lagSeconds: 78,
        lastEventAt: "2026-05-02T09:58:00.000Z",
        connectionId: "conn_notion_456",
        webhookHealthy: false,
      },
    ]);
  });

  it("rejects missing auth on integrations list", async () => {
    const { GET } = await loadIntegrationsListRoute();
    const response = await GET(
      buildIntegrationsListRequest(),
      integrationsListContext(),
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("rejects relayfile JWT workspace mismatch on integrations list", async () => {
    installJwksFetchMock();
    const token = await mintRelayfileToken(OTHER_WORKSPACE_ID);
    const { GET } = await loadIntegrationsListRoute();

    const response = await GET(
      buildIntegrationsListRequest({ token }),
      integrationsListContext(),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden" });
  });

  it("returns workspace sync aggregate mapped onto the contract enum", async () => {
    installJwksFetchMock();
    const token = await mintRelayfileToken(WORKSPACE_ID);
    listWorkspaceIntegrationsMock.mockResolvedValue([
      {
        workspaceId: WORKSPACE_ID,
        provider: "github",
        connectionId: "conn_github_123",
        providerConfigKey: "github-sage",
        installationId: null,
        metadata: {
          _relayfileProviderReadiness: {
            connectionId: "conn_github_123",
            providerConfigKey: "github-sage",
            initialSync: { state: "complete" },
          },
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        workspaceId: WORKSPACE_ID,
        provider: "notion",
        connectionId: "conn_notion_456",
        providerConfigKey: "notion-sage",
        installationId: null,
        metadata: {
          _relayfileProviderReadiness: {
            connectionId: "conn_notion_456",
            providerConfigKey: "notion-sage",
            initialSync: { state: "running" },
          },
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        workspaceId: WORKSPACE_ID,
        provider: "linear",
        connectionId: "conn_linear_789",
        providerConfigKey: "linear-relay",
        installationId: null,
        metadata: {
          _relayfileProviderReadiness: {
            connectionId: "conn_linear_789",
            providerConfigKey: "linear-relay",
            initialSync: { state: "complete" },
          },
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    fetchWorkspaceProviderSyncStatusMock.mockImplementation(
      async (_workspaceId: string, provider: string) => {
        if (provider === "github") {
          return {
            provider: "github",
            status: "healthy",
            lagSeconds: 4,
            watermarkTs: "2026-05-02T10:00:03.000Z",
            webhookHealthy: true,
          };
        }
        if (provider === "notion") {
          return {
            provider: "notion",
            status: "lagging",
            lagSeconds: 78,
            watermarkTs: "2026-05-02T09:58:00.000Z",
            webhookHealthy: false,
          };
        }
        if (provider === "linear") {
          // Watermark older than 10 minutes → degraded
          return {
            provider: "linear",
            status: "lagging",
            lagSeconds: 900,
            watermarkTs: "2026-05-02T09:45:00.000Z",
            webhookHealthy: true,
          };
        }
        return null;
      },
    );
    const { GET } = await loadWorkspaceSyncRoute();

    const response = await GET(
      buildWorkspaceSyncRequest({ token }),
      workspaceSyncContext(),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      workspaceId: string;
      providers: Array<{ provider: string; status: string; lagSeconds: number; webhookHealthy: boolean | null }>;
    };
    expect(body.workspaceId).toBe(WORKSPACE_ID);
    const byProvider = Object.fromEntries(
      body.providers.map((entry) => [entry.provider, entry]),
    );
    expect(byProvider.github.status).toBe("ready");
    expect(byProvider.github.webhookHealthy).toBe(true);
    expect(byProvider.notion.status).toBe("syncing");
    expect(byProvider.notion.webhookHealthy).toBe(false);
    expect(byProvider.linear.status).toBe("degraded");
  });

  it("rejects missing auth on workspace sync aggregate", async () => {
    const { GET } = await loadWorkspaceSyncRoute();
    const response = await GET(
      buildWorkspaceSyncRequest(),
      workspaceSyncContext(),
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("proxies op replay to relayfile and returns the queued response", async () => {
    installJwksFetchMock();
    const token = await mintRelayfileToken(WORKSPACE_ID);
    replayOpMock.mockResolvedValue({
      status: "queued",
      id: "op_test_123",
      correlationId: "corr-test",
    });
    const { POST } = await loadOpReplayRoute();

    const response = await POST(
      buildOpReplayRequest({ token, opId: "op_test_123" }),
      opReplayContext(WORKSPACE_ID, "op_test_123"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "queued",
      id: "op_test_123",
      correlationId: "corr-test",
    });
    expect(replayOpMock).toHaveBeenCalledWith(
      WORKSPACE_ID,
      "op_test_123",
      expect.any(String),
    );
  });

  it("surfaces relayfile 404 from op replay as 404", async () => {
    installJwksFetchMock();
    const token = await mintRelayfileToken(WORKSPACE_ID);
    replayOpMock.mockRejectedValue(
      new FakeRelayFileApiError(404, { code: "not_found", message: "op not found" }),
    );
    const { POST } = await loadOpReplayRoute();

    const response = await POST(
      buildOpReplayRequest({ token, opId: "missing-op" }),
      opReplayContext(WORKSPACE_ID, "missing-op"),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "op not found" });
  });

  it("rejects missing auth on op replay", async () => {
    const { POST } = await loadOpReplayRoute();
    const response = await POST(
      buildOpReplayRequest(),
      opReplayContext(),
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(replayOpMock).not.toHaveBeenCalled();
  });
});
