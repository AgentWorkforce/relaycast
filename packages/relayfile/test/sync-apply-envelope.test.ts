import { describe, expect, it, vi } from "vitest";
import {
  applyEnvelope,
  deadLetterEnvelope,
  handleSyncRefresh,
  handleSyncWebhookHealth,
  type EnvelopeMessage,
  type SyncHandlerContext,
} from "../src/durable-objects/handlers/sync.js";
import { refreshWorkspaceDigests } from "../src/durable-objects/digest.js";
import type { SyncProviderStatus } from "../src/types.js";

// Regression tests for fix/rev-bump-atomicity.
//
// Production failure mode (workspace rw_91c99e4d, verified live):
//
//   1. applyEnvelope calls nextRevision() → SQL meta write (rev_96), staged
//      in the implicit DO transaction.
//   2. applyEnvelope calls putObject() → R2 has @rev_96 → contentA
//      (NOT transactional).
//   3. SQL upsert into files: rev=rev_96, content_ref=…@rev_96 (staged).
//   4. insertEvent → broadcast() over WebSocket: daemon now believes
//      rev_96 = hash(contentA) (NOT transactional).
//   5. updateProviderStatus / bumpIngressMetric / syncWorkspaceStats throws
//      "Durable Object overloaded".
//
// On (5), the DO request handler's implicit transaction rolls back: the
// rev counter rewinds to 95, and the files row reverts. R2 still has
// @rev_96 → contentA, and the daemon still has the WS event.
//
// The next envelope on the same path then calls nextRevision() and gets
// rev_96 AGAIN (counter rewound). putObject overwrites @rev_96 with
// contentB. SQL upsert commits with content_ref=…@rev_96 (now contentB).
// The daemon already received an event for rev_96 and never re-fetches —
// cloud and daemon both call it rev_96 but point at different content.

type CallLog = string[];

type Storage = {
  meta: Map<string, string>;
  files: Map<string, Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  durableMeta: Map<string, string>;
  durableFiles: Map<string, Record<string, unknown>>;
  durableEvents: Array<Record<string, unknown>>;
  r2: Map<string, string>;
  broadcasts: Array<{
    revision: string;
    path: string;
    type?: string;
    origin?: string;
  }>;
};

function createStorage(): Storage {
  return {
    meta: new Map(),
    files: new Map(),
    events: [],
    durableMeta: new Map(),
    durableFiles: new Map(),
    durableEvents: [],
    r2: new Map(),
    broadcasts: [],
  };
}

/**
 * Test analogue of `WorkspaceDO.runDueDigestRefresh`. Tests that want to
 * assert the *content* of the regenerated digest (rather than just the
 * scheduling intent) pass this as the fixture's `scheduleDigestRefresh`,
 * which runs `refreshWorkspaceDigests` synchronously instead of arming an
 * alarm. The thunk indirection lets the closure capture the surrounding
 * `context` that's still being constructed at the call site.
 */
function runDigestRefreshInline(
  getContext: () => SyncHandlerContext,
): SyncHandlerContext["scheduleDigestRefresh"] {
  return async (options) => {
    const ctx = getContext();
    await refreshWorkspaceDigests(
      ctx as unknown as Parameters<typeof refreshWorkspaceDigests>[0],
      "ws_test",
      {
        ...options,
        timeZone: ctx.bindings.RELAYFILE_DIGEST_TIMEZONE,
      },
    );
  };
}

// Tiny in-memory SQL stub that knows just enough about the queries
// applyEnvelope issues to model the read-your-writes behavior + the
// monotonic ON CONFLICT guard.
function createSql(storage: Storage, log: CallLog) {
  return {
    exec(query: string, ...bindings: unknown[]) {
      log.push("sql.exec");
      const trimmed = query.trim();
      if (trimmed.startsWith("INSERT INTO meta")) {
        const [key, value] = bindings as [string, string];
        storage.meta.set(key, value);
        return { toArray: () => [] };
      }
      if (trimmed.startsWith("SELECT value FROM meta WHERE key = ?")) {
        const [key] = bindings as [string];
        const value = storage.meta.get(key) ?? null;
        return {
          one: () => (value === null ? null : { value }),
          toArray: () => (value === null ? [] : [{ value }]),
        };
      }
      if (trimmed.startsWith("INSERT INTO files")) {
        const path = bindings[0] as string;
        const incomingRev = bindings[1] as string;
        const existing = storage.files.get(path);
        // Mirror the CASE-based monotonic guard: only overwrite when the
        // incoming revision is strictly greater (string compare matches
        // the SQL CASE because revisions are zero-padded by virtue of
        // being prefixed counters, but we use numeric compare here for
        // the test — applyEnvelope's revs look like "rev_<n>").
        if (existing) {
          const incomingN = parseRev(incomingRev);
          const existingN = parseRev(existing.revision as string);
          if (incomingN <= existingN) {
            return { toArray: () => [] };
          }
        }
        storage.files.set(path, {
          path,
          revision: incomingRev,
          content_type: bindings[2],
          content_ref: bindings[3],
          size: bindings[4],
          encoding: bindings[5],
          updated_at: bindings[6],
          semantics_json: bindings[7],
          provider: bindings[8],
          provider_object_id: bindings[9],
          content_hash: bindings[10],
        });
        return { toArray: () => [] };
      }
      if (trimmed.startsWith("INSERT INTO events")) {
        storage.events.push({
          event_id: bindings[0],
          type: bindings[1],
          path: bindings[2],
          revision: bindings[3],
          origin: bindings[4],
          provider: bindings[5],
          correlation_id: bindings[6],
          timestamp: bindings[7],
        });
        return { toArray: () => [] };
      }
      if (trimmed.startsWith("DELETE FROM files")) {
        const [path, revision] = bindings as [string, string | undefined];
        if (!revision) {
          storage.files.delete(path);
          return { toArray: () => [] };
        }
        const existing = storage.files.get(path);
        if (
          existing &&
          parseRev(revision) > parseRev(existing.revision as string)
        ) {
          storage.files.delete(path);
        }
        return { toArray: () => [] };
      }
      return { toArray: () => [] };
    },
  };
}

function parseRev(rev: string): number {
  const m = /^rev_(\d+)$/.exec(rev);
  return m ? Number.parseInt(m[1], 10) : 0;
}

// Simulates the implicit DO transaction: SQL writes since the last
// flushStorage are pending; on rollback they're discarded; on flush they
// become durable.
function commitPending(storage: Storage) {
  storage.durableMeta = new Map(storage.meta);
  storage.durableFiles = new Map(storage.files);
  storage.durableEvents = [...storage.events];
}

function rollbackPending(storage: Storage) {
  storage.meta = new Map(storage.durableMeta);
  storage.files = new Map(storage.durableFiles);
  storage.events = [...storage.durableEvents];
}

