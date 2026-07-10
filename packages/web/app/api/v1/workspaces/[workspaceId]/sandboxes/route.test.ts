import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveRequestAuth: vi.fn(),
  hasWorkspaceAccess: vi.fn(),
  resolveServerDaytonaAuthParams: vi.fn(),
  readFile: vi.fn(),
  getDb: vi.fn(),
  normalizePersonaIntegrationSource: vi.fn((config: { source?: unknown } | null | undefined) =>
    config?.source ?? { kind: "deployer_user" }),
  resolvePersonaIntegrations: vi.fn(),
  serializeResolvedPersonaIntegrations: vi.fn((resolved: unknown) => resolved),
  recordWorkforceSandboxCreated: vi.fn(),
  recordWorkforceSandboxPathTokenMinted: vi.fn(),
  daytonaConstructor: vi.fn(),
  sstResources: {} as Record<string, { value?: string }>,
  daytona: {
    create: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
  },
  sandbox: {
    id: "sbx_test",
    organizationId: "org_daytona",
    process: {
      executeCommand: vi.fn(),
    },
    fs: {
      uploadFile: vi.fn(),
    },
  },
  db: {
    insert: vi.fn(),
    select: vi.fn(),
    update: vi.fn(),
  },
  sandboxRows: [] as Array<{ id: string }>,
}));

function relayfileTokenPair() {
  return {
    accessToken: "relay_pa_scoped",
    accessTokenExpiresAt: "2026-06-13T20:00:00.000Z",
    refreshToken: "relay_pa_scoped_refresh",
    refreshTokenExpiresAt: "2026-06-14T19:00:00.000Z",
    tokenType: "Bearer",
  };
}

vi.mock("node:fs/promises", () => ({
  readFile: mocks.readFile,
}));

vi.mock("@/lib/auth/request-auth", () => ({
  resolveRequestAuth: mocks.resolveRequestAuth,
}));

vi.mock("@/lib/integrations/integration-route-handler", () => ({
  hasWorkspaceAccess: mocks.hasWorkspaceAccess,
}));

vi.mock("@/lib/integrations/persona-integration-config", () => ({
  normalizePersonaIntegrationSource: mocks.normalizePersonaIntegrationSource,
}));

vi.mock("@/lib/daytona-auth", () => ({
  resolveServerDaytonaAuthParams: mocks.resolveServerDaytonaAuthParams,
}));

vi.mock("@/lib/db", () => ({
  getDb: mocks.getDb,
}));

vi.mock("@/lib/integrations/persona-integration-resolver", () => ({
  normalizePersonaIntegrationSource: mocks.normalizePersonaIntegrationSource,
  resolvePersonaIntegrations: mocks.resolvePersonaIntegrations,
  serializeResolvedPersonaIntegrations: mocks.serializeResolvedPersonaIntegrations,
}));

vi.mock("@daytonaio/sdk", () => ({
  Daytona: mocks.daytonaConstructor,
}));

vi.mock("sst", () => ({
  Resource: mocks.sstResources,
}));

vi.mock("@cloud/core/config/snapshot.js", () => ({
  getSnapshotName: vi.fn(async () => "snapshot-test"),
}));

vi.mock("./workforce-sandbox-audit", () => ({
  recordWorkforceSandboxCreated: mocks.recordWorkforceSandboxCreated,
  recordWorkforceSandboxPathTokenMinted: mocks.recordWorkforceSandboxPathTokenMinted,
}));

import { POST as createSandbox } from "./route";
import { DELETE as deleteSandbox } from "./[sandboxId]/route";
import { POST as execSandbox } from "./[sandboxId]/exec/route";
import { PUT as uploadFiles } from "./[sandboxId]/files/route";

const auth = {
  userId: "00000000-0000-0000-0000-000000000001",
  workspaceId: "00000000-0000-0000-0000-000000000002",
  organizationId: "00000000-0000-0000-0000-000000000003",
  source: "token",
  scopes: ["cli:auth"],
};

