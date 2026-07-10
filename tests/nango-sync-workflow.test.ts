// Tests for processNangoSyncPage and NangoSyncWorkflow
// NB: cloudflare:workers is mocked before any imports from the workflow module.

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

const sstMock = vi.hoisted(() => ({
  resources: {} as Record<string, unknown>,
}));

// ---------------------------------------------------------------------------
// Mock cloudflare:workers so the workflow module can be imported in Node.
// ---------------------------------------------------------------------------

vi.mock("cloudflare:workers", () => {
  class WorkflowEntrypoint<_Env = unknown, _T = unknown> {
    protected env: _Env = {} as _Env;
    // biome-ignore lint: test mock
    constructor(_ctx: unknown, env: _Env) {
      this.env = env;
    }
  }
  return { WorkflowEntrypoint };
});

// Mock sst Resource so the workflow file can import it.
vi.mock("sst", () => ({
  Resource: new Proxy(
    sstMock.resources,
    {
      get(target, prop) {
        if (typeof prop !== "string") return undefined;
        if (prop in target) return target[prop];
        throw new Error(`"${prop}" is not linked in your sst.config.ts`);
      },
    },
  ),
}));

vi.mock("sst/resource", () => ({
  fromCloudflareEnv(input: Record<string, unknown>) {
    for (const [key, rawValue] of Object.entries(input)) {
      let value = rawValue;
      if (typeof value === "string") {
        try {
          value = JSON.parse(value);
        } catch {
          // Native plain-text bindings are valid too.
        }
      }
      sstMock.resources[key] = value;
      if (key.startsWith("SST_RESOURCE_")) {
        sstMock.resources[key.replace("SST_RESOURCE_", "")] = value;
      }
    }
  },
}));

// Mock heavy infra deps — we test the orchestration logic, not the clients.
vi.mock("@nangohq/node", () => ({
  Nango: class {
    listRecords() {
      return Promise.resolve({ records: [], next_cursor: null });
    }
  },
}));

vi.mock("@relayfile/sdk", () => ({
  RelayFileClient: class {
    // no-op
  },
}));

vi.mock("../packages/core/src/relayfile/client.js", () => ({
  mintRelayfileToken: () => Promise.resolve("mock-token"),
}));

vi.mock("../packages/core/src/provider-readiness-worker.js", () => ({
  markProviderInitialSyncRunning: vi.fn().mockResolvedValue(undefined),
  markProviderInitialSyncComplete: vi.fn().mockResolvedValue(undefined),
  markProviderInitialSyncFailed: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../packages/core/src/sync/record-writer.js", () => ({
  writeBatchToRelayfile: vi
    .fn()
    .mockResolvedValue({ written: 0, deleted: 0, errors: 0 }),
  WRITE_CONCURRENCY: 5,
}));

// ---------------------------------------------------------------------------
// After mocks: import the modules under test
// ---------------------------------------------------------------------------

const {
  buildNangoListRecordsRequest,
  NANGO_SYNC_DEFAULT_PAGE_SIZE,
  processNangoSyncPage,
} = await import(
  "../packages/core/src/sync/nango-sync-runtime.js"
);
const { NangoSyncWorkflow, buildNeonSyncDeltaEventHooks } = await import(
  "../packages/core/src/sync/nango-sync-workflow.js"
);
const { markProviderInitialSyncRunning, markProviderInitialSyncComplete, markProviderInitialSyncFailed } = await import(
  "../packages/core/src/provider-readiness-worker.js"
);
const { parseNangoSyncJob } = await import(
  "../packages/core/src/sync/nango-sync-job.js"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import type { NangoSyncJob } from "../packages/core/src/sync/nango-sync-job.js";
import type { NangoSyncPageDeps } from "../packages/core/src/sync/nango-sync-runtime.js";
import { providerModelKey } from "../packages/core/src/sync/provider-write-planner.js";

function makeNativeCloudflareResourceEnv(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    SST_RESOURCE_App: JSON.stringify({ name: "cloud", stage: "test" }),
    NeonDatabaseUrl: JSON.stringify({
      value: "postgres://user:pw@ep-neon-pooler.test/db?sslmode=require",
    }),
    NangoSecretKey: JSON.stringify({ value: "sk-resource" }),
    RelayfileInternalHmacSecret: JSON.stringify({ value: "relayfile-hmac-resource" }),
    WebRelayauthApiKey: JSON.stringify({ value: "relayauth-resource" }),
    ...overrides,
  };
}

