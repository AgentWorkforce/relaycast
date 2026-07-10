// @route POST /api/v1/ricky/runs
// @route GET /api/v1/ricky/runs/[rickyRunId]
// @route POST /api/v1/ricky/runs/[rickyRunId]/cancel
// @route POST /api/v1/ricky/runs/[rickyRunId]/gates/[gateId]/resolve
// @route GET /api/v1/ricky/slack/oauth/start
// @route GET /api/v1/ricky/slack/oauth/callback
import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  envJson,
  expectErrorLike,
  expectStatus,
  hasBearerAuth,
  hasSessionAuth,
  readJson,
  requestApi,
} from "../helpers/runtime";

const errorResponseSchema = z.object({
  error: z.string().min(1),
}).passthrough();

const createResponseSchema = z.object({
  rickyRunId: z.string().min(1),
  rootRunId: z.string().min(1),
  status: z.string().min(1),
  monitorUrl: z.string().min(1),
  attempts: z.array(
    z.object({
      attempt: z.number(),
      workflowRunId: z.string().min(1),
      role: z.string().min(1),
      status: z.string().min(1),
    }),
  ),
});

const detailSchema = z.object({
  id: z.string().min(1),
  rootWorkflowRunId: z.string().min(1),
  activeWorkflowRunId: z.string().nullable().optional(),
  status: z.string().min(1),
  attempts: z.array(z.object({ workflowRunId: z.string().min(1) }).passthrough()),
  gates: z.array(z.object({ id: z.string().min(1), status: z.string().min(1) }).passthrough()),
  events: z.array(z.object({ sequence: z.number() }).passthrough()),
}).passthrough();

describe("/api/v1/ricky/runs", () => {
  it("rejects unauthenticated create requests", async () => {
    const response = await requestApi("/api/v1/ricky/runs", {
      method: "POST",
      json: {},
    });
    expectStatus(response, [401, 429]);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");

    const body = await readJson<Record<string, unknown>>(response);
    if (response.status === 401) {
      errorResponseSchema.parse(body);
      return;
    }

    expect(body).toBeTruthy();
    expect(typeof body).toBe("object");
  });

  const createBody = envJson<unknown>("ACCEPTANCE_RICKY_CREATE_BODY");
  (createBody && hasBearerAuth() ? it : it.skip)(
    "creates a ricky run from the supplied fixture body",
    async () => {
      const response = await requestApi("/api/v1/ricky/runs", {
        method: "POST",
        auth: "user",
        json: createBody,
      });

      expect(response.status).toBe(201);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");

      const parsed = createResponseSchema.parse(await readJson(response));
      expect(parsed.attempts.length).toBeGreaterThan(0);
    },
  );

  const detailRunId = process.env.ACCEPTANCE_RICKY_RUN_ID?.trim();
  (detailRunId && hasBearerAuth() ? it : it.skip)(
    "reads the configured ricky run detail payload",
    async () => {
      const response = await requestApi(`/api/v1/ricky/runs/${detailRunId}`, {
        auth: "user",
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      const parsed = detailSchema.parse(await readJson(response));
      expect(parsed.id).toBe(detailRunId);
    },
  );

  const cancelRunId = process.env.ACCEPTANCE_RICKY_CANCEL_RUN_ID?.trim();
  (cancelRunId && hasSessionAuth() ? it : it.skip)(
    "cancels the configured ricky run",
    async () => {
      const response = await requestApi(
        `/api/v1/ricky/runs/${cancelRunId}/cancel`,
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

  const gateRunId = process.env.ACCEPTANCE_RICKY_GATE_RUN_ID?.trim();
  const gateId = process.env.ACCEPTANCE_RICKY_GATE_ID?.trim();
  const gateBody =
    envJson<unknown>("ACCEPTANCE_RICKY_GATE_RESOLUTION_BODY") ??
    { decision: "approve" };
  (gateRunId && gateId && hasSessionAuth() ? it : it.skip)(
    "resolves the configured human gate",
    async () => {
      const response = await requestApi(
        `/api/v1/ricky/runs/${gateRunId}/gates/${gateId}/resolve`,
        {
          method: "POST",
          auth: "user",
          json: gateBody,
        },
      );

      expectStatus(response, [200, 404]);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      if (response.status !== 200) {
        errorResponseSchema.parse(await readJson(response));
      }
    },
  );
});

describe("/api/v1/ricky/slack/oauth", () => {
  it("redirects unauthenticated OAuth starts to the Google sign-in bootstrap", async () => {
    const response = await requestApi(
      "/api/v1/ricky/slack/oauth/start?slack_team_id=T123&slack_user_id=U123",
      { redirect: "manual" },
    );

    expectStatus(response, [302, 307, 429]);
    if (response.status === 429) {
      if ((response.headers.get("content-type") ?? "").includes("application/json")) {
        expectErrorLike(await readJson<Record<string, unknown>>(response));
      } else {
        expect(await response.text()).toBeTruthy();
      }
      return;
    }

    const location = response.headers.get("location");
    expect(location).toContain("/api/auth/google/start");
    expect(location).toContain("returnTo=");
  });

  it("rejects unauthenticated OAuth callbacks", async () => {
    const response = await requestApi("/api/v1/ricky/slack/oauth/callback");
    expectStatus(response, [401, 429]);

    if ((response.headers.get("content-type") ?? "").includes("application/json")) {
      if (response.status === 401) {
        errorResponseSchema.parse(await readJson(response));
      }
    }
  });
});