function createContext(
  storage: Storage,
  log: CallLog,
  overrides: {
    putObject?: SyncHandlerContext["putObject"];
    syncWorkspaceStats?: SyncHandlerContext["syncWorkspaceStats"];
    touchWorkspaceWriteStats?: SyncHandlerContext["touchWorkspaceWriteStats"];
    updateProviderStatus?: SyncHandlerContext["updateProviderStatus"];
    bumpIngressMetric?: SyncHandlerContext["bumpIngressMetric"];
    scheduleDigestRefresh?: SyncHandlerContext["scheduleDigestRefresh"];
  } = {},
): SyncHandlerContext {
  const sql = createSql(storage, log);

  const nextId = (prefix: "rev" | "evt" | "op") => {
    const key = `counter:${prefix}`;
    const cursor = sql.exec("SELECT value FROM meta WHERE key = ?", key);
    const row = (cursor as { one?: () => { value: string } | null }).one?.();
    const current = Number.parseInt(row?.value ?? "0", 10) || 0;
    const next = current + 1;
    sql.exec(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      String(next),
    );
    return `${prefix}_${next}`;
  };

  const allRows = ((query: string, ...bindings: unknown[]) => {
    if (query.includes("SELECT path") && query.includes("FROM files")) {
      if (bindings.length >= 3 && query.includes("path >= ?")) {
        const [lower, upper, limit] = bindings as [string, string, number];
        return Array.from(storage.files.values())
          .filter(
            (row) => String(row.path) >= lower && String(row.path) < upper,
          )
          .sort((a, b) => String(a.path).localeCompare(String(b.path)))
          .slice(0, limit)
          .map((row) => ({ ...row }));
      }

      const [likePattern, indexPath, byPattern] = bindings as [
        string,
        string,
        string,
      ];
      const prefix = likePattern.replace(/%\.json$/u, "");
      const byPrefix = byPattern.replace(/%$/u, "");
      return [...storage.files.keys()]
        .filter(
          (path) =>
            path.startsWith(prefix) &&
            path.endsWith(".json") &&
            path !== indexPath &&
            !path.startsWith(byPrefix),
        )
        .sort()
        .map((path) => ({ path }));
    }

    if (query.includes("FROM events")) {
      const [from, to] = bindings as [string, string];
      return storage.events
        .filter(
          (event) =>
            String(event.timestamp) >= from &&
            String(event.timestamp) < to &&
            !String(event.path).startsWith("/digests/"),
        )
        .map((event) => ({
          event_id: event.event_id,
          type: event.type,
          path: event.path,
          revision: event.revision,
          origin: event.origin,
          provider: event.provider,
          correlation_id: event.correlation_id,
          timestamp: event.timestamp,
        }));
    }

    if (query.includes("SELECT DISTINCT provider")) {
      const providers = new Set<string>();
      for (const [path, file] of storage.files.entries()) {
        const provider = file.provider;
        if (
          !path.startsWith("/digests/") &&
          typeof provider === "string" &&
          provider
        ) {
          providers.add(provider);
        }
      }
      return [...providers].sort().map((provider) => ({ provider }));
    }

    return [];
  }) as SyncHandlerContext["allRows"];

  return {
    bindings: {
      CONTENT_BUCKET: {
        delete: vi.fn(async (contentRef: string) => {
          storage.r2.delete(contentRef);
        }),
      } as unknown as R2Bucket,
      ENVELOPE_QUEUE: {} as unknown as Queue,
    },
    sql,
    readJson: async <T>() => ({}) as T,
    requireWorkspaceId: async () => "ws_test",
    resolveWorkspaceId: async () => "ws_test",
    correlationId: () => "corr_test",
    json: () => new Response(),
    errorResponse: () => new Response(),
    allRows,
    sqlExec: (query: string, ...bindings: unknown[]) => {
      sql.exec(query, ...bindings);
    },
    d1Run: async () => undefined,
    d1First: async () => null,
    d1All: async () => [],
    ensureWorkspaceStats: async () => undefined,
    loadWorkspaceStats: async () => ({ providerStatus: {} }),
    buildSyncProviders: async () => [],
    buildIngressStatus: async () =>
      ({
        workspaceId: "ws_test",
        providers: [],
      }) as never,
    bumpIngressMetric:
      overrides.bumpIngressMetric ??
      (async () => {
        log.push("bumpIngressMetric");
      }),
    updateProviderStatus:
      overrides.updateProviderStatus ??
      (async () => {
        log.push("updateProviderStatus");
      }),
    syncWorkspaceStats:
      overrides.syncWorkspaceStats ??
      (async () => {
        log.push("syncWorkspaceStats");
      }),
    touchWorkspaceWriteStats:
      overrides.touchWorkspaceWriteStats ??
      (async () => {
        log.push("touchWorkspaceWriteStats");
      }),
    nextId,
    getFileRow: (path: string) => {
      const row = storage.files.get(path);
      if (!row) return null;
      return {
        path: row.path as string,
        revision: row.revision as string,
        contentType: row.content_type as string,
        contentRef: row.content_ref as string,
        size: row.size as number,
        encoding: row.encoding as "utf-8" | "base64",
        updatedAt: row.updated_at as string,
        semantics: {},
        provider: row.provider as string,
        providerObjectId: row.provider_object_id as string,
        contentHash: row.content_hash as string,
      } as never;
    },
    toCoreFileRow: (file) => file as never,
    contentRef: (workspaceId, path, revision) =>
      `content/${workspaceId}${path}@${revision}`,
    loadContent: async (contentRef) => storage.r2.get(contentRef) ?? "",
    putObject:
      overrides.putObject ??
      (async (contentRef, content) => {
        log.push(`putObject:${contentRef}`);
        storage.r2.set(contentRef, content as string);
      }),
    deleteContent: (contentRef: string) => {
      storage.r2.delete(contentRef);
    },
    insertEvent: (event, options) => {
      log.push(
        `insertEvent:${event.path}:broadcast=${options?.broadcast !== false}`,
      );
      // Mirror the real impl: SQL row first, optional broadcast.
      // (We only log for the broadcast distinction; the SQL write is
      // exercised by the real handler via context.sql.)
      storage.events.push({
        event_id: event.eventId,
        type: event.type,
        path: event.path,
        revision: event.revision,
        origin: event.origin,
        provider: event.provider ?? "",
        correlation_id: event.correlationId ?? "",
        timestamp: event.timestamp,
      });
      if (options?.broadcast !== false) {
        storage.broadcasts.push({
          revision: event.revision,
          path: event.path,
          type: event.type,
          origin: event.origin,
        });
      }
    },
    broadcastEvent: (event) => {
      log.push(`broadcastEvent:${event.path}`);
      storage.broadcasts.push({
        revision: event.revision,
        path: event.path,
        type: event.type,
        origin: event.origin,
      });
    },
    flushStorage: async () => {
      log.push("flushStorage");
      commitPending(storage);
    },
    // Digest regeneration is deferred to the DO alarm (cloud#846). The
    // default fixture just logs the call so most tests can assert deferral
    // semantics without exercising the alarm itself. Tests that need the
    // actual digest CONTENT pass an override (e.g. `runDigestRefreshInline`)
    // that runs `refreshWorkspaceDigests` synchronously — the same code
    // the real `WorkspaceDO.runDueDigestRefresh` runs.
    scheduleDigestRefresh:
      overrides.scheduleDigestRefresh ??
      (async (options) => {
        log.push(
          `scheduleDigestRefresh:${options.changedPaths.join(",") || "(none)"}`,
        );
      }),
  };
}

