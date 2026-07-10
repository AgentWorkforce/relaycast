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

type GitHubModel = "Repo" | "PullRequest" | "Issue";
type LinearModel =
  | "LinearIssue"
  | "LinearComment"
  | "LinearLabel"
  | "LinearUser"
  | "LinearTeam"
  | "LinearProject"
  | "LinearMilestone"
  | "LinearRoadmap"
  | "LinearCycle";

const owner = "octo";
const repo = "hello-world";
const linearIssueId = "6f1a0a48-1111-4111-8111-abcdef012346";

function githubJob(model: GitHubModel): NangoSyncJob {
  return {
    type: "nango_sync",
    workspaceId: "rw_test",
    provider: "github",
    providerConfigKey: "github-relay",
    connectionId: "conn_github",
    syncName:
      model === "Repo"
        ? "fetch-repos"
        : model === "PullRequest"
          ? "fetch-open-prs"
          : "fetch-open-issues",
    model,
    cursor: null,
    modifiedAfter: "1970-01-01T00:00:00.000Z",
  };
}

function linearJob(model: LinearModel): NangoSyncJob {
  const syncName =
    model === "LinearIssue"
      ? "fetch-active-issues"
      : model === "LinearComment"
        ? "fetch-comments"
        : model === "LinearLabel"
          ? "fetch-labels"
        : model === "LinearUser"
          ? "fetch-users"
          : model === "LinearTeam"
            ? "fetch-teams"
            : model === "LinearProject"
              ? "fetch-projects"
              : model === "LinearMilestone"
                ? "fetch-milestones"
                : model === "LinearRoadmap"
                  ? "fetch-roadmaps"
                  : "fetch-cycles";

  return {
    type: "nango_sync",
    workspaceId: "rw_test",
    provider: "linear",
    providerConfigKey: "linear-relay",
    connectionId: "conn_linear",
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
              left.eventId.localeCompare(left.eventId)
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
    path === "/github/LAYOUT.md" ||
    path === "/linear/LAYOUT.md" ||
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
  await writeBatchToRelayfile(client, records, job);
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

function plannedWrite(
  job: NangoSyncJob,
  records: readonly Record<string, unknown>[],
  match: (write: PlannedRelayfileWrite) => boolean,
): PlannedRelayfileWrite {
  const write = planProviderRecordWrites(
    job,
    records,
    new Set([providerModelKey(job)]),
  ).writes.find((candidate) => !candidate.delete && match(candidate));
  assert.ok(write, "expected matching planned write");
  assert.equal(typeof write.contents, "string");
  return write;
}

const githubRepo = {
  id: 42,
  owner,
  repo,
  full_name: `${owner}/${repo}`,
  updated_at: "2026-05-10T10:00:00.000Z",
};

const githubPullRequest = {
  id: 1001,
  number: 7,
  owner,
  repo,
  full_name: `${owner}/${repo}`,
  title: "Add dispatch queue",
  state: "open",
  updated_at: "2026-05-10T10:00:00.000Z",
};

const githubIssue = {
  id: 2001,
  number: 9,
  owner,
  repo,
  full_name: `${owner}/${repo}`,
  title: "Fix webhook ingestion",
  state: "closed",
  updated_at: "2026-05-10T10:00:00.000Z",
};

const linearIssue = {
  id: linearIssueId,
  identifier: "ENG-8",
  title: "Fix webhook ingestion",
  state: { name: "Todo" },
  updatedAt: "2026-05-10T10:00:00.000Z",
  createdAt: "2026-05-09T10:00:00.000Z",
};

describe("GitHub and Linear provider write planner deep parity", () => {
  it("matches the GitHub Node oracle for first-write repo, pull request, and issue fanout", async () => {
    for (const [job, records] of [
      [githubJob("Repo"), [githubRepo]],
      [githubJob("PullRequest"), [githubPullRequest]],
      [githubJob("Issue"), [githubIssue]],
    ] as const) {
      assert.deepEqual(plannedOps(job, records), await oracleOps(job, records));
    }
  });

  it("matches GitHub stale guard, rename cleanup, and tombstone behavior", async () => {
    const issueJob = githubJob("Issue");
    const staleSeed = {
      [`/github/repos/${owner}__${repo}/issues/by-id/9.json`]: {
        provider: "github",
        objectType: "issue",
        objectId: "9",
        payload: { ...githubIssue, updated_at: "2026-05-12T10:00:00.000Z" },
      },
    };
    const stale = [{ ...githubIssue, updated_at: "2026-05-11T10:00:00.000Z" }];
    assert.deepEqual(plannedOps(issueJob, stale, staleSeed), await oracleOps(issueJob, stale, staleSeed));
    assert.deepEqual(plannedOps(issueJob, stale, staleSeed), []);

    const renameSeed = {
      [`/github/repos/${owner}__${repo}/issues/by-id/9.json`]: {
        provider: "github",
        objectType: "issue",
        objectId: "9",
        payload: { ...githubIssue, title: "Old title", updated_at: "2026-05-09T10:00:00.000Z" },
      },
      [`/github/repos/${owner}/${repo}/issues/9__old-title/meta.json`]: {},
      [`/github/repos/${owner}__${repo}/issues/by-title/old-title.json`]: {},
      [`/github/repos/${owner}/${repo}/issues/_index.json`]: [{
        id: "9",
        title: "Old title",
        updated: "2026-05-09T10:00:00.000Z",
        number: 9,
        state: "open",
      }],
    };
    const renamed = [{ ...githubIssue, title: "New title", updated_at: "2026-05-12T10:00:00.000Z" }];
    const renameOps = plannedOps(issueJob, renamed, renameSeed);
    assert.deepEqual(renameOps, await oracleOps(issueJob, renamed, renameSeed));
    assert.ok(renameOps.some((op) => op.op === "delete" && op.path.endsWith("/issues/9__old-title/meta.json")));
    assert.ok(renameOps.some((op) => op.op === "delete" && op.path.endsWith("/issues/by-title/old-title.json")));

    const tombstone = [{
      owner,
      repo,
      full_name: `${owner}/${repo}`,
      number: 9,
      _nango_metadata: { last_action: "DELETED" },
    }];
    assert.deepEqual(plannedOps(issueJob, tombstone, renameSeed), await oracleOps(issueJob, tombstone, renameSeed));
    assert.deepEqual(plannedOps(issueJob, tombstone), await oracleOps(issueJob, tombstone));
  });

  it("matches the Linear Node oracle for first-write fanout across all Linear models", async () => {
    const recordsByModel: Record<LinearModel, Record<string, unknown>[]> = {
      LinearIssue: [linearIssue],
      LinearComment: [{
        id: "comment-1",
        body: "Looks good",
        issue: { id: linearIssueId, identifier: "ENG-8", title: "Fix webhook ingestion" },
        updatedAt: "2026-05-10T10:00:00.000Z",
      }],
      LinearLabel: [{
        id: "label-1",
        name: "Escalation",
        color: "#bec2c8",
        team: { id: "team-1", key: "ENG", name: "Engineering" },
        updatedAt: "2026-05-10T10:00:00.000Z",
      }],
      LinearUser: [{
        id: "user-1",
        name: "Ada Lovelace",
        email: "ada@example.com",
        updatedAt: "2026-05-10T10:00:00.000Z",
      }],
      LinearTeam: [{
        id: "team-1",
        key: "ENG",
        name: "Engineering",
        updatedAt: "2026-05-10T10:00:00.000Z",
      }],
      LinearProject: [{
        id: "project-1",
        name: "Webhook Reliability",
        state: "started",
        team_ids: ["team-1"],
        updatedAt: "2026-05-10T10:00:00.000Z",
      }],
      LinearMilestone: [{
        id: "milestone-1",
        name: "Option B",
        status: "active",
        updatedAt: "2026-05-10T10:00:00.000Z",
      }],
      LinearRoadmap: [{
        id: "roadmap-1",
        name: "Ingestion",
        updatedAt: "2026-05-10T10:00:00.000Z",
      }],
      LinearCycle: [{
        id: "cycle-1",
        number: 42,
        name: "Cycle 42",
        updatedAt: "2026-05-10T10:00:00.000Z",
      }],
    };

    for (const [model, records] of Object.entries(recordsByModel) as [LinearModel, Record<string, unknown>[]][]) {
      const job = linearJob(model);
      assert.deepEqual(plannedOps(job, records), await oracleOps(job, records));
    }
  });

  it("does not clear populated Linear team and project indexes during other Linear model syncs", async () => {
    const teamIndexRow = {
      id: "team-1",
      title: "Engineering",
      updated: "2026-05-10T10:00:00.000Z",
    };
    const projectIndexRow = {
      id: "project-1",
      title: "Webhook Reliability",
      updated: "2026-05-10T10:00:00.000Z",
    };
    const seed = {
      "/linear/teams/_index.json": [teamIndexRow],
      "/linear/projects/_index.json": [projectIndexRow],
    };

    const issueOps = plannedOps(linearJob("LinearIssue"), [linearIssue], seed);
    assert.deepEqual(issueOps, await oracleOps(linearJob("LinearIssue"), [linearIssue], seed));
    assert.ok(
      !issueOps.some((op) => op.path === "/linear/teams/_index.json"),
      "LinearIssue sync must not overwrite the teams index",
    );
    assert.ok(
      !issueOps.some((op) => op.path === "/linear/projects/_index.json"),
      "LinearIssue sync must not overwrite the projects index",
    );

    const projectOps = plannedOps(
      linearJob("LinearProject"),
      [{
        id: "project-2",
        name: "Digest Backfill",
        state: "started",
        teams: [{ id: "team-2" }],
        updatedAt: "2026-05-11T10:00:00.000Z",
      }],
      seed,
    );
    assert.deepEqual(
      projectOps,
      await oracleOps(
        linearJob("LinearProject"),
        [{
          id: "project-2",
          name: "Digest Backfill",
          state: "started",
          teams: [{ id: "team-2" }],
          updatedAt: "2026-05-11T10:00:00.000Z",
        }],
        seed,
      ),
    );
    assert.ok(
      !projectOps.some((op) => op.path === "/linear/teams/_index.json"),
      "LinearProject sync must not overwrite the teams index",
    );
    assert.ok(
      projectOps.some((op) =>
        op.path === "/linear/projects/_index.json" &&
        op.contents?.includes("\"project-1\"") &&
        op.contents?.includes("\"project-2\"")
      ),
      "LinearProject sync should merge the existing project index rows",
    );
  });

  it("matches Linear stale guard, alias cleanup, tombstone, and terminal-state preservation", async () => {
    const job = linearJob("LinearIssue");
    const byUuid = `/linear/issues/by-uuid/${linearIssueId}.json`;
    const staleSeed = {
      [byUuid]: {
        provider: "linear",
        objectType: "issue",
        objectId: linearIssueId,
        payload: { ...linearIssue, updatedAt: "2026-05-12T10:00:00.000Z" },
      },
    };
    const stale = [{ ...linearIssue, updatedAt: "2026-05-11T10:00:00.000Z" }];
    assert.deepEqual(plannedOps(job, stale, staleSeed), await oracleOps(job, stale, staleSeed));
    assert.deepEqual(plannedOps(job, stale, staleSeed), []);

    const renameSeed = {
      [byUuid]: {
        provider: "linear",
        objectType: "issue",
        objectId: linearIssueId,
        payload: {
          ...linearIssue,
          identifier: "ENG-7",
          title: "Old title",
          state: { name: "Todo" },
          updatedAt: "2026-05-09T10:00:00.000Z",
        },
      },
      [`/linear/issues/ENG-7__${linearIssueId}.json`]: {},
      [`/linear/issues/by-id/ENG-7.json`]: {},
      "/linear/issues/by-title/old-title.json": {},
      "/linear/issues/by-state/todo/ENG-7.json": {},
      "/linear/issues/_index.json": [{
        id: linearIssueId,
        title: "Old title",
        updated: "2026-05-09T10:00:00.000Z",
        identifier: "ENG-7",
        state: "Todo",
      }],
    };
    const moved = [{
      ...linearIssue,
      identifier: "ENG-8",
      title: "New title",
      state: { name: "Done" },
      completedAt: "2026-05-12T10:00:00.000Z",
      updatedAt: "2026-05-12T10:00:00.000Z",
    }];
    const movedOps = plannedOps(job, moved, renameSeed);
    assert.deepEqual(movedOps, await oracleOps(job, moved, renameSeed));
    assert.ok(movedOps.some((op) => op.op === "delete" && op.path === `/linear/issues/ENG-7__${linearIssueId}.json`));
    assert.ok(movedOps.some((op) => op.op === "delete" && op.path === "/linear/issues/by-state/todo/ENG-7.json"));
    assert.ok(movedOps.some((op) => op.op === "write" && op.contents?.includes("\"completedAt\"")));

    const tombstone = [{ id: linearIssueId, _nango_metadata: { last_action: "DELETED" } }];
    assert.deepEqual(plannedOps(job, tombstone, renameSeed), await oracleOps(job, tombstone, renameSeed));
    assert.deepEqual(plannedOps(job, tombstone), await oracleOps(job, tombstone));
  });

  it("keeps GitHub and Linear oracle tree output concurrency-independent", async () => {
    for (const [job, records] of [
      [githubJob("Issue"), [githubIssue, { ...githubIssue, id: 2002, number: 10, title: "Second issue" }]],
      [linearJob("LinearIssue"), [linearIssue, { ...linearIssue, id: "issue-2", identifier: "ENG-9", title: "Second issue" }]],
    ] as const) {
      const sequential = makeOracleClient();
      const concurrent = makeOracleClient();
      await writeBatchToRelayfile(sequential, records, job, { concurrency: 1 });
      await writeBatchToRelayfile(concurrent, records, job, { concurrency: 10 });
      assert.deepEqual(
        [...sequential.files.entries()].sort(),
        [...concurrent.files.entries()].sort(),
      );
    }
  });

  it("surfaces Worker-planned GitHub and Linear terminal records in today and yesterday digests", async () => {
    const githubWrite = plannedWrite(
      githubJob("Issue"),
      [{ ...githubIssue, state: "closed" }],
      (write) => write.path === `/github/repos/${owner}/${repo}/issues/9__fix-webhook-ingestion/meta.json`,
    );
    const linearWrite = plannedWrite(
      linearJob("LinearIssue"),
      [{ ...linearIssue, state: { name: "Done" }, completedAt: "2026-05-14T09:00:00.000Z" }],
      (write) => write.path === `/linear/issues/ENG-8__${linearIssueId}.json`,
    );
    const githubRevision = "rev_github_terminal";
    const linearRevision = "rev_linear_terminal";
    const { context, stored } = createDigestContext(
      [
        {
          eventId: "evt_github_today",
          type: "file.updated",
          path: githubWrite.path,
          revision: githubRevision,
          origin: "provider_sync",
          provider: "github",
          correlationId: "corr_github",
          timestamp: "2026-05-20T09:00:00.000Z",
        },
        {
          eventId: "evt_linear_yesterday",
          type: "file.updated",
          path: linearWrite.path,
          revision: linearRevision,
          origin: "provider_sync",
          provider: "linear",
          correlationId: "corr_linear",
          timestamp: "2026-05-19T09:00:00.000Z",
        },
      ],
      new Map([
        [`${githubWrite.path}@${githubRevision}`, githubWrite.contents ?? ""],
        [`${linearWrite.path}@${linearRevision}`, linearWrite.contents ?? ""],
      ]),
    );

    await refreshWorkspaceDigests(context, "rw_test", {
      generatedAt: new Date("2026-05-20T12:00:00.000Z"),
    });

    const today = stored.find((item) => item.path === "/digests/today.md")?.content ?? "";
    const yesterday = stored.find((item) => item.path === "/digests/yesterday.md")?.content ?? "";
    assert.match(today, /github/i);
    assert.match(today, /closed/i);
    assert.match(today, /9__fix-webhook-ingestion/);
    assert.match(yesterday, /linear/i);
    assert.match(yesterday, /completed/i);
    assert.match(yesterday, /ENG-8__/);
  });
});
