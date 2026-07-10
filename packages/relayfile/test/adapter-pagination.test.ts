import { describe, expect, it, vi } from "vitest";
import {
  createCoreStorageAdapter,
  iterateWorkspaceFilesForExport,
} from "../src/durable-objects/adapter.js";
import { RUNTIME_FILES } from "../src/durable-objects/runtime-files.js";

const RUNTIME_PATHS = RUNTIME_FILES.map((file) => file.path);

describe("createCoreStorageAdapter pagination filters", () => {
  it("pushes operation status/provider/action filters into SQL before LIMIT", () => {
    const allRows = vi.fn(
      <T extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        ...bindings: unknown[]
      ): T[] => {
        if (sql.includes("FROM operations") && sql.includes("ORDER BY")) {
          expect(sql).toContain("status = ?");
          expect(sql).toContain("action = ?");
          expect(sql).toContain("provider = ?");
          expect(sql).toContain("LIMIT ?");
          expect(bindings).toEqual(["failed", "file_upsert", "github", 3]);
          return [
            {
              op_id: "op_old",
              path: "/github/issues/1.json",
              revision: "rev_1",
              action: "file_upsert",
              provider: "github",
              status: "failed",
              attempt_count: 1,
              next_attempt_at: null,
              last_error: "failed",
              provider_result_json: null,
              correlation_id: "corr",
              created_at: "2026-05-01T00:00:00.000Z",
              updated_at: "2026-05-01T00:00:00.000Z",
              completed_at: null,
            },
          ] as unknown as T[];
        }
        return [];
      },
    );
    const adapter = createCoreStorageAdapter(
      {
        allRows: allRows as never,
        sqlExec: vi.fn(),
        getFileRow: vi.fn(),
        getOperation: vi.fn(),
        insertEvent: vi.fn(),
        loadContent: vi.fn(),
        nextId: vi.fn(),
        toWorkspaceFile: vi.fn(),
        toEvent: vi.fn(),
        toWorkspaceOperation: (row) => ({
          opId: String(row.op_id),
          path: String(row.path),
          revision: String(row.revision),
          action: row.action as "file_upsert",
          provider: String(row.provider),
          status: row.status as "failed",
          attemptCount: Number(row.attempt_count),
          nextAttemptAt: row.next_attempt_at as string | null,
          lastError: row.last_error as string | null,
          providerResultJson: row.provider_result_json as string | null,
          correlationId: String(row.correlation_id),
          createdAt: String(row.created_at),
          updatedAt: String(row.updated_at),
          completedAt: row.completed_at as string | null,
        }),
      },
      "ws_test",
    );

    const result = adapter.listOperations({
      status: "failed",
      action: "file_upsert",
      provider: "github",
      limit: 2,
    });
    expect(result.items.map((item) => item.opId)).toEqual(["op_old"]);
  });

  it("ignores an event cursor from a different provider", () => {
    const allRows = vi.fn(
      <T extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        ...bindings: unknown[]
      ): T[] => {
        if (sql.includes("SELECT timestamp, event_id FROM events")) {
          expect(sql).toContain("AND provider = ?");
          expect(bindings).toEqual(["evt_github", "notion"]);
          return [];
        }
        if (sql.includes("FROM events") && sql.includes("ORDER BY")) {
          expect(bindings).toEqual(["notion", 3]);
          return [
            {
              event_id: "evt_notion_new",
              type: "file.updated",
              path: "/notion/a.json",
              revision: "rev_1",
              origin: "provider",
              provider: "notion",
              correlation_id: "corr",
              timestamp: "2026-05-01T00:00:00.000Z",
              content_hash: "",
            },
          ] as unknown as T[];
        }
        return [];
      },
    );
    const adapter = createCoreStorageAdapter(
      {
        allRows: allRows as never,
        sqlExec: vi.fn(),
        getFileRow: vi.fn(),
        getOperation: vi.fn(),
        insertEvent: vi.fn(),
        loadContent: vi.fn(),
        nextId: vi.fn(),
        toWorkspaceFile: vi.fn(),
        toWorkspaceOperation: vi.fn(),
        toEvent: (row) => ({
          eventId: String(row.event_id),
          type: row.type as "file.updated",
          path: String(row.path),
          revision: String(row.revision),
          origin: "provider_sync",
          provider: String(row.provider),
          correlationId: String(row.correlation_id),
          timestamp: String(row.timestamp),
          contentHash: String(row.content_hash),
        }),
      },
      "ws_test",
    );

    const result = adapter.listEvents({
      provider: "notion",
      cursor: "evt_github",
      limit: 2,
    });
    expect(result.items.map((item) => item.eventId)).toEqual([
      "evt_notion_new",
    ]);
  });

  it("seeks the event cursor by numeric suffix so unpadded ids don't strand same-ms events (receipt-loss regression)", () => {
    // Cursor `evt_99` and a same-millisecond `evt_100` (e.g. a Slack writeback
    // receipt). Lexically `evt_100` < `evt_99`, so a `event_id > 'evt_99'` seek
    // would never return it and the cursor would never move back — the receipt is
    // lost forever and post() can't thread. The fix seeks on the numeric suffix.
    const allRows = vi.fn(
      <T extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        ...bindings: unknown[]
      ): T[] => {
        if (sql.includes("SELECT timestamp, event_id FROM events")) {
          return [
            { timestamp: "2026-05-01T00:00:00.000Z", event_id: "evt_99" },
          ] as unknown as T[];
        }
        if (sql.includes("FROM events") && sql.includes("ORDER BY")) {
          // numeric-suffix seek + sort, and the cursor is bound as the integer 99
          expect(sql).toContain("CAST(SUBSTR(event_id, 5) AS INTEGER) > ?");
          expect(sql).toContain(
            "CAST(SUBSTR(event_id, 5) AS INTEGER) ASC",
          );
          expect(sql).not.toContain("event_id > ?");
          expect(bindings).toContain(99);
          expect(bindings).not.toContain("evt_99");
          return [
            {
              event_id: "evt_100",
              type: "file.updated",
              path: "/slack/channels/C0/messages/m.json",
              revision: "rev_1",
              origin: "system",
              provider: "slack",
              correlation_id: "corr",
              timestamp: "2026-05-01T00:00:00.000Z",
              content_hash: "",
            },
          ] as unknown as T[];
        }
        return [];
      },
    );
    const adapter = createCoreStorageAdapter(
      {
        allRows: allRows as never,
        sqlExec: vi.fn(),
        getFileRow: vi.fn(),
        getOperation: vi.fn(),
        insertEvent: vi.fn(),
        loadContent: vi.fn(),
        nextId: vi.fn(),
        toWorkspaceFile: vi.fn(),
        toWorkspaceOperation: vi.fn(),
        toEvent: (row) => ({
          eventId: String(row.event_id),
          type: row.type as "file.updated",
          path: String(row.path),
          revision: String(row.revision),
          origin: "system",
          provider: String(row.provider),
          correlationId: String(row.correlation_id),
          timestamp: String(row.timestamp),
          contentHash: String(row.content_hash),
        }),
      },
      "ws_test",
    );

    const result = adapter.listEvents({
      provider: "slack",
      cursor: "evt_99",
      limit: 2,
    });
    expect(result.items.map((item) => item.eventId)).toEqual(["evt_100"]);
  });
});

