import { describe, expect, it, vi } from "vitest";
import {
  dispatchWriteback,
  handleAckWriteback,
  handleDispatchWriteback,
  handleGetOperation,
  handleListOperationsGet,
  handleReplayOperation,
  recordMutation,
  recordMutations,
  type OpsHandlerContext,
} from "../src/durable-objects/handlers/ops.js";

// Regression for the writeback-queue contamination bug.
//
// Production failure mode (workspace rw_517d60b6, verified live during
// demo): the Nango sync worker mints a token with
// `agentName: "nango-sync-worker"` and calls the same `writeFile` SDK as
// user/agent writes. Without origin gating, every synced record (e.g.
// /notion/pages/<id>.json from `fetch-pages`) created a writeback op,
// dispatched it to WRITEBACK_QUEUE, and the queue consumer attempted to
// UPDATE the upstream record via the Notion adapter. The synced JSON
// shape ({id, title, url, parent_*, last_edited_time, content_preview})
// has no `properties` field, so the adapter threw permanently with
// `Writeback payload must include a properties object`. op_637 / op_636
// were both poisoned this way.
//
// Fix: when the caller is a sync worker (origin="provider_sync"),
// recordMutation must NOT create an op and must NOT dispatch to the
// queue. The file event still fires so subscribers see the change.
//
// We assert the gating directly here rather than at the SDK layer because
// the entire op + queue side-effect chain has to be skipped, and the
// recordMutation function is the single chokepoint where every fs.write
// path converges (handleWriteFile, bulkWrite, handleDeleteFileWithBody).

type RecordedQueueItem = {
  opId: string;
  workspaceId: string;
  path?: string;
  revision?: string;
  correlationId?: string;
};

function createOpsContext(
  options: {
    readJsonBody?: unknown;
    queueSend?: (item: RecordedQueueItem) => Promise<void>;
    setAlarm?: (when: number) => Promise<void>;
    upsertWorkspaceOperation?: (...args: unknown[]) => Promise<void>;
    coreGetOperationMiss?: boolean;
  } = {},
): {
  context: OpsHandlerContext;
  queueSend: ReturnType<typeof vi.fn>;
  upsertOp: ReturnType<typeof vi.fn>;
  appendedEvents: Array<{ origin: string; path: string; type: string }>;
  broadcastEvents: Array<{ origin: string; path: string; type: string }>;
  putOperationCalls: Array<Record<string, unknown>>;
  writeReceiptCalls: Array<Record<string, unknown>>;
  order: string[];
  nextOpIds: string[];
} {
  const queueSend = vi.fn(
    options.queueSend ?? (async (_item: RecordedQueueItem) => undefined),
  );
  const upsertOp = vi.fn(
    options.upsertWorkspaceOperation ??
      (async (..._args: unknown[]) => {
        order.push("upsertOp");
      }),
  );
  const appendedEvents: Array<{ origin: string; path: string; type: string }> =
    [];
  const broadcastEvents: Array<{ origin: string; path: string; type: string }> =
    [];
  const putOperationCalls: Array<Record<string, unknown>> = [];
  const writeReceiptCalls: Array<Record<string, unknown>> = [];
  const nextOpIds: string[] = [];
  const order: string[] = [];

  const adapter = {
    getFile: () => null,
    listFiles: () => [],
    putFile: () => undefined,
    deleteFile: () => undefined,
    loadFileContent: () => ({ content: "", encoding: "utf-8" as const }),
    appendEvent: (event: Record<string, unknown>) => {
      order.push("appendEvent");
      appendedEvents.push({
        origin: String(event.origin),
        path: String(event.path),
        type: String(event.type),
      });
    },
    listEvents: () => ({ items: [], nextCursor: null }),
    getRecentEvents: () => [],
    getOperation: (opId: string) =>
      [...putOperationCalls].reverse().find((op) => op.opId === opId) ?? null,
    putOperation: (op: Record<string, unknown>) => {
      order.push("putOperation");
      putOperationCalls.push(op);
      nextOpIds.push(String(op.opId));
    },
    listOperations: (
      options: { status?: string; cursor?: string; limit?: number } = {},
    ) => {
      const items = [...putOperationCalls]
        .filter(
          (op) =>
            !options.status ||
            (options.status === "running"
              ? op.status === "running" || op.status === "dispatched"
              : op.status === options.status),
        )
        .slice(0, options.limit ?? 100);
      return { items, nextCursor: null };
    },
    nextRevision: () => "rev_test",
    nextOperationId: () => `op_${putOperationCalls.length + 1}`,
    nextEventId: () => `evt_${appendedEvents.length + 1}`,
    enqueueWriteback: () => undefined,
    getPendingWritebacks: () => [],
    getWorkspaceId: () => "ws_517d60b6",
  };

  const context = {
    workspaceId: "ws_517d60b6",
    bindings: {
      WRITEBACK_QUEUE: {
        send: vi.fn(async (item: RecordedQueueItem) => {
          order.push("queueSend");
          await queueSend(item);
        }),
      },
    },
    state: {
      storage: {
        setAlarm: vi.fn(options.setAlarm ?? (async () => undefined)),
        deleteAlarm: vi.fn(async () => undefined),
      },
    },
    sql: {
      exec: vi.fn((query: string, opId?: unknown) => ({
        one: () => {
          if (!query.includes("FROM operations")) return null;
          if (!opId) {
            const op = [...putOperationCalls]
              .reverse()
              .find(
                (candidate) =>
                  candidate.status === "pending" && candidate.nextAttemptAt,
              );
            return op
              ? {
                  next_attempt_at: op.nextAttemptAt,
                }
              : null;
          }
          const op = [...putOperationCalls]
            .reverse()
            .find((candidate) => candidate.opId === opId);
          if (!op) return null;
          return {
            op_id: op.opId,
            path: op.path,
            revision: op.revision,
            action: op.action,
            provider: op.provider,
            status: op.status,
            attempt_count: op.attemptCount,
            next_attempt_at: op.nextAttemptAt,
            last_error: op.lastError,
            provider_result_json: null,
            correlation_id: op.correlationId,
            created_at: "2026-05-07T10:02:00.000Z",
            updated_at: "2026-05-07T10:02:00.000Z",
            completed_at: null,
          };
        },
        toArray: () => [],
      })),
    },
    getFileRow: () => null,
    loadContent: async () => "",
    readJson: async <T>(_request: Request) => (options.readJsonBody ?? {}) as T,
    resolveWorkspaceId: async () => "ws_517d60b6",
    requireWorkspaceId: async () => "ws_517d60b6",
    getWorkspaceId: async () => "ws_517d60b6",
    correlationId: () => "corr_test",
    json: (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), { status }),
    errorResponse: (
      _request: Request,
      status: number,
      code: string,
      message: string,
    ) =>
      new Response(JSON.stringify({ code, message }), {
        status,
      }),
    coreStorageAdapter: (
      _workspaceId: string,
      eventOptions?: { broadcast?: boolean },
    ) => ({
      ...adapter,
      getOperation: options.coreGetOperationMiss
        ? () => null
        : adapter.getOperation,
      appendEvent: (event: Record<string, unknown>) => {
        adapter.appendEvent(event);
        if (eventOptions?.broadcast !== false) {
          order.push("broadcastEvent");
          broadcastEvents.push({
            origin: String(event.origin),
            path: String(event.path),
            type: String(event.type),
          });
        }
      },
    }),
    broadcastEvent: (event: {
      origin?: string;
      path: string;
      type: string;
    }) => {
      order.push("broadcastEvent");
      broadcastEvents.push({
        origin: String(event.origin),
        path: event.path,
        type: String(event.type),
      });
    },
    flushStorage: vi.fn(async () => {
      order.push("flushStorage");
    }),
    writeReceiptFile: vi.fn(async (input: Record<string, unknown>) => {
      order.push("writeReceiptFile");
      writeReceiptCalls.push(input);
    }),
    upsertWorkspaceOperation: upsertOp,
    syncWorkspaceStats: vi.fn(async () => undefined),
  } as unknown as OpsHandlerContext;

  return {
    context,
    queueSend,
    upsertOp,
    appendedEvents,
    broadcastEvents,
    putOperationCalls,
    writeReceiptCalls,
    order,
    nextOpIds,
  };
}

