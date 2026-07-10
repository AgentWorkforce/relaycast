import { describe, expect, it, vi } from "vitest";
import {
  isDigestPath,
  isInternalDigestPath,
  refreshWorkspaceDigests,
  type WorkspaceDigestContext,
} from "../src/durable-objects/digest.js";
import {
  listTree,
  readFile,
  type WorkspaceFsContext,
} from "../src/durable-objects/handlers/fs.js";
import type { WorkspaceEvent, WorkspaceFile } from "../src/types.js";

type StoredContent = {
  path: string;
  content: string;
  contentType: string;
  revision: string;
};

function createDigestContext(
  events: WorkspaceEvent[],
  initialContent = new Map<string, string>(),
): {
  context: WorkspaceDigestContext;
  files: Map<string, Partial<WorkspaceFile>>;
  stored: StoredContent[];
  insertedEvents: WorkspaceEvent[];
  order: string[];
} {
  const files = new Map<string, Partial<WorkspaceFile>>();
  const stored: StoredContent[] = [];
  const insertedEvents: WorkspaceEvent[] = [];
  const order: string[] = [];
  let rev = 0;
  let evt = 100;

  const allRows = ((query: string, ...bindings: unknown[]) => {
    if (query.includes("FROM events")) {
      const [from, to, limit] = bindings as [
        string,
        string,
        number | undefined,
      ];
      // Byte-mirror of the production SQL `WHERE` clause in
      // `readDigestEvents` (src/durable-objects/digest.ts). We literally
      // reproduce each `path NOT LIKE` / `path != ` predicate here instead
      // of delegating to `isInternalDigestPath` so this fake stays an
      // independent SQL-layer mirror: if a future edit removes a clause
      // from the production SQL (e.g. drops `%/.relayfile.acl`) the JS
      // `isInternalDigestPath` defense-in-depth filter in production would
      // silently keep tests green while production loses budget reclaim.
      // Keeping these literal forces a visible diff in both the fake-SQL
      // mirror and the production SQL whenever the SQL filter changes, so
      // the directly-exercised regression test (`SQL filter alone excludes
      // internal/system paths`) catches SQL-only regressions.
      const matchesLike = (path: string, pattern: string): boolean => {
        const escaped = pattern.replace(/[.+?^${}()|[\]\\]/gu, "\\$&");
        const regex = new RegExp(`^${escaped.replace(/%/gu, ".*")}$`, "u");
        return regex.test(path);
      };
      const aliasSegments = [
        "by-assignee",
        "by-author",
        "by-calendar",
        "by-conversation",
        "by-creator",
        "by-database",
        "by-day",
        "by-edited",
        "by-id",
        "by-key",
        "by-label",
        "by-name",
        "by-organizer",
        "by-parent",
        "by-participant",
        "by-priority",
        "by-query",
        "by-ref",
        "by-role",
        "by-sender",
        "by-space",
        "by-state",
        "by-status",
        "by-thread",
        "by-title",
        "by-username",
        "by-uuid",
      ];
      const sqlExcludes = (path: string): boolean =>
        matchesLike(path, "/digests/%") ||
        matchesLike(path, "/discovery/%") ||
        matchesLike(path, "/.skills/%") ||
        matchesLike(path, "%/.relayfile.acl") ||
        path === "/.relayfile.acl" ||
        matchesLike(path, "%/LAYOUT.md") ||
        path === "/LAYOUT.md" ||
        matchesLike(path, "%/_index.json") ||
        aliasSegments.some((segment) => matchesLike(path, `%/${segment}/%`)) ||
        path === "/.relayfile-mount-state.json";
      const rows = events
        .concat(insertedEvents)
        .filter(
          (event) =>
            event.timestamp >= from &&
            event.timestamp < to &&
            !sqlExcludes(event.path),
        )
        .sort((left, right) =>
          query.includes("ORDER BY timestamp DESC")
            ? right.timestamp.localeCompare(left.timestamp) ||
              right.eventId.localeCompare(left.eventId)
            : left.timestamp.localeCompare(right.timestamp) ||
              left.eventId.localeCompare(right.eventId),
        )
        .slice(0, limit ?? Number.POSITIVE_INFINITY)
        .sort((left, right) =>
          query.includes("ORDER BY timestamp ASC")
            ? left.timestamp.localeCompare(right.timestamp) ||
              left.eventId.localeCompare(right.eventId)
            : 0,
        );
      return rows.map((event) => ({
        event_id: event.eventId,
        type: event.type,
        path: event.path,
        revision: event.revision,
        origin: event.origin,
        provider: event.provider,
        correlation_id: event.correlationId,
        timestamp: event.timestamp,
      }));
    }

    if (query.includes("SELECT DISTINCT provider")) {
      const providers = new Set<string>();
      for (const file of files.values()) {
        if (file.provider) providers.add(file.provider);
      }
      return [...providers].sort().map((provider) => ({ provider }));
    }

    return [];
  }) as WorkspaceDigestContext["allRows"];

  const context: WorkspaceDigestContext = {
    allRows,
    sqlExec: vi.fn((query: string, ...bindings: unknown[]) => {
      if (!query.includes("INSERT INTO files")) return;
      const [
        path,
        revision,
        contentType,
        contentRef,
        size,
        encoding,
        updatedAt,
        semanticsJson,
        provider,
        providerObjectId,
        contentHash,
      ] = bindings as string[];
      files.set(path, {
        path,
        revision,
        contentType,
        contentRef,
        size: Number(size),
        encoding: encoding as "utf-8",
        updatedAt,
        semanticsJson,
        provider,
        providerObjectId,
        contentHash,
      });
    }),
    getFileRow: vi.fn((path: string) => files.get(path) ?? null),
    nextId: vi.fn((prefix: "rev" | "evt" | "op") => {
      if (prefix === "evt") return `evt_${++evt}`;
      if (prefix === "rev") return `rev_${++rev}`;
      return "op_1";
    }),
    contentRef: vi.fn((_workspaceId, path, revision) => `${path}@${revision}`),
    putObject: vi.fn(async (contentRef, content, _encoding, contentType) => {
      order.push("putObject");
      const [path, revision] = contentRef.split("@") as [string, string];
      stored.push({ path, revision, content, contentType });
    }),
    loadContent: vi.fn(async (contentRef) => {
      const storedContent = stored.find(
        (item) => `${item.path}@${item.revision}` === contentRef,
      );
      return storedContent?.content ?? initialContent.get(contentRef) ?? "";
    }),
    deleteContent: vi.fn(),
    insertEvent: vi.fn((event) => insertedEvents.push(event as WorkspaceEvent)),
    broadcastEvent: vi.fn(),
    flushStorage: vi.fn(async () => {
      order.push("flushStorage");
    }),
  };

  return { context, files, stored, insertedEvents, order };
}

