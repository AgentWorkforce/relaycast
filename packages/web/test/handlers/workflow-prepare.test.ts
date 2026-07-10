// @handler /api/v1/workflows/prepare
import { z } from "zod";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mintScopedS3Credentials: vi.fn(),
  createApiTokenSession: vi.fn(),
  resolveRequestAuth: vi.fn(),
  requireAuthScope: vi.fn(),
  requireSessionAuth: vi.fn(),
  workflowStorageBackend: "s3" as "s3" | "r2",
  buildCloudApiWorkflowStorageCredentials: vi.fn(),
  resources: {
    WorkflowStorage: {
      stsRoleArn: "arn:aws:iam::123456789012:role/workflow-storage",
      bucketName: "workflow-bucket",
    },
  },
}));

vi.mock("sst", () => ({
  Resource: mocks.resources,
}));

vi.mock("@/lib/aws/sts-credentials", () => ({
  mintScopedS3Credentials: mocks.mintScopedS3Credentials,
}));

vi.mock("@/lib/aws/broker-client", () => ({
  BrokerClientError: class BrokerClientError extends Error {
    readonly status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
      this.name = "BrokerClientError";
    }
  },
}));

vi.mock("@/lib/aws/runtime", () => ({
  isWorkerRuntime: () => false,
}));

vi.mock("@/lib/auth/request-auth", () => ({
  resolveRequestAuth: mocks.resolveRequestAuth,
  requireAuthScope: mocks.requireAuthScope,
  requireSessionAuth: mocks.requireSessionAuth,
}));

vi.mock("@/lib/auth/api-token-store", () => ({
  createApiTokenSession: mocks.createApiTokenSession,
}));

vi.mock("@/lib/app-origin", () => ({
  getConfiguredAppOrigin: () => "https://agentrelay.com/cloud",
}));

vi.mock("@/lib/storage", () => ({
  getWorkflowStorageBackend: () => mocks.workflowStorageBackend,
  buildCloudApiWorkflowStorageCredentials: mocks.buildCloudApiWorkflowStorageCredentials,
}));

import { POST } from "../../app/api/v1/workflows/prepare/route";

const responseSchema = z.object({
  runId: z.string().uuid(),
  s3CodeKey: z.literal("code.tar.gz"),
  s3Credentials: z.object({
    accessKeyId: z.string().min(1),
    secretAccessKey: z.string().min(1),
    sessionToken: z.string().min(1),
    bucket: z.string().min(1),
    prefix: z.string().min(1),
  }),
});

