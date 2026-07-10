import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dispatchIntegrationWatchEvent: vi.fn(),
  findWorkspaceIntegrationByConnection: vi.fn(),
  ingestWebhook: vi.fn(),
  loggerError: vi.fn(),
  writeBatchToRelayfile: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@nangohq/node", () => ({
  Nango: vi.fn(function Nango() {
    return {
      proxy: vi.fn(),
    };
  }),
}));

vi.mock("@cloud/core/provider-readiness.js", () => ({
  markProviderInitialSyncComplete: vi.fn(),
  markProviderInitialSyncFailed: vi.fn(),
  markProviderInitialSyncQueued: vi.fn(),
  markProviderOAuthConnected: vi.fn(),
}));

vi.mock("@cloud/core/sync/nango-provider-parity.js", () => ({
  isGeneratedNangoProviderModel: vi.fn(() => false),
}));

vi.mock("@cloud/core/sync/record-writer.js", () => ({
  buildDeletionRecord: vi.fn((id: string, metadata: Record<string, unknown>) => ({
    id,
    _deleted: true,
    ...metadata,
  })),
  createWebhookSyncJob: vi.fn((job: Record<string, unknown>) => job),
  writeBatchToRelayfile: mocks.writeBatchToRelayfile,
}));

vi.mock("@/lib/integrations/nango-sync-queue", () => ({
  enqueueNangoSyncJob: vi.fn(),
}));

vi.mock("@/lib/integrations/github-relayfile", async () => {
  const actual = await vi.importActual<
    typeof import("./github-relayfile")
  >("@/lib/integrations/github-relayfile");
  return {
    ...actual,
    createGitHubRelayfileClient: vi.fn(() => ({
      mocked: "relayfile-client",
      ingestWebhook: mocks.ingestWebhook,
    })),
  };
});

vi.mock("@/lib/proactive-runtime/integration-watch-dispatcher", () => ({
  dispatchIntegrationWatchEvent: mocks.dispatchIntegrationWatchEvent,
}));

vi.mock("@/lib/integrations/nango-service", async () => {
  const actual = await vi.importActual<
    typeof import("./nango-service")
  >("@/lib/integrations/nango-service");
  return {
    ...actual,
    getNangoConnectionDetails: vi.fn(),
    getNangoSecretKey: vi.fn(() => "nango-secret"),
    getProviderConfigKey: vi.fn(() => "github-relay"),
    triggerNangoSyncs: vi.fn(),
  };
});

vi.mock("@/lib/integrations/workspace-integrations", async () => {
  const actual = await vi.importActual<
    typeof import("./workspace-integrations")
  >("@/lib/integrations/workspace-integrations");
  return {
    ...actual,
    findWorkspaceIntegrationByConnection:
      mocks.findWorkspaceIntegrationByConnection,
  };
});

vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: mocks.loggerError,
  },
}));