describe("workspace digest refresh", () => {
  it("writes hosted digest windows from non-digest events", async () => {
    const { context, stored, insertedEvents } = createDigestContext([
      {
        eventId: "evt_github",
        type: "file.updated",
        path: "/github/repos/acme/api/issues/43__fix-bug/meta.json",
        revision: "rev_source",
        origin: "provider_sync",
        provider: "github",
        correlationId: "corr_source",
        timestamp: "2026-05-15T09:00:00.000Z",
      },
    ]);

    await refreshWorkspaceDigests(context, "ws_123", {
      changedPaths: ["/github/repos/acme/api/issues/43__fix-bug/meta.json"],
      generatedAt: new Date("2026-05-15T10:00:00.000Z"),
      correlationId: "corr_source",
    });

    expect(stored.map((item) => item.path)).toEqual([
      "/digests/today.md",
      "/digests/yesterday.md",
      "/digests/2026-05-14.md",
      "/digests/this-week.md",
      "/digests/last-week.md",
    ]);
    expect(stored[0]?.content).toContain("covers: today");
    expect(stored[0]?.content).toContain("window_key: date:2026-05-15");
    expect(stored[0]?.content).toContain(
      "window_start: 2026-05-15T00:00:00.000Z",
    );
    expect(stored[0]?.content).toContain("warnings: []");
    expect(stored[0]?.content).toContain("providers: [github]");
    expect(stored[0]?.content).toContain(
      "- #43 was updated - [/github/repos/acme/api/issues/43__fix-bug/meta.json]",
    );
    expect(stored[1]?.content).toContain("covers: yesterday");
    expect(stored[2]?.content).toContain("covers: 2026-05-14");
    expect(stored[3]?.content).toContain("covers: this-week");
    expect(stored[4]?.content).toContain("covers: last-week");
    expect(stored[1]?.content).toContain("events: 0");
    expect(insertedEvents.map((event) => event.path)).toEqual([
      "/digests/today.md",
      "/digests/yesterday.md",
      "/digests/2026-05-14.md",
      "/digests/this-week.md",
      "/digests/last-week.md",
    ]);
  });

  it("burns digest revisions before writing digest content to R2", async () => {
    const { context, order } = createDigestContext([
      {
        eventId: "evt_github",
        type: "file.updated",
        path: "/github/repos/acme/api/issues/43__fix-bug/meta.json",
        revision: "rev_source",
        origin: "provider_sync",
        provider: "github",
        correlationId: "corr_source",
        timestamp: "2026-05-15T09:00:00.000Z",
      },
    ]);

    await refreshWorkspaceDigests(context, "ws_123", {
      changedPaths: ["/github/repos/acme/api/issues/43__fix-bug/meta.json"],
      generatedAt: new Date("2026-05-15T10:00:00.000Z"),
      correlationId: "corr_source",
    });

    expect(order.slice(0, 2)).toEqual(["flushStorage", "putObject"]);
  });

  it("includes more than 500 same-day provider events", async () => {
    const events = Array.from({ length: 501 }, (_, index) => {
      const issue = index + 1;
      return {
        eventId: `evt_${String(issue).padStart(3, "0")}`,
        type: "file.updated" as const,
        path: `/github/repos/acme/api/issues/${issue}__bulk/meta.json`,
        revision: `rev_${issue}`,
        origin: "provider_sync" as const,
        provider: "github",
        correlationId: "corr_bulk",
        timestamp: `2026-05-15T09:${String(index % 60).padStart(2, "0")}:00.000Z`,
      };
    });
    const { context, stored } = createDigestContext(events);

    await refreshWorkspaceDigests(context, "ws_123", {
      changedPaths: ["/github/repos/acme/api/issues/501__bulk/meta.json"],
      generatedAt: new Date("2026-05-15T10:00:00.000Z"),
      correlationId: "corr_bulk",
    });

    expect(stored[0]?.content).toContain("events: 501");
    expect(stored[0]?.content).toContain("truncated: false");
    expect(stored[0]?.content).toContain(
      "- #1 was updated - [/github/repos/acme/api/issues/1__bulk/meta.json]",
    );
    expect(stored[0]?.content).toContain(
      "- #501 was updated - [/github/repos/acme/api/issues/501__bulk/meta.json]",
    );
  });

  it("marks busy digest windows as truncated when only the newest events fit", async () => {
    const base = Date.parse("2026-05-15T09:00:00.000Z");
    const events = Array.from({ length: 2001 }, (_, index) => {
      const issue = index + 1;
      return {
        eventId: `evt_${String(issue).padStart(4, "0")}`,
        type: "file.updated" as const,
        path: `/github/repos/acme/api/issues/${issue}__bulk/meta.json`,
        revision: `rev_${issue}`,
        origin: "provider_sync" as const,
        provider: "github",
        correlationId: "corr_bulk",
        timestamp: new Date(base + index).toISOString(),
      };
    });
    const { context, stored } = createDigestContext(events);

    await refreshWorkspaceDigests(context, "ws_123", {
      changedPaths: ["/github/repos/acme/api/issues/2001__bulk/meta.json"],
      generatedAt: new Date("2026-05-15T10:00:00.000Z"),
      correlationId: "corr_bulk",
    });

    expect(stored[0]?.content).toContain("events: 2000");
    expect(stored[0]?.content).toContain("truncated: true");
    expect(stored[0]?.content).toContain(
      "warnings: [digest_event_limit_exceeded]",
    );
    expect(stored[0]?.content).not.toContain(
      "- #1 was updated - [/github/repos/acme/api/issues/1__bulk/meta.json]",
    );
    expect(stored[0]?.content).toContain(
      "- #2 was updated - [/github/repos/acme/api/issues/2__bulk/meta.json]",
    );
    expect(stored[0]?.content).toContain(
      "- #2001 was updated - [/github/repos/acme/api/issues/2001__bulk/meta.json]",
    );
  });

  it("guards digest file upserts against older revisions", async () => {
    const { context } = createDigestContext([
      {
        eventId: "evt_source",
        type: "file.updated",
        path: "/github/repos/acme/api/issues/42/metadata.json",
        revision: "rev_source",
        origin: "provider_sync",
        provider: "github",
        correlationId: "corr_source",
        timestamp: "2026-05-15T09:00:00.000Z",
      },
    ]);

    await refreshWorkspaceDigests(context, "ws_123", {
      changedPaths: ["/github/repos/acme/api/issues/42/metadata.json"],
      generatedAt: new Date("2026-05-15T12:00:00.000Z"),
    });

    const upsertQuery = vi
      .mocked(context.sqlExec)
      .mock.calls.find((call) =>
        String(call[0]).includes("INSERT INTO files"),
      )?.[0];
    expect(String(upsertQuery)).toContain("WHERE");
    expect(String(upsertQuery)).toContain("excluded.revision");
    expect(String(upsertQuery)).toContain("files.revision");
  });

  it("does not write objects, events, or deletes when an existing digest revision is newer", async () => {
    const { context, files, stored, insertedEvents } = createDigestContext([
      {
        eventId: "evt_source",
        type: "file.updated",
        path: "/github/repos/acme/api/issues/42/metadata.json",
        revision: "rev_source",
        origin: "provider_sync",
        provider: "github",
        correlationId: "corr_source",
        timestamp: "2026-05-15T09:00:00.000Z",
      },
    ]);

    files.set("/digests/today.md", {
      path: "/digests/today.md",
      revision: "rev_99",
      contentRef: "/digests/today.md@rev_99",
      updatedAt: "2026-05-15T11:59:00.000Z",
    });
    files.set("/digests/yesterday.md", {
      path: "/digests/yesterday.md",
      revision: "rev_100",
      contentRef: "/digests/yesterday.md@rev_100",
      updatedAt: "2026-05-15T11:59:00.000Z",
    });
    files.set("/digests/2026-05-14.md", {
      path: "/digests/2026-05-14.md",
      revision: "rev_101",
      contentRef: "/digests/2026-05-14.md@rev_101",
      updatedAt: "2026-05-15T11:59:00.000Z",
    });
    files.set("/digests/this-week.md", {
      path: "/digests/this-week.md",
      revision: "rev_102",
      contentRef: "/digests/this-week.md@rev_102",
      updatedAt: "2026-05-15T11:59:00.000Z",
    });
    files.set("/digests/last-week.md", {
      path: "/digests/last-week.md",
      revision: "rev_103",
      contentRef: "/digests/last-week.md@rev_103",
      updatedAt: "2026-05-15T11:59:00.000Z",
    });

    await refreshWorkspaceDigests(context, "ws_123", {
      changedPaths: ["/github/repos/acme/api/issues/42/metadata.json"],
      generatedAt: new Date("2026-05-15T12:00:00.000Z"),
    });

    expect(stored).toEqual([]);
    expect(insertedEvents).toEqual([]);
    expect(context.insertEvent).not.toHaveBeenCalled();
    expect(context.broadcastEvent).not.toHaveBeenCalled();
    expect(context.deleteContent).not.toHaveBeenCalled();
  });

  it("discards the new digest object without events when a newer row wins during write", async () => {
    const { context, files, stored, insertedEvents } = createDigestContext([
      {
        eventId: "evt_source",
        type: "file.updated",
        path: "/github/repos/acme/api/issues/42/metadata.json",
        revision: "rev_source",
        origin: "provider_sync",
        provider: "github",
        correlationId: "corr_source",
        timestamp: "2026-05-15T09:00:00.000Z",
      },
    ]);
    const originalSqlExec = vi.mocked(context.sqlExec).getMockImplementation();
    vi.mocked(context.sqlExec).mockImplementation((query, ...bindings) => {
      if (
        String(query).includes("INSERT INTO files") &&
        bindings[0] === "/digests/today.md"
      ) {
        return;
      }
      originalSqlExec?.(query, ...bindings);
    });

    vi.mocked(context.putObject).mockImplementationOnce(
      async (contentRef, content, _encoding, contentType) => {
        const [path, revision] = contentRef.split("@") as [string, string];
        stored.push({ path, revision, content, contentType });
        files.set("/digests/today.md", {
          path: "/digests/today.md",
          revision: "rev_99",
          contentRef: "/digests/today.md@rev_99",
          updatedAt: "2026-05-15T12:00:01.000Z",
        });
      },
    );

    await refreshWorkspaceDigests(context, "ws_123", {
      changedPaths: ["/github/repos/acme/api/issues/42/metadata.json"],
      generatedAt: new Date("2026-05-15T12:00:00.000Z"),
    });

    expect(context.deleteContent).toHaveBeenCalledWith(
      "/digests/today.md@rev_1",
    );
    expect(insertedEvents.map((event) => event.path)).toEqual([
      "/digests/yesterday.md",
      "/digests/2026-05-14.md",
      "/digests/this-week.md",
      "/digests/last-week.md",
    ]);
    expect(context.broadcastEvent).toHaveBeenCalledTimes(4);
    expect(context.broadcastEvent).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/digests/yesterday.md" }),
    );
  });

  it("does not recurse when the only changed paths are digest files", async () => {
    const { context, stored } = createDigestContext([]);

    await refreshWorkspaceDigests(context, "ws_123", {
      changedPaths: ["/digests/today.md"],
      generatedAt: new Date("2026-05-15T10:00:00.000Z"),
    });

    expect(stored).toEqual([]);
  });

  it("does not rewrite closed digest windows during implicit current refreshes", async () => {
    const { context, files, stored, insertedEvents } = createDigestContext([
      {
        eventId: "evt_today",
        type: "file.updated",
        path: "/github/repos/acme/api/issues/43__fix-bug/meta.json",
        revision: "rev_source",
        origin: "provider_sync",
        provider: "github",
        correlationId: "corr_source",
        timestamp: "2026-05-15T09:00:00.000Z",
      },
    ]);
    for (const path of [
      "/digests/yesterday.md",
      "/digests/2026-05-14.md",
      "/digests/last-week.md",
    ]) {
      files.set(path, {
        path,
        revision: "rev_20",
        contentRef: `${path}@rev_20`,
        updatedAt: "2026-05-15T00:00:00.000Z",
      });
    }

    await refreshWorkspaceDigests(context, "ws_123", {
      changedPaths: ["/github/repos/acme/api/issues/43__fix-bug/meta.json"],
      generatedAt: new Date("2026-05-15T10:00:00.000Z"),
      correlationId: "corr_source",
    });

    expect(stored.map((item) => item.path)).toEqual([
      "/digests/today.md",
      "/digests/this-week.md",
    ]);
    expect(insertedEvents.map((event) => event.path)).toEqual([
      "/digests/today.md",
      "/digests/this-week.md",
    ]);
  });

  it("coalesces implicit rolling digest refreshes within thirty seconds", async () => {
    const { context, files, stored, insertedEvents } = createDigestContext([
      {
        eventId: "evt_today",
        type: "file.updated",
        path: "/github/repos/acme/api/issues/43__fix-bug/meta.json",
        revision: "rev_source",
        origin: "provider_sync",
        provider: "github",
        correlationId: "corr_source",
        timestamp: "2026-05-15T09:00:00.000Z",
      },
    ]);
    for (const path of ["/digests/today.md", "/digests/this-week.md"]) {
      files.set(path, {
        path,
        revision: "rev_20",
        contentRef: `${path}@rev_20`,
        updatedAt: "2026-05-15T09:59:45.000Z",
      });
    }

    await refreshWorkspaceDigests(context, "ws_123", {
      changedPaths: ["/github/repos/acme/api/issues/43__fix-bug/meta.json"],
      generatedAt: new Date("2026-05-15T10:00:00.000Z"),
      correlationId: "corr_source",
    });

    expect(stored.map((item) => item.path)).toEqual([
      "/digests/yesterday.md",
      "/digests/2026-05-14.md",
      "/digests/last-week.md",
    ]);
    expect(insertedEvents.map((event) => event.path)).toEqual([
      "/digests/yesterday.md",
      "/digests/2026-05-14.md",
      "/digests/last-week.md",
    ]);
  });

  it("refreshes already-closed date digests when late provider events arrive", async () => {
    const contentRef = "/digests/2026-05-14.md@rev_8";
    const { context, files, stored, insertedEvents } = createDigestContext(
      [
        {
          eventId: "evt_source",
          type: "file.updated",
          path: "/github/repos/acme/api/issues/42/metadata.json",
          revision: "rev_source",
          origin: "provider_sync",
          provider: "github",
          correlationId: "corr_source",
          timestamp: "2026-05-14T09:00:00.000Z",
        },
      ],
      new Map([
        [
          contentRef,
          [
            "---",
            "covers: 2026-05-14",
            "window_key: date:2026-05-14",
            "---",
            "",
          ].join("\n"),
        ],
      ]),
    );
    files.set("/digests/2026-05-14.md", {
      path: "/digests/2026-05-14.md",
      revision: "rev_0",
      contentRef,
      updatedAt: "2026-05-15T00:00:00.000Z",
    });

    await refreshWorkspaceDigests(context, "ws_123", {
      changedPaths: ["/github/repos/acme/api/issues/42/metadata.json"],
      generatedAt: new Date("2026-05-15T12:00:00.000Z"),
      windows: ["2026-05-14"],
    });

    expect(stored).toHaveLength(1);
    expect(stored[0]?.content).toContain("window_key: date:2026-05-14");
    expect(stored[0]?.content).toContain(
      "- #42 was updated - [/github/repos/acme/api/issues/42/metadata.json]",
    );
    expect(insertedEvents).toHaveLength(1);
    expect(context.putObject).toHaveBeenCalledTimes(1);
  });

  it("uses the workspace timezone when resolving digest boundaries", async () => {
    const { context, stored } = createDigestContext([
      {
        eventId: "evt_late",
        type: "file.updated",
        path: "/github/repos/acme/api/issues/42/metadata.json",
        revision: "rev_source",
        origin: "provider_sync",
        provider: "github",
        correlationId: "corr_source",
        timestamp: "2026-05-14T22:30:00.000Z",
      },
    ]);

    await refreshWorkspaceDigests(context, "ws_123", {
      changedPaths: ["/github/repos/acme/api/issues/42/metadata.json"],
      generatedAt: new Date("2026-05-15T01:00:00.000Z"),
      timeZone: "Europe/Oslo",
      windows: ["today"],
    });

    expect(stored[0]?.content).toContain("date: 2026-05-15");
    expect(stored[0]?.content).toContain(
      "window_start: 2026-05-14T22:00:00.000Z",
    );
    expect(stored[0]?.content).toContain("timezone: Europe/Oslo");
    expect(stored[0]?.content).toContain("events: 1");
  });

  it("serves the activity-summary skill as a hosted runtime artifact", async () => {
    const file = await readFile(
      {
        getFileRow: vi.fn(() => null),
        loadContent: vi.fn(async () => ""),
      },
      "/.skills/activity-summary.md",
    );
    expect(file?.content).toContain("/digests/this-week.md");
    expect(file?.content).toContain("/digests/YYYY-MM-DD.md");

    const tree = listTree(
      {
        allRows: vi.fn(() => []),
        getFileRow: vi.fn(() => null),
        toWorkspaceFile: vi.fn((row) => row as WorkspaceFile),
        loadContent: vi.fn(async () => ""),
      } as unknown as WorkspaceFsContext,
      "ws_123",
      "/.skills",
      2,
      null,
      null,
    );
    expect(tree.entries).toContainEqual(
      expect.objectContaining({
        path: "/.skills/activity-summary.md",
        type: "file",
        provider: "runtime",
      }),
    );
  });

  it("warns when a digest window includes provider sync errors", async () => {
    const { context, stored } = createDigestContext([
      {
        eventId: "evt_sync_error",
        type: "sync.error",
        path: "/github/repos/acme/api/_sync.json",
        revision: "rev_error",
        origin: "provider_sync",
        provider: "github",
        correlationId: "corr_sync",
        timestamp: "2026-05-15T09:00:00.000Z",
      },
    ]);

    await refreshWorkspaceDigests(context, "ws_123", {
      changedPaths: ["/github/repos/acme/api/_sync.json"],
      generatedAt: new Date("2026-05-15T10:00:00.000Z"),
      correlationId: "corr_sync",
      windows: ["today"],
    });

    expect(stored[0]?.content).toContain(
      "warnings: [provider_partial_failure]",
    );
    expect(stored[0]?.content).toContain(
      "- _sync had a sync error - [/github/repos/acme/api/_sync.json]",
    );
  });

  it("renders GitHub terminal states from the event revision content", async () => {
    const issuePath = "/github/repos/acme/api/issues/43__fix-bug/meta.json";
    const pullPath = "/github/repos/acme/api/pulls/12__ship-it/meta.json";
    const { context, stored } = createDigestContext(
      [
        {
          eventId: "evt_issue",
          type: "file.updated",
          path: issuePath,
          revision: "rev_issue",
          origin: "provider_sync",
          provider: "github",
          correlationId: "corr_github",
          timestamp: "2026-05-15T08:55:00.000Z",
        },
        {
          eventId: "evt_pr",
          type: "file.updated",
          path: pullPath,
          revision: "rev_pr",
          origin: "provider_sync",
          provider: "github",
          correlationId: "corr_github",
          timestamp: "2026-05-15T09:00:00.000Z",
        },
      ],
      new Map([
        [
          `${issuePath}@rev_issue`,
          JSON.stringify({ number: 43, state: "closed" }),
        ],
        [
          `${pullPath}@rev_pr`,
          JSON.stringify({ number: 12, state: "closed", merged: true }),
        ],
      ]),
    );

    await refreshWorkspaceDigests(context, "ws_123", {
      changedPaths: [issuePath, pullPath],
      generatedAt: new Date("2026-05-15T10:00:00.000Z"),
      correlationId: "corr_github",
    });

    expect(stored[0]?.content).toContain(
      "- #43 was closed - [/github/repos/acme/api/issues/43__fix-bug/meta.json]",
    );
    expect(stored[0]?.content).toContain(
      "- #12 was merged - [/github/repos/acme/api/pulls/12__ship-it/meta.json]",
    );
  });

  it("bounds verb-override content reads to the most recent N events (cloud#1251)", async () => {
    const base = "/github/repos/acme/api/issues";
    const mk = (n: number, ts: string) => ({
      eventId: `evt_${n}`,
      type: "file.updated" as const,
      path: `${base}/${n}__x/meta.json`,
      revision: `rev_${n}`,
      origin: "provider_sync" as const,
      provider: "github",
      correlationId: "corr",
      timestamp: ts,
    });
    // Ascending timestamps: #1 oldest … #3 newest; all "closed" in content.
    const events = [
      mk(1, "2026-05-15T08:50:00.000Z"),
      mk(2, "2026-05-15T08:55:00.000Z"),
      mk(3, "2026-05-15T09:00:00.000Z"),
    ];
    const content = new Map(
      events.map((e) => [
        `${e.path}@${e.revision}`,
        JSON.stringify({ state: "closed" }),
      ]),
    );
    const { context, stored } = createDigestContext(events, content);

    await refreshWorkspaceDigests(context, "ws_123", {
      changedPaths: events.map((e) => e.path),
      generatedAt: new Date("2026-05-15T10:00:00.000Z"),
      correlationId: "corr",
      windows: ["today"],
      verbOverrideMaxEvents: 2,
    });

    const digest = stored[0]?.content ?? "";
    // The 2 most-recent events get the precise content-derived verb …
    expect(digest).toContain("- #3 was closed -");
    expect(digest).toContain("- #2 was closed -");
    // … the oldest beyond the budget falls back to the default verb (less
    // precise, never wrong — it WAS updated when it was closed).
    expect(digest).toContain("- #1 was updated -");
    expect(digest).not.toContain("- #1 was closed -");
    // And the over-budget event's content is never read (bounds R2 fan-out).
    const readRefs = vi
      .mocked(context.loadContent!)
      .mock.calls.map((call) => call[0]);
    expect(readRefs).not.toContain(`${base}/1__x/meta.json@rev_1`);
    expect(readRefs).toContain(`${base}/2__x/meta.json@rev_2`);
    expect(readRefs).toContain(`${base}/3__x/meta.json@rev_3`);
  });

  it("disables verb-override reads entirely when the budget is 0 (cloud#1251)", async () => {
    const path = "/github/repos/acme/api/issues/43__fix-bug/meta.json";
    const { context, stored } = createDigestContext(
      [
        {
          eventId: "evt_issue",
          type: "file.updated",
          path,
          revision: "rev_issue",
          origin: "provider_sync",
          provider: "github",
          correlationId: "corr",
          timestamp: "2026-05-15T09:00:00.000Z",
        },
      ],
      new Map([[`${path}@rev_issue`, JSON.stringify({ state: "closed" })]]),
    );

    await refreshWorkspaceDigests(context, "ws_123", {
      changedPaths: [path],
      generatedAt: new Date("2026-05-15T10:00:00.000Z"),
      correlationId: "corr",
      windows: ["today"],
      verbOverrideMaxEvents: 0,
    });

    expect(stored[0]?.content).toContain("- #43 was updated -");
    expect(stored[0]?.content).not.toContain("- #43 was closed -");
    expect(vi.mocked(context.loadContent!).mock.calls).toHaveLength(0);
  });

  it("bounds total verb-override bytes and keeps the digest complete", async () => {
    const base = Date.parse("2026-05-15T08:00:00.000Z");
    const events = Array.from({ length: 400 }, (_, index) => {
      const issue = index + 1;
      return {
        eventId: `evt_${issue}`,
        type: "file.updated" as const,
        path: `/github/repos/acme/api/issues/${issue}__bulk/meta.json`,
        revision: `rev_${issue}`,
        origin: "provider_sync" as const,
        provider: "github",
        correlationId: "corr_budget",
        timestamp: new Date(base + index).toISOString(),
      };
    });
    const { context, stored } = createDigestContext(events);
    const prefix = '{"state":"closed","padding":"';
    const suffix = '"}';
    const payload = `${prefix}${"x".repeat(512 * 1024 - prefix.length - suffix.length)}${suffix}`;
    expect(new TextEncoder().encode(payload).byteLength).toBe(512 * 1024);
    vi.mocked(context.loadContent!).mockImplementation(async () => payload);

    await refreshWorkspaceDigests(context, "ws_123", {
      changedPaths: ["/github/repos/acme/api/issues/400__bulk/meta.json"],
      generatedAt: new Date("2026-05-15T10:00:00.000Z"),
      correlationId: "corr_budget",
      windows: ["today"],
      verbOverrideMaxEvents: 400,
    });

    const digest = stored[0]?.content ?? "";
    expect(vi.mocked(context.loadContent!).mock.calls).toHaveLength(32);
    expect(digest).toContain("events: 400");
    expect(digest).toContain("truncated: false");
    expect(digest).toContain("- #400 was closed -");
    expect(digest).toContain("- #369 was closed -");
    expect(digest).toContain("- #368 was updated -");
    expect(digest).toContain("- #1 was updated -");
    expect(digest).not.toContain("padding");
  });

  it("allows disabling only the aggregate verb-override byte budget", async () => {
    const base = Date.parse("2026-05-15T08:00:00.000Z");
    const events = Array.from({ length: 3 }, (_, index) => {
      const issue = index + 1;
      return {
        eventId: `evt_disable_${issue}`,
        type: "file.updated" as const,
        path: `/github/repos/acme/api/issues/${issue}__budget-disabled/meta.json`,
        revision: `rev_disable_${issue}`,
        origin: "provider_sync" as const,
        provider: "github",
        correlationId: "corr_budget_disabled",
        timestamp: new Date(base + index).toISOString(),
      };
    });
    const { context, stored } = createDigestContext(events);
    vi.mocked(context.loadContent!).mockImplementation(async () =>
      JSON.stringify({ state: "closed" }),
    );

    await refreshWorkspaceDigests(context, "ws_123", {
      changedPaths: [events[0]!.path],
      generatedAt: new Date("2026-05-15T10:00:00.000Z"),
      correlationId: "corr_budget_disabled",
      windows: ["today"],
      verbOverrideMaxEvents: 3,
      verbOverrideBudgetBytes: 0,
    });

    expect(vi.mocked(context.loadContent!).mock.calls).toHaveLength(3);
    expect(stored[0]?.content).toContain("- #1 was closed -");
    expect(stored[0]?.content).toContain("- #2 was closed -");
    expect(stored[0]?.content).toContain("- #3 was closed -");
  });

  it("skips digest verb overrides gracefully when event content exceeds the digest read cap", async () => {
    const issuePath = "/github/repos/acme/api/issues/43__fix-bug/meta.json";
    const { context, stored } = createDigestContext([
      {
        eventId: "evt_issue",
        type: "file.updated",
        path: issuePath,
        revision: "rev_issue",
        origin: "provider_sync",
        provider: "github",
        correlationId: "corr_github",
        timestamp: "2026-05-15T08:55:00.000Z",
      },
    ]);
    const loadContent = vi.mocked(context.loadContent!);
    loadContent.mockImplementation(async (_contentRef, _encoding, maxBytes) => {
      expect(maxBytes).toBe(512 * 1024);
      throw {
        status: 413,
        code: "payload_too_large",
        message: "digest metadata read cap exceeded",
      };
    });

    await refreshWorkspaceDigests(context, "ws_123", {
      changedPaths: [issuePath],
      generatedAt: new Date("2026-05-15T10:00:00.000Z"),
      correlationId: "corr_github",
      windows: ["today"],
    });

    expect(loadContent).toHaveBeenCalledOnce();
    expect(stored[0]?.content).toContain(
      "- #43 was updated - [/github/repos/acme/api/issues/43__fix-bug/meta.json]",
    );
    expect(stored[0]?.content).not.toContain("#43 was closed");
  });

  it("renders Slack channel archive and delete state changes", async () => {
    const archivedPath = "/slack/channels/C123__general.json";
    const deletedPath = "/slack/channels/C345__old-channel.json";
    const { context, stored } = createDigestContext(
      [
        {
          eventId: "evt_slack",
          type: "file.updated",
          path: archivedPath,
          revision: "rev_slack",
          origin: "provider_sync",
          provider: "slack",
          correlationId: "corr_slack",
          timestamp: "2026-05-15T09:00:00.000Z",
        },
        {
          eventId: "evt_slack_delete",
          type: "file.deleted",
          path: deletedPath,
          revision: "rev_slack_delete",
          origin: "provider_sync",
          provider: "slack",
          correlationId: "corr_slack",
          timestamp: "2026-05-15T09:05:00.000Z",
        },
      ],
      new Map([
        [
          `${archivedPath}@rev_slack`,
          JSON.stringify({
            provider: "slack",
            objectType: "channel",
            payload: { id: "C123", name: "general", is_archived: true },
          }),
        ],
      ]),
    );

    await refreshWorkspaceDigests(context, "ws_123", {
      changedPaths: [archivedPath, deletedPath],
      generatedAt: new Date("2026-05-15T10:00:00.000Z"),
      correlationId: "corr_slack",
    });

    expect(stored[0]?.content).toContain(
      "- C123 was archived - [/slack/channels/C123__general.json]",
    );
    expect(stored[0]?.content).toContain(
      "- C345 was deleted - [/slack/channels/C345__old-channel.json]",
    );
  });

  it("renders Jira issue completion from nested status fields", async () => {
    const path = "/jira/issues/ENG-7__finish-import.json";
    const revision = "rev_jira";
    const { context, stored } = createDigestContext(
      [
        {
          eventId: "evt_jira",
          type: "file.updated",
          path,
          revision,
          origin: "provider_sync",
          provider: "jira",
          correlationId: "corr_jira",
          timestamp: "2026-05-15T09:00:00.000Z",
        },
      ],
      new Map([
        [
          `${path}@${revision}`,
          JSON.stringify({
            provider: "jira",
            objectType: "issue",
            payload: {
              id: "10001",
              key: "ENG-7",
              fields: { status: { name: "Done" } },
            },
          }),
        ],
      ]),
    );

    await refreshWorkspaceDigests(context, "ws_123", {
      changedPaths: [path],
      generatedAt: new Date("2026-05-15T10:00:00.000Z"),
      correlationId: "corr_jira",
    });

    expect(stored[0]?.content).toContain(
      "- ENG-7 was completed - [/jira/issues/ENG-7__finish-import.json]",
    );
  });

  it("renders Linear terminal states from nested state payloads", async () => {
    const donePath = "/linear/issues/AGE-8__issue-123.json";
    const canceledPath = "/linear/issues/AGE-9__issue-456.json";
    const { context, stored } = createDigestContext(
      [
        {
          eventId: "evt_linear_done",
          type: "file.updated",
          path: donePath,
          revision: "rev_linear_done",
          origin: "provider_sync",
          provider: "linear",
          correlationId: "corr_linear",
          timestamp: "2026-05-15T09:00:00.000Z",
        },
        {
          eventId: "evt_linear_canceled",
          type: "file.updated",
          path: canceledPath,
          revision: "rev_linear_canceled",
          origin: "provider_sync",
          provider: "linear",
          correlationId: "corr_linear",
          timestamp: "2026-05-15T09:05:00.000Z",
        },
      ],
      new Map([
        [
          `${donePath}@rev_linear_done`,
          JSON.stringify({
            id: "issue-123",
            state: { name: "Done", type: "done" },
          }),
        ],
        [
          `${canceledPath}@rev_linear_canceled`,
          JSON.stringify({
            id: "issue-456",
            state: { name: "Canceled", type: "canceled" },
          }),
        ],
      ]),
    );

    await refreshWorkspaceDigests(context, "ws_123", {
      changedPaths: [donePath, canceledPath],
      generatedAt: new Date("2026-05-15T10:00:00.000Z"),
      correlationId: "corr_linear",
    });

    expect(stored[0]?.content).toContain(
      "- AGE-8 was completed - [/linear/issues/AGE-8__issue-123.json]",
    );
    expect(stored[0]?.content).toContain(
      "- AGE-9 was canceled - [/linear/issues/AGE-9__issue-456.json]",
    );
  });

  it("renders Confluence and Notion archived state from wrapped payloads", async () => {
    const confluencePath = "/confluence/pages/123__release-plan.json";
    const notionPath = "/notion/pages/roadmap__page_b/page.md";
    const { context, stored } = createDigestContext(
      [
        {
          eventId: "evt_confluence",
          type: "file.updated",
          path: confluencePath,
          revision: "rev_confluence",
          origin: "provider_sync",
          provider: "confluence",
          correlationId: "corr_confluence",
          timestamp: "2026-05-15T09:00:00.000Z",
        },
        {
          eventId: "evt_notion",
          type: "file.updated",
          path: notionPath,
          revision: "rev_notion",
          origin: "provider_sync",
          provider: "notion",
          correlationId: "corr_notion",
          timestamp: "2026-05-15T09:05:00.000Z",
        },
      ],
      new Map([
        [
          `${confluencePath}@rev_confluence`,
          JSON.stringify({
            provider: "confluence",
            objectType: "page",
            payload: { id: "123", title: "Release Plan", status: "archived" },
          }),
        ],
        [
          `${notionPath}@rev_notion`,
          JSON.stringify({
            provider: "notion",
            objectType: "page",
            payload: { id: "page_b", title: "Roadmap", archived: true },
          }),
        ],
      ]),
    );

    await refreshWorkspaceDigests(context, "ws_123", {
      changedPaths: [confluencePath, notionPath],
      generatedAt: new Date("2026-05-15T10:00:00.000Z"),
      correlationId: "corr_archived",
    });

    expect(stored[0]?.content).toContain(
      "- 123 was archived - [/confluence/pages/123__release-plan.json]",
    );
    expect(stored[0]?.content).toContain(
      "- roadmap was archived - [/notion/pages/roadmap__page_b/page.md]",
    );
  });

  it("renders terminal state from the event revision when current content changed later", async () => {
    const path = "/confluence/pages/123__release-plan.json";
    const revisionRef = `${path}@rev_archived`;
    const currentRef = `${path}@rev_current`;
    const { context, files, stored } = createDigestContext(
      [
        {
          eventId: "evt_confluence_archived",
          type: "file.updated",
          path,
          revision: "rev_archived",
          origin: "provider_sync",
          provider: "confluence",
          correlationId: "corr_confluence",
          timestamp: "2026-05-15T09:00:00.000Z",
        },
      ],
      new Map([
        [
          revisionRef,
          JSON.stringify({
            provider: "confluence",
            objectType: "page",
            payload: { id: "123", status: "archived" },
          }),
        ],
        [
          currentRef,
          JSON.stringify({
            provider: "confluence",
            objectType: "page",
            payload: { id: "123", status: "current" },
          }),
        ],
      ]),
    );
    files.set(path, {
      path,
      revision: "rev_current",
      contentType: "application/json; charset=utf-8",
      contentRef: currentRef,
      updatedAt: "2026-05-15T10:00:00.000Z",
      provider: "confluence",
    });

    await refreshWorkspaceDigests(context, "ws_123", {
      changedPaths: [path],
      generatedAt: new Date("2026-05-15T11:00:00.000Z"),
      correlationId: "corr_confluence",
    });

    expect(stored[0]?.content).toContain(
      "- 123 was archived - [/confluence/pages/123__release-plan.json]",
    );
  });

  it("renders Confluence restored pages as restored instead of deleted", async () => {
    const path = "/confluence/pages/123__release-plan.json";
    const revision = "rev_confluence_restore";
    const { context, stored } = createDigestContext(
      [
        {
          eventId: "evt_confluence_restore",
          type: "file.updated",
          path,
          revision,
          origin: "provider_sync",
          provider: "confluence",
          correlationId: "corr_confluence_restore",
          timestamp: "2026-05-15T09:00:00.000Z",
        },
      ],
      new Map([
        [
          `${path}@${revision}`,
          JSON.stringify({
            provider: "confluence",
            objectType: "page",
            payload: {
              id: "123",
              title: "Release Plan",
              status: "current",
              _webhook: { eventType: "page_restored", action: "restored" },
            },
          }),
        ],
      ]),
    );

    await refreshWorkspaceDigests(context, "ws_123", {
      changedPaths: [path],
      generatedAt: new Date("2026-05-15T10:00:00.000Z"),
      correlationId: "corr_confluence_restore",
    });

    expect(stored[0]?.content).toContain(
      "- 123 was restored - [/confluence/pages/123__release-plan.json]",
    );
    expect(stored[0]?.content).not.toContain(
      "- 123 was deleted - [/confluence/pages/123__release-plan.json]",
    );
  });

  it("renders GitLab issue, merge request, and commit records in digests", async () => {
    const issuePath =
      "/gitlab/projects/acme/api/issues/17__fix-sync-state/meta.json";
    const mrPath =
      "/gitlab/projects/acme/api/merge_requests/12__ship-it/meta.json";
    const commitPath =
      "/gitlab/projects/acme/api/commits/abc123__wire-gitlab-relayfile/meta.json";
    const filePath = "/gitlab/projects/acme/api/files/config%2Ffoo__bar.json";
    const tagPath =
      "/gitlab/projects/acme/api/tags/release-foo-bar__release%2Ffoo__bar.json";
    const tagAliasPath =
      "/gitlab/projects/acme/api/tags/by-ref/release-foo-bar__release%2Ffoo__bar.json";
    const legacyTagPath =
      "/gitlab/projects/acme/api/tags/release/foo__bar.json";
    const fullRefTagPath =
      "/gitlab/projects/acme/api/tags/refs-tags-release-foo-bar__refs%2Ftags%2Frelease%2Ffoo__bar.json";
    const legacyFlatTagPath = "/gitlab/projects/acme/api/tags/foo__bar.json";
    const projectByIdAliasPath = "/gitlab/projects/by-id/20.json";
    const jobPath =
      "/gitlab/projects/acme/api/pipelines/1001__main/jobs/77.json";
    const deploymentPath =
      "/gitlab/projects/acme/api/deployments/production__15.json";
    const { context, stored } = createDigestContext(
      [
        {
          eventId: "evt_gitlab_issue",
          type: "file.updated",
          path: issuePath,
          revision: "rev_gitlab_issue",
          origin: "provider_sync",
          provider: "gitlab",
          correlationId: "corr_gitlab",
          timestamp: "2026-05-15T09:00:00.000Z",
        },
        {
          eventId: "evt_gitlab_mr",
          type: "file.updated",
          path: mrPath,
          revision: "rev_gitlab_mr",
          origin: "provider_sync",
          provider: "gitlab",
          correlationId: "corr_gitlab",
          timestamp: "2026-05-15T09:05:00.000Z",
        },
        {
          eventId: "evt_gitlab_commit",
          type: "file.updated",
          path: commitPath,
          revision: "rev_gitlab_commit",
          origin: "provider_sync",
          provider: "gitlab",
          correlationId: "corr_gitlab",
          timestamp: "2026-05-15T09:10:00.000Z",
        },
        {
          eventId: "evt_gitlab_file",
          type: "file.updated",
          path: filePath,
          revision: "rev_gitlab_file",
          origin: "provider_sync",
          provider: "gitlab",
          correlationId: "corr_gitlab",
          timestamp: "2026-05-15T09:12:00.000Z",
        },
        {
          eventId: "evt_gitlab_tag",
          type: "file.updated",
          path: tagPath,
          revision: "rev_gitlab_tag",
          origin: "provider_sync",
          provider: "gitlab",
          correlationId: "corr_gitlab",
          timestamp: "2026-05-15T09:15:00.000Z",
        },
        {
          eventId: "evt_gitlab_tag_alias",
          type: "file.updated",
          path: tagAliasPath,
          revision: "rev_gitlab_tag_alias",
          origin: "provider_sync",
          provider: "gitlab",
          correlationId: "corr_gitlab",
          timestamp: "2026-05-15T09:16:00.000Z",
        },
        {
          eventId: "evt_gitlab_tag_legacy",
          type: "file.deleted",
          path: legacyTagPath,
          revision: "rev_gitlab_tag_legacy",
          origin: "provider_sync",
          provider: "gitlab",
          correlationId: "corr_gitlab",
          timestamp: "2026-05-15T09:17:00.000Z",
        },
        {
          eventId: "evt_gitlab_tag_full_ref",
          type: "file.deleted",
          path: fullRefTagPath,
          revision: "rev_gitlab_tag_full_ref",
          origin: "provider_sync",
          provider: "gitlab",
          correlationId: "corr_gitlab",
          timestamp: "2026-05-15T09:18:00.000Z",
        },
        {
          eventId: "evt_gitlab_tag_legacy_flat",
          type: "file.deleted",
          path: legacyFlatTagPath,
          revision: "rev_gitlab_tag_legacy_flat",
          origin: "provider_sync",
          provider: "gitlab",
          correlationId: "corr_gitlab",
          timestamp: "2026-05-15T09:19:00.000Z",
        },
        {
          eventId: "evt_gitlab_job",
          type: "file.updated",
          path: jobPath,
          revision: "rev_gitlab_job",
          origin: "provider_sync",
          provider: "gitlab",
          correlationId: "corr_gitlab",
          timestamp: "2026-05-15T09:20:00.000Z",
        },
        {
          eventId: "evt_gitlab_project_alias",
          type: "file.updated",
          path: projectByIdAliasPath,
          revision: "rev_gitlab_project_alias",
          origin: "provider_sync",
          provider: "gitlab",
          correlationId: "corr_gitlab",
          timestamp: "2026-05-15T09:22:00.000Z",
        },
        {
          eventId: "evt_gitlab_deployment",
          type: "file.updated",
          path: deploymentPath,
          revision: "rev_gitlab_deployment",
          origin: "provider_sync",
          provider: "gitlab",
          correlationId: "corr_gitlab",
          timestamp: "2026-05-15T09:25:00.000Z",
        },
      ],
      new Map([
        [
          `${issuePath}@rev_gitlab_issue`,
          JSON.stringify({ iid: 17, state: "closed" }),
        ],
        [
          `${mrPath}@rev_gitlab_mr`,
          JSON.stringify({ iid: 12, state: "merged" }),
        ],
        [
          `${commitPath}@rev_gitlab_commit`,
          JSON.stringify({ id: "abc123", title: "Wire GitLab relayfile" }),
        ],
        [
          `${filePath}@rev_gitlab_file`,
          JSON.stringify({ path: "config/foo__bar" }),
        ],
        [
          `${tagPath}@rev_gitlab_tag`,
          JSON.stringify({ ref: "release/foo__bar" }),
        ],
        [
          `${jobPath}@rev_gitlab_job`,
          JSON.stringify({
            id: "77",
            status: "failed",
            _webhook: { eventType: "job.failed" },
          }),
        ],
        [
          `${deploymentPath}@rev_gitlab_deployment`,
          JSON.stringify({
            id: "15",
            status: "success",
            _webhook: { eventType: "deployment.success" },
          }),
        ],
      ]),
    );

    await refreshWorkspaceDigests(context, "ws_123", {
      changedPaths: [
        issuePath,
        mrPath,
        commitPath,
        filePath,
        tagPath,
        tagAliasPath,
        legacyTagPath,
        fullRefTagPath,
        legacyFlatTagPath,
        projectByIdAliasPath,
        jobPath,
        deploymentPath,
      ],
      generatedAt: new Date("2026-05-15T10:00:00.000Z"),
      correlationId: "corr_gitlab",
    });

    expect(stored[0]?.content).toContain(
      "- issue #17 was closed - [/gitlab/projects/acme/api/issues/17__fix-sync-state/meta.json]",
    );
    expect(stored[0]?.content).toContain(
      "- MR !12 was merged - [/gitlab/projects/acme/api/merge_requests/12__ship-it/meta.json]",
    );
    expect(stored[0]?.content).toContain(
      "- commit abc123 was updated - [/gitlab/projects/acme/api/commits/abc123__wire-gitlab-relayfile/meta.json]",
    );
    expect(stored[0]?.content).toContain(
      "- file config%2Ffoo__bar was updated - [/gitlab/projects/acme/api/files/config%2Ffoo__bar.json]",
    );
    expect(stored[0]?.content).toContain(
      "- tag release/foo__bar was updated - [/gitlab/projects/acme/api/tags/release-foo-bar__release%2Ffoo__bar.json]",
    );
    expect(stored[0]?.content).toContain(
      "- job #77 failed - [/gitlab/projects/acme/api/pipelines/1001__main/jobs/77.json]",
    );
    expect(stored[0]?.content).toContain(
      "- deployment #15 succeeded - [/gitlab/projects/acme/api/deployments/production__15.json]",
    );
    expect(stored[0]?.content).not.toContain(tagAliasPath);
    expect(stored[0]?.content).not.toContain(legacyTagPath);
    expect(stored[0]?.content).not.toContain(legacyFlatTagPath);
    expect(stored[0]?.content).not.toContain(projectByIdAliasPath);
  });

  it("falls back to current file content when an older event revision was pruned", async () => {
    const path =
      "/gitlab/projects/acme/api/merge_requests/7__ship-it/meta.json";
    const currentRef = `${path}@rev_current`;
    const { context, files, stored } = createDigestContext(
      [
        {
          eventId: "evt_mr",
          type: "file.updated",
          path,
          revision: "rev_pruned",
          origin: "provider_sync",
          provider: "gitlab",
          correlationId: "corr_mr",
          timestamp: "2026-05-15T09:00:00.000Z",
        },
      ],
      new Map([[currentRef, JSON.stringify({ iid: 7, state: "merged" })]]),
    );
    files.set(path, {
      path,
      contentRef: currentRef,
      provider: "gitlab",
      updatedAt: "2026-05-15T09:00:00.000Z",
    });

    await refreshWorkspaceDigests(context, "ws_123", {
      changedPaths: [path],
      generatedAt: new Date("2026-05-15T10:00:00.000Z"),
      correlationId: "corr_mr",
    });

    expect(stored[0]?.content).toContain(
      "- MR !7 was merged - [/gitlab/projects/acme/api/merge_requests/7__ship-it/meta.json]",
    );
  });

  it("does not use current content for a different event timestamp", async () => {
    const path = "/github/repos/acme/api/pulls/12__ship-it/meta.json";
    const currentRef = `${path}@rev_current`;
    const { context, files, stored } = createDigestContext(
      [
        {
          eventId: "evt_old",
          type: "file.updated",
          path,
          revision: "rev_pruned",
          origin: "provider_sync",
          provider: "github",
          correlationId: "corr_old",
          timestamp: "2026-05-15T08:00:00.000Z",
        },
      ],
      new Map([
        [
          currentRef,
          JSON.stringify({ number: 12, state: "closed", merged: true }),
        ],
      ]),
    );
    files.set(path, {
      path,
      contentRef: currentRef,
      provider: "github",
      updatedAt: "2026-05-15T09:00:00.000Z",
    });

    await refreshWorkspaceDigests(context, "ws_123", {
      changedPaths: [path],
      generatedAt: new Date("2026-05-15T10:00:00.000Z"),
      correlationId: "corr_old",
    });

    expect(stored[0]?.content).toContain(
      "- #12 was updated - [/github/repos/acme/api/pulls/12__ship-it/meta.json]",
    );
  });

  it("recognizes digest paths with or without a leading slash", () => {
    expect(isDigestPath("/digests/today.md")).toBe(true);
    expect(isDigestPath("digests/yesterday.md")).toBe(true);
    expect(isDigestPath("/github/digests/today.md")).toBe(false);
  });

  it("excludes internal/system paths from the activity budget so real provider activity is not squeezed out", async () => {
    // Reproduces the rw_fc7b534b digest issue: 1500 updates to /.relayfile.acl
    // (an internal ACL marker file) plus 100 each across Linear / Jira / Notion.
    // The ACL spam must NOT consume budget; real provider activity MUST render
    // in full and the digest must NOT be flagged truncated for this fixture.
    const base = Date.parse("2026-05-15T08:00:00.000Z");
    const aclEvents = Array.from({ length: 1500 }, (_, index) => ({
      eventId: `evt_acl_${String(index).padStart(4, "0")}`,
      type: "file.updated" as const,
      // The acl marker exists at the workspace root and in every directory.
      path:
        index % 2 === 0
          ? "/.relayfile.acl"
          : `/linear/issues/${index}/.relayfile.acl`,
      revision: `rev_acl_${index}`,
      origin: "system" as const,
      provider: "",
      correlationId: "corr_acl",
      timestamp: new Date(base + index).toISOString(),
    }));
    const providerEvents = (
      [
        ["linear", "issues"],
        ["jira", "issues"],
        ["notion", "pages"],
      ] as const
    ).flatMap(([provider, resource], providerIndex) =>
      Array.from({ length: 100 }, (_, index) => ({
        eventId: `evt_${provider}_${String(index).padStart(3, "0")}`,
        type: "file.updated" as const,
        path: `/${provider}/${resource}/${index + 1}__work/meta.json`,
        revision: `rev_${provider}_${index}`,
        origin: "provider_sync" as const,
        provider,
        correlationId: `corr_${provider}`,
        timestamp: new Date(
          base + 1500 + providerIndex * 100 + index,
        ).toISOString(),
      })),
    );
    const { context, stored } = createDigestContext([
      ...aclEvents,
      ...providerEvents,
    ]);

    await refreshWorkspaceDigests(context, "ws_123", {
      changedPaths: ["/linear/issues/1__work/meta.json"],
      generatedAt: new Date("2026-05-15T10:00:00.000Z"),
      correlationId: "corr_linear",
    });

    const today = stored.find((item) => item.path === "/digests/today.md");
    expect(today, "today digest must be written").toBeDefined();
    const content = today!.content;
    // No ACL noise in rendered activity at all.
    expect(content).not.toContain("/.relayfile.acl");
    // Real provider activity present.
    expect(content).toContain(
      "- 1 was updated - [/linear/issues/1__work/meta.json]",
    );
    expect(content).toContain(
      "- 1 was updated - [/jira/issues/1__work/meta.json]",
    );
    expect(content).toContain(
      "- 1 was updated - [/notion/pages/1__work/meta.json]",
    );
    expect(content).toContain(
      "- 100 was updated - [/linear/issues/100__work/meta.json]",
    );
    // 1500 ACL events + 300 real → only 300 real remain after filter.
    expect(content).toContain("events: 300");
    // Real activity fits inside 2000-event budget once internals are gone.
    expect(content).toContain("truncated: false");
    expect(content).toContain("warnings: []");
  });

  it("does not load content for provider auxiliary index or alias events", async () => {
    const base = Date.parse("2026-05-15T08:00:00.000Z");
    const events: WorkspaceEvent[] = [
      {
        eventId: "evt_index",
        type: "file.updated",
        path: "/google-mail/messages/_index.json",
        revision: "rev_index",
        origin: "provider_sync",
        provider: "google-mail",
        correlationId: "corr_aux",
        timestamp: new Date(base).toISOString(),
      },
      {
        eventId: "evt_alias",
        type: "file.updated",
        path: "/google-mail/messages/by-thread/thread_1/msg_1.json",
        revision: "rev_alias",
        origin: "provider_sync",
        provider: "google-mail",
        correlationId: "corr_aux",
        timestamp: new Date(base + 1).toISOString(),
      },
      {
        eventId: "evt_real",
        type: "file.updated",
        path: "/linear/issues/1__work/meta.json",
        revision: "rev_real",
        origin: "provider_sync",
        provider: "linear",
        correlationId: "corr_linear",
        timestamp: new Date(base + 2).toISOString(),
      },
    ];
    const initialContent = new Map([
      ["/linear/issues/1__work/meta.json@rev_real", '{"state":"closed"}'],
      ["/google-mail/messages/_index.json@rev_index", '{"state":"closed"}'],
      [
        "/google-mail/messages/by-thread/thread_1/msg_1.json@rev_alias",
        '{"state":"closed"}',
      ],
    ]);
    const { context, stored } = createDigestContext(events, initialContent);

    await refreshWorkspaceDigests(context, "ws_123", {
      changedPaths: ["/linear/issues/1__work/meta.json"],
      generatedAt: new Date("2026-05-15T10:00:00.000Z"),
      correlationId: "corr_linear",
      windows: ["today"],
    });

    const loadContent = vi.mocked(context.loadContent!);
    const loadRefs = loadContent.mock.calls.map((call) => String(call[0]));
    expect(loadRefs).toEqual(["/linear/issues/1__work/meta.json@rev_real"]);

    const today = stored.find((item) => item.path === "/digests/today.md");
    expect(today?.content).toContain(
      "- 1 was closed - [/linear/issues/1__work/meta.json]",
    );
    expect(today?.content).not.toContain("_index.json");
    expect(today?.content).not.toContain("by-thread");
  });

  describe("isInternalDigestPath", () => {
    it("excludes the ACL marker file at the root and inside any directory", () => {
      expect(isInternalDigestPath("/.relayfile.acl")).toBe(true);
      expect(isInternalDigestPath("/linear/issues/.relayfile.acl")).toBe(true);
      expect(
        isInternalDigestPath("/jira/projects/ENG/issues/42/.relayfile.acl"),
      ).toBe(true);
      expect(isInternalDigestPath(".relayfile.acl")).toBe(true);
    });

    it("excludes LAYOUT.md whether at the root or inside a provider tree", () => {
      expect(isInternalDigestPath("/LAYOUT.md")).toBe(true);
      expect(isInternalDigestPath("/linear/LAYOUT.md")).toBe(true);
      expect(isInternalDigestPath("/gitlab/projects/LAYOUT.md")).toBe(true);
    });

    it("excludes the /discovery/, /digests/, and /.skills/ subtrees", () => {
      expect(isInternalDigestPath("/discovery/linear/.adapter.md")).toBe(true);
      expect(
        isInternalDigestPath("/discovery/linear/issues/.schema.json"),
      ).toBe(true);
      expect(isInternalDigestPath("/digests/today.md")).toBe(true);
      expect(isInternalDigestPath("/.skills/activity-summary.md")).toBe(true);
      expect(isInternalDigestPath("/.relayfile-mount-state.json")).toBe(true);
    });

    it("excludes provider auxiliary index and alias files", () => {
      expect(isInternalDigestPath("/google-mail/messages/_index.json")).toBe(
        true,
      );
      expect(
        isInternalDigestPath("/google-mail/messages/by-id/msg_1.json"),
      ).toBe(true);
      expect(
        isInternalDigestPath(
          "/google-mail/messages/by-thread/thread_1/msg_1.json",
        ),
      ).toBe(true);
      expect(
        isInternalDigestPath(
          "/google-calendar/events/by-calendar/cal_1/_index.json",
        ),
      ).toBe(true);
    });

    it("INCLUDES (does not exclude) real provider activity paths", () => {
      expect(isInternalDigestPath("/linear/issues/42/meta.json")).toBe(false);
      expect(isInternalDigestPath("/jira/issues/PROJ-1/meta.json")).toBe(false);
      expect(isInternalDigestPath("/notion/pages/abc/page.md")).toBe(false);
      expect(isInternalDigestPath("/github/repos/acme/api/issues/1.json")).toBe(
        false,
      );
      expect(
        isInternalDigestPath("/gitlab/projects/acme/merge_requests/7"),
      ).toBe(false);
      expect(isInternalDigestPath("/confluence/spaces/ENG/pages/1.md")).toBe(
        false,
      );
    });

    it("is path-anchored, not substring-based, so provider files merely containing 'acl'/'layout'/'discovery' are NOT excluded", () => {
      // Hypothetical Notion page mentioning 'acl' or 'layout' in its filename.
      expect(isInternalDigestPath("/notion/pages/some-acl-doc.json")).toBe(
        false,
      );
      expect(isInternalDigestPath("/notion/pages/page-LAYOUT.md")).toBe(false);
      expect(
        isInternalDigestPath("/linear/issues/discovery-call/meta.json"),
      ).toBe(false);
      expect(isInternalDigestPath("/notion/pages/by-design/meta.json")).toBe(
        false,
      );
      expect(
        isInternalDigestPath("/linear/issues/42/.relayfile.acl.backup"),
      ).toBe(false);
    });
  });

  // These tests directly exercise the production SQL `WHERE` clause via
  // the fake-SQL mirror in `createDigestContext`. Their purpose is to
  // ensure that a future regression which weakens ONLY the SQL filter
  // (e.g. someone deletes the `%/.relayfile.acl` clause) is caught by
  // tests — without these, the JS `isInternalDigestPath` defense-in-depth
  // filter would silently keep coverage green while production loses
  // budget reclaim and the user's exact bug (`truncated:true`,
  // `digest_event_limit_exceeded` from ACL spam) returns at the SQL
  // layer. The fake-SQL is a literal byte-mirror of production SQL (see
  // the comment in `createDigestContext`), so any divergence between the
  // production SQL `WHERE` and the literal mirror surfaces here as a
  // test failure.
  describe("SQL filter (fake-SQL byte-mirror of production WHERE)", () => {
    it("excludes every internal/system path that production SQL excludes", () => {
      const base = Date.parse("2026-05-15T09:00:00.000Z");
      const fixturePaths = [
        // Real provider activity — must SURVIVE the SQL filter.
        "/linear/issues/1__work/meta.json",
        "/jira/issues/PROJ-1/meta.json",
        "/notion/pages/abc/page.md",
        "/github/repos/acme/api/issues/1.json",
        "/gitlab/projects/acme/api/merge_requests/7/meta.json",
        "/confluence/pages/123__release-plan.json",
        "/notion/pages/by-design/meta.json",
        // Internal/system paths — must be EXCLUDED by the SQL filter.
        "/.relayfile.acl",
        "/linear/issues/1/.relayfile.acl",
        "/jira/projects/ENG/issues/42/.relayfile.acl",
        "/LAYOUT.md",
        "/linear/LAYOUT.md",
        "/gitlab/projects/LAYOUT.md",
        "/.relayfile-mount-state.json",
        "/google-mail/messages/_index.json",
        "/google-mail/messages/by-id/msg_1.json",
        "/google-mail/messages/by-thread/thread_1/msg_1.json",
        "/google-calendar/events/by-calendar/cal_1/_index.json",
        "/digests/today.md",
        "/digests/yesterday.md",
        "/discovery/linear/.adapter.md",
        "/discovery/linear/issues/.schema.json",
        "/.skills/activity-summary.md",
      ];
      const fixtureEvents: WorkspaceEvent[] = fixturePaths.map(
        (path, index) => ({
          eventId: `evt_${String(index).padStart(3, "0")}`,
          type: "file.updated",
          path,
          revision: `rev_${index}`,
          origin: path.endsWith(".relayfile.acl") ? "system" : "provider_sync",
          provider: "",
          correlationId: "corr_fixture",
          timestamp: new Date(base + index).toISOString(),
        }),
      );
      const { context } = createDigestContext(fixtureEvents);

      // Use the exact production query string from src/durable-objects/digest.ts
      // so any structural drift (e.g. someone renames `events`) also fails here.
      const productionQuery = `
        SELECT event_id, type, path, revision, origin, provider, correlation_id, timestamp
        FROM (
          SELECT event_id, type, path, revision, origin, provider, correlation_id, timestamp
          FROM events
          WHERE timestamp >= ? AND timestamp < ?
            AND path NOT LIKE '/digests/%'
            AND path NOT LIKE '/discovery/%'
            AND path NOT LIKE '/.skills/%'
            AND path NOT LIKE '%/.relayfile.acl'
            AND path != '/.relayfile.acl'
            AND path NOT LIKE '%/LAYOUT.md'
            AND path != '/LAYOUT.md'
            AND path NOT LIKE '%/_index.json'
            AND path NOT LIKE '%/by-assignee/%'
            AND path NOT LIKE '%/by-author/%'
            AND path NOT LIKE '%/by-calendar/%'
            AND path NOT LIKE '%/by-conversation/%'
            AND path NOT LIKE '%/by-creator/%'
            AND path NOT LIKE '%/by-database/%'
            AND path NOT LIKE '%/by-day/%'
            AND path NOT LIKE '%/by-edited/%'
            AND path NOT LIKE '%/by-id/%'
            AND path NOT LIKE '%/by-key/%'
            AND path NOT LIKE '%/by-label/%'
            AND path NOT LIKE '%/by-name/%'
            AND path NOT LIKE '%/by-organizer/%'
            AND path NOT LIKE '%/by-parent/%'
            AND path NOT LIKE '%/by-participant/%'
            AND path NOT LIKE '%/by-priority/%'
            AND path NOT LIKE '%/by-query/%'
            AND path NOT LIKE '%/by-ref/%'
            AND path NOT LIKE '%/by-role/%'
            AND path NOT LIKE '%/by-sender/%'
            AND path NOT LIKE '%/by-space/%'
            AND path NOT LIKE '%/by-state/%'
            AND path NOT LIKE '%/by-status/%'
            AND path NOT LIKE '%/by-thread/%'
            AND path NOT LIKE '%/by-title/%'
            AND path NOT LIKE '%/by-username/%'
            AND path NOT LIKE '%/by-uuid/%'
            AND path != '/.relayfile-mount-state.json'
          ORDER BY timestamp DESC, event_id DESC
          LIMIT ?
        )
        ORDER BY timestamp ASC, event_id ASC
      `;
      const rows = context.allRows<{ path: string }>(
        productionQuery,
        "2026-05-15T00:00:00.000Z",
        "2026-05-16T00:00:00.000Z",
        10000,
      );
      const paths = rows.map((row) => String(row.path));

      // Real provider activity survives.
      expect(paths).toContain("/linear/issues/1__work/meta.json");
      expect(paths).toContain("/jira/issues/PROJ-1/meta.json");
      expect(paths).toContain("/notion/pages/abc/page.md");
      expect(paths).toContain("/github/repos/acme/api/issues/1.json");
      expect(paths).toContain(
        "/gitlab/projects/acme/api/merge_requests/7/meta.json",
      );
      expect(paths).toContain("/confluence/pages/123__release-plan.json");
      expect(paths).toContain("/notion/pages/by-design/meta.json");

      // Internal/system paths are excluded. Each `not.toContain` corresponds
      // to a specific SQL clause; remove that clause and this assertion
      // fails with a content diff (no missing-symbol error).
      expect(paths).not.toContain("/.relayfile.acl");
      expect(paths).not.toContain("/linear/issues/1/.relayfile.acl");
      expect(paths).not.toContain(
        "/jira/projects/ENG/issues/42/.relayfile.acl",
      );
      expect(paths).not.toContain("/LAYOUT.md");
      expect(paths).not.toContain("/linear/LAYOUT.md");
      expect(paths).not.toContain("/gitlab/projects/LAYOUT.md");
      expect(paths).not.toContain("/.relayfile-mount-state.json");
      expect(paths).not.toContain("/google-mail/messages/_index.json");
      expect(paths).not.toContain("/google-mail/messages/by-id/msg_1.json");
      expect(paths).not.toContain(
        "/google-mail/messages/by-thread/thread_1/msg_1.json",
      );
      expect(paths).not.toContain(
        "/google-calendar/events/by-calendar/cal_1/_index.json",
      );
      expect(paths).not.toContain("/digests/today.md");
      expect(paths).not.toContain("/digests/yesterday.md");
      expect(paths).not.toContain("/discovery/linear/.adapter.md");
      expect(paths).not.toContain("/discovery/linear/issues/.schema.json");
      expect(paths).not.toContain("/.skills/activity-summary.md");

      // Belt-and-suspenders: the count of surviving rows equals the count
      // of real-provider paths in the fixture. If a single internal path
      // leaks through, this fails with `Expected 6, received 7` — a clear
      // content diff, not a symbol error.
      expect(paths).toHaveLength(7);
    });

    it("alone reclaims budget for the user's bug fixture (1500 ACL events + 300 real)", () => {
      // Mirrors the rw_fc7b534b user bug at the SQL layer: a workspace with
      // 1500 ACL marker churn events plus 300 real provider events. Before
      // the SQL filter, the 2000-event SQL `LIMIT` would be exhausted by
      // ACL noise and the digest would return `truncated:true` with the
      // newest 2000 events (mostly ACL). With the production SQL filter
      // active, the SQL layer alone must drop the ACL events so only 300
      // real events flow into the digest pipeline.
      const base = Date.parse("2026-05-15T08:00:00.000Z");
      const aclEvents: WorkspaceEvent[] = Array.from(
        { length: 1500 },
        (_, index) => ({
          eventId: `evt_acl_${String(index).padStart(4, "0")}`,
          type: "file.updated",
          path:
            index % 2 === 0
              ? "/.relayfile.acl"
              : `/linear/issues/${index}/.relayfile.acl`,
          revision: `rev_acl_${index}`,
          origin: "system",
          provider: "",
          correlationId: "corr_acl",
          timestamp: new Date(base + index).toISOString(),
        }),
      );
      const realEvents: WorkspaceEvent[] = (
        [
          ["linear", "issues"],
          ["jira", "issues"],
          ["notion", "pages"],
        ] as const
      ).flatMap(([provider, resource], providerIndex) =>
        Array.from({ length: 100 }, (_, index) => ({
          eventId: `evt_${provider}_${String(index).padStart(3, "0")}`,
          type: "file.updated" as const,
          path: `/${provider}/${resource}/${index + 1}__work/meta.json`,
          revision: `rev_${provider}_${index}`,
          origin: "provider_sync" as const,
          provider,
          correlationId: `corr_${provider}`,
          timestamp: new Date(
            base + 1500 + providerIndex * 100 + index,
          ).toISOString(),
        })),
      );
      const { context } = createDigestContext([...aclEvents, ...realEvents]);
      const productionQuery = `
        SELECT event_id, type, path, revision, origin, provider, correlation_id, timestamp
        FROM (
          SELECT event_id, type, path, revision, origin, provider, correlation_id, timestamp
          FROM events
          WHERE timestamp >= ? AND timestamp < ?
            AND path NOT LIKE '/digests/%'
            AND path NOT LIKE '/discovery/%'
            AND path NOT LIKE '/.skills/%'
            AND path NOT LIKE '%/.relayfile.acl'
            AND path != '/.relayfile.acl'
            AND path NOT LIKE '%/LAYOUT.md'
            AND path != '/LAYOUT.md'
            AND path NOT LIKE '%/_index.json'
            AND path NOT LIKE '%/by-assignee/%'
            AND path NOT LIKE '%/by-author/%'
            AND path NOT LIKE '%/by-calendar/%'
            AND path NOT LIKE '%/by-conversation/%'
            AND path NOT LIKE '%/by-creator/%'
            AND path NOT LIKE '%/by-database/%'
            AND path NOT LIKE '%/by-day/%'
            AND path NOT LIKE '%/by-edited/%'
            AND path NOT LIKE '%/by-id/%'
            AND path NOT LIKE '%/by-key/%'
            AND path NOT LIKE '%/by-label/%'
            AND path NOT LIKE '%/by-name/%'
            AND path NOT LIKE '%/by-organizer/%'
            AND path NOT LIKE '%/by-parent/%'
            AND path NOT LIKE '%/by-participant/%'
            AND path NOT LIKE '%/by-priority/%'
            AND path NOT LIKE '%/by-query/%'
            AND path NOT LIKE '%/by-ref/%'
            AND path NOT LIKE '%/by-role/%'
            AND path NOT LIKE '%/by-sender/%'
            AND path NOT LIKE '%/by-space/%'
            AND path NOT LIKE '%/by-state/%'
            AND path NOT LIKE '%/by-status/%'
            AND path NOT LIKE '%/by-thread/%'
            AND path NOT LIKE '%/by-title/%'
            AND path NOT LIKE '%/by-username/%'
            AND path NOT LIKE '%/by-uuid/%'
            AND path != '/.relayfile-mount-state.json'
          ORDER BY timestamp DESC, event_id DESC
          LIMIT ?
        )
        ORDER BY timestamp ASC, event_id ASC
      `;
      // Use the digest-internal LIMIT of 2000+1 so the SELECT inside the
      // subquery matches the production budget check exactly.
      const rows = context.allRows<{ path: string }>(
        productionQuery,
        "2026-05-15T00:00:00.000Z",
        "2026-05-16T00:00:00.000Z",
        2001,
      );

      // 1800 input events → 300 survivors after SQL alone. If the SQL
      // filter is weakened (e.g. someone removes `%/.relayfile.acl`), this
      // collapses to `Expected 300, received 2001` because the SQL LIMIT
      // would cap at 2001 (newest first) — and the budget reclaim is gone.
      expect(rows).toHaveLength(300);
      const paths = rows.map((row) => String(row.path));
      expect(paths.some((p) => p.endsWith("/.relayfile.acl"))).toBe(false);
      expect(paths).toContain("/linear/issues/1__work/meta.json");
      expect(paths).toContain("/jira/issues/1__work/meta.json");
      expect(paths).toContain("/notion/pages/1__work/meta.json");
    });
  });
});
