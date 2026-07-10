import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  defaultCloudAgentBoxDeps: vi.fn(),
  readCloudAgentBox: vi.fn(),
  readCloudAgentBoxViaQueue: vi.fn(),
  requireWorkspaceSandboxAuth: vi.fn(),
}));

vi.mock("../../../../sandboxes/sandbox-utils", async (orig) => {
  const actual = await orig<typeof import("../../../../sandboxes/sandbox-utils")>();
  return { ...actual, requireWorkspaceSandboxAuth: mocks.requireWorkspaceSandboxAuth };
});

vi.mock("../box-manager", () => {
  class CloudAgentBoxError extends Error {
    code: string;
    status: number;

    constructor(message: string, code: string, status: number) {
      super(message);
      this.code = code;
      this.status = status;
    }
  }

  return {
    CloudAgentBoxError,
    defaultCloudAgentBoxDeps: mocks.defaultCloudAgentBoxDeps,
    readCloudAgentBox: mocks.readCloudAgentBox,
  };
});

vi.mock("../warm-route", () => ({
  isCloudAgentWarmViaQueueEnabled: vi.fn(() => false),
  readCloudAgentBoxViaQueue: mocks.readCloudAgentBoxViaQueue,
}));

import {
  createCloudAgentBoxEventsRouteHandlers,
  createCloudAgentBoxStatusStream,
  type CloudAgentBoxStatusEvent,
} from "./route";

const auth = {
  userId: "00000000-0000-0000-0000-000000000001",
  workspaceId: "00000000-0000-0000-0000-000000000002",
  organizationId: "00000000-0000-0000-0000-000000000003",
  source: "token",
  scopes: ["cli:auth"],
};

const cloudAgentId = "00000000-0000-0000-0000-000000000004";
const deps = { name: "test-deps" };

function request(): NextRequest {
  return new NextRequest(
    `https://cloud.test/api/v1/workspaces/${auth.workspaceId}/cloud-agents/${cloudAgentId}/box/events`,
    {
      method: "GET",
      headers: { authorization: "Bearer cld_at_cloud-token" },
    },
  );
}

function context() {
  return {
    params: Promise.resolve({
      workspaceId: auth.workspaceId,
      cloudAgentId,
    }),
  };
}

async function readStreamText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    text += decoder.decode(next.value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

function parseSseEvents(text: string): Array<{ event: string; data: CloudAgentBoxStatusEvent }> {
  return text
    .trim()
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => {
      const lines = frame.split("\n");
      const event = lines.find((line) => line.startsWith("event: "))?.slice("event: ".length) ?? "";
      const data = lines.find((line) => line.startsWith("data: "))?.slice("data: ".length) ?? "{}";
      return { event, data: JSON.parse(data) as CloudAgentBoxStatusEvent };
    });
}

function parseRawSseEvents(text: string): Array<{ event: string; data: Record<string, unknown> }> {
  return text
    .trim()
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => {
      const lines = frame.split("\n");
      const event = lines.find((line) => line.startsWith("event: "))?.slice("event: ".length) ?? "";
      const data = lines.find((line) => line.startsWith("data: "))?.slice("data: ".length) ?? "{}";
      return { event, data: JSON.parse(data) as Record<string, unknown> };
    });
}

