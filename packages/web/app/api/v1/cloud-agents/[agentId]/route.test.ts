import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cloud/core/auth/credential-store.js", () => ({
  CredentialStore: class {
    delete() {
      return Promise.resolve();
    }
  },
}));

vi.mock("@/lib/storage", () => ({
  createCredentialStoreS3Client: vi.fn(async () => ({ kind: "s3-client" })),
}));

vi.mock("@/lib/env", () => ({
  optionalEnv: vi.fn(() => "test-value"),
  tryResourceValue: vi.fn(() => "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"),
}));

vi.mock("sst", () => ({
  Resource: { WorkflowStorage: { bucketName: "workflow-storage-test" } },
}));

vi.mock("@/lib/auth/request-auth", () => ({
  requireAuthScope: vi.fn(),
  requireSessionAuth: vi.fn(),
  resolveRequestAuth: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

vi.mock("@/lib/db/schema", () => ({
  providerCredentials: {
    id: "id",
    displayName: "displayName",
    harness: "harness",
    defaultModel: "defaultModel",
    status: "status",
    credentialStoredAt: "credentialStoredAt",
    lastAuthenticatedAt: "lastAuthenticatedAt",
    lastUsedAt: "lastUsedAt",
    lastError: "lastError",
    createdAt: "createdAt",
    updatedAt: "updatedAt",
    authType: "authType",
    modelProvider: "modelProvider",
    isActive: "isActive",
    userId: "userId",
    workspaceId: "workspaceId",
  },
}));

import {
  createCloudAgentDetailRouteHandlers,
  planCredentialStoreDelete,
} from "./route";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const SIBLING_ID = "22222222-2222-4222-8222-222222222222";

type Row = {
  id: string;
  displayName: string;
  harness: string;
  modelProvider: string;
  defaultModel: string | null;
  status: string;
  credentialStoredAt: Date;
  lastAuthenticatedAt: Date | null;
  lastUsedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  authType: string;
  isActive: boolean;
};

const now = new Date("2026-06-01T12:00:00.000Z");

const targetRow: Row = {
  id: AGENT_ID,
  displayName: "Claude OAuth",
  harness: "claude",
  modelProvider: "anthropic",
  defaultModel: "claude-sonnet-4-5",
  status: "connected",
  credentialStoredAt: now,
  lastAuthenticatedAt: now,
  lastUsedAt: null,
  lastError: null,
  createdAt: now,
  updatedAt: now,
  authType: "provider_oauth",
  isActive: true,
};

const state: {
  rows: Row[];
  selectResults: Array<Array<{ id: string }>>;
  remainingProviderNameKeyedRows: Array<{
    authType: string;
    id: string;
    modelProvider: string;
  }>;
  updates: Array<{ set: Record<string, unknown> }>;
} = { rows: [], selectResults: [], remainingProviderNameKeyedRows: [], updates: [] };

function deleteChain() {
  const chain = {
    where: vi.fn(() => chain),
    returning: vi.fn(async () => {
      const index = state.rows.findIndex((row) => row.id === AGENT_ID);
      if (index === -1) {
        return [];
      }
      const [removed] = state.rows.splice(index, 1);
      return [removed];
    }),
  };
  return chain;
}

function selectChain() {
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    limit: vi.fn(async () => state.selectResults.shift() ?? []),
    then: (
      resolve: (value: typeof state.remainingProviderNameKeyedRows) => unknown,
      reject: (reason: unknown) => unknown,
    ) => Promise.resolve(state.remainingProviderNameKeyedRows).then(resolve, reject),
  };
  return chain;
}

function updateChain() {
  const update = {
    set: vi.fn((values: Record<string, unknown>) => {
      state.updates.push({ set: values });
      return update;
    }),
    where: vi.fn(async () => undefined),
  };
  return update;
}

function dbStub() {
  const db = {
    delete: vi.fn(() => deleteChain()),
    select: vi.fn(() => selectChain()),
    update: vi.fn(() => updateChain()),
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      const rowsSnapshot = state.rows.map((row) => ({ ...row }));
      const updatesSnapshot = state.updates.map((update) => ({
        set: { ...update.set },
      }));
      try {
        return await callback(db);
      } catch (error) {
        state.rows = rowsSnapshot;
        state.updates = updatesSnapshot;
        throw error;
      }
    }),
  };
  return db;
}

function makeDeps(overrides?: { auth?: unknown; db?: unknown; storeDelete?: ReturnType<typeof vi.fn> }) {
  const storeDelete = overrides?.storeDelete ?? vi.fn(async () => undefined);
  return {
    resolveRequestAuth: vi.fn(async () =>
      overrides && "auth" in overrides
        ? (overrides.auth as never)
        : ({
            userId: "00000000-0000-4000-8000-000000000001",
            workspaceId: "00000000-0000-4000-8000-000000000002",
          } as never),
    ),
    requireSessionAuth: vi.fn(() => true),
    requireAuthScope: vi.fn(() => false),
    getDb: vi.fn(() => (overrides?.db ?? dbStub()) as never),
    createCredentialStoreForUser: vi.fn(async () => ({ delete: storeDelete })),
  };
}

