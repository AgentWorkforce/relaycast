// @handler /api/v1/workflows/schedules
// @handler /api/v1/workflows/schedules/[scheduleId]
// @handler /api/v1/workflows/schedules/trigger
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class RelaycronClientError extends Error {
    code: string;
    status: number;
    constructor(code: string, message: string, status: number) {
      super(message);
      this.code = code;
      this.status = status;
    }
  }

  return {
    RelaycronClientError,
    resolveRequestAuth: vi.fn(),
    requireSessionAuth: vi.fn(),
    requireAuthScope: vi.fn(),
    createRelaycronApiKey: vi.fn(),
    createRelaycronSchedule: vi.fn(),
    listRelaycronSchedules: vi.fn(),
    deleteRelaycronSchedule: vi.fn(),
    updateRelaycronSchedule: vi.fn(),
    parseCreateWorkflowScheduleRequest: vi.fn(),
    encryptJsonAsync: vi.fn(),
    decryptJson: vi.fn(),
    extractWorkflowRequest: vi.fn(),
    generateScheduleWebhookSecret: vi.fn(),
    hashScheduleWebhookSecret: vi.fn(),
    verifyScheduleWebhookSecret: vi.fn(),
    getWorkflowScheduleCredentialEncryptionKey: vi.fn(),
    toPublicWorkflowSchedule: vi.fn((schedule) => schedule),
    workflowScheduleStore: {
      listByWorkspaceIds: vi.fn(),
      listByWorkspace: vi.fn(),
      create: vi.fn(),
      get: vi.fn(),
      getForWorkspace: vi.fn(),
      existingWorkflowRunIds: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      claimOnceTrigger: vi.fn(),
    },
    getConfiguredAppOrigin: vi.fn(),
    toAbsoluteAppUrl: vi.fn(),
    createApiTokenSession: vi.fn(),
    revokeApiTokenSessionById: vi.fn(),
    runWorkflow: vi.fn(),
  };
});

vi.mock("@/lib/auth/request-auth", () => ({
  resolveRequestAuth: mocks.resolveRequestAuth,
  requireSessionAuth: mocks.requireSessionAuth,
  requireAuthScope: mocks.requireAuthScope,
}));

vi.mock("@/lib/workflow-schedules/relaycron-client", () => ({
  RelaycronClientError: mocks.RelaycronClientError,
  createRelaycronApiKey: mocks.createRelaycronApiKey,
  createRelaycronSchedule: mocks.createRelaycronSchedule,
  listRelaycronSchedules: mocks.listRelaycronSchedules,
  deleteRelaycronSchedule: mocks.deleteRelaycronSchedule,
  updateRelaycronSchedule: mocks.updateRelaycronSchedule,
}));

vi.mock("@/lib/workflow-schedules/request", () => ({
  parseCreateWorkflowScheduleRequest: mocks.parseCreateWorkflowScheduleRequest,
  encryptJsonAsync: mocks.encryptJsonAsync,
  decryptJson: mocks.decryptJson,
  extractWorkflowRequest: mocks.extractWorkflowRequest,
  generateScheduleWebhookSecret: mocks.generateScheduleWebhookSecret,
  hashScheduleWebhookSecret: mocks.hashScheduleWebhookSecret,
  verifyScheduleWebhookSecret: mocks.verifyScheduleWebhookSecret,
}));

vi.mock("@/lib/workflow-schedules/config", () => ({
  getWorkflowScheduleCredentialEncryptionKey: mocks.getWorkflowScheduleCredentialEncryptionKey,
}));

vi.mock("@/lib/workflow-schedules/store", () => ({
  workflowScheduleStore: mocks.workflowScheduleStore,
  toPublicWorkflowSchedule: mocks.toPublicWorkflowSchedule,
}));

vi.mock("@/lib/app-origin", () => ({
  getConfiguredAppOrigin: mocks.getConfiguredAppOrigin,
}));

vi.mock("@/lib/app-path", () => ({
  toAbsoluteAppUrl: mocks.toAbsoluteAppUrl,
}));

