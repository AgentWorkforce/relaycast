// @route GET /api/v1/workflows/runs
// @route GET /api/v1/workflows/runs/[runId]
// @route GET /api/v1/workflows/runs/[runId]/agents
// @route GET /api/v1/workflows/runs/[runId]/events
// @route POST /api/v1/workflows/runs/[runId]/events
// @route GET /api/v1/workflows/runs/[runId]/logs
// @route GET /api/v1/workflows/runs/[runId]/steps
// @route GET /api/v1/workflows/runs/[runId]/patch
// @route GET /api/v1/workflows/runs/[runId]/export
// @route POST /api/v1/workflows/runs/[runId]/cancel
// @route POST /api/v1/workflows/runs/[runId]/clone/archive-lease
// @route PUT /api/v1/workflows/runs/[runId]/storage/[...objectKey]
// @route POST /api/v1/workflows/runs/[runId]/storage/[...objectKey]
// @route GET /api/v1/workflows/runs/[runId]/storage/[...objectKey]
// @route HEAD /api/v1/workflows/runs/[runId]/storage/[...objectKey]
// @route DELETE /api/v1/workflows/runs/[runId]/storage/[...objectKey]
import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  expectStatus,
  hasBearerAuth,
  hasUserAuth,
  hasSessionAuth,
  readJson,
  requestApi,
} from "../helpers/runtime";

const errorResponseSchema = z.object({
  error: z.string().min(1),
}).passthrough();

const workflowRecordSchema = z.object({
  runId: z.string().min(1),
  status: z.string().min(1),
  workflow: z.string().min(1),
  fileType: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
}).passthrough();

const logsSchema = z.object({
  content: z.string(),
  offset: z.number(),
  totalSize: z.number(),
  done: z.boolean(),
});

const agentsSchema = z.object({
  agents: z.array(
    z.object({
      name: z.string().min(1),
      hasLogs: z.boolean(),
    }),
  ),
});

const eventsSchema = z.object({
  events: z.array(z.object({ sequence: z.number() }).passthrough()),
});

const detailRunId = process.env.ACCEPTANCE_WORKFLOW_RUN_ID?.trim();

