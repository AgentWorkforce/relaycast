import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test as nodeTest } from "node:test";
import { fileURLToPath } from "node:url";

const isVitestRuntime =
  process.env.VITEST_WORKER_ID !== undefined ||
  process.env.VITEST_POOL_ID !== undefined ||
  process.argv.some((arg) => arg.includes("vitest"));

if (!isVitestRuntime) {
  nodeTest("workflow repository allowlist routes", () => {
    const result = spawnSync(
      process.execPath,
      ["./node_modules/vitest/vitest.mjs", "run", fileURLToPath(import.meta.url)],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, FORCE_COLOR: "0" },
      },
    );

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
} else {
const { afterEach, beforeEach, describe, expect, it, vi } = await import("vitest");
const { createRelayfileWritebackPgliteDb } = await import("./helpers/relayfile-writeback-pglite-db.ts");

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const ORG_ID = "44444444-4444-4444-8444-444444444444";

const { resolveRequestAuthMock, loggerInfoMock } = vi.hoisted(() => ({
  resolveRequestAuthMock: vi.fn(),
  loggerInfoMock: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  resolveRequestAuth: (...args: unknown[]) => resolveRequestAuthMock(...args),
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: (...args: unknown[]) => loggerInfoMock(...args),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    notice: vi.fn(),
    captureError: vi.fn(),
  },
}));

type BaseRouteModule = {
  GET: (
    request: Request,
    context: { params: Promise<{ workspaceId: string }> },
  ) => Promise<Response>;
  POST: (
    request: Request,
    context: { params: Promise<{ workspaceId: string }> },
  ) => Promise<Response>;
};

type ItemRouteModule = {
  GET: (
    request: Request,
    context: { params: Promise<{ workspaceId: string; owner: string; repo: string }> },
  ) => Promise<Response>;
  PATCH: (
    request: Request,
    context: { params: Promise<{ workspaceId: string; owner: string; repo: string }> },
  ) => Promise<Response>;
  DELETE: (
    request: Request,
    context: { params: Promise<{ workspaceId: string; owner: string; repo: string }> },
  ) => Promise<Response>;
};

let cleanupDb: (() => Promise<void>) | undefined;

function sessionAuth(workspaceId = WORKSPACE_ID) {
  return {
    userId: USER_ID,
    workspaceId,
    organizationId: ORG_ID,
    source: "session",
    context: {
      user: { id: USER_ID },
      currentOrganization: { id: ORG_ID },
      currentWorkspace: { id: workspaceId },
      workspaces: [{ id: workspaceId }],
    },
  };
}

function baseContext(workspaceId = WORKSPACE_ID) {
  return { params: Promise.resolve({ workspaceId }) };
}

function itemContext(
  owner = "agentrelay",
  repo = "cloud",
  workspaceId = WORKSPACE_ID,
) {
  return { params: Promise.resolve({ workspaceId, owner, repo }) };
}

