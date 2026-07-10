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

function confluenceJob(model: "ConfluencePage" | "ConfluenceSpace"): NangoSyncJob {
  return {
    type: "nango_sync",
    workspaceId: "rw_test",
    provider: "confluence",
    providerConfigKey: "confluence-relay",
    connectionId: "conn_test",
    syncName: model === "ConfluencePage" ? "fetch-pages" : "fetch-spaces",
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
    path === "/confluence/LAYOUT.md" ||
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

function plannedConfluenceWrite(
  job: NangoSyncJob,
  records: readonly Record<string, unknown>[],
  match: (write: PlannedRelayfileWrite) => boolean,
): PlannedRelayfileWrite {
  const write = planProviderRecordWrites(
    job,
    records,
    new Set([providerModelKey(job)]),
  ).writes.find((candidate) => !candidate.delete && match(candidate));
  assert.ok(write, "expected matching Confluence planned write");
  assert.equal(typeof write.contents, "string");
  return write;
}

describe("Confluence provider write planner parity", () => {
  it("matches the Node record-writer oracle for first-write page fanout", async () => {
    const job = confluenceJob("ConfluencePage");
    const records = [{
      id: "c1",
      title: "Conf page",
      spaceId: "SP",
      status: "current",
      parentId: "p1",
      version: { createdAt: "2026-05-11T10:00:00.000Z" },
      _nango_metadata: { last_action: "UPDATED" },
    }];

    assert.deepEqual(plannedOps(job, records), await oracleOps(job, records));
  });

  it("matches the Node record-writer oracle for first-write space fanout", async () => {
    const job = confluenceJob("ConfluenceSpace");
    const records = [{
      id: "100",
      key: "ENG",
      name: "Engineering",
      type: "global",
      updated_at: "2026-05-11T10:00:00.000Z",
      _nango_metadata: { last_action: "UPDATED" },
    }];

    assert.deepEqual(plannedOps(job, records), await oracleOps(job, records));
  });

  it("matches updated_at-only multi-row index ordering against the Node oracle", async () => {
    const pageJob = confluenceJob("ConfluencePage");
    const pageRecords = [
      {
        id: "page-old",
        title: "Old page",
        spaceId: "ENG",
        status: "current",
        updated_at: "2026-05-11T10:00:00.000Z",
      },
      {
        id: "page-new",
        title: "New page",
        spaceId: "ENG",
        status: "current",
        updated_at: "2026-05-13T10:00:00.000Z",
      },
      {
        id: "page-mid",
        title: "Mid page",
        spaceId: "ENG",
        status: "draft",
        updated_at: "2026-05-12T10:00:00.000Z",
      },
    ];
    const spaceJob = confluenceJob("ConfluenceSpace");
    const spaceRecords = [
      {
        id: "space-old",
        key: "OLD",
        name: "Old space",
        updated_at: "2026-05-11T10:00:00.000Z",
      },
      {
        id: "space-new",
        key: "NEW",
        name: "New space",
        updated_at: "2026-05-13T10:00:00.000Z",
      },
      {
        id: "space-mid",
        key: "MID",
        name: "Mid space",
        updated_at: "2026-05-12T10:00:00.000Z",
      },
    ];

    const plannedPageOps = plannedOps(pageJob, pageRecords);
    const plannedSpaceOps = plannedOps(spaceJob, spaceRecords);
    assert.deepEqual(plannedPageOps, await oracleOps(pageJob, pageRecords));
    assert.deepEqual(plannedSpaceOps, await oracleOps(spaceJob, spaceRecords));

    const pageIndex = plannedPageOps.find((op) => op.path === "/confluence/pages/_index.json");
    const spaceIndex = plannedSpaceOps.find((op) => op.path === "/confluence/spaces/_index.json");
    assert.equal(typeof pageIndex?.contents, "string");
    assert.equal(typeof spaceIndex?.contents, "string");
    assert.deepEqual(JSON.parse(pageIndex.contents), [
      { id: "page-new", title: "New page", updated: "2026-05-13T10:00:00.000Z", spaceId: "ENG", status: "current" },
      { id: "page-mid", title: "Mid page", updated: "2026-05-12T10:00:00.000Z", spaceId: "ENG", status: "draft" },
      { id: "page-old", title: "Old page", updated: "2026-05-11T10:00:00.000Z", spaceId: "ENG", status: "current" },
    ]);
    assert.deepEqual(JSON.parse(spaceIndex.contents), [
      { id: "space-new", title: "New space", updated: "2026-05-13T10:00:00.000Z", key: "NEW" },
      { id: "space-mid", title: "Mid space", updated: "2026-05-12T10:00:00.000Z", key: "MID" },
      { id: "space-old", title: "Old space", updated: "2026-05-11T10:00:00.000Z", key: "OLD" },
    ]);
  });

  it("matches published Confluence timestamp precedence and by-edited semantics", async () => {
    const job = confluenceJob("ConfluencePage");
    const records = [
      {
        id: "page-precedence",
        title: "Precedence page",
        spaceId: "ENG",
        status: "current",
        updated: "2026-05-12T10:00:00.000Z",
        updatedAt: "2026-05-11T10:00:00.000Z",
        updated_at: "2026-05-13T10:00:00.000Z",
        version: { createdAt: "2026-05-10T08:15:00.000Z" },
      },
    ];

    const planned = plannedOps(job, records);
    assert.deepEqual(planned, await oracleOps(job, records));

    const pageIndex = planned.find((op) => op.path === "/confluence/pages/_index.json");
    assert.equal(typeof pageIndex?.contents, "string");
    assert.deepEqual(JSON.parse(pageIndex.contents), [
      {
        id: "page-precedence",
        title: "Precedence page",
        updated: "2026-05-12T10:00:00.000Z",
        spaceId: "ENG",
        status: "current",
      },
    ]);
    assert.ok(
      planned.some((op) => op.path === "/confluence/pages/by-edited/2026-05-10/page-precedence.json"),
      "by-edited alias should use version.createdAt, not root updated_at",
    );
    assert.ok(
      !planned.some((op) => op.path === "/confluence/pages/by-edited/2026-05-13/page-precedence.json"),
      "root updated_at must not drive by-edited alias generation",
    );
  });

  it("matches stale timestamp behavior and does not silently rewrite older page records", async () => {
    const job = confluenceJob("ConfluencePage");
    const seed = {
      "/confluence/pages/by-id/c1.json": {
        provider: "confluence",
        objectType: "page",
        objectId: "c1",
        payload: {
          id: "c1",
          title: "Current",
          spaceId: "SP",
          status: "current",
          updated_at: "2026-05-12T00:00:00.000Z",
        },
      },
    };
    const records = [{
      id: "c1",
      title: "Older",
      spaceId: "SP",
      status: "current",
      updated_at: "2026-05-11T00:00:00.000Z",
    }];

    assert.deepEqual(plannedOps(job, records, seed), await oracleOps(job, records, seed));
    assert.deepEqual(plannedOps(job, records, seed), []);
  });

  it("matches rename, state, parent, and space cleanup against the Node oracle", async () => {
    const job = confluenceJob("ConfluencePage");
    const seed = {
      "/confluence/pages/by-id/c1.json": {
        provider: "confluence",
        objectType: "page",
        objectId: "c1",
        payload: {
          id: "c1",
          title: "Old",
          spaceId: "SP1",
          status: "current",
          parentId: "p1",
          updated_at: "2026-05-11T00:00:00.000Z",
        },
      },
      "/confluence/pages/by-title/old.json": {},
      "/confluence/pages/by-state/current/c1.json": {},
      "/confluence/pages/by-space/SP1/c1.json": {},
      "/confluence/pages/by-parent/p1/c1.json": {},
      "/confluence/spaces/SP1/pages/old__c1.json": {},
      "/confluence/pages/_index.json": [{
        id: "c1",
        title: "Old",
        spaceId: "SP1",
        status: "current",
        updated: "2026-05-11T00:00:00.000Z",
      }],
    };
    const records = [{
      id: "c1",
      title: "New",
      spaceId: "SP2",
      status: "archived",
      parentId: "p2",
      updated_at: "2026-05-12T00:00:00.000Z",
    }];

    assert.deepEqual(plannedOps(job, records, seed), await oracleOps(job, records, seed));
  });

  it("keeps concurrency-independent tree output identical for Confluence batches", async () => {
    const job = confluenceJob("ConfluencePage");
    const records = [
      { id: "c1", title: "A", spaceId: "SP", status: "current" },
      { id: "c2", title: "B", spaceId: "SP", status: "draft" },
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

  it("surfaces Worker-planned Confluence records in today and yesterday digests", async () => {
    const pageJob = confluenceJob("ConfluencePage");
    const spaceJob = confluenceJob("ConfluenceSpace");
    const todayWrite = plannedConfluenceWrite(
      pageJob,
      [{
        id: "c1",
        title: "Release Plan",
        spaceId: "ENG",
        status: "current",
        updated_at: "2026-05-15T09:00:00.000Z",
      }],
      (write) => write.path.includes("/pages/release-plan__c1.json"),
    );
    const yesterdayWrite = plannedConfluenceWrite(
      spaceJob,
      [{
        id: "100",
        key: "ENG",
        name: "Engineering",
        type: "global",
        updated_at: "2026-05-14T09:00:00.000Z",
      }],
      (write) => write.path === "/confluence/spaces/engineering__100.json",
    );
    const todayRevision = "rev_today_confluence";
    const yesterdayRevision = "rev_yesterday_confluence";
    const initialContent = new Map([
      [`${todayWrite.path}@${todayRevision}`, todayWrite.contents ?? ""],
      [`${yesterdayWrite.path}@${yesterdayRevision}`, yesterdayWrite.contents ?? ""],
    ]);
    const { context, stored } = createDigestContext(
      [
        {
          eventId: "evt_confluence_today",
          type: "file.updated",
          path: todayWrite.path,
          revision: todayRevision,
          origin: "provider_sync",
          provider: "confluence",
          correlationId: "corr_confluence_today",
          timestamp: "2026-05-15T09:00:00.000Z",
        },
        {
          eventId: "evt_confluence_yesterday",
          type: "file.updated",
          path: yesterdayWrite.path,
          revision: yesterdayRevision,
          origin: "provider_sync",
          provider: "confluence",
          correlationId: "corr_confluence_yesterday",
          timestamp: "2026-05-14T09:00:00.000Z",
        },
      ],
      initialContent,
    );

    await refreshWorkspaceDigests(context, "rw_test", {
      changedPaths: [todayWrite.path, yesterdayWrite.path],
      generatedAt: new Date("2026-05-15T10:00:00.000Z"),
      correlationId: "corr_confluence_digest",
    });

    const todayDigest = stored.find((item) => item.path === "/digests/today.md");
    const yesterdayDigest = stored.find((item) => item.path === "/digests/yesterday.md");
    assert.ok(todayDigest);
    assert.ok(yesterdayDigest);
    assert.ok(todayDigest.content.includes("covers: today"));
    assert.ok(todayDigest.content.includes(todayWrite.path));
    assert.ok(yesterdayDigest.content.includes("covers: yesterday"));
    assert.ok(yesterdayDigest.content.includes(yesterdayWrite.path));
  });
});
