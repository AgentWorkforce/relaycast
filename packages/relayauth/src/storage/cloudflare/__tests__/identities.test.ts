import { describe, expect, it } from "vitest";
import type { StoredIdentity } from "../../../durable-objects/identity-do.js";
import { CloudflareIdentityStorage } from "../identities.js";

type RecordedDoRequest = {
  identityId: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: unknown;
};

type DurableObjectHandler = (request: RecordedDoRequest) => Response | Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

function createStoredIdentity(overrides: Partial<StoredIdentity> = {}): StoredIdentity {
  const id = overrides.id ?? "agent_identity_123";
  const sponsorId = overrides.sponsorId ?? "user_sponsor_123";
  const timestamp = overrides.createdAt ?? "2026-03-28T00:00:00.000Z";

  return {
    id,
    name: overrides.name ?? "Test Agent",
    type: overrides.type ?? "agent",
    orgId: overrides.orgId ?? "org_test",
    status: overrides.status ?? "active",
    scopes: overrides.scopes ?? ["cloud:projects:read"],
    roles: overrides.roles ?? ["role_member"],
    metadata: overrides.metadata ?? { team: "platform" },
    createdAt: timestamp,
    updatedAt: overrides.updatedAt ?? timestamp,
    sponsorId,
    sponsorChain: overrides.sponsorChain ?? [sponsorId, id],
    workspaceId: overrides.workspaceId ?? "ws_test",
    ...(overrides.lastActiveAt ? { lastActiveAt: overrides.lastActiveAt } : {}),
    ...(overrides.suspendedAt ? { suspendedAt: overrides.suspendedAt } : {}),
    ...(overrides.suspendReason ? { suspendReason: overrides.suspendReason } : {}),
    ...(overrides.budget !== undefined ? { budget: overrides.budget } : {}),
    ...(overrides.budgetUsage !== undefined ? { budgetUsage: overrides.budgetUsage } : {}),
  };
}

function createUnusedD1Database(): D1Database {
  const meta = {
    changed_db: false,
    changes: 0,
    duration: 0,
    rows_read: 0,
    rows_written: 0,
  };

  const prepared = {
    bind: (..._params: unknown[]) => ({
      first: async <T>() => null as T | null,
      run: async () => ({ success: true, meta }),
      raw: async <T>() => [] as T[],
      all: async <T>() => ({ results: [] as T[], success: true, meta }),
    }),
    first: async <T>() => null as T | null,
    run: async () => ({ success: true, meta }),
    raw: async <T>() => [] as T[],
    all: async <T>() => ({ results: [] as T[], success: true, meta }),
  };

  return {
    prepare: (_query: string) => prepared,
    batch: async <T>(statements: D1PreparedStatement[]) =>
      Promise.all(statements.map((statement) => statement.run())) as Awaited<T>,
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  } as D1Database;
}

function createIdentityStorage(handler: DurableObjectHandler): {
  requests: RecordedDoRequest[];
  storage: CloudflareIdentityStorage;
} {
  const requests: RecordedDoRequest[] = [];

  const namespace = {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: (id: DurableObjectId) => ({
      fetch: async (request: Request) => {
        const bodyText = await request.clone().text();
        const record: RecordedDoRequest = {
          identityId: String(id),
          method: request.method,
          path: new URL(request.url).pathname,
          headers: Object.fromEntries(request.headers.entries()),
          body: bodyText ? JSON.parse(bodyText) : undefined,
        };

        requests.push(record);
        return handler(record);
      },
    }),
  } as unknown as DurableObjectNamespace;

  return {
    requests,
    storage: new CloudflareIdentityStorage({
      DB: createUnusedD1Database(),
      IDENTITY_DO: namespace,
      INTERNAL_SECRET: "test-internal-secret",
    }),
  };
}