vi.mock("@/lib/auth/api-token-store", () => ({
  createApiTokenSession: mocks.createApiTokenSession,
  revokeApiTokenSessionById: mocks.revokeApiTokenSessionById,
}));

vi.mock("../../app/api/v1/workflows/run/route", () => ({
  POST: mocks.runWorkflow,
}));

import {
  GET as getSchedules,
  POST as postSchedules,
} from "../../app/api/v1/workflows/schedules/route";
import {
  PATCH as patchSchedule,
  DELETE as deleteSchedule,
} from "../../app/api/v1/workflows/schedules/[scheduleId]/route";
import { POST as triggerSchedule } from "../../app/api/v1/workflows/schedules/trigger/route";

describe("workflow schedule handlers", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolveRequestAuth.mockResolvedValue({
      userId: "user_123",
      workspaceId: "rw_12345678",
      organizationId: "org_123",
      source: "session",
      context: {
        currentOrganization: { id: "org_123" },
        workspaces: [{ id: "rw_12345678", organization_id: "org_123" }],
      },
    });
    mocks.requireSessionAuth.mockReturnValue(true);
    mocks.requireAuthScope.mockReturnValue(true);
    mocks.parseCreateWorkflowScheduleRequest.mockReturnValue({
      name: "Nightly",
      description: "Nightly run",
      scheduleType: "recurring",
      cronExpression: "0 0 * * *",
      scheduledAt: null,
      scheduledAtDate: null,
      timezone: "UTC",
      workflowRequest: { workflow: "name: nightly" },
      scheduleMetadata: { owner: "test" },
    });
    mocks.generateScheduleWebhookSecret.mockReturnValue("webhook-secret");
    mocks.hashScheduleWebhookSecret.mockReturnValue("hashed-secret");
    mocks.getWorkflowScheduleCredentialEncryptionKey.mockReturnValue("encryption-key");
    mocks.encryptJsonAsync.mockImplementation((value) => `enc:${JSON.stringify(value)}`);
    mocks.decryptJson.mockImplementation((value) =>
      typeof value === "string" && value.startsWith("enc:")
        ? JSON.parse(value.slice(4))
        : value,
    );
    mocks.createRelaycronApiKey.mockResolvedValue("relaycron-api-key");
    mocks.createRelaycronSchedule.mockResolvedValue({ id: "relaycron_sched_123" });
    mocks.listRelaycronSchedules.mockResolvedValue([]);
    mocks.deleteRelaycronSchedule.mockResolvedValue(undefined);
    mocks.workflowScheduleStore.create.mockResolvedValue({
      id: "sched_123",
      status: "active",
      workspaceId: "rw_12345678",
    });
    mocks.getConfiguredAppOrigin.mockReturnValue("https://cloud.test");
    mocks.toAbsoluteAppUrl.mockImplementation((_origin, pathname) => new URL(pathname, "https://cloud.test"));
    mocks.workflowScheduleStore.get.mockResolvedValue({
      id: "sched_123",
      status: "active",
      userId: "user_123",
      workspaceId: "rw_12345678",
      organizationId: "org_123",
      relaycronScheduleId: "relaycron_sched_123",
      relaycronApiKeyEnvelope: "enc:\"relaycron-api-key\"",
      workflowRequestEnvelope: "enc:{\"workflow\":\"name: nightly\"}",
      webhookSecretHash: "hashed-secret",
    });
    mocks.workflowScheduleStore.getForWorkspace.mockImplementation(mocks.workflowScheduleStore.get);
    mocks.workflowScheduleStore.update.mockResolvedValue({
      id: "sched_123",
      status: "paused",
      workspaceId: "rw_12345678",
    });
    mocks.workflowScheduleStore.delete.mockResolvedValue(undefined);
    mocks.workflowScheduleStore.claimOnceTrigger.mockResolvedValue(true);
    mocks.workflowScheduleStore.existingWorkflowRunIds.mockResolvedValue(new Set(["run_123"]));
    mocks.extractWorkflowRequest.mockReturnValue({ workflow: "name: nightly" });
    mocks.verifyScheduleWebhookSecret.mockReturnValue(true);
    mocks.createApiTokenSession.mockResolvedValue({
      sessionId: "session_123",
      accessToken: "token_123",
    });
    mocks.runWorkflow.mockResolvedValue(
      Response.json({ runId: "run_123", status: "queued" }, { status: 200 }),
    );
    mocks.revokeApiTokenSessionById.mockResolvedValue(undefined);
  });

  it("creates a workflow schedule and persists the encrypted local record", async () => {
    const response = await postSchedules(
      new Request("http://localhost/api/v1/workflows/schedules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Nightly" }),
      }) as never,
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");
    expect(mocks.createRelaycronSchedule).toHaveBeenCalledOnce();
    const [relaycronApiKey, relaycronScheduleInput] = mocks.createRelaycronSchedule.mock.calls[0];
    expect(relaycronApiKey).toBe("relaycron-api-key");
    expect(relaycronScheduleInput.transport).toMatchObject({
      url: "https://cloud.test/api/v1/workflows/schedules/trigger?workflow_schedule_token=webhook-secret",
      headers: {
        "X-Cloud-Workflow-Schedule-Token": "webhook-secret",
      },
    });
    expect(mocks.workflowScheduleStore.create).toHaveBeenCalledWith(
      expect.objectContaining({
        relaycronScheduleId: "relaycron_sched_123",
        relaycronApiKeyEnvelope: expect.stringContaining("relaycron-api-key"),
        webhookSecretHash: "hashed-secret",
      }),
    );
  });

  it("returns a deterministic relaycron error and rolls back the remote schedule on create failure", async () => {
    mocks.workflowScheduleStore.create.mockRejectedValueOnce(
      new mocks.RelaycronClientError("bad_request", "relaycron down", 503),
    );
    const response = await postSchedules(
      new Request("http://localhost/api/v1/workflows/schedules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Nightly" }),
      }) as never,
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "relaycron_error",
      code: "bad_request",
      message: "relaycron down",
    });
    expect(mocks.deleteRelaycronSchedule).toHaveBeenCalledWith(
      "relaycron-api-key",
      "relaycron_sched_123",
    );
  });

  it("returns a structured timeout and rolls back RelayCron when local schedule creation stalls", async () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.workflowScheduleStore.create.mockReturnValueOnce(new Promise(() => undefined));

    const responsePromise = postSchedules(
      new Request("http://localhost/api/v1/workflows/schedules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Nightly" }),
      }) as never,
    );

    await vi.advanceTimersByTimeAsync(8_000);
    const response = await responsePromise;

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "workflow_schedules_timeout",
      stage: "createLocalSchedule",
    });
    expect(mocks.deleteRelaycronSchedule).toHaveBeenCalledWith(
      "relaycron-api-key",
      "relaycron_sched_123",
    );
    consoleError.mockRestore();
    vi.useRealTimers();
  });

  it("cleans up RelayCron rows by metadata when create times out before returning an id", async () => {
    vi.useFakeTimers();
    const randomUUID = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000123");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.createRelaycronSchedule.mockReturnValueOnce(new Promise(() => undefined));
    mocks.listRelaycronSchedules.mockResolvedValueOnce([
      {
        id: "relaycron_lost_response",
        metadata: {
          cloudScheduleId: "00000000-0000-4000-8000-000000000123",
        },
      },
      {
        id: "relaycron_unrelated",
        metadata: {
          cloudScheduleId: "other",
        },
      },
    ]);

    const responsePromise = postSchedules(
      new Request("http://localhost/api/v1/workflows/schedules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Nightly" }),
      }) as never,
    );

    await vi.advanceTimersByTimeAsync(8_000);
    const response = await responsePromise;

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "workflow_schedules_timeout",
      stage: "createRelaycronSchedule",
    });
    expect(mocks.listRelaycronSchedules).toHaveBeenCalledWith("relaycron-api-key");
    expect(mocks.deleteRelaycronSchedule).toHaveBeenCalledTimes(1);
    expect(mocks.deleteRelaycronSchedule).toHaveBeenCalledWith(
      "relaycron-api-key",
      "relaycron_lost_response",
    );
    consoleError.mockRestore();
    randomUUID.mockRestore();
    vi.useRealTimers();
  });

  it("patches a schedule and writes the local encrypted workflow request when provided", async () => {
    const response = await patchSchedule(
      new Request("http://localhost/api/v1/workflows/schedules/sched_123", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: "paused",
          workflowRequest: { workflow: "name: nightly" },
        }),
      }) as never,
      { params: Promise.resolve({ scheduleId: "sched_123" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");
    expect(mocks.updateRelaycronSchedule).toHaveBeenCalledWith(
      "relaycron-api-key",
      "relaycron_sched_123",
      { status: "paused" },
    );
    expect(mocks.workflowScheduleStore.update).toHaveBeenCalledWith(
      "sched_123",
      expect.objectContaining({
        status: "paused",
        workflowRequestEnvelope: expect.stringContaining("name: nightly"),
      }),
    );
  });

  it("deletes a schedule after removing the relaycron counterpart", async () => {
    const response = await deleteSchedule(
      new Request("http://localhost/api/v1/workflows/schedules/sched_123", {
        method: "DELETE",
      }) as never,
      { params: Promise.resolve({ scheduleId: "sched_123" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");
    await expect(response.json()).resolves.toEqual({ deleted: true });
    expect(mocks.deleteRelaycronSchedule).toHaveBeenCalledWith(
      "relaycron-api-key",
      "relaycron_sched_123",
    );
    expect(mocks.workflowScheduleStore.delete).toHaveBeenCalledWith("sched_123");
  });

  it("returns 409 when a once schedule has already been claimed", async () => {
    mocks.workflowScheduleStore.get.mockResolvedValueOnce({
      id: "sched_123",
      status: "active",
      scheduleType: "once",
      userId: "user_123",
      workspaceId: "rw_12345678",
      organizationId: "org_123",
      workflowRequestEnvelope: "enc:{\"workflow\":\"name: nightly\"}",
      webhookSecretHash: "hashed-secret",
    });
    mocks.workflowScheduleStore.claimOnceTrigger.mockResolvedValueOnce(false);
    const response = await triggerSchedule(
      new Request("http://localhost/api/v1/workflows/schedules/trigger", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-cloud-workflow-schedule-token": "webhook-secret",
        },
        body: JSON.stringify({ scheduleId: "sched_123" }),
      }) as never,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Schedule was already triggered",
    });
  });

  it("launches the workflow, returns the downstream response, and always revokes the minted token", async () => {
    const response = await triggerSchedule(
      new Request("http://localhost/api/v1/workflows/schedules/trigger", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-cloud-workflow-schedule-token": "webhook-secret",
        },
        body: JSON.stringify({ scheduleId: "sched_123" }),
      }) as never,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");
    await expect(response.json()).resolves.toEqual({
      scheduleId: "sched_123",
      ok: true,
      run: { runId: "run_123", status: "queued" },
    });
    expect(mocks.runWorkflow).toHaveBeenCalledOnce();
    expect(mocks.workflowScheduleStore.update).toHaveBeenCalledWith(
      "sched_123",
      expect.objectContaining({
        lastTriggeredRunId: "run_123",
        lastTriggerStatus: "succeeded",
        lastTriggerError: null,
      }),
    );
    expect(mocks.revokeApiTokenSessionById).toHaveBeenCalledWith(
      "session_123",
      "workflow_schedule_triggered",
    );
  });

  it("accepts the registered schedule token from the callback URL when delivery headers are missing", async () => {
    const response = await triggerSchedule(
      new Request(
        "http://localhost/api/v1/workflows/schedules/trigger?workflow_schedule_token=webhook-secret",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ scheduleId: "sched_123" }),
        },
      ) as never,
    );

    expect(response.status).toBe(200);
    expect(mocks.verifyScheduleWebhookSecret).toHaveBeenCalledWith(
      "webhook-secret",
      "hashed-secret",
    );
    expect(mocks.runWorkflow).toHaveBeenCalledOnce();
  });

  it("claims a once schedule without exposing a run link until launch succeeds", async () => {
    mocks.workflowScheduleStore.get.mockResolvedValueOnce({
      id: "sched_123",
      status: "active",
      scheduleType: "once",
      userId: "user_123",
      workspaceId: "rw_12345678",
      organizationId: "org_123",
      workflowRequestEnvelope: "enc:{\"workflow\":\"name: nightly\",\"fileType\":\"yaml\"}",
      webhookSecretHash: "hashed-secret",
    });

    const response = await triggerSchedule(
      new Request("http://localhost/api/v1/workflows/schedules/trigger", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-cloud-workflow-schedule-token": "webhook-secret",
        },
        body: JSON.stringify({ scheduleId: "sched_123" }),
      }) as never,
    );

    expect(response.status).toBe(200);
    expect(mocks.workflowScheduleStore.claimOnceTrigger).toHaveBeenCalledWith(
      "sched_123",
      expect.any(Date),
    );
    expect(mocks.workflowScheduleStore.claimOnceTrigger).not.toHaveBeenCalledWith(
      "sched_123",
      expect.any(String),
      expect.any(Date),
    );
    expect(mocks.workflowScheduleStore.update).toHaveBeenCalledWith(
      "sched_123",
      expect.objectContaining({
        lastTriggeredRunId: "run_123",
        lastTriggerStatus: "succeeded",
        lastTriggerError: null,
      }),
    );
  });

  it("records launch failures so completed one-shot schedules do not point at missing runs", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.workflowScheduleStore.get.mockResolvedValueOnce({
      id: "sched_123",
      status: "active",
      scheduleType: "once",
      userId: "user_123",
      workspaceId: "rw_12345678",
      organizationId: "org_123",
      workflowRequestEnvelope: "enc:{\"workflow\":\"name: nightly\",\"fileType\":\"yaml\"}",
      webhookSecretHash: "hashed-secret",
    });
    mocks.runWorkflow.mockResolvedValueOnce(
      Response.json({ error: "No CLI credentials connected" }, { status: 400 }),
    );

    const response = await triggerSchedule(
      new Request("http://localhost/api/v1/workflows/schedules/trigger", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-cloud-workflow-schedule-token": "webhook-secret",
        },
        body: JSON.stringify({ scheduleId: "sched_123" }),
      }) as never,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      scheduleId: "sched_123",
      ok: false,
      run: { error: "No CLI credentials connected" },
    });
    expect(mocks.workflowScheduleStore.update).toHaveBeenCalledWith(
      "sched_123",
      expect.objectContaining({
        lastTriggeredRunId: null,
        lastTriggerStatus: "failed",
        lastTriggerError: "No CLI credentials connected",
      }),
    );
    consoleError.mockRestore();
  });

  it("returns a structured timeout when schedule listing stalls", async () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.workflowScheduleStore.listByWorkspaceIds.mockReturnValueOnce(new Promise(() => undefined));

    const responsePromise = getSchedules(
      new Request("http://localhost/api/v1/workflows/schedules") as never,
    );

    await vi.advanceTimersByTimeAsync(8_000);
    const response = await responsePromise;

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "workflow_schedules_timeout",
      stage: "listByWorkspaceIds",
    });
    consoleError.mockRestore();
    vi.useRealTimers();
  });

  it("suppresses stale last-run links when a schedule points at a missing run", async () => {
    mocks.workflowScheduleStore.listByWorkspaceIds.mockResolvedValueOnce([
      {
        id: "sched_123",
        status: "completed",
        workspaceId: "rw_12345678",
        lastTriggeredRunId: "run_missing",
        lastTriggeredAt: new Date("2026-05-21T09:22:18.455Z"),
        lastTriggerStatus: null,
        lastTriggerError: null,
      },
    ]);
    mocks.workflowScheduleStore.existingWorkflowRunIds.mockResolvedValueOnce(new Set());

    const response = await getSchedules(
      new Request("http://localhost/api/v1/workflows/schedules") as never,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      schedules: [
        expect.objectContaining({
          id: "sched_123",
          lastTriggeredRunId: null,
          lastTriggerStatus: "failed",
          lastTriggerError: "Workflow launch did not create a run record.",
        }),
      ],
    });
  });
});
