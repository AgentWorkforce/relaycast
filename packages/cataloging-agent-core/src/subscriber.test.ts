import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CatalogingContext } from "./context.js";
import {
  registerCatalogingAgentConfig,
  type CatalogingWorkerEnv,
} from "./config.js";
import type { InsightGenerator } from "./insight.js";
import { CatalogingSubscriber } from "./subscriber.js";

const relayfileMock = vi.hoisted(() => {
  class RelayFileApiError extends Error {
    readonly status: number;
    readonly code: string;

    constructor(status: number, payload: { message?: string; code?: string } = {}) {
      super(payload.message ?? `RelayFile API error: ${status}`);
      this.name = "RelayFileApiError";
      this.status = status;
      this.code = payload.code ?? "unknown_error";
    }
  }

  const files = new Map<string, Record<string, unknown>>();
  const clients: Array<{ options: Record<string, unknown> }> = [];
  const writeCalls: Array<Record<string, unknown>> = [];
  const connectCalls: Array<{
    options: Record<string, unknown>;
    sync: Record<string, unknown>;
    handlers: Map<string, Function[]>;
  }> = [];

  class RelayFileClient {
    readonly options: Record<string, unknown>;

    constructor(options: Record<string, unknown>) {
      this.options = options;
      clients.push(this);
    }

    async readFile(workspaceId: string, path: string): Promise<Record<string, unknown>> {
      const file = files.get(fileKey(workspaceId, path));
      if (!file) {
        throw new RelayFileApiError(404, { message: "not found" });
      }
      return file;
    }

    async writeFile(input: Record<string, unknown>): Promise<Record<string, unknown>> {
      writeCalls.push(input);
      const revision = String(writeCalls.length);
      files.set(fileKey(String(input.workspaceId), String(input.path)), {
        path: input.path,
        revision,
        contentType: input.contentType,
        content: input.content,
        encoding: input.encoding,
        semantics: input.semantics,
      });
      return {
        opId: `op_${writeCalls.length}`,
        status: "queued",
        targetRevision: revision,
      };
    }
  }

  const connect = vi.fn((options: Record<string, unknown>) => {
    const handlers = new Map<string, Function[]>();
    const sync = {
      getState: vi.fn(() => "open"),
      on: vi.fn((event: string, handler: Function) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
        return () => undefined;
      }),
      stop: vi.fn(async () => undefined),
      emit: (event: string, ...args: unknown[]) => {
        for (const handler of handlers.get(event) ?? []) {
          handler(...args);
        }
      },
    };
    connectCalls.push({ options, sync, handlers });
    return sync;
  });

  return {
    RelayFileApiError,
    RelayFileClient,
    RelayFileSync: { connect },
    clients,
    connectCalls,
    files,
    writeCalls,
    reset: () => {
      files.clear();
      clients.length = 0;
      writeCalls.length = 0;
      connectCalls.length = 0;
      connect.mockClear();
    },
  };

  function fileKey(workspaceId: string, path: string): string {
    return `${workspaceId}:${path}`;
  }
});

vi.mock("@relayfile/sdk", () => ({
  DEFAULT_RELAYFILE_BASE_URL: "https://api.relayfile.dev",
  RelayFileApiError: relayfileMock.RelayFileApiError,
  RelayFileClient: relayfileMock.RelayFileClient,
  RelayFileSync: relayfileMock.RelayFileSync,
}));

const BASE_TIME = new Date("2026-04-21T12:00:00.000Z");
const SUBSCRIPTION_BODY = {
  workspaceId: "workspace_123",
  domain: "linear",
  relayfileUrl: "https://relayfile.test",
};

