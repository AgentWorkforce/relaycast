import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NangoSyncJob } from "../src/sync/nango-sync-job.js";
import {
  planProviderRecordWrites,
  providerModelKey,
} from "../src/sync/provider-write-planner.js";
import {
  assertGeneratedModelSchema,
  assertNoThrowForMalformed,
  enabledOnly,
  renderTodayDigest,
  writeByPath,
} from "./provider-write-planner-smoke-helpers.js";

type JiraModel = "JiraIssue" | "JiraProject" | "JiraSprint";

function jiraJob(model: JiraModel): NangoSyncJob {
  return {
    type: "nango_sync",
    workspaceId: "rw_test",
    provider: "jira",
    providerConfigKey: "jira-relay",
    connectionId: "conn_jira",
    syncName:
      model === "JiraIssue"
        ? "fetch-issues"
        : model === "JiraProject"
          ? "fetch-projects"
          : "fetch-sprints",
    model,
    cursor: null,
    modifiedAfter: "1970-01-01T00:00:00.000Z",
  };
}

const jiraIssue = {
  id: "10001",
  key: "ENG-1",
  self: "https://example.atlassian.net/rest/api/3/issue/10001",
  web_url: "https://example.atlassian.net/browse/ENG-1",
  fields: {
    summary: "Finish import",
    status: { id: "3", name: "Done" },
    project: { id: "100", key: "ENG", name: "Engineering" },
    assignee: { accountId: "acct-1", displayName: "Alice Example" },
    updated: "2026-05-15T09:00:00.000Z",
  },
};

const jiraProject = {
  id: "100",
  key: "ENG",
  name: "Engineering",
  self: "https://example.atlassian.net/rest/api/3/project/100",
  web_url: "https://example.atlassian.net/jira/software/projects/ENG",
};

const jiraSprint = {
  id: "200",
  name: "Platform Sprint 42",
  state: "active",
  board_id: "55",
  start_date: "2026-05-01T00:00:00.000Z",
  end_date: "2026-05-14T00:00:00.000Z",
};

function plan(model: JiraModel, record: Record<string, unknown>) {
  const job = jiraJob(model);
  return planProviderRecordWrites(job, [record], enabledOnly(providerModelKey(job)));
}

function deleteByPath(
  writes: readonly { path: string; delete?: boolean }[],
  path: string,
): void {
  const write = writes.find((candidate) => candidate.path === path);
  assert.ok(write, `expected planned delete for ${path}`);
  assert.equal(write.delete, true, `${path} should be a delete`);
}