describe("/api/v1/workflows/runs", () => {
  it("rejects unauthenticated run listing", async () => {
    const response = await requestApi("/api/v1/workflows/runs");
    expectStatus(response, [401, 429]);

    if ((response.headers.get("content-type") ?? "").includes("application/json")) {
      if (response.status === 401) {
        errorResponseSchema.parse(await readJson(response));
      }
    }
  });

  it("rejects unauthenticated workflow agent listings", async () => {
    const response = await requestApi("/api/v1/workflows/runs/test-run/agents");
    expectStatus(response, [401, 429]);

    if ((response.headers.get("content-type") ?? "").includes("application/json")) {
      if (response.status === 401) {
        errorResponseSchema.parse(await readJson(response));
      }
    }
  });

  (detailRunId && hasUserAuth() ? it : it.skip)(
    "lists agent metadata for the configured workflow run",
    async () => {
      const response = await requestApi(
        `/api/v1/workflows/runs/${detailRunId}/agents`,
        { auth: "user" },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      agentsSchema.parse(await readJson(response));
    },
  );

  it("rejects unauthenticated workflow event listings", async () => {
    const response = await requestApi("/api/v1/workflows/runs/test-run/events");
    expectStatus(response, [401, 429]);

    if ((response.headers.get("content-type") ?? "").includes("application/json")) {
      if (response.status === 401) {
        errorResponseSchema.parse(await readJson(response));
      }
    }
  });

  it("rejects unauthenticated workflow event writes", async () => {
    const response = await requestApi("/api/v1/workflows/runs/test-run/events", {
      method: "POST",
      json: { eventType: "acceptance.test" },
    });
    expectStatus(response, [401, 429]);

    if ((response.headers.get("content-type") ?? "").includes("application/json")) {
      if (response.status === 401) {
        errorResponseSchema.parse(await readJson(response));
      }
    }
  });

  it("rejects unauthenticated workflow clone archive lease requests", async () => {
    const response = await requestApi(
      "/api/v1/workflows/runs/test-run/clone/archive-lease",
      {
        method: "POST",
        json: {
          owner: "octocat",
          repo: "hello-world",
          headSha: "0123456789abcdef0123456789abcdef01234567",
        },
      },
    );
    expectStatus(response, [401, 404, 429]);

    if ((response.headers.get("content-type") ?? "").includes("application/json")) {
      if (response.status === 401) {
        const body = errorResponseSchema.parse(await readJson(response));
        expect(body.error).toBe("unauthorized");
      }
    }
  });

  it("rejects unauthenticated workflow storage reads", async () => {
    const response = await requestApi("/api/v1/workflows/runs/test-run/storage/code.tar.gz");
    expectStatus(response, [401, 404, 429]);

    if ((response.headers.get("content-type") ?? "").includes("application/json")) {
      if (response.status === 401) {
        errorResponseSchema.parse(await readJson(response));
      }
    }
  });

  it("rejects unauthenticated workflow storage writes", async () => {
    const response = await requestApi("/api/v1/workflows/runs/test-run/storage/code.tar.gz", {
      method: "PUT",
      body: "tarball",
      headers: { "content-type": "application/gzip" },
    });
    expectStatus(response, [401, 404, 429]);

    if ((response.headers.get("content-type") ?? "").includes("application/json")) {
      if (response.status === 401) {
        errorResponseSchema.parse(await readJson(response));
      }
    }
  });

  it("rejects unauthenticated workflow storage multipart creation", async () => {
    const response = await requestApi("/api/v1/workflows/runs/test-run/storage/code.tar.gz?uploads=1", {
      method: "POST",
    });
    expectStatus(response, [401, 404, 429]);

    if ((response.headers.get("content-type") ?? "").includes("application/json")) {
      if (response.status === 401) {
        errorResponseSchema.parse(await readJson(response));
      }
    }
  });

  it("rejects unauthenticated workflow storage metadata reads", async () => {
    const response = await requestApi("/api/v1/workflows/runs/test-run/storage/code.tar.gz", {
      method: "HEAD",
    });
    expectStatus(response, [401, 404, 429]);
  });

  it("rejects unauthenticated workflow storage multipart aborts", async () => {
    const response = await requestApi("/api/v1/workflows/runs/test-run/storage/code.tar.gz?uploadId=test-upload", {
      method: "DELETE",
    });
    expectStatus(response, [401, 404, 429]);

    if ((response.headers.get("content-type") ?? "").includes("application/json")) {
      if (response.status === 401) {
        errorResponseSchema.parse(await readJson(response));
      }
    }
  });

  (detailRunId && hasUserAuth() ? it : it.skip)(
    "lists workflow events for the configured run",
    async () => {
      const response = await requestApi(
        `/api/v1/workflows/runs/${detailRunId}/events?after=0&limit=10&sort=asc`,
        { auth: "user" },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      eventsSchema.parse(await readJson(response));
    },
  );

  (hasSessionAuth() ? it : it.skip)(
    "lists workflow runs for the authenticated session",
    async () => {
      const response = await requestApi("/api/v1/workflows/runs", {
        auth: "user",
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      const body = await readJson<{ runs: unknown[] }>(response);
      expect(Array.isArray(body.runs)).toBe(true);
      for (const run of body.runs) {
        workflowRecordSchema.parse(run);
      }
    },
  );

  (detailRunId && hasBearerAuth() ? it : it.skip)(
    "reads the configured workflow run detail",
    async () => {
      const response = await requestApi(`/api/v1/workflows/runs/${detailRunId}`, {
        auth: "user",
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      const parsed = workflowRecordSchema.parse(await readJson(response));
      expect(parsed.runId).toBe(detailRunId);
    },
  );

  const logsRunId = process.env.ACCEPTANCE_WORKFLOW_LOGS_RUN_ID?.trim() ?? detailRunId;
  (logsRunId && hasBearerAuth() ? it : it.skip)(
    "reads workflow logs with the documented incremental payload",
    async () => {
      const response = await requestApi(
        `/api/v1/workflows/runs/${logsRunId}/logs?offset=0`,
        { auth: "user" },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      logsSchema.parse(await readJson(response));
    },
  );

  const stepsRunId = process.env.ACCEPTANCE_WORKFLOW_STEPS_RUN_ID?.trim() ?? detailRunId;
  (stepsRunId && hasBearerAuth() ? it : it.skip)(
    "reads workflow step metadata",
    async () => {
      const response = await requestApi(
        `/api/v1/workflows/runs/${stepsRunId}/steps`,
        { auth: "user" },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      const body = await readJson<{ steps: unknown[] }>(response);
      expect(Array.isArray(body.steps)).toBe(true);
    },
  );

  const patchRunId = process.env.ACCEPTANCE_WORKFLOW_PATCH_RUN_ID?.trim();
  (patchRunId && hasBearerAuth() ? it : it.skip)(
    "reads workflow patch output for a completed run",
    async () => {
      const response = await requestApi(
        `/api/v1/workflows/runs/${patchRunId}/patch`,
        { auth: "user" },
      );

      expectStatus(response, [200, 404, 409]);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      if (response.status !== 200) {
        errorResponseSchema.parse(await readJson(response));
      }
    },
  );

  const exportRunId = process.env.ACCEPTANCE_WORKFLOW_EXPORT_RUN_ID?.trim();
  (exportRunId && hasBearerAuth() ? it : it.skip)(
    "exports the workflow workspace artifact",
    async () => {
      const response = await requestApi(
        `/api/v1/workflows/runs/${exportRunId}/export`,
        { auth: "user" },
      );

      expectStatus(response, [200, 404, 409, 500, 502]);
      expect(response.headers.get("content-type")).toBeTruthy();
    },
  );

  const cancelRunId = process.env.ACCEPTANCE_WORKFLOW_CANCEL_RUN_ID?.trim();
  (cancelRunId && hasUserAuth() ? it : it.skip)(
    "cancels the configured workflow run",
    async () => {
      const response = await requestApi(
        `/api/v1/workflows/runs/${cancelRunId}/cancel`,
        {
          method: "POST",
          auth: "user",
        },
      );

      expectStatus(response, [200, 404, 409]);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      if (response.status !== 200) {
        errorResponseSchema.parse(await readJson(response));
      }
    },
  );
});
