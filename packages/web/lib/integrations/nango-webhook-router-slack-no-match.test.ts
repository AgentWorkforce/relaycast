import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findSlackIntegrationByConnectionId: vi.fn(),
  findSlackIntegrationByTeamId: vi.fn(),
  findWorkspaceIntegrationByConnection: vi.fn(),
  loggerError: vi.fn(),
  loggerWarn: vi.fn(),
  loggerInfo: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/integrations/workspace-integrations", async () => {
  const actual = await vi.importActual<
    typeof import("./workspace-integrations")
  >("@/lib/integrations/workspace-integrations");
  return {
    ...actual,
    findSlackIntegrationByConnectionId: mocks.findSlackIntegrationByConnectionId,
    findSlackIntegrationByTeamId: mocks.findSlackIntegrationByTeamId,
    findWorkspaceIntegrationByConnection:
      mocks.findWorkspaceIntegrationByConnection,
  };
});

vi.mock("@/lib/logger", () => ({
  logger: {
    error: mocks.loggerError,
    warn: mocks.loggerWarn,
    info: mocks.loggerInfo,
  },
}));

describe("Slack relayfile forward routing", () => {
  it("surfaces no-match forwards instead of silently accepting and dropping them", async () => {
    mocks.findWorkspaceIntegrationByConnection.mockResolvedValue(null);
    mocks.findSlackIntegrationByConnectionId.mockResolvedValue(null);
    mocks.findSlackIntegrationByTeamId.mockResolvedValue(null);
    const { routeNangoWebhook } = await import("./nango-webhook-router");

    await expect(
      routeNangoWebhook({
        from: "slack",
        type: "forward",
        providerConfigKey: "slack-relay",
        connectionId: "48d75838-5c1b-4885-b0c1-3620a80e12f6",
        payload: {
          team_id: "T123",
          event: {
            type: "message",
            channel: "C123",
            ts: "1711111000.000100",
            text: "hello",
          },
        },
      }),
    ).rejects.toThrow(/no matching workspace integration/);

    expect(mocks.loggerError).toHaveBeenCalledWith(
      "Slack relayfile forward webhook received with no matching workspace integration",
      expect.objectContaining({
        connectionId: "48d75838-5c1b-4885-b0c1-3620a80e12f6",
        providerConfigKey: "slack-relay",
        teamId: "T123",
      }),
    );
  });
});
