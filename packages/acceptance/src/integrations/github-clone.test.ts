// @route POST /api/v1/github/clone
// @route POST /api/v1/github/clone/request
// @route GET /api/v1/github/clone/archive/[jobId]
// @route GET /api/v1/github/clone/status/[jobId]
// @route GET /api/v1/github/clone/status/by-repo
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  expectStatus,
  requestApi,
} from "../helpers/runtime";
import {
  envBody,
  errorSchema,
  githubCloneAuthMode,
  hasGithubCloneAuth,
  parseJson,
} from "./_helpers";

const cloneAcceptedSchema = z.object({
  ok: z.literal(true),
  jobId: z.string().min(1),
  status: z.enum(["queued", "running", "completed", "failed"]),
});

const cloneRouteErrorSchema = z.object({
  ok: z.literal(false).optional(),
  error: z.string().min(1),
}).passthrough();

const cloneStatusSchema = z.object({
  ok: z.literal(true),
  jobId: z.string().min(1),
  status: z.enum(["queued", "running", "completed", "failed"]),
  attempts: z.number(),
  lastError: z.string().nullable(),
  completedAt: z.string().nullable(),
  job: z.object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    owner: z.string().min(1),
    repo: z.string().min(1),
    ref: z.string().min(1),
    connectionId: z.string().min(1),
    status: z.enum(["queued", "running", "completed", "failed"]),
  }).passthrough(),
});

const cloneStatusErrorSchema = z.object({
  ok: z.literal(false),
  error: z.string().min(1),
});

const cloneByRepoSchema = z.object({
  state: z.string().min(1),
  jobId: z.string().min(1).optional(),
  queuedAt: z.string().nullable().optional(),
  startedAt: z.string().nullable().optional(),
  completedAt: z.string().nullable().optional(),
  headSha: z.string().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
  cloneSource: z.string().nullable().optional(),
}).passthrough();

const configuredCloneBody = envBody("ACCEPTANCE_GITHUB_CLONE_REQUEST_BODY");
const missingCloneQueryErrorSchema = z.object({
  error: z.string().min(1),
});

const RUNNING_AGAINST_PROD =
  process.env.ACCEPTANCE_BASE_URL?.replace(/\/+$/, "") ===
  "https://agentrelay.com/cloud";

describe("/api/v1/github/clone*", () => {
  it("rejects unauthenticated clone requests", async () => {
    const response = await requestApi("/api/v1/github/clone", {
      method: "POST",
      json: {
        workspaceId: "ws_test",
        owner: "octocat",
        repo: "hello-world",
      },
    });

    expect(response.status).toBe(401);
    const body = await parseJson(response, errorSchema);
    expect(body.error).toBe("Unauthorized");
  });

  it("rejects unauthenticated clone-request jobs", async () => {
    const response = await requestApi("/api/v1/github/clone/request", {
      method: "POST",
      json: {
        workspaceId: "ws_test",
        owner: "octocat",
        repo: "hello-world",
      },
    });

    expect(response.status).toBe(401);
    const body = await parseJson(response, cloneRouteErrorSchema);
    expect(body.error).toBe("Unauthorized");
  });

  it("rejects unauthenticated archive lease downloads", async () => {
    const response = await requestApi(
      "/api/v1/github/clone/archive/00000000-0000-4000-8000-000000000000",
    );

    expect(RUNNING_AGAINST_PROD ? [401, 404] : [401]).toContain(response.status);
    if (response.status === 404) {
      return;
    }

    const body = await parseJson(response, cloneRouteErrorSchema);
    expect(body.error).toBe("unauthorized");
  });

  (hasGithubCloneAuth() ? it : it.skip)(
    "rejects clone status lookups with missing by-repo query params",
    async () => {
      const response = await requestApi("/api/v1/github/clone/status/by-repo?owner=octocat", {
        auth: githubCloneAuthMode(),
      });

      expect(response.status).toBe(400);
      const body = await parseJson(response, missingCloneQueryErrorSchema);
      expect(body.error).toBe("workspaceId, owner, repo required");
    },
  );

  (hasGithubCloneAuth() ? it : it.skip)(
    "returns 404 for unknown clone status jobs",
    async () => {
      const response = await requestApi(
        "/api/v1/github/clone/status/00000000-0000-4000-8000-000000000000",
        {
          auth: githubCloneAuthMode(),
        },
      );

      expect(response.status).toBe(404);
      const body = await parseJson(response, cloneStatusErrorSchema);
      expect(body.error).toBe("Job not found");
    },
  );

  (hasGithubCloneAuth() ? it : it.skip)(
    "returns a no_jobs envelope when a repo has not been cloned yet",
    async () => {
      const response = await requestApi(
        "/api/v1/github/clone/status/by-repo?workspaceId=00000000-0000-0000-0000-000000000000&owner=octocat&repo=never-cloned",
        {
          auth: githubCloneAuthMode(),
        },
      );

      expect(response.status).toBe(200);
      const body = await parseJson(response, cloneByRepoSchema);
      expect(body.state).toBe("no_jobs");
    },
  );

  (hasGithubCloneAuth() && configuredCloneBody ? it : it.skip)(
    "accepts an async clone-request job",
    async () => {
      const response = await requestApi("/api/v1/github/clone/request", {
        method: "POST",
        auth: githubCloneAuthMode(),
        json: configuredCloneBody,
      });

      expect(response.status).toBe(202);
      await parseJson(response, cloneAcceptedSchema);
    },
  );

  (hasGithubCloneAuth() && configuredCloneBody ? it : it.skip)(
    "accepts a clone request and exposes status endpoints for the created job",
    async () => {
      const cloneResponse = await requestApi("/api/v1/github/clone", {
        method: "POST",
        auth: githubCloneAuthMode(),
        json: configuredCloneBody,
      });

      expect(cloneResponse.status).toBe(202);
      const accepted = await parseJson(cloneResponse, cloneAcceptedSchema);

      const statusResponse = await requestApi(
        `/api/v1/github/clone/status/${accepted.jobId}`,
        {
          auth: githubCloneAuthMode(),
        },
      );

      expect(statusResponse.status).toBe(200);
      await parseJson(statusResponse, cloneStatusSchema);

      if (!configuredCloneBody) return;
      const workspaceId = configuredCloneBody.workspaceId;
      const owner = configuredCloneBody.owner;
      const repo = configuredCloneBody.repo;
      if (
        typeof workspaceId === "string"
        && typeof owner === "string"
        && typeof repo === "string"
      ) {
        const byRepoResponse = await requestApi(
          `/api/v1/github/clone/status/by-repo?workspaceId=${encodeURIComponent(workspaceId)}&owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`,
          {
            auth: githubCloneAuthMode(),
          },
        );

        expectStatus(byRepoResponse, [200]);
        await parseJson(byRepoResponse, cloneByRepoSchema);
      }
    },
  );
});
