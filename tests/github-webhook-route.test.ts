import type { NextRequest, NextResponse } from "next/server";
import { describe, expect, it, vi } from "vitest";

const {
  createGitHubRelayfileClientMock,
  dispatchIntegrationWatchEventMock,
  fanoutExceptMock,
  findAllWorkspaceIntegrationsByInstallationMock,
  findWorkspaceIntegrationByConnectionMock,
  ingestWebhookMock,
  loggerErrorMock,
  loggerWarnMock,
  writeBatchToRelayfileMock,
} = vi.hoisted(() => ({
  createGitHubRelayfileClientMock: vi.fn(),
  dispatchIntegrationWatchEventMock: vi.fn(),
  fanoutExceptMock: vi.fn(),
  findAllWorkspaceIntegrationsByInstallationMock: vi.fn(),
  findWorkspaceIntegrationByConnectionMock: vi.fn(),
  ingestWebhookMock: vi.fn(),
  loggerErrorMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  writeBatchToRelayfileMock: vi.fn(),
}));

function resetMocks(): void {
  vi.clearAllMocks();
  findWorkspaceIntegrationByConnectionMock.mockResolvedValue({
    workspaceId: "rw_test",
    provider: "github",
    connectionId: "conn-github",
    providerConfigKey: "github-relay",
    installationId: null,
    metadata: {},
  });
  findAllWorkspaceIntegrationsByInstallationMock.mockResolvedValue([]);
  createGitHubRelayfileClientMock.mockReturnValue({
    ingestWebhook: ingestWebhookMock,
  });
  ingestWebhookMock.mockResolvedValue({ status: "queued", id: "evt-1" });
  writeBatchToRelayfileMock.mockResolvedValue({ written: 1, deleted: 0, errors: 0 });
  dispatchIntegrationWatchEventMock.mockResolvedValue({ matched: 1, delivered: 1, failed: 0 });
  fanoutExceptMock.mockResolvedValue({ total: 1, succeeded: [], failed: [], skipped: [] });
  loggerErrorMock.mockResolvedValue(undefined);
  loggerWarnMock.mockResolvedValue(undefined);
}

function installMocks(): void {
  vi.doMock(
    "@/lib/integrations/github-relayfile",
    async (importOriginal: () => Promise<Record<string, unknown>>) => {
      const actual = await importOriginal();
      return {
        ...actual,
        createGitHubRelayfileClient: createGitHubRelayfileClientMock,
      };
    },
  );

  vi.doMock("@cloud/core/sync/record-writer.js", () => ({
    createWebhookSyncJob: (input: Record<string, unknown>) => ({
      type: "nango_sync",
      modifiedAfter: "",
      cursor: null,
      ...input,
    }),
    writeBatchToRelayfile: writeBatchToRelayfileMock,
  }));

  vi.doMock("@/lib/integrations/workspace-integrations", () => ({
    findWorkspaceIntegrationByConnection: findWorkspaceIntegrationByConnectionMock,
    findAllWorkspaceIntegrationsByInstallation: findAllWorkspaceIntegrationsByInstallationMock,
  }));

  vi.doMock("@/lib/integrations/webhook-consumer-registry", () => ({
    getRegistry: () => ({
      fanoutExcept: fanoutExceptMock,
    }),
  }));

  vi.doMock("@/lib/proactive-runtime/service-client", () => ({
    dispatchIntegrationWatchEvent: dispatchIntegrationWatchEventMock,
  }));

  vi.doMock("@/lib/logger", () => ({
    captureError: vi.fn().mockResolvedValue(undefined),
    logger: {
      error: loggerErrorMock,
      warn: loggerWarnMock,
    },
  }));
}

async function loadRoute(): Promise<{ POST: (request: NextRequest) => Promise<NextResponse> }> {
  vi.resetModules();
  installMocks();
  return (await import(
    "../packages/web/app/api/v1/webhooks/github/route.ts"
  )) as unknown as { POST: (request: NextRequest) => Promise<NextResponse> };
}

function githubRequest(event: string, body: Record<string, unknown>): NextRequest {
  const url = new URL("https://cloud.example.com/api/v1/webhooks/github?connection_id=conn-github");
  const request = new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": "delivery-1",
    },
    body: JSON.stringify(body),
  });
  Object.defineProperty(request, "nextUrl", { value: url });
  return request as unknown as NextRequest;
}