it("sync refresh rebuilds Linear team and project indexes from canonical files", async () => {
  const storage = createStorage();
  const log: CallLog = [];
  storage.meta.set("counter:rev", "4");
  storage.durableMeta.set("counter:rev", "4");
  storage.files.set("/linear/teams/_index.json", {
    path: "/linear/teams/_index.json",
    revision: "rev_1",
    content_type: "application/json; charset=utf-8",
    content_ref: "content/ws_test/linear/teams/_index.json@rev_1",
    size: 3,
    encoding: "utf-8",
    updated_at: "2026-05-20T00:00:00.000Z",
    semantics_json: "{}",
    provider: "linear",
    provider_object_id: "",
    content_hash: "",
  });
  storage.r2.set("content/ws_test/linear/teams/_index.json@rev_1", "[]\n");
  storage.files.set("/linear/teams/team-1.json", {
    path: "/linear/teams/team-1.json",
    revision: "rev_2",
    content_type: "application/json",
    content_ref: "content/ws_test/linear/teams/team-1.json@rev_2",
    size: 1,
    encoding: "utf-8",
    updated_at: "2026-05-20T10:00:00.000Z",
    semantics_json: "{}",
    provider: "linear",
    provider_object_id: "team-1",
    content_hash: "",
  });
  storage.r2.set(
    "content/ws_test/linear/teams/team-1.json@rev_2",
    JSON.stringify({
      id: "team-1",
      key: "AR",
      name: "Agent Relay",
      updatedAt: "2026-05-20T10:00:00.000Z",
    }),
  );
  storage.files.set("/linear/projects/_index.json", {
    path: "/linear/projects/_index.json",
    revision: "rev_3",
    content_type: "application/json; charset=utf-8",
    content_ref: "content/ws_test/linear/projects/_index.json@rev_3",
    size: 3,
    encoding: "utf-8",
    updated_at: "2026-05-20T00:00:00.000Z",
    semantics_json: "{}",
    provider: "linear",
    provider_object_id: "",
    content_hash: "",
  });
  storage.r2.set("content/ws_test/linear/projects/_index.json@rev_3", "[]\n");
  storage.files.set("/linear/projects/project-1.json", {
    path: "/linear/projects/project-1.json",
    revision: "rev_4",
    content_type: "application/json",
    content_ref: "content/ws_test/linear/projects/project-1.json@rev_4",
    size: 1,
    encoding: "utf-8",
    updated_at: "2026-05-21T10:00:00.000Z",
    semantics_json: "{}",
    provider: "linear",
    provider_object_id: "project-1",
    content_hash: "",
  });
  storage.r2.set(
    "content/ws_test/linear/projects/project-1.json@rev_4",
    JSON.stringify({
      provider: "linear",
      objectType: "project",
      objectId: "project-1",
      payload: {
        id: "project-1",
        name: "Pear Launch",
        updatedAt: "2026-05-21T10:00:00.000Z",
      },
    }),
  );

  const context = createContext(storage, log);
  context.readJson = async <T>() =>
    ({
      provider: "linear",
      reason: "certify #175",
    }) as T;
  context.json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  const response = await handleSyncRefresh(
    context,
    new Request("https://relayfile.test/v1/workspaces/ws_test/sync/refresh", {
      method: "POST",
    }),
  );

  expect(response.status).toBe(202);
  expect(
    JSON.parse(
      storage.r2.get(
        storage.files.get("/linear/teams/_index.json")?.content_ref as string,
      ) ?? "null",
    ),
  ).toEqual([
    {
      id: "team-1",
      title: "Agent Relay",
      updated: "2026-05-20T10:00:00.000Z",
    },
  ]);
  expect(
    JSON.parse(
      storage.r2.get(
        storage.files.get("/linear/projects/_index.json")
          ?.content_ref as string,
      ) ?? "null",
    ),
  ).toEqual([
    {
      id: "project-1",
      title: "Pear Launch",
      updated: "2026-05-21T10:00:00.000Z",
    },
  ]);
  expect(storage.events.map((event) => event.path)).toEqual([
    "/linear/teams/_index.json",
    "/linear/projects/_index.json",
  ]);
  expect(log).toContain(
    "scheduleDigestRefresh:/linear/teams/_index.json,/linear/projects/_index.json",
  );
});

function fileEnvelope(
  path: string,
  content: string,
  deliveryId = "d_1",
  timestamp = "2025-01-01T00:00:00.000Z",
): EnvelopeMessage {
  return {
    envelopeId: `env_${deliveryId}`,
    workspaceId: "ws_test",
    provider: "notion",
    deliveryId,
    receivedAt: timestamp,
    correlationId: `corr_${deliveryId}`,
    headers: {},
    payload: {
      event_type: "file.updated",
      path,
      data: {
        content,
        contentType: "text/markdown",
        encoding: "utf-8",
      },
      timestamp,
    },
  };
}

function deleteEnvelope(
  path: string,
  deliveryId = "delete_1",
  timestamp = "2025-01-01T00:00:00.000Z",
): EnvelopeMessage {
  return {
    envelopeId: `env_${deliveryId}`,
    workspaceId: "ws_test",
    provider: "notion",
    deliveryId,
    receivedAt: timestamp,
    correlationId: `corr_${deliveryId}`,
    headers: {},
    payload: {
      event_type: "file.deleted",
      path,
      timestamp,
    },
  };
}

function slackFileEnvelope(
  path: string,
  content: string,
  eventType: "file.created" | "file.updated" = "file.updated",
  deliveryId = "slack_1",
  timestamp = "2026-06-07T20:00:00.000Z",
): EnvelopeMessage {
  return {
    envelopeId: `env_${deliveryId}`,
    workspaceId: "ws_test",
    provider: "slack",
    deliveryId,
    receivedAt: timestamp,
    correlationId: `corr_${deliveryId}`,
    headers: {},
    payload: {
      event_type: eventType,
      path,
      data: {
        content,
        contentType: "application/json",
        encoding: "utf-8",
      },
      timestamp,
    },
  };
}

function slackDeleteEnvelope(
  path: string,
  deliveryId = "slack_delete_1",
  timestamp = "2026-06-07T20:00:00.000Z",
): EnvelopeMessage {
  return {
    envelopeId: `env_${deliveryId}`,
    workspaceId: "ws_test",
    provider: "slack",
    deliveryId,
    receivedAt: timestamp,
    correlationId: `corr_${deliveryId}`,
    headers: {},
    payload: {
      event_type: "file.deleted",
      path,
      timestamp,
    },
  };
}

