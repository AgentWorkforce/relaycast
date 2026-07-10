import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handleRickySlackForward: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
  loggerInfo: vi.fn(),
}));

vi.mock("@/lib/ricky/slack/ingress", () => ({
  handleRickySlackForward: mocks.handleRickySlackForward,
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
    info: mocks.loggerInfo,
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Nango Slack Ricky router dispatch", () => {
  it("short-circuits slack-ricky forward envelopes before the generic Slack fanout", async () => {
    const { isRickySlackForwardEnvelope, routeForwardEvent } = await import("./nango-webhook-router");
    const envelope = {
      from: "slack",
      type: "forward",
      providerConfigKey: "slack-ricky",
      connectionId: "conn_1",
      payload: { body: { command: "/ricky" } },
    };

    expect(isRickySlackForwardEnvelope(envelope)).toBe(true);
    await routeForwardEvent(envelope);

    expect(mocks.handleRickySlackForward).toHaveBeenCalledWith(envelope);
  });

  it("surfaces slack-ricky dispatch failures so the Nango route can return retryable errors", async () => {
    const { routeForwardEvent } = await import("./nango-webhook-router");
    const envelope = {
      from: "slack",
      type: "forward",
      providerConfigKey: "slack-ricky",
      connectionId: "conn_1",
      payload: { body: { command: "/ricky" } },
    };

    mocks.handleRickySlackForward.mockRejectedValueOnce(new Error("slack retry me"));

    await expect(routeForwardEvent(envelope)).rejects.toThrow("slack retry me");
  });

  it("does not classify generic Slack forwards as Ricky Slack events", async () => {
    const { isRickySlackForwardEnvelope } = await import("./nango-webhook-router");

    expect(
      isRickySlackForwardEnvelope({
        from: "slack-sage",
        type: "forward",
        providerConfigKey: "slack-sage",
      }),
    ).toBe(false);
  });
});
