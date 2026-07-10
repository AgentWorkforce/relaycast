import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyRequest } from "@cloud/sts-broker/hmac-node.js";
import {
  REQUEST_SIGNATURE_HEADER,
  REQUEST_TIMESTAMP_HEADER,
} from "@cloud/sts-broker/hmac.js";

const mocks = vi.hoisted(() => ({
  getSqsClientForQueueUrl: vi.fn(),
  sqsSend: vi.fn(),
}));

vi.mock("sst", () => ({
  Resource: {
    WorkflowLaunchQueue: {
      url: "https://sqs.us-east-1.amazonaws.com/123/WorkflowLaunchQueue",
    },
  },
}));

vi.mock("@/lib/aws/sqs-client", () => ({
  getSqsClientForQueueUrl: mocks.getSqsClientForQueueUrl,
}));

const cfSymbol = Symbol.for("__cloudflare-context__");
const SECRET = "queue-bridge-worker-secret";

function setWorkerEnv(env: Record<string, unknown>): void {
  (globalThis as Record<symbol, unknown>)[cfSymbol] = { env };
}

function clearWorkerEnv(): void {
  delete (globalThis as Record<symbol, unknown>)[cfSymbol];
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getSqsClientForQueueUrl.mockReturnValue({ send: mocks.sqsSend });
  mocks.sqsSend.mockResolvedValue({});
  clearWorkerEnv();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearWorkerEnv();
});

describe("enqueueWorkflowLaunchJob", () => {
  it("uses direct SQS enqueue outside the Worker runtime", async () => {
    const { enqueueWorkflowLaunchJob } = await import("./durable-launch-queue");

    await enqueueWorkflowLaunchJob({ jobId: "launch-job-1", runId: "run-1" });

    expect(mocks.getSqsClientForQueueUrl).toHaveBeenCalledWith(
      "https://sqs.us-east-1.amazonaws.com/123/WorkflowLaunchQueue",
    );
    expect(mocks.sqsSend).toHaveBeenCalledOnce();
  });

  it("posts a signed workflow launch job to the queue bridge in the Worker runtime", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({ accepted: true }), { status: 202 });
    }));
    setWorkerEnv({
      QUEUE_BRIDGE_URL: "https://queue-bridge.example.test",
      QUEUE_BRIDGE_HMAC_SECRET: SECRET,
    });
    const { enqueueWorkflowLaunchJob } = await import("./durable-launch-queue");

    await enqueueWorkflowLaunchJob({ jobId: "launch-job-1", runId: "run-1" });

    expect(mocks.getSqsClientForQueueUrl).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(
      "https://queue-bridge.example.test/internal/queues/workflow-launch/send",
    );
    expect(requests[0].init?.method).toBe("POST");
    const body = String(requests[0].init?.body ?? "");
    expect(JSON.parse(body)).toEqual({
      job: { jobId: "launch-job-1", runId: "run-1" },
    });
    const headers = requests[0].init?.headers as Record<string, string>;
    expect(verifyRequest({
      method: "POST",
      path: "/internal/queues/workflow-launch/send",
      body,
      headers: {
        [REQUEST_SIGNATURE_HEADER]: headers[REQUEST_SIGNATURE_HEADER],
        [REQUEST_TIMESTAMP_HEADER]: headers[REQUEST_TIMESTAMP_HEADER],
      },
      secret: SECRET,
    })).toEqual({ ok: true });
  });
});