describe("/api/v1/webhooks/github", () => {
  it("routes issues through the record writer so indexes and aliases can emit", async () => {
    resetMocks();
    const { POST } = await loadRoute();

    const response = await POST(
      githubRequest("issues", {
        action: "opened",
        repository: {
          full_name: "AgentWorkforce/cloud",
          name: "cloud",
          owner: { login: "AgentWorkforce" },
        },
        issue: {
          id: 584,
          number: 584,
          title: "GitHub webhook route",
          html_url: "https://github.com/AgentWorkforce/cloud/issues/584",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(writeBatchToRelayfileMock).toHaveBeenCalledTimes(1);
    expect(dispatchIntegrationWatchEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "rw_test",
        provider: "github",
        eventType: "issues.opened",
        connectionId: "conn-github",
        deliveryId: "delivery-1",
        paths: [expect.stringContaining("/issues/584__github-webhook-route/meta.json")],
      }),
    );
    expect(ingestWebhookMock).not.toHaveBeenCalled();
    expect(writeBatchToRelayfileMock.mock.calls[0]?.[2]).toMatchObject({
      provider: "github",
      syncName: "fetch-open-issues",
      model: "Issue",
      workspaceId: "rw_test",
    });
  });

  it("returns 500 when the record writer reports partial write errors", async () => {
    resetMocks();
    writeBatchToRelayfileMock.mockResolvedValueOnce({ written: 0, deleted: 0, errors: 1 });
    const { POST } = await loadRoute();

    const response = await POST(
      githubRequest("issues", {
        action: "opened",
        repository: {
          full_name: "AgentWorkforce/cloud",
          name: "cloud",
          owner: { login: "AgentWorkforce" },
        },
        issue: {
          id: 584,
          number: 584,
          title: "GitHub webhook route",
        },
      }),
    );

    expect(response.status).toBe(500);
    expect(dispatchIntegrationWatchEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "rw_test",
        provider: "github",
        eventType: "issues.opened",
        paths: [expect.stringContaining("/issues/584__github-webhook-route/meta.json")],
      }),
    );
    expect(fanoutExceptMock).toHaveBeenCalledWith(
      "github",
      expect.objectContaining({
        eventType: "issues.opened",
        workspaceId: "rw_test",
        path: expect.stringContaining("/issues/584__github-webhook-route/meta.json"),
      }),
      ["relayfile-primary"],
    );
    expect(loggerErrorMock).toHaveBeenCalledWith(
      "GitHub webhook Relayfile write completed with errors",
      expect.objectContaining({
        provider: "github",
        model: "Issue",
        errors: 1,
      }),
    );
  });

  it("materializes issue comments with a non-empty Relayfile ingest envelope", async () => {
    resetMocks();
    const { POST } = await loadRoute();

    const response = await POST(
      githubRequest("issue_comment", {
        action: "created",
        repository: {
          full_name: "AgentWorkforce/cloud",
          name: "cloud",
          owner: { login: "AgentWorkforce" },
        },
        issue: {
          number: 584,
          title: "GitHub webhook route",
        },
        comment: {
          id: 4441089669,
          body: "route comment",
          user: { login: "codex" },
          created_at: "2026-05-13T12:41:04Z",
          updated_at: "2026-05-13T12:41:04Z",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(writeBatchToRelayfileMock).not.toHaveBeenCalled();
    expect(ingestWebhookMock).toHaveBeenCalledTimes(1);
    const ingestCall = ingestWebhookMock.mock.calls[0]?.[0] as {
      event_type: string;
      path: string;
      data: Record<string, unknown>;
    };
    expect(ingestCall.event_type).toBe("file.updated");
    expect(ingestCall.path).toContain("/issues/584__github-webhook-route/comments/4441089669.json");
    expect(ingestCall.data.contentType).toBe("application/json; charset=utf-8");
    expect(JSON.parse(ingestCall.data.content as string)).toMatchObject({
      id: 4441089669,
      body: "route comment",
      author: { login: "codex" },
    });
  });

  it("fans out installation webhooks to every matching workspace before responding", async () => {
    resetMocks();
    findWorkspaceIntegrationByConnectionMock.mockResolvedValue(null);
    findAllWorkspaceIntegrationsByInstallationMock.mockResolvedValue([
      {
        workspaceId: "rw_primary",
        provider: "github",
        connectionId: "conn-primary",
        providerConfigKey: "github-relay",
        installationId: "133694449",
        metadata: {},
      },
      {
        workspaceId: "rw_sibling",
        provider: "github",
        connectionId: "conn-sibling",
        providerConfigKey: "github-relay",
        installationId: "133694449",
        metadata: {},
      },
    ]);
    let releaseSiblingDispatch: () => void = () => {
      throw new Error("sibling dispatch was not started");
    };
    dispatchIntegrationWatchEventMock.mockImplementation((input: { workspaceId: string }) => {
      if (input.workspaceId !== "rw_sibling") {
        return Promise.resolve({ matched: 1, delivered: 1, failed: 0 });
      }
      return new Promise((resolve) => {
        releaseSiblingDispatch = () => resolve({ matched: 1, delivered: 1, failed: 0 });
      });
    });
    const { POST } = await loadRoute();

    let settled = false;
    const responsePromise = POST(
      githubRequest("issues", {
        action: "opened",
        installation: { id: 133694449 },
        repository: {
          full_name: "AgentWorkforce/cloud",
          name: "cloud",
          owner: { login: "AgentWorkforce" },
        },
        issue: {
          id: 584,
          number: 584,
          title: "GitHub webhook route",
        },
      }),
    ).finally(() => {
      settled = true;
    });

    await vi.waitFor(() => {
      expect(dispatchIntegrationWatchEventMock).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: "rw_sibling" }),
      );
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseSiblingDispatch?.();
    const response = await responsePromise;
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      workspaceId: "rw_primary",
      fanoutWorkspaces: 1,
    });
    expect(findAllWorkspaceIntegrationsByInstallationMock).toHaveBeenCalledWith(
      "github",
      "133694449",
    );
    expect(findWorkspaceIntegrationByConnectionMock).not.toHaveBeenCalled();
    expect(writeBatchToRelayfileMock).toHaveBeenCalledTimes(2);
    expect(dispatchIntegrationWatchEventMock).toHaveBeenCalledTimes(2);
    expect(dispatchIntegrationWatchEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "rw_primary",
        connectionId: "conn-primary",
      }),
    );
    expect(dispatchIntegrationWatchEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "rw_sibling",
        connectionId: "conn-sibling",
      }),
    );
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "GitHub webhook installation fanout matched multiple workspaces",
      expect.objectContaining({
        installationId: "133694449",
        matchingWorkspaceIds: ["rw_primary", "rw_sibling"],
      }),
    );
  });
});
