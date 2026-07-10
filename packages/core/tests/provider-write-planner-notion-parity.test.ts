import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  refreshWorkspaceDigests,
  type WorkspaceDigestContext,
} from "../../relayfile/src/durable-objects/digest.js";
import type {
  WorkspaceEvent,
  WorkspaceFile,
} from "../../relayfile/src/types.js";
import type { NangoSyncJob } from "../src/sync/nango-sync-job.js";
import {
  planProviderRecordWrites,
  providerModelKey,
  type PlannedRelayfileWrite,
} from "../src/sync/provider-write-planner.js";
import {
  writeBatchToRelayfile,
  type RelayfileWriteClient,
} from "../src/sync/record-writer.js";

type NotionModel = "NotionPage" | "NotionPageContent" | "NotionDatabase" | "NotionUser";

type CapturedOp = {
  op: "write" | "delete";
  path: string;
  contents?: string;
  contentType?: string;
  baseRevision?: string;
  semantics?: unknown;
};

type StoredDigest = {
  path: string;
  content: string;
  contentType: string;
  revision: string;
};

const pageId = "3586800c-1c90-80eb-aa52-ea4d88eb32d5";
const databaseId = "1f9c9d4e-1234-4abc-9def-abcdef012345";
const parentPageId = "90b6800c-1c90-80eb-aa52-ea4d88eb32d6";
const userId = "6f1a0a48-1111-4111-8111-abcdef012346";

function notionJob(model: NotionModel): NangoSyncJob {
  const syncName =
    model === "NotionDatabase"
      ? "fetch-databases"
      : model === "NotionUser"
        ? "fetch-users"
        : "fetch-pages";

  return {
    type: "nango_sync",
    workspaceId: "rw_test",
    provider: "notion",
    providerConfigKey: "notion-relay",
    connectionId: "conn_test",
    syncName,
    model,
    cursor: null,
    modifiedAfter: "1970-01-01T00:00:00.000Z",
  };
}