describe("GitHub forward webhooks", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.findWorkspaceIntegrationByConnection.mockResolvedValue({
      workspaceId: "rw_fc7b534b",
      connectionId: "conn-github-1",
      providerConfigKey: "github-relay",
    });
    mocks.dispatchIntegrationWatchEvent.mockResolvedValue({
      matched: 1,
      delivered: 0,
      failed: 0,
    });
    mocks.ingestWebhook.mockResolvedValue({ ok: true });
  });

  it("infers GitHub pull request webhook variants from payload shape", async () => {
    const { inferGitHubEvent } = await import("./nango-webhook-router");

    expect(inferGitHubEvent({
      deployment: { id: 42 },
      deployment_status: { id: 555 },
    })).toBe("deployment_status");
    expect(inferGitHubEvent({
      pull_request: { id: 17 },
      comment: { id: 987 },
    })).toBe("pull_request_review_comment");
    expect(inferGitHubEvent({
      pull_request: { id: 17 },
      review: { id: 654 },
    })).toBe("pull_request_review");
    expect(inferGitHubEvent({
      pull_request: { id: 17 },
    })).toBe("pull_request");
  });

  it("materializes pull request author from webhook user into Relayfile metadata", async () => {
    mocks.writeBatchToRelayfile.mockResolvedValue({
      written: 1,
      deleted: 0,
      skipped: 0,
      errors: 0,
    });
    const { routeNangoWebhook } = await import("./nango-webhook-router");

    await routeNangoWebhook({
      from: "github-app-oauth",
      type: "forward",
      providerConfigKey: "github-relay",
      connectionId: "conn-github-1",
      payload: {
        headers: {
          "x-github-event": "pull_request",
          "x-github-delivery": "delivery-pr-1803",
        },
        body: {
          action: "opened",
          installation: { id: 12345 },
          repository: {
            name: "cloud",
            full_name: "AgentWorkforce/cloud",
            owner: { login: "AgentWorkforce" },
          },
          pull_request: {
            id: 1803000,
            number: 1803,
            title: "Trigger review",
            state: "open",
            user: {
              login: "khaliqgant",
              avatar_url: "https://avatars.githubusercontent.com/u/123?v=4",
            },
          },
        },
      },
    });

    expect(mocks.writeBatchToRelayfile).toHaveBeenCalledWith(
      expect.anything(),
      [
        expect.objectContaining({
          number: 1803,
          author: "khaliqgant",
          _webhook: expect.objectContaining({
            eventType: "pull_request.opened",
            objectType: "pull_request",
            objectId: "1803",
          }),
        }),
      ],
      expect.objectContaining({
        workspaceId: "rw_fc7b534b",
        provider: "github",
        syncName: "fetch-open-prs",
        model: "PullRequest",
      }),
    );
    expect(mocks.dispatchIntegrationWatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "pull_request.opened",
        paths: [
          "/github/repos/AgentWorkforce/cloud/pulls/1803__trigger-review/meta.json",
        ],
        payload: expect.objectContaining({
          author: "khaliqgant",
          // The DELIVERY payload carries the minimal nested stub so the
          // pr-reviewer persona resolves the author from the event itself —
          // deterministic, no mounted-meta.json race.
          pull_request: { user: { login: "khaliqgant" } },
        }),
      }),
    );
    // The relayfile-STORED record must stay unenriched: meta.json keeps the
    // canonical unwrapped shape (no nested pull_request).
    const [, writtenRecords] = mocks.writeBatchToRelayfile.mock.calls.at(-1)!;
    expect(writtenRecords[0].pull_request).toBeUndefined();
  });

  it("fans out pull request review comments when Nango omits the GitHub event header", async () => {
    const { routeNangoWebhook } = await import("./nango-webhook-router");

    await routeNangoWebhook({
      from: "github-app-oauth",
      type: "forward",
      providerConfigKey: "github-relay",
      connectionId: "conn-github-1",
      payload: {
        request: {
          headers: {
            "x-github-delivery": "delivery-review-comment-987",
          },
        },
        body: {
          action: "created",
          installation: { id: 12345 },
          repository: {
            name: "cloud",
            full_name: "AgentWorkforce/cloud",
            owner: { login: "AgentWorkforce" },
          },
          pull_request: {
            id: 1700,
            number: 17,
            title: "Fix webhook fanout",
          },
          comment: {
            id: 987,
            body: "Please update this line",
            path: "packages/web/lib/integrations/nango-webhook-router.ts",
          },
        },
      },
    });

    expect(mocks.dispatchIntegrationWatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "rw_fc7b534b",
        provider: "github",
        eventType: "pull_request_review_comment.created",
        connectionId: "conn-github-1",
        deliveryId: "delivery-review-comment-987",
        paths: [
          "/github/repos/AgentWorkforce/cloud/comments/987.json",
          "/github/repos/AgentWorkforce/cloud/pulls/17__fix-webhook-fanout/**",
        ],
        payload: expect.objectContaining({
          id: 987,
          _webhook: expect.objectContaining({
            eventType: "pull_request_review_comment.created",
            objectType: "review_comment",
            objectId: "987",
          }),
        }),
      }),
    );
  });

  it("fans out deployment_status events when Nango omits the GitHub event header", async () => {
    const { routeNangoWebhook } = await import("./nango-webhook-router");

    await routeNangoWebhook({
      from: "github-app-oauth",
      type: "forward",
      providerConfigKey: "github-relay",
      connectionId: "conn-github-1",
      payload: {
        request: {
          headers: {
            "x-github-delivery": "delivery-deployment-status-555",
          },
        },
        body: {
          action: "created",
          installation: { id: 12345 },
          repository: {
            name: "cloud",
            full_name: "AgentWorkforce/cloud",
            owner: { login: "AgentWorkforce" },
          },
          deployment: {
            id: 42,
            environment: "production",
            sha: "abc123",
          },
          deployment_status: {
            id: 555,
            state: "success",
            target_url: "https://deploy.example/status/555",
          },
        },
      },
    });

    expect(mocks.dispatchIntegrationWatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "rw_fc7b534b",
        provider: "github",
        eventType: "deployment_status.created",
        connectionId: "conn-github-1",
        deliveryId: "delivery-deployment-status-555",
        paths: [
          "/github/repos/AgentWorkforce/cloud/deployments/42/statuses/555.json",
        ],
        payload: expect.objectContaining({
          id: 555,
          state: "success",
          deployment_id: 42,
          deploymentId: 42,
          environment: "production",
          deployment_environment: "production",
          deployment_sha: "abc123",
          _webhook: expect.objectContaining({
            eventType: "deployment_status.created",
            objectType: "deployment_status",
            objectId: "555",
          }),
        }),
      }),
    );
    expect(mocks.ingestWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "github",
        event_type: "file.updated",
        path: "/github/repos/AgentWorkforce/cloud/deployments/42/statuses/555.json",
        data: expect.objectContaining({
          state: "success",
          deployment_id: 42,
          content: expect.stringContaining("\"state\": \"success\""),
        }),
      }),
    );
    expect(mocks.ingestWebhook.mock.calls[0]?.[0].data).not.toHaveProperty(
      "deployment_status",
    );
  });

  it("forwards a completed check_run to integration-watch with conclusion and PR context", async () => {
    const { routeNangoWebhook } = await import("./nango-webhook-router");

    await routeNangoWebhook({
      from: "github-app-oauth",
      type: "forward",
      providerConfigKey: "github-relay",
      connectionId: "conn-github-1",
      payload: {
        headers: {
          "x-github-event": "check_run",
          "x-github-delivery": "delivery-check-run-555",
        },
        body: {
          action: "completed",
          installation: { id: 12345 },
          repository: {
            name: "cloud",
            full_name: "AgentWorkforce/cloud",
            owner: { login: "AgentWorkforce" },
          },
          check_run: {
            id: 555,
            name: "Unit Tests",
            status: "completed",
            conclusion: "failure",
            head_sha: "deadbeef",
            pull_requests: [
              {
                number: 88,
                url: "https://api.github.com/repos/AgentWorkforce/cloud/pulls/88",
              },
            ],
          },
        },
      },
    });

    expect(mocks.dispatchIntegrationWatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "rw_fc7b534b",
        provider: "github",
        // The action is appended to the X-GitHub-Event header — the persona
        // watch_rule and the failure-filter both key on this exact string.
        eventType: "check_run.completed",
        connectionId: "conn-github-1",
        deliveryId: "delivery-check-run-555",
        paths: ["/github/repos/AgentWorkforce/cloud/checks/555.json"],
        payload: expect.objectContaining({
          // The dispatcher reads `conclusion` (failure-filter) and
          // `pull_requests[]` (loop-guard PR key) straight off this payload.
          conclusion: "failure",
          pull_requests: [
            expect.objectContaining({ number: 88 }),
          ],
          _webhook: expect.objectContaining({
            eventType: "check_run.completed",
            objectType: "check_run",
            objectId: "555",
          }),
        }),
      }),
    );
  });

  it("enqueues integration-watch before surfacing Relayfile primary write failures", async () => {
    mocks.writeBatchToRelayfile.mockResolvedValue({
      written: 0,
      deleted: 0,
      skipped: 0,
      errors: 1,
    });
    const { routeNangoWebhook } = await import("./nango-webhook-router");

    await expect(routeNangoWebhook({
      from: "github-app-oauth",
      type: "forward",
      providerConfigKey: "github-relay",
      connectionId: "conn-github-1",
      payload: {
        headers: {
          "x-github-event": "issues",
          "x-github-delivery": "delivery-1204",
        },
        body: {
          action: "opened",
          installation: { id: 12345 },
          repository: {
            name: "cloud",
            full_name: "AgentWorkforce/cloud",
            owner: { login: "AgentWorkforce" },
          },
          issue: {
            id: 1204000,
            number: 1204,
            title: "E2E probe",
            state: "open",
            labels: [{ name: "small" }],
          },
        },
      },
    })).rejects.toMatchObject({
      name: "RelayfilePrimaryWriteError",
    });

    expect(mocks.dispatchIntegrationWatchEvent).toHaveBeenCalledWith({
      workspaceId: "rw_fc7b534b",
      provider: "github",
      eventType: "issues.opened",
      connectionId: "conn-github-1",
      deliveryId: "delivery-1204",
      paths: [
        "/github/repos/AgentWorkforce/cloud/issues/1204__e2e-probe/meta.json",
      ],
      payload: expect.objectContaining({
        number: 1204,
        state: "open",
      }),
    });
    expect(
      mocks.dispatchIntegrationWatchEvent.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.writeBatchToRelayfile.mock.invocationCallOrder[0]);
    expect(mocks.loggerError).toHaveBeenCalledWith(
      "Relayfile provider write completed with errors",
      expect.objectContaining({
        area: "nango-webhook",
        workspaceId: "rw_fc7b534b",
        provider: "github",
        errors: 1,
      }),
    );
    expect(mocks.loggerError).toHaveBeenCalledWith(
      "GitHub forward relayfile primary write failed; continuing webhook fanout",
      expect.objectContaining({
        area: "nango-webhook",
        workspaceId: "rw_fc7b534b",
        connectionId: "conn-github-1",
        deliveryId: "delivery-1204",
      }),
    );
  });
});