describe("CloudflareIdentityStorage", () => {
  it("create() sends POST /internal/create and returns the created identity", async () => {
    const identity = createStoredIdentity();
    const { storage, requests } = createIdentityStorage(async () => jsonResponse(identity, 201));

    const created = await storage.create(identity);

    expect(created).toEqual(identity);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      identityId: identity.id,
      method: "POST",
      path: "/internal/create",
      body: identity,
    });
    expect(requests[0]?.headers["content-type"]).toContain("application/json");
    expect(requests[0]?.headers["x-internal-secret"]).toBe("test-internal-secret");
  });

  it("get() sends GET /internal/get and returns the identity", async () => {
    const identity = createStoredIdentity();
    const { storage, requests } = createIdentityStorage(async () => jsonResponse(identity));

    const result = await storage.get(identity.id);

    expect(result).toEqual(identity);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      identityId: identity.id,
      method: "GET",
      path: "/internal/get",
      body: undefined,
    });
    expect(requests[0]?.headers["x-internal-secret"]).toBe("test-internal-secret");
    expect(requests[0]?.headers["content-type"]).toBeUndefined();
  });

  it("update() sends PATCH /internal/update with the patch body", async () => {
    const identity = createStoredIdentity();
    const patch = {
      name: "Updated Agent",
      metadata: {
        team: "security",
      },
    } satisfies Partial<StoredIdentity>;
    const updatedIdentity = {
      ...identity,
      ...patch,
      updatedAt: "2026-03-28T00:05:00.000Z",
    };
    const { storage, requests } = createIdentityStorage(async () => jsonResponse(updatedIdentity));

    const result = await storage.update(identity.id, patch);

    expect(result).toEqual(updatedIdentity);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      identityId: identity.id,
      method: "PATCH",
      path: "/internal/update",
      body: patch,
    });
    expect(requests[0]?.headers["content-type"]).toContain("application/json");
    expect(requests[0]?.headers["x-internal-secret"]).toBe("test-internal-secret");
  });

  it("suspend() sends POST /internal/suspend with the reason", async () => {
    const identity = createStoredIdentity();
    const suspendedIdentity = {
      ...identity,
      status: "suspended",
      suspendedAt: "2026-03-28T00:10:00.000Z",
      suspendReason: "policy_violation",
      updatedAt: "2026-03-28T00:10:00.000Z",
    } satisfies StoredIdentity;
    const { storage, requests } = createIdentityStorage(async () => jsonResponse(suspendedIdentity));

    const result = await storage.suspend(identity.id, "policy_violation");

    expect(result).toEqual(suspendedIdentity);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      identityId: identity.id,
      method: "POST",
      path: "/internal/suspend",
      body: { reason: "policy_violation" },
    });
    expect(requests[0]?.headers["content-type"]).toContain("application/json");
    expect(requests[0]?.headers["x-internal-secret"]).toBe("test-internal-secret");
  });

  it("retire() sends POST /internal/retire", async () => {
    const identity = createStoredIdentity();
    const retiredIdentity = {
      ...identity,
      status: "retired",
      updatedAt: "2026-03-28T00:15:00.000Z",
    } satisfies StoredIdentity;
    const { storage, requests } = createIdentityStorage(async () => jsonResponse(retiredIdentity));

    const result = await storage.retire(identity.id);

    expect(result).toEqual(retiredIdentity);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      identityId: identity.id,
      method: "POST",
      path: "/internal/retire",
      body: undefined,
    });
    expect(requests[0]?.headers["x-internal-secret"]).toBe("test-internal-secret");
    expect(requests[0]?.headers["content-type"]).toBeUndefined();
  });

  it("reactivate() sends POST /internal/reactivate", async () => {
    const identity = createStoredIdentity({
      status: "suspended",
      suspendedAt: "2026-03-28T00:10:00.000Z",
      suspendReason: "policy_violation",
    });
    const reactivatedIdentity = {
      ...identity,
      status: "active",
      suspendedAt: undefined,
      suspendReason: undefined,
      updatedAt: "2026-03-28T00:20:00.000Z",
    } satisfies StoredIdentity;
    const { storage, requests } = createIdentityStorage(async () => jsonResponse(reactivatedIdentity));

    const result = await storage.reactivate(identity.id);

    expect(result).toEqual(reactivatedIdentity);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      identityId: identity.id,
      method: "POST",
      path: "/internal/reactivate",
      body: undefined,
    });
    expect(requests[0]?.headers["x-internal-secret"]).toBe("test-internal-secret");
  });

  it("delete() sends DELETE /internal/delete", async () => {
    const identity = createStoredIdentity();
    const { storage, requests } = createIdentityStorage(async () => new Response(null, { status: 204 }));

    await storage.delete(identity.id);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      identityId: identity.id,
      method: "DELETE",
      path: "/internal/delete",
      body: undefined,
    });
    expect(requests[0]?.headers["x-internal-secret"]).toBe("test-internal-secret");
  });

  it("get() returns null for a non-existent identity", async () => {
    const { storage, requests } = createIdentityStorage(async () =>
      jsonResponse({ error: "identity_not_found" }, 404),
    );

    const result = await storage.get("agent_missing");

    expect(result).toBeNull();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      identityId: "agent_missing",
      method: "GET",
      path: "/internal/get",
    });
  });

  it("create() throws when sponsorId is missing", async () => {
    const identity = createStoredIdentity({
      sponsorId: "",
      sponsorChain: [],
    });
    const { storage, requests } = createIdentityStorage(async (request) => {
      const sponsorId = (request.body as { sponsorId?: unknown } | undefined)?.sponsorId;
      return typeof sponsorId === "string" && sponsorId.trim()
        ? jsonResponse(identity, 201)
        : jsonResponse({ error: "sponsorId is required" }, 400);
    });

    await expect(storage.create(identity)).rejects.toMatchObject({
      name: "StorageError",
      message: "sponsorId is required",
      status: 400,
      code: "identity_storage_error",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      identityId: identity.id,
      method: "POST",
      path: "/internal/create",
      body: expect.objectContaining({
        sponsorId: "",
      }),
    });
  });
});