function makeRequest(): NextRequest {
  return new NextRequest(`https://cloud.test/api/v1/cloud-agents/${AGENT_ID}`, {
    method: "DELETE",
  });
}

const routeContext = { params: Promise.resolve({ agentId: AGENT_ID }) };

describe("DELETE /api/v1/cloud-agents/[agentId]", () => {
  beforeEach(() => {
    state.rows = [];
    state.selectResults = [];
    state.remainingProviderNameKeyedRows = [];
    state.updates = [];
  });

  it("rejects unauthenticated requests", async () => {
    const deps = makeDeps({ auth: null });
    const { DELETE } = createCloudAgentDetailRouteHandlers(deps as never);

    const response = await DELETE(makeRequest(), routeContext);

    expect(response.status).toBe(401);
  });

  it("returns 404 when the credential does not belong to the caller", async () => {
    const deps = makeDeps();
    const { DELETE } = createCloudAgentDetailRouteHandlers(deps as never);

    const response = await DELETE(makeRequest(), routeContext);

    expect(response.status).toBe(404);
    expect(state.updates).toEqual([]);
  });

  it("promotes a same-provider sibling when deleting the active credential", async () => {
    state.rows = [
      targetRow,
      {
        ...targetRow,
        id: SIBLING_ID,
        displayName: "Claude BYOK",
        isActive: false,
      },
    ];
    state.selectResults = [[], [{ id: SIBLING_ID }]];
    const deps = makeDeps();
    const { DELETE } = createCloudAgentDetailRouteHandlers(deps as never);

    const response = await DELETE(makeRequest(), routeContext);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: AGENT_ID,
      modelProvider: "anthropic",
      isActive: true,
    });
    expect(state.updates.map((update) => update.set.isActive)).toEqual([true]);
  });

  it("deletes row-scoped BYOK credential blobs after deleting the row", async () => {
    const storeDelete = vi.fn(async () => undefined);
    state.rows = [{ ...targetRow, authType: "byo_api_key" }];
    state.selectResults = [[], []];
    const deps = makeDeps({ storeDelete });
    const { DELETE } = createCloudAgentDetailRouteHandlers(deps as never);

    const response = await DELETE(makeRequest(), routeContext);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: AGENT_ID,
      credentialStoreDelete: {
        attempted: true,
        key: AGENT_ID,
        mode: "byok-row",
        success: true,
      },
    });
    expect(state.rows).toEqual([]);
    expect(storeDelete).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000001",
      AGENT_ID,
    );
  });

  it("preserves a provider-name credential blob while another workspace row still references it", async () => {
    const storeDelete = vi.fn(async () => undefined);
    state.rows = [{ ...targetRow, authType: "provider_oauth" }];
    state.selectResults = [[], []];
    state.remainingProviderNameKeyedRows = [
      {
        id: "33333333-3333-4333-8333-333333333333",
        authType: "provider_oauth",
        modelProvider: "anthropic",
      },
    ];
    const deps = makeDeps({ storeDelete });
    const { DELETE } = createCloudAgentDetailRouteHandlers(deps as never);

    const response = await DELETE(makeRequest(), routeContext);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.id).toBe(AGENT_ID);
    expect(body.credentialStoreDelete).toBeUndefined();
    expect(storeDelete).not.toHaveBeenCalled();
  });

  it("sweeps the final provider OAuth blob after deleting its row", async () => {
    const rowsVisibleDuringStoreDelete: string[][] = [];
    const storeDelete = vi.fn(async () => {
      rowsVisibleDuringStoreDelete.push(state.rows.map((row) => row.id));
    });
    state.rows = [{ ...targetRow, authType: "provider_oauth" }];
    state.selectResults = [[], []];
    const deps = makeDeps({ storeDelete });
    const { DELETE } = createCloudAgentDetailRouteHandlers(deps as never);

    const response = await DELETE(makeRequest(), routeContext);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: AGENT_ID,
      credentialStoreDelete: {
        attempted: true,
        key: "anthropic",
        mode: "provider-name",
        success: true,
      },
    });
    expect(rowsVisibleDuringStoreDelete).toEqual([[]]);
    expect(storeDelete).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000001",
      "anthropic",
    );
  });

  it("deletes the provider-name credential blob when the deleted row was the last keyed reference", async () => {
    const storeDelete = vi.fn(async () => undefined);
    state.rows = [{ ...targetRow, authType: "oauth_token" }];
    state.selectResults = [[], []];
    const deps = makeDeps({ storeDelete });
    const { DELETE } = createCloudAgentDetailRouteHandlers(deps as never);

    const response = await DELETE(makeRequest(), routeContext);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: AGENT_ID,
      credentialStoreDelete: {
        attempted: true,
        key: "anthropic",
        mode: "provider-name",
        success: true,
      },
    });
    expect(state.rows).toEqual([]);
    expect(storeDelete).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000001",
      "anthropic",
    );
  });

  it("rolls back the row delete when final provider-name blob deletion fails", async () => {
    const storeDelete = vi.fn(async () => {
      throw new Error("s3 delete failed");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    state.rows = [{ ...targetRow, authType: "oauth_token" }];
    state.selectResults = [[], []];
    const deps = makeDeps({ storeDelete });
    const { DELETE } = createCloudAgentDetailRouteHandlers(deps as never);

    const response = await DELETE(makeRequest(), routeContext);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "Failed to delete credential store blob",
      code: "credential_store_delete_failed",
      credentialStoreDelete: {
        attempted: true,
        key: "anthropic",
        mode: "provider-name",
        success: false,
        error: "s3 delete failed",
      },
    });
    expect(state.rows.map((row) => row.id)).toEqual([AGENT_ID]);
    expect(storeDelete).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000001",
      "anthropic",
    );
    expect(warn).toHaveBeenCalledWith(
      "[cloud-agents] Failed to delete final provider-name credential store blob before deleting row",
      expect.objectContaining({
        agentId: AGENT_ID,
        key: "anthropic",
        mode: "provider-name",
      }),
    );
    warn.mockRestore();
  });

  it("keeps the deleted row response when best-effort blob deletion fails", async () => {
    const storeDelete = vi.fn(async () => {
      throw new Error("s3 delete failed");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    state.rows = [{ ...targetRow, authType: "byo_api_key" }];
    state.selectResults = [[], []];
    const deps = makeDeps({ storeDelete });
    const { DELETE } = createCloudAgentDetailRouteHandlers(deps as never);

    const response = await DELETE(makeRequest(), routeContext);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: AGENT_ID,
      credentialStoreDelete: {
        attempted: true,
        key: AGENT_ID,
        mode: "byok-row",
        success: false,
        error: "s3 delete failed",
      },
    });
    expect(warn).toHaveBeenCalledWith(
      "[cloud-agents] Deleted credential row but failed to delete credential store blob",
      expect.objectContaining({
        agentId: AGENT_ID,
        key: AGENT_ID,
        mode: "byok-row",
      }),
    );
    warn.mockRestore();
  });

  it("does not promote another credential when a sibling is already active", async () => {
    state.rows = [
      { ...targetRow, isActive: false },
      {
        ...targetRow,
        id: SIBLING_ID,
        displayName: "Claude BYOK",
        isActive: true,
      },
    ];
    state.selectResults = [[{ id: SIBLING_ID }]];
    const deps = makeDeps();
    const { DELETE } = createCloudAgentDetailRouteHandlers(deps as never);

    const response = await DELETE(makeRequest(), routeContext);

    expect(response.status).toBe(200);
    expect(state.updates).toEqual([]);
  });

  it("returns 409 when a concurrent activation wins the promotion race", async () => {
    state.rows = [
      targetRow,
      {
        ...targetRow,
        id: SIBLING_ID,
        displayName: "Claude BYOK",
        isActive: false,
      },
    ];
    state.selectResults = [[], [{ id: SIBLING_ID }]];
    const conflict = Object.assign(
      new Error(
        "duplicate key value violates unique constraint provider_credentials_one_active_per_provider",
      ),
      {
        code: "23505",
        constraint: "provider_credentials_one_active_per_provider",
      },
    );
    const db = dbStub();
    db.update = vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(async () => {
          throw conflict;
        }),
      })),
    })) as never;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const deps = makeDeps({ db });
    const { DELETE } = createCloudAgentDetailRouteHandlers(deps as never);

    const response = await DELETE(makeRequest(), routeContext);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error:
        "Another credential activation completed first. Refresh and try again.",
      code: "active_credential_conflict",
    });
    expect(warn).toHaveBeenCalledWith(
      "Cloud agent delete promotion conflict:",
      expect.objectContaining({
        agentId: AGENT_ID,
        constraint: "provider_credentials_one_active_per_provider",
      }),
    );
    warn.mockRestore();
  });
});

describe("planCredentialStoreDelete", () => {
  it("skips relay-managed credentials because they have no credential-store blob", () => {
    expect(
      planCredentialStoreDelete({
        deleted: {
          id: AGENT_ID,
          authType: "relay_managed",
          modelProvider: "anthropic",
        },
        remainingProviderNameKeyedRows: [],
      }),
    ).toEqual({ reason: "relay-managed-has-no-blob" });
  });
});