function operation(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    opId: "op_ack",
    path: "/github/repos/acme/api/issues/1__bug/meta.json",
    revision: "rev_44",
    action: "file_upsert",
    provider: "github",
    status: "dispatched",
    attemptCount: 0,
    nextAttemptAt: null,
    lastError: null,
    correlationId: "corr_agent",
    ...overrides,
  };
}

describe("recordMutation origin gating", () => {
  it("skips op creation and writeback dispatch for provider_sync origin", async () => {
    const { context, queueSend, upsertOp, appendedEvents, putOperationCalls } =
      createOpsContext();

    const result = await recordMutation(context, {
      path: "/notion/pages/abc123.json",
      revision: "rev_42",
      provider: "notion",
      correlationId: "corr_sync",
      eventType: "file.updated",
      action: "file_upsert",
      timestamp: "2026-05-07T10:00:00.000Z",
      origin: "provider_sync",
    });

    // No writeback op created → no putOperation, no upsert, no queue send.
    expect(putOperationCalls).toEqual([]);
    expect(upsertOp).not.toHaveBeenCalled();
    expect(queueSend).not.toHaveBeenCalled();

    // Event still fired with origin=provider_sync so onWrite subscribers
    // (cataloging agents, daemon mounts) see the change.
    expect(appendedEvents).toEqual([
      {
        origin: "provider_sync",
        path: "/notion/pages/abc123.json",
        type: "file.updated",
      },
    ]);

    // Response shape signals "no writeback intended" via empty opId +
    // writeback.state=succeeded so the SDK caller doesn't poll for a
    // writeback that will never run.
    expect(result.opId).toBe("");
    expect(result.writeback?.state).toBe("succeeded");
    expect(result.targetRevision).toBe("rev_42");
  });

  it("skips op creation and writeback dispatch for system origin (cloud#2029 drain primitive)", async () => {
    // The legacy-draft drain removes a delivered Slack draft via a
    // system-origin file.deleted. recordMutations MUST suppress the op +
    // dispatch (else the Slack adapter turns file_delete into chat.delete and
    // UN-SENDS the delivered message), while still emitting the tombstone event
    // so mounts apply the delete. Mutation guard: reverting the suppression to
    // `origin === "provider_sync"` only makes this test fail (an op is created).
    const { context, queueSend, upsertOp, appendedEvents, putOperationCalls } =
      createOpsContext();

    const result = await recordMutation(context, {
      path: "/slack/channels/C0B8ZL2L9GC__x/messages/draft-abc.json",
      revision: "rev_900",
      provider: "slack",
      correlationId: "relayfile:legacy-draft-drain:run_1",
      eventType: "file.deleted",
      action: "file_delete",
      timestamp: "2026-06-09T17:00:00.000Z",
      origin: "system",
    });

    expect(putOperationCalls).toEqual([]);
    expect(upsertOp).not.toHaveBeenCalled();
    expect(queueSend).not.toHaveBeenCalled();
    expect(appendedEvents).toEqual([
      {
        origin: "system",
        path: "/slack/channels/C0B8ZL2L9GC__x/messages/draft-abc.json",
        type: "file.deleted",
      },
    ]);
    expect(result.opId).toBe("");
    expect(result.writeback?.state).toBe("succeeded");
  });

  it("still creates a writeback op + dispatch for agent_write deletes (suppression is system-only, not all deletes)", async () => {
    // Guards the narrowing: only system/provider_sync are suppressed. A normal
    // agent delete still creates the op (so genuine agent-authored deletes keep
    // working). Mutation guard: broadening suppression to all origins fails this.
    const { context, queueSend, putOperationCalls } = createOpsContext();

    const result = await recordMutation(context, {
      path: "/slack/channels/C0B8ZL2L9GC__x/messages/1781594911.320649.json",
      revision: "rev_901",
      provider: "slack",
      correlationId: "corr_agent",
      eventType: "file.deleted",
      action: "file_delete",
      timestamp: "2026-06-09T17:01:00.000Z",
      origin: "agent_write",
    });

    expect(result.opId).toBe("op_1");
    expect(putOperationCalls.length).toBeGreaterThan(0);
    expect(queueSend).toHaveBeenCalledOnce();
  });

  it.each([
    {
      provider: "slack",
      path: "/slack/channels/C0AD7UU0J1G__proj-cloud/messages/1781594911_320649/replies/.relay/state.json",
    },
    {
      provider: "linear",
      path: "/linear/teams/AR/.relay/state.json",
    },
    {
      provider: "_logs",
      path: "/_logs/rw_7ccfea89/2026-06-16.jsonl",
    },
    {
      provider: "github",
      path: "/github/repos/AgentWorkforce/cloud/issues/1190__e2e-probe-6-atomic-opened-with-label/meta.json",
    },
  ])(
    "skips op creation and writeback dispatch for non-writeback agent_write path $path",
    async ({ provider, path }) => {
      const {
        context,
        queueSend,
        upsertOp,
        appendedEvents,
        putOperationCalls,
      } = createOpsContext();

      const result = await recordMutation(context, {
        path,
        revision: "rev_internal",
        provider,
        correlationId: "corr_agent",
        eventType: "file.updated",
        action: "file_upsert",
        timestamp: "2026-06-16T13:55:00.000Z",
        origin: "agent_write",
      });

      expect(putOperationCalls).toEqual([]);
      expect(upsertOp).not.toHaveBeenCalled();
      expect(queueSend).not.toHaveBeenCalled();
      expect(appendedEvents).toEqual([
        {
          origin: "agent_write",
          path,
          type: "file.updated",
        },
      ]);
      expect(result.opId).toBe("");
      expect(result.writeback?.state).toBe("succeeded");
    },
  );

  it("dispatches factory-create writebacks even when the core adapter lookup misses the freshly-created op", async () => {
    const { context, queueSend } = createOpsContext({
      coreGetOperationMiss: true,
    });

    const result = await recordMutation(context, {
      path: "/linear/issues/factory-create-uuid-new.json",
      revision: "rev_factory",
      provider: "linear",
      correlationId: "corr_factory_create",
      eventType: "file.created",
      action: "file_upsert",
      timestamp: "2026-06-15T10:00:00.000Z",
      origin: "agent_write",
    });

    expect(result.opId).toBe("op_1");
    expect(queueSend).toHaveBeenCalledOnce();
    expect(queueSend).toHaveBeenCalledWith(
      expect.objectContaining({
        opId: "op_1",
        workspaceId: "ws_517d60b6",
        path: "/linear/issues/factory-create-uuid-new.json",
        revision: "rev_factory",
        correlationId: "corr_factory_create",
      }),
    );
  });

  it.each([
    {
      path: "/linear/labels/create-area-harnesses.json",
      correlationId: "corr_linear_label_create",
    },
    {
      path: "/linear/projects/create-roadmap.json",
      correlationId: "corr_linear_project_create",
    },
    {
      path: "/linear/projects/11111111-1111-4111-8111-111111111111/meta.json",
      correlationId: "corr_linear_project_update",
    },
    {
      path: "/linear/projects/11111111-1111-4111-8111-111111111111/add-issues.json",
      correlationId: "corr_linear_project_assign",
    },
  ])(
    "creates a writeback op + dispatch for Linear writable resource path $path",
    async ({ path, correlationId }) => {
      const { context, queueSend, putOperationCalls } = createOpsContext();

      const result = await recordMutation(context, {
        path,
        revision: "rev_linear_resource",
        provider: "linear",
        correlationId,
        eventType: "file.created",
        action: "file_upsert",
        timestamp: "2026-06-17T12:00:00.000Z",
        origin: "agent_write",
      });

      expect(result.opId).toBe("op_1");
      expect(putOperationCalls.length).toBeGreaterThan(0);
      expect(queueSend).toHaveBeenCalledOnce();
      expect(queueSend).toHaveBeenCalledWith(
        expect.objectContaining({
          opId: "op_1",
          workspaceId: "ws_517d60b6",
          path,
          revision: "rev_linear_resource",
          correlationId,
        }),
      );
    },
  );

  it("emits the event with origin=provider_sync for delete actions too", async () => {
    const { context, queueSend, upsertOp, appendedEvents, putOperationCalls } =
      createOpsContext();

    await recordMutation(context, {
      path: "/notion/pages/abc123.json",
      revision: "rev_43",
      provider: "notion",
      correlationId: "corr_sync",
      eventType: "file.deleted",
      action: "file_delete",
      timestamp: "2026-05-07T10:01:00.000Z",
      origin: "provider_sync",
    });

    expect(putOperationCalls).toEqual([]);
    expect(upsertOp).not.toHaveBeenCalled();
    expect(queueSend).not.toHaveBeenCalled();
    expect(appendedEvents).toEqual([
      {
        origin: "provider_sync",
        path: "/notion/pages/abc123.json",
        type: "file.deleted",
      },
    ]);
  });

  it.each([
    "/discovery/github/.adapter.md",
    "/github/repos/AgentWorkforce/cloud/issues/1190__e2e-probe-6-atomic-opened-with-label/meta.json",
  ])(
    "skips writeback op creation and dispatch for GitHub provider-sync writes to %s",
    async (path) => {
      const {
        context,
        queueSend,
        upsertOp,
        appendedEvents,
        putOperationCalls,
      } = createOpsContext();

      const result = await recordMutation(context, {
        path,
        revision: "rev_44",
        provider: "github",
        correlationId: "corr_sync",
        eventType: "file.updated",
        action: "file_upsert",
        timestamp: "2026-05-07T10:02:00.000Z",
        origin: "provider_sync",
      });

      expect(putOperationCalls).toEqual([]);
      expect(upsertOp).not.toHaveBeenCalled();
      expect(queueSend).not.toHaveBeenCalled();
      expect(appendedEvents).toEqual([
        {
          origin: "provider_sync",
          path,
          type: "file.updated",
        },
      ]);
      expect(result.opId).toBe("");
      expect(result.writeback?.state).toBe("succeeded");
    },
  );

  it("flushes file events before broadcasting or dispatching writeback", async () => {
    const { context, order, broadcastEvents, queueSend } = createOpsContext();

    const result = await recordMutation(context, {
      path: "/github/repos/acme/api/issues/create-bug.json",
      revision: "rev_44",
      provider: "github",
      correlationId: "corr_agent",
      eventType: "file.updated",
      action: "file_upsert",
      timestamp: "2026-05-07T10:02:00.000Z",
      origin: "agent_write",
    });

    expect(result.opId).toBe("op_1");
    expect(queueSend).toHaveBeenCalledOnce();
    expect(broadcastEvents).toEqual([
      {
        origin: "agent_write",
        path: "/github/repos/acme/api/issues/create-bug.json",
        type: "file.updated",
      },
    ]);
    expect(order.slice(0, 5)).toEqual([
      "putOperation",
      "appendEvent",
      "flushStorage",
      "upsertOp",
      "broadcastEvent",
    ]);
    expect(order.slice(5, 9)).toEqual([
      "putOperation",
      "putOperation",
      "flushStorage",
      "queueSend",
    ]);
  });

  it("batches agent_write mutation flush while preserving per-file writeback ops and broadcasts", async () => {
    const { context, order, broadcastEvents, queueSend, putOperationCalls } =
      createOpsContext();

    const result = await recordMutations(context, [
      {
        path: "/github/repos/acme/api/issues/create-bug.json",
        revision: "rev_44",
        provider: "github",
        correlationId: "corr_agent",
        eventType: "file.updated",
        action: "file_upsert",
        timestamp: "2026-05-07T10:02:00.000Z",
        origin: "agent_write",
      },
      {
        path: "/github/repos/acme/api/issues/create-feature.json",
        revision: "rev_45",
        provider: "github",
        correlationId: "corr_agent",
        eventType: "file.created",
        action: "file_upsert",
        timestamp: "2026-05-07T10:02:01.000Z",
        origin: "agent_write",
      },
    ]);

    expect(result.syncCount).toBe(1);
    expect(result.responses.map((item) => item.opId)).toEqual(["op_1", "op_2"]);
    expect(queueSend).toHaveBeenCalledTimes(2);
    expect(broadcastEvents).toEqual([
      {
        origin: "agent_write",
        path: "/github/repos/acme/api/issues/create-bug.json",
        type: "file.updated",
      },
      {
        origin: "agent_write",
        path: "/github/repos/acme/api/issues/create-feature.json",
        type: "file.created",
      },
    ]);
    expect(
      new Set(
        putOperationCalls
          .map((operation) => String(operation.opId))
          .filter((opId) => opId === "op_1" || opId === "op_2"),
      ),
    ).toEqual(new Set(["op_1", "op_2"]));

    const firstBroadcastIndex = order.indexOf("broadcastEvent");
    expect(firstBroadcastIndex).toBeGreaterThan(-1);
    expect(order.slice(0, firstBroadcastIndex)).toEqual([
      "putOperation",
      "appendEvent",
      "putOperation",
      "appendEvent",
      "flushStorage",
      "upsertOp",
      "upsertOp",
    ]);
  });

  it("flushes ack events before broadcasting writeback status", async () => {
    const { context, order, broadcastEvents, putOperationCalls } =
      createOpsContext({
        readJsonBody: {
          success: true,
          providerResult: { url: "https://example.test/issue/1" },
        },
      });
    putOperationCalls.push(operation());

    const response = await handleAckWriteback(
      context,
      new Request("https://relayfile.test/writeback/op_ack/ack"),
      "op_ack",
    );

    expect(response.status).toBe(200);
    expect(broadcastEvents).toEqual([
      {
        origin: "system",
        path: "/github/repos/acme/api/issues/1__bug/meta.json",
        type: "writeback.succeeded",
      },
    ]);
    expect(order.slice(0, 5)).toEqual([
      "putOperation",
      "appendEvent",
      "flushStorage",
      "broadcastEvent",
      "upsertOp",
    ]);
  });

  it("surfaces the provider object id as a receipt on the draft file so post() can thread", async () => {
    const { context, writeReceiptCalls, putOperationCalls } = createOpsContext({
      readJsonBody: {
        success: true,
        providerResult: { externalId: "1718900000.001200", idempotencyDuplicate: false },
      },
    });
    putOperationCalls.push(operation());

    const response = await handleAckWriteback(
      context,
      new Request("https://relayfile.test/writeback/op_ack/ack"),
      "op_ack",
    );

    expect(response.status).toBe(200);
    // The receipt is written back onto the same draft path the agent's
    // slackClient().post() is polling via waitForReceipt, carrying the ts.
    expect(writeReceiptCalls).toHaveLength(1);
    expect(writeReceiptCalls[0]).toMatchObject({
      workspaceId: "ws_517d60b6",
      path: "/github/repos/acme/api/issues/1__bug/meta.json",
      provider: "github",
      receipt: {
        path: "/github/repos/acme/api/issues/1__bug/meta.json",
        externalId: "1718900000.001200",
        ts: "1718900000.001200",
        id: "1718900000.001200",
      },
    });
  });

  it("does not write a receipt when the provider returned no object id", async () => {
    const { context, writeReceiptCalls, putOperationCalls } = createOpsContext({
      readJsonBody: {
        success: true,
        providerResult: { url: "https://example.test/issue/1" },
      },
    });
    putOperationCalls.push(operation());

    const response = await handleAckWriteback(
      context,
      new Request("https://relayfile.test/writeback/op_ack/ack"),
      "op_ack",
    );

    expect(response.status).toBe(200);
    expect(writeReceiptCalls).toHaveLength(0);
  });

  it("does not write a receipt for a failed writeback ack", async () => {
    const { context, writeReceiptCalls, putOperationCalls } = createOpsContext({
      readJsonBody: { success: false, error: "boom" },
    });
    putOperationCalls.push(operation());

    const response = await handleAckWriteback(
      context,
      new Request("https://relayfile.test/writeback/op_ack/ack"),
      "op_ack",
    );

    expect(response.status).toBe(200);
    expect(writeReceiptCalls).toHaveLength(0);
  });

  it("broadcasts final queue-send failure events after flushing them", async () => {
    const { context, order, broadcastEvents, putOperationCalls } =
      createOpsContext({
        queueSend: async () => {
          throw new Error("queue unavailable");
        },
      });
    putOperationCalls.push(operation({ status: "pending", attemptCount: 2 }));

    const result = await dispatchWriteback(context, "op_ack");

    expect(result.kind).toBe("dead_lettered");
    expect(broadcastEvents).toEqual([
      {
        origin: "system",
        path: "/github/repos/acme/api/issues/1__bug/meta.json",
        type: "writeback.failed",
      },
    ]);
    expect(order).toEqual([
      "putOperation",
      "putOperation",
      "flushStorage",
      "queueSend",
      "putOperation",
      "putOperation",
      "appendEvent",
      "flushStorage",
      "broadcastEvent",
      "upsertOp",
    ]);
  });

  it("does not report retryable queue-send failures as missing writebacks", async () => {
    const { context, putOperationCalls } = createOpsContext({
      readJsonBody: { opId: "op_ack" },
      queueSend: async () => {
        throw new Error("queue unavailable");
      },
    });
    putOperationCalls.push(operation({ status: "pending", attemptCount: 0 }));

    const response = await handleDispatchWriteback(
      context,
      new Request("https://relayfile.test/writeback/dispatch", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      status: "queued",
      dispatchStatus: "retry_scheduled",
      id: "op_ack",
    });
  });

  it("surfaces retry alarm scheduling failures separately from scheduled retries", async () => {
    const { context, putOperationCalls } = createOpsContext({
      readJsonBody: { opId: "op_ack" },
      queueSend: async () => {
        throw new Error("queue unavailable");
      },
      setAlarm: async () => {
        throw new Error("alarm unavailable");
      },
    });
    putOperationCalls.push(operation({ status: "pending", attemptCount: 0 }));

    const response = await handleDispatchWriteback(
      context,
      new Request("https://relayfile.test/writeback/dispatch", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      status: "queued",
      dispatchStatus: "retry_alarm_failed",
      id: "op_ack",
    });
  });

  it("reports final queue-send failure dispatches as dead-lettered", async () => {
    const { context, putOperationCalls } = createOpsContext({
      readJsonBody: { opId: "op_ack" },
      queueSend: async () => {
        throw new Error("queue unavailable");
      },
    });
    putOperationCalls.push(operation({ status: "pending", attemptCount: 2 }));

    const response = await handleDispatchWriteback(
      context,
      new Request("https://relayfile.test/writeback/dispatch", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      status: "queued",
      dispatchStatus: "dead_lettered",
      id: "op_ack",
    });
  });

  it("maps internal dispatched status on public operation reads", async () => {
    const { context, putOperationCalls } = createOpsContext();
    putOperationCalls.push(operation());

    const getResponse = await handleGetOperation(
      context,
      new Request("https://relayfile.test/ops/op_ack"),
      "op_ack",
    );
    await expect(getResponse.json()).resolves.toMatchObject({
      opId: "op_ack",
      status: "running",
    });

    const listResponse = await handleListOperationsGet(
      context,
      new Request("https://relayfile.test/ops"),
    );
    await expect(listResponse.json()).resolves.toMatchObject({
      items: [{ opId: "op_ack", status: "running" }],
    });

    const filteredListResponse = await handleListOperationsGet(
      context,
      new Request("https://relayfile.test/ops?status=running"),
    );
    await expect(filteredListResponse.json()).resolves.toMatchObject({
      items: [{ opId: "op_ack", status: "running" }],
    });
  });

  it("still dispatches replay when the D1 operation mirror fails", async () => {
    const { context, putOperationCalls, queueSend } = createOpsContext({
      upsertWorkspaceOperation: async () => {
        throw new Error("d1 unavailable");
      },
    });
    putOperationCalls.push(
      operation({ status: "dead_lettered", attemptCount: 3 }),
    );

    const response = await handleReplayOperation(
      context,
      new Request("https://relayfile.test/ops/op_ack/replay", {
        method: "POST",
      }),
      "op_ack",
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      status: "queued",
      id: "op_ack",
    });
    expect(queueSend).toHaveBeenCalledWith(
      expect.objectContaining({ opId: "op_ack" }),
    );
  });
});