describe("cloud agent box events route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkspaceSandboxAuth.mockResolvedValue({
      ok: true,
      auth,
      workspaceId: auth.workspaceId,
      sandboxId: undefined,
    });
    mocks.readCloudAgentBox.mockResolvedValue({
      sandboxId: "sbx_1",
      status: "ready",
      relayfileToken: "relay-token",
      relayfileMountPath: "/workspace",
      phase: "ready",
      etaMs: 0,
    });
  });

  it("authenticates and returns an SSE response", async () => {
    const { GET } = createCloudAgentBoxEventsRouteHandlers(deps as never);

    const response = await GET(request(), context());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    const events = parseSseEvents(await readStreamText(response.body!));
    expect(events).toEqual([
      {
        event: "status",
        data: {
          sandboxId: "sbx_1",
          status: "ready",
          phase: "ready",
          etaMs: 0,
          emittedAt: expect.any(String),
        },
      },
    ]);
    expect(mocks.readCloudAgentBox).toHaveBeenCalledWith(deps, {
      auth,
      urlWorkspaceId: auth.workspaceId,
      cloudAgentId,
      workspaceToken: null,
    });
  });

  it("rejects unauthenticated SSE requests", async () => {
    vi.resetModules();
    mocks.requireWorkspaceSandboxAuth.mockResolvedValueOnce({
      ok: false,
      response: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    });
    const { createCloudAgentBoxEventsRouteHandlers: createHandlers } = await import("./route");
    const { GET } = createHandlers(deps as never);

    const response = await GET(request(), context());

    expect(response.status).toBe(401);
    expect(mocks.readCloudAgentBox).not.toHaveBeenCalled();
  });

  it("uses the queue-backed read path when requested", async () => {
    mocks.readCloudAgentBoxViaQueue.mockResolvedValueOnce({
      sandboxId: "job_1",
      status: "warming",
      relayfileToken: "relay-token",
      relayfileMountPath: "/workspace",
      currentStep: "flush-relayfile",
      phase: "cloning",
      etaMs: 120_000,
    });

    const stream = createCloudAgentBoxStatusStream({
      deps: deps as never,
      request: { auth, cloudAgentId, workspaceToken: null },
      queueEnabled: true,
      options: { now: () => new Date("2026-06-03T12:00:00.000Z") },
    });
    const reader = stream.getReader();
    const chunk = await reader.read();
    await reader.cancel();

    expect(new TextDecoder().decode(chunk.value)).toContain("event: status");
    const events = parseSseEvents(new TextDecoder().decode(chunk.value));
    expect(events[0].data).toMatchObject({
      sandboxId: "job_1",
      status: "warming",
      currentStep: "flush-relayfile",
      phase: "cloning",
      etaMs: 120_000,
      emittedAt: "2026-06-03T12:00:00.000Z",
    });
    expect(mocks.readCloudAgentBoxViaQueue).toHaveBeenCalled();
    expect(mocks.readCloudAgentBox).not.toHaveBeenCalled();
  });

  it("dedupes unchanged poll payloads and closes after a terminal event", async () => {
    const statuses: CloudAgentBoxStatusEvent[] = [
      {
        sandboxId: "sbx_1",
        status: "warming",
        phase: "starting",
        etaMs: 10_000,
        emittedAt: "2026-06-03T12:00:00.000Z",
      },
      {
        sandboxId: "sbx_1",
        status: "warming",
        phase: "starting",
        etaMs: 10_000,
        emittedAt: "2026-06-03T12:00:01.000Z",
      },
      {
        sandboxId: "sbx_1",
        status: "ready",
        phase: "ready",
        etaMs: 0,
        emittedAt: "2026-06-03T12:00:02.000Z",
      },
    ];
    let pollCount = 0;

    const stream = createCloudAgentBoxStatusStream({
      deps: deps as never,
      request: { auth, cloudAgentId, workspaceToken: null },
      queueEnabled: false,
      options: {
        pollIntervalMs: 1,
        readStatusEvent: vi.fn(async () => statuses[Math.min(pollCount++, statuses.length - 1)]),
      },
    });

    const events = parseSseEvents(await readStreamText(stream));

    expect(events.map((event) => event.data.status)).toEqual(["warming", "ready"]);
    expect(events[0].data.emittedAt).toBe("2026-06-03T12:00:00.000Z");
    expect(events[1].data.emittedAt).toBe("2026-06-03T12:00:02.000Z");
  });

  it("continues through stopping until stopped", async () => {
    const statuses: CloudAgentBoxStatusEvent[] = [
      {
        sandboxId: "sbx_1",
        status: "warming",
        phase: "starting",
        etaMs: 10_000,
        emittedAt: "2026-06-03T12:00:00.000Z",
      },
      {
        sandboxId: "sbx_1",
        status: "stopping",
        emittedAt: "2026-06-03T12:00:01.000Z",
      },
      {
        sandboxId: "sbx_1",
        status: "stopped",
        emittedAt: "2026-06-03T12:00:02.000Z",
      },
    ];
    let pollCount = 0;

    const stream = createCloudAgentBoxStatusStream({
      deps: deps as never,
      request: { auth, cloudAgentId, workspaceToken: null },
      queueEnabled: false,
      options: {
        pollIntervalMs: 1,
        readStatusEvent: vi.fn(async () => statuses[Math.min(pollCount++, statuses.length - 1)]),
      },
    });

    const events = parseSseEvents(await readStreamText(stream));

    expect(events.map((event) => event.data.status)).toEqual(["warming", "stopping", "stopped"]);
  });

  it("emits stream errors without reporting the box as failed", async () => {
    const stream = createCloudAgentBoxStatusStream({
      deps: deps as never,
      request: { auth, cloudAgentId, workspaceToken: null },
      queueEnabled: false,
      options: {
        now: () => new Date("2026-06-03T12:00:00.000Z"),
        readStatusEvent: vi.fn(async () => {
          throw new Error("broker unavailable");
        }),
      },
    });

    const events = parseRawSseEvents(await readStreamText(stream));

    expect(events).toEqual([
      {
        event: "error",
        data: {
          error: "broker unavailable",
          emittedAt: "2026-06-03T12:00:00.000Z",
        },
      },
    ]);
  });

  it("stops polling when the stream is canceled", async () => {
    const readStatusEvent = vi.fn(async () => ({
      sandboxId: "sbx_1",
      status: "warming" as const,
      phase: "starting" as const,
      etaMs: 10_000,
      emittedAt: "2026-06-03T12:00:00.000Z",
    }));
    const stream = createCloudAgentBoxStatusStream({
      deps: deps as never,
      request: { auth, cloudAgentId, workspaceToken: null },
      queueEnabled: false,
      options: {
        pollIntervalMs: 1,
        readStatusEvent,
      },
    });
    const reader = stream.getReader();

    await reader.read();
    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(readStatusEvent).toHaveBeenCalledTimes(1);
  });
});