describe("applyEnvelope atomicity (fix/rev-bump-atomicity)", () => {
  it("flushes the rev counter before R2, INSERTs files row after R2, and broadcasts last", async () => {
    const storage = createStorage();
    const log: CallLog = [];
    const context = createContext(storage, log);

    await applyEnvelope(context, fileEnvelope("/notes.md", "contentA"));

    // Order assertions (PR #460 review fix — Codex P1):
    //   1. flushStorage(burn rev counter) BEFORE putObject — so a putObject
    //      throw cannot leave a row pointing at a missing R2 object, and a
    //      later rollback cannot rewind the rev counter and reuse rev_N.
    //   2. putObject BEFORE the files-row INSERT — so a putObject failure
    //      means cloud's view of the file never advances.
    //   3. flushStorage AGAIN BEFORE broadcast — so SQL is durable when the
    //      daemon receives the WS event.
    //   4. broadcast LAST — daemons fetching content find it in R2.
    const firstFlushIdx = log.indexOf("flushStorage");
    const putObjectIdx = log.findIndex((x) => x.startsWith("putObject:"));
    const broadcastIdx = log.indexOf("broadcastEvent:/notes.md");
    const sourceInsertEventIdx = log.indexOf(
      "insertEvent:/notes.md:broadcast=false",
    );
    const flushBeforeBroadcastIdx = log.findIndex(
      (entry, index) =>
        index > sourceInsertEventIdx &&
        index < broadcastIdx &&
        entry === "flushStorage",
    );

    expect(firstFlushIdx).toBeGreaterThan(-1);
    expect(putObjectIdx).toBeGreaterThan(-1);
    expect(flushBeforeBroadcastIdx).toBeGreaterThan(firstFlushIdx);
    expect(broadcastIdx).toBeGreaterThan(-1);
    expect(sourceInsertEventIdx).toBeGreaterThan(-1);

    // First flush burns the rev counter BEFORE R2 put
    expect(firstFlushIdx).toBeLessThan(putObjectIdx);
    // R2 put comes BEFORE the event-row INSERT (and the files-row INSERT
    // that precedes it)
    expect(putObjectIdx).toBeLessThan(sourceInsertEventIdx);
    // Final flush commits files + events BEFORE broadcast
    expect(sourceInsertEventIdx).toBeLessThan(flushBeforeBroadcastIdx);
    expect(flushBeforeBroadcastIdx).toBeLessThan(broadcastIdx);

    // No event was broadcast as part of insertEvent (every insertEvent
    // call passed broadcast: false during the SQL-staging pass).
    expect(log.some((entry) => entry.endsWith(":broadcast=true"))).toBe(false);
  });

  it("does not roll back rev counter or files row when incremental stats writes throw", async () => {
    const storage = createStorage();
    const log: CallLog = [];

    // Simulate the production failure: stats writes throw "Durable
    // Object overloaded" after the broadcast was originally fired.
    const context = createContext(storage, log, {
      touchWorkspaceWriteStats: async () => {
        log.push("touchWorkspaceWriteStats:throw");
        throw new Error("Durable Object overloaded");
      },
    });

    // In the original buggy code path, this call would have left R2 with
    // @rev_1 → contentA and a broadcast for rev_1 even though the SQL
    // transaction was about to roll back. The fix wraps stats writes in
    // try/catch so they cannot reach the request boundary.
    await expect(
      applyEnvelope(context, fileEnvelope("/notes.md", "contentA")),
    ).resolves.toBeUndefined();

    // Stats failure was swallowed.
    expect(log).toContain("touchWorkspaceWriteStats:throw");

    // The rev counter, files row, and event row are durable. Post-cloud#846
    // the rev counter advances ONLY for the inline source write (1) — the
    // five default digest windows are no longer regenerated on the sync
    // critical path (they run on the DO alarm), so previously this value
    // was rev_6 (1 source + 5 digest windows).
    expect(storage.durableMeta.get("counter:rev")).toBe("1");
    expect(storage.durableFiles.get("/notes.md")?.revision).toBe("rev_1");
    expect(storage.durableEvents.length).toBeGreaterThan(0);

    // R2 + broadcast are aligned with the durable SQL state. The digest
    // refresh is scheduled (not run inline), so the only R2 object the
    // sync path produces is the source content itself.
    expect(storage.r2.has("content/ws_test/notes.md@rev_1")).toBe(true);
    const sourceBroadcasts = storage.broadcasts.filter(
      (broadcast) => broadcast.path === "/notes.md",
    );
    expect(sourceBroadcasts).toHaveLength(1);
    expect(sourceBroadcasts[0]?.revision).toBe("rev_1");
  });

  it("uses incremental stats deltas instead of a full workspace stats rollup", async () => {
    const storage = createStorage();
    const log: CallLog = [];
    const statTouches: unknown[] = [];
    const context = createContext(storage, log, {
      syncWorkspaceStats: async () => {
        throw new Error("full stats rollup should not run");
      },
      touchWorkspaceWriteStats: async (_workspaceId, overrides) => {
        statTouches.push(overrides);
        log.push("touchWorkspaceWriteStats");
      },
    });

    await applyEnvelope(context, fileEnvelope("/notes.md", "abc", "create_1"));
    await applyEnvelope(
      context,
      fileEnvelope("/notes.md", "abcdef", "update_1"),
    );
    await applyEnvelope(context, deleteEnvelope("/notes.md", "delete_1"));

    expect(log).not.toContain("syncWorkspaceStats");
    expect(statTouches).toEqual([
      expect.objectContaining({
        fileCountDelta: 1,
        bytesStoredDelta: 3,
        lastEventAt: "2025-01-01T00:00:00.000Z",
        lastActivity: "2025-01-01T00:00:00.000Z",
      }),
      expect.objectContaining({
        fileCountDelta: 0,
        bytesStoredDelta: 3,
      }),
      expect.objectContaining({
        fileCountDelta: -1,
        bytesStoredDelta: -6,
      }),
    ]);
  });

  it("counts delete stats for existing legacy rows with empty content refs", async () => {
    const storage = createStorage();
    storage.files.set("/legacy.md", {
      path: "/legacy.md",
      revision: "rev_0",
      content_type: "text/markdown",
      content_ref: "",
      size: 11,
      encoding: "utf-8",
      updated_at: "2024-12-31T00:00:00.000Z",
      semantics_json: "{}",
      provider: "notion",
      provider_object_id: "",
      content_hash: "",
    });
    commitPending(storage);

    const statTouches: unknown[] = [];
    const context = createContext(storage, [], {
      touchWorkspaceWriteStats: async (_workspaceId, overrides) => {
        statTouches.push(overrides);
      },
    });

    await applyEnvelope(context, deleteEnvelope("/legacy.md", "delete_legacy"));

    expect(storage.durableFiles.has("/legacy.md")).toBe(false);
    expect(statTouches).toEqual([
      expect.objectContaining({
        fileCountDelta: -1,
        bytesStoredDelta: -11,
      }),
    ]);
  });

  it("does not fail provider sync writes when deferred digest scheduling fails after the file write", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const storage = createStorage();
      const log: CallLog = [];
      const context = createContext(storage, log, {
        scheduleDigestRefresh: async () => {
          log.push("scheduleDigestRefresh:throw");
          throw new Error("alarm storage unavailable");
        },
      });

      await expect(
        applyEnvelope(context, fileEnvelope("/notes.md", "contentA")),
      ).resolves.toBeUndefined();

      expect(log).toContain("scheduleDigestRefresh:throw");
      expect(storage.durableFiles.get("/notes.md")?.revision).toBe("rev_1");
      expect(storage.r2.has("content/ws_test/notes.md@rev_1")).toBe(true);
      expect(storage.broadcasts).toEqual([
        expect.objectContaining({ path: "/notes.md", revision: "rev_1" }),
      ]);
      expect(consoleError).toHaveBeenCalledWith(
        "maybeRefreshWorkspaceDigests: schedule failed",
        expect.any(Error),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("does not broadcast when the files-row INSERT throws after R2 put succeeded", async () => {
    // PR #460 review (Codex P1): putObject now runs BEFORE the files-row
    // INSERT so a put failure can't leave a row pointing at a missing
    // object. The trade-off is that an INSERT failure leaks an orphan R2
    // object — but that's recoverable (GC) and never causes readers to see
    // empty content for an existing rev. Critical safety property: even
    // when the INSERT throws, the broadcast must NOT fire (otherwise the
    // daemon would receive a rev that cloud's files row never recorded).
    const storage = createStorage();
    const log: CallLog = [];

    let putObjectCalled = false;
    const context = createContext(storage, log, {
      putObject: async () => {
        putObjectCalled = true;
      },
    });

    // Force the SQL exec to throw on the files INSERT (simulating an
    // unexpected SQL failure after the R2 put has already landed).
    const originalExec = context.sql.exec.bind(context.sql);
    context.sql.exec = (query: string, ...bindings: unknown[]) => {
      if (query.trim().startsWith("INSERT INTO files")) {
        throw new Error("simulated SQL failure");
      }
      return originalExec(query, ...bindings) as never;
    };

    await expect(
      applyEnvelope(context, fileEnvelope("/notes.md", "contentA")),
    ).rejects.toThrow("simulated SQL failure");

    // putObject ran (it's now sequenced before the INSERT) — the orphan is
    // acceptable because the files row never recorded the new rev.
    expect(putObjectCalled).toBe(true);
    // But the broadcast must NOT have fired — that's the safety property.
    expect(storage.broadcasts).toHaveLength(0);
  });

  it("the deferred digest refresh (when the DO alarm fires) covers the processing date during old envelope replay", async () => {
    // Pre-cloud#846 the sync apply path regenerated digests inline. The
    // refresh now runs on the DO alarm — this test simulates the alarm
    // firing by having the fixture's `scheduleDigestRefresh` call
    // `refreshWorkspaceDigests` synchronously, which is the same code the
    // real `WorkspaceDO.runDueDigestRefresh` runs. The assertion is the
    // same property the original test guarded: the refreshed digest is
    // anchored to TODAY's processing date, not the envelope timestamp.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00.000Z"));
    try {
      const storage = createStorage();
      const log: CallLog = [];
      const context = createContext(storage, log, {
        scheduleDigestRefresh: runDigestRefreshInline(() => context),
      });

      await applyEnvelope(context, fileEnvelope("/notes.md", "contentA"));

      const todayEntry = [...storage.r2.entries()].find(([key]) =>
        key.includes("/digests/today.md@"),
      );
      expect(todayEntry).toBeDefined();
      expect(todayEntry?.[1]).toContain("date: 2026-05-15");
      expect(todayEntry?.[1]).toContain("covers: today");
    } finally {
      vi.useRealTimers();
    }
  });

  it("the deferred digest refresh (when the DO alarm fires) captures dead-lettered envelopes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00.000Z"));
    try {
      const storage = createStorage();
      const log: CallLog = [];
      const context = createContext(storage, log, {
        scheduleDigestRefresh: runDigestRefreshInline(() => context),
      });

      await deadLetterEnvelope(
        context,
        fileEnvelope("/notes.md", "contentA", "dead_1"),
        "simulated provider failure",
      );

      const todayEntry = [...storage.r2.entries()].find(([key]) =>
        key.includes("/digests/today.md@"),
      );
      expect(todayEntry).toBeDefined();
      expect(todayEntry?.[1]).toContain(
        "- notes had a sync error - [/notes.md]",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks webhook delivery healthy when an envelope applies", async () => {
    const storage = createStorage();
    const log: CallLog = [];
    const providerUpdates: SyncProviderStatus[] = [];
    const context = createContext(storage, log, {
      updateProviderStatus: async (_workspaceId, _provider, updater) => {
        providerUpdates.push(
          updater({
            provider: "notion",
            status: "lagging",
          }),
        );
      },
    });

    await applyEnvelope(
      context,
      fileEnvelope(
        "/notes.md",
        "contentA",
        "healthy_1",
        "2026-05-20T10:37:00.000Z",
      ),
    );

    expect(providerUpdates.at(-1)).toMatchObject({
      provider: "notion",
      status: "healthy",
      webhookHealthy: true,
      webhookLastEventAt: "2026-05-20T10:37:00.000Z",
      webhookLastError: null,
    });
  });

  it("marks webhook delivery unhealthy when an envelope is dead-lettered", async () => {
    const storage = createStorage();
    const log: CallLog = [];
    const providerUpdates: SyncProviderStatus[] = [];
    const context = createContext(storage, log, {
      updateProviderStatus: async (_workspaceId, _provider, updater) => {
        providerUpdates.push(
          updater({
            provider: "notion",
            status: "healthy",
          }),
        );
      },
    });

    await deadLetterEnvelope(
      context,
      fileEnvelope("/notes.md", "contentA", "dead_health_1"),
      "simulated provider failure",
    );

    expect(providerUpdates.at(-1)).toMatchObject({
      provider: "notion",
      status: "error",
      lastError: "simulated provider failure",
      webhookHealthy: false,
      webhookLastError: "simulated provider failure",
    });
  });

  it("monotonic guard: an out-of-order older envelope does not clobber a newer files row", async () => {
    const storage = createStorage();
    const log: CallLog = [];
    const context = createContext(storage, log);

    // First envelope lands at rev_1 (contentA). Pre-cloud#846 the inline
    // digest refresh produced 5 additional revs (rev_2..rev_6, one per
    // default window) on this same write; the refresh is now deferred to
    // the DO alarm, so no /digests/* rows appear inline.
    await applyEnvelope(context, fileEnvelope("/notes.md", "contentA", "d_1"));
    expect(storage.durableFiles.get("/notes.md")?.revision).toBe("rev_1");
    const firstDigestRows = [...storage.durableFiles.entries()].filter(
      ([path]) => path.startsWith("/digests/"),
    );
    expect(firstDigestRows).toEqual([]);

    // Second envelope lands at rev_2 (contentB) — without inline digest
    // writes the rev counter advances by exactly 1 per envelope.
    await applyEnvelope(context, fileEnvelope("/notes.md", "contentB", "d_2"));
    expect(storage.durableFiles.get("/notes.md")?.revision).toBe("rev_2");

    // Now manually replay the SQL upsert for an *older* revision (rev_1)
    // with stale content. With the monotonic guard the row stays at
    // rev_2/contentB. Without the guard, the row would silently rewind.
    context.sql.exec(
      `
        INSERT INTO files (
          path, revision, content_type, content_ref, size, encoding, updated_at,
          semantics_json, provider, provider_object_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
          revision = CASE WHEN excluded.revision > files.revision
            THEN excluded.revision ELSE files.revision END,
          content_ref = CASE WHEN excluded.revision > files.revision
            THEN excluded.content_ref ELSE files.content_ref END
      `,
      "/notes.md",
      "rev_1",
      "text/markdown",
      "content/ws_test/notes.md@rev_1",
      8,
      "utf-8",
      "2025-01-01T00:00:00.000Z",
      "{}",
      "notion",
      "",
    );

    const row = storage.files.get("/notes.md");
    expect(row?.revision).toBe("rev_2");
    expect(row?.content_ref).toBe("content/ws_test/notes.md@rev_2");
  });

  it("monotonic guard: an older delete envelope does not remove a newer files row or broadcast a delete", async () => {
    const storage = createStorage();
    const log: CallLog = [];
    const context = createContext(storage, log);

    await applyEnvelope(
      context,
      fileEnvelope(
        "/notes.md",
        "contentA",
        "d_old",
        "2025-01-01T00:00:00.000Z",
      ),
    );
    await applyEnvelope(
      context,
      fileEnvelope(
        "/notes.md",
        "contentB",
        "d_new",
        "2025-01-02T00:00:00.000Z",
      ),
    );

    await applyEnvelope(
      context,
      deleteEnvelope("/notes.md", "older_delete", "2025-01-01T12:00:00.000Z"),
    );

    // Two source envelopes → rev_1 then rev_2 (digest refresh deferred to
    // the alarm, so the rev counter advances by exactly 1 per envelope).
    expect(storage.durableFiles.get("/notes.md")?.revision).toBe("rev_2");
    expect(
      storage.broadcasts.some(
        (event) => event.path === "/notes.md" && event.type === "file.deleted",
      ),
    ).toBe(false);
    expect(
      storage.durableEvents.some(
        (event) => event.path === "/notes.md" && event.type === "file.deleted",
      ),
    ).toBe(false);
  });

  it("stale guard: an older update envelope does not overwrite a newer files row", async () => {
    const storage = createStorage();
    const log: CallLog = [];
    const context = createContext(storage, log);

    await applyEnvelope(
      context,
      fileEnvelope(
        "/notes.md",
        "contentA",
        "d_old",
        "2025-01-01T00:00:00.000Z",
      ),
    );
    await applyEnvelope(
      context,
      fileEnvelope(
        "/notes.md",
        "contentB",
        "d_new",
        "2025-01-02T00:00:00.000Z",
      ),
    );
    const newer = storage.durableFiles.get("/notes.md");
    // Two source envelopes → rev_1 then rev_2 (digest refresh deferred).
    expect(newer?.revision).toBe("rev_2");
    expect(storage.r2.get("content/ws_test/notes.md@rev_1")).toBe("contentA");
    const fileUpdatedBroadcastsBeforeReplay = storage.broadcasts.filter(
      (event) => event.path === "/notes.md" && event.type === "file.updated",
    ).length;

    await applyEnvelope(
      context,
      fileEnvelope(
        "/notes.md",
        "contentA-replayed",
        "d_replay",
        "2025-01-01T01:00:00.000Z",
      ),
    );

    const row = storage.durableFiles.get("/notes.md");
    // The stale replay (older timestamp) must NOT win against the newer
    // rev_2; without the inline digest writes the latest rev is rev_2.
    expect(row?.revision).toBe("rev_2");
    expect(storage.r2.get(String(row?.content_ref))).toBe("contentB");
    expect(
      storage.broadcasts.filter(
        (event) => event.path === "/notes.md" && event.type === "file.updated",
      ).length,
    ).toBe(fileUpdatedBroadcastsBeforeReplay);
  });

  it("canonicalizes Slack provider-relative raw channel paths to existing channel aliases", async () => {
    const storage = createStorage();
    const log: CallLog = [];
    storage.files.set(
      "/slack/channels/C123__pear-pty-investigation/meta.json",
      {
        path: "/slack/channels/C123__pear-pty-investigation/meta.json",
        revision: "rev_1",
        content_type: "application/json",
        content_ref:
          "content/ws_test/slack/channels/C123__pear-pty-investigation/meta.json@rev_1",
        size: 2,
        encoding: "utf-8",
        updated_at: "2026-06-07T19:00:00.000Z",
        semantics_json: "{}",
        provider: "slack",
        provider_object_id: "C123",
        content_hash: "",
      },
    );
    commitPending(storage);
    const context = createContext(storage, log);

    await applyEnvelope(
      context,
      slackFileEnvelope(
        "/channels/C123/messages/1780862900_854659/meta.json",
        JSON.stringify({ text: "hello from Slack" }),
      ),
    );

    const aliasPath =
      "/slack/channels/C123__pear-pty-investigation/messages/1780862900_854659/meta.json";
    expect(storage.durableFiles.has(aliasPath)).toBe(true);
    expect(
      storage.durableFiles.has(
        "/slack/channels/C123/messages/1780862900_854659/meta.json",
      ),
    ).toBe(false);
    expect(storage.broadcasts.at(-1)).toMatchObject({
      path: aliasPath,
      origin: "provider_sync",
      type: "file.updated",
    });
    expect(storage.durableEvents.at(-1)).toMatchObject({
      path: aliasPath,
      origin: "provider_sync",
      type: "file.updated",
    });
  });

  it("persists Slack create events with the same channel alias path as the created file row", async () => {
    const storage = createStorage();
    const log: CallLog = [];
    storage.files.set(
      "/slack/channels/C123__pear-pty-investigation/meta.json",
      {
        path: "/slack/channels/C123__pear-pty-investigation/meta.json",
        revision: "rev_1",
        content_type: "application/json",
        content_ref:
          "content/ws_test/slack/channels/C123__pear-pty-investigation/meta.json@rev_1",
        size: 2,
        encoding: "utf-8",
        updated_at: "2026-06-07T19:00:00.000Z",
        semantics_json: "{}",
        provider: "slack",
        provider_object_id: "C123",
        content_hash: "",
      },
    );
    commitPending(storage);
    const context = createContext(storage, log);
    const aliasPath =
      "/slack/channels/C123__pear-pty-investigation/threads/1780871788_370329/replies/1780921813_531539.json";

    await applyEnvelope(
      context,
      slackFileEnvelope(
        "/channels/C123/threads/1780871788_370329/replies/1780921813_531539.json",
        JSON.stringify({ text: "new Slack reply" }),
        "file.created",
      ),
    );

    expect(storage.durableFiles.has(aliasPath)).toBe(true);
    expect(storage.durableEvents.at(-1)).toMatchObject({
      path: aliasPath,
      origin: "provider_sync",
      type: "file.created",
    });
    expect(storage.broadcasts.at(-1)).toMatchObject({
      path: aliasPath,
      origin: "provider_sync",
      type: "file.created",
    });
  });

  it("persists Slack delete events with the same channel alias path as the deleted file row", async () => {
    const storage = createStorage();
    const log: CallLog = [];
    storage.files.set(
      "/slack/channels/C123__pear-pty-investigation/meta.json",
      {
        path: "/slack/channels/C123__pear-pty-investigation/meta.json",
        revision: "rev_1",
        content_type: "application/json",
        content_ref:
          "content/ws_test/slack/channels/C123__pear-pty-investigation/meta.json@rev_1",
        size: 2,
        encoding: "utf-8",
        updated_at: "2026-06-07T19:00:00.000Z",
        semantics_json: "{}",
        provider: "slack",
        provider_object_id: "C123",
        content_hash: "",
      },
    );
    const aliasPath =
      "/slack/channels/C123__pear-pty-investigation/threads/1780871788_370329/replies/1780921813_531539.json";
    storage.files.set(aliasPath, {
      path: aliasPath,
      revision: "rev_0",
      content_type: "application/json",
      content_ref: `content/ws_test${aliasPath}@rev_0`,
      size: 2,
      encoding: "utf-8",
      updated_at: "2026-06-07T20:00:00.000Z",
      semantics_json: "{}",
      provider: "slack",
      provider_object_id: "",
      content_hash: "",
    });
    commitPending(storage);
    const context = createContext(storage, log);

    await applyEnvelope(
      context,
      slackDeleteEnvelope(
        "/channels/C123/threads/1780871788_370329/replies/1780921813_531539.json",
      ),
    );

    expect(storage.durableFiles.has(aliasPath)).toBe(false);
    expect(storage.durableEvents.at(-1)).toMatchObject({
      path: aliasPath,
      origin: "provider_sync",
      type: "file.deleted",
    });
    expect(storage.broadcasts.at(-1)).toMatchObject({
      path: aliasPath,
      origin: "provider_sync",
      type: "file.deleted",
    });
  });

  it("ignores Slack envelopes that target outside the Slack provider root", async () => {
    const storage = createStorage();
    const log: CallLog = [];
    const context = createContext(storage, log);

    await applyEnvelope(
      context,
      slackFileEnvelope(
        "/github/repos/AgentWorkforce/cloud/issues/1/meta.json",
        JSON.stringify({ title: "must not write" }),
      ),
    );

    expect(storage.durableFiles.size).toBe(0);
    expect(storage.durableEvents).toEqual([]);
    expect(storage.broadcasts).toEqual([]);
    expect([...storage.r2.keys()]).toEqual([]);
  });

  it("monotonic guard: a write that loses the files upsert does not emit events or digests", async () => {
    const storage = createStorage();
    const log: CallLog = [];
    const context = createContext(storage, log);
    storage.meta.set("counter:rev", "0");
    storage.meta.set("counter:evt", "0");
    storage.files.set("/notes.md", {
      path: "/notes.md",
      revision: "rev_99",
      content_type: "text/markdown",
      content_ref: "content/ws_test/notes.md@rev_99",
      size: 8,
      encoding: "utf-8",
      updated_at: "2025-01-01T00:00:00.000Z",
      semantics_json: "{}",
      provider: "github",
      provider_object_id: "",
      content_hash: "newer",
    });
    storage.r2.set("content/ws_test/notes.md@rev_99", "contentB");
    commitPending(storage);

    await applyEnvelope(
      context,
      fileEnvelope(
        "/notes.md",
        "contentA",
        "d_replay",
        "2025-01-02T00:00:00.000Z",
      ),
    );

    const row = storage.durableFiles.get("/notes.md");
    expect(row?.revision).toBe("rev_99");
    expect(row?.content_ref).toBe("content/ws_test/notes.md@rev_99");
    expect(storage.r2.has("content/ws_test/notes.md@rev_1")).toBe(false);
    expect(
      storage.durableEvents.some(
        (event) => event.path === "/notes.md" && event.revision === "rev_1",
      ),
    ).toBe(false);
    expect(
      storage.broadcasts.some(
        (event) => event.path === "/notes.md" && event.revision === "rev_1",
      ),
    ).toBe(false);
    expect(storage.durableFiles.has("/digests/today.md")).toBe(false);
    expect(storage.durableFiles.has("/digests/yesterday.md")).toBe(false);
  });

  it.each([
    ["file update", () => fileEnvelope("/teams/team_1/board.md", "contentA")],
    ["file delete", () => deleteEnvelope("/teams/team_1/board.md")],
  ] as const)(
    "ignores provider-sync %s envelopes for ctx.team shared subtrees",
    async (_name, makeEnvelope) => {
      const storage = createStorage();
      const log: CallLog = [];
      const context = createContext(storage, log);

      await applyEnvelope(context, makeEnvelope());

      expect(storage.durableFiles.has("/teams/team_1/board.md")).toBe(false);
      expect(
        storage.durableEvents.some((event) =>
          String(event.path).startsWith("/teams/"),
        ),
      ).toBe(false);
      expect(
        storage.broadcasts.some((event) => event.path.startsWith("/teams/")),
      ).toBe(false);
      expect(
        [...storage.r2.keys()].some((key) =>
          key.includes("/teams/team_1/board.md@"),
        ),
      ).toBe(false);
    },
  );
});

describe("handleSyncWebhookHealth", () => {
  it("marks a provider webhook healthy with the reported event timestamp", async () => {
    const storage = createStorage();
    const log: CallLog = [];
    let nextStatus: SyncProviderStatus | null = null;
    const context = createContext(storage, log, {
      updateProviderStatus: async (_workspaceId, _provider, updater) => {
        nextStatus = updater({
          provider: "google-mail",
          status: "lagging",
          webhookHealthy: false,
          webhookLastError: "previous trigger failed",
          lastError: "previous trigger failed",
        });
      },
    });
    context.readJson = async <T>() =>
      ({
        provider: "google-mail",
        healthy: true,
        eventAt: "2026-05-20T10:37:00.000Z",
        error: null,
      }) as T;
    context.json = (payload, status) => Response.json(payload, { status });

    const response = await handleSyncWebhookHealth(
      context,
      new Request(
        "https://relayfile.test/v1/workspaces/ws_test/sync/webhook-health",
      ),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      provider: "google-mail",
      webhookHealthy: true,
      webhookLastEventAt: "2026-05-20T10:37:00.000Z",
      webhookLastError: null,
    });
    expect(nextStatus).toMatchObject({
      provider: "google-mail",
      status: "lagging",
      lastError: null,
      webhookHealthy: true,
      webhookLastEventAt: "2026-05-20T10:37:00.000Z",
      webhookLastError: null,
    });
  });

  it("marks a provider webhook unhealthy when the trigger path fails", async () => {
    const storage = createStorage();
    const log: CallLog = [];
    let nextStatus: SyncProviderStatus | null = null;
    const context = createContext(storage, log, {
      updateProviderStatus: async (_workspaceId, _provider, updater) => {
        nextStatus = updater({
          provider: "google-mail",
          status: "healthy",
        });
      },
    });
    context.readJson = async <T>() =>
      ({
        provider: "google-mail",
        healthy: false,
        eventAt: "2026-05-20T10:38:00.000Z",
        error: "Nango trigger returned 502",
      }) as T;
    context.json = (payload, status) => Response.json(payload, { status });

    await handleSyncWebhookHealth(
      context,
      new Request(
        "https://relayfile.test/v1/workspaces/ws_test/sync/webhook-health",
      ),
    );

    expect(nextStatus).toMatchObject({
      provider: "google-mail",
      status: "error",
      lastError: "Nango trigger returned 502",
      webhookHealthy: false,
      webhookLastEventAt: "2026-05-20T10:38:00.000Z",
      webhookLastError: "Nango trigger returned 502",
    });
  });

  it("ignores stale webhook health reports", async () => {
    const storage = createStorage();
    const log: CallLog = [];
    let nextStatus: SyncProviderStatus | null = null;
    const context = createContext(storage, log, {
      updateProviderStatus: async (_workspaceId, _provider, updater) => {
        nextStatus = updater({
          provider: "google-mail",
          status: "healthy",
          lastError: null,
          webhookHealthy: true,
          webhookLastEventAt: "2026-05-20T10:40:00.000Z",
          webhookLastError: null,
        });
      },
    });
    context.readJson = async <T>() =>
      ({
        provider: "google-mail",
        healthy: false,
        eventAt: "2026-05-20T10:38:00.000Z",
        error: "late failure report",
      }) as T;
    context.json = (payload, status) => Response.json(payload, { status });

    const response = await handleSyncWebhookHealth(
      context,
      new Request(
        "https://relayfile.test/v1/workspaces/ws_test/sync/webhook-health",
      ),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      provider: "google-mail",
      webhookHealthy: true,
      webhookLastEventAt: "2026-05-20T10:40:00.000Z",
      webhookLastError: null,
    });
    expect(nextStatus).toMatchObject({
      provider: "google-mail",
      status: "healthy",
      lastError: null,
      webhookHealthy: true,
      webhookLastEventAt: "2026-05-20T10:40:00.000Z",
      webhookLastError: null,
    });
  });
});