describe("Jira provider write planner smoke parity", () => {
  it("schema-conforms all sampled Jira records to the generated model contracts", async () => {
    await assertGeneratedModelSchema("JiraIssue", jiraIssue);
    await assertGeneratedModelSchema("JiraProject", jiraProject);
    await assertGeneratedModelSchema("JiraSprint", jiraSprint);

    await assert.rejects(
      assertGeneratedModelSchema("JiraIssue", { id: "10001" }),
      /key/,
    );
  });

  it("plans Jira issue canonical, index, and by-* alias writes", () => {
    const result = plan("JiraIssue", jiraIssue);

    assert.equal(result.written, 1);
    writeByPath(result.writes, "/jira/issues/finish-import__10001.json");
    writeByPath(result.writes, "/jira/issues/_index.json");
    writeByPath(result.writes, "/jira/issues/by-id/10001.json");
    writeByPath(result.writes, "/jira/issues/by-key/ENG-1.json");
    writeByPath(result.writes, "/jira/issues/by-state/done/10001.json");
    writeByPath(result.writes, "/jira/issues/by-assignee/acct-1/10001.json");
    writeByPath(result.writes, "/jira/issues/by-edited/2026-05-15/10001.json");
  });

  it("plans Jira project and sprint smoke writes", () => {
    const project = plan("JiraProject", jiraProject);
    writeByPath(project.writes, "/jira/projects/engineering__100.json");
    writeByPath(project.writes, "/jira/projects/by-id/100.json");
    writeByPath(project.writes, "/jira/projects/_index.json");

    const sprint = plan("JiraSprint", jiraSprint);
    writeByPath(sprint.writes, "/jira/sprints/platform-sprint-42__200.json");
    writeByPath(sprint.writes, "/jira/sprints/by-id/200.json");
    writeByPath(sprint.writes, "/jira/sprints/_index.json");
  });

  it("deletes all prior Jira issue aliases when a tombstone only carries the id", () => {
    const job = jiraJob("JiraIssue");
    const priorCanonicalPath = "/jira/issues/finish-import__10001.json";
    const priorAlias = JSON.stringify({
      provider: "jira",
      objectType: "issue",
      objectId: "10001",
      payload: jiraIssue,
      path: priorCanonicalPath,
    });
    const result = planProviderRecordWrites(
      job,
      [{ id: "10001", _nango_metadata: { last_action: "deleted" } }],
      enabledOnly(providerModelKey(job)),
      {
        existingFiles: new Map([
          [priorCanonicalPath, JSON.stringify(jiraIssue)],
          ["/jira/issues/by-id/10001.json", priorAlias],
          ["/jira/issues/by-key/ENG-1.json", priorAlias],
          ["/jira/issues/by-state/done/10001.json", priorAlias],
          ["/jira/issues/by-assignee/acct-1/10001.json", priorAlias],
          ["/jira/issues/by-edited/2026-05-15/10001.json", priorAlias],
          ["/jira/issues/_index.json", JSON.stringify([{ id: "10001", key: "ENG-1" }])],
        ]),
      },
    );

    assert.equal(result.deleted, 1);
    deleteByPath(result.writes, priorCanonicalPath);
    deleteByPath(result.writes, "/jira/issues/by-id/10001.json");
    deleteByPath(result.writes, "/jira/issues/by-key/ENG-1.json");
    deleteByPath(result.writes, "/jira/issues/by-state/done/10001.json");
    deleteByPath(result.writes, "/jira/issues/by-assignee/acct-1/10001.json");
    deleteByPath(result.writes, "/jira/issues/by-edited/2026-05-15/10001.json");
  });

  it("removes stale Jira issue aliases when key, status, assignee, or edited date changes", () => {
    const job = jiraJob("JiraIssue");
    const prior = {
      ...jiraIssue,
      key: "ENG-1",
      fields: {
        ...jiraIssue.fields,
        status: { id: "2", name: "To Do" },
        assignee: { accountId: "acct-old", displayName: "Old Owner" },
        updated: "2026-05-14T09:00:00.000Z",
      },
    };
    const next = {
      ...jiraIssue,
      key: "ENG-2",
      fields: {
        ...jiraIssue.fields,
        status: { id: "3", name: "Done" },
        assignee: { accountId: "acct-1", displayName: "Alice Example" },
        updated: "2026-05-15T09:00:00.000Z",
      },
    };
    const canonicalPath = "/jira/issues/finish-import__10001.json";
    const priorAlias = JSON.stringify({
      provider: "jira",
      objectType: "issue",
      objectId: "10001",
      payload: prior,
      path: canonicalPath,
    });

    const result = planProviderRecordWrites(
      job,
      [next],
      enabledOnly(providerModelKey(job)),
      {
        existingFiles: new Map([
          [canonicalPath, JSON.stringify(prior)],
          ["/jira/issues/by-id/10001.json", priorAlias],
          ["/jira/issues/by-key/ENG-1.json", priorAlias],
          ["/jira/issues/by-state/to-do/10001.json", priorAlias],
          ["/jira/issues/by-assignee/acct-old/10001.json", priorAlias],
          ["/jira/issues/by-edited/2026-05-14/10001.json", priorAlias],
        ]),
      },
    );

    assert.equal(result.written, 1);
    deleteByPath(result.writes, "/jira/issues/by-key/ENG-1.json");
    deleteByPath(result.writes, "/jira/issues/by-state/to-do/10001.json");
    deleteByPath(result.writes, "/jira/issues/by-assignee/acct-old/10001.json");
    deleteByPath(result.writes, "/jira/issues/by-edited/2026-05-14/10001.json");
    writeByPath(result.writes, "/jira/issues/by-key/ENG-2.json");
    writeByPath(result.writes, "/jira/issues/by-state/done/10001.json");
    writeByPath(result.writes, "/jira/issues/by-assignee/acct-1/10001.json");
    writeByPath(result.writes, "/jira/issues/by-edited/2026-05-15/10001.json");
  });

  it("surfaces one planned Jira record in today's digest", async () => {
    const result = plan("JiraIssue", jiraIssue);
    const write = writeByPath(result.writes, "/jira/issues/finish-import__10001.json");

    const digest = await renderTodayDigest({
      provider: "jira",
      path: write.path,
      contents: write.contents ?? "",
      timestamp: "2026-05-15T09:00:00.000Z",
    });

    assert.ok(digest.includes("covers: today"));
    assert.ok(digest.includes("/jira/issues/finish-import__10001.json"));
    assert.ok(digest.includes("finish-import was completed"));
  });

  it("acks malformed Jira planner input without throwing", () => {
    const job = jiraJob("JiraIssue");
    assertNoThrowForMalformed(() =>
      planProviderRecordWrites(
        job,
        [null, false, { fields: { summary: "missing id" } }] as unknown as Record<string, unknown>[],
        enabledOnly(providerModelKey(job)),
      ),
    );
  });
});
