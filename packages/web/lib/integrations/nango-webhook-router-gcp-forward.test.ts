import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dispatchIntegrationWatchEvent: vi.fn(),
  findWorkspaceIntegrationByConnection: vi.fn(),
  getNangoConnectionDetails: vi.fn(),
  getNangoSecretKey: vi.fn(),
  getProviderConfigKey: vi.fn(),
  loggerError: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  triggerNangoSyncs: vi.fn(),
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
  writeProviderReadiness: vi.fn(),
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
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
  },
}));

describe("GCP forward webhooks", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    mocks.findWorkspaceIntegrationByConnection.mockResolvedValue({
      workspaceId: "rw_fc7b534b",
      connectionId: "conn-gcp-1",
      providerConfigKey: "gcp-relay",
    });
    mocks.getNangoConnectionDetails.mockResolvedValue(null);
    mocks.getNangoSecretKey.mockReturnValue("nango-secret");
    mocks.getProviderConfigKey.mockReturnValue("gcp-relay");
    mocks.triggerNangoSyncs.mockResolvedValue({
      ok: true,
    });
    mocks.writeBatchToRelayfile.mockResolvedValue({
      written: 1,
      deleted: 0,
      errors: 0,
    });
    mocks.dispatchIntegrationWatchEvent.mockResolvedValue({
      matched: 0,
      delivered: 0,
      failed: 0,
    });
  });

  it("materializes monitoring alert files via writeBatchToRelayfile", async () => {
    const payload = {
      incident: {
        policy_name:
          "projects/nightcto-production/alertPolicies/17163008471956214188",
        condition_name: "relay-entrypoint ERROR logs",
        resource_name:
          "projects/nightcto-production/services/nightcto-production-relay-entrypoint",
        state: "open",
        started_at: 1781681184,
      },
    };
    const { routeNangoWebhook } = await import("./nango-webhook-router");

    await routeNangoWebhook({
      from: "gcp",
      type: "forward",
      providerConfigKey: "gcp-relay",
      connectionId: "conn-gcp-1",
      payload,
    });

    expect(mocks.findWorkspaceIntegrationByConnection).toHaveBeenCalledWith(
      "gcp",
      "conn-gcp-1",
    );
    expect(mocks.writeBatchToRelayfile).toHaveBeenCalledTimes(1);
    expect(mocks.triggerNangoSyncs).not.toHaveBeenCalled();
    expect(mocks.writeBatchToRelayfile).toHaveBeenCalledWith(
      expect.anything(),
      [
        expect.objectContaining({
          id: "17163008471956214188",
          policyId: "17163008471956214188",
          firing: true,
          state: "open",
        }),
      ],
      expect.objectContaining({
        provider: "gcp",
        syncName: "fetch-monitoring-alerts",
        model: "GcpMonitoringAlert",
      }),
    );
    expect(mocks.dispatchIntegrationWatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "rw_fc7b534b",
        provider: "gcp",
        eventType: "monitoring.incident.open",
        connectionId: "conn-gcp-1",
        paths: ["/gcp/monitoring/alerts/17163008471956214188.json"],
      }),
    );
    expect(
      mocks.dispatchIntegrationWatchEvent.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.writeBatchToRelayfile.mock.invocationCallOrder[0]);
  });

  it("preserves terminal state on closed incidents instead of deleting the canonical record", async () => {
    const payload = {
      incident: {
        policy_name:
          "projects/nightcto-production/alertPolicies/17163008471956214188",
        condition_name: "relay-entrypoint ERROR logs",
        state: "closed",
        ended_at: 1781681284,
      },
    };
    const { routeNangoWebhook } = await import("./nango-webhook-router");

    await routeNangoWebhook({
      from: "gcp",
      type: "forward",
      providerConfigKey: "gcp-relay",
      connectionId: "conn-gcp-1",
      payload,
    });

    expect(mocks.writeBatchToRelayfile).toHaveBeenCalledWith(
      expect.anything(),
      [
        expect.objectContaining({
          id: "17163008471956214188",
          firing: false,
          state: "closed",
        }),
      ],
      expect.objectContaining({
        provider: "gcp",
        model: "GcpMonitoringAlert",
      }),
    );
    expect(mocks.writeBatchToRelayfile.mock.calls[0][1][0]).not.toHaveProperty(
      "_deleted",
    );
  });

  it("triggers fetch-cloud-run for Cloud Run audit webhooks instead of direct writes", async () => {
    const { routeNangoWebhook } = await import("./nango-webhook-router");

    await routeNangoWebhook({
      from: "gcp",
      type: "forward",
      providerConfigKey: "gcp-relay",
      connectionId: "conn-gcp-1",
      payload: {
        protoPayload: {
          serviceName: "run.googleapis.com",
          methodName: "google.cloud.run.v2.Services.UpdateService",
          resourceName: "projects/nightcto-production/locations/us-central1/services/nightcto-production-api",
        },
        resource: {
          type: "cloud_run_revision",
          labels: {
            service_name: "nightcto-production-api",
            location: "us-central1",
          },
        },
      },
    });

    expect(mocks.writeBatchToRelayfile).not.toHaveBeenCalled();
    expect(mocks.triggerNangoSyncs).toHaveBeenCalledWith({
      providerConfigKey: "gcp-relay",
      connectionId: "conn-gcp-1",
      syncs: ["fetch-cloud-run"],
    });
    expect(mocks.dispatchIntegrationWatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "cloud-run.service.updated",
        paths: ["/gcp/run/services/nightcto-production-api.json"],
      }),
    );
  });

  it("triggers fetch-billing for budget Pub/Sub notifications", async () => {
    const payload = {
      message: {
        attributes: {
          billingAccountId: "019B2B-F97F32-2169DE",
          budgetId: "budget-123",
        },
        data: Buffer.from(JSON.stringify({
          budgetDisplayName: "NightCTO Budget",
          costAmount: 141.23,
          budgetAmount: 200,
          currencyCode: "USD",
        })).toString("base64"),
      },
    };
    const { routeNangoWebhook } = await import("./nango-webhook-router");

    await routeNangoWebhook({
      from: "gcp",
      type: "forward",
      providerConfigKey: "gcp-relay",
      connectionId: "conn-gcp-1",
      payload,
    });

    expect(mocks.writeBatchToRelayfile).not.toHaveBeenCalled();
    expect(mocks.triggerNangoSyncs).toHaveBeenCalledWith({
      providerConfigKey: "gcp-relay",
      connectionId: "conn-gcp-1",
      syncs: ["fetch-billing"],
    });
    expect(mocks.dispatchIntegrationWatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "billing.budget.alert",
        paths: ["/gcp/billing/current.json"],
      }),
    );
  });

  it("triggers fetch-error-groups for Error Reporting signals", async () => {
    const { routeNangoWebhook } = await import("./nango-webhook-router");

    await routeNangoWebhook({
      from: "gcp",
      type: "forward",
      providerConfigKey: "gcp-relay",
      connectionId: "conn-gcp-1",
      payload: {
        version: "1.0",
        subject: "New error group: TypeError",
        group_info: {
          project_id: "nightcto-production",
          detail_link: "https://console.cloud.google.com/errors/detail/group-123?project=nightcto-production",
        },
        exception_info: {
          type: "TypeError",
          message: "undefined is not a function",
        },
      },
    });

    expect(mocks.writeBatchToRelayfile).not.toHaveBeenCalled();
    expect(mocks.triggerNangoSyncs).toHaveBeenCalledWith({
      providerConfigKey: "gcp-relay",
      connectionId: "conn-gcp-1",
      syncs: ["fetch-error-groups"],
    });
    expect(mocks.dispatchIntegrationWatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "error-reporting.group.opened",
        paths: ["/gcp/error-reporting/groups/group-123.json"],
      }),
    );
  });

  it("warns and skips when connectionId is missing", async () => {
    const { routeNangoWebhook } = await import("./nango-webhook-router");

    await routeNangoWebhook({
      from: "gcp",
      type: "forward",
      providerConfigKey: "gcp-relay",
      connectionId: null,
      payload: {},
    });

    expect(mocks.writeBatchToRelayfile).not.toHaveBeenCalled();
    expect(mocks.dispatchIntegrationWatchEvent).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      "GCP forward webhook received without a connection id",
      expect.any(Object),
    );
  });

  it("warns and skips when no matching workspace integration exists", async () => {
    mocks.findWorkspaceIntegrationByConnection.mockResolvedValueOnce(null);
    const { routeNangoWebhook } = await import("./nango-webhook-router");

    await routeNangoWebhook({
      from: "gcp",
      type: "forward",
      providerConfigKey: "gcp-relay",
      connectionId: "conn-gcp-1",
      payload: {},
    });

    expect(mocks.writeBatchToRelayfile).not.toHaveBeenCalled();
    expect(mocks.dispatchIntegrationWatchEvent).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      "GCP forward webhook received with no matching workspace integration",
      expect.any(Object),
    );
  });
});
