import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  writeBatchToRelayfile,
  type RelayfileWriteClient,
} from "../src/sync/record-writer.js";
import type { NangoSyncJob } from "../src/sync/nango-sync-job.js";

interface RecordedWrite {
  path: string;
  content: string;
  contentType: string;
}

type RecordingClient = RelayfileWriteClient & {
  deletes: string[];
  files: Map<string, string>;
  writes: RecordedWrite[];
};

function makeRecordingClient(): RecordingClient {
  const files = new Map<string, string>();
  const writes: RecordedWrite[] = [];
  const deletes: string[] = [];

  return {
    files,
    writes,
    deletes,
    async readFile(_workspaceId, path) {
      const content = files.get(path);
      if (content === undefined) {
        const err = new Error("not found") as Error & { status: number };
        err.status = 404;
        throw err;
      }
      return { content };
    },
    async writeFile(input) {
      files.set(input.path, input.content);
      writes.push({
        path: input.path,
        content: input.content,
        contentType: input.contentType,
      });
    },
    async deleteFile(input) {
      files.delete(input.path);
      deletes.push(input.path);
    },
  };
}

function job(provider: string, model: string): NangoSyncJob {
  return {
    type: "nango_sync",
    workspaceId: "by_edited_test",
    provider,
    providerConfigKey: `${provider}-relay`,
    connectionId: "conn_test",
    syncName: `fetch-${model.toLowerCase()}`,
    model,
    cursor: null,
    modifiedAfter: "1970-01-01T00:00:00.000Z",
  };
}

const OLD_DATE = "2026-05-14";
const NEW_DATE = "2026-05-15";
const CONFLUENCE_CREATED_DATE = "2026-05-01";

const cases: Array<{
  name: string;
  job: NangoSyncJob;
  oldRecord: Record<string, unknown>;
  newRecord: Record<string, unknown>;
}> = [
  {
    name: "Notion pages",
    job: job("notion", "NotionPage"),
    oldRecord: {
      id: "3586800c-1c90-80eb-aa52-ea4d88eb32d5",
      title: "Launch Plan",
      parent_type: "workspace",
      lastEditedTime: `${OLD_DATE}T10:00:00.000Z`,
    },
    newRecord: {
      id: "3586800c-1c90-80eb-aa52-ea4d88eb32d5",
      title: "Launch Plan",
      parent_type: "workspace",
      lastEditedTime: `${NEW_DATE}T11:00:00.000Z`,
    },
  },
  {
    name: "Linear issues",
    job: job("linear", "LinearIssue"),
    oldRecord: {
      id: "issue-123",
      identifier: "AGE-8",
      title: "Release plan",
      state_name: "Todo",
      updatedAt: `${OLD_DATE}T10:00:00.000Z`,
    },
    newRecord: {
      id: "issue-123",
      identifier: "AGE-8",
      title: "Release plan",
      state_name: "In Progress",
      updatedAt: `${NEW_DATE}T11:00:00.000Z`,
    },
  },
  {
    name: "GitHub issues",
    job: job("github", "Issue"),
    oldRecord: {
      id: "issue-node-9",
      full_name: "octocat/hello-world",
      owner: "octocat",
      repo: "hello-world",
      number: 9,
      title: "Fix login",
      state: "open",
      updated_at: `${OLD_DATE}T10:00:00.000Z`,
    },
    newRecord: {
      id: "issue-node-9",
      full_name: "octocat/hello-world",
      owner: "octocat",
      repo: "hello-world",
      number: 9,
      title: "Fix login",
      state: "open",
      updated_at: `${NEW_DATE}T11:00:00.000Z`,
    },
  },
  {
    name: "GitHub pull requests",
    job: job("github", "PullRequest"),
    oldRecord: {
      id: "pr-node-42",
      full_name: "octocat/hello-world",
      owner: "octocat",
      repo: "hello-world",
      number: 42,
      title: "Ship sync",
      state: "open",
      updated_at: `${OLD_DATE}T10:00:00.000Z`,
    },
    newRecord: {
      id: "pr-node-42",
      full_name: "octocat/hello-world",
      owner: "octocat",
      repo: "hello-world",
      number: 42,
      title: "Ship sync",
      state: "open",
      updated_at: `${NEW_DATE}T11:00:00.000Z`,
    },
  },
  {
    name: "Jira issues",
    job: job("jira", "JiraIssue"),
    oldRecord: {
      id: "10001",
      key: "ENG-1",
      fields: {
        summary: "Refactor auth",
        status: { name: "In Progress" },
        updated: `${OLD_DATE}T10:00:00.000Z`,
      },
    },
    newRecord: {
      id: "10001",
      key: "ENG-1",
      fields: {
        summary: "Refactor auth",
        status: { name: "Done" },
        updated: `${NEW_DATE}T11:00:00.000Z`,
      },
    },
  },
  {
    name: "Confluence pages",
    job: job("confluence", "ConfluencePage"),
    oldRecord: {
      id: "page-7",
      title: "Architecture",
      spaceId: "SP1",
      status: "current",
      createdAt: `${CONFLUENCE_CREATED_DATE}T09:00:00.000Z`,
      version: { createdAt: `${OLD_DATE}T10:00:00.000Z` },
    },
    newRecord: {
      id: "page-7",
      title: "Architecture",
      spaceId: "SP1",
      status: "current",
      createdAt: `${CONFLUENCE_CREATED_DATE}T09:00:00.000Z`,
      version: { createdAt: `${NEW_DATE}T11:00:00.000Z` },
    },
  },
];

