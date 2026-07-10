import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createGitHubRelayfileClient: vi.fn(),
  dbExecute: vi.fn(),
  dispatchIntegrationWatchEvent: vi.fn(),
  findSlackIntegrationByConnectionId: vi.fn(),
  findSlackIntegrationByTeamId: vi.fn(),
  findWorkspaceIntegrationByConnection: vi.fn(),
  forwardSlackToRelay: vi.fn(),
  ingestWebhook: vi.fn(),
  loggerError: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  nangoProxy: vi.fn(),
  relayfileReadFile: vi.fn(),
  resolveAppWorkspaceIdForRuntime: vi.fn(),
  resolveRelayfileCredentialWorkspaceId: vi.fn(),
  upsertWorkspaceIntegration: vi.fn(),
  writeFile: vi.fn(),
  writeBatchToRelayfile: vi.fn(),
  claimWebhookDelivery: vi.fn(),
  releaseWebhookDelivery: vi.fn(),
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
  writeProviderReadiness: vi.fn(),
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

vi.mock("@/lib/integrations/github-relayfile", async () => {
  const actual = await vi.importActual<
    typeof import("./github-relayfile")
  >("@/lib/integrations/github-relayfile");
  return {
    ...actual,
    createGitHubRelayfileClient: mocks.createGitHubRelayfileClient.mockImplementation(() => ({
      ingestWebhook: mocks.ingestWebhook,
      readFile: mocks.relayfileReadFile,
      writeFile: mocks.writeFile,
    })),
  };
});

vi.mock("@/lib/integrations/github-installation-index", () => ({
  upsertGithubInstallationIndex: vi.fn(),
}));

vi.mock("@/lib/integrations/github-incremental-sync-trigger", () => ({
  enqueueIncrementalCloneJob: vi.fn(),
  readPriorCloneManifest: vi.fn(),
}));

vi.mock("@/lib/integrations/nango-service", () => ({
  getNangoConnectionDetails: vi.fn(),
  getNangoSecretKey: vi.fn(() => "nango-secret"),
  getProviderConfigKey: vi.fn(() => "slack-relay"),
  probeNangoConnectionLiveness: vi.fn(),
  startNangoSyncSchedules: vi.fn(),
  triggerNangoSyncs: vi.fn(),
}));

vi.mock("@/lib/integrations/nango-sync-queue", () => ({
  enqueueNangoSyncJob: vi.fn(),
}));

vi.mock("@/lib/integrations/nango-db-workspace-diagnostic", () => ({
  logNangoDbWorkspaceDiagnostic: vi.fn(),
}));

vi.mock("@/lib/integrations/relayfile-integration-push", () => ({
  resolveRelayfileCredentialWorkspaceId: mocks.resolveRelayfileCredentialWorkspaceId,
}));

vi.mock("@/lib/workspaces/workspace-integration-identity", () => ({
  resolveAppWorkspaceIdForRuntime: mocks.resolveAppWorkspaceIdForRuntime,
}));

vi.mock("@/lib/integrations/daytona-hookdeck-webhook", () => ({
  routeDaytonaWebhook: vi.fn(),
}));

vi.mock("@/lib/env", () => ({
  optionalEnv: vi.fn(() => undefined),
}));

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => ({ execute: mocks.dbExecute })),
}));

vi.mock("@/lib/integrations/workspace-integrations", () => ({
  deleteWorkspaceIntegration: vi.fn(),
  findAllWorkspaceIntegrationsByInstallation: vi.fn(),
  findSlackIntegrationByConnectionId: mocks.findSlackIntegrationByConnectionId,
  findSlackIntegrationByTeamId: mocks.findSlackIntegrationByTeamId,
  findWorkspaceIntegrationByConnection:
    mocks.findWorkspaceIntegrationByConnection,
  findWorkspaceIntegrationByInstallation: vi.fn(),
  findWorkspaceIntegrationByProviderAliasAndConnection: vi.fn(),
  getRecentWorkspaceIntegrationDisconnect: vi.fn(),
  insertWorkspaceIntegrationIfAbsent: vi.fn(),
  recordWorkspaceIntegrationDisconnect: vi.fn(),
  replaceWorkspaceIntegrationConnectionIfStale: vi.fn(),
  updateWorkspaceIntegrationMetadata: vi.fn(),
  upsertWorkspaceIntegration: mocks.upsertWorkspaceIntegration,
}));

vi.mock("@/lib/proactive-runtime/integration-watch-dispatcher", () => ({
  dispatchIntegrationWatchEvent: mocks.dispatchIntegrationWatchEvent,
}));

vi.mock("@/lib/ricky/slack/ingress", () => ({
  handleRickySlackForward: vi.fn(),
}));

vi.mock("@/lib/ricky/webhook-dedup", () => ({
  claimWebhookDelivery: mocks.claimWebhookDelivery,
  releaseWebhookDelivery: mocks.releaseWebhookDelivery,
}));

vi.mock("@/lib/integrations/slack-relay-bridge/bridge", () => ({
  forwardSlackToRelay: mocks.forwardSlackToRelay,
}));

vi.mock("@/lib/integrations/slack-relay-bridge/relaycast", () => ({
  createRelaycastPoster: vi.fn(() => ({ mocked: "poster" })),
}));

vi.mock("@/lib/integrations/slack-relay-bridge/store", () => ({
  createSlackRelayBridgeStore: vi.fn(() => ({ mocked: "store" })),
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    error: mocks.loggerError,
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
  },
}));

