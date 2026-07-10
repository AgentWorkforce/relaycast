import { describe, expect, it, vi } from "vitest";

import { COMPOSIO_PROXY_USER_AGENT, executeComposioToolRequest } from "./composio-tool.js";

describe("executeComposioToolRequest", () => {
  it("passes a generic axios User-Agent through the Nango proxy headers", async () => {
    const proxy = vi.fn().mockResolvedValue({
      data: {
        successful: true,
        data: { ok: true },
        error: null,
      },
    });

    await executeComposioToolRequest(
      { proxy } as never,
      {
        apiKey: "composio-key",
        connectedAccountId: "connected-account",
        userId: "relay-user",
      },
      {
        toolSlug: "REDDIT_CREATE_POST",
        arguments: { title: "Hello" },
      },
    );

    expect(proxy).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({
          "User-Agent": COMPOSIO_PROXY_USER_AGENT,
        }),
      }),
    );
    expect(proxy.mock.calls[0]?.[0]?.headers?.["User-Agent"]).not.toContain("nango-node-client");
  });
});
