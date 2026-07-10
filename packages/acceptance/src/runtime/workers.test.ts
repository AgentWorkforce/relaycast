// @route GET /api/v1/workers
// @route GET /api/v1/workers/[workerId]
// @route DELETE /api/v1/workers/[workerId]
// @route POST /api/v1/workers/register
// @route POST /api/v1/workers/enrollment-tokens
// @route POST /api/v1/workers/[workerId]/heartbeat
// @route GET /api/v1/workers/[workerId]/queue
// @route POST /api/v1/workers/[workerId]/assignments/[runId]/ack
// @route POST /api/v1/workers/[workerId]/assignments/[runId]/status
// @route GET /api/v1/workers/[workerId]/assignments/[runId]/storage/[...objectKey]
// @route HEAD /api/v1/workers/[workerId]/assignments/[runId]/storage/[...objectKey]
import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  envJson,
  expectErrorLike,
  expectJsonError,
  expectStatus,
  expectSseShape,
  hasSessionAuth,
  hasWorkerAuth,
  readJson,
  requestApi,
} from "../helpers/runtime";

const errorResponseSchema = z.object({
  error: z.string().min(1),
}).passthrough();

const workerListSchema = z.object({
  workers: z.array(z.unknown()),
});

const workerDetailSchema = z.object({
  worker: z.unknown(),
}).passthrough();

const registerSchema = z.object({
  workerId: z.string().min(1),
  workerToken: z.string().min(1),
  heartbeatIntervalMs: z.number(),
});

const workerDeleteSchema = z.object({
  workerId: z.string().min(1),
  status: z.string().min(1),
}).passthrough();

describe("/api/v1/workers", () => {
  it("rejects unauthenticated worker listing", async () => {
    const body = await expectJsonError("/api/v1/workers", {
      allowedStatus: [401, 429],
    });

    expectErrorLike(body as Record<string, unknown>);
  });

  (hasSessionAuth() ? it : it.skip)(
    "lists workspace workers",
    async () => {
      const response = await requestApi("/api/v1/workers", {
        auth: "user",
      });

      expect(response.status).toBe(200);
      workerListSchema.parse(await readJson(response));
    },
  );

  const detailWorkerId = process.env.ACCEPTANCE_WORKER_ID?.trim();
  (detailWorkerId && hasSessionAuth() ? it : it.skip)(
    "reads the configured worker detail payload",
    async () => {
      const response = await requestApi(`/api/v1/workers/${detailWorkerId}`, {
        auth: "user",
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      workerDetailSchema.parse(await readJson(response));
    },
  );

  const deleteWorkerId = process.env.ACCEPTANCE_WORKER_DELETE_ID?.trim() ?? detailWorkerId;
  (deleteWorkerId && hasSessionAuth() ? it : it.skip)(
    "revokes the configured worker",
    async () => {
      const response = await requestApi(`/api/v1/workers/${deleteWorkerId}`, {
        method: "DELETE",
        auth: "user",
      });

      expectStatus(response, [200, 404, 500]);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      if (response.status === 200) {
        workerDeleteSchema.parse(await readJson(response));
        return;
      }
      errorResponseSchema.parse(await readJson(response));
    },
  );

  it("rejects malformed worker registration bodies", async () => {
    const response = await requestApi("/api/v1/workers/register", {
      method: "POST",
      json: {},
    });
    expectStatus(response, [400, 429]);

    if ((response.headers.get("content-type") ?? "").includes("application/json")) {
      if (response.status === 400) {
        errorResponseSchema.parse(await readJson(response));
      }
    }
  });

  const enrollmentToken = process.env.ACCEPTANCE_WORKER_ENROLLMENT_TOKEN?.trim();
  const registerBody = envJson<unknown>("ACCEPTANCE_WORKER_REGISTER_BODY") ?? (
    enrollmentToken
      ? {
          enrollmentToken,
          name: process.env.ACCEPTANCE_WORKER_REGISTER_NAME?.trim() ?? "acceptance-worker",
        }
      : undefined
  );
  (registerBody ? it : it.skip)(
    "registers a worker from the configured enrollment token",
    async () => {
      const response = await requestApi("/api/v1/workers/register", {
        method: "POST",
        json: registerBody,
      });

      expectStatus(response, [200, 401, 409]);
      if (response.status === 200) {
        registerSchema.parse(await readJson(response));
      }
    },
  );

  const enrollmentBody = envJson<unknown>("ACCEPTANCE_WORKER_ENROLLMENT_BODY");
  (enrollmentBody && hasSessionAuth() ? it : it.skip)(
    "mints an enrollment token for the supplied workspace/body",
    async () => {
      const response = await requestApi("/api/v1/workers/enrollment-tokens", {
        method: "POST",
        auth: "user",
        json: enrollmentBody,
      });

      expectStatus(response, [200, 403, 404, 429]);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      if (response.status !== 200) {
        errorResponseSchema.parse(await readJson(response));
      }
    },
  );

  const heartbeatWorkerId = process.env.ACCEPTANCE_WORKER_ID?.trim();
  (heartbeatWorkerId && hasWorkerAuth() ? it : it.skip)(
    "accepts a worker heartbeat",
    async () => {
      const response = await requestApi(
        `/api/v1/workers/${heartbeatWorkerId}/heartbeat`,
        {
          method: "POST",
          auth: "worker",
        },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      z.record(z.string(), z.unknown()).parse(await readJson(response));
    },
  );

  const queueWorkerId = process.env.ACCEPTANCE_WORKER_ID?.trim();
  (queueWorkerId && hasWorkerAuth() ? it : it.skip)(
    "streams the worker assignment queue as SSE",
    async () => {
      await expectSseShape(`/api/v1/workers/${queueWorkerId}/queue`, {
        auth: "worker",
      });
    },
  );

  const assignmentWorkerId = process.env.ACCEPTANCE_WORKER_ID?.trim();
  const assignmentRunId = process.env.ACCEPTANCE_WORKER_ASSIGNMENT_RUN_ID?.trim();
  (assignmentWorkerId && assignmentRunId && hasWorkerAuth() ? it : it.skip)(
    "acks the configured worker assignment",
    async () => {
      const response = await requestApi(
        `/api/v1/workers/${assignmentWorkerId}/assignments/${assignmentRunId}/ack`,
        {
          method: "POST",
          auth: "worker",
        },
      );

      expectStatus(response, [200, 404]);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      z.record(z.string(), z.unknown()).parse(await readJson(response));
    },
  );

  const statusBody =
    envJson<unknown>("ACCEPTANCE_WORKER_ASSIGNMENT_STATUS_BODY") ??
    { phase: "running" };
  (assignmentWorkerId && assignmentRunId && hasWorkerAuth() ? it : it.skip)(
    "updates assignment status for the configured worker/run pair",
    async () => {
      const response = await requestApi(
        `/api/v1/workers/${assignmentWorkerId}/assignments/${assignmentRunId}/status`,
        {
          method: "POST",
          auth: "worker",
          json: statusBody,
        },
      );

      expectStatus(response, [200, 404]);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      z.record(z.string(), z.unknown()).parse(await readJson(response));
    },
  );
});
