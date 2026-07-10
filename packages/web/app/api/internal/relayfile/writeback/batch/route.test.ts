import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handleRelayfileProviderWriteback: vi.fn(),
  isRelayfileWritebackInput: vi.fn(),
  verifyRelayfileInternalRequest: vi.fn(),
  dispatchMovedToCloudflare: vi.fn(),
}));

vi.mock(
  "../../../../../../lib/integrations/relayfile-writeback-bridge",
  () => ({
    handleRelayfileProviderWriteback: mocks.handleRelayfileProviderWriteback,
    isRelayfileWritebackInput: mocks.isRelayfileWritebackInput,
  }),
);

vi.mock("../../../../../../lib/integrations/relayfile-writeback-auth", () => ({
  verifyRelayfileInternalRequest: mocks.verifyRelayfileInternalRequest,
}));

vi.mock("../dispatch-moved", () => ({
  dispatchMovedToCloudflare: mocks.dispatchMovedToCloudflare,
}));

const ROUTE_URL = "https://cloud.test/api/internal/relayfile/writeback/batch";

describe("relayfile writeback batch route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyRelayfileInternalRequest.mockReturnValue(true);
    mocks.isRelayfileWritebackInput.mockReturnValue(true);
    mocks.dispatchMovedToCloudflare.mockResolvedValue(false);
    mocks.handleRelayfileProviderWriteback.mockResolvedValue({
      outcome: "success",
      provider: "linear",
      metadata: { provider: "linear", action: "create_issue" },
      relayfileAcked: true,
    });
  });

  it("returns retryable dispatch_moved for batch items whose provider moved to CF", async () => {
    mocks.dispatchMovedToCloudflare.mockResolvedValueOnce(true);
    const item = {
      opId: "op_linear_batch_fallback",
      workspaceId: "50587328-441d-4acb-b8f3-dbe1b3c5de99",
      path: "/linear/issues/factory-create-23eb9afd.json",
      revision: "rev_linear_batch_fallback",
      correlationId: "corr_linear_batch_fallback",
      provider: "linear",
      action: "file_upsert",
      content: JSON.stringify({ title: "Create from fallback" }),
      encoding: "utf-8",
    };

    const { POST } = await import("./route");
    const response = await POST(
      new Request(ROUTE_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: [item] }),
      }) as never,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      results: [
        {
          opId: item.opId,
          outcome: "retryable_failure",
          provider: "linear",
          error: {
            code: "dispatch_moved",
            message: "Relayfile writeback dispatch moved to Cloudflare",
          },
          relayfileAcked: false,
        },
      ],
    });
    expect(mocks.dispatchMovedToCloudflare).toHaveBeenCalledWith(item);
    expect(mocks.handleRelayfileProviderWriteback).not.toHaveBeenCalled();
  });
});