function jsonRequest(body?: unknown, method = "POST"): Request {
  return new Request("https://cloud.test/api", {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function getRequest(): Request {
  return new Request("https://cloud.test/api");
}

async function loadBaseRoute(): Promise<BaseRouteModule> {
  return import(
    new URL(
      "../packages/web/app/api/v1/workspaces/[workspaceId]/integrations/github/allowed-repos/route.ts",
      import.meta.url,
    ).href
  ) as Promise<BaseRouteModule>;
}

async function loadItemRoute(): Promise<ItemRouteModule> {
  return import(
    new URL(
      "../packages/web/app/api/v1/workspaces/[workspaceId]/integrations/github/allowed-repos/[owner]/[repo]/route.ts",
      import.meta.url,
    ).href
  ) as Promise<ItemRouteModule>;
}

async function setupDb(options: { githubIntegration?: boolean } = {}) {
  const testDb = await createRelayfileWritebackPgliteDb();
  cleanupDb = testDb.cleanup;
  testDb.installAsAppDb();
  await testDb.insertWorkspace({ id: WORKSPACE_ID });
  await testDb.insertWorkspace({ id: OTHER_WORKSPACE_ID, slug: "other-workspace" });

  if (options.githubIntegration ?? true) {
    await testDb.insertWorkspaceIntegration({
      workspaceId: WORKSPACE_ID,
      provider: "github",
      connectionId: "conn_github",
      providerConfigKey: "github-app",
      installationId: "install_1",
    });
  }

  return testDb;
}

beforeEach(() => {
  resolveRequestAuthMock.mockResolvedValue(sessionAuth());
  loggerInfoMock.mockReset();
});

afterEach(async () => {
  if (cleanupDb) {
    await cleanupDb();
    cleanupDb = undefined;
  }

  vi.clearAllMocks();
  vi.resetModules();
});

describe("GitHub workflow repository allowlist routes", () => {
  it("returns 401 for unauthenticated list requests", async () => {
    resolveRequestAuthMock.mockResolvedValueOnce(null);
    const { GET } = await loadBaseRoute();

    const response = await GET(getRequest(), baseContext());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("returns 403 when the authenticated user cannot access the workspace", async () => {
    await setupDb();
    resolveRequestAuthMock.mockResolvedValueOnce(sessionAuth(OTHER_WORKSPACE_ID));
    const { GET } = await loadBaseRoute();

    const response = await GET(getRequest(), baseContext(WORKSPACE_ID));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden" });
  });

  it("returns 400 for malformed workspace ids", async () => {
    const { GET } = await loadBaseRoute();

    const response = await GET(getRequest(), baseContext("not-a-uuid"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid workspaceId" });
  });

  it("returns 400 for malformed repo coordinates", async () => {
    await setupDb();
    const { POST } = await loadBaseRoute();

    const response = await POST(
      jsonRequest({ repoOwner: "agentrelay/bad", repoName: "cloud" }),
      baseContext(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "repoOwner and repoName are required and must be valid GitHub path segments",
    });
  });

  it("rejects URL-encoded slash in POST body repo coordinates after decoding", async () => {
    await setupDb();
    const { POST } = await loadBaseRoute();

    // `agentrelay%2Fevil` decodes to `agentrelay/evil` and must be rejected
    // BEFORE the slash check (otherwise an attacker can sneak `/` past the
    // GitHub path-segment check by smuggling it as `%2F`).
    const response = await POST(
      jsonRequest({ repoOwner: "agentrelay%2Fevil", repoName: "cloud" }),
      baseContext(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "repoOwner and repoName are required and must be valid GitHub path segments",
    });
  });

  it("returns 409 when GitHub is not connected for the workspace", async () => {
    await setupDb({ githubIntegration: false });
    const { POST } = await loadBaseRoute();

    const response = await POST(
      jsonRequest({ repoOwner: "agentrelay", repoName: "cloud" }),
      baseContext(),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Connect the GitHub integration at /integrations/github before adding repos to the allowlist.",
    });
  });

  it("upserts a repo and captures the current GitHub installation id", async () => {
    const testDb = await setupDb();
    const { GET, POST } = await loadBaseRoute();

    const createResponse = await POST(
      jsonRequest({ repoOwner: "agentrelay", repoName: "cloud" }),
      baseContext(),
    );

    expect(createResponse.status).toBe(201);
    await expect(createResponse.json()).resolves.toMatchObject({
      workspaceId: WORKSPACE_ID,
      repoOwner: "agentrelay",
      repoName: "cloud",
      installationId: "install_1",
      pushAllowed: false,
      allowedBy: USER_ID,
    });

    await testDb.insertWorkspaceIntegration({
      workspaceId: WORKSPACE_ID,
      provider: "github",
      connectionId: "conn_github",
      providerConfigKey: "github-app",
      installationId: "install_2",
    });

    const upgradeResponse = await POST(
      jsonRequest({ repoOwner: "agentrelay", repoName: "cloud", pushAllowed: true }),
      baseContext(),
    );

    expect(upgradeResponse.status).toBe(201);
    await expect(upgradeResponse.json()).resolves.toMatchObject({
      repoOwner: "agentrelay",
      repoName: "cloud",
      installationId: "install_2",
      pushAllowed: true,
      allowedBy: USER_ID,
    });

    const listResponse = await GET(getRequest(), baseContext());
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject({
      rows: [
        {
          repoOwner: "agentrelay",
          repoName: "cloud",
          installationId: "install_2",
          pushAllowed: true,
        },
      ],
    });
  });

  it("gets, patches, and deletes a single allowlisted repo", async () => {
    const testDb = await setupDb();
    await testDb.insertAllowedRepo({
      workspaceId: WORKSPACE_ID,
      repoOwner: "agentrelay",
      repoName: "cloud",
      installationId: "install_1",
      pushAllowed: true,
      allowedBy: USER_ID,
    });
    const { DELETE, GET, PATCH } = await loadItemRoute();

    const getResponse = await GET(getRequest(), itemContext());
    expect(getResponse.status).toBe(200);
    await expect(getResponse.json()).resolves.toMatchObject({
      repoOwner: "agentrelay",
      repoName: "cloud",
      pushAllowed: true,
    });

    const patchResponse = await PATCH(
      jsonRequest({ pushAllowed: false }, "PATCH"),
      itemContext(),
    );
    expect(patchResponse.status).toBe(200);
    await expect(patchResponse.json()).resolves.toMatchObject({
      repoOwner: "agentrelay",
      repoName: "cloud",
      pushAllowed: false,
    });

    const deleteResponse = await DELETE(getRequest(), itemContext());
    expect(deleteResponse.status).toBe(204);

    const missingResponse = await GET(getRequest(), itemContext());
    expect(missingResponse.status).toBe(404);
    await expect(missingResponse.json()).resolves.toEqual({
      error: "Repository is not allowlisted",
    });

    expect(loggerInfoMock).toHaveBeenCalledWith(
      "Workflow repository allowlist updated",
      expect.objectContaining({
        area: "workflow-repo-allowlist",
        workspaceId: WORKSPACE_ID,
        owner: "agentrelay",
        repo: "cloud",
        userId: USER_ID,
      }),
    );
  });

  it("returns 404 when patching or deleting a repo that is not allowlisted", async () => {
    await setupDb();
    const { DELETE, PATCH } = await loadItemRoute();

    const patchResponse = await PATCH(
      jsonRequest({ pushAllowed: true }, "PATCH"),
      itemContext("agentrelay", "missing"),
    );
    expect(patchResponse.status).toBe(404);

    const deleteResponse = await DELETE(
      getRequest(),
      itemContext("agentrelay", "missing"),
    );
    expect(deleteResponse.status).toBe(404);
  });

  it("returns 400 for malformed owner or repo path params", async () => {
    await setupDb();
    const { GET } = await loadItemRoute();

    const response = await GET(
      getRequest(),
      itemContext("agentrelay%2Fbad", "cloud"),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "repoOwner and repoName must be valid GitHub path segments",
    });
  });
});
}
