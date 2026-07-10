import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  processCloudAgentBoxWarmStep: vi.fn(),
  failExhaustedCloudAgentBoxWarmJob: vi.fn(),
}));

vi.mock("../../../workspaces/[workspaceId]/cloud-agents/[cloudAgentId]/box/warm-step-processor", () => ({
  processCloudAgentBoxWarmStep: mocks.processCloudAgentBoxWarmStep,
  failExhaustedCloudAgentBoxWarmJob: mocks.failExhaustedCloudAgentBoxWarmJob,
}));

import { POST } from "./route";

const SECRET = "internal-secret";

function post(body: unknown, token?: string) {
  return new Request("https://cloud-web.internal/api/v1/internal/cloud-agent-warm/step", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  }) as never;
}

describe("internal cloud-agent-warm/step endpoint", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.processCloudAgentBoxWarmStep.mockReset();
    mocks.failExhaustedCloudAgentBoxWarmJob.mockReset();
    process.env.BROKER_HMAC_SECRET = SECRET;
  });
  afterEach(() => {
    delete process.env.BROKER_HMAC_SECRET;
  });

  it("401 without a bearer token", async () => {
    const res = await POST(post({ jobId: "j", expectedStep: "ensure-sandbox" }));
    expect(res.status).toBe(401);
    expect(mocks.processCloudAgentBoxWarmStep).not.toHaveBeenCalled();
  });

  it("403 with a wrong token", async () => {
    const res = await POST(post({ jobId: "j", expectedStep: "ensure-sandbox" }, "wrong"));
    expect(res.status).toBe(403);
    expect(mocks.processCloudAgentBoxWarmStep).not.toHaveBeenCalled();
  });

  it("runs the step and returns the outcome on a valid token", async () => {
    mocks.processCloudAgentBoxWarmStep.mockResolvedValue({ outcome: "advanced", nextStep: "build-env" });
    const res = await POST(post({ jobId: "j", expectedStep: "ensure-sandbox" }, SECRET));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: "advanced", nextStep: "build-env" });
    expect(mocks.processCloudAgentBoxWarmStep).toHaveBeenCalledWith({ payload: { jobId: "j", expectedStep: "ensure-sandbox" } });
  });

  it("returns 503 (not 200) on a retry outcome so the CF Queue redelivers the step", async () => {
    mocks.processCloudAgentBoxWarmStep.mockResolvedValue({ outcome: "retry", error: "Error 524: A timeout occurred (proxy.app.daytona.io)" });
    const res = await POST(post({ jobId: "j", expectedStep: "ensure-broker" }, SECRET));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ outcome: "retry", error: "Error 524: A timeout occurred (proxy.app.daytona.io)" });
  });

  it("routes dlq:true to failExhausted", async () => {
    mocks.failExhaustedCloudAgentBoxWarmJob.mockResolvedValue(undefined);
    const res = await POST(post({ jobId: "j", expectedStep: "ensure-broker", dlq: true }, SECRET));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: "exhausted" });
    expect(mocks.failExhaustedCloudAgentBoxWarmJob).toHaveBeenCalledWith({ jobId: "j", expectedStep: "ensure-broker" });
    expect(mocks.processCloudAgentBoxWarmStep).not.toHaveBeenCalled();
  });

  it("400 on a malformed body", async () => {
    const res = await POST(post({ jobId: "j" }, SECRET));
    expect(res.status).toBe(400);
  });
});