// SKIPPED while the cloud-side `writeByEditedAliases` emitter is not yet
// invoked from `record-writer.ts`. The emitter module exists
// (`packages/core/src/sync/by-edited-alias-emitter.ts`) but wiring it into
// the 5 per-provider aux emitters breaks the provider-write-planner parity
// suites for confluence / github / linear / notion, because the planner
// does not yet compute by-edited writes for those providers. Re-enable this
// suite in a follow-up PR that updates `provider-write-planner.ts` to emit
// the same by-edited writes (jira / github / notion currently have the
// path-helper exports but no planner call site).
describe("by-edited aliases through hosted sync output", { skip: true }, () => {
  for (const item of cases) {
    it(`${item.name}: resolves aliases to the current canonical record and prunes stale dates`, async () => {
      const client = makeRecordingClient();

      const oldWriteStart = client.writes.length;
      await writeBatchToRelayfile(client, [item.oldRecord], item.job);
      const oldAlias = findByEditedWrite(client.writes.slice(oldWriteStart), OLD_DATE);
      assert.ok(oldAlias, "expected first write to emit a by-edited alias");
      if (item.name === "Confluence pages") {
        assert.equal(
          findByEditedWrite(client.writes.slice(oldWriteStart), CONFLUENCE_CREATED_DATE),
          undefined,
          "Confluence by-edited aliases must prefer version.createdAt over page createdAt",
        );
      }
      assertResolvesToCanonical(client, oldAlias);

      const deleteStart = client.deletes.length;
      const newWriteStart = client.writes.length;
      await writeBatchToRelayfile(client, [item.newRecord], item.job);

      assert.ok(
        client.deletes.slice(deleteStart).includes(oldAlias.path),
        `expected stale alias ${oldAlias.path} to be deleted`,
      );
      const newAlias = findByEditedWrite(client.writes.slice(newWriteStart), NEW_DATE);
      assert.ok(newAlias, "expected second write to emit a new by-edited alias");
      if (item.name === "Confluence pages") {
        assert.equal(
          findByEditedWrite(client.writes.slice(newWriteStart), CONFLUENCE_CREATED_DATE),
          undefined,
          "Confluence by-edited aliases must continue to ignore unchanged page createdAt",
        );
      }
      assert.notEqual(newAlias.path, oldAlias.path);
      assertResolvesToCanonical(client, newAlias);
    });
  }
  for (const item of cases) {
    it(`${item.name}: re-sync of an unchanged record does not double-write or churn the by-edited alias`, async () => {
      const client = makeRecordingClient();

      const firstWriteStart = client.writes.length;
      await writeBatchToRelayfile(client, [item.newRecord], item.job);
      const firstAlias = findByEditedWrite(
        client.writes.slice(firstWriteStart),
        NEW_DATE,
      );
      assert.ok(firstAlias, "expected first sync to emit a by-edited alias");
      const aliasPath = firstAlias.path;
      const aliasContent = client.files.get(aliasPath);
      assert.ok(aliasContent, "by-edited alias should be persisted");

      // Re-sync the identical record (same edited date). This simulates the
      // day an upgraded @relayfile/adapter-* also emits the same tree: cloud
      // must remain idempotent — no stale-alias delete, no second/divergent
      // dated path, and the persisted alias unchanged — so a future adapter
      // that starts emitting the same tree fails this guard loudly.
      const deleteStart = client.deletes.length;
      await writeBatchToRelayfile(client, [item.newRecord], item.job);

      const byEditedDeletes = client.deletes
        .slice(deleteStart)
        .filter((p) => p.includes("/by-edited/"));
      assert.deepEqual(
        byEditedDeletes,
        [],
        `re-sync must not delete any by-edited alias, deleted: ${byEditedDeletes.join(
          ", ",
        )}`,
      );

      // Exactly one by-edited alias path exists for this record/date — cloud
      // is not creating a second, divergent dated alias under re-sync.
      const distinctByEditedPaths = new Set(
        client.writes
          .filter((w) => w.path.includes(`/by-edited/${NEW_DATE}/`))
          .map((w) => w.path),
      );
      assert.deepEqual(
        [...distinctByEditedPaths],
        [aliasPath],
        `expected a single stable by-edited/${NEW_DATE}/ alias path`,
      );

      // The persisted alias is unchanged and still resolves to a canonical
      // record the batch actually wrote (no path drift under re-sync).
      assert.equal(
        client.files.get(aliasPath),
        aliasContent,
        "re-sync must keep the persisted by-edited alias content stable",
      );
      assertResolvesToCanonical(client, { ...firstAlias, content: aliasContent });
    });
  }
});

function findByEditedWrite(
  writes: readonly RecordedWrite[],
  date: string,
): RecordedWrite | undefined {
  return writes.find((write) => write.path.includes(`/by-edited/${date}/`));
}

function assertResolvesToCanonical(
  client: RecordingClient,
  aliasWrite: RecordedWrite,
): void {
  const alias = JSON.parse(aliasWrite.content) as { canonicalPath?: unknown };
  assert.equal(typeof alias.canonicalPath, "string");
  assert.ok(
    client.files.has(alias.canonicalPath),
    `expected ${aliasWrite.path} to resolve to ${alias.canonicalPath}`,
  );
}
