// @route GET /api/v1/workflows/schedules
// @route POST /api/v1/workflows/schedules
// @route GET /api/v1/workflows/schedules/[scheduleId]
// @route PATCH /api/v1/workflows/schedules/[scheduleId]
// @route DELETE /api/v1/workflows/schedules/[scheduleId]
// @route POST /api/v1/workflows/schedules/trigger
import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  envJson,
  expectJsonError,
  expectStatus,
  hasUserAuth,
  readJson,
  requestApi,
} from "../helpers/runtime";

const errorResponseSchema = z.object({
  error: z.string().min(1),
}).passthrough();

const scheduleSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  status: z.string().min(1),
  scheduleType: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
}).passthrough();

describe("/api/v1/workflows/schedules", () => {
  it("rejects unauthenticated schedule listing", async () => {
    const response = await requestApi("/api/v1/workflows/schedules");
    expectStatus(response, [401, 429]);

    if ((response.headers.get("content-type") ?? "").includes("application/json")) {
      if (response.status === 401) {
        errorResponseSchema.parse(await readJson(response));
      }
    }
  });

  (hasUserAuth() ? it : it.skip)(
    "lists workflow schedules for the authenticated caller",
    async () => {
      const response = await requestApi("/api/v1/workflows/schedules", {
        auth: "user",
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      const body = await readJson<{ schedules: unknown[] }>(response);
      expect(Array.isArray(body.schedules)).toBe(true);
      for (const schedule of body.schedules) {
        scheduleSchema.parse(schedule);
      }
    },
  );

  const createBody = envJson<unknown>("ACCEPTANCE_WORKFLOW_SCHEDULE_CREATE_BODY");
  (createBody && hasUserAuth() ? it : it.skip)(
    "creates a workflow schedule from the supplied fixture body",
    async () => {
      const response = await requestApi("/api/v1/workflows/schedules", {
        method: "POST",
        auth: "user",
        json: createBody,
      });

      expect(response.status).toBe(201);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      const body = await readJson<{ schedule: unknown }>(response);
      scheduleSchema.parse(body.schedule);
    },
  );

  const scheduleId = process.env.ACCEPTANCE_WORKFLOW_SCHEDULE_ID?.trim();
  (scheduleId && hasUserAuth() ? it : it.skip)(
    "reads the configured workflow schedule",
    async () => {
      const response = await requestApi(`/api/v1/workflows/schedules/${scheduleId}`, {
        auth: "user",
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      const body = await readJson<{ schedule: unknown }>(response);
      scheduleSchema.parse(body.schedule);
    },
  );

  const patchId = process.env.ACCEPTANCE_WORKFLOW_SCHEDULE_PATCH_ID?.trim();
  const patchBody =
    envJson<unknown>("ACCEPTANCE_WORKFLOW_SCHEDULE_PATCH_BODY") ??
    { status: "paused" };
  (patchId && hasUserAuth() ? it : it.skip)(
    "patches the configured workflow schedule",
    async () => {
      const response = await requestApi(
        `/api/v1/workflows/schedules/${patchId}`,
        {
          method: "PATCH",
          auth: "user",
          json: patchBody,
        },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      const body = await readJson<{ schedule: unknown }>(response);
      scheduleSchema.parse(body.schedule);
    },
  );

  const deleteId = process.env.ACCEPTANCE_WORKFLOW_SCHEDULE_DELETE_ID?.trim();
  (deleteId && hasUserAuth() ? it : it.skip)(
    "deletes the configured workflow schedule",
    async () => {
      const response = await requestApi(
        `/api/v1/workflows/schedules/${deleteId}`,
        {
          method: "DELETE",
          auth: "user",
        },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      const body = await readJson<{ deleted: boolean }>(response);
      expect(body.deleted).toBe(true);
    },
  );
});

describe("/api/v1/workflows/schedules/trigger", () => {
  it("rejects trigger requests that omit the schedule webhook token", async () => {
    const response = await requestApi("/api/v1/workflows/schedules/trigger", {
      method: "POST",
      json: { scheduleId: "test-schedule" },
    });
    expectStatus(response, [401, 429]);

    if ((response.headers.get("content-type") ?? "").includes("application/json")) {
      if (response.status === 401) {
        errorResponseSchema.parse(await readJson(response));
      }
    }
  });

  it("rejects trigger requests with an invalid body before schedule lookup", async () => {
    const response = await requestApi("/api/v1/workflows/schedules/trigger", {
      method: "POST",
      headers: { "x-cloud-workflow-schedule-token": "test-token" },
      json: {},
    });
    expectStatus(response, [400, 429]);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");

    const body = await readJson<Record<string, unknown>>(response);
    if (response.status === 400) {
      const parsed = errorResponseSchema.parse(body);
      expect(parsed.error).toBeTruthy();
      return;
    }

    expect(body).toBeTruthy();
    expect(typeof body).toBe("object");
  });
});