function makeJob(overrides: Partial<NangoSyncJob> = {}): NangoSyncJob {
  return {
    type: "nango_sync",
    provider: "confluence",
    providerConfigKey: "confluence-relay",
    connectionId: "conn_1",
    syncName: "fetch-spaces",
    model: "ConfluenceSpace",
    modifiedAfter: "2026-05-19T00:00:00.000Z",
    cursor: null,
    workspaceId: "rw_test",
    ...overrides,
  };
}

function makePageDeps(
  overrides: Partial<NangoSyncPageDeps> = {},
): NangoSyncPageDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    nango: {
      async listRecords(config) {
        calls.push(`list:${config.cursor ?? "first"}`);
        return {
          records: [{ id: config.cursor ?? "first" }],
          next_cursor: config.cursor ? null : "next",
        };
      },
    },
    relayfile: {
      async writeBatch(records) {
        calls.push(`write:${records.length}`);
        return { written: records.length, deleted: 0, errors: 0 };
      },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// processNangoSyncPage unit tests
// ---------------------------------------------------------------------------

describe("processNangoSyncPage", () => {
  it.each([
    {
      name: "INITIAL syncType",
      job: makeJob({
        syncType: "INITIAL",
        modifiedAfter: "2026-05-19T00:00:00.000Z",
      }),
    },
    {
      name: "checkpoint range with null from",
      job: makeJob({
        checkpoints: {
          from: null,
          to: { lastRunAt: "2026-05-19T00:00:00.000Z" },
        },
        modifiedAfter: "2026-05-19T00:00:00.000Z",
      }),
    },
  ])("does not pass modifiedAfter for first-page $name backfills", ({ job }) => {
    expect(
      buildNangoListRecordsRequest(
        job,
        { cursor: null },
        NANGO_SYNC_DEFAULT_PAGE_SIZE,
      ),
    ).toEqual({
      providerConfigKey: job.providerConfigKey,
      connectionId: job.connectionId,
      model: job.model,
      limit: NANGO_SYNC_DEFAULT_PAGE_SIZE,
    });
  });

  it("passes modifiedAfter for first-page incremental delta syncs", () => {
    const job = makeJob({
      syncType: "INCREMENTAL",
      checkpoints: {
        from: { lastRunAt: "2026-05-18T00:00:00.000Z" },
        to: { lastRunAt: "2026-05-19T00:00:00.000Z" },
      },
      modifiedAfter: "2026-05-18T00:00:00.000Z",
    });

    expect(
      buildNangoListRecordsRequest(job, { cursor: null }, 50),
    ).toEqual({
      providerConfigKey: "confluence-relay",
      connectionId: "conn_1",
      model: "ConfluenceSpace",
      modifiedAfter: "2026-05-18T00:00:00.000Z",
      limit: 50,
    });
  });

  it("keeps the timestamp lower bound on incremental continuation pages", () => {
    const job = makeJob({
      syncType: "INCREMENTAL",
      modifiedAfter: "2026-05-18T00:00:00.000Z",
    });

    expect(
      buildNangoListRecordsRequest(job, { cursor: "cursor-page-2" }, 50),
    ).toEqual({
      providerConfigKey: "confluence-relay",
      connectionId: "conn_1",
      model: "ConfluenceSpace",
      modifiedAfter: "2026-05-18T00:00:00.000Z",
      cursor: "cursor-page-2",
      limit: 50,
    });
  });

  it("fetches one page and returns nextCursor + counts", async () => {
    const job = makeJob();
    const deps = makePageDeps({
      enabledProviderModels: new Set([providerModelKey(job)]),
    });

    const result = await processNangoSyncPage(
      job,
      { cursor: null, recordOffset: 0 },
      deps,
    );

    expect(result.nextCursor).toBe("next");
    expect(result.written).toBe(1);
    expect(result.deleted).toBe(0);
    expect(result.errors).toEqual([]);
    expect(deps.calls).toEqual(["list:first", "write:1"]);
  });

  it("processes deleted tombstone records through the shared write path", async () => {
    const job = makeJob();
    const deps = makePageDeps({
      enabledProviderModels: new Set([providerModelKey(job)]),
      nango: {
        async listRecords() {
          return {
            records: [{ id: "page-1", _deleted: true }],
            next_cursor: null,
          };
        },
      },
      relayfile: {
        async writeBatch(records) {
          expect(records).toEqual([{ id: "page-1", _deleted: true }]);
          return { written: 0, deleted: 1, errors: 0 };
        },
      },
    });

    const result = await processNangoSyncPage(
      job,
      { cursor: null, recordOffset: 0 },
      deps,
    );

    expect(result).toEqual({
      nextCursor: null,
      written: 0,
      deleted: 1,
      errors: [],
    });
  });

  it("treats empty sync pages as clean no-ops", async () => {
    const job = makeJob();
    const deps = makePageDeps({
      enabledProviderModels: new Set([providerModelKey(job)]),
      nango: {
        async listRecords() {
          return { records: [], next_cursor: null };
        },
      },
      relayfile: {
        async writeBatch(records) {
          expect(records).toEqual([]);
          return { written: 0, deleted: 0, errors: 0 };
        },
      },
    });

    const result = await processNangoSyncPage(
      job,
      { cursor: null, recordOffset: 0 },
      deps,
    );

    expect(result).toEqual({
      nextCursor: null,
      written: 0,
      deleted: 0,
      errors: [],
    });
  });

  it("advances cursor for subsequent pages", async () => {
    const job = makeJob();
    const deps = makePageDeps({
      enabledProviderModels: new Set([providerModelKey(job)]),
    });

    // Page 1: cursor=null → next_cursor="next"
    const r1 = await processNangoSyncPage(
      job,
      { cursor: null, recordOffset: 0 },
      deps,
    );
    expect(r1.nextCursor).toBe("next");

    // Page 2: cursor="next" → next_cursor=null (end)
    const r2 = await processNangoSyncPage(
      job,
      { cursor: "next", recordOffset: 0 },
      deps,
    );
    expect(r2.nextCursor).toBeNull();
    expect(deps.calls).toEqual(["list:first", "write:1", "list:next", "write:1"]);
  });

  it("returns non-empty errors string when writeBatch reports partial failures", async () => {
    const job = makeJob();
    const deps = makePageDeps({
      enabledProviderModels: new Set([providerModelKey(job)]),
      relayfile: {
        async writeBatch() {
          return { written: 0, deleted: 0, errors: 3 };
        },
      },
    });

    const result = await processNangoSyncPage(
      job,
      { cursor: null, recordOffset: 0 },
      deps,
    );

    expect(result.errors).toEqual(["batch_partial_errors:3"]);
  });

  it("rejects when provider is not parity-enabled", async () => {
    const job = makeJob({
      provider: "unsupported",
      providerConfigKey: "unsupported-relay",
      syncName: "unknown",
      model: "Unknown",
    });
    const deps = makePageDeps(); // no enabledProviderModels override

    await expect(
      processNangoSyncPage(job, { cursor: null, recordOffset: 0 }, deps),
    ).rejects.toThrow(/parity is not enabled/);
  });

  it("enriches Neon transitions before write and dispatches provider events after write", async () => {
    const job = makeJob({
      provider: "neon",
      providerConfigKey: "neon-relay",
      connectionId: "conn-neon",
      syncName: "neon-sync",
      model: "NeonEndpoint",
      workspaceId: "app-workspace",
      relayWorkspaceId: "relay-workspace",
      syncType: "INCREMENTAL",
      modifiedAfter: "2026-06-18T08:00:00.000Z",
    });
    const record = {
      id: "ep-1",
      current_state: "active",
      _nango_metadata: {
        last_action: "updated",
        last_modified_at: "2026-06-18T09:00:00.000Z",
        cursor: "cursor-1",
      },
    };
    const calls: string[] = [];
    const gatewayRequests: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
    const deps: NangoSyncPageDeps = {
      nango: {
        async listRecords() {
          calls.push("list");
          return { records: [record], next_cursor: null };
        },
      },
      relayfile: {
        async readFile(workspaceId, path) {
          calls.push(`read:${workspaceId}:${path}`);
          return {
            content: JSON.stringify({ id: "ep-1", current_state: "idle" }),
          };
        },
        async writeBatch(records) {
          calls.push("write");
          expect(records).toEqual([record]);
          return { written: 1, deleted: 0, errors: 0 };
        },
      },
      syncDeltaEvents: buildNeonSyncDeltaEventHooks({
        RELAYFILE_INTERNAL_HMAC_SECRET: "test-hmac-secret",
        AGENT_GATEWAY: {
          async fetch(request) {
            calls.push("dispatch");
            const req = request instanceof Request ? request : new Request(request);
            gatewayRequests.push({
              headers: req.headers,
              body: await req.json() as Record<string, unknown>,
            });
            return Response.json({ ok: true });
          },
        },
      } as never),
      enabledProviderModels: new Set([providerModelKey(job)]),
    };

    const result = await processNangoSyncPage(
      job,
      { cursor: null, recordOffset: 0 },
      deps,
    );

    expect(result.errors).toEqual([]);
    expect(calls).toEqual([
      "list",
      "read:relay-workspace:/neon/endpoints/ep-1.json",
      "write",
      "dispatch",
    ]);
    expect(gatewayRequests).toHaveLength(1);
    expect(gatewayRequests[0]?.headers.get("x-relay-signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(gatewayRequests[0]?.body).toMatchObject({
      workspaceId: "app-workspace",
      path: "/neon/endpoints/ep-1.json",
      provider: "neon",
      eventType: "endpoint.state_changed",
      connectionId: "conn-neon",
      occurredAt: "2026-06-18T09:00:00.000Z",
    });
    expect(gatewayRequests[0]?.body.writeId).toBe(
      "neon:conn-neon:endpoint.state_changed:ep-1:2026-06-18T09:00:00.000Z:cursor-1",
    );
    expect(gatewayRequests[0]?.body.payload).toMatchObject({
      provider: "neon",
      eventType: "endpoint.state_changed",
      objectType: "endpoint",
      id: "ep-1",
      objectId: "ep-1",
      current_state: "active",
      payload: {
        id: "ep-1",
        current_state: "active",
      },
      metadata: {
        action: "UPDATED",
        lastModifiedAt: "2026-06-18T09:00:00.000Z",
        cursor: "cursor-1",
      },
    });
  });
});

// ---------------------------------------------------------------------------
// NangoSyncWorkflow replay tests
// ---------------------------------------------------------------------------

type StepRecord = { name: string; type: "do" };

function makeWorkflowStep(
  pageResults: Array<{
    nextCursor: string | null;
    nextRecordOffset?: number;
    written: number;
    deleted: number;
    errors: string[];
  }>,
): {
  step: {
    do<T>(name: string, ...args: unknown[]): Promise<T>;
  };
  stepLog: StepRecord[];
} {
  const stepLog: StepRecord[] = [];
  let pageCallIndex = 0;

  const step = {
    async do<T>(name: string, ...args: unknown[]): Promise<T> {
      stepLog.push({ name, type: "do" });

      // Find the callback (last argument that is a function)
      const cb = [...args].reverse().find((a) => typeof a === "function") as
        | (() => Promise<T>)
        | undefined;

      if (name.startsWith("page-")) {
        // Return pre-canned page result instead of executing the real callback
        const result = pageResults[pageCallIndex++] ?? {
          nextCursor: null,
          written: 0,
          deleted: 0,
          errors: [],
        };
        return result as unknown as T;
      }

      // For mark-* and continue steps: execute the real callback
      if (cb) return cb();
      return null as unknown as T;
    },
  };

  return { step, stepLog };
}

function makeWorkflowInstance(
  env: Record<string, unknown>,
  pageResults: Array<{
    nextCursor: string | null;
    nextRecordOffset?: number;
    written: number;
    deleted: number;
    errors: string[];
  }>,
) {
  const instance = new NangoSyncWorkflow(
    {} as unknown,
    makeNativeCloudflareResourceEnv(env) as never,
  );
  const { step, stepLog } = makeWorkflowStep(pageResults);
  return { instance, step, stepLog };
}

function makeEvent(job: NangoSyncJob): { payload: NangoSyncJob; timestamp: Date; instanceId: string } {
  return { payload: job, timestamp: new Date(), instanceId: "test-instance" };
}

beforeAll(() => {
  vi.mocked(markProviderInitialSyncRunning).mockResolvedValue(undefined);
  vi.mocked(markProviderInitialSyncComplete).mockResolvedValue(undefined);
  vi.mocked(markProviderInitialSyncFailed).mockResolvedValue(undefined);
});

beforeEach(() => {
  for (const key of Object.keys(sstMock.resources)) {
    delete sstMock.resources[key];
  }
  vi.clearAllMocks();
  vi.mocked(markProviderInitialSyncRunning).mockResolvedValue(undefined);
  vi.mocked(markProviderInitialSyncComplete).mockResolvedValue(undefined);
  vi.mocked(markProviderInitialSyncFailed).mockResolvedValue(undefined);
});

describe("parseNangoSyncJob", () => {
  it("preserves Nango sync window metadata across workflow payload parsing", () => {
    const job = makeJob({
      syncType: "INCREMENTAL",
      checkpoints: {
        from: { lastRunAt: "2026-05-18T00:00:00.000Z" },
        to: { lastRunAt: "2026-05-19T00:00:00.000Z" },
      },
      responseResults: { added: 1, updated: 2, deleted: 3 },
    });

    expect(parseNangoSyncJob(job)).toEqual(job);
  });
});

describe("NangoSyncWorkflow", () => {
  it("hydrates SST Resource from native Cloudflare bindings before readiness", async () => {
    const job = makeJob();
    const env = makeNativeCloudflareResourceEnv({
      NeonDatabaseUrl: JSON.stringify({
        value: "postgres://resource-user:pw@ep-neon-pooler.test/db?sslmode=require",
      }),
      NANGO_SECRET_KEY: "sk-env-fallback",
      WEB_RELAYAUTH_API_KEY: "key-env-fallback",
    });
    const instance = new NangoSyncWorkflow({} as unknown, env as never);
    const { step } = makeWorkflowStep([
      { nextCursor: null, written: 1, deleted: 0, errors: [] },
    ]);
    const { Resource } = await import("sst");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    vi.mocked(markProviderInitialSyncRunning).mockImplementationOnce(async () => {
      expect((Resource as { NeonDatabaseUrl?: { value?: string } }).NeonDatabaseUrl?.value)
        .toBe("postgres://resource-user:pw@ep-neon-pooler.test/db?sslmode=require");
    });

    await instance.run(makeEvent(job), step as never);

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("\"event\":\"workflow-resource-hydration\""),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("\"hasNeonDatabaseUrl\":true"),
    );
    logSpy.mockRestore();
  });

  it("fails before mark-running when an SST-linked Workflow is missing required resources", async () => {
    const job = makeJob();
    const env = makeNativeCloudflareResourceEnv({
      NeonDatabaseUrl: JSON.stringify({ value: "" }),
    });
    const instance = new NangoSyncWorkflow({} as unknown, env as never);
    const { step } = makeWorkflowStep([
      { nextCursor: null, written: 1, deleted: 0, errors: [] },
    ]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(instance.run(makeEvent(job), step as never))
      .rejects
      .toThrow("NangoSyncWorkflow Resource hydration failed: missing NeonDatabaseUrl");

    expect(markProviderInitialSyncRunning).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("emits mark-running before any page steps", async () => {
    const job = makeJob();
    const env = { NANGO_SECRET_KEY: "sk-test", WEB_RELAYAUTH_API_KEY: "key-test" };
    const { instance, step, stepLog } = makeWorkflowInstance(env, [
      { nextCursor: null, written: 1, deleted: 0, errors: [] },
    ]);

    await instance.run(makeEvent(job), step as never);

    expect(stepLog[0]?.name).toBe("mark-running");
  });

  it("marks failed and rethrows when mark-running fails", async () => {
    const job = makeJob();
    const cause = new Error("WebSocket connection timed out");
    cause.name = "TimeoutError";
    const failure = new Error("Failed query", { cause });
    (failure as Error & { code?: string }).code = "QUERY_FAILED";
    vi.mocked(markProviderInitialSyncRunning).mockRejectedValueOnce(failure);
    const { instance, step } = makeWorkflowInstance(
      { NANGO_SECRET_KEY: "sk", WEB_RELAYAUTH_API_KEY: "key" },
      [{ nextCursor: null, written: 1, deleted: 0, errors: [] }],
    );

    await expect(instance.run(makeEvent(job), step as never))
      .rejects
      .toThrow("Failed query");

    expect(markProviderInitialSyncFailed).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Failed query" }),
    );
  });

  it("emits one page step per page, then mark-complete", async () => {
    const job = makeJob();
    const env = { NANGO_SECRET_KEY: "sk", WEB_RELAYAUTH_API_KEY: "key" };
    const { instance, step, stepLog } = makeWorkflowInstance(env, [
      { nextCursor: "c1", written: 1, deleted: 0, errors: [] },
      { nextCursor: null, written: 1, deleted: 0, errors: [] },
    ]);

    await instance.run(makeEvent(job), step as never);

    const names = stepLog.map((s) => s.name);
    expect(names).toEqual(["mark-running", "page-0", "page-1", "mark-complete"]);
  });

  it("keeps processing the same Nango page while a mid-page record offset remains", async () => {
    const job = makeJob();
    const env = { NANGO_SECRET_KEY: "sk", WEB_RELAYAUTH_API_KEY: "key" };
    const { instance, step, stepLog } = makeWorkflowInstance(env, [
      {
        nextCursor: null,
        nextRecordOffset: 20,
        written: 20,
        deleted: 0,
        errors: [],
      },
      { nextCursor: null, written: 5, deleted: 0, errors: [] },
    ]);

    await instance.run(makeEvent(job), step as never);

    const names = stepLog.map((s) => s.name);
    expect(names).toEqual(["mark-running", "page-0", "page-1", "mark-complete"]);
  });

  it("marks failed and rethrows when mark-complete fails", async () => {
    const job = makeJob();
    vi.mocked(markProviderInitialSyncComplete)
      .mockRejectedValueOnce(new Error("complete query failed"));
    const { instance, step } = makeWorkflowInstance(
      { NANGO_SECRET_KEY: "sk", WEB_RELAYAUTH_API_KEY: "key" },
      [{ nextCursor: null, written: 1, deleted: 0, errors: [] }],
    );

    await expect(instance.run(makeEvent(job), step as never))
      .rejects
      .toThrow("complete query failed");

    expect(markProviderInitialSyncFailed).toHaveBeenCalledWith(
      expect.objectContaining({ error: "complete query failed" }),
    );
  });

  it("uses deterministic page step names (page-0, page-1, …)", async () => {
    const job = makeJob();
    const env = { NANGO_SECRET_KEY: "sk", WEB_RELAYAUTH_API_KEY: "key" };
    const pages = Array.from({ length: 5 }, (_, i) => ({
      nextCursor: i < 4 ? `c${i + 1}` : null,
      written: 1,
      deleted: 0,
      errors: [],
    }));
    const { instance, step, stepLog } = makeWorkflowInstance(env, pages);

    await instance.run(makeEvent(job), step as never);

    const pageSteps = stepLog.filter((s) => s.name.startsWith("page-"));
    expect(pageSteps.map((s) => s.name)).toEqual([
      "page-0", "page-1", "page-2", "page-3", "page-4",
    ]);
  });

  it("emits a continue step and returns when pageIndex reaches MAX threshold (≥900)", async () => {
    const job = makeJob();
    const env = {
      NANGO_SECRET_KEY: "sk",
      WEB_RELAYAUTH_API_KEY: "key",
      NANGO_SYNC_WORKFLOW: {
        create: vi.fn().mockResolvedValue({}),
      },
    };

    // 901 pages: first 900 return a cursor, the last triggers continue
    const pages = Array.from({ length: 901 }, (_, i) => ({
      nextCursor: i < 900 ? `c${i + 1}` : null,
      written: 1,
      deleted: 0,
      errors: [],
    }));
    const { instance, step, stepLog } = makeWorkflowInstance(env, pages);

    await instance.run(makeEvent(job), step as never);

    const names = stepLog.map((s) => s.name);
    expect(names).toContain("continue");
    expect(names).not.toContain("mark-complete");
    // 900 page steps (page-0..page-899) then "continue"
    const pageSteps = names.filter((n) => n.startsWith("page-"));
    expect(pageSteps).toHaveLength(900);
    expect(names.at(-1)).toBe("continue");
    // Continuation must carry a DETERMINISTIC id (parent instanceId + page
    // boundary) so a step replay cannot spawn a duplicate child for the same
    // cursor. makeEvent() uses instanceId "test-instance".
    expect(env.NANGO_SYNC_WORKFLOW.create).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "test-instance-c900",
        params: expect.objectContaining({ cursor: "c900" }),
      }),
    );
  });

  it("carries a mid-page record offset into workflow continuation children", async () => {
    const job = makeJob();
    const env = {
      NANGO_SECRET_KEY: "sk",
      WEB_RELAYAUTH_API_KEY: "key",
      NANGO_SYNC_WORKFLOW: {
        create: vi.fn().mockResolvedValue({}),
      },
    };
    const pages = Array.from({ length: 900 }, (_, index) => ({
      nextCursor: null,
      nextRecordOffset: (index + 1) * 20,
      written: 20,
      deleted: 0,
      errors: [],
    }));
    const { instance, step } = makeWorkflowInstance(env, pages);

    await instance.run(makeEvent(job), step as never);

    expect(env.NANGO_SYNC_WORKFLOW.create).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "test-instance-c900",
        params: expect.objectContaining({
          cursor: null,
          recordOffset: 18_000,
        }),
      }),
    );
  });

  it("continuation is idempotent: a duplicate-id (already-exists) error is swallowed, not rethrown", async () => {
    const job = makeJob();
    const env = {
      NANGO_SECRET_KEY: "sk",
      WEB_RELAYAUTH_API_KEY: "key",
      NANGO_SYNC_WORKFLOW: {
        // Simulate the replay case: the child instance already exists.
        create: vi
          .fn()
          .mockRejectedValue(
            new Error("instance with id test-instance-c900 already exists"),
          ),
      },
    };
    const pages = Array.from({ length: 901 }, (_, i) => ({
      nextCursor: i < 900 ? `c${i + 1}` : null,
      written: 1,
      deleted: 0,
      errors: [],
    }));
    const { instance, step, stepLog } = makeWorkflowInstance(env, pages);

    // Must NOT throw — the already-exists error is the intended idempotent outcome.
    await expect(instance.run(makeEvent(job), step as never)).resolves.toBeUndefined();
    expect(env.NANGO_SYNC_WORKFLOW.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: "test-instance-c900" }),
    );
    // mark-failed must NOT fire — the continuation succeeded idempotently.
    expect(stepLog.map((s) => s.name)).not.toContain("mark-failed");
  });

  it("calls mark-failed and rethrows when a step throws", async () => {
    const job = makeJob();
    const env = { NANGO_SECRET_KEY: "sk", WEB_RELAYAUTH_API_KEY: "key" };

    const boom = new Error("page exploded");
    const step = {
      async do<T>(name: string, ...args: unknown[]): Promise<T> {
        if (name === "mark-running") {
          const cb = [...args].reverse().find((a) => typeof a === "function") as () => Promise<T>;
          return cb();
        }
        if (name === "page-0") throw boom;
        // mark-failed callback
        const cb = [...args].reverse().find((a) => typeof a === "function") as () => Promise<T>;
        return cb ? cb() : (null as unknown as T);
      },
    };

    await expect(
      instance_for_step(job, env, step as never),
    ).rejects.toThrow("page exploded");

    expect(markProviderInitialSyncFailed).toHaveBeenCalledWith(
      expect.objectContaining({ error: "page exploded" }),
    );
  });

  it("rethrows when mark-failed fails", async () => {
    const job = makeJob();
    const env = { NANGO_SECRET_KEY: "sk", WEB_RELAYAUTH_API_KEY: "key" };
    const pageError = new Error("page exploded");
    vi.mocked(markProviderInitialSyncFailed)
      .mockRejectedValueOnce(new Error("failed readiness update failed"));
    const step = {
      async do<T>(name: string, ...args: unknown[]): Promise<T> {
        if (name === "mark-running") {
          const cb = [...args].reverse().find((a) => typeof a === "function") as () => Promise<T>;
          return cb();
        }
        if (name === "page-0") throw pageError;
        const cb = [...args].reverse().find((a) => typeof a === "function") as () => Promise<T>;
        return cb();
      },
    };

    await expect(instance_for_step(job, env, step as never))
      .rejects
      .toThrow("failed readiness update failed");

    expect(markProviderInitialSyncFailed).toHaveBeenCalledWith(
      expect.objectContaining({ error: "page exploded" }),
    );
  });
});

// Helper to avoid repeating instance construction in error test
function instance_for_step(
  job: NangoSyncJob,
  env: Record<string, unknown>,
  step: never,
) {
  const inst = new NangoSyncWorkflow({} as unknown, env as never);
  return inst.run(makeEvent(job), step);
}
