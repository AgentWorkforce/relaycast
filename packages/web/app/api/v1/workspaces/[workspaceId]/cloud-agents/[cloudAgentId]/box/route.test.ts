import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  defaultCloudAgentBoxDeps: vi.fn(),
  readCloudAgentBox: vi.fn(),
  readCloudAgentBoxViaQueue: vi.fn(),
  requireWorkspaceSandboxAuth: vi.fn(),
  isCloudAgentWarmViaQueueEnabled: vi.fn(),
  startCloudAgentBoxWarm: vi.fn(),
  startCloudAgentBoxWarmViaQueue: vi.fn(),
  stopCloudAgentBox: vi.fn(),
  updateCloudAgentBoxMountPaths: vi.fn(),
  warmCloudAgentBox: vi.fn(),
}));

vi.mock("../../../sandboxes/sandbox-utils", async (orig) => {
  const actual = await orig<typeof import("../../../sandboxes/sandbox-utils")>();
  return { ...actual, requireWorkspaceSandboxAuth: mocks.requireWorkspaceSandboxAuth };
});

vi.mock("./box-manager", () => {
  class CloudAgentBoxError extends Error {
    code: string;
    status: number;

    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }

  return {
    CloudAgentBoxError,
    defaultCloudAgentBoxDeps: mocks.defaultCloudAgentBoxDeps,
    readCloudAgentBox: mocks.readCloudAgentBox,
    startCloudAgentBoxWarm: mocks.startCloudAgentBoxWarm,
    stopCloudAgentBox: mocks.stopCloudAgentBox,
    updateCloudAgentBoxMountPaths: mocks.updateCloudAgentBoxMountPaths,
    warmCloudAgentBox: mocks.warmCloudAgentBox,
  };
});

vi.mock("./warm-route", () => ({
  isCloudAgentWarmViaQueueEnabled: mocks.isCloudAgentWarmViaQueueEnabled,
  readCloudAgentBoxViaQueue: mocks.readCloudAgentBoxViaQueue,
  startCloudAgentBoxWarmViaQueue: mocks.startCloudAgentBoxWarmViaQueue,
}));

import { createCloudAgentBoxRouteHandlers } from "./route";

const auth = {
  userId: "00000000-0000-0000-0000-000000000001",
  workspaceId: "00000000-0000-0000-0000-000000000002",
  organizationId: "00000000-0000-0000-0000-000000000003",
  source: "token",
  scopes: ["cli:auth"],
};

const deps = { name: "test-deps" };

function request(body?: unknown, authorization = "Bearer cld_at_cloud-token"): NextRequest {
  return new NextRequest(
    "https://cloud.test/api/v1/workspaces/00000000-0000-0000-0000-000000000002/cloud-agents/00000000-0000-0000-0000-000000000004/box",
    {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        authorization,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
    },
  );
}

function context() {
  return {
    params: Promise.resolve({
      workspaceId: "00000000-0000-0000-0000-000000000002",
      cloudAgentId: "00000000-0000-0000-0000-000000000004",
    }),
  };
}

