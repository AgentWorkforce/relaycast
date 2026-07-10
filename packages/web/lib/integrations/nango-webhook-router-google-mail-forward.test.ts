import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findWorkspaceIntegrationByConnection: vi.fn(),
  getNangoConnectionDetails: vi.fn(),
  getNangoSecretKey: vi.fn(),
  getProviderConfigKey: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  nangoProxy: vi.fn(),
  reportWorkspaceProviderWebhookHealth: vi.fn(),
  triggerNangoSyncs: vi.fn(),
  dispatchIntegrationWatchEvent: vi.fn(),
  updateWorkspaceIntegrationMetadata: vi.fn(),
  writeBatchToRelayfile: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@nangohq/node", () => ({
  Nango: vi.fn(function Nango() {
    return {
      proxy: mocks.nangoProxy,
    };
  }),
}));

vi.mock("@cloud/core/provider-readiness.js", () => ({
  markProviderInitialSyncComplete: vi.fn(),
  markProviderInitialSyncFailed: vi.fn(),
  markProviderInitialSyncQueued: vi.fn(),
  markProviderOAuthConnected: vi.fn(),
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
    createGitHubRelayfileClient: vi.fn(() => ({ mocked: "relayfile-client" })),
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
    getProviderConfigKey: mocks.getProviderConfigKey,
    getNangoConnectionDetails: mocks.getNangoConnectionDetails,
    getNangoSecretKey: mocks.getNangoSecretKey,
    triggerNangoSyncs: mocks.triggerNangoSyncs,
  };
});

vi.mock("@/lib/integrations/provider-status", () => ({
  reportWorkspaceProviderWebhookHealth:
    mocks.reportWorkspaceProviderWebhookHealth,
}));

vi.mock("@/lib/integrations/workspace-integrations", async () => {
  const actual = await vi.importActual<
    typeof import("./workspace-integrations")
  >("@/lib/integrations/workspace-integrations");
  return {
    ...actual,
    findWorkspaceIntegrationByConnection:
      mocks.findWorkspaceIntegrationByConnection,
    updateWorkspaceIntegrationMetadata:
      mocks.updateWorkspaceIntegrationMetadata,
  };
});

vi.mock("@/lib/logger", () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: vi.fn(),
  },
}));

