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

type SlackModel = "SlackChannel" | "SlackUser" | "SlackMessage";

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

function slackJob(model: SlackModel): NangoSyncJob {
  return {
    type: "nango_sync",
    workspaceId: "rw_slack_test",
    provider: "slack",
    providerConfigKey: "slack-relay",
    connectionId: "conn_slack",
    syncName: "fetch-channel-history",
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
    path === "/slack/LAYOUT.md" ||
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

function plannedSlackWrite(
  job: NangoSyncJob,
  records: readonly Record<string, unknown>[],
  match: (write: PlannedRelayfileWrite) => boolean,
): PlannedRelayfileWrite {
  const write = planProviderRecordWrites(
    job,
    records,
    new Set([providerModelKey(job)]),
  ).writes.find((candidate) => !candidate.delete && match(candidate));
  assert.ok(write, "expected matching Slack planned write");
  assert.equal(typeof write.contents, "string");
  return write;
}

describe("Slack provider write planner parity", () => {
  it("matches the Node record-writer oracle for first-write channel fanout", async () => {
    const job = slackJob("SlackChannel");
    const records = [{
      id: "C123",
      name: "general",
      is_channel: true,
      updated: "2026-05-15T09:00:00.000Z",
    }];

    assert.deepEqual(plannedOps(job, records), await oracleOps(job, records));
  });

  it("mirrors existing channel discovery index during a zero-record refresh", () => {
    const job = slackJob("SlackChannel");
    const existingFiles = new Map<string, string>([
      ["/slack/channels/_index.json", `${JSON.stringify([
        { id: "C123", title: "general", updated: "2026-05-15T09:00:00.000Z" },
      ])}\n`],
    ]);

    const plan = planProviderRecordWrites(
      job,
      [],
      new Set([providerModelKey(job)]),
      { existingFiles },
    );

    assert.deepEqual(plan.writes, [{
      path: "/discovery/slack/channels/_index.json",
      contents: `${JSON.stringify([{
        id: "C123",
        name: "general",
        title: "general",
        path: "/slack/channels/C123",
        messagesPath: "/slack/channels/C123/messages",
      }])}\n`,
      contentType: "application/json; charset=utf-8",
      baseRevision: "*",
    }]);
    assert.deepEqual(
      { written: plan.written, deleted: plan.deleted, skipped: plan.skipped },
      { written: 0, deleted: 0, skipped: 0 },
    );
  });

  it("clears existing channel discovery index during a zero-record refresh", () => {
    const job = slackJob("SlackChannel");
    const existingFiles = new Map<string, string>([
      ["/slack/channels/_index.json", "[]\n"],
    ]);

    const plan = planProviderRecordWrites(
      job,
      [],
      new Set([providerModelKey(job)]),
      { existingFiles },
    );

    assert.deepEqual(plan.writes, [{
      path: "/discovery/slack/channels/_index.json",
      contents: "[]\n",
      contentType: "application/json; charset=utf-8",
      baseRevision: "*",
    }]);
  });

  it("matches user rename, bot flip, and alias cleanup against the Node oracle", async () => {
    const job = slackJob("SlackUser");
    const seed = {
      "/slack/users/_index.json": [{
        id: "U123",
        title: "Build Bot",
        updated: "2026-05-14T09:00:00.000Z",
        is_bot: true,
        name: "buildbot",
      }],
      "/slack/users/U123__buildbot/meta.json": {},
      "/slack/users/by-name/buildbot.json": {},
      "/slack/users/bots/U123__buildbot.json": {},
    };
    const records = [{
      id: "U123",
      name: "build-human",
      real_name: "Build Human",
      is_bot: false,
      updated: "2026-05-15T09:00:00.000Z",
    }];

    assert.deepEqual(plannedOps(job, records, seed), await oracleOps(job, records, seed));
  });

  it("matches message, thread, and reply path fanout using the channel index", async () => {
    const job = slackJob("SlackMessage");
    const seed = {
      "/slack/channels/_index.json": [{
        id: "C123",
        title: "general",
        updated: "2026-05-15T08:00:00.000Z",
      }],
    };
    const records = [
      {
        id: "m1",
        channel: "C123",
        ts: "1715770000.000100",
        text: "standalone",
      },
      {
        id: "t1",
        channel: "C123",
        ts: "1715770010.000100",
        thread_ts: "1715770010.000100",
        reply_count: 2,
        text: "thread root",
      },
      {
        id: "r1",
        channel: "C123",
        ts: "1715770015.000100",
        thread_ts: "1715770010.000100",
        text: "thread reply",
      },
    ];

    assert.deepEqual(plannedOps(job, records, seed), await oracleOps(job, records, seed));
  });

  it("matches the oracle when the channel name is just the channel id fallback", async () => {
    const job = slackJob("SlackChannel");
    // Regression: when channel-name resolution falls back to the channel id
    // (any case), the path must stay `/slack/channels/<ID>` — not the
    // duplicate tree `/slack/channels/<ID>__<lowercased-id>` observed in prod
    // (C0AD7UU0J1G__c0ad7uu0j1g).
    const records = [{
      id: "C0AD7UU0J1G",
      name: "c0ad7uu0j1g",
      is_channel: true,
      updated: "2026-06-05T09:00:00.000Z",
    }];

    const planned = plannedOps(job, records);
    assert.ok(
      planned.some((op) => op.path === "/slack/channels/C0AD7UU0J1G/meta.json"),
      `expected bare-id channel path; got: ${planned.map((op) => op.path).join(", ")}`,
    );
    assert.ok(
      !planned.some((op) => op.path.includes("C0AD7UU0J1G__")),
      `unexpected id-slug duplicate path; got: ${planned.map((op) => op.path).join(", ")}`,
    );
    assert.deepEqual(planned, await oracleOps(job, records));
  });

  it("matches message fanout when the channel index title is the id fallback", async () => {
    const job = slackJob("SlackMessage");
    const seed = {
      "/slack/channels/_index.json": [{
        id: "C0AD7UU0J1G",
        title: "C0AD7UU0J1G",
        updated: "2026-06-05T08:00:00.000Z",
      }],
    };
    const records = [{
      id: "m1",
      channel: "C0AD7UU0J1G",
      ts: "1780687762.971029",
      text: "probe",
    }];

    const planned = plannedOps(job, records, seed);
    assert.ok(
      !planned.some((op) => op.path.includes("C0AD7UU0J1G__")),
      `unexpected id-slug duplicate path; got: ${planned.map((op) => op.path).join(", ")}`,
    );
    assert.deepEqual(planned, await oracleOps(job, records, seed));
  });

  it("preserves archived channels and deletes channel tombstones with index cleanup", async () => {
    const job = slackJob("SlackChannel");
    const seed = {
      "/slack/channels/_index.json": [{
        id: "COLD",
        title: "old-channel",
        updated: "2026-05-13T09:00:00.000Z",
      }],
      "/slack/channels/COLD__old-channel/meta.json": {},
      "/slack/channels/by-name/old-channel.json": {},
    };
    const records = [
      {
        id: "CARCH",
        name: "archive-room",
        is_archived: true,
        updated: "2026-05-15T09:00:00.000Z",
      },
      {
        id: "COLD",
        name: "old-channel",
        _nango_metadata: { last_action: "DELETED" },
      },
    ];

    assert.deepEqual(plannedOps(job, records, seed), await oracleOps(job, records, seed));
  });

  it("keeps concurrency-independent tree output identical for Slack batches", async () => {
    const job = slackJob("SlackMessage");
    const records = [
      { id: "m1", channel: "C123", ts: "1715770000.000100", text: "one" },
      {
        id: "r1",
        channel: "C123",
        ts: "1715770015.000100",
        thread_ts: "1715770010.000100",
        text: "reply",
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

  it("surfaces Worker-planned Slack records in today and yesterday digests", async () => {
    const channelJob = slackJob("SlackChannel");
    const userJob = slackJob("SlackUser");
    const todayWrite = plannedSlackWrite(
      channelJob,
      [{
        id: "C123",
        name: "general",
        is_archived: true,
        updated: "2026-05-15T09:00:00.000Z",
      }],
      (write) => write.path === "/slack/channels/C123__general/meta.json",
    );
    const yesterdayWrite = plannedSlackWrite(
      userJob,
      [{
        id: "U123",
        name: "buildbot",
        real_name: "Build Bot",
        is_bot: true,
        updated: "2026-05-14T09:00:00.000Z",
      }],
      (write) => write.path === "/slack/users/U123__buildbot/meta.json",
    );
    const todayRevision = "rev_today_slack";
    const yesterdayRevision = "rev_yesterday_slack";
    const initialContent = new Map([
      [`${todayWrite.path}@${todayRevision}`, todayWrite.contents ?? ""],
      [`${yesterdayWrite.path}@${yesterdayRevision}`, yesterdayWrite.contents ?? ""],
    ]);
    const { context, stored } = createDigestContext(
      [
        {
          eventId: "evt_slack_today",
          type: "file.updated",
          path: todayWrite.path,
          revision: todayRevision,
          origin: "provider_sync",
          provider: "slack",
          correlationId: "corr_slack_today",
          timestamp: "2026-05-15T09:00:00.000Z",
        },
        {
          eventId: "evt_slack_yesterday",
          type: "file.updated",
          path: yesterdayWrite.path,
          revision: yesterdayRevision,
          origin: "provider_sync",
          provider: "slack",
          correlationId: "corr_slack_yesterday",
          timestamp: "2026-05-14T09:00:00.000Z",
        },
      ],
      initialContent,
    );

    await refreshWorkspaceDigests(context, "rw_slack_test", {
      changedPaths: [todayWrite.path, yesterdayWrite.path],
      generatedAt: new Date("2026-05-15T10:00:00.000Z"),
      correlationId: "corr_slack_digest",
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

  it("proves the Slack parity oracle is non-vacuous", async () => {
    const job = slackJob("SlackChannel");
    const records = [
      { id: "C111", name: "alerts", updated: "2026-05-15T09:00:00.000Z" },
      { id: "C222", name: "alerts", updated: "2026-05-15T09:01:00.000Z" },
    ];
    const planned = plannedOps(job, records);
    const oracle = await oracleOps(job, records);

    assert.deepEqual(planned, oracle);
    assert.notDeepEqual(
      planned.filter((op) => op.path !== "/slack/_index.json"),
      oracle,
    );
    assert.notDeepEqual(
      planned.map((op) =>
        op.path.includes("/by-name/alerts-")
          ? { ...op, path: op.path.replace(/alerts-[a-f0-9]{8}/u, "alerts") }
          : op,
      ),
      oracle,
    );
  });
});
