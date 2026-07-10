import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  bulkWrite,
  handleGetChangeResourceGet,
  handleWriteFile,
  listChanges,
  listEvents,
  listTree,
  readFile,
  type WorkspaceFsContext,
} from "../src/durable-objects/handlers/fs.js";
import {
  base64DecodedSize,
  hashContent,
} from "../src/durable-objects/content-hash.js";
import type { TokenClaims } from "../src/middleware/auth.js";
import type { WorkspaceEvent, WorkspaceFile } from "../src/types.js";

// Tests for the contentHash field added to fs/file, fs/tree, and fs/events
// responses. This is what activates the daemon-side defensive cross-check
// from relayfile PR #90 (dormant until cloud emits contentHash).

function createClaims(): TokenClaims {
  return {
    workspaceId: "ws_123",
    agentName: "test-agent",
    scopes: new Set(["fs:write"]),
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf-8").digest("hex");
}

function createWriteRequest(body: Record<string, unknown>): Request {
  // Content-Length is mandatory on the JSON write path (411 otherwise).
  const serialized = JSON.stringify(body);
  const byteLength = new TextEncoder().encode(serialized).byteLength;
  return new Request(
    "https://relayfile.test/v1/workspaces/ws_123/fs/file?path=/notes/readme.md",
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(byteLength),
        "If-Match": "0",
        "X-Correlation-Id": "corr_123",
      },
      body: serialized,
    },
  );
}

function makeFile(overrides: Partial<WorkspaceFile> = {}): WorkspaceFile {
  return {
    path: "/notes/readme.md",
    revision: "rev_42",
    contentType: "text/markdown",
    contentRef: "content/ws_123/notes/readme.md/rev_42",
    size: 11,
    encoding: "utf-8",
    provider: "notion",
    providerObjectId: "obj_42",
    updatedAt: "2026-05-06T00:00:00.000Z",
    semanticsJson: "{}",
    contentHash: sha256Hex("# updated\n"),
    ...overrides,
  };
}

function makeEvent(overrides: Partial<WorkspaceEvent> = {}): WorkspaceEvent {
  return {
    eventId: "evt_1",
    type: "file.updated",
    path: "/notes/readme.md",
    revision: "rev_42",
    origin: "agent_write",
    provider: "notion",
    correlationId: "corr_123",
    timestamp: "2026-05-06T00:00:00.000Z",
    contentHash: sha256Hex("# updated\n"),
    ...overrides,
  };
}

function createBaseContext(
  overrides: Record<string, unknown> = {},
): WorkspaceFsContext {
  return {
    errors: {
      invalidInput: { status: 400, code: "invalid_input", message: "invalid" },
      notFound: { status: 404, code: "not_found", message: "not found" },
      preconditionFailed: {
        status: 412,
        code: "precondition_failed",
        message: "missing If-Match header",
      },
      revisionConflict: {
        status: 409,
        code: "revision_conflict",
        message: "revision conflict",
      },
      payloadTooLarge: {
        status: 413,
        code: "payload_too_large",
        message: "payload too large",
      },
      badRequest: { status: 400, code: "bad_request", message: "bad request" },
    },
    readJson: async <T>(request: Request) => (await request.json()) as T,
    resolveWorkspaceId: async () => "ws_123",
    getRequestClaims: async () => createClaims(),
    json: (payload: unknown, status = 200, headers?: HeadersInit) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: {
          "Content-Type": "application/json",
          ...(headers ?? {}),
        },
      }),
    errorResponse: (
      _request: Request,
      status: number,
      code: string,
      message: string,
      details?: Record<string, unknown>,
    ) =>
      new Response(JSON.stringify({ code, message, ...(details ?? {}) }), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    correlationId: () => "corr_123",
    dedupKv: undefined,
    putObject: vi.fn(async () => undefined),
    deleteContent: vi.fn(),
    contentRef: () => "content/ws_123/notes/readme.md/rev_42",
    recordMutation: vi.fn(async () => ({
      opId: "op_1",
      status: "queued" as const,
      targetRevision: "rev_42",
    })),
    syncWorkspaceStats: vi.fn(async () => undefined),
    touchWorkspaceActivity: vi.fn(async () => undefined),
    allRows: vi.fn(() => []),
    sqlExec: vi.fn(),
    getFileRow: vi.fn(() => null),
    getOperation: vi.fn(() => null),
    insertEvent: vi.fn(),
    loadContent: vi.fn(async () => "# updated\n"),
    nextId: vi.fn(() => "rev_42"),
    toWorkspaceFile: vi.fn((row) => row as unknown as WorkspaceFile),
    toEvent: vi.fn((row) => row as unknown as WorkspaceEvent),
    toWorkspaceOperation: vi.fn(),
    // Digest regeneration is deferred to the DO alarm (cloud#846). Fixtures
    // expose a spy so individual tests can assert the deferred schedule.
    scheduleDigestRefresh: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as WorkspaceFsContext;
}

