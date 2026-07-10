import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Resource } from "sst";

type CatalogingWorkspaceRouteModule = {
  GET: (
    request: Request,
    context: { params: Promise<{ provider: string }> },
  ) => Promise<Response>;
};

type TestWorkspaceIntegrationSeed = {
  workspaceId: string;
  provider: string;
  connectionId: string;
  providerConfigKey?: string | null;
  installationId?: string | null;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
  updatedAt?: Date;
};

type TestDb = {
  installAsAppDb: () => void;
  insertWorkspaceIntegration: (
    input: TestWorkspaceIntegrationSeed,
  ) => Promise<void>;
  cleanup: () => Promise<void>;
};

const CATALOGING_TOKEN = "cataloging-cloud-api-token";
const SAGE_TOKEN = "sage-cloud-api-token";
const GITHUB_WORKSPACE_A = "11111111-1111-4111-8111-111111111111";
const LINEAR_WORKSPACE = "22222222-2222-4222-8222-222222222222";
const GITHUB_WORKSPACE_B = "33333333-3333-4333-8333-333333333333";

let cleanupDb: (() => Promise<void>) | undefined;

async function loadRoute(): Promise<CatalogingWorkspaceRouteModule> {
  return import(
    new URL(
      "../packages/web/app/api/internal/cataloging/workspaces/[provider]/route.ts",
      import.meta.url,
    ).href
  ) as Promise<CatalogingWorkspaceRouteModule>;
}

async function createTestDb(): Promise<TestDb> {
  const helper = await import(
    new URL("./helpers/relayfile-writeback-pglite-db.ts", import.meta.url).href
  ) as {
    createRelayfileWritebackPgliteDb: () => Promise<TestDb>;
  };
  return helper.createRelayfileWritebackPgliteDb();
}

function requestWithToken(token?: string): Request {
  const headers = new Headers();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return new Request("https://cloud.test/api/internal/cataloging/workspaces/github", {
    headers,
  });
}

function routeContext(provider: string): { params: Promise<{ provider: string }> } {
  return { params: Promise.resolve({ provider }) };
}

beforeEach(() => {
  const resources = Resource as unknown as Record<string, unknown>;
  resources.CatalogingCloudApiToken = { value: CATALOGING_TOKEN };
  resources.SageCloudApiToken = { value: SAGE_TOKEN };
});

afterEach(async () => {
  if (cleanupDb) {
    await cleanupDb();
    cleanupDb = undefined;
  }

  const resources = Resource as unknown as Record<string, unknown>;
  delete resources.CatalogingCloudApiToken;
  delete resources.SageCloudApiToken;
});

describe("cataloging workspace discovery route", () => {
  it("rejects requests without the dedicated cataloging token", async () => {
    const { GET } = await loadRoute();

    const response = await GET(requestWithToken(), routeContext("github"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("rejects the Sage service token", async () => {
    const { GET } = await loadRoute();

    const response = await GET(requestWithToken(SAGE_TOKEN), routeContext("github"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("rejects unsupported cataloging providers", async () => {
    const { GET } = await loadRoute();

    const response = await GET(
      requestWithToken(CATALOGING_TOKEN),
      routeContext("slack"),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Cataloging provider not found",
    });
  });

  it("returns stable GitHub workspace ids from workspace_integrations only", async () => {
    const db = await createTestDb();
    cleanupDb = db.cleanup;
    db.installAsAppDb();
    await db.insertWorkspaceIntegration({
      workspaceId: GITHUB_WORKSPACE_B,
      provider: "github",
      connectionId: "conn_github_b",
    });
    await db.insertWorkspaceIntegration({
      workspaceId: LINEAR_WORKSPACE,
      provider: "linear",
      connectionId: "conn_linear",
    });
    await db.insertWorkspaceIntegration({
      workspaceId: GITHUB_WORKSPACE_A,
      provider: "github",
      connectionId: "conn_github_a",
    });

    const { GET } = await loadRoute();
    const response = await GET(
      requestWithToken(CATALOGING_TOKEN),
      routeContext("github"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      provider: "github",
      workspaces: [GITHUB_WORKSPACE_A, GITHUB_WORKSPACE_B],
    });
  });

  it("returns Linear workspace ids separately from GitHub", async () => {
    const db = await createTestDb();
    cleanupDb = db.cleanup;
    db.installAsAppDb();
    await db.insertWorkspaceIntegration({
      workspaceId: GITHUB_WORKSPACE_A,
      provider: "github",
      connectionId: "conn_github",
    });
    await db.insertWorkspaceIntegration({
      workspaceId: LINEAR_WORKSPACE,
      provider: "linear",
      connectionId: "conn_linear",
    });

    const { GET } = await loadRoute();
    const response = await GET(
      requestWithToken(CATALOGING_TOKEN),
      routeContext("linear"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      provider: "linear",
      workspaces: [LINEAR_WORKSPACE],
    });
  });
});
