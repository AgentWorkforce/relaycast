import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCloudAgentActivateRouteHandlers } from "./route";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const SIBLING_ID = "22222222-2222-4222-8222-222222222222";

type Row = { id: string; modelProvider: string; isActive: boolean };

const state: {
  rows: Row[];
  updates: Array<{ set: Record<string, unknown> }>;
} = { rows: [], updates: [] };

function selectChain() {
  let limited = false;
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(() => {
      limited = true;
      return Promise.resolve(state.rows.slice(0, 1));
    }),
    then: (
      resolve: (rows: Row[]) => unknown,
      reject?: (error: unknown) => unknown,
    ) =>
      Promise.resolve(limited ? state.rows.slice(0, 1) : state.rows).then(
        resolve,
        reject,
      ),
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
    select: vi.fn(() => selectChain()),
    update: vi.fn(() => updateChain()),
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({ update: vi.fn(() => updateChain()) }),
    ),
  };
  return db;
}

function makeDeps(overrides?: { auth?: unknown; db?: unknown }) {
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
  };
}

function makeRequest(): NextRequest {
  return new NextRequest(
    `https://cloud.test/api/v1/cloud-agents/${AGENT_ID}/activate`,
    {
      method: "POST",
    },
  );
}

const routeContext = { params: Promise.resolve({ agentId: AGENT_ID }) };

describe("POST /api/v1/cloud-agents/[agentId]/activate", () => {
  beforeEach(() => {
    state.rows = [];
    state.updates = [];
  });

  it("rejects unauthenticated requests", async () => {
    const deps = makeDeps({ auth: null });
    const { POST } = createCloudAgentActivateRouteHandlers(deps as never);
    const response = await POST(makeRequest(), routeContext);
    expect(response.status).toBe(401);
  });

  it("returns 404 when the credential does not belong to the caller", async () => {
    const deps = makeDeps();
    const { POST } = createCloudAgentActivateRouteHandlers(deps as never);
    const response = await POST(makeRequest(), routeContext);
    expect(response.status).toBe(404);
  });

  it("activates the target and deactivates provider siblings", async () => {
    state.rows = [
      { id: AGENT_ID, modelProvider: "openai", isActive: false },
      { id: SIBLING_ID, modelProvider: "openai", isActive: true },
    ];
    const deps = makeDeps();
    const { POST } = createCloudAgentActivateRouteHandlers(deps as never);
    const response = await POST(makeRequest(), routeContext);
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { activatedId: string };
    expect(payload.activatedId).toBe(AGENT_ID);
    // First update deactivates siblings, second activates the target.
    expect(state.updates.map((update) => update.set.isActive)).toEqual([
      false,
      true,
    ]);
  });

  it("is a no-op when the credential is already active", async () => {
    state.rows = [{ id: AGENT_ID, modelProvider: "openai", isActive: true }];
    const deps = makeDeps();
    const { POST } = createCloudAgentActivateRouteHandlers(deps as never);
    const response = await POST(makeRequest(), routeContext);
    expect(response.status).toBe(200);
    expect(state.updates).toEqual([]);
  });

  it("returns 409 when a concurrent activation wins the active credential index race", async () => {
    state.rows = [
      { id: AGENT_ID, modelProvider: "openai", isActive: false },
      { id: SIBLING_ID, modelProvider: "openai", isActive: true },
    ];
    const conflict = Object.assign(
      new Error(
        "duplicate key value violates unique constraint provider_credentials_one_active_per_provider",
      ),
      {
        code: "23505",
        constraint: "provider_credentials_one_active_per_provider",
      },
    );
    const db = {
      select: vi.fn(() => selectChain()),
      transaction: vi.fn(async () => {
        throw conflict;
      }),
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const deps = makeDeps({ db });
    const { POST } = createCloudAgentActivateRouteHandlers(deps as never);

    const response = await POST(makeRequest(), routeContext);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error:
        "Another credential activation completed first. Refresh and try again.",
      code: "active_credential_conflict",
    });
    expect(warn).toHaveBeenCalledWith(
      "Cloud agent activation conflict:",
      expect.objectContaining({
        agentId: AGENT_ID,
        constraint: "provider_credentials_one_active_per_provider",
      }),
    );
    warn.mockRestore();
  });

  it("keeps unrelated activation failures on the generic 500 path", async () => {
    state.rows = [
      { id: AGENT_ID, modelProvider: "openai", isActive: false },
      { id: SIBLING_ID, modelProvider: "openai", isActive: true },
    ];
    const db = {
      select: vi.fn(() => selectChain()),
      transaction: vi.fn(async () => {
        throw Object.assign(new Error("duplicate key value"), {
          code: "23505",
          constraint: "some_other_constraint",
        });
      }),
    };
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const deps = makeDeps({ db });
    const { POST } = createCloudAgentActivateRouteHandlers(deps as never);

    const response = await POST(makeRequest(), routeContext);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Failed to activate cloud agent",
    });
    error.mockRestore();
  });
});