describe("hashContent", () => {
  it("matches Node's SHA-256 for utf-8 content", async () => {
    const content = "# updated\n";
    const expected = createHash("sha256").update(content).digest("hex");
    expect(await hashContent(content, "utf-8")).toBe(expected);
  });

  it.each([
    ["empty", ""],
    ["ascii", "plain ascii content\n"],
    ["latin-1", "café déjà vu"],
    ["large ascii", "a".repeat(140 * 1024)],
    ["astral at first old chunk boundary", `${"a".repeat(64 * 1024 - 1)}😀x`],
    ["astral at second old chunk boundary", `${"a".repeat(128 * 1024 - 1)}😀x`],
  ])("preserves old utf-8 hash parity for %s", async (_name, content) => {
    const expected = createHash("sha256")
      .update(content, "utf-8")
      .digest("hex");
    expect(await hashContent(content, "utf-8")).toBe(expected);
  });

  it("preserves utf-8 hash parity when an astral character crosses the old chunk boundary", async () => {
    const content = `${"a".repeat(64 * 1024 - 1)}😀${"b".repeat(8)}`;
    const expected = createHash("sha256")
      .update(content, "utf-8")
      .digest("hex");
    expect(await hashContent(content, "utf-8")).toBe(expected);
  });

  it("hashes the raw bytes for base64 content (matches daemon hashBytes)", async () => {
    const raw = Buffer.from([0x00, 0x01, 0x02, 0xff]);
    const base64 = raw.toString("base64");
    const expected = createHash("sha256").update(raw).digest("hex");
    expect(await hashContent(base64, "base64")).toBe(expected);
  });

  it("matches whole-buffer base64 hashing when the input contains whitespace", async () => {
    const raw = Buffer.from([0x00, 0x01, 0x02, 0xff, 0x7f, 0x80]);
    const wrapped = `${raw.toString("base64").slice(0, 4)}\n ${raw
      .toString("base64")
      .slice(4)}\t`;
    const expected = createHash("sha256")
      .update(Buffer.from(wrapped, "base64"))
      .digest("hex");
    expect(await hashContent(wrapped, "base64")).toBe(expected);
  });

  it.each([
    ["empty", ""],
    ["single byte padded", Buffer.from([0x4d]).toString("base64")],
    [
      "single byte unpadded",
      Buffer.from([0x4d]).toString("base64").replace(/=+$/u, ""),
    ],
    ["two bytes padded", Buffer.from([0x4d, 0x61]).toString("base64")],
    ["three bytes", Buffer.from([0x4d, 0x61, 0x6e]).toString("base64")],
    [
      "binary",
      Buffer.from([0x00, 0x01, 0x02, 0x7f, 0x80, 0xff]).toString("base64"),
    ],
    [
      "large binary",
      Buffer.from(
        Uint8Array.from(
          { length: 96 * 1024 },
          (_value, index) => (index * 31) & 0xff,
        ),
      ).toString("base64"),
    ],
    [
      "whitespace wrapped",
      Buffer.from([0x00, 0x01, 0x02, 0xff, 0x7f, 0x80])
        .toString("base64")
        .replace(/(.{4})/gu, "$1 \n\t"),
    ],
  ])("preserves old base64 hash parity for %s", async (_name, content) => {
    const expected = createHash("sha256")
      .update(Buffer.from(content, "base64"))
      .digest("hex");
    expect(await hashContent(content, "base64")).toBe(expected);
  });

  it.each(["", "TQ==", "TQ", "TWE=", "TWFu", "T W\nF\tu\r"])(
    "computes decoded base64 size without decoding the whole body for %j",
    (input) => {
      expect(base64DecodedSize(input)).toBe(atob(input).length);
    },
  );
});