describe("Google Mail forward webhooks", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T10:37:00.000Z"));
    mocks.findWorkspaceIntegrationByConnection.mockResolvedValue({
      workspaceId: "rw_fc7b534b",
      connectionId: "conn-gmail-1",
      providerConfigKey: "google-mail-relay",
      metadata: {
        gmailForwardHistoryId: "100",
      },
    });
    mocks.getNangoConnectionDetails.mockResolvedValue(null);
    mocks.getNangoSecretKey.mockReturnValue("nango-secret");
    mocks.getProviderConfigKey.mockReturnValue("google-mail-relay");
    mocks.reportWorkspaceProviderWebhookHealth.mockResolvedValue(true);
    mocks.updateWorkspaceIntegrationMetadata.mockResolvedValue({
      workspaceId: "rw_fc7b534b",
      connectionId: "conn-gmail-1",
      providerConfigKey: "google-mail-relay",
      metadata: {
        gmailForwardHistoryId: "105",
      },
    });
    mocks.writeBatchToRelayfile.mockResolvedValue({
      written: 1,
      deleted: 0,
      skipped: 0,
      errors: 0,
    });
    mocks.triggerNangoSyncs.mockResolvedValue({ ok: true });
    mocks.dispatchIntegrationWatchEvent.mockResolvedValue({
      matched: 0,
      delivered: 0,
      failed: 0,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function pubsubPayload(historyId: string) {
    return {
      message: {
        data: Buffer.from(
          JSON.stringify({ emailAddress: "me@example.com", historyId }),
          "utf8",
        ).toString("base64"),
      },
    };
  }

  it("writes changed messages and threads directly from Gmail history", async () => {
    const payload = pubsubPayload("105");
    mocks.nangoProxy
      .mockResolvedValueOnce({
        data: {
          historyId: "105",
          history: [
            {
              id: "101",
              messagesAdded: [
                { message: { id: "msg-1", threadId: "thread-1" } },
              ],
              labelsAdded: [
                { message: { id: "msg-2", threadId: "thread-2" }, labelIds: ["STARRED"] },
              ],
              messagesDeleted: [
                { message: { id: "msg-old", threadId: "thread-old" } },
              ],
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: {
          id: "msg-1",
          threadId: "thread-1",
          historyId: "104",
          internalDate: "1716200000000",
        },
      })
      .mockResolvedValueOnce({
        data: {
          id: "msg-2",
          threadId: "thread-2",
          historyId: "105",
          internalDate: "1716200001000",
        },
      })
      .mockResolvedValueOnce({
        data: {
          id: "thread-1",
          historyId: "104",
          messages: [{ id: "msg-1", threadId: "thread-1" }],
        },
      })
      .mockResolvedValueOnce({
        data: {
          id: "thread-2",
          historyId: "105",
          messages: [{ id: "msg-2", threadId: "thread-2" }],
        },
      })
      .mockRejectedValueOnce({ status: 404 });
    const { routeNangoWebhook } = await import("./nango-webhook-router");

    await routeNangoWebhook({
      from: "google-mail",
      type: "forward",
      providerConfigKey: "google-mail-relay",
      connectionId: "conn-gmail-1",
      payload,
    });

    expect(mocks.triggerNangoSyncs).not.toHaveBeenCalled();
    expect(mocks.nangoProxy).toHaveBeenNthCalledWith(1, {
      method: "GET",
      endpoint: "/gmail/v1/users/me/history",
      connectionId: "conn-gmail-1",
      providerConfigKey: "google-mail-relay",
      params: { startHistoryId: "100" },
    });
    expect(mocks.writeBatchToRelayfile).toHaveBeenNthCalledWith(
      1,
      expect.any(Object),
      expect.arrayContaining([
        expect.objectContaining({ id: "msg-1" }),
        expect.objectContaining({ id: "msg-2" }),
        expect.objectContaining({ id: "msg-old" }),
      ]),
      expect.objectContaining({
        provider: "google-mail",
        syncName: "fetch-messages",
        model: "GoogleMailMessage",
      }),
      { concurrency: 1 },
    );
    expect(mocks.writeBatchToRelayfile).toHaveBeenNthCalledWith(
      2,
      expect.any(Object),
      expect.arrayContaining([
        expect.objectContaining({ id: "thread-1" }),
        expect.objectContaining({ id: "thread-2" }),
        expect.objectContaining({ id: "thread-old" }),
      ]),
      expect.objectContaining({
        provider: "google-mail",
        syncName: "fetch-threads",
        model: "GoogleMailThread",
      }),
      { concurrency: 1 },
    );
    expect(mocks.updateWorkspaceIntegrationMetadata).toHaveBeenCalledWith({
      workspaceId: "rw_fc7b534b",
      provider: "google-mail",
      connectionId: "conn-gmail-1",
      update: expect.any(Function),
    });
    const update = mocks.updateWorkspaceIntegrationMetadata.mock.calls[0][0].update;
    expect(update({ gmailForwardHistoryId: "100" })).toMatchObject({
      gmailForwardHistoryId: "105",
      gmailForwardHistoryUpdatedAt: "2026-05-20T10:37:00.000Z",
    });
    expect(mocks.reportWorkspaceProviderWebhookHealth).toHaveBeenCalledWith({
      workspaceId: "rw_fc7b534b",
      provider: "google-mail",
      healthy: true,
      eventAt: "2026-05-20T10:37:00.000Z",
      error: null,
    });
    expect(mocks.dispatchIntegrationWatchEvent).toHaveBeenCalledWith({
      workspaceId: "rw_fc7b534b",
      provider: "google-mail",
      eventType: "message.changed",
      connectionId: "conn-gmail-1",
      payload,
    });
    expect(
      mocks.dispatchIntegrationWatchEvent.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.nangoProxy.mock.invocationCallOrder[0]);
    expect(
      mocks.dispatchIntegrationWatchEvent.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.writeBatchToRelayfile.mock.invocationCallOrder[0]);
  });

  it("falls back to incremental sync when Gmail history is stale", async () => {
    mocks.nangoProxy.mockRejectedValueOnce({ response: { status: 404 } });
    const { routeNangoWebhook } = await import("./nango-webhook-router");

    await routeNangoWebhook({
      from: "google-mail",
      type: "forward",
      providerConfigKey: "google-mail-relay",
      connectionId: "conn-gmail-1",
      payload: pubsubPayload("105"),
    });

    expect(mocks.writeBatchToRelayfile).not.toHaveBeenCalled();
    expect(mocks.triggerNangoSyncs).toHaveBeenCalledWith({
      providerConfigKey: "google-mail-relay",
      connectionId: "conn-gmail-1",
      syncs: ["fetch-messages", "fetch-threads"],
      syncMode: "incremental",
    });
    expect(mocks.updateWorkspaceIntegrationMetadata).not.toHaveBeenCalled();
    expect(mocks.reportWorkspaceProviderWebhookHealth).toHaveBeenCalledWith({
      workspaceId: "rw_fc7b534b",
      provider: "google-mail",
      healthy: true,
      eventAt: "2026-05-20T10:37:00.000Z",
      error: null,
    });
  });

  it("bootstraps the forward checkpoint when falling back without a stored history id", async () => {
    mocks.findWorkspaceIntegrationByConnection.mockResolvedValue({
      workspaceId: "rw_fc7b534b",
      connectionId: "conn-gmail-1",
      providerConfigKey: "google-mail-relay",
      metadata: {},
    });
    const { routeNangoWebhook } = await import("./nango-webhook-router");

    await routeNangoWebhook({
      from: "google-mail",
      type: "forward",
      providerConfigKey: "google-mail-relay",
      connectionId: "conn-gmail-1",
      payload: pubsubPayload("105"),
    });

    expect(mocks.nangoProxy).not.toHaveBeenCalled();
    expect(mocks.triggerNangoSyncs).toHaveBeenCalledWith({
      providerConfigKey: "google-mail-relay",
      connectionId: "conn-gmail-1",
      syncs: ["fetch-messages", "fetch-threads"],
      syncMode: "incremental",
    });
    expect(mocks.updateWorkspaceIntegrationMetadata).not.toHaveBeenCalled();
  });

  it("does not regress the checkpoint for out-of-order pushes", async () => {
    mocks.findWorkspaceIntegrationByConnection.mockResolvedValue({
      workspaceId: "rw_fc7b534b",
      connectionId: "conn-gmail-1",
      providerConfigKey: "google-mail-relay",
      metadata: {
        gmailForwardHistoryId: "200",
      },
    });
    const { routeNangoWebhook } = await import("./nango-webhook-router");

    await routeNangoWebhook({
      from: "google-mail",
      type: "forward",
      providerConfigKey: "google-mail-relay",
      connectionId: "conn-gmail-1",
      payload: pubsubPayload("150"),
    });

    expect(mocks.nangoProxy).not.toHaveBeenCalled();
    expect(mocks.writeBatchToRelayfile).not.toHaveBeenCalled();
    expect(mocks.triggerNangoSyncs).not.toHaveBeenCalled();
    expect(mocks.updateWorkspaceIntegrationMetadata).not.toHaveBeenCalled();
    expect(mocks.reportWorkspaceProviderWebhookHealth).toHaveBeenCalledWith({
      workspaceId: "rw_fc7b534b",
      provider: "google-mail",
      healthy: true,
      eventAt: "2026-05-20T10:37:00.000Z",
      error: null,
    });
  });

  it("records unhealthy webhook status without failing the webhook when fallback sync trigger fails", async () => {
    mocks.nangoProxy.mockRejectedValueOnce({ status: 404 });
    mocks.triggerNangoSyncs.mockResolvedValue({ ok: false, status: 502 });
    const { routeNangoWebhook } = await import("./nango-webhook-router");

    await routeNangoWebhook({
      from: "google-mail",
      type: "forward",
      providerConfigKey: "google-mail-relay",
      connectionId: "conn-gmail-1",
      payload: pubsubPayload("105"),
    });

    expect(mocks.reportWorkspaceProviderWebhookHealth).toHaveBeenCalledWith({
      workspaceId: "rw_fc7b534b",
      provider: "google-mail",
      healthy: false,
      eventAt: "2026-05-20T10:37:00.000Z",
      error: "Failed to trigger Google Mail syncs from forward webhook: 502",
    });
    expect(mocks.updateWorkspaceIntegrationMetadata).not.toHaveBeenCalled();
  });

  it("records unhealthy webhook status without failing the webhook when fallback sync throws", async () => {
    mocks.nangoProxy.mockRejectedValueOnce({ status: 404 });
    mocks.triggerNangoSyncs.mockRejectedValue(new Error("nango unavailable"));
    const { routeNangoWebhook } = await import("./nango-webhook-router");

    await routeNangoWebhook({
      from: "google-mail",
      type: "forward",
      providerConfigKey: "google-mail-relay",
      connectionId: "conn-gmail-1",
      payload: pubsubPayload("105"),
    });

    expect(mocks.reportWorkspaceProviderWebhookHealth).toHaveBeenCalledWith({
      workspaceId: "rw_fc7b534b",
      provider: "google-mail",
      healthy: false,
      eventAt: "2026-05-20T10:37:00.000Z",
      error: "nango unavailable",
    });
    expect(mocks.updateWorkspaceIntegrationMetadata).not.toHaveBeenCalled();
  });

  it("retries transient Nango proxy throttles before replaying history", async () => {
    const payload = pubsubPayload("105");
    mocks.nangoProxy
      .mockRejectedValueOnce({ status: 429, response: { headers: { "Retry-After": "60" } } })
      .mockResolvedValueOnce({
        data: {
          historyId: "105",
          history: [
            {
              id: "101",
              messagesAdded: [
                { message: { id: "msg-1", threadId: "thread-1" } },
              ],
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: {
          id: "msg-1",
          threadId: "thread-1",
          historyId: "105",
        },
      })
      .mockResolvedValueOnce({
        data: {
          id: "thread-1",
          historyId: "105",
          messages: [{ id: "msg-1", threadId: "thread-1" }],
        },
      });
    const { routeNangoWebhook } = await import("./nango-webhook-router");

    const run = routeNangoWebhook({
      from: "google-mail",
      type: "forward",
      providerConfigKey: "google-mail-relay",
      connectionId: "conn-gmail-1",
      payload,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await run;

    expect(mocks.nangoProxy).toHaveBeenCalledTimes(4);
    expect(mocks.writeBatchToRelayfile).toHaveBeenCalledTimes(2);
    expect(mocks.triggerNangoSyncs).not.toHaveBeenCalled();
  });

  it("falls back to incremental sync after sustained transient Nango proxy failures", async () => {
    mocks.nangoProxy.mockRejectedValue({
      response: { status: 429, headers: { "retry-after": "0" } },
    });
    const { routeNangoWebhook } = await import("./nango-webhook-router");

    const run = routeNangoWebhook({
      from: "google-mail",
      type: "forward",
      providerConfigKey: "google-mail-relay",
      connectionId: "conn-gmail-1",
      payload: pubsubPayload("105"),
    });
    await vi.runAllTimersAsync();
    await run;

    expect(mocks.nangoProxy).toHaveBeenCalledTimes(4);
    expect(mocks.writeBatchToRelayfile).not.toHaveBeenCalled();
    expect(mocks.triggerNangoSyncs).toHaveBeenCalledWith({
      providerConfigKey: "google-mail-relay",
      connectionId: "conn-gmail-1",
      syncs: ["fetch-messages", "fetch-threads"],
      syncMode: "incremental",
    });
    expect(mocks.reportWorkspaceProviderWebhookHealth).toHaveBeenLastCalledWith({
      workspaceId: "rw_fc7b534b",
      provider: "google-mail",
      healthy: true,
      eventAt: "2026-05-20T10:37:00.000Z",
      error: null,
    });
    expect(mocks.updateWorkspaceIntegrationMetadata).not.toHaveBeenCalled();
  });

  it("falls back to incremental sync when direct Relayfile replay remains overloaded", async () => {
    mocks.nangoProxy
      .mockResolvedValueOnce({
        data: {
          historyId: "105",
          history: [
            {
              id: "101",
              messagesAdded: [
                { message: { id: "msg-1", threadId: "thread-1" } },
              ],
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: {
          id: "msg-1",
          threadId: "thread-1",
          historyId: "105",
        },
      })
      .mockResolvedValueOnce({
        data: {
          id: "thread-1",
          historyId: "105",
          messages: [{ id: "msg-1", threadId: "thread-1" }],
        },
      });
    mocks.writeBatchToRelayfile.mockResolvedValue({
      written: 0,
      deleted: 0,
      skipped: 0,
      errors: 1,
    });
    const { routeNangoWebhook } = await import("./nango-webhook-router");

    const run = routeNangoWebhook({
      from: "google-mail",
      type: "forward",
      providerConfigKey: "google-mail-relay",
      connectionId: "conn-gmail-1",
      payload: pubsubPayload("105"),
    });
    await vi.advanceTimersByTimeAsync(750);
    await run;

    expect(mocks.writeBatchToRelayfile).toHaveBeenCalledTimes(3);
    expect(mocks.triggerNangoSyncs).toHaveBeenCalledWith({
      providerConfigKey: "google-mail-relay",
      connectionId: "conn-gmail-1",
      syncs: ["fetch-messages", "fetch-threads"],
      syncMode: "incremental",
    });
    expect(mocks.reportWorkspaceProviderWebhookHealth).toHaveBeenLastCalledWith({
      workspaceId: "rw_fc7b534b",
      provider: "google-mail",
      healthy: true,
      eventAt: "2026-05-20T10:37:00.000Z",
      error: null,
    });
    expect(mocks.updateWorkspaceIntegrationMetadata).not.toHaveBeenCalled();
  });
});