describe("iterateWorkspaceFilesForExport", () => {
  it("clamps pageSize=0 instead of returning an empty export", async () => {
    const rows = [
      {
        path: "/a.md",
        revision: "rev_1",
        content_type: "text/markdown",
        content_ref: "ref-a",
        size: 5,
        encoding: "utf-8",
        updated_at: "2026-05-01T00:00:00.000Z",
        semantics_json: "{}",
        provider: "notion",
        provider_object_id: "obj-a",
        content_hash: "",
      },
      {
        path: "/b.md",
        revision: "rev_1",
        content_type: "text/markdown",
        content_ref: "ref-b",
        size: 4,
        encoding: "utf-8",
        updated_at: "2026-05-01T00:00:00.000Z",
        semantics_json: "{}",
        provider: "notion",
        provider_object_id: "obj-b",
        content_hash: "",
      },
    ];
    const context = {
      allRows: vi.fn(
        <T extends Record<string, unknown> = Record<string, unknown>>(
          _sql: string,
          ...bindings: unknown[]
        ): T[] => {
          const cursor =
            typeof bindings[0] === "string" ? String(bindings[0]) : null;
          const limit = Number(bindings.at(-1));
          return rows
            .filter((row) => (cursor ? row.path > cursor : true))
            .slice(0, limit) as unknown as T[];
        },
      ),
      sqlExec: vi.fn(),
      getFileRow: vi.fn(),
      getOperation: vi.fn(),
      insertEvent: vi.fn(),
      loadContent: vi.fn(async (ref: string) => `body:${ref}`),
      nextId: vi.fn(),
      toEvent: vi.fn(),
      toWorkspaceOperation: vi.fn(),
      toWorkspaceFile: vi.fn((row: (typeof rows)[number]) => ({
        path: row.path,
        revision: row.revision,
        contentType: row.content_type,
        contentRef: row.content_ref,
        size: row.size,
        encoding: row.encoding,
        updatedAt: row.updated_at,
        semanticsJson: row.semantics_json,
        provider: row.provider,
        providerObjectId: row.provider_object_id,
        contentHash: row.content_hash,
      })),
    };

    const exported = [];
    for await (const chunk of iterateWorkspaceFilesForExport(
      context as never,
      "ws_test",
      null,
      0,
    )) {
      exported.push(chunk);
    }

    expect(exported.map((chunk) => chunk.file.path)).toEqual([
      ...RUNTIME_PATHS,
      "/a.md",
      "/b.md",
    ]);
    expect(exported[0]?.content).toContain("/digests/today.md");
    expect(context.loadContent).toHaveBeenCalledTimes(2);
  });
});