describe("Slack Relayfile forward routing", () => {
  const cloudflareContextSymbol = Symbol.for("__cloudflare-context__");

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete (globalThis as Record<symbol, unknown>)[cloudflareContextSymbol];
    mocks.findWorkspaceIntegrationByConnection.mockImplementation(
      async (provider: string, connectionId: string) =>
        provider === "slack" && connectionId === "conn-slack-1"
          ? {
              workspaceId: "rw_slack_1",
              connectionId: "conn-slack-1",
              provider: "slack",
              providerConfigKey: "slack-relay",
              metadata: {},
            }
          : null,
    );
    mocks.findSlackIntegrationByConnectionId.mockResolvedValue(null);
    mocks.findSlackIntegrationByTeamId.mockResolvedValue(null);
    mocks.resolveAppWorkspaceIdForRuntime.mockImplementation(async (workspaceId: string) => workspaceId);
    mocks.writeBatchToRelayfile.mockResolvedValue({
      written: 1,
      deleted: 0,
      errors: 0,
    });
    mocks.writeFile.mockResolvedValue({ revision: "rev-1" });
    mocks.resolveRelayfileCredentialWorkspaceId.mockImplementation(async (workspaceId: string) => workspaceId);
    mocks.dbExecute.mockResolvedValue({ rows: [] });
    mocks.dispatchIntegrationWatchEvent.mockResolvedValue({
      matched: 0,
      delivered: 0,
      failed: 0,
    });
    mocks.forwardSlackToRelay.mockResolvedValue({ status: "skipped", reason: "unit-test" });
    mocks.claimWebhookDelivery.mockResolvedValue(true);
    mocks.releaseWebhookDelivery.mockResolvedValue(undefined);
    mocks.upsertWorkspaceIntegration.mockResolvedValue(undefined);
    mocks.nangoProxy.mockImplementation(async (input?: { params?: { channel?: string } }) => {
      const channel = input?.params?.channel;
      if (channel && !channel.startsWith("D")) {
        return {
          status: 200,
          data: {
            ok: true,
            channel: {
              id: channel,
              name: "fallback-channel",
            },
          },
        };
      }
      return { status: 200, data: {} };
    });
    mocks.relayfileReadFile.mockResolvedValue(null);
  });

  it("suppresses duplicate Slack forward redeliveries (same channel+ts): one write, agent wakes once", async () => {
    // Regression for the duplicate-jokes bug: Nango/Hookdeck redeliver the same
    // forward, and without an idempotency claim each redelivery does a fresh
    // write + integration-watch enqueue → the agent runs N times.
    mocks.claimWebhookDelivery
      .mockResolvedValueOnce(true) // first delivery wins the claim
      .mockResolvedValueOnce(false); // redelivery already claimed → suppressed

    const { routeNangoWebhook } = await import("./nango-webhook-router");
    const envelope = {
      from: "slack" as const,
      type: "forward" as const,
      providerConfigKey: "",
      connectionId: "conn-slack-1",
      payload: {
        team_id: "T123",
        event: {
          type: "app_mention",
          channel: "C123",
          ts: "1711111000.000999",
          event_ts: "1711111000.000999",
          text: "<@U0B2596R7EZ> tell me a joke",
          user: "U234",
        },
      },
    };

    await routeNangoWebhook(envelope);
    await routeNangoWebhook(envelope);

    // Both forwards attempt a claim, keyed on surface=slack + (workspace, channel, ts, thread).
    expect(mocks.claimWebhookDelivery).toHaveBeenCalledTimes(2);
    const claimArg = mocks.claimWebhookDelivery.mock.calls[0]![0] as {
      surface: string;
      deliveryId: string;
    };
    expect(claimArg.surface).toBe("slack");
    expect(claimArg.deliveryId).toContain("C123");
    expect(claimArg.deliveryId).toContain("1711111000.000999");

    // Only the first delivery does the durable work; the redelivery is dropped
    // before the relayfile write, so the agent wakes exactly once.
    expect(mocks.writeBatchToRelayfile).toHaveBeenCalledTimes(1);
  });

  it("does not suppress a later edit for an already-seen ts (distinct dedupe key per Slack event type)", async () => {
    // The dedupe key must distinguish a *redelivery* of the same event from a
    // genuinely new lifecycle event (edit/delete) for the same channel+ts.
    // Model the durable store with a Set so the assertions reflect real claim
    // semantics: a repeated key is suppressed, a new key passes.
    const claimed = new Set<string>();
    mocks.claimWebhookDelivery.mockImplementation(
      async ({ deliveryId }: { deliveryId: string }) => {
        if (claimed.has(deliveryId)) return false;
        claimed.add(deliveryId);
        return true;
      },
    );

    const { routeNangoWebhook } = await import("./nango-webhook-router");
    const channel = "C123";
    const ts = "1711111000.000999";
    const mention = {
      from: "slack" as const,
      type: "forward" as const,
      providerConfigKey: "",
      connectionId: "conn-slack-1",
      payload: {
        team_id: "T123",
        event: {
          type: "app_mention",
          channel,
          ts,
          event_ts: ts,
          text: "<@U0B2596R7EZ> tell me a joke",
          user: "U234",
        },
      },
    };

    // Original mention + an exact redelivery (suppressed) + a real edit of the
    // same message (same ts, eventType message.updated) which MUST pass through.
    await routeNangoWebhook(mention);
    await routeNangoWebhook(mention);
    await routeNangoWebhook({
      from: "slack",
      type: "forward",
      providerConfigKey: "",
      connectionId: "conn-slack-1",
      payload: {
        team_id: "T123",
        event: {
          type: "message",
          subtype: "message_changed",
          channel,
          ts,
          message: { channel, ts, text: "<@U0B2596R7EZ> tell me a joke (edited)", user: "U234" },
        },
      },
    });

    expect(mocks.claimWebhookDelivery).toHaveBeenCalledTimes(3);
    // The mention and its edit produce different claim keys, so both win a claim
    // and write; only the exact redelivery of the mention is suppressed.
    const keys = mocks.claimWebhookDelivery.mock.calls.map(
      ([arg]) => (arg as { deliveryId: string }).deliveryId,
    );
    expect(keys[0]).toBe(keys[1]); // redelivery → identical key → suppressed
    expect(keys[2]).not.toBe(keys[0]); // edit → distinct key → passes
    expect(mocks.writeBatchToRelayfile).toHaveBeenCalledTimes(2);
  });

  it("does not re-enqueue the RECALL thread-reply wake on a suppressed redelivery", async () => {
    // Devin finding: the dedupe claim must guard the human-thread-reply side
    // effects (reaction + note write + RECALL agent wake) too — not only the
    // later relayfile write — or a redelivery wakes the RECALL agent twice.
    mocks.claimWebhookDelivery
      .mockResolvedValueOnce(true) // first delivery wins the claim
      .mockResolvedValueOnce(false); // redelivery already claimed → suppressed
    mocks.resolveAppWorkspaceIdForRuntime.mockResolvedValue("50587328-441d-4acb-b8f3-dbe1b3c5de99");
    mocks.dbExecute.mockResolvedValue({
      rows: [
        {
          input_values: {
            QUESTION_CHANNEL: "CQUESTION123",
            SLACK_CHANNEL: "CDIGEST123",
          },
        },
      ],
    });
    mocks.relayfileReadFile.mockResolvedValue({
      content: `${JSON.stringify([
        {
          id: "CQUESTION123",
          title: "customer-questions",
          updated: "2026-06-12T18:40:00.000Z",
        },
      ])}\n`,
    });
    mocks.nangoProxy.mockImplementation(async (input?: { endpoint?: string; params?: { channel?: string } }) => {
      if (input?.endpoint === "/reactions.add") {
        return { status: 200, data: { ok: true } };
      }
      if (input?.endpoint === "/conversations.replies") {
        return {
          status: 200,
          data: {
            ok: true,
            messages: [
              {
                ts: "1781287713.325259",
                text: [
                  ":brain: *Braindump 2026-06-12* — 1 thing need a human call before they can become tasks:",
                  "",
                  "*1.* Legg til eTulipan-kount-endepunkt med test",
                  "",
                  "Reply here; meeting-actions files the issue once answered. (recording braindump-1781287267188)",
                ].join("\n"),
                user: "U0BOT",
                bot_id: "B0BOT",
              },
              {
                ts: "1781289704.710549",
                thread_ts: "1781287713.325259",
                text: "typescript is fine",
                user: "U0ADJH4P83T",
              },
            ],
          },
        };
      }
      if (input?.params?.channel === "CQUESTION123") {
        return {
          status: 200,
          data: { ok: true, channel: { id: "CQUESTION123", name: "customer-questions" } },
        };
      }
      return { status: 200, data: {} };
    });

    const { routeNangoWebhook } = await import("./nango-webhook-router");
    const threadReply = {
      from: "slack" as const,
      type: "forward" as const,
      providerConfigKey: "slack-relay",
      connectionId: "conn-slack-1",
      payload: {
        team_id: "T0AD97QUZDJ",
        event: {
          type: "message",
          channel: "CQUESTION123",
          channel_type: "channel",
          ts: "1781289704.710549",
          thread_ts: "1781287713.325259",
          text: "typescript is fine",
          user: "U0ADJH4P83T",
        },
        type: "event_callback",
      },
    };

    await routeNangoWebhook(threadReply);
    await routeNangoWebhook(threadReply);

    // The redelivery is suppressed before any side effect, so the RECALL wake,
    // the eyes reaction, and the relayfile write each happen exactly once.
    const recallWakes = mocks.dispatchIntegrationWatchEvent.mock.calls.filter(
      ([input]) => (input as { provider: string }).provider === "recall",
    );
    expect(recallWakes).toHaveLength(1);
    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    expect(mocks.writeBatchToRelayfile).toHaveBeenCalledTimes(1);
    expect(mocks.nangoProxy).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "/reactions.add" }),
    );
    expect(
      mocks.nangoProxy.mock.calls.filter(([input]) => (input as { endpoint?: string })?.endpoint === "/reactions.add"),
    ).toHaveLength(1);
  });

  it("routes Slack forwards without providerConfigKey to Relayfile when the connection is the Slack integration", async () => {
    const { routeNangoWebhook } = await import("./nango-webhook-router");

    await routeNangoWebhook({
      from: "slack",
      type: "forward",
      providerConfigKey: "",
      connectionId: "conn-slack-1",
      payload: {
        team_id: "T123",
        event: {
          type: "app_mention",
          channel: "C123",
          ts: "1711111000.000100",
          event_ts: "1711111000.000100",
          text: "<@U0B2596R7EZ> this is so dangerous",
          user: "U234",
        },
      },
    });

    expect(mocks.writeBatchToRelayfile).toHaveBeenCalledTimes(1);
    const [, records, job] = mocks.writeBatchToRelayfile.mock.calls[0]!;
    expect(records).toEqual([
      expect.objectContaining({
        channel: "C123",
        id: "C123:1711111000.000100",
        text: "<@U0B2596R7EZ> this is so dangerous",
      }),
    ]);
    expect(job).toMatchObject({
      workspaceId: "rw_slack_1",
      connectionId: "conn-slack-1",
      provider: "slack",
      providerConfigKey: "slack-relay",
      syncName: "fetch-channel-history",
      model: "SlackMessage",
    });
    expect(mocks.dispatchIntegrationWatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "rw_slack_1",
        provider: "slack",
        eventType: "app_mention",
        paths: expect.arrayContaining([
          expect.stringMatching(/^\/slack\/channels\/C123/),
        ]),
      }),
    );
    expect(mocks.writeBatchToRelayfile).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Array),
      expect.objectContaining({
        workspaceId: "rw_slack_1",
        connectionId: "conn-slack-1",
        provider: "slack",
        syncName: "fetch-channel-history",
        model: "SlackMessage",
      }),
      expect.objectContaining({ materializeContract: false }),
    );
    expect(
      mocks.writeBatchToRelayfile.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.dispatchIntegrationWatchEvent.mock.invocationCallOrder[0]);
  });

  it("writes Slack event_callback message forwards from Nango's nested Slack payload", async () => {
    const { routeNangoWebhook } = await import("./nango-webhook-router");

    await routeNangoWebhook({
      from: "slack",
      type: "forward",
      providerConfigKey: "slack-relay",
      connectionId: "conn-slack-1",
      payload: {
        context_team_id: "T0AD97QUZDJ",
        event_id: "Ev0B8M9KMB7W",
        authorizations: [
          {
            user_id: "U0B2596R7EZ",
            is_enterprise_install: false,
            team_id: "T0AD97QUZDJ",
            enterprise_id: null,
            is_bot: true,
          },
        ],
        api_app_id: "A0B1M9K2R55",
        team_id: "T0AD97QUZDJ",
        event: {
          client_msg_id: "24bcc1f8-5b93-4c89-8282-849bcc19b7ed",
          event_ts: "1780648879.968049",
          channel: "C0AD7UU0J1G",
          text: "<@U0B2596R7EZ> this...so...dangerous",
          team: "T0AD97QUZDJ",
          type: "message",
          channel_type: "channel",
          user: "U0ADJH4P83T",
          ts: "1780648879.968049",
        },
        type: "event_callback",
        event_context:
          "4-eyJldCI6Im1lc3NhZ2UiLCJ0aWQiOiJUMEFEOTdRVVpESiIsImFpZCI6IkEwQjFNOUsyUjU1IiwiY2lkIjoiQzBBRDdVVTBKMUcifQ",
        is_ext_shared_channel: false,
        context_enterprise_id: null,
        event_time: 1780648879,
        token: "test-token",
      },
    });

    expect(mocks.writeBatchToRelayfile).toHaveBeenCalledTimes(1);
    const [, records, job] = mocks.writeBatchToRelayfile.mock.calls[0]!;
    expect(records).toEqual([
      expect.objectContaining({
        channel: "C0AD7UU0J1G",
        id: "C0AD7UU0J1G:1780648879.968049",
        text: "<@U0B2596R7EZ> this...so...dangerous",
        user: "U0ADJH4P83T",
      }),
    ]);
    expect(job).toMatchObject({
      workspaceId: "rw_slack_1",
      connectionId: "conn-slack-1",
      provider: "slack",
      providerConfigKey: "slack-relay",
      syncName: "fetch-channel-history",
      model: "SlackMessage",
    });
    expect(mocks.dispatchIntegrationWatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "rw_slack_1",
        provider: "slack",
        eventType: "message.created",
        paths: expect.arrayContaining([
          expect.stringMatching(/^\/slack\/channels\/C0AD7UU0J1G/),
        ]),
      }),
    );
  });

  it("attaches the prior Slack channel name before live channel message writes", async () => {
    mocks.relayfileReadFile.mockResolvedValue({
      content: `${JSON.stringify([
        {
          id: "C0B8ZL2L9GC",
          title: "pear-pty-investigation",
          updated: "2026-06-08T08:35:00.000Z",
        },
      ])}\n`,
    });
    const { routeNangoWebhook } = await import("./nango-webhook-router");

    await routeNangoWebhook({
      from: "slack",
      type: "forward",
      providerConfigKey: "slack-relay",
      connectionId: "conn-slack-1",
      payload: {
        team_id: "T0AD97QUZDJ",
        event: {
          type: "message",
          channel: "C0B8ZL2L9GC",
          channel_type: "channel",
          ts: "1780921813.531539",
          thread_ts: "1780871788.370329",
          text: "live thread reply",
          user: "U0ADJH4P83T",
        },
        type: "event_callback",
      },
    });

    expect(mocks.writeBatchToRelayfile).toHaveBeenCalledTimes(1);
    const [, records] = mocks.writeBatchToRelayfile.mock.calls[0]!;
    expect(records).toEqual([
      expect.objectContaining({
        channel: "C0B8ZL2L9GC",
        channelName: "pear-pty-investigation",
        ts: "1780921813.531539",
        thread_ts: "1780871788.370329",
      }),
    ]);
    expect(mocks.dispatchIntegrationWatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        paths: [
          "/slack/channels/C0B8ZL2L9GC__pear-pty-investigation/threads/1780871788_370329/replies/1780921813_531539/meta.json",
          "/slack/channels/C0B8ZL2L9GC__pear-pty-investigation/messages/1780871788_370329/replies/**",
        ],
      }),
    );
  });

  it("reacts with eyes to configured meeting-actions question thread replies before routing the event", async () => {
    mocks.resolveAppWorkspaceIdForRuntime.mockResolvedValue("50587328-441d-4acb-b8f3-dbe1b3c5de99");
    mocks.dbExecute.mockResolvedValue({
      rows: [
        {
          input_values: {
            QUESTION_CHANNEL: "CQUESTION123",
            SLACK_CHANNEL: "CDIGEST123",
          },
        },
      ],
    });
    mocks.relayfileReadFile.mockResolvedValue({
      content: `${JSON.stringify([
        {
          id: "CQUESTION123",
          title: "customer-questions",
          updated: "2026-06-12T18:40:00.000Z",
        },
      ])}\n`,
    });
    mocks.nangoProxy.mockImplementation(async (input?: { endpoint?: string; params?: { channel?: string; ts?: string } }) => {
      if (input?.endpoint === "/reactions.add") {
        return { status: 200, data: { ok: true } };
      }
      if (input?.endpoint === "/conversations.replies") {
        return {
          status: 200,
          data: {
            ok: true,
            messages: [
              {
                ts: "1781287713.325259",
                text: [
                  ":brain: *Braindump 2026-06-12* — 1 thing need a human call before they can become tasks:",
                  "",
                  "*1.* Legg til eTulipan-kount-endepunkt med test",
                  "",
                  "Reply here; meeting-actions files the issue once answered. (recording braindump-1781287267188)",
                ].join("\n"),
                user: "U0BOT",
                bot_id: "B0BOT",
              },
              {
                ts: "1781289704.710549",
                thread_ts: "1781287713.325259",
                text: "typescript is fine",
                user: "U0ADJH4P83T",
              },
            ],
          },
        };
      }
      if (input?.params?.channel === "CQUESTION123") {
        return {
          status: 200,
          data: {
            ok: true,
            channel: {
              id: "CQUESTION123",
              name: "customer-questions",
            },
          },
        };
      }
      return { status: 200, data: {} };
    });
    const { routeNangoWebhook } = await import("./nango-webhook-router");

    await routeNangoWebhook({
      from: "slack",
      type: "forward",
      providerConfigKey: "slack-relay",
      connectionId: "conn-slack-1",
      payload: {
        team_id: "T0AD97QUZDJ",
        event: {
          type: "message",
          channel: "CQUESTION123",
          channel_type: "channel",
          ts: "1781289704.710549",
          thread_ts: "1781287713.325259",
          text: "typescript is fine",
          user: "U0ADJH4P83T",
        },
        type: "event_callback",
      },
    });

    expect(mocks.nangoProxy).toHaveBeenCalledWith(expect.objectContaining({
      method: "POST",
      endpoint: "/reactions.add",
      connectionId: "conn-slack-1",
      providerConfigKey: "slack-relay",
      data: {
        channel: "CQUESTION123",
        timestamp: "1781289704.710549",
        name: "eyes",
      },
    }));
    expect(mocks.resolveAppWorkspaceIdForRuntime).toHaveBeenCalledWith("rw_slack_1");
    expect(mocks.writeBatchToRelayfile).toHaveBeenCalledTimes(1);
    expect(mocks.writeFile).toHaveBeenCalledWith({
      workspaceId: "rw_slack_1",
      path: "/recall/recordings/thread-reply-braindump-1781287267188-1781289704-710549.json",
      baseRevision: "*",
      content: expect.stringContaining('"type": "thread_reply"'),
      contentType: "application/json",
      encoding: "utf-8",
    });
    const written = JSON.parse((mocks.writeFile.mock.calls[0]?.[0] as { content: string }).content) as Record<string, unknown>;
    expect(written).toMatchObject({
      type: "thread_reply",
      recording_id: "braindump-1781287267188",
      question_message_ts: "1781287713.325259",
      channel: "CQUESTION123",
      thread_ts: "1781287713.325259",
      answer_text: "typescript is fine",
      answer_user: "U0ADJH4P83T",
      answer_ts: "1781289704.710549",
    });
    expect(String(written.question_text)).toContain("Reply here; meeting-actions files the issue once answered.");
    expect(mocks.dispatchIntegrationWatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "rw_slack_1",
        provider: "recall",
        eventType: "recording.changed",
        connectionId: "rw_slack_1",
        paths: [
          "/recall/recordings/thread-reply-braindump-1781287267188-1781289704-710549.json",
        ],
        payload: expect.objectContaining({
          type: "thread_reply",
          recording_id: "braindump-1781287267188",
          answer_text: "typescript is fine",
        }),
      }),
    );
    expect(mocks.dispatchIntegrationWatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "slack",
        eventType: "message.created",
        paths: [
          "/slack/channels/CQUESTION123__customer-questions/threads/1781287713_325259/replies/1781289704_710549/meta.json",
          "/slack/channels/CQUESTION123__customer-questions/messages/1781287713_325259/replies/**",
        ],
      }),
    );
    expect(
      mocks.nangoProxy.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.writeBatchToRelayfile.mock.invocationCallOrder[0] ?? 0);
    expect(
      mocks.nangoProxy.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.writeFile.mock.invocationCallOrder[0] ?? 0);
    const slackWatchCall = mocks.dispatchIntegrationWatchEvent.mock.calls.findIndex(([input]) =>
      input.provider === "slack"
    );
    expect(slackWatchCall).toBeGreaterThanOrEqual(0);
    expect(
      mocks.nangoProxy.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.dispatchIntegrationWatchEvent.mock.invocationCallOrder[slackWatchCall] ?? 0);
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "Slack thread reply reaction added",
      expect.objectContaining({
        area: "nango-webhook",
        channel: "CQUESTION123",
        ts: "1781289704.710549",
        threadTs: "1781287713.325259",
        reaction: "eyes",
      }),
    );
  });

  it("does not react to Slack thread replies outside configured agent question channels", async () => {
    mocks.dbExecute.mockResolvedValue({
      rows: [
        {
          input_values: {
            QUESTION_CHANNEL: "CQUESTION123",
            SLACK_CHANNEL: "CDIGEST123",
          },
        },
      ],
    });
    mocks.relayfileReadFile.mockResolvedValue({
      content: `${JSON.stringify([
        {
          id: "C0OTHER123",
          title: "other-channel",
          updated: "2026-06-12T18:40:00.000Z",
        },
      ])}\n`,
    });
    const { routeNangoWebhook } = await import("./nango-webhook-router");

    await routeNangoWebhook({
      from: "slack",
      type: "forward",
      providerConfigKey: "slack-relay",
      connectionId: "conn-slack-1",
      payload: {
        team_id: "T0AD97QUZDJ",
        event: {
          type: "message",
          channel: "C0OTHER123",
          channel_type: "channel",
          ts: "1781289704.710549",
          thread_ts: "1781287713.325259",
          text: "typescript is fine",
          user: "U0ADJH4P83T",
        },
        type: "event_callback",
      },
    });

    expect(mocks.nangoProxy).not.toHaveBeenCalledWith(expect.objectContaining({
      endpoint: "/reactions.add",
    }));
    expect(mocks.writeBatchToRelayfile).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchIntegrationWatchEvent).toHaveBeenCalledTimes(1);
  });

  it("does not react or write thread notes when no active meeting-actions channel is configured", async () => {
    mocks.dbExecute.mockResolvedValue({ rows: [] });
    mocks.relayfileReadFile.mockResolvedValue({
      content: `${JSON.stringify([
        {
          id: "CQUESTION123",
          title: "customer-questions",
          updated: "2026-06-12T18:40:00.000Z",
        },
      ])}\n`,
    });
    const { routeNangoWebhook } = await import("./nango-webhook-router");

    await routeNangoWebhook({
      from: "slack",
      type: "forward",
      providerConfigKey: "slack-relay",
      connectionId: "conn-slack-1",
      payload: {
        team_id: "T0AD97QUZDJ",
        event: {
          type: "message",
          channel: "CQUESTION123",
          channel_type: "channel",
          ts: "1781289704.710549",
          thread_ts: "1781287713.325259",
          text: "typescript is fine",
          user: "U0ADJH4P83T",
        },
        type: "event_callback",
      },
    });

    expect(mocks.nangoProxy).not.toHaveBeenCalledWith(expect.objectContaining({
      endpoint: "/reactions.add",
    }));
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(mocks.writeBatchToRelayfile).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchIntegrationWatchEvent).toHaveBeenCalledTimes(1);
  });

  it("fails closed when meeting-actions channel lookup is unavailable", async () => {
    mocks.dbExecute.mockRejectedValue(new Error("No Postgres connection string configured"));
    mocks.relayfileReadFile.mockResolvedValue({
      content: `${JSON.stringify([
        {
          id: "CQUESTION123",
          title: "customer-questions",
          updated: "2026-06-12T18:40:00.000Z",
        },
      ])}\n`,
    });
    const { routeNangoWebhook } = await import("./nango-webhook-router");

    await routeNangoWebhook({
      from: "slack",
      type: "forward",
      providerConfigKey: "slack-relay",
      connectionId: "conn-slack-1",
      payload: {
        team_id: "T0AD97QUZDJ",
        event: {
          type: "message",
          channel: "CQUESTION123",
          channel_type: "channel",
          ts: "1781289704.710549",
          thread_ts: "1781287713.325259",
          text: "typescript is fine",
          user: "U0ADJH4P83T",
        },
        type: "event_callback",
      },
    });

    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      "Slack thread reply question channel lookup failed",
      expect.objectContaining({
        workspaceId: "rw_slack_1",
        error: "No Postgres connection string configured",
      }),
    );
    expect(mocks.nangoProxy).not.toHaveBeenCalledWith(expect.objectContaining({
      endpoint: "/reactions.add",
    }));
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(mocks.writeBatchToRelayfile).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchIntegrationWatchEvent).toHaveBeenCalledTimes(1);
  });

  it("falls back to Slack conversations.info when the channel index lacks a live channel message name", async () => {
    mocks.relayfileReadFile.mockResolvedValue(null);
    mocks.nangoProxy.mockResolvedValue({
      status: 200,
      data: {
        ok: true,
        channel: {
          id: "C0B8ZL2L9GC",
          name: "pear-pty-investigation",
        },
      },
    });
    const { routeNangoWebhook } = await import("./nango-webhook-router");

    await routeNangoWebhook({
      from: "slack",
      type: "forward",
      providerConfigKey: "slack-relay",
      connectionId: "conn-slack-1",
      payload: {
        team_id: "T0AD97QUZDJ",
        event: {
          type: "message",
          channel: "C0B8ZL2L9GC",
          channel_type: "channel",
          ts: "1780930616.003639",
          thread_ts: "1780871788.370329",
          text: "hi",
          user: "U0ADJH4P83T",
        },
        type: "event_callback",
      },
    });

    expect(mocks.nangoProxy).toHaveBeenCalledWith(expect.objectContaining({
      method: "GET",
      endpoint: "/conversations.info",
      connectionId: "conn-slack-1",
      providerConfigKey: "slack-relay",
      params: { channel: "C0B8ZL2L9GC" },
    }));
    expect(mocks.writeBatchToRelayfile).toHaveBeenCalledTimes(1);
    const [, records] = mocks.writeBatchToRelayfile.mock.calls[0]!;
    expect(records).toEqual([
      expect.objectContaining({
        channel: "C0B8ZL2L9GC",
        channelName: "pear-pty-investigation",
        ts: "1780930616.003639",
        thread_ts: "1780871788.370329",
      }),
    ]);
    expect(mocks.dispatchIntegrationWatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        paths: [
          "/slack/channels/C0B8ZL2L9GC__pear-pty-investigation/threads/1780871788_370329/replies/1780930616_003639/meta.json",
          "/slack/channels/C0B8ZL2L9GC__pear-pty-investigation/messages/1780871788_370329/replies/**",
        ],
      }),
    );
  });

  it("skips live channel message writes when no channel name can be resolved", async () => {
    mocks.relayfileReadFile.mockResolvedValue(null);
    mocks.nangoProxy.mockResolvedValue({
      status: 200,
      data: {
        ok: true,
        channel: {
          id: "C0B8ZL2L9GC",
        },
      },
    });
    const { routeNangoWebhook } = await import("./nango-webhook-router");

    await routeNangoWebhook({
      from: "slack",
      type: "forward",
      providerConfigKey: "slack-relay",
      connectionId: "conn-slack-1",
      payload: {
        team_id: "T0AD97QUZDJ",
        event: {
          type: "message",
          channel: "C0B8ZL2L9GC",
          channel_type: "channel",
          ts: "1780930616.003639",
          thread_ts: "1780871788.370329",
          text: "hi",
          user: "U0ADJH4P83T",
        },
        type: "event_callback",
      },
    });
    await routeNangoWebhook({
      from: "slack",
      type: "forward",
      providerConfigKey: "slack-relay",
      connectionId: "conn-slack-1",
      payload: {
        team_id: "T0AD97QUZDJ",
        event: {
          type: "message",
          channel: "C0B8ZL2L9GC",
          channel_type: "channel",
          ts: "1780930617.003639",
          thread_ts: "1780871788.370329",
          text: "hi again",
          user: "U0ADJH4P83T",
        },
        type: "event_callback",
      },
    });

    expect(mocks.nangoProxy).toHaveBeenCalledTimes(2);
    expect(mocks.writeBatchToRelayfile).not.toHaveBeenCalled();
    expect(mocks.dispatchIntegrationWatchEvent).not.toHaveBeenCalled();
    expect(mocks.forwardSlackToRelay).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      "Slack relayfile forward missing channel name; skipped write to avoid bare Slack channel path",
      expect.objectContaining({
        area: "nango-webhook",
        workspaceId: "rw_slack_1",
        connectionId: "conn-slack-1",
        providerConfigKey: "slack-relay",
        channelId: "C0B8ZL2L9GC",
        ts: "1780930616.003639",
        threadTs: "1780871788.370329",
        eventType: "message.created",
      }),
    );
  });

  it("skips live channel message writes when channel name resolution fails", async () => {
    mocks.relayfileReadFile.mockResolvedValue(null);
    mocks.nangoProxy.mockRejectedValue(new Error("nango unavailable"));
    const { routeNangoWebhook } = await import("./nango-webhook-router");

    await routeNangoWebhook({
      from: "slack",
      type: "forward",
      providerConfigKey: "slack-relay",
      connectionId: "conn-slack-1",
      payload: {
        team_id: "T0AD97QUZDJ",
        event: {
          type: "message",
          channel: "C0B8ZL2L9GC",
          channel_type: "channel",
          ts: "1780930616.003639",
          thread_ts: "1780871788.370329",
          text: "hi",
          user: "U0ADJH4P83T",
        },
        type: "event_callback",
      },
    });

    expect(mocks.writeBatchToRelayfile).not.toHaveBeenCalled();
    expect(mocks.dispatchIntegrationWatchEvent).not.toHaveBeenCalled();
    expect(mocks.forwardSlackToRelay).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      "Slack channel name resolution failed; preserving no-bare write guard",
      expect.objectContaining({
        area: "nango-webhook",
        connectionId: "conn-slack-1",
        providerConfigKey: "slack-relay",
        channelId: "C0B8ZL2L9GC",
        error: "nango unavailable",
      }),
    );
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      "Slack relayfile forward missing channel name; skipped write to avoid bare Slack channel path",
      expect.objectContaining({
        area: "nango-webhook",
        workspaceId: "rw_slack_1",
        connectionId: "conn-slack-1",
        providerConfigKey: "slack-relay",
        channelId: "C0B8ZL2L9GC",
        ts: "1780930616.003639",
        threadTs: "1780871788.370329",
        eventType: "message.created",
      }),
    );
  });

  it("routes resolved Slack IM forwards to the canonical user-message path while preserving the flat record shape", async () => {
    mocks.nangoProxy.mockResolvedValue({
      status: 200,
      data: {
        ok: true,
        channel: {
          id: "D0B2MHP6E3T",
          is_im: true,
          user: "U0DMRECIPIENT",
        },
      },
    });
    const { routeNangoWebhook } = await import("./nango-webhook-router");

    await routeNangoWebhook({
      from: "slack",
      type: "forward",
      providerConfigKey: "slack-relay",
      connectionId: "conn-slack-1",
      payload: {
        team_id: "T0AD97QUZDJ",
        event: {
          type: "message",
          channel: "D0B2MHP6E3T",
          channel_type: "im",
          ts: "1780893132.131989",
          event_ts: "1780893132.131989",
          thread_ts: "1780893000.000100",
          text: "canonical dm",
          user: "U0AUTHOR",
        },
        type: "event_callback",
      },
    });

    expect(mocks.nangoProxy).toHaveBeenCalledWith(expect.objectContaining({
      method: "GET",
      endpoint: "/conversations.info",
      connectionId: "conn-slack-1",
      providerConfigKey: "slack-relay",
      params: { channel: "D0B2MHP6E3T" },
    }));
    const [, records] = mocks.writeBatchToRelayfile.mock.calls[0]!;
    expect(records).toEqual([
      expect.objectContaining({
        channel: "D0B2MHP6E3T",
        channel_type: "im",
        dm_user_id: "U0DMRECIPIENT",
        source_channel_id: "D0B2MHP6E3T",
        text: "canonical dm",
        user: "U0AUTHOR",
        thread_ts: "1780893000.000100",
      }),
    ]);
    expect(records[0]).not.toHaveProperty("payload");
    expect(mocks.dispatchIntegrationWatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        paths: [
          "/slack/users/U0DMRECIPIENT/messages/1780893000_000100/replies/1780893132_131989/meta.json",
          "/slack/users/U0DMRECIPIENT/messages/1780893000_000100/replies/**",
        ],
        payload: expect.objectContaining({
          text: "canonical dm",
          user: "U0AUTHOR",
          thread_ts: "1780893000.000100",
        }),
      }),
    );
    const eventPayload = mocks.dispatchIntegrationWatchEvent.mock.calls[0]![0] as { paths: string[] };
    expect(eventPayload.paths.some((path) => path.startsWith("/slack/channels/D0B2MHP6E3T/"))).toBe(false);
  });

  it("falls back to raw D-channel paths when Slack IM user resolution is unavailable", async () => {
    mocks.nangoProxy.mockResolvedValue({
      status: 200,
      data: { ok: false, error: "channel_not_found" },
    });
    const { routeNangoWebhook } = await import("./nango-webhook-router");

    await routeNangoWebhook({
      from: "slack",
      type: "forward",
      providerConfigKey: "slack-relay",
      connectionId: "conn-slack-1",
      payload: {
        team_id: "T0AD97QUZDJ",
        event: {
          type: "message",
          channel: "D0B2MHP6E3T",
          channel_type: "im",
          ts: "1780893132.131989",
          event_ts: "1780893132.131989",
          text: "diagnostic fallback",
          user: "U0AUTHOR",
        },
        type: "event_callback",
      },
    });

    const [, records] = mocks.writeBatchToRelayfile.mock.calls[0]!;
    expect(records).toEqual([
      expect.not.objectContaining({
        dm_user_id: expect.anything(),
      }),
    ]);
    expect(mocks.dispatchIntegrationWatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        paths: [
          "/slack/channels/D0B2MHP6E3T/messages/1780893132_131989/meta.json",
        ],
      }),
    );
  });

  it("writes and dispatches Slack forwards against the bound Relayfile workspace", async () => {
    mocks.findWorkspaceIntegrationByConnection.mockResolvedValue({
      workspaceId: "50587328-441d-4acb-b8f3-dbe1b3c5de99",
      connectionId: "conn-slack-1",
      provider: "slack",
      providerConfigKey: "slack-relay",
      metadata: {},
    });
    mocks.resolveRelayfileCredentialWorkspaceId.mockResolvedValue("rw_7ccfea89");
    const { routeNangoWebhook } = await import("./nango-webhook-router");

    await routeNangoWebhook({
      from: "slack",
      type: "forward",
      providerConfigKey: "slack-relay",
      connectionId: "conn-slack-1",
      payload: {
        team_id: "T0AD97QUZDJ",
        event: {
          event_ts: "1780648879.968049",
          channel: "C0AD7UU0J1G",
          text: "<@U0B2596R7EZ> this...so...dangerous",
          type: "message",
          user: "U0ADJH4P83T",
          ts: "1780648879.968049",
        },
        type: "event_callback",
      },
    });

    expect(mocks.resolveRelayfileCredentialWorkspaceId).toHaveBeenCalledWith(
      "50587328-441d-4acb-b8f3-dbe1b3c5de99",
    );
    expect(mocks.createGitHubRelayfileClient).toHaveBeenCalledWith("rw_7ccfea89");
    const [, , job] = mocks.writeBatchToRelayfile.mock.calls[0]!;
    expect(job).toMatchObject({ workspaceId: "rw_7ccfea89" });
    expect(mocks.dispatchIntegrationWatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "rw_7ccfea89",
        provider: "slack",
        eventType: "message.created",
      }),
    );
  });

  it("schedules Slack Relay bridge fanout with waitUntil after the watched write is enqueued", async () => {
    const waitUntilPromises: Promise<unknown>[] = [];
    const waitUntil = vi.fn((promise: Promise<unknown>) => {
      waitUntilPromises.push(promise);
    });
    (globalThis as Record<symbol, unknown>)[cloudflareContextSymbol] = { waitUntil };
    let resolveBridge!: (value: { status: string }) => void;
    mocks.forwardSlackToRelay.mockImplementation(
      () => new Promise((resolve) => {
        resolveBridge = resolve;
      }),
    );
    const { routeNangoWebhook } = await import("./nango-webhook-router");

    await routeNangoWebhook({
      from: "slack",
      type: "forward",
      providerConfigKey: "slack-relay",
      connectionId: "conn-slack-1",
      payload: {
        team_id: "T0AD97QUZDJ",
        event: {
          event_ts: "1780648879.968049",
          channel: "C0AD7UU0J1G",
          text: "bridge me",
          type: "message",
          user: "U0ADJH4P83T",
          ts: "1780648879.968049",
        },
        type: "event_callback",
      },
    });

    expect(mocks.writeBatchToRelayfile).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchIntegrationWatchEvent).toHaveBeenCalledTimes(1);
    expect(
      mocks.writeBatchToRelayfile.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.dispatchIntegrationWatchEvent.mock.invocationCallOrder[0]);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(waitUntilPromises).toHaveLength(1);
    expect(mocks.forwardSlackToRelay).toHaveBeenCalledTimes(1);

    resolveBridge({ status: "sent" });
    await waitUntilPromises[0];
    expect(mocks.loggerError).not.toHaveBeenCalledWith(
      "Slack relay bridge background failed",
      expect.anything(),
    );
  });

  it("logs Slack Relay bridge waitUntil failures without rejecting the Nango route", async () => {
    const waitUntilPromises: Promise<unknown>[] = [];
    const waitUntil = vi.fn((promise: Promise<unknown>) => {
      waitUntilPromises.push(promise);
    });
    (globalThis as Record<symbol, unknown>)[cloudflareContextSymbol] = { waitUntil };
    mocks.forwardSlackToRelay.mockRejectedValue(new Error("relay bridge unavailable"));
    const { routeNangoWebhook } = await import("./nango-webhook-router");

    await expect(routeNangoWebhook({
      from: "slack",
      type: "forward",
      providerConfigKey: "slack-relay",
      connectionId: "conn-slack-1",
      payload: {
        team_id: "T0AD97QUZDJ",
        event: {
          event_ts: "1780648879.968049",
          channel: "C0AD7UU0J1G",
          text: "bridge failure should not retry nango",
          type: "message",
          user: "U0ADJH4P83T",
          ts: "1780648879.968049",
        },
        type: "event_callback",
      },
    })).resolves.toBeUndefined();

    expect(waitUntil).toHaveBeenCalledTimes(1);
    await waitUntilPromises[0];
    expect(mocks.loggerError).toHaveBeenCalledWith(
      "Slack relay bridge background failed",
      expect.objectContaining({
        area: "nango-webhook",
        workspaceId: "rw_slack_1",
        connectionId: "conn-slack-1",
        channel: "C0AD7UU0J1G",
        ts: "1780648879.968049",
        error: "relay bridge unavailable",
      }),
    );
  });
});