describe("POST /api/v1/workflows/prepare", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolveRequestAuth.mockResolvedValue({
      userId: "user_123",
      workspaceId: "rw_12345678",
      organizationId: "org_123",
      source: "session",
    });
    mocks.requireSessionAuth.mockReturnValue(true);
    mocks.requireAuthScope.mockReturnValue(true);
    mocks.workflowStorageBackend = "s3";
    mocks.buildCloudApiWorkflowStorageCredentials.mockImplementation(({ userId, runId, apiUrl, accessToken, refreshToken }) => ({
      backend: "cloud-api",
      accessKeyId: "cloud-api",
      secretAccessKey: "cloud-api",
      sessionToken: accessToken,
      bucket: "workflow-storage-r2",
      prefix: `${userId}/${runId}`,
      cloudApiUrl: apiUrl,
      cloudApiAccessToken: accessToken,
      ...(refreshToken ? { cloudApiRefreshToken: refreshToken } : {}),
    }));
    mocks.createApiTokenSession.mockResolvedValue({
      sessionId: "session-123",
      tokenFamilyId: "family-123",
      accessToken: "minted-access",
      accessTokenExpiresAt: "2026-05-21T12:00:00.000Z",
      refreshToken: "minted-refresh",
      refreshTokenExpiresAt: "2026-05-22T12:00:00.000Z",
      subjectType: "cli",
      scopes: ["workflow:invoke:write"],
    });
    mocks.resources.WorkflowStorage.stsRoleArn = "arn:aws:iam::123456789012:role/workflow-storage";
    mocks.resources.WorkflowStorage.bucketName = "workflow-bucket";
    mocks.mintScopedS3Credentials.mockResolvedValue({
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "secret",
      sessionToken: "session",
      bucket: "workflow-bucket",
      prefix: "user-123/run-123",
    });
  });

  it("returns 401 when auth is missing", async () => {
    mocks.resolveRequestAuth.mockResolvedValueOnce(null);
    const response = await POST(new Request("http://localhost/api/v1/workflows/prepare", {
      method: "POST",
    }) as never);
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");
  });

  it("returns 403 when the caller has neither session auth nor cli scope", async () => {
    mocks.requireSessionAuth.mockReturnValueOnce(false);
    mocks.requireAuthScope.mockReturnValueOnce(false);
    const response = await POST(new Request("http://localhost/api/v1/workflows/prepare", {
      method: "POST",
    }) as never);
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");
  });

  it("returns 500 when workflow storage bindings are missing", async () => {
    mocks.resources.WorkflowStorage.stsRoleArn = "";
    const response = await POST(new Request("http://localhost/api/v1/workflows/prepare", {
      method: "POST",
    }) as never);
    expect(response.status).toBe(500);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");
    await expect(response.json()).resolves.toEqual({
      error: "Server misconfigured: STS role or workflow storage bucket missing",
    });
  });

  it("mints S3 credentials and returns the documented response shape", async () => {
    const response = await POST(new Request("http://localhost/api/v1/workflows/prepare", {
      method: "POST",
    }) as never);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");
    const body = responseSchema.parse(await response.json());
    expect(body.s3Credentials.bucket).toBe("workflow-bucket");
    expect(mocks.mintScopedS3Credentials).toHaveBeenCalledWith({
      userId: "user_123",
      runId: body.runId,
      roleArn: "arn:aws:iam::123456789012:role/workflow-storage",
      bucket: "workflow-bucket",
    });
  });

  it("returns cloud-api workflow storage credentials when the Worker uses R2", async () => {
    mocks.workflowStorageBackend = "r2";
    mocks.resolveRequestAuth.mockResolvedValueOnce({
      userId: "user_123",
      workspaceId: "rw_12345678",
      organizationId: "org_123",
      source: "token",
      bearerToken: "cli-token",
      scopes: ["cli:auth"],
    });
    mocks.requireSessionAuth.mockReturnValueOnce(false);
    mocks.requireAuthScope.mockReturnValueOnce(true);

    const response = await POST(new Request("http://localhost/api/v1/workflows/prepare", {
      method: "POST",
    }) as never);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.workflowStorage).toEqual({ backend: "cloud-api" });
    expect(body.s3Credentials).toMatchObject({
      backend: "cloud-api",
      sessionToken: "cli-token",
      cloudApiAccessToken: "cli-token",
      prefix: `user_123/${body.runId}`,
    });
    expect(mocks.mintScopedS3Credentials).not.toHaveBeenCalled();
    expect(mocks.createApiTokenSession).not.toHaveBeenCalled();
  });

  it("mints upload credentials for session auth when the Worker uses R2", async () => {
    mocks.workflowStorageBackend = "r2";

    const response = await POST(new Request("http://localhost/api/v1/workflows/prepare", {
      method: "POST",
    }) as never);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.workflowStorage).toEqual({ backend: "cloud-api" });
    expect(body.s3Credentials).toMatchObject({
      backend: "cloud-api",
      sessionToken: "minted-access",
      cloudApiAccessToken: "minted-access",
      cloudApiRefreshToken: "minted-refresh",
      prefix: `user_123/${body.runId}`,
    });
    expect(mocks.createApiTokenSession).toHaveBeenCalledWith({
      subjectType: "cli",
      userId: "user_123",
      workspaceId: "rw_12345678",
      organizationId: "org_123",
      runId: body.runId,
      scopes: ["workflow:invoke:write"],
      accessTokenTtlSeconds: 60 * 30,
      refreshTokenTtlSeconds: 60 * 60 * 24,
    });
    expect(mocks.mintScopedS3Credentials).not.toHaveBeenCalled();
  });
});
