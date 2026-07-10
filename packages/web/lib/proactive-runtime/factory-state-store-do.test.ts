import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loggerWarn: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: mocks.loggerWarn,
    error: vi.fn(),
  },
}));

import {
  createFactoryStateStore,
  DurableObjectFactoryStateStore,
  FactoryStateStoreDO,
  type FactoryClarificationRecord,
  type FactoryInFlightRecord,
} from "@/lib/proactive-runtime/factory-state-store-do";

const cloudflareContextSymbol = Symbol.for("__cloudflare-context__");

/**
 * In-memory stand-in for the Durable Object `state.storage` API. Persists across
 * DO instances so a fresh `FactoryStateStoreDO` over the SAME storage proves the
 * round-trip survives an isolate swap (i.e. it is durable, not instance-memory).
 */
class FakeDurableStorage {
  readonly map = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.map.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.map.delete(key);
  }

  async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    for (const [key, value] of this.map) {
      if (!options?.prefix || key.startsWith(options.prefix)) {
        out.set(key, value as T);
      }
    }
    return out;
  }
}

function inFlight(overrides: Partial<FactoryInFlightRecord> = {}): FactoryInFlightRecord {
  return {
    workspaceId: "workspace-a",
    issueId: "issue-1",
    issueKey: "AR-267",
    issuePath: "/linear/issues/AR-267.json",
    recipe: "team",
    deliveryId: "delivery-a",
    spawns: [
      {
        name: "factory-ar-267-impl-cloud",
        capability: "spawn:claude",
        invocationId: "factory:workspace-a:AR-267:implementer:cloud",
        status: "dispatched",
        role: "implementer",
      },
    ],
    createdAt: "2026-06-16T12:00:00.000Z",
    updatedAt: "2026-06-16T12:00:00.000Z",
    ...overrides,
  };
}

describe("FactoryStateStoreDO round-trip", () => {
  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[cloudflareContextSymbol];
    vi.clearAllMocks();
  });

  function durableStore(storage: FakeDurableStorage): DurableObjectFactoryStateStore {
    // Each `get()` hands back a FRESH DO instance bound to the same storage,
    // simulating a worker isolate swap / redeploy between requests.
    const namespace = {
      idFromName: (name: string) => name,
      get: () => new FactoryStateStoreDO({ storage }),
    };
    return new DurableObjectFactoryStateStore(namespace);
  }

  it("persists an in-flight record across a fresh DO instance (put -> new stub -> get)", async () => {
    const storage = new FakeDurableStorage();
    const store = durableStore(storage);

    const record = inFlight();
    await store.putInFlight(record);

    // A brand-new DO instance (the namespace mints one per `get`) must still
    // see the record because it lives in durable storage, not isolate memory.
    await expect(store.getInFlight("workspace-a", "issue-1")).resolves.toEqual(record);
  });

  it("lists in-flight records by workspace prefix and isolates other workspaces", async () => {
    const storage = new FakeDurableStorage();
    const store = durableStore(storage);

    await store.putInFlight(inFlight({ workspaceId: "workspace-a", issueId: "issue-1" }));
    await store.putInFlight(inFlight({ workspaceId: "workspace-a", issueId: "issue-2" }));
    await store.putInFlight(inFlight({ workspaceId: "workspace-b", issueId: "issue-1" }));

    await expect(store.listInFlight("workspace-a")).resolves.toHaveLength(2);
    await expect(store.listInFlight("workspace-b")).resolves.toHaveLength(1);
  });

  it("deletes an in-flight record", async () => {
    const storage = new FakeDurableStorage();
    const store = durableStore(storage);

    await store.putInFlight(inFlight());
    await store.deleteInFlight("workspace-a", "issue-1");
    await expect(store.getInFlight("workspace-a", "issue-1")).resolves.toBeNull();
  });

  it("round-trips a waiting-clarification record and supports delete", async () => {
    const storage = new FakeDurableStorage();
    const store = durableStore(storage);

    const clarification: FactoryClarificationRecord = {
      workspaceId: "workspace-a",
      threadId: "thread-1",
      issueId: "issue-1",
      reason: "ambiguous recipe",
      createdAt: "2026-06-16T12:00:00.000Z",
      updatedAt: "2026-06-16T12:00:00.000Z",
    };
    await store.putWaitingClarification(clarification);
    await expect(
      store.getWaitingClarification("workspace-a", "thread-1"),
    ).resolves.toEqual(clarification);

    await store.deleteWaitingClarification("workspace-a", "thread-1");
    await expect(
      store.getWaitingClarification("workspace-a", "thread-1"),
    ).resolves.toBeNull();
  });

  it("returns 400 on an invalid JSON body", async () => {
    const storage = new FakeDurableStorage();
    const doInstance = new FactoryStateStoreDO({ storage });
    const response = await doInstance.fetch(
      new Request("https://factory-state-store.local/", { method: "POST", body: "not json" }),
    );
    expect(response.status).toBe(400);
  });
});

describe("createFactoryStateStore backend selection", () => {
  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[cloudflareContextSymbol];
    vi.clearAllMocks();
  });

  it("selects the Durable Object backend when FACTORY_STATE_STORE is bound", async () => {
    const storage = new FakeDurableStorage();
    (globalThis as Record<symbol, unknown>)[cloudflareContextSymbol] = {
      env: {
        FACTORY_STATE_STORE: {
          idFromName: (name: string) => name,
          get: () => new FactoryStateStoreDO({ storage }),
        },
      },
    };

    const store = createFactoryStateStore();
    expect(store).toBeInstanceOf(DurableObjectFactoryStateStore);
    await store.putInFlight(inFlight());
    await expect(store.getInFlight("workspace-a", "issue-1")).resolves.not.toBeNull();
    expect(mocks.loggerWarn).not.toHaveBeenCalled();
  });

  it("warns LOUDLY when a deployed worker has no FACTORY_STATE_STORE binding (degraded durability)", () => {
    // CF context present (deployed worker) but the DO binding is absent.
    (globalThis as Record<symbol, unknown>)[cloudflareContextSymbol] = { env: {} };

    const store = createFactoryStateStore();
    expect(store).not.toBeInstanceOf(DurableObjectFactoryStateStore);
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      "Factory StateStore degraded to per-isolate memory",
      expect.objectContaining({
        area: "factory-cloud-brain",
        diag: "state-store-memory-fallback",
      }),
    );
  });

  it("stays silent when there is no Cloudflare context (local/test)", () => {
    const store = createFactoryStateStore();
    expect(store).not.toBeInstanceOf(DurableObjectFactoryStateStore);
    expect(mocks.loggerWarn).not.toHaveBeenCalled();
  });
});
