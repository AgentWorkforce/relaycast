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

type GitLabModel =
  | "GitLabProject"
  | "GitLabMergeRequest"
  | "GitLabIssue"
  | "GitLabCommit"
  | "GitLabPipeline"
  | "GitLabPipelineJob"
  | "GitLabDeployment"
  | "GitLabTag";

function gitlabJob(model: GitLabModel): NangoSyncJob {
  const syncName =
    model === "GitLabProject"
      ? "fetch-projects"
      : model === "GitLabMergeRequest"
        ? "fetch-merge-requests"
        : model === "GitLabIssue"
          ? "fetch-issues"
          : model === "GitLabCommit"
            ? "fetch-commits"
            : model === "GitLabPipeline" || model === "GitLabPipelineJob"
              ? "fetch-pipelines"
              : model === "GitLabDeployment"
                ? "fetch-deployments"
                : "fetch-tags";

  return {
    type: "nango_sync",
    workspaceId: "rw_test",
    provider: "gitlab",
    providerConfigKey: "gitlab-relay",
    connectionId: "conn_gitlab",
    syncName,
    model,
    cursor: null,
    modifiedAfter: "1970-01-01T00:00:00.000Z",
  };
}

const samples: Record<GitLabModel, Record<string, unknown>> = {
  GitLabProject: {
    id: "20",
    name: "api",
    name_with_namespace: "Acme / API",
    path_with_namespace: "acme/api",
    updated_at: "2026-05-15T09:00:00.000Z",
    web_url: "https://gitlab.com/acme/api",
  },
  GitLabMergeRequest: {
    id: "9001",
    iid: "7",
    project_id: "20",
    project_path: "acme/api",
    title: "Ship relayfile state updates",
    state: "merged",
    updated_at: "2026-05-15T10:00:00.000Z",
    web_url: "https://gitlab.com/acme/api/-/merge_requests/7",
  },
  GitLabIssue: {
    id: "3001",
    iid: "17",
    project_id: "20",
    project_path: "acme/api",
    title: "Fix webhook fanout",
    state: "opened",
    updated_at: "2026-05-15T10:30:00.000Z",
    web_url: "https://gitlab.com/acme/api/-/issues/17",
  },
  GitLabCommit: {
    id: "abc123def456",
    short_id: "abc123",
    project_id: "20",
    project_path: "acme/api",
    title: "Add parity smoke",
    committed_date: "2026-05-15T11:00:00.000Z",
    updated_at: "2026-05-15T11:00:00.000Z",
    web_url: "https://gitlab.com/acme/api/-/commit/abc123def456",
  },
  GitLabPipeline: {
    id: "501",
    project_id: "20",
    project_path: "acme/api",
    ref: "main",
    status: "success",
    updated_at: "2026-05-15T11:30:00.000Z",
    web_url: "https://gitlab.com/acme/api/-/pipelines/501",
  },
  GitLabPipelineJob: {
    id: "7001",
    pipeline_id: "501",
    project_id: "20",
    project_path: "acme/api",
    name: "unit-tests",
    ref: "main",
    status: "success",
    updated_at: "2026-05-15T11:45:00.000Z",
    web_url: "https://gitlab.com/acme/api/-/jobs/7001",
  },
  GitLabDeployment: {
    id: "8101",
    project_id: "20",
    project_path: "acme/api",
    ref: "main",
    status: "success",
    environment_name: "production",
    updated_at: "2026-05-15T11:50:00.000Z",
  },
  GitLabTag: {
    id: "20:v1.2.3",
    ref: "v1.2.3",
    project_id: "20",
    project_path: "acme/api",
    target: "abc123def456",
    updated_at: "2026-05-15T12:00:00.000Z",
  },
};

function plan(model: GitLabModel) {
  const job = gitlabJob(model);
  return planProviderRecordWrites(
    job,
    [samples[model]],
    enabledOnly(providerModelKey(job)),
  );
}

function deleteByPath(
  writes: readonly { path: string; delete?: boolean }[],
  path: string,
): void {
  const write = writes.find((candidate) => candidate.path === path);
  assert.ok(write, `expected planned delete for ${path}`);
  assert.equal(write.delete, true, `${path} should be a delete`);
}