describe("CatalogingSubscriber", () => {
  beforeEach(() => {
    relayfileMock.reset();
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("persists subscription config and opens a RelayFileSync connection on POST /subscribe", async () => {
    const harness = createHarness();

    const response = await harness.subscriber.fetch(postJson("/subscribe", SUBSCRIPTION_BODY));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      config: {
        workspaceId: "workspace_123",
        domain: "linear",
        relayfileUrl: "https://relayfile.test",
        updatedAt: BASE_TIME.toISOString(),
      },
    });
    expect(harness.kv.get("config")).toMatchObject({
      workspaceId: "workspace_123",
      domain: "linear",
      relayfileUrl: "https://relayfile.test",
      updatedAt: BASE_TIME.toISOString(),
    });
    expect(relayfileMock.RelayFileSync.connect).toHaveBeenCalledTimes(1);
    expect(relayfileMock.connectCalls[0].options).toMatchObject({
      workspaceId: "workspace_123",
      baseUrl: "https://relayfile.test",
      token: "relayfile-token",
    });
    expect(relayfileMock.clients[0].options).toMatchObject({
      baseUrl: "https://relayfile.test",
      token: "relayfile-token",
      userAgent: "cataloging-agent-core/linear",
    });
  });

  it("enqueues matching file.updated events and schedules the debounce alarm", async () => {
    const harness = await createSubscribedHarness();

    await deliverFileUpdated(harness, "/linear/issues/ISS-1.json");

    expect(harness.kv.get("pending")).toEqual({
      "open-issues": BASE_TIME.getTime() + 500,
    });
    expect(harness.storage.setAlarm).toHaveBeenLastCalledWith(BASE_TIME.getTime() + 500);
  });

  it("leaves the pending set unchanged for non-matching file.updated events", async () => {
    const harness = await createSubscribedHarness();

    await deliverFileUpdated(harness, "/github/pulls/1.json");

    expect(harness.kv.get("pending")).toBeUndefined();
  });

  it("runs pending insights on alarm and clears the pending set", async () => {
    const harness = await createSubscribedHarness();
    await deliverFileUpdated(harness, "/linear/issues/ISS-1.json");

    vi.setSystemTime(new Date(BASE_TIME.getTime() + 500));
    await harness.subscriber.alarm();

    expect(harness.generate).toHaveBeenCalledTimes(1);
    expect(relayfileMock.writeCalls).toHaveLength(1);
    expect(relayfileMock.writeCalls[0]).toMatchObject({
      workspaceId: "workspace_123",
      path: "/insights/open-issues.json",
    });
    expect(harness.kv.has("pending")).toBe(false);
  });

  it("debounces rapid events for the same insight into one generate call", async () => {
    const harness = await createSubscribedHarness();
    await deliverFileUpdated(harness, "/linear/issues/ISS-1.json");

    vi.setSystemTime(new Date(BASE_TIME.getTime() + 100));
    await deliverFileUpdated(harness, "/linear/issues/ISS-2.json");

    vi.setSystemTime(new Date(BASE_TIME.getTime() + 600));
    await harness.subscriber.alarm();

    expect(harness.generate).toHaveBeenCalledTimes(1);
    expect(relayfileMock.writeCalls).toHaveLength(1);
  });

  it("returns connection and event counters from GET /status", async () => {
    const harness = await createSubscribedHarness();
    await deliverFileUpdated(harness, "/linear/issues/ISS-1.json");

    const response = await harness.subscriber.fetch(new Request("https://subscriber.test/status"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      connectedSince: BASE_TIME.toISOString(),
      eventsReceivedCount: 1,
      lastEventAt: BASE_TIME.toISOString(),
      nextAlarmAt: BASE_TIME.getTime() + 500,
    });
  });

  it("POST /run/:insightId bypasses RelayFileSync and forces regeneration", async () => {
    const harness = createHarness();

    const response = await harness.subscriber.fetch(postJson("/run/open-issues", SUBSCRIPTION_BODY));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      result: {
        status: "written",
        insightId: "open-issues",
        path: "/insights/open-issues.json",
      },
    });
    expect(relayfileMock.RelayFileSync.connect).not.toHaveBeenCalled();
    expect(harness.generate).toHaveBeenCalledTimes(1);
    expect(relayfileMock.writeCalls).toHaveLength(1);
  });

  it("emits the convention fragment exactly once per cold-start when configured", async () => {
    const conventions = vi.fn(() => ({
      provider: "linear",
      version: "0.1.9",
      generatedAt: "2026-04-21T12:00:00.000Z",
      paths: [
        {
          pattern: "/linear/issues/{id}.json",
          description: "Issue metadata",
          objectType: "issue",
        },
      ],
    }));
    const harness = createHarness({ conventions });

    const response = await harness.subscriber.fetch(postJson("/subscribe", SUBSCRIPTION_BODY));
    expect(response.status).toBe(200);
    await harness.flushWaitUntil();

    const conventionWrites = relayfileMock.writeCalls.filter(
      (call) => call.path === "/_conventions/linear.json",
    );
    expect(conventionWrites).toHaveLength(1);
    expect(conventions).toHaveBeenCalledTimes(1);

    // Re-subscribing within the same DO instance must not re-emit (in-memory
    // flag short-circuits) — and even if it did, the RelayFile-side hash
    // compare would skip the duplicate write.
    relayfileMock.writeCalls.length = 0;
    const second = await harness.subscriber.fetch(postJson("/subscribe", SUBSCRIPTION_BODY));
    expect(second.status).toBe(200);
    await harness.flushWaitUntil();

    const reEmitted = relayfileMock.writeCalls.filter(
      (call) => call.path === "/_conventions/linear.json",
    );
    expect(reEmitted).toHaveLength(0);
  });

  it("emits the convention fragment even when an early return fires for an existing hibernated socket", async () => {
    const conventions = vi.fn(() => ({
      provider: "linear",
      version: "0.1.9",
      generatedAt: "2026-04-21T12:00:00.000Z",
      paths: [
        {
          pattern: "/linear/issues/{id}.json",
          description: "Issue metadata",
          objectType: "issue",
        },
      ],
    }));
    // Simulate a cold-start DO that wakes with an already-accepted
    // hibernated RelayFile sync socket and persisted config. The
    // constructor's #ready hook restores config from storage; the alarm
    // then runs #ensureSubscription which takes the
    // `socketCount > 0 && !state` early-return path — the convention
    // fragment must still be published.
    const fakeSocket = {} as WebSocket;
    const harness = createHarness({
      conventions,
      websockets: [fakeSocket],
      initialKv: {
        config: {
          workspaceId: "workspace_123",
          domain: "linear",
          relayfileUrl: "https://relayfile.test",
          updatedAt: BASE_TIME.toISOString(),
        },
        // Mark the socket as recently active so #hibernatedSocketIsStale
        // returns false and the stale-close branch does not fire — that
        // forces the early-return branch we want to exercise.
        lastSocketActivityAt: BASE_TIME.getTime(),
        // Make the alarm consider the reconnect window already due so
        // #ensureSubscription is invoked.
        reconnectAt: BASE_TIME.getTime() - 1,
      },
    });

    await harness.subscriber.alarm();
    await harness.flushWaitUntil();

    expect(relayfileMock.RelayFileSync.connect).not.toHaveBeenCalled();
    const conventionWrites = relayfileMock.writeCalls.filter(
      (call) => call.path === "/_conventions/linear.json",
    );
    expect(conventionWrites).toHaveLength(1);
    expect(conventions).toHaveBeenCalledTimes(1);
  });

  it("does not emit when conventions is not configured", async () => {
    const harness = createHarness();

    const response = await harness.subscriber.fetch(postJson("/subscribe", SUBSCRIPTION_BODY));
    expect(response.status).toBe(200);
    await harness.flushWaitUntil();

    const conventionWrites = relayfileMock.writeCalls.filter(
      (call) => typeof call.path === "string" && call.path.startsWith("/_conventions/"),
    );
    expect(conventionWrites).toHaveLength(0);
  });
});

