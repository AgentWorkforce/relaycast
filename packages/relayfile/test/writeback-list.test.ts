import { describe, expect, it, vi } from "vitest";
import {
  handleListWritebacks,
  type OpsHandlerContext,
} from "../src/durable-objects/handlers/ops.js";

// Hosted writeback discovery exposes only actionable agent-facing states:
// `pending` and `dead`. Dead-lettered DB rows still include the canonical
// `WritebackDeadLetterError` payload derived from operations-row columns, so
// SDK consumers can read the same `error` block they'd otherwise read from the
// on-disk `.relay/dead-letter/<opId>.error.json` sidecar.

type Row = Record<string, unknown>;

function createContext(rows: Row[]): {
  context: OpsHandlerContext;
  execArgs: unknown[][];
} {
  const execArgs: unknown[][] = [];
  const exec = (query: string, ...bindings: unknown[]) => {
    execArgs.push([query, ...bindings]);
    return { toArray: <R>() => rows as unknown as R[] };
  };
  const context = {
    workspaceId: "ws_test",
    bindings: { WRITEBACK_QUEUE: { send: vi.fn() } },
    state: { storage: { setAlarm: vi.fn(), deleteAlarm: vi.fn() } },
    sql: { exec },
    requireWorkspaceId: async () => "ws_test",
    resolveWorkspaceId: async () => "ws_test",
    getWorkspaceId: async () => "ws_test",
    getFileRow: () => null,
    loadContent: async () => "",
    readJson: async <T>() => ({}) as T,
    correlationId: () => "corr_test",
    json: (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    errorResponse: (
      _req: Request,
      status: number,
      code: string,
      message: string,
    ) =>
      new Response(JSON.stringify({ code, message }), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    coreStorageAdapter: () => ({}) as never,
    upsertWorkspaceOperation: vi.fn(),
    syncWorkspaceStats: vi.fn(),
  } as unknown as OpsHandlerContext;
  return { context, execArgs };
}

describe("handleListWritebacks", () => {
  it("rejects requests missing the state query parameter", async () => {
    const { context } = createContext([]);
    const res = await handleListWritebacks(
      context,
      new Request("https://example.com/writeback"),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("invalid_input");
    expect(body.message).toMatch(/missing state/);
  });

  it("rejects unsupported state values", async () => {
    const { context } = createContext([]);
    const res = await handleListWritebacks(
      context,
      new Request("https://example.com/writeback?state=quarantined"),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.message).toMatch(/unsupported state "quarantined"/);
  });

  it("rejects terminal history states from the hosted agent-facing list", async () => {
    const { context } = createContext([]);
    const res = await handleListWritebacks(
      context,
      new Request("https://example.com/writeback?state=succeeded"),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("expected one of: pending, dead");
  });

  it("returns pending operations mapped onto the SDK WritebackItem shape", async () => {
    const { context, execArgs } = createContext([
      {
        op_id: "op_1",
        path: "/linear/issues/AGE-16/comments/abc.json",
        revision: "rev_1",
        action: "file_upsert",
        provider: "linear",
        status: "pending",
        attempt_count: 0,
        next_attempt_at: null,
        last_error: null,
        provider_result_json: null,
        correlation_id: "corr_a",
        created_at: "2026-05-13T10:00:00.000Z",
        updated_at: "2026-05-13T10:00:00.000Z",
        completed_at: null,
      },
    ]);
    const res = await handleListWritebacks(
      context,
      new Request("https://example.com/writeback?state=pending"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<Record<string, unknown>>;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      id: "op_1",
      workspaceId: "ws_test",
      state: "pending",
      provider: "linear",
      attempts: 0,
      firstAttemptAt: "2026-05-13T10:00:00.000Z",
      enqueuedAt: "2026-05-13T10:00:00.000Z",
    });
    expect(body.items[0]).not.toHaveProperty("error");
    // The SQL filter is parameterized — no string interpolation of the
    // state value, guarding against state-parameter SQL injection.
    expect(execArgs[0][1]).toBe("pending");
  });

  it("returns a keyset cursor when more than one writeback page exists", async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => ({
      op_id: `op_${String(1001 - i).padStart(4, "0")}`,
      path: `/linear/issues/${i}.json`,
      revision: `rev_${i}`,
      action: "file_upsert",
      provider: "linear",
      status: "pending",
      attempt_count: 0,
      next_attempt_at: null,
      last_error: null,
      provider_result_json: null,
      correlation_id: `corr_${i}`,
      created_at: `2026-05-13T10:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`,
      updated_at: "2026-05-13T10:00:00.000Z",
      completed_at: null,
    }));
    const { context, execArgs } = createContext(rows);
    const res = await handleListWritebacks(
      context,
      new Request("https://example.com/writeback?state=pending"),
    );

    const body = (await res.json()) as {
      items: Array<Record<string, unknown>>;
      nextCursor: string | null;
      hasMore: boolean;
    };
    expect(body.items).toHaveLength(1000);
    expect(body.hasMore).toBe(true);
    expect(body.nextCursor).toEqual(expect.any(String));
    expect(String(execArgs[0][0])).toContain("LIMIT ?");
    expect(execArgs[0].at(-1)).toBe(1001);
  });

  it("uses the writeback keyset cursor on continuation requests", async () => {
    const cursor = btoa(
      JSON.stringify({
        createdAt: "2026-05-13T10:00:00.000Z",
        opId: "op_1000",
      }),
    );
    const { context, execArgs } = createContext([]);

    await handleListWritebacks(
      context,
      new Request(
        `https://example.com/writeback?state=pending&cursor=${encodeURIComponent(cursor)}`,
      ),
    );

    expect(String(execArgs[0][0])).toContain("created_at < ?");
    expect(String(execArgs[0][0])).toContain("op_id < ?");
    expect(execArgs[0].slice(1)).toEqual([
      "pending",
      "2026-05-13T10:00:00.000Z",
      "2026-05-13T10:00:00.000Z",
      "op_1000",
      1001,
    ]);
  });

  it("maps state=dead onto the dead_lettered DB rows and surfaces alias verbatim", async () => {
    const { context, execArgs } = createContext([
      {
        op_id: "op_2",
        path: "/github/repos/acme/api/issues/42/comments/draft.json",
        revision: "rev_2",
        action: "file_upsert",
        provider: "github",
        status: "dead_lettered",
        attempt_count: 4,
        next_attempt_at: null,
        last_error: "422 Unprocessable Entity",
        provider_result_json: JSON.stringify({
          status: 422,
          body: { message: "Validation Failed" },
        }),
        correlation_id: "corr_b",
        created_at: "2026-05-13T14:30:01.000Z",
        updated_at: "2026-05-13T14:32:07.000Z",
        completed_at: "2026-05-13T14:32:07.000Z",
      },
    ]);
    const res = await handleListWritebacks(
      context,
      new Request("https://example.com/writeback?state=dead"),
    );
    expect(res.status).toBe(200);
    expect(execArgs[0][1]).toBe("dead_lettered");
    const body = (await res.json()) as {
      items: Array<Record<string, unknown>>;
    };
    expect(body.items).toHaveLength(1);
    const item = body.items[0];
    expect(item.state).toBe("dead");
    expect(item.attempts).toBe(4);
    expect(item.error).toMatchObject({
      code: "provider_4xx",
      message: "422 Unprocessable Entity",
      providerStatus: 422,
      attempts: 4,
      firstAttemptAt: "2026-05-13T14:30:01.000Z",
      lastAttemptAt: "2026-05-13T14:32:07.000Z",
      opId: "op_2",
    });
    expect(
      (
        (item.error as Record<string, unknown>).providerResponse as Record<
          string,
          unknown
        >
      ).status,
    ).toBe(422);
    expect(item.code).toBe("provider_4xx");
    expect(item.providerStatus).toBe(422);
  });

  it("classifies dead-letter rows without provider status as timeout (and schema_violation when the message mentions schema)", async () => {
    const { context } = createContext([
      {
        op_id: "op_timeout",
        path: "/linear/issues/AGE-17.json",
        revision: "rev_t",
        action: "file_upsert",
        provider: "linear",
        status: "dead_lettered",
        attempt_count: 5,
        next_attempt_at: null,
        last_error: "context deadline exceeded",
        provider_result_json: null,
        correlation_id: "corr_t",
        created_at: "2026-05-13T10:00:00.000Z",
        updated_at: "2026-05-13T10:05:00.000Z",
        completed_at: "2026-05-13T10:05:00.000Z",
      },
      {
        op_id: "op_schema",
        path: "/linear/issues/AGE-18.json",
        revision: "rev_s",
        action: "file_upsert",
        provider: "linear",
        status: "dead_lettered",
        attempt_count: 1,
        next_attempt_at: null,
        last_error: "Writeback payload schema validation failed",
        provider_result_json: null,
        correlation_id: "corr_s",
        created_at: "2026-05-13T11:00:00.000Z",
        updated_at: "2026-05-13T11:00:01.000Z",
        completed_at: "2026-05-13T11:00:01.000Z",
      },
    ]);
    const res = await handleListWritebacks(
      context,
      new Request("https://example.com/writeback?state=dead"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<Record<string, unknown>>;
    };
    expect(body.items).toHaveLength(2);
    expect((body.items[0].error as Record<string, unknown>).code).toBe(
      "timeout",
    );
    expect((body.items[1].error as Record<string, unknown>).code).toBe(
      "schema_violation",
    );
    expect(body.items[0].state).toBe("dead");
  });

  it("classifies 5xx and 429 as provider_5xx_exhausted", async () => {
    const baseRow = {
      op_id: "op_x",
      path: "/notion/pages/abc/page.md",
      revision: "rev_x",
      action: "file_upsert",
      provider: "notion",
      status: "dead_lettered",
      attempt_count: 4,
      next_attempt_at: null,
      last_error: "upstream error",
      correlation_id: "corr_x",
      created_at: "2026-05-13T09:00:00.000Z",
      updated_at: "2026-05-13T09:05:00.000Z",
      completed_at: "2026-05-13T09:05:00.000Z",
    };
    const { context } = createContext([
      {
        ...baseRow,
        op_id: "op_503",
        provider_result_json: JSON.stringify({ status: 503 }),
      },
      {
        ...baseRow,
        op_id: "op_429",
        provider_result_json: JSON.stringify({ status: 429 }),
      },
    ]);
    const res = await handleListWritebacks(
      context,
      new Request("https://example.com/writeback?state=dead"),
    );
    const body = (await res.json()) as {
      items: Array<Record<string, unknown>>;
    };
    expect((body.items[0].error as Record<string, unknown>).code).toBe(
      "provider_5xx_exhausted",
    );
    expect((body.items[1].error as Record<string, unknown>).code).toBe(
      "provider_5xx_exhausted",
    );
  });
});