describe("GitLab provider write planner smoke parity", () => {
  it("schema-conforms all sampled GitLab records to the generated model contracts", async () => {
    for (const [model, record] of Object.entries(samples) as Array<[GitLabModel, Record<string, unknown>]>) {
      await assertGeneratedModelSchema(model, record);
    }

    await assert.rejects(
      assertGeneratedModelSchema("GitLabMergeRequest", { id: "9001" }),
      /iid/,
    );
  });

  it("plans canonical, index, and at least one by-* alias write for each GitLab model", () => {
    const expectations: Record<GitLabModel, { canonical: string; index: string; alias: string }> = {
      GitLabProject: {
        canonical: "/gitlab/projects/acme/api/meta.json",
        index: "/gitlab/projects/_index.json",
        alias: "/gitlab/projects/by-id/20.json",
      },
      GitLabMergeRequest: {
        canonical: "/gitlab/projects/acme/api/merge_requests/7__ship-relayfile-state-updates/meta.json",
        index: "/gitlab/projects/acme/api/merge_requests/_index.json",
        alias: "/gitlab/projects/acme/api/merge_requests/by-id/7.json",
      },
      GitLabIssue: {
        canonical: "/gitlab/projects/acme/api/issues/17__fix-webhook-fanout/meta.json",
        index: "/gitlab/projects/acme/api/issues/_index.json",
        alias: "/gitlab/projects/acme/api/issues/by-id/17.json",
      },
      GitLabCommit: {
        canonical: "/gitlab/projects/acme/api/commits/abc123def456__add-parity-smoke/meta.json",
        index: "/gitlab/projects/acme/api/commits/_index.json",
        alias: "/gitlab/projects/acme/api/commits/by-id/abc123def456.json",
      },
      GitLabPipeline: {
        canonical: "/gitlab/projects/acme/api/pipelines/501__main/meta.json",
        index: "/gitlab/projects/acme/api/pipelines/_index.json",
        alias: "/gitlab/projects/acme/api/pipelines/by-id/501.json",
      },
      GitLabPipelineJob: {
        canonical: "/gitlab/projects/acme/api/pipelines/501/jobs/main__7001.json",
        index: "/gitlab/projects/acme/api/jobs/_index.json",
        alias: "/gitlab/projects/acme/api/jobs/by-id/7001.json",
      },
      GitLabDeployment: {
        canonical: "/gitlab/projects/acme/api/deployments/8101__8101/meta.json",
        index: "/gitlab/projects/acme/api/deployments/_index.json",
        alias: "/gitlab/projects/acme/api/deployments/by-id/8101.json",
      },
      GitLabTag: {
        canonical: "/gitlab/projects/acme/api/tags/v1-2-3__v1.2.3.json",
        index: "/gitlab/projects/acme/api/tags/_index.json",
        alias: "/gitlab/projects/acme/api/tags/by-ref/v1-2-3__v1.2.3.json",
      },
    };

    for (const [model, expected] of Object.entries(expectations) as Array<[GitLabModel, { canonical: string; index: string; alias: string }]>) {
      const result = plan(model);
      assert.equal(result.written, 1, model);
      writeByPath(result.writes, expected.canonical);
      writeByPath(result.writes, expected.index);
      writeByPath(result.writes, expected.alias);
    }
  });

  it("deletes prior GitLab pipeline aliases when a tombstone omits ref details", () => {
    const job = gitlabJob("GitLabPipeline");
    const prior = samples.GitLabPipeline;
    const canonicalPath = "/gitlab/projects/acme/api/pipelines/501__main/meta.json";
    const priorAlias = JSON.stringify({
      id: "501",
      canonicalPath,
      projectPath: "acme/api",
      title: "main",
    });
    const priorRefAlias = JSON.stringify({
      id: "501",
      canonicalPath,
      projectPath: "acme/api",
      title: "main",
      ref: "main",
    });

    const result = planProviderRecordWrites(
      job,
      [{ id: "501", project_path: "acme/api", _nango_metadata: { last_action: "deleted" } }],
      enabledOnly(providerModelKey(job)),
      {
        existingFiles: new Map([
          [canonicalPath, JSON.stringify(prior)],
          ["/gitlab/projects/acme/api/pipelines/by-id/501.json", priorAlias],
          ["/gitlab/projects/acme/api/pipelines/by-ref/main/501.json", priorRefAlias],
          ["/gitlab/projects/acme/api/pipelines/_index.json", JSON.stringify([{ id: "501", title: "main" }])],
        ]),
      },
    );

    assert.equal(result.deleted, 1);
    deleteByPath(result.writes, canonicalPath);
    deleteByPath(result.writes, "/gitlab/projects/acme/api/pipelines/by-id/501.json");
    deleteByPath(result.writes, "/gitlab/projects/acme/api/pipelines/by-ref/main/501.json");
  });

  it("removes stale GitLab deployment status aliases on status change", () => {
    const job = gitlabJob("GitLabDeployment");
    const prior = { ...samples.GitLabDeployment, status: "running" };
    const next = { ...samples.GitLabDeployment, status: "success" };
    const canonicalPath = "/gitlab/projects/acme/api/deployments/8101__8101/meta.json";
    const priorAlias = JSON.stringify({
      id: "8101",
      canonicalPath,
      projectPath: "acme/api",
      title: "8101",
    });

    const result = planProviderRecordWrites(
      job,
      [next],
      enabledOnly(providerModelKey(job)),
      {
        existingFiles: new Map([
          [canonicalPath, JSON.stringify(prior)],
          ["/gitlab/projects/acme/api/deployments/by-id/8101.json", priorAlias],
          ["/gitlab/projects/acme/api/deployments/by-status/running/8101.json", priorAlias],
        ]),
      },
    );

    assert.equal(result.written, 1);
    deleteByPath(result.writes, "/gitlab/projects/acme/api/deployments/by-status/running/8101.json");
    writeByPath(result.writes, "/gitlab/projects/acme/api/deployments/by-status/success/8101.json");
  });

  it("scopes GitLab index removals to the affected project index", () => {
    const job = gitlabJob("GitLabIssue");
    const canonicalPath = "/gitlab/projects/acme/api/issues/17__fix-webhook-fanout/meta.json";
    const alias = JSON.stringify({
      id: "17",
      canonicalPath,
      projectPath: "acme/api",
      title: "Fix webhook fanout",
    });

    const result = planProviderRecordWrites(
      job,
      [{
        iid: "17",
        project_path: "acme/api",
        _nango_metadata: { last_action: "deleted" },
      }],
      enabledOnly(providerModelKey(job)),
      {
        existingFiles: new Map([
          [canonicalPath, JSON.stringify(samples.GitLabIssue)],
          ["/gitlab/projects/acme/api/issues/by-id/17.json", alias],
          ["/gitlab/projects/acme/api/issues/_index.json", JSON.stringify([{ id: "17", title: "API issue" }])],
          ["/gitlab/projects/acme/web/issues/_index.json", JSON.stringify([{ id: "17", title: "Web issue" }])],
        ]),
      },
    );

    const apiIndex = writeByPath(result.writes, "/gitlab/projects/acme/api/issues/_index.json");
    assert.deepEqual(JSON.parse(apiIndex.contents ?? "[]"), []);
    assert.equal(
      result.writes.some((write) => write.path === "/gitlab/projects/acme/web/issues/_index.json"),
      false,
      "delete in acme/api must not rewrite or prune acme/web index",
    );
  });

  it("surfaces one planned GitLab record in today's digest", async () => {
    const result = plan("GitLabIssue");
    const write = writeByPath(
      result.writes,
      "/gitlab/projects/acme/api/issues/17__fix-webhook-fanout/meta.json",
    );

    const digest = await renderTodayDigest({
      provider: "gitlab",
      path: write.path,
      contents: write.contents ?? "",
      timestamp: "2026-05-15T10:30:00.000Z",
    });

    assert.ok(digest.includes("covers: today"));
    assert.ok(digest.includes("/gitlab/projects/acme/api/issues/17__fix-webhook-fanout/meta.json"));
    assert.ok(digest.includes("issue #17 was updated"));
  });

  it("acks malformed GitLab planner input without throwing", () => {
    const job = gitlabJob("GitLabIssue");
    assertNoThrowForMalformed(() =>
      planProviderRecordWrites(
        job,
        [null, "", { iid: "17", title: "missing project context" }] as unknown as Record<string, unknown>[],
        enabledOnly(providerModelKey(job)),
      ),
    );
  });
});