// ── Server-side threading ───────────────────────────────────────────────────
// A reply op that names a not-yet-delivered parent must be HELD (not dispatched
// on write) and then released by the parent's ack with the parent's delivered
// ts injected as thread_ts. Backed by a real in-memory operations store so the
// parent_op_id SQL (resolve-by-path, set, pending-children, provider_result_json)
// actually executes.
describe("parent-dependency: ordered child-op dispatch (slack threading is one consumer)", () => {
  type OpRow = {
    opId: string;
    path: string;
    revision: string;
    action: string;
    provider: string;
    status: string;
    attemptCount: number;
    nextAttemptAt: string | null;
    lastError: string | null;
    providerResultJson: string | null;
    correlationId: string;
    createdAt: string;
    parentOpId: string | null;
  };

  function makeThreadingContext() {
    const store = new Map<string, OpRow>();
    let opSeq = 0;
    let evtSeq = 0;
    const sent: Array<Record<string, unknown>> = [];
    let createdAtSeq = 0;

    const adapter = {
      getFile: () => null,
      listFiles: () => [],
      putFile: () => undefined,
      deleteFile: () => undefined,
      loadFileContent: () => ({ content: "", encoding: "utf-8" as const }),
      appendEvent: () => undefined,
      listEvents: () => ({ items: [], nextCursor: null }),
      getRecentEvents: () => [],
      nextRevision: () => "rev_test",
      nextOperationId: () => `op_${++opSeq}`,
      nextEventId: () => `evt_${++evtSeq}`,
      enqueueWriteback: () => undefined,
      getPendingWritebacks: () => [],
      getWorkspaceId: () => "ws_thread",
      getOperation: (opId: string) => {
        const row = store.get(opId);
        return row ? { ...row } : null;
      },
      putOperation: (op: Record<string, unknown>) => {
        const opId = String(op.opId);
        const prev = store.get(opId);
        store.set(opId, {
          opId,
          path: String(op.path ?? prev?.path ?? ""),
          revision: String(op.revision ?? prev?.revision ?? ""),
          action: String(op.action ?? prev?.action ?? "file_upsert"),
          provider: String(op.provider ?? prev?.provider ?? ""),
          status: String(op.status ?? prev?.status ?? "pending"),
          attemptCount: Number(op.attemptCount ?? prev?.attemptCount ?? 0),
          nextAttemptAt:
            (op.nextAttemptAt as string | null) ?? prev?.nextAttemptAt ?? null,
          lastError: (op.lastError as string | null) ?? prev?.lastError ?? null,
          providerResultJson:
            (op.providerResultJson as string | null) ??
            prev?.providerResultJson ??
            null,
          correlationId: String(
            op.correlationId ?? prev?.correlationId ?? "",
          ),
          createdAt: String(
            prev?.createdAt ??
              `2026-06-19T00:00:0${createdAtSeq++}.000Z`,
          ),
          parentOpId: prev?.parentOpId ?? null,
        });
      },
      listOperations: () => ({ items: [], nextCursor: null }),
    };

    // context.sql backed by the same store: handles getOperation reads, the
    // parent_op_id resolve/set, pending-children, and the ack's result update.
    const sql = {
      exec: (query: string, ...bindings: unknown[]) => {
        const rows = () => [...store.values()];
        if (query.includes("UPDATE operations SET parent_op_id")) {
          const row = store.get(String(bindings[1]));
          if (row) row.parentOpId = String(bindings[0]);
          return { toArray: () => [], one: () => null };
        }
        if (query.includes("UPDATE operations SET provider_result_json")) {
          const row = store.get(String(bindings[1]));
          if (row) row.providerResultJson = String(bindings[0]);
          return { toArray: () => [], one: () => null };
        }
        if (
          query.includes("FROM operations") &&
          query.includes("WHERE path = ?")
        ) {
          const match = rows()
            .filter((r) => r.path === String(bindings[0]) && r.status !== "failed")
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
          return {
            one: () => (match ? { op_id: match.opId } : null),
            toArray: () => (match ? [{ op_id: match.opId }] : []),
          };
        }
        if (
          query.includes("FROM operations") &&
          query.includes("WHERE parent_op_id = ?")
        ) {
          const matches = rows().filter(
            (r) => r.parentOpId === String(bindings[0]) && r.status === "pending",
          );
          return {
            toArray: () => matches.map((r) => ({ op_id: r.opId })),
            one: () => (matches[0] ? { op_id: matches[0].opId } : null),
          };
        }
        if (query.includes("FROM operations") && query.includes("WHERE op_id = ?")) {
          const r = store.get(String(bindings[0]));
          return {
            one: () =>
              r
                ? {
                    op_id: r.opId,
                    path: r.path,
                    revision: r.revision,
                    action: r.action,
                    provider: r.provider,
                    status: r.status,
                    attempt_count: r.attemptCount,
                    next_attempt_at: r.nextAttemptAt,
                    last_error: r.lastError,
                    provider_result_json: r.providerResultJson,
                    correlation_id: r.correlationId,
                    created_at: r.createdAt,
                    updated_at: r.createdAt,
                    completed_at: null,
                    parent_op_id: r.parentOpId ?? null,
                  }
                : null,
            toArray: () => [],
          };
        }
        // ensureNextAlarm's pending+next_attempt query and anything else.
        return { one: () => null, toArray: () => [] };
      },
    };

    const context = {
      workspaceId: "ws_thread",
      bindings: {
        WRITEBACK_QUEUE: {
          send: vi.fn(async (item: Record<string, unknown>) => {
            sent.push(item);
          }),
        },
      },
      state: {
        storage: {
          setAlarm: vi.fn(async () => undefined),
          deleteAlarm: vi.fn(async () => undefined),
        },
      },
      sql,
      getFileRow: () => null,
      loadContent: async () => "",
      readJson: async <T>(_request: Request) => ({}) as T,
      resolveWorkspaceId: async () => "ws_thread",
      requireWorkspaceId: async () => "ws_thread",
      getWorkspaceId: async () => "ws_thread",
      correlationId: () => "corr_thread",
      json: (payload: unknown, status = 200) =>
        new Response(JSON.stringify(payload), { status }),
      errorResponse: (
        _request: Request,
        status: number,
        code: string,
        message: string,
      ) => new Response(JSON.stringify({ code, message }), { status }),
      coreStorageAdapter: () => adapter,
      broadcastEvent: () => undefined,
      flushStorage: vi.fn(async () => undefined),
      writeReceiptFile: vi.fn(async () => undefined),
      upsertWorkspaceOperation: vi.fn(async () => undefined),
      syncWorkspaceStats: vi.fn(async () => undefined),
    } as unknown as OpsHandlerContext;

    return { context, store, sent };
  }

  const HEADER_PATH = "/slack/channels/C0/messages/messages header.json";
  // A server-side-threaded reply is a plain message draft carrying a parentRef —
  // the cloud injects thread_ts — NOT a `messages/{ts}/replies/` path (which the
  // adapter-slack resolver would mangle when the segment isn't a real ts).
  const REPLY_PATH = "/slack/channels/C0/messages/messages reply.json";

  it("holds a child op until its parent acks, then dispatches it carrying the parent's delivered id", async () => {
    const { context, store, sent } = makeThreadingContext();

    // 1. Header posts — ordinary op, dispatched eagerly.
    await recordMutation(context, {
      path: HEADER_PATH,
      revision: "rev_h",
      provider: "slack",
      correlationId: "corr_thread",
      eventType: "file.created",
      action: "file_upsert",
      timestamp: "2026-06-19T00:00:00.000Z",
    });
    const headerOpId = [...store.values()].find((o) => o.path === HEADER_PATH)!
      .opId;
    expect(sent.map((i) => i.opId)).toEqual([headerOpId]);

    // 2. Reply names the header draft as its parent — must be HELD (parent not
    //    yet delivered): created with parent_op_id, but NOT dispatched.
    await recordMutation(context, {
      path: REPLY_PATH,
      revision: "rev_r",
      provider: "slack",
      correlationId: "corr_thread",
      eventType: "file.created",
      action: "file_upsert",
      timestamp: "2026-06-19T00:00:01.000Z",
      parentRef: HEADER_PATH,
    });
    const replyRow = [...store.values()].find((o) => o.path === REPLY_PATH)!;
    expect(replyRow.parentOpId).toBe(headerOpId);
    expect(sent.map((i) => i.opId)).toEqual([headerOpId]); // reply NOT dispatched yet

    // 3. Header acks with a delivered Slack ts → the reply is released with that
    //    ts injected as thread_ts.
    context.readJson = (async () => ({
      success: true,
      providerResult: { ts: "1718999999.001200", channel: "C0" },
    })) as typeof context.readJson;
    const ackRes = await handleAckWriteback(
      context,
      new Request("https://do/ack", { method: "POST" }),
      headerOpId,
    );
    expect(ackRes.status).toBe(200);

    const replyItem = sent.find((i) => i.opId === replyRow.opId);
    expect(replyItem, "reply dispatched on parent ack").toBeDefined();
    expect(replyItem?.parentExternalId).toBe("1718999999.001200");
  });

  it("links a child to a parent that appears LATER in the same batch (arrival order independent)", async () => {
    const { context, store, sent } = makeThreadingContext();

    // The mount can sync a header and its cards in one bulk batch with no
    // guaranteed order. Record the REPLY first and the HEADER second in a single
    // recordMutations call: the reply must still link to the header (held, not
    // dispatched), proving parentRef is resolved after every op in the batch
    // exists — not in the per-op creation pass.
    await recordMutations(context, [
      {
        path: REPLY_PATH,
        revision: "rev_r",
        provider: "slack",
        correlationId: "corr_batch",
        eventType: "file.created",
        action: "file_upsert",
        timestamp: "2026-06-19T00:00:01.000Z",
        parentRef: HEADER_PATH,
      },
      {
        path: HEADER_PATH,
        revision: "rev_h",
        provider: "slack",
        correlationId: "corr_batch",
        eventType: "file.created",
        action: "file_upsert",
        timestamp: "2026-06-19T00:00:00.000Z",
      },
    ]);

    const headerOpId = [...store.values()].find((o) => o.path === HEADER_PATH)!
      .opId;
    const replyRow = [...store.values()].find((o) => o.path === REPLY_PATH)!;
    // Linked despite coming first in the batch; header dispatched, reply held.
    expect(replyRow.parentOpId).toBe(headerOpId);
    expect(sent.map((i) => i.opId)).toEqual([headerOpId]);

    context.readJson = (async () => ({
      success: true,
      providerResult: { ts: "1718999999.001200", channel: "C0" },
    })) as typeof context.readJson;
    await handleAckWriteback(
      context,
      new Request("https://do/ack", { method: "POST" }),
      headerOpId,
    );
    const replyItem = sent.find((i) => i.opId === replyRow.opId);
    expect(replyItem, "reply dispatched on parent ack").toBeDefined();
    expect(replyItem?.parentExternalId).toBe("1718999999.001200");
  });

  it("carries the parent's id resolved from parent_op_id (not a transient arg), so any dispatch — incl. retries — threads", async () => {
    const { context, store, sent } = makeThreadingContext();

    // Header posts AND acks (delivered) BEFORE the reply is recorded.
    await recordMutation(context, {
      path: HEADER_PATH,
      revision: "rev_h",
      provider: "slack",
      correlationId: "corr_pre",
      eventType: "file.created",
      action: "file_upsert",
      timestamp: "2026-06-19T00:00:00.000Z",
    });
    const headerOpId = [...store.values()].find((o) => o.path === HEADER_PATH)!
      .opId;
    context.readJson = (async () => ({
      success: true,
      providerResult: { ts: "1718999999.001200", channel: "C0" },
    })) as typeof context.readJson;
    await handleAckWriteback(
      context,
      new Request("https://do/ack", { method: "POST" }),
      headerOpId,
    );
    sent.length = 0;

    // Reply recorded after the parent already delivered → dispatched immediately,
    // carrying the parent's id resolved from the persisted parent_op_id. No
    // transient dispatch arg is involved, which is exactly what keeps the id on
    // any later alarm-driven retry too (the bug being a top-level repost).
    await recordMutation(context, {
      path: REPLY_PATH,
      revision: "rev_r",
      provider: "slack",
      correlationId: "corr_pre",
      eventType: "file.created",
      action: "file_upsert",
      timestamp: "2026-06-19T00:00:02.000Z",
      parentRef: HEADER_PATH,
    });
    const replyRow = [...store.values()].find((o) => o.path === REPLY_PATH)!;
    const replyItem = sent.find((i) => i.opId === replyRow.opId);
    expect(replyItem, "reply dispatched immediately").toBeDefined();
    expect(replyItem?.parentExternalId).toBe("1718999999.001200");
  });
});