async function createSubscribedHarness() {
  const harness = createHarness();
  const response = await harness.subscriber.fetch(postJson("/subscribe", SUBSCRIPTION_BODY));
  expect(response.status).toBe(200);
  return harness;
}

function createHarness(
  options: {
    conventions?: () => unknown;
    websockets?: WebSocket[];
    initialKv?: Record<string, unknown>;
  } = {},
) {
  const stateHarness = createMockState({
    websockets: options.websockets,
    initialKv: options.initialKv,
  });
  const generate = vi.fn(async (context: CatalogingContext<CatalogingWorkerEnv>) => ({
    generatedAt: context.now.toISOString(),
    workspaceId: context.workspaceId,
  }));
  registerCatalogingAgentConfig({
    domain: "linear",
    insights: [createInsight(generate)],
    tokenFactory: () => "relayfile-token",
    conventions: options.conventions as
      | (() => import("./conventions.js").VfsConventionFragment)
      | undefined,
  });

  return {
    ...stateHarness,
    generate,
    subscriber: new CatalogingSubscriber(stateHarness.state, {} as CatalogingWorkerEnv),
  };
}

function createInsight(
  generate: (context: CatalogingContext<CatalogingWorkerEnv>) => Promise<Record<string, unknown>>,
): InsightGenerator<CatalogingWorkerEnv> {
  return {
    id: "open-issues",
    outputPath: "/insights/open-issues.json",
    triggerPaths: ["/linear/issues"],
    intervalSeconds: 60,
    debounceMs: 500,
    generate,
  };
}