describe("cloud agent box route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireWorkspaceSandboxAuth.mockResolvedValue({
      ok: true,
      auth,
      workspaceId: "00000000-0000-0000-0000-000000000002",
      sandboxId: undefined,
    });
    mocks.warmCloudAgentBox.mockResolvedValue({
      sandboxId: "sbx_1",
      execUrl: "https://sbx-1.daytona.test",
      status: "ready",
      relayfileToken: "relay-token",
      relayfileMountPath: "/workspace",
      apiKey: "api_sbx_1",
    });
    mocks.startCloudAgentBoxWarm.mockResolvedValue({
      response: {
        sandboxId: "boxwarm_1",
        status: "warming",
        relayfileToken: "relay-token",
        relayfileMountPath: "/workspace",
      },
      status: 202,
    });
    mocks.startCloudAgentBoxWarmViaQueue.mockResolvedValue({
      response: {
        sandboxId: "boxwarm_queue_1",
        status: "warming",
        relayfileToken: "relay-token",
        relayfileMountPath: "/workspace",
        phase: "queued",
        etaMs: 300_000,
      },
      status: 202,
    });
    mocks.isCloudAgentWarmViaQueueEnabled.mockReturnValue(false);
  });

  it("passes optional POST relayfile mount paths through to the box manager", async () => {
    const { POST } = createCloudAgentBoxRouteHandlers(deps as never);

    const response = await POST(
      request({ relayfileMountPaths: ["/workspace", "/docs"] }),
      context(),
    );

    expect(response.status).toBe(201);
    expect(mocks.warmCloudAgentBox).toHaveBeenCalledWith(
      deps,
      expect.objectContaining({
        auth,
        cloudAgentId: "00000000-0000-0000-0000-000000000004",
        mountPaths: ["/workspace", "/docs"],
        urlWorkspaceId: "00000000-0000-0000-0000-000000000002",
        workspaceToken: null,
      }),
    );
  });

  it("passes optional POST git workspace source through to the box manager", async () => {
    const { POST } = createCloudAgentBoxRouteHandlers(deps as never);

    const response = await POST(
      request({
        relayfileMountPaths: ["/integrations/github"],
        workspaceSource: {
          kind: "git",
          remoteUrl: "https://github.com/acme/large-repo.git",
          ref: "main",
          commit: "abc123",
          shallow: true,
          targetDir: "/workspace",
          largeReason: "6000 tracked files",
        },
      }),
      context(),
    );

    expect(response.status).toBe(201);
    expect(mocks.warmCloudAgentBox).toHaveBeenCalledWith(
      deps,
      expect.objectContaining({
        mountPaths: ["/integrations/github"],
        workspaceSource: {
          kind: "git",
          remoteUrl: "https://github.com/acme/large-repo.git",
          ref: "main",
          commit: "abc123",
          shallow: true,
          targetDir: "/workspace",
          largeReason: "6000 tracked files",
        },
      }),
    );
  });

  it("passes optional POST git-overlay workspace source through to the box manager", async () => {
    const { POST } = createCloudAgentBoxRouteHandlers(deps as never);

    const response = await POST(
      request({
        relayfileMountPaths: ["/workspace", "/integrations/github"],
        workspaceSource: {
          kind: "git-overlay",
          remoteUrl: "https://github.com/acme/fast-repo.git",
          ref: "main",
          commit: "abc123",
          shallow: true,
          targetDir: "/workspace",
        },
      }),
      context(),
    );

    expect(response.status).toBe(201);
    expect(mocks.warmCloudAgentBox).toHaveBeenCalledWith(
      deps,
      expect.objectContaining({
        mountPaths: ["/workspace", "/integrations/github"],
        workspaceSource: {
          kind: "git-overlay",
          remoteUrl: "https://github.com/acme/fast-repo.git",
          ref: "main",
          commit: "abc123",
          shallow: true,
          targetDir: "/workspace",
        },
      }),
    );
  });

  it("strips embedded credentials from POST git workspace remotes", async () => {
    const { POST } = createCloudAgentBoxRouteHandlers(deps as never);

    const response = await POST(
      request({
        relayfileMountPaths: ["/integrations/github"],
        workspaceSource: {
          kind: "git",
          remoteUrl: "https://user:secret@github.com/acme/large-repo.git?x=1#frag",
          targetDir: "/workspace",
        },
      }),
      context(),
    );

    expect(response.status).toBe(201);
    expect(mocks.warmCloudAgentBox).toHaveBeenCalledWith(
      deps,
      expect.objectContaining({
        workspaceSource: {
          kind: "git",
          remoteUrl: "https://github.com/acme/large-repo.git",
          targetDir: "/workspace",
        },
      }),
    );
  });

  it("rejects git workspace target directories outside /workspace", async () => {
    const { POST } = createCloudAgentBoxRouteHandlers(deps as never);

    const response = await POST(
      request({
        relayfileMountPaths: ["/integrations/github"],
        workspaceSource: {
          kind: "git",
          remoteUrl: "https://github.com/acme/large-repo.git",
          targetDir: "/home/daytona",
        },
      }),
      context(),
    );

    expect(response.status).toBe(400);
    expect(mocks.warmCloudAgentBox).not.toHaveBeenCalled();
  });

  it("accepts Pear's cloud bearer shape without a relay workspace token", async () => {
    const { POST } = createCloudAgentBoxRouteHandlers(deps as never);

    const response = await POST(request(undefined, "Bearer cld_at_cloud-token"), context());

    expect(response.status).toBe(201);
    expect(mocks.warmCloudAgentBox).toHaveBeenCalledWith(
      deps,
      expect.objectContaining({
        auth,
        cloudAgentId: "00000000-0000-0000-0000-000000000004",
        workspaceToken: null,
      }),
    );
  });

  it("keeps POST body optional", async () => {
    const { POST } = createCloudAgentBoxRouteHandlers(deps as never);

    const response = await POST(request(), context());

    expect(response.status).toBe(201);
    expect(mocks.warmCloudAgentBox.mock.calls[0]?.[1]).toHaveProperty(
      "mountPaths",
      undefined,
    );
  });

  it("starts async warm when requested by query param", async () => {
    const { POST } = createCloudAgentBoxRouteHandlers(deps as never);
    const asyncRequest = new NextRequest(
      "https://cloud.test/api/v1/workspaces/00000000-0000-0000-0000-000000000002/cloud-agents/00000000-0000-0000-0000-000000000004/box?async=true",
      {
        method: "POST",
        headers: { authorization: "Bearer cld_at_cloud-token" },
      },
    );

    const response = await POST(asyncRequest, context());

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      sandboxId: "boxwarm_1",
      status: "warming",
    });
    expect(mocks.startCloudAgentBoxWarm).toHaveBeenCalledWith(
      deps,
      expect.objectContaining({
        auth,
        cloudAgentId: "00000000-0000-0000-0000-000000000004",
      }),
    );
    expect(mocks.warmCloudAgentBox).not.toHaveBeenCalled();
    expect(mocks.startCloudAgentBoxWarmViaQueue).not.toHaveBeenCalled();
  });

  it("defaults POST to queue-backed async warm when the deployed queue flag is enabled", async () => {
    mocks.isCloudAgentWarmViaQueueEnabled.mockReturnValue(true);
    const { POST } = createCloudAgentBoxRouteHandlers(deps as never);

    const response = await POST(
      request({
        relayfileMountPaths: ["/workspace", "/integrations/github"],
        workspaceSource: { kind: "relayfile" },
      }),
      context(),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      sandboxId: "boxwarm_queue_1",
      status: "warming",
      phase: "queued",
      etaMs: 300_000,
    });
    expect(mocks.startCloudAgentBoxWarmViaQueue).toHaveBeenCalledWith(
      deps,
      expect.objectContaining({
        auth,
        cloudAgentId: "00000000-0000-0000-0000-000000000004",
        mountPaths: ["/workspace", "/integrations/github"],
        workspaceSource: { kind: "relayfile" },
      }),
    );
    expect(mocks.startCloudAgentBoxWarm).not.toHaveBeenCalled();
    expect(mocks.warmCloudAgentBox).not.toHaveBeenCalled();
  });

  it("rejects invalid POST mount path payloads", async () => {
    const { POST } = createCloudAgentBoxRouteHandlers(deps as never);

    const response = await POST(request({ relayfileMountPaths: ["/workspace", 42] }), context());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid request body",
      code: "invalid_request",
    });
    expect(mocks.warmCloudAgentBox).not.toHaveBeenCalled();
  });

  it("passes POST broker identity through to the box manager verbatim (#125)", async () => {
    const { POST } = createCloudAgentBoxRouteHandlers(deps as never);

    const response = await POST(
      request({
        relayfileMountPaths: ["/workspace"],
        workspaceKey: "wsk_explicit-workspace",
        brokerName: "cloud-00000000",
      }),
      context(),
    );

    expect(response.status).toBe(201);
    expect(mocks.warmCloudAgentBox).toHaveBeenCalledWith(
      deps,
      expect.objectContaining({
        mountPaths: ["/workspace"],
        workspaceKey: "wsk_explicit-workspace",
        brokerName: "cloud-00000000",
      }),
    );
  });

  it("leaves broker identity undefined when the POST body omits it (#125)", async () => {
    const { POST } = createCloudAgentBoxRouteHandlers(deps as never);

    const response = await POST(request({ relayfileMountPaths: ["/workspace"] }), context());

    expect(response.status).toBe(201);
    const input = mocks.warmCloudAgentBox.mock.calls[0]?.[1];
    expect(input).not.toHaveProperty("workspaceKey");
    expect(input).not.toHaveProperty("brokerName");
  });

  it("rejects blank or non-string POST broker identity fields (#125)", async () => {
    const { POST } = createCloudAgentBoxRouteHandlers(deps as never);

    for (const body of [
      { workspaceKey: "" },
      { workspaceKey: "   " },
      { workspaceKey: 42 },
      { brokerName: "" },
      { brokerName: { name: "x" } },
    ]) {
      const response = await POST(request(body), context());
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "Invalid request body",
        code: "invalid_request",
      });
    }
    expect(mocks.warmCloudAgentBox).not.toHaveBeenCalled();
  });

  it("PATCH never parses broker identity — provision-time only (#125)", async () => {
    mocks.updateCloudAgentBoxMountPaths.mockResolvedValue({
      sandboxId: "sbx_1",
      status: "ready",
      relayfileToken: "relay-token",
      relayfileMountPath: "/workspace",
    });
    const { PATCH } = createCloudAgentBoxRouteHandlers(deps as never);
    const patchRequest = new NextRequest(
      "https://cloud.test/api/v1/workspaces/00000000-0000-0000-0000-000000000002/cloud-agents/00000000-0000-0000-0000-000000000004/box",
      {
        method: "PATCH",
        body: JSON.stringify({
          relayfileMountPaths: ["/workspace"],
          workspaceKey: "wsk_attempted-rebind",
          brokerName: "rogue-rename",
        }),
        headers: {
          authorization: "Bearer cld_at_cloud-token",
          "content-type": "application/json",
        },
      },
    );

    const response = await PATCH(patchRequest, context());

    expect(response.status).toBe(200);
    const input = mocks.updateCloudAgentBoxMountPaths.mock.calls[0]?.[1];
    expect(input).toHaveProperty("mountPaths", ["/workspace"]);
    expect(input).not.toHaveProperty("workspaceKey");
    expect(input).not.toHaveProperty("brokerName");
  });

  it("maps unwrapped Daytona upstream timeout HTML to a clean 504 response", async () => {
    mocks.warmCloudAgentBox.mockRejectedValueOnce(
      new Error("<!DOCTYPE html><title>524: A timeout occurred</title> proxy.app.daytona.io"),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { POST } = createCloudAgentBoxRouteHandlers(deps as never);

    const response = await POST(request(), context());

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toEqual({
      error: "Daytona is currently unresponsive — please retry in a moment",
      code: "daytona_upstream_timeout",
    });
    expect(consoleError).toHaveBeenCalledWith(
      "[cloud-agent-box] unwrapped daytona upstream timeout reached routeError",
      expect.objectContaining({
        messagePreview: expect.stringContaining("524: A timeout occurred"),
      }),
    );
    consoleError.mockRestore();
  });
});