function request(body?: unknown, headers?: Record<string, string>): NextRequest {
  return new NextRequest(
    "https://cloud.test/api/v1/workspaces/00000000-0000-0000-0000-000000000002/sandboxes",
    {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
    },
  );
}

function context(sandboxId = "sbx_test") {
  return {
    params: Promise.resolve({
      workspaceId: "00000000-0000-0000-0000-000000000002",
      sandboxId,
    }),
  };
}

function mockDb() {
  mocks.db.insert.mockReturnValue({
    values: vi.fn(async () => undefined),
  });
  mocks.db.select.mockReturnValue({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => mocks.sandboxRows),
      })),
    })),
  });
  mocks.db.update.mockReturnValue({
    set: vi.fn(() => ({
      where: vi.fn(async () => undefined),
    })),
  });
  mocks.getDb.mockReturnValue(mocks.db);
}

describe("workspace sandbox routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    for (const key of Object.keys(mocks.sstResources)) {
      delete mocks.sstResources[key];
    }
    mocks.sandboxRows = [{ id: "sbx_test" }];
    mocks.resolveRequestAuth.mockResolvedValue(auth);
    mocks.hasWorkspaceAccess.mockReturnValue(true);
    mocks.resolveServerDaytonaAuthParams.mockReturnValue({ daytonaApiKey: "daytona-key" });
    mocks.readFile.mockRejectedValue(Object.assign(new Error("not found"), { code: "ENOENT" }));
    mocks.normalizePersonaIntegrationSource.mockImplementation(
      (config: { source?: unknown } | null | undefined) =>
        config?.source ?? { kind: "deployer_user" },
    );
    mocks.serializeResolvedPersonaIntegrations.mockImplementation((resolved: unknown) => resolved);
    mocks.daytonaConstructor.mockImplementation(function () {
      return mocks.daytona;
    } as never);
    mocks.daytona.create.mockResolvedValue(mocks.sandbox);
    mocks.daytona.get.mockResolvedValue(mocks.sandbox);
    mocks.daytona.delete.mockResolvedValue(undefined);
    mocks.resolvePersonaIntegrations.mockResolvedValue({
      slack: {
        provider: "slack",
        source: { kind: "workspace" },
        adapter: "nango",
        workspace_integration: {
          connectionId: "workspace-slack",
        },
        backendConnection: {
          backend: "nango",
          connectionId: "workspace-slack",
          status: "active",
        },
      },
    });
    mocks.sandbox.process.executeCommand.mockResolvedValue({
      exitCode: 0,
      result: "ok\n",
    });
    mocks.sandbox.fs.uploadFile.mockResolvedValue(undefined);
    mockDb();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("creates a workforce-deploy sandbox and returns proxy handle URLs", async () => {
    const response = await createSandbox(
      request({
        purpose: "workforce-deploy",
        personaId: "weekly-digest",
        label: "weekly",
        env: { NODE_ENV: "test" },
        timeoutSeconds: 3600,
      }),
      context(),
    );

    expect(response.status).toBe(201);
    expect(mocks.daytonaConstructor).toHaveBeenCalledWith({ apiKey: "daytona-key" });
    expect(mocks.daytona.create).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshot: "snapshot-test",
        language: "typescript",
        name: "weekly",
        envVars: {
          NODE_ENV: "test",
          RELAY_AGENT_NAME: "weekly-digest",
          RELAY_DEFAULT_WORKSPACE: auth.workspaceId,
        },
        labels: expect.objectContaining({
          purpose: "workforce-deploy",
          personaId: "weekly-digest",
        }),
      }),
      { timeout: 120 },
    );
    expect(mocks.db.insert).toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      sandboxId: "sbx_test",
      status: "running",
      authMode: "proxy",
      organizationId: "org_daytona",
      execUrl:
        "https://cloud.test/api/v1/workspaces/00000000-0000-0000-0000-000000000002/sandboxes/sbx_test/exec",
      filesUrl:
        "https://cloud.test/api/v1/workspaces/00000000-0000-0000-0000-000000000002/sandboxes/sbx_test/files",
    });
  });

  it("mints a path-scoped relayfile token from persona watch globs and injects only that token into the sandbox env", async () => {
    mocks.sstResources.RelayauthUrl = { value: "https://relayauth.resource.test" };
    vi.stubEnv("WEB_RELAYAUTH_URL", "https://relayauth.env.test");
    mocks.readFile.mockResolvedValue(JSON.stringify({
      id: "review-agent",
      integrations: {
        github: {
          triggers: [
            {
              trigger: { on: "pull_request.opened" },
              watchGlobs: ["/github/pull_requests/**"],
            },
          ],
        },
      },
    }));
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(relayfileTokenPair()), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await createSandbox(
      request(
        {
          purpose: "workforce-deploy",
          personaId: "review-agent",
          agentId: "agent_123",
          env: { NODE_ENV: "test" },
          timeoutSeconds: 1800,
        },
        { authorization: "Bearer relay_ws_workspace" },
      ),
      context(),
    );

    expect(response.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0] as unknown as [
      RequestInfo | URL,
      RequestInit,
    ];
    expect(String(input)).toBe("https://relayauth.resource.test/v1/tokens/path");
    const headers = init?.headers as Headers;
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("authorization")).toBe("Bearer relay_ws_workspace");
    expect(JSON.parse(String(init?.body))).toEqual({
      workspaceId: "00000000-0000-0000-0000-000000000002",
      paths: ["/github/pull_requests/**"],
      ttlSeconds: 1800,
      refreshTokenTtlSeconds: 60 * 60 * 24 * 90,
      agentName: "agent_123",
    });
    const sandboxEnv = mocks.daytona.create.mock.calls[0]?.[0]?.envVars as
      | Record<string, string>
      | undefined;
    expect(sandboxEnv).toEqual({
      NODE_ENV: "test",
      RELAYFILE_TOKEN: "relay_pa_scoped",
      RELAYFILE_MOUNT_PATHS: JSON.stringify(["/github/pull_requests/**"]),
      RELAY_AGENT_NAME: "agent_123",
      RELAY_DEFAULT_WORKSPACE: auth.workspaceId,
    });
    expect(Object.keys(sandboxEnv ?? {}).sort()).toEqual([
      "NODE_ENV",
      "RELAYFILE_MOUNT_PATHS",
      "RELAYFILE_TOKEN",
      "RELAY_AGENT_NAME",
      "RELAY_DEFAULT_WORKSPACE",
    ].sort());
    expect(mocks.daytona.create).toHaveBeenCalledWith(
      expect.objectContaining({
        envVars: {
          NODE_ENV: "test",
          RELAYFILE_TOKEN: "relay_pa_scoped",
          RELAYFILE_MOUNT_PATHS: JSON.stringify(["/github/pull_requests/**"]),
          RELAY_AGENT_NAME: "agent_123",
          RELAY_DEFAULT_WORKSPACE: auth.workspaceId,
        },
      }),
      { timeout: 120 },
    );
    expect(mocks.recordWorkforceSandboxCreated).toHaveBeenCalled();
    expect(mocks.recordWorkforceSandboxPathTokenMinted).toHaveBeenCalledWith({
      workspaceId: "00000000-0000-0000-0000-000000000002",
      personaId: "review-agent",
      agentId: "agent_123",
      sandboxId: "sbx_test",
      requester: auth.userId,
      paths: ["/github/pull_requests/**"],
    });
  });

  it("derives relayfile paths from persona integration triggers in the sandbox endpoint", async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify({
      id: "review-agent",
      integrations: {
        github: {
          triggers: [{ trigger: { on: "pull_request.opened" } }],
        },
      },
    }));
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(relayfileTokenPair()), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await createSandbox(
      request(
        {
          purpose: "workforce-deploy",
          personaId: "review-agent",
          timeoutSeconds: 1800,
        },
        { authorization: "Bearer relay_ws_workspace" },
      ),
      context(),
    );

    expect(response.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      RequestInfo | URL,
      RequestInit,
    ];
    expect(JSON.parse(String(init?.body))).toEqual({
      workspaceId: "00000000-0000-0000-0000-000000000002",
      paths: ["/github/repos/**/**/pulls/**"],
      ttlSeconds: 1800,
      refreshTokenTtlSeconds: 60 * 60 * 24 * 90,
      agentName: "review-agent",
    });
    expect(mocks.daytona.create).toHaveBeenCalledWith(
      expect.objectContaining({
        envVars: {
          RELAYFILE_TOKEN: "relay_pa_scoped",
          RELAYFILE_MOUNT_PATHS: JSON.stringify(["/github/repos/**/**/pulls/**"]),
          RELAY_AGENT_NAME: "review-agent",
          RELAY_DEFAULT_WORKSPACE: auth.workspaceId,
        },
      }),
      { timeout: 120 },
    );
  });

  it("rejects client-supplied relayfile paths instead of trusting request scopes", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await createSandbox(
      request(
        {
          purpose: "workforce-deploy",
          personaId: "review-agent",
          relayfilePaths: ["/linear/issues/**"],
          timeoutSeconds: 1800,
        },
        { authorization: "Bearer relay_ws_workspace" },
      ),
      context(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid request body",
      code: "invalid_request",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.daytona.create).not.toHaveBeenCalled();
  });

  it("keeps the legacy sandbox path working without a relayfile token mint", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await createSandbox(
      request({
        purpose: "workforce-deploy",
        personaId: "weekly-digest",
        timeoutSeconds: 3600,
      }),
      context(),
    );

    expect(response.status).toBe(201);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.daytona.create).toHaveBeenCalledWith(
      expect.objectContaining({
        envVars: {
          RELAY_AGENT_NAME: "weekly-digest",
          RELAY_DEFAULT_WORKSPACE: auth.workspaceId,
        },
      }),
      { timeout: 120 },
    );
  });

  it("resolves persona integrations during workforce-deploy sandbox creation", async () => {
    const response = await createSandbox(
      request({
        purpose: "workforce-deploy",
        personaId: "weekly-digest",
        env: { NODE_ENV: "test" },
        integrations: {
          slack: { source: { kind: "workspace" } },
          linear: {},
        },
        timeoutSeconds: 3600,
      }),
      context(),
    );

    expect(response.status).toBe(201);
    expect(mocks.normalizePersonaIntegrationSource).toHaveBeenCalledWith({ source: { kind: "workspace" } });
    expect(mocks.normalizePersonaIntegrationSource).toHaveBeenCalledWith({});
    expect(mocks.resolvePersonaIntegrations).toHaveBeenCalledWith({
      workspaceId: auth.workspaceId,
      deployerUserId: auth.userId,
      integrations: {
        slack: { source: { kind: "workspace" } },
        linear: { source: { kind: "deployer_user" } },
      },
    });
    expect(mocks.serializeResolvedPersonaIntegrations).toHaveBeenCalled();
    expect(mocks.daytona.create).toHaveBeenCalledWith(
      expect.objectContaining({
        envVars: expect.objectContaining({
          NODE_ENV: "test",
          AGENT_WORKFORCE_PERSONA_INTEGRATIONS: JSON.stringify({
            slack: {
              provider: "slack",
              source: { kind: "workspace" },
              adapter: "nango",
              workspace_integration: {
                connectionId: "workspace-slack",
              },
              backendConnection: {
                backend: "nango",
                connectionId: "workspace-slack",
                status: "active",
              },
            },
          }),
        }),
      }),
      { timeout: 120 },
    );
  });

  it("does not create a sandbox when persona integration resolution fails", async () => {
    mocks.resolvePersonaIntegrations.mockRejectedValueOnce(new Error("missing integration"));

    const response = await createSandbox(
      request({
        purpose: "workforce-deploy",
        personaId: "weekly-digest",
        integrations: {
          slack: { source: { kind: "workspace" } },
        },
        timeoutSeconds: 3600,
      }),
      context(),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "missing integration",
      code: "integration_resolution_failed",
    });
    expect(mocks.daytona.create).not.toHaveBeenCalled();
  });


  it("rolls back the Daytona sandbox when the DB insert fails", async () => {
    // Daytona create succeeds, DB insert blows up — the route should
    // clean up the just-created sandbox so we don't leak billed
    // resources keyed to a row that never got written.
    mocks.db.insert.mockReturnValueOnce({
      values: vi.fn(async () => {
        throw new Error("simulated DB failure");
      }),
    });
    mocks.daytona.get.mockResolvedValueOnce(mocks.sandbox);
    mocks.daytona.delete.mockResolvedValueOnce(undefined);

    const response = await createSandbox(
      request({
        purpose: "workforce-deploy",
        personaId: "weekly-digest",
        timeoutSeconds: 60,
      }),
      context(),
    );

    expect(response.status).toBe(503);
    // Rollback uses the same Daytona client to resolve + delete the
    // orphaned sandbox.
    expect(mocks.daytona.get).toHaveBeenCalledWith("sbx_test");
    expect(mocks.daytona.delete).toHaveBeenCalledWith(mocks.sandbox);
    // The audit log should NOT fire when the row never persisted.
    expect(mocks.recordWorkforceSandboxCreated).not.toHaveBeenCalled();
  });

  it("rejects invalid create bodies with the v1 error envelope", async () => {
    const response = await createSandbox(
      request({ purpose: "other", personaId: "weekly-digest" }),
      context(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid request body",
      code: "invalid_request",
    });
    expect(mocks.daytona.create).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated callers before creating a sandbox", async () => {
    mocks.resolveRequestAuth.mockResolvedValue(null);

    const response = await createSandbox(
      request({ purpose: "workforce-deploy", personaId: "weekly-digest" }),
      context(),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Unauthorized",
      code: "unauthorized",
    });
    expect(mocks.daytona.create).not.toHaveBeenCalled();
  });

  it("executes a command through the managed sandbox proxy", async () => {
    const response = await execSandbox(
      request({ command: "node -e 'console.log(1)'", cwd: "/workspace" }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(mocks.daytona.get).toHaveBeenCalledWith("sbx_test");
    expect(mocks.sandbox.process.executeCommand).toHaveBeenCalledWith(
      "node -e 'console.log(1)'",
      "/workspace",
      undefined,
      60,
    );
    await expect(response.json()).resolves.toEqual({
      sandboxId: "sbx_test",
      exitCode: 0,
      output: "ok\n",
    });
  });

  it("preserves stderr from split Daytona artifacts in the managed sandbox proxy", async () => {
    mocks.sandbox.process.executeCommand.mockResolvedValueOnce({
      exitCode: 7,
      artifacts: {
        stdout: "stdout-only\n",
        stderr: "stderr-only\n",
      },
    });

    const response = await execSandbox(
      request({ command: "node split.js", cwd: "/workspace" }),
      context(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      sandboxId: "sbx_test",
      exitCode: 7,
      output: "stdout-only\nstderr-only\n",
    });
  });

  it("uploads base64 file entries through the managed sandbox proxy", async () => {
    const response = await uploadFiles(
      request({
        entries: [
          {
            source: Buffer.from("hello").toString("base64"),
            destination: "/workspace/hello.txt",
          },
        ],
      }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(mocks.sandbox.fs.uploadFile).toHaveBeenCalledWith(
      Buffer.from("hello"),
      "/workspace/hello.txt",
    );
    await expect(response.json()).resolves.toEqual({
      sandboxId: "sbx_test",
      uploaded: 1,
    });
  });

  it("returns not_found when a proxied sandbox is outside the workspace", async () => {
    mocks.sandboxRows = [];

    const response = await execSandbox(
      request({ command: "pwd" }),
      context("sbx_missing"),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Sandbox not found",
      code: "sandbox_not_found",
    });
    expect(mocks.daytona.get).not.toHaveBeenCalled();
  });

  it("deletes a managed sandbox and marks the local record deleted", async () => {
    const response = await deleteSandbox(request(), context());

    expect(response.status).toBe(200);
    expect(mocks.daytona.delete).toHaveBeenCalledWith(mocks.sandbox);
    expect(mocks.db.update).toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      sandboxId: "sbx_test",
      deleted: true,
    });
  });

  it("records an audit entry on successful sandbox creation", async () => {
    await createSandbox(
      request({
        purpose: "workforce-deploy",
        personaId: "weekly-digest",
        timeoutSeconds: 3600,
      }),
      context(),
    );

    expect(mocks.recordWorkforceSandboxCreated).toHaveBeenCalledWith({
      workspaceId: "00000000-0000-0000-0000-000000000002",
      personaId: "weekly-digest",
      sandboxId: "sbx_test",
      requester: auth.userId,
      organizationId: "org_daytona",
      timeoutSeconds: 3600,
    });
  });

  it("rejects exec calls with an invalid body using the v1 error envelope", async () => {
    const response = await execSandbox(
      request({ command: "" }),
      context(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid request body",
      code: "invalid_request",
    });
    expect(mocks.daytona.get).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated exec callers", async () => {
    mocks.resolveRequestAuth.mockResolvedValue(null);

    const response = await execSandbox(
      request({ command: "pwd" }),
      context(),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Unauthorized",
      code: "unauthorized",
    });
    expect(mocks.daytona.get).not.toHaveBeenCalled();
  });

  it("rejects file uploads with an invalid body using the v1 error envelope", async () => {
    const response = await uploadFiles(
      request({ entries: [] }),
      context(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid request body",
      code: "invalid_request",
    });
    expect(mocks.sandbox.fs.uploadFile).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated file upload callers", async () => {
    mocks.resolveRequestAuth.mockResolvedValue(null);

    const response = await uploadFiles(
      request({
        entries: [
          {
            source: Buffer.from("hello").toString("base64"),
            destination: "/workspace/hello.txt",
          },
        ],
      }),
      context(),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Unauthorized",
      code: "unauthorized",
    });
    expect(mocks.sandbox.fs.uploadFile).not.toHaveBeenCalled();
  });

  it("returns not_found when uploading files to a sandbox outside the workspace", async () => {
    mocks.sandboxRows = [];

    const response = await uploadFiles(
      request({
        entries: [
          {
            source: Buffer.from("hello").toString("base64"),
            destination: "/workspace/hello.txt",
          },
        ],
      }),
      context("sbx_missing"),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Sandbox not found",
      code: "sandbox_not_found",
    });
    expect(mocks.sandbox.fs.uploadFile).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated delete callers", async () => {
    mocks.resolveRequestAuth.mockResolvedValue(null);

    const response = await deleteSandbox(request(), context());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Unauthorized",
      code: "unauthorized",
    });
    expect(mocks.daytona.delete).not.toHaveBeenCalled();
  });

  it("returns not_found when deleting a sandbox outside the workspace", async () => {
    mocks.sandboxRows = [];

    const response = await deleteSandbox(request(), context("sbx_missing"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Sandbox not found",
      code: "sandbox_not_found",
    });
    expect(mocks.daytona.delete).not.toHaveBeenCalled();
  });
});