function createMockState(
  options: { websockets?: WebSocket[]; initialKv?: Record<string, unknown> } = {},
) {
  const kv = new Map<string, unknown>(Object.entries(options.initialKv ?? {}));
  const waitUntilPromises: Promise<unknown>[] = [];
  const websockets = options.websockets ?? [];
  let alarmAt: number | null = null;
  const storage = {
    get: vi.fn(async (key: string) => kv.get(key)),
    put: vi.fn(async (key: string, value: unknown) => {
      kv.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      kv.delete(key);
    }),
    setAlarm: vi.fn(async (timestamp: number) => {
      alarmAt = timestamp;
    }),
    getAlarm: vi.fn(async () => alarmAt),
    deleteAlarm: vi.fn(async () => {
      alarmAt = null;
    }),
  };
  const state = {
    id: {
      toString: () => "cataloging-subscriber-test-id",
      equals: () => false,
    },
    storage,
    blockConcurrencyWhile: vi.fn(async <T>(callback: () => Promise<T> | T) => await callback()),
    waitUntil: vi.fn((promise: Promise<unknown>) => {
      waitUntilPromises.push(Promise.resolve(promise));
    }),
    getWebSockets: vi.fn(() => websockets),
    acceptWebSocket: vi.fn(),
    setWebSocketAutoResponse: vi.fn(),
    setHibernatableWebSocketEventTimeout: vi.fn(),
  } as unknown as DurableObjectState;

  return {
    kv,
    storage,
    state,
    get alarmAt() {
      return alarmAt;
    },
    flushWaitUntil: async () => {
      while (waitUntilPromises.length > 0) {
        await Promise.all(waitUntilPromises.splice(0));
      }
    },
  };
}

async function deliverFileUpdated(
  harness: ReturnType<typeof createHarness>,
  path: string,
): Promise<void> {
  const connectCall = relayfileMock.connectCalls.at(-1);
  if (!connectCall) {
    throw new Error("RelayFileSync.connect was not called");
  }
  const onEvent = connectCall.options.onEvent;
  if (typeof onEvent !== "function") {
    throw new Error("RelayFileSync.connect did not receive an onEvent handler");
  }
  onEvent({
    eventId: `evt_${path}`,
    type: "file.updated",
    path,
    revision: "1",
  });
  await harness.flushWaitUntil();
}

function postJson(path: string, body: unknown): Request {
  return new Request(`https://subscriber.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