describe("handleWriteFile content hash", () => {
  it("persists SHA-256 hex of the content on the files row INSERT", async () => {
    const sqlExec = vi.fn();
    const recordMutation = vi.fn(async () => ({
      opId: "op_1",
      status: "queued" as const,
      targetRevision: "rev_42",
    }));
    let rowWritten = false;
    const context = createBaseContext({
      sqlExec: vi.fn((...args: unknown[]) => {
        sqlExec(...args);
        rowWritten = true;
      }),
      recordMutation,
      getFileRow: vi.fn(() => (rowWritten ? makeFile() : null)),
    });

    const content = "# updated\n";
    const response = await handleWriteFile(
      context,
      createWriteRequest({ content, contentType: "text/markdown" }),
    );

    expect(response.status).toBe(202);
    const args = sqlExec.mock.calls.find(
      (call) => call[1] === "/notes/readme.md",
    );
    expect(args).toBeDefined();
    if (!args) return;
    const sql = args[0] as string;
    expect(sql).toContain("content_hash");
    // Last bound parameter is the contentHash. The INSERT shape is fixed at
    // 11 placeholders ending with content_hash.
    const lastBinding = args[args.length - 1] as string;
    expect(lastBinding).toBe(sha256Hex(content));
  });

  it("schedules a deferred digest refresh after a file write (no inline /digests/* writes — cloud#846)", async () => {
    // Pre-cloud#846 the write path synchronously regenerated every default
    // digest window before returning 202 — multi-window × thousands of
    // events × per-event R2 reads — which made writes time out at 60s on
    // any busy workspace. This test now asserts the new contract: the
    // write returns 202 WITHOUT touching /digests/*, and the DO is asked
    // to run a debounced refresh on its alarm instead.
    const putObject = vi.fn(async () => undefined);
    const scheduleDigestRefresh = vi.fn(async () => undefined);
    let rowWritten = false;
    const context = createBaseContext({
      putObject,
      scheduleDigestRefresh,
      contentRef: (_workspaceId: string, path: string, revision: string) =>
        `${path}@${revision}`,
      sqlExec: vi.fn((query: string, path: string) => {
        if (
          query.includes("INSERT INTO files") &&
          path === "/notes/readme.md"
        ) {
          rowWritten = true;
        }
      }),
      getFileRow: vi.fn((path: string) =>
        rowWritten && path === "/notes/readme.md"
          ? makeFile({
              path,
              contentRef: `${path}@rev_42`,
            })
          : null,
      ),
    });

    const response = await handleWriteFile(
      context,
      createWriteRequest({
        content: JSON.stringify({ state: "closed" }),
        contentType: "application/json",
      }),
    );

    expect(response.status).toBe(202);

    // No inline digest writes leaked into the synchronous path.
    const writtenPaths = putObject.mock.calls.map(
      (call) => (call as unknown[])[5],
    );
    expect(
      writtenPaths.filter((p) => String(p).startsWith("/digests/")),
    ).toEqual([]);

    // The deferred refresh WAS scheduled, exactly once, naming the path
    // whose write triggered it. (The actual `refreshWorkspaceDigests` call
    // is covered by digest.test.ts, which exercises the refresh function
    // directly without going through the write path.)
    expect(scheduleDigestRefresh).toHaveBeenCalledTimes(1);
    expect(scheduleDigestRefresh).toHaveBeenCalledWith(
      expect.objectContaining({ changedPaths: ["/notes/readme.md"] }),
    );
  });

  it("still returns 202 when deferred digest scheduling fails after the file write", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      let rowWritten = false;
      const recordMutation = vi.fn(async () => ({
        opId: "op_1",
        status: "queued" as const,
        targetRevision: "rev_42",
      }));
      const scheduleDigestRefresh = vi.fn(async () => {
        throw new Error("alarm storage unavailable");
      });
      const context = createBaseContext({
        recordMutation,
        scheduleDigestRefresh,
        sqlExec: vi.fn((query: string, path: string) => {
          if (
            query.includes("INSERT INTO files") &&
            path === "/notes/readme.md"
          ) {
            rowWritten = true;
          }
        }),
        getFileRow: vi.fn((path: string) =>
          rowWritten && path === "/notes/readme.md" ? makeFile({ path }) : null,
        ),
      });

      const response = await handleWriteFile(
        context,
        createWriteRequest({
          content: "# updated\n",
          contentType: "text/markdown",
        }),
      );

      expect(response.status).toBe(202);
      expect(recordMutation).toHaveBeenCalledOnce();
      expect(scheduleDigestRefresh).toHaveBeenCalledOnce();
      expect(consoleError).toHaveBeenCalledWith(
        "maybeRefreshWorkspaceDigests: schedule failed",
        expect.any(Error),
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("bulkWrite content hash", () => {
  it("computes contentHash per file and binds it on the INSERT", async () => {
    const sqlExec = vi.fn();
    const recordMutation = vi.fn(async () => ({
      opId: "op_1",
      status: "queued" as const,
      targetRevision: "rev_42",
    }));
    const context = createBaseContext({ sqlExec, recordMutation });

    await bulkWrite(
      context,
      "ws_123",
      [
        {
          path: "/a.md",
          contentType: "text/markdown",
          content: "alpha\n",
        },
        {
          path: "/b.md",
          contentType: "text/markdown",
          content: "beta\n",
        },
      ],
      "corr_bulk",
      createClaims(),
    );

    expect(sqlExec).toHaveBeenCalledTimes(2);
    const firstHash = sqlExec.mock.calls[0]![sqlExec.mock.calls[0]!.length - 1];
    const secondHash =
      sqlExec.mock.calls[1]![sqlExec.mock.calls[1]!.length - 1];
    expect(firstHash).toBe(sha256Hex("alpha\n"));
    expect(secondHash).toBe(sha256Hex("beta\n"));
  });
});

describe("readFile contentHash", () => {
  it("surfaces contentHash on the FileReadResponse when the row has one", async () => {
    const file = makeFile();
    const context = createBaseContext({
      getFileRow: vi.fn(() => file),
      loadContent: vi.fn(async () => "# updated\n"),
    });

    const response = await readFile(context, file.path);
    expect(response).toMatchObject({
      path: file.path,
      revision: file.revision,
      contentHash: sha256Hex("# updated\n"),
    });
  });

  it("omits contentHash for legacy rows whose contentHash is empty", async () => {
    const file = makeFile({ contentHash: "" });
    const context = createBaseContext({
      getFileRow: vi.fn(() => file),
    });
    const response = await readFile(context, file.path);
    expect(response && "contentHash" in response).toBe(false);
  });
});

describe("listTree contentHash", () => {
  it("emits contentHash on every file entry when the row has one", () => {
    const file = makeFile();
    const context = createBaseContext({
      allRows: vi.fn(() => [
        { ...file, content_hash: file.contentHash } as unknown as Record<
          string,
          unknown
        >,
      ]),
      toWorkspaceFile: vi.fn(() => file),
      // listTree mixes coreListTree's directory walk + our SQL row data,
      // so we need a no-op file row too.
      getFileRow: vi.fn(() => file),
    });

    const result = listTree(context, "ws_123", "/", 2, null, createClaims());
    const entry = result.entries.find((e) => e.path === file.path);
    expect(entry).toBeDefined();
    if (entry && entry.type === "file") {
      const tagged = entry as typeof entry & { contentHash?: string };
      expect(tagged.contentHash).toBe(sha256Hex("# updated\n"));
    }
  });
});

describe("listEvents contentHash", () => {
  it("includes contentHash on file events when present in the events row", () => {
    const event = makeEvent();
    const context = createBaseContext({
      allRows: vi.fn(() => [
        {
          event_id: event.eventId,
          type: event.type,
          path: event.path,
          revision: event.revision,
          origin: event.origin,
          provider: event.provider,
          correlation_id: event.correlationId,
          timestamp: event.timestamp,
          content_hash: event.contentHash,
        } as Record<string, unknown>,
      ]),
      toEvent: vi.fn(() => event),
    });

    const response = listEvents(context, "ws_123");
    expect(response.events).toHaveLength(1);
    const tagged = response.events[0] as (typeof response.events)[number] & {
      contentHash?: string;
    };
    expect(tagged.contentHash).toBe(sha256Hex("# updated\n"));
  });

  it("omits contentHash for delete events and sync.* events", () => {
    const deleteEvent = makeEvent({
      type: "file.deleted",
      contentHash: "",
    });
    const syncEvent = makeEvent({
      eventId: "evt_2",
      type: "sync.error",
      contentHash: "",
    });
    const context = createBaseContext({
      allRows: vi.fn(() => [
        {
          event_id: deleteEvent.eventId,
          type: deleteEvent.type,
          path: deleteEvent.path,
          revision: deleteEvent.revision,
          origin: deleteEvent.origin,
          provider: deleteEvent.provider,
          correlation_id: deleteEvent.correlationId,
          timestamp: deleteEvent.timestamp,
          content_hash: "",
        } as Record<string, unknown>,
        {
          event_id: syncEvent.eventId,
          type: syncEvent.type,
          path: syncEvent.path,
          revision: syncEvent.revision,
          origin: syncEvent.origin,
          provider: syncEvent.provider,
          correlation_id: syncEvent.correlationId,
          timestamp: syncEvent.timestamp,
          content_hash: "",
        } as Record<string, unknown>,
      ]),
      toEvent: vi.fn((row) => {
        const data = row as Record<string, unknown>;
        return {
          eventId: data.event_id as string,
          type: data.type as WorkspaceEvent["type"],
          path: data.path as string,
          revision: data.revision as string,
          origin: data.origin as WorkspaceEvent["origin"],
          provider: data.provider as string,
          correlationId: data.correlation_id as string,
          timestamp: data.timestamp as string,
          contentHash: data.content_hash as string,
        };
      }),
    });

    const response = listEvents(context, "ws_123");
    expect(response.events).toHaveLength(2);
    for (const event of response.events) {
      expect("contentHash" in event).toBe(false);
    }
  });
});

describe("listEvents forward cursor semantics", () => {
  // Regression guard for the silent mirror-freeze bug: the daemon treats the
  // cursor as a forward watermark and expects each page to return events
  // *newer* than it, oldest-first. A DESC / "events older than cursor" feed
  // made resolveLatestEventCursor seed the oldest event, after which every
  // incremental probe asked for events before it and got nothing — so new
  // provider records never reached the local mirror.
  function rowFor(event: WorkspaceEvent): Record<string, unknown> {
    return {
      event_id: event.eventId,
      type: event.type,
      path: event.path,
      revision: event.revision,
      origin: event.origin,
      provider: event.provider,
      correlation_id: event.correlationId,
      timestamp: event.timestamp,
      content_hash: event.contentHash,
    };
  }

  function passthroughToEvent() {
    return vi.fn((row) => {
      const data = row as Record<string, unknown>;
      return {
        eventId: data.event_id as string,
        type: data.type as WorkspaceEvent["type"],
        path: data.path as string,
        revision: data.revision as string,
        origin: data.origin as WorkspaceEvent["origin"],
        provider: data.provider as string,
        correlationId: data.correlation_id as string,
        timestamp: data.timestamp as string,
        contentHash: data.content_hash as string,
      };
    });
  }

  it("orders the feed ascending and pages events newer than the cursor", () => {
    const older = makeEvent({
      eventId: "evt_10",
      timestamp: "2026-05-06T00:00:00.000Z",
    });
    const newerA = makeEvent({
      eventId: "evt_11",
      timestamp: "2026-05-06T00:01:00.000Z",
    });
    const newerB = makeEvent({
      eventId: "evt_12",
      timestamp: "2026-05-06T00:02:00.000Z",
    });

    const seenSql: string[] = [];
    const allRows = vi.fn((sql: string, ..._bindings: unknown[]) => {
      seenSql.push(sql);
      if (
        sql.includes("SELECT timestamp, event_id FROM events WHERE event_id")
      ) {
        // Resolve the cursor's (timestamp, event_id).
        return [{ timestamp: older.timestamp, event_id: older.eventId }];
      }
      if (sql.includes("FROM events") && sql.includes("ORDER BY")) {
        // The real ASC query returns rows oldest-first; the mock mirrors that.
        return [rowFor(newerA), rowFor(newerB)];
      }
      return [];
    });

    const context = createBaseContext({
      allRows,
      toEvent: passthroughToEvent(),
    });

    const response = listEvents(context, "ws_123", undefined, "evt_10", 200);

    const mainQuery = seenSql.find(
      (sql) => sql.includes("FROM events") && sql.includes("ORDER BY"),
    );
    expect(mainQuery).toBeDefined();
    // Forward feed: ascending order, and the cursor predicate selects events
    // STRICTLY NEWER than the cursor (a regression to `<`/DESC refreezes the
    // mirror).
    expect(mainQuery).toContain(
      "ORDER BY timestamp ASC, CAST(SUBSTR(event_id, 5) AS INTEGER) ASC",
    );
    expect(mainQuery).toContain("timestamp > ?");
    expect(mainQuery).not.toContain("timestamp < ?");
    expect(mainQuery).not.toContain("ORDER BY timestamp DESC");

    // Returned oldest-first; nextCursor (no more pages here) is null.
    expect(response.events.map((e) => e.eventId)).toEqual(["evt_11", "evt_12"]);
    expect(response.nextCursor).toBeNull();
  });

  it("returns the newest event of the page as nextCursor when more remain", () => {
    const newerA = makeEvent({
      eventId: "evt_11",
      timestamp: "2026-05-06T00:01:00.000Z",
    });
    const newerB = makeEvent({
      eventId: "evt_12",
      timestamp: "2026-05-06T00:02:00.000Z",
    });

    const context = createBaseContext({
      // limit=1 so the handler fetches limit+1 (=2) rows and reports hasMore.
      allRows: vi.fn((sql: string) =>
        sql.includes("ORDER BY") ? [rowFor(newerA), rowFor(newerB)] : [],
      ),
      toEvent: passthroughToEvent(),
    });

    const response = listEvents(context, "ws_123", undefined, null, 1);
    expect(response.events.map((e) => e.eventId)).toEqual(["evt_11"]);
    // Forward paging: advance from the newest event seen on this page.
    expect(response.nextCursor).toBe("evt_11");
  });

  it("can query the latest event without walking the feed", () => {
    const older = makeEvent({
      eventId: "evt_11",
      timestamp: "2026-05-06T00:01:00.000Z",
    });
    const latest = makeEvent({
      eventId: "evt_12",
      timestamp: "2026-05-06T00:02:00.000Z",
    });

    const seenSql: string[] = [];
    const allRows = vi.fn((sql: string) => {
      seenSql.push(sql);
      if (sql.includes("FROM events") && sql.includes("ORDER BY")) {
        // The real DESC query returns newest-first; the mock mirrors that.
        return [rowFor(latest), rowFor(older)];
      }
      return [];
    });

    const context = createBaseContext({
      allRows,
      toEvent: passthroughToEvent(),
    });

    const response = listEvents(context, "ws_123", undefined, null, 1, "desc");

    expect(allRows).toHaveBeenCalledTimes(1);
    const mainQuery = seenSql.find(
      (sql) => sql.includes("FROM events") && sql.includes("ORDER BY"),
    );
    expect(mainQuery).toBeDefined();
    expect(mainQuery).toContain(
      "ORDER BY timestamp DESC, CAST(SUBSTR(event_id, 5) AS INTEGER) DESC",
    );
    expect(response.events.map((e) => e.eventId)).toEqual(["evt_12"]);
    expect(response.nextCursor).toBe("evt_12");
  });

  it("lists last N changes as SDK-compatible newest change envelopes", () => {
    const older = makeEvent({
      eventId: "evt_11",
      path: "/github/issues/old.json",
      provider: "github",
      timestamp: "2026-05-06T00:01:00.000Z",
      revision: "rev_11",
    });
    const latest = makeEvent({
      eventId: "evt_12",
      path: "/github/issues/new.json",
      provider: "github",
      timestamp: "2026-05-06T00:02:00.000Z",
      revision: "rev_12",
    });

    const seenSql: string[] = [];
    const context = createBaseContext({
      allRows: vi.fn((sql: string) => {
        seenSql.push(sql);
        if (sql.includes("FROM events") && sql.includes("ORDER BY")) {
          return [rowFor(latest), rowFor(older)];
        }
        return [];
      }),
      toEvent: passthroughToEvent(),
    });

    const changes = listChanges(context, "rw_7ccfea89", {
      last: true,
      limit: 2,
    });

    const mainQuery = seenSql.find(
      (sql) => sql.includes("FROM events") && sql.includes("ORDER BY"),
    );
    expect(mainQuery).toContain(
      "ORDER BY timestamp DESC, CAST(SUBSTR(event_id, 5) AS INTEGER) DESC",
    );
    expect(changes.map((event) => event.id)).toEqual(["evt_11", "evt_12"]);
    expect(changes[1]).toMatchObject({
      id: "evt_12",
      workspace: "rw_7ccfea89",
      type: "relayfile.changed",
      occurredAt: "2026-05-06T00:02:00.000Z",
      resource: {
        path: "/github/issues/new.json",
        kind: "github.issue",
        id: "new",
        provider: "github",
      },
      summary: {
        title: "new",
        fieldsChanged: ["file.updated"],
      },
      digest: `sha256:${latest.contentHash}`,
    });
  });

  it("returns an empty change feed for an empty workspace", () => {
    const context = createBaseContext({
      allRows: vi.fn(() => []),
      toEvent: passthroughToEvent(),
    });

    expect(
      listChanges(context, "rw_7ccfea89", { last: true, limit: 100 }),
    ).toEqual([]);
  });

  it("rejects resource hydration when event path is outside the token scope", async () => {
    const secretEvent = makeEvent({
      eventId: "evt_secret",
      path: "/secret/file.md",
    });
    const loadContent = vi.fn(async () => "secret");
    const context = createBaseContext({
      allRows: vi.fn((sql: string) =>
        sql.includes("WHERE event_id = ?") ? [rowFor(secretEvent)] : [],
      ),
      getRequestClaims: async () => ({
        workspaceId: "ws_123",
        agentName: "scoped-agent",
        scopes: new Set(["relayfile:fs:read:/allowed/**"]),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
      loadContent,
      toEvent: passthroughToEvent(),
    });

    const response = await handleGetChangeResourceGet(
      context,
      new Request(
        "https://relayfile.test/v1/workspaces/ws_123/fs/changes/resource?eventId=evt_secret",
      ),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "forbidden",
      message: "missing required scope: fs:read",
    });
    expect(loadContent).not.toHaveBeenCalled();
  });
});