function createDigestContext(
  events: WorkspaceEvent[],
  initialContent = new Map<string, string>(),
): {
  context: WorkspaceDigestContext;
  stored: StoredDigest[];
} {
  const files = new Map<string, Partial<WorkspaceFile>>();
  const stored: StoredDigest[] = [];
  const insertedEvents: WorkspaceEvent[] = [];
  let revisionCounter = 0;
  let eventCounter = 100;

  const allRows = ((query: string, ...bindings: unknown[]) => {
    if (query.includes("FROM events")) {
      const [from, to, limit] = bindings as [
        string,
        string,
        number | undefined,
      ];
      const rows = events
        .concat(insertedEvents)
        .filter(
          (event) =>
            event.timestamp >= from &&
            event.timestamp < to &&
            !event.path.startsWith("/digests/"),
        )
        .sort((left, right) =>
          query.includes("ORDER BY timestamp DESC")
            ? right.timestamp.localeCompare(left.timestamp) ||
              right.eventId.localeCompare(left.eventId)
            : left.timestamp.localeCompare(right.timestamp) ||
              left.eventId.localeCompare(left.eventId),
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
    sqlExec(query: string, ...bindings: unknown[]) {
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
    },
    getFileRow(path: string) {
      return files.get(path) ?? null;
    },
    nextId(prefix: "rev" | "evt" | "op") {
      if (prefix === "evt") return `evt_${++eventCounter}`;
      if (prefix === "rev") return `rev_${++revisionCounter}`;
      return "op_1";
    },
    contentRef(_workspaceId: string, path: string, revision: string) {
      return `${path}@${revision}`;
    },
    async putObject(contentRef, content, _encoding, contentType) {
      const [path, revision] = contentRef.split("@") as [string, string];
      stored.push({ path, revision, content, contentType });
    },
    async loadContent(contentRef) {
      const storedContent = stored.find(
        (item) => `${item.path}@${item.revision}` === contentRef,
      );
      return storedContent?.content ?? initialContent.get(contentRef) ?? "";
    },
    async deleteContent() {},
    insertEvent(event) {
      insertedEvents.push(event as WorkspaceEvent);
    },
    broadcastEvent() {},
    async flushStorage() {},
  };

  return { context, stored };
}

function isContractPath(path: string): boolean {
  return (
    path === "/LAYOUT.md" ||
    path === "/notion/LAYOUT.md" ||
    path.startsWith("/discovery/")
  );
}

function planOps(writes: readonly PlannedRelayfileWrite[]): CapturedOp[] {
  return writes
    .filter((write) => !isContractPath(write.path))
    .map((write) => ({
      op: write.delete ? "delete" : "write",
      path: write.path,
      ...(write.contents !== undefined ? { contents: write.contents } : {}),
      ...(write.contentType ? { contentType: write.contentType } : {}),
      ...(write.baseRevision ? { baseRevision: write.baseRevision } : {}),
      ...(write.semantics ? { semantics: write.semantics } : {}),
    }));
}

function makeOracleClient(seed: Record<string, unknown> = {}): RelayfileWriteClient & {
  ops: CapturedOp[];
  files: Map<string, string>;
  revisions: Map<string, string>;
} {
  const files = new Map<string, string>();
  const revisions = new Map<string, string>();
  for (const [path, value] of Object.entries(seed)) {
    files.set(path, typeof value === "string" ? value : JSON.stringify(value));
    revisions.set(path, `rev:${path}`);
  }
  const ops: CapturedOp[] = [];
  return {
    ops,
    files,
    revisions,
    async writeFile(input) {
      ops.push({
        op: "write",
        path: input.path,
        contents: input.content,
        contentType: input.contentType,
        baseRevision: input.baseRevision,
        ...(input.semantics ? { semantics: input.semantics } : {}),
      });
      files.set(input.path, input.content);
      revisions.set(input.path, `rev:${input.path}`);
    },
    async deleteFile(input) {
      ops.push({
        op: "delete",
        path: input.path,
        baseRevision: input.baseRevision,
      });
      files.delete(input.path);
      revisions.delete(input.path);
    },
    async readFile(_workspaceId, path) {
      if (files.has(path)) {
        return { content: files.get(path), revision: revisions.get(path) };
      }
      const error = new Error("not found") as Error & { status: number };
      error.status = 404;
      throw error;
    },
  };
}

async function oracleOps(
  job: NangoSyncJob,
  records: readonly Record<string, unknown>[],
  seed: Record<string, unknown> = {},
): Promise<CapturedOp[]> {
  const client = makeOracleClient(seed);
  const result = await writeBatchToRelayfile(client, records, job, {
    concurrency: 1,
  });
  assert.equal(result.errors, 0);
  return client.ops.filter((op) => !isContractPath(op.path));
}

function plannedOps(
  job: NangoSyncJob,
  records: readonly Record<string, unknown>[],
  seed: Record<string, unknown> = {},
): CapturedOp[] {
  const existingFiles = new Map<string, string>();
  const existingRevisions = new Map<string, string>();
  for (const [path, value] of Object.entries(seed)) {
    existingFiles.set(path, typeof value === "string" ? value : JSON.stringify(value));
    existingRevisions.set(path, `rev:${path}`);
  }
  return planOps(
    planProviderRecordWrites(
      job,
      records,
      new Set([providerModelKey(job)]),
      { existingFiles, existingRevisions },
    ).writes,
  );
}

function plannedNotionWrite(
  job: NangoSyncJob,
  records: readonly Record<string, unknown>[],
  match: (write: PlannedRelayfileWrite) => boolean,
): PlannedRelayfileWrite {
  const write = planProviderRecordWrites(
    job,
    records,
    new Set([providerModelKey(job)]),
  ).writes.find((candidate) => !candidate.delete && match(candidate));
  assert.ok(write, "expected matching Notion planned write");
  assert.equal(typeof write.contents, "string");
  return write;
}

const notionPage = {
  id: pageId,
  title: "Roadmap",
  parent_type: "database",
  parent_id: databaseId,
  databaseId,
  databaseTitle: "Product Docs",
  last_edited_time: "2026-05-10T10:00:00.000Z",
  archived: false,
};

describe("Notion provider write planner parity", () => {
  it("matches the Node record-writer oracle for first-write page fanout", async () => {
    const job = notionJob("NotionPage");
    assert.deepEqual(plannedOps(job, [notionPage]), await oracleOps(job, [notionPage]));
  });

  it("matches the Node record-writer oracle for page content markdown writes", async () => {
    const job = notionJob("NotionPageContent");
    const records = [{
      id: pageId,
      pageId,
      content: "# Roadmap\n\nBody",
      contentHash: "hash-1",
      lastEditedTime: "2026-05-10T10:00:00.000Z",
    }];
    assert.deepEqual(plannedOps(job, records), await oracleOps(job, records));
  });

  it("matches the Node record-writer oracle for first-write database fanout", async () => {
    const job = notionJob("NotionDatabase");
    const records = [{
      id: databaseId,
      title: "Product Roadmap",
      last_edited_time: "2026-05-10T10:00:00.000Z",
    }];
    assert.deepEqual(plannedOps(job, records), await oracleOps(job, records));
  });

  it("matches the Node record-writer oracle for first-write user fanout", async () => {
    const job = notionJob("NotionUser");
    const records = [{
      id: userId,
      name: "Ada Lovelace",
      type: "person",
      last_edited_time: "2026-05-10T10:00:00.000Z",
    }];
    assert.deepEqual(plannedOps(job, records), await oracleOps(job, records));
  });

  it("matches stale timestamp behavior for page metadata", async () => {
    const job = notionJob("NotionPage");
    const seed = {
      [`/notion/pages/${pageId}/meta.json`]: {
        id: pageId,
        title: "Current",
        last_edited_time: "2026-05-15T12:00:00.000Z",
      },
    };
    const records = [{
      id: pageId,
      title: "Old",
      last_edited_time: "2026-05-14T12:00:00.000Z",
    }];
    assert.deepEqual(plannedOps(job, records, seed), await oracleOps(job, records, seed));
    assert.deepEqual(plannedOps(job, records, seed), []);
  });

  it("matches page title and parent alias cleanup against the Node oracle", async () => {
    const job = notionJob("NotionPage");
    const byIdPath = `/notion/pages/by-id/${pageId.replace(/-/g, "")}.json`;
    const seed = {
      [byIdPath]: {
        provider: "notion",
        objectType: "page",
        objectId: pageId,
        payload: {
          id: pageId,
          title: "Old Roadmap",
          parent_type: "page",
          parent_id: parentPageId,
          parent_title: "Parent",
          last_edited_time: "2026-05-10T10:00:00.000Z",
        },
      },
      [`/notion/pages/${pageId}/meta.json`]: {},
      "/notion/pages/by-title/old-roadmap__88eb32d5.json": {},
      "/notion/pages/by-parent/page-parent__88eb32d6/old-roadmap__88eb32d5.json": {},
      "/notion/pages/_index.json": [{
        id: pageId,
        title: "Old Roadmap",
        updated: "2026-05-10T10:00:00.000Z",
        parent_id: parentPageId,
        parent_type: "page",
      }],
    };
    const records = [{
      id: pageId,
      title: "New Roadmap",
      parent_type: "database",
      parent_id: databaseId,
      databaseId,
      databaseTitle: "Product Docs",
      last_edited_time: "2026-05-12T12:00:00.000Z",
    }];
    assert.deepEqual(plannedOps(job, records, seed), await oracleOps(job, records, seed));
  });

  it("matches delete tombstone and delete-not-found semantics", async () => {
    const job = notionJob("NotionDatabase");
    const tombstone = {
      id: databaseId,
      _nango_metadata: { last_action: "DELETED" },
    };
    const byIdPath = `/notion/databases/by-id/${databaseId.replace(/-/g, "")}.json`;
    const seed = {
      [`/notion/databases/${databaseId}/metadata.json`]: {},
      [byIdPath]: {
        provider: "notion",
        objectType: "database",
        objectId: databaseId,
        payload: { id: databaseId, title: "Product Roadmap" },
      },
      "/notion/databases/by-title/product-roadmap__ef012345.json": {},
      "/notion/databases/_index.json": [{
        id: databaseId,
        title: "Product Roadmap",
        updated: "2026-05-10T10:00:00.000Z",
        parent_id: null,
        parent_type: "workspace",
      }],
    };

    assert.deepEqual(plannedOps(job, [tombstone], seed), await oracleOps(job, [tombstone], seed));
    assert.deepEqual(plannedOps(job, [tombstone]), await oracleOps(job, [tombstone]));
  });

  it("keeps concurrency-independent tree output identical for Notion batches", async () => {
    const job = notionJob("NotionPage");
    const records = [
      notionPage,
      {
        id: "4586800c-1c90-80eb-aa52-ea4d88eb32d7",
        title: "Runbook",
        parent_type: "workspace",
        last_edited_time: "2026-05-11T10:00:00.000Z",
      },
    ];
    const sequential = makeOracleClient();
    const concurrent = makeOracleClient();

    await writeBatchToRelayfile(sequential, records, job, { concurrency: 1 });
    await writeBatchToRelayfile(concurrent, records, job, { concurrency: 10 });

    assert.deepEqual(
      [...sequential.files.entries()].sort(),
      [...concurrent.files.entries()].sort(),
    );
  });

  it("surfaces Worker-planned Notion records in today and yesterday digests", async () => {
    const pageJob = notionJob("NotionPage");
    const databaseJob = notionJob("NotionDatabase");
    const todayWrite = plannedNotionWrite(
      pageJob,
      [{
        id: pageId,
        title: "Roadmap",
        archived: true,
        last_edited_time: "2026-05-15T09:00:00.000Z",
      }],
      (write) => write.path === `/notion/pages/${pageId}/meta.json`,
    );
    const yesterdayWrite = plannedNotionWrite(
      databaseJob,
      [{
        id: databaseId,
        title: "Product Roadmap",
        last_edited_time: "2026-05-14T09:00:00.000Z",
      }],
      (write) => write.path === `/notion/databases/${databaseId}/metadata.json`,
    );
    const todayRevision = "rev_today_notion";
    const yesterdayRevision = "rev_yesterday_notion";
    const initialContent = new Map([
      [`${todayWrite.path}@${todayRevision}`, todayWrite.contents ?? ""],
      [`${yesterdayWrite.path}@${yesterdayRevision}`, yesterdayWrite.contents ?? ""],
    ]);
    const { context, stored } = createDigestContext(
      [
        {
          eventId: "evt_notion_today",
          type: "file.updated",
          path: todayWrite.path,
          revision: todayRevision,
          origin: "provider_sync",
          provider: "notion",
          correlationId: "corr_notion_today",
          timestamp: "2026-05-15T09:00:00.000Z",
        },
        {
          eventId: "evt_notion_yesterday",
          type: "file.updated",
          path: yesterdayWrite.path,
          revision: yesterdayRevision,
          origin: "provider_sync",
          provider: "notion",
          correlationId: "corr_notion_yesterday",
          timestamp: "2026-05-14T09:00:00.000Z",
        },
      ],
      initialContent,
    );

    await refreshWorkspaceDigests(context, "rw_test", {
      changedPaths: [todayWrite.path, yesterdayWrite.path],
      generatedAt: new Date("2026-05-15T10:00:00.000Z"),
      correlationId: "corr_notion_digest",
    });

    const todayDigest = stored.find((item) => item.path === "/digests/today.md");
    const yesterdayDigest = stored.find((item) => item.path === "/digests/yesterday.md");
    assert.ok(todayDigest);
    assert.ok(yesterdayDigest);
    assert.ok(todayDigest.content.includes("covers: today"));
    assert.ok(todayDigest.content.includes(todayWrite.path));
    assert.ok(todayDigest.content.includes("was archived"));
    assert.ok(yesterdayDigest.content.includes("covers: yesterday"));
    assert.ok(yesterdayDigest.content.includes(yesterdayWrite.path));
  });
});