// Hardening for the demo's onWrite flow.
//
// The cortical-demo orchestrator (and any agent using @relayfile/sdk's
// `onWrite(pattern, handler)`) subscribes via WebSocket to FilesystemEvent
// broadcasts emitted by the workspace DO. The default operation set the SDK
// matches against is ["create", "update"], which the dispatcher maps from
// event types `file.created` / `file.updated` only. If a server-side write
// (Notion/Linear/etc. webhook → Nango → cloud → applyEnvelope) ever stopped
// emitting those exact event types — e.g. the type drifted to "sync.applied"
// or got dropped from broadcastEvent — every onWrite subscriber would go
// silent without any test failing.
//
// This block pins the onWrite contract: applyEnvelope MUST broadcast a
// file.created (first write to a path) or file.updated (subsequent write)
// event with the path and revision the daemon and SDK expect. It does NOT
// re-test the atomicity ordering — that's covered above.
describe("applyEnvelope onWrite broadcast contract", () => {
  // Builds an envelope with an explicit event_type. fileEnvelope above
  // hardcodes "file.updated" because most of those tests don't care; here
  // we want to drive the create path explicitly.
  function fileEnvelopeWithType(
    eventType: "file.created" | "file.updated",
    path: string,
    content: string,
    deliveryId = "d_1",
  ): EnvelopeMessage {
    return {
      envelopeId: `env_${deliveryId}`,
      workspaceId: "ws_test",
      provider: "notion",
      deliveryId,
      receivedAt: "2025-01-01T00:00:00.000Z",
      correlationId: `corr_${deliveryId}`,
      headers: {},
      payload: {
        event_type: eventType,
        path,
        data: { content, contentType: "text/markdown", encoding: "utf-8" },
        timestamp: "2025-01-01T00:00:00.000Z",
      },
    };
  }

  it.each([
    ["file.created", "create"],
    ["file.updated", "update"],
  ] as const)(
    "broadcasts a %s event for a content write so onWrite can map it to op=%s",
    async (eventType, _operationLabel) => {
      const storage = createStorage();
      const log: CallLog = [];
      const context = createContext(storage, log);

      await applyEnvelope(
        context,
        fileEnvelopeWithType(
          eventType,
          "/notion/pages/calls/abc/transcript.md",
          "content",
        ),
      );

      const broadcast = storage.broadcasts.find(
        (item) => item.path === "/notion/pages/calls/abc/transcript.md",
      );
      expect(broadcast).toBeDefined();
      if (!broadcast) return;
      expect(broadcast.path).toBe("/notion/pages/calls/abc/transcript.md");
      expect(broadcast.revision).toMatch(/^rev_\d+$/);
      // The SDK's onWrite default operations set is { create, update },
      // mapped from these exact event-type strings. Drift here breaks
      // every subscriber silently — even though the file persists.
      expect(broadcast.type).toBe(eventType);
    },
  );

  it("never broadcasts a non-fs type for a content-bearing envelope", async () => {
    // Regression guard: if applyEnvelope ever started broadcasting a
    // sync-internal type (e.g. "sync.applied", "sync.suppressed") for a
    // content envelope instead of the file.* family, onWrite subscribers
    // using the default operation set would never see the write — even
    // though the file did get persisted.
    const storage = createStorage();
    const log: CallLog = [];
    const context = createContext(storage, log);

    await applyEnvelope(
      context,
      fileEnvelopeWithType("file.updated", "/linear/issues/ABC-1.json", "{}"),
    );

    expect(storage.broadcasts.length).toBeGreaterThan(0);
    for (const broadcast of storage.broadcasts) {
      expect(broadcast.type).toMatch(/^file\.(created|updated)$/);
    }
  });

  it("preserves the path and revision the daemon needs to fetch updated content", async () => {
    // The SDK's onWrite handler receives `path` and `revision` and the
    // mount daemon fetches @{revision} from R2 to reconcile. If broadcasts
    // ever lost either field, agents would receive vacuous events.
    const storage = createStorage();
    const log: CallLog = [];
    const context = createContext(storage, log);

    await applyEnvelope(
      context,
      fileEnvelopeWithType(
        "file.created",
        "/notion/pages/calls/abc/transcript.md",
        "content",
      ),
    );

    const broadcast = storage.broadcasts.find(
      (item) => item.path === "/notion/pages/calls/abc/transcript.md",
    );
    expect(broadcast).toBeDefined();
    if (!broadcast) return;
    expect(broadcast.path).toBe("/notion/pages/calls/abc/transcript.md");
    expect(broadcast.revision).toMatch(/^rev_\d+$/);
  });
});
