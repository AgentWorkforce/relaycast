import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  resolveWritebackDispatchBackend,
  type WritebackDispatchBackend,
} from "./relayfile-writeback-bridge";
import type { WorkspaceIntegrationRecord } from "./workspace-integrations";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeIntegration(
  overrides: Partial<WorkspaceIntegrationRecord> = {},
): WorkspaceIntegrationRecord {
  return {
    id: "integration-1",
    workspaceId: "ws_test123",
    provider: "slack",
    connectionId: "conn_slack_1",
    providerConfigKey: "slack-relay",
    installationId: null,
    metadata: {},
    writebackDispatchVia: "bridge",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveWritebackDispatchBackend unit tests
// ---------------------------------------------------------------------------

describe("resolveWritebackDispatchBackend", () => {
  it("returns 'direct-proxy' for cf+slack+reply_in_thread", () => {
    const result = resolveWritebackDispatchBackend({
      provider: "slack",
      action: "reply_in_thread",
      integration: makeIntegration({ writebackDispatchVia: "cf" }),
    });
    expect(result).toBe<WritebackDispatchBackend>("direct-proxy");
  });

  it("returns 'direct-proxy' for cf+slack+post_message", () => {
    const result = resolveWritebackDispatchBackend({
      provider: "slack",
      action: "post_message",
      integration: makeIntegration({ writebackDispatchVia: "cf" }),
    });
    expect(result).toBe<WritebackDispatchBackend>("direct-proxy");
  });

  it("returns 'bridge' when writebackDispatchVia is 'bridge' (even if slack+eligible action)", () => {
    const result = resolveWritebackDispatchBackend({
      provider: "slack",
      action: "reply_in_thread",
      integration: makeIntegration({ writebackDispatchVia: "bridge" }),
    });
    expect(result).toBe<WritebackDispatchBackend>("bridge");
  });

  it("returns 'bridge' for cf+github (non-slack provider)", () => {
    const result = resolveWritebackDispatchBackend({
      provider: "github",
      action: "reply_in_thread",
      integration: makeIntegration({
        provider: "github",
        writebackDispatchVia: "cf",
      }),
    });
    expect(result).toBe<WritebackDispatchBackend>("bridge");
  });

  it("returns 'direct-proxy' for cf+slack+add_reaction", () => {
    const result = resolveWritebackDispatchBackend({
      provider: "slack",
      action: "add_reaction",
      integration: makeIntegration({ writebackDispatchVia: "cf" }),
    });
    expect(result).toBe<WritebackDispatchBackend>("direct-proxy");
  });

  it("returns 'direct-proxy' for cf+slack+remove_reaction", () => {
    const result = resolveWritebackDispatchBackend({
      provider: "slack",
      action: "remove_reaction",
      integration: makeIntegration({ writebackDispatchVia: "cf" }),
    });
    expect(result).toBe<WritebackDispatchBackend>("direct-proxy");
  });

  it("returns 'direct-proxy' for cf+telegram rich bot actions", () => {
    const actions = [
      "send_message",
      "set_message_reaction",
      "answer_callback_query",
      "answer_inline_query",
      "set_my_commands",
      "set_chat_menu_button",
    ];

    for (const action of actions) {
      const result = resolveWritebackDispatchBackend({
        provider: "telegram",
        action,
        integration: makeIntegration({
          provider: "telegram",
          providerConfigKey: "telegram-relay",
          connectionId: "conn_telegram_1",
          writebackDispatchVia: "cf",
        }),
      });
      expect(result, action).toBe<WritebackDispatchBackend>("direct-proxy");
    }
  });

  it("returns 'bridge' for telegram actions when writebackDispatchVia is 'bridge'", () => {
    const result = resolveWritebackDispatchBackend({
      provider: "telegram",
      action: "send_message",
      integration: makeIntegration({
        provider: "telegram",
        providerConfigKey: "telegram-relay",
        connectionId: "conn_telegram_1",
        writebackDispatchVia: "bridge",
      }),
    });
    expect(result).toBe<WritebackDispatchBackend>("bridge");
  });

  it("returns 'bridge' for cf+slack+non-eligible action (delete_message)", () => {
    const result = resolveWritebackDispatchBackend({
      provider: "slack",
      action: "delete_message",
      integration: makeIntegration({ writebackDispatchVia: "cf" }),
    });
    expect(result).toBe<WritebackDispatchBackend>("bridge");
  });

  it("returns 'bridge' for cf+slack+non-eligible action (update_message)", () => {
    const result = resolveWritebackDispatchBackend({
      provider: "slack",
      action: "update_message",
      integration: makeIntegration({ writebackDispatchVia: "cf" }),
    });
    expect(result).toBe<WritebackDispatchBackend>("bridge");
  });

  it("returns 'bridge' when writebackDispatchVia is undefined", () => {
    const integration = makeIntegration();
    delete integration.writebackDispatchVia;
    const result = resolveWritebackDispatchBackend({
      provider: "slack",
      action: "reply_in_thread",
      integration,
    });
    expect(result).toBe<WritebackDispatchBackend>("bridge");
  });
});

// ---------------------------------------------------------------------------
// executeSlackWriteback integration tests -- mocking the direct Slack + Nango paths
// ---------------------------------------------------------------------------

// We mock both the direct Slack API path and the Nango proxy path and verify
// only the expected one is called based on writebackDispatchVia.

const {
  mockResolveBotToken,
  mockNangoProxy,
  mockClaimSlackDirectProxyWriteback,
  mockCompleteSlackDirectProxyWriteback,
  mockReleaseSlackDirectProxyWritebackClaim,
  mockWaitForSlackDirectProxyWritebackResult,
} = vi.hoisted(() => ({
  mockResolveBotToken: vi.fn(),
  mockNangoProxy: vi.fn(),
  mockClaimSlackDirectProxyWriteback: vi.fn(),
  mockCompleteSlackDirectProxyWriteback: vi.fn(),
  mockReleaseSlackDirectProxyWritebackClaim: vi.fn(),
  mockWaitForSlackDirectProxyWritebackResult: vi.fn(),
}));

vi.mock("./slack-conversation/egress", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./slack-conversation/egress")>();
  return {
    ...actual,
    resolveSlackConversationBotToken: mockResolveBotToken,
  };
});

vi.mock("./nango-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./nango-service")>();
  return {
    ...actual,
    getNangoClient: vi.fn(() => ({
      proxy: mockNangoProxy,
    })),
    getProviderConfigKey: vi.fn().mockReturnValue("slack-relay"),
    getSlackProviderConfigKey: vi.fn().mockReturnValue("slack-relay"),
  };
});

vi.mock("./workspace-integrations", async (importOriginal) => {
  return {
    ...(await importOriginal<typeof import("./workspace-integrations")>()),
    getWorkspaceIntegrationByProviderAlias: vi.fn(),
    upsertWorkspaceIntegration: vi.fn(),
  };
});

vi.mock("./relayfile-writeback-receipts", () => {
  return {
    findRelayfileWritebackReceipt: vi.fn().mockResolvedValue(null),
    markRelayfileWritebackReceiptAcked: vi.fn().mockResolvedValue(undefined),
    recordRelayfileWritebackReceipt: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("./slack-direct-proxy-writeback-idempotency", () => {
  return {
    claimSlackDirectProxyWriteback: mockClaimSlackDirectProxyWriteback,
    completeSlackDirectProxyWriteback: mockCompleteSlackDirectProxyWriteback,
    releaseSlackDirectProxyWritebackClaim: mockReleaseSlackDirectProxyWritebackClaim,
    waitForSlackDirectProxyWritebackResult: mockWaitForSlackDirectProxyWritebackResult,
  };
});

vi.mock("@relayfile/sdk", () => ({
  RelayFileClient: vi.fn().mockImplementation(() => ({
    ackWriteback: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("../relayfile", () => ({
  resolveRelayfileConfig: vi.fn().mockReturnValue({
    relayfileUrl: "https://relayfile.test",
    relayAuthUrl: "https://relayauth.test",
    relayAuthApiKey: "test-api-key",
  }),
}));

vi.mock("../../../core/src/relayfile/client", () => ({
  mintRelayfileToken: vi.fn().mockResolvedValue("test-token"),
}));

describe("executeSlackWriteback direct-proxy integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveBotToken.mockResolvedValue("xoxb-test-token");
    mockClaimSlackDirectProxyWriteback.mockResolvedValue({ claimed: true });
    mockCompleteSlackDirectProxyWriteback.mockResolvedValue(undefined);
    mockReleaseSlackDirectProxyWritebackClaim.mockResolvedValue(undefined);
    mockWaitForSlackDirectProxyWritebackResult.mockResolvedValue(null);
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://slack.com/api/chat.postMessage") {
        return new Response(
          JSON.stringify({ ok: true, ts: "1234567890.000100" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/writeback/op_direct_proxy_test/ack")) {
        return new Response(
          JSON.stringify({ status: "acknowledged", id: "op_direct_proxy_test", success: true }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/writeback/op_bridge_test/ack")) {
        return new Response(
          JSON.stringify({ status: "acknowledged", id: "op_bridge_test", success: true }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch ${url}`);
    }) as typeof fetch;
    mockNangoProxy.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      data: { ok: true, ts: "1234567890.000200" },
    });
  });

  it("posts the full Slack payload directly and NOT through Nango when writebackDispatchVia is 'cf'", async () => {
    const { getWorkspaceIntegrationByProviderAlias } = await import(
      "./workspace-integrations"
    );

    const integration = makeIntegration({ writebackDispatchVia: "cf" });
    vi.mocked(getWorkspaceIntegrationByProviderAlias).mockResolvedValue(integration);

    const { executeRelayfileProviderWriteback } = await import("./relayfile-writeback-bridge");

    const result = await executeRelayfileProviderWriteback({
      opId: "op_direct_proxy_test",
      workspaceId: "ws_test123",
      path: "/slack/channels/general--C01GENERAL/messages/original-msg--1111111111_000100/replies/new-reply.json",
      revision: "rev_1",
      correlationId: "corr_1",
      action: "file_upsert",
      content: JSON.stringify({
        text: "Hello from direct proxy!",
        blocks: [{ type: "section", text: { type: "mrkdwn", text: "*hello*" } }],
        unfurl_links: false,
      }),
    });

    expect(result.outcome).toBe("success");
    expect(mockResolveBotToken).toHaveBeenCalledWith("ws_test123");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://slack.com/api/chat.postMessage",
      expect.objectContaining({
        method: "POST",
        body: expect.any(String),
      }),
    );
    const slackCall = vi.mocked(globalThis.fetch).mock.calls.find(
      ([input]) => String(input) === "https://slack.com/api/chat.postMessage",
    );
    expect(JSON.parse(String(slackCall?.[1]?.body))).toMatchObject({
      channel: "C01GENERAL",
      thread_ts: "1111111111.000100",
      text: "Hello from direct proxy!",
    });
    expect(mockNangoProxy).not.toHaveBeenCalled();
  });

  it("dedupes the same logical Slack reply across distinct relayfile op ids", async () => {
    const { getWorkspaceIntegrationByProviderAlias } = await import(
      "./workspace-integrations"
    );

    const integration = makeIntegration({ writebackDispatchVia: "cf" });
    vi.mocked(getWorkspaceIntegrationByProviderAlias).mockResolvedValue(integration);
    mockClaimSlackDirectProxyWriteback
      .mockResolvedValueOnce({ claimed: true })
      .mockResolvedValueOnce({
        claimed: false,
        record: {
          workspaceId: "ws_test123",
          idempotencyKey: "slack-direct-proxy:key",
          providerConfigKey: "slack-relay",
          connectionId: "conn_slack_1",
          status: "success",
          opId: "op_direct_proxy_first",
          slackTs: "1234567890.000100",
          metadata: {
            provider: "slack",
            action: "reply_in_thread",
            method: "POST",
            endpoint: "/api/chat.postMessage",
            externalId: "1234567890.000100",
          },
          errorCode: null,
          errorMessage: null,
        },
      });

    const { executeRelayfileProviderWriteback } = await import("./relayfile-writeback-bridge");
    const base = {
      workspaceId: "ws_test123",
      path: "/slack/channels/general--C01GENERAL/messages/original-msg--1111111111_000100/replies/duplicate-a.json",
      revision: "rev_1",
      correlationId: "corr_1",
      action: "file_upsert" as const,
      content: JSON.stringify({
        text: "same reply",
        idempotencyKey: "client-key-1",
      }),
    };

    const first = await executeRelayfileProviderWriteback({
      ...base,
      opId: "op_direct_proxy_first",
    });
    const second = await executeRelayfileProviderWriteback({
      ...base,
      opId: "op_direct_proxy_second",
      path: "/slack/channels/general--C01GENERAL/messages/original-msg--1111111111_000100/replies/duplicate-b.json",
      revision: "rev_2",
      correlationId: "corr_2",
    });

    expect(first.outcome).toBe("success");
    expect(second).toMatchObject({
      outcome: "success",
      metadata: { externalId: "1234567890.000100" },
    });
    const postCalls = vi.mocked(globalThis.fetch).mock.calls.filter(
      ([input]) => String(input) === "https://slack.com/api/chat.postMessage",
    );
    expect(postCalls).toHaveLength(1);
    expect(mockCompleteSlackDirectProxyWriteback).toHaveBeenCalledTimes(1);
  });

  it("waits on a concurrent duplicate claim and returns the stored success without posting", async () => {
    const { getWorkspaceIntegrationByProviderAlias } = await import(
      "./workspace-integrations"
    );

    const integration = makeIntegration({ writebackDispatchVia: "cf" });
    vi.mocked(getWorkspaceIntegrationByProviderAlias).mockResolvedValue(integration);
    mockClaimSlackDirectProxyWriteback.mockResolvedValue({
      claimed: false,
      record: {
        workspaceId: "ws_test123",
        idempotencyKey: "slack-direct-proxy:key",
        providerConfigKey: "slack-relay",
        connectionId: "conn_slack_1",
        status: "pending",
        opId: "op_inflight",
        slackTs: null,
        metadata: null,
        errorCode: null,
        errorMessage: null,
      },
    });
    mockWaitForSlackDirectProxyWritebackResult.mockResolvedValue({
      workspaceId: "ws_test123",
      idempotencyKey: "slack-direct-proxy:key",
      providerConfigKey: "slack-relay",
      connectionId: "conn_slack_1",
      status: "success",
      opId: "op_inflight",
      slackTs: "1234567890.000300",
      metadata: {
        provider: "slack",
        action: "reply_in_thread",
        method: "POST",
        endpoint: "/api/chat.postMessage",
      },
      errorCode: null,
      errorMessage: null,
    });

    const { executeRelayfileProviderWriteback } = await import("./relayfile-writeback-bridge");
    const result = await executeRelayfileProviderWriteback({
      opId: "op_direct_proxy_waiter",
      workspaceId: "ws_test123",
      path: "/slack/channels/general--C01GENERAL/messages/original-msg--1111111111_000100/replies/waiter.json",
      revision: "rev_1",
      correlationId: "corr_1",
      action: "file_upsert",
      content: JSON.stringify({
        text: "same reply",
        idempotencyKey: "client-key-1",
      }),
    });

    expect(result).toMatchObject({
      outcome: "success",
      metadata: { externalId: "1234567890.000300" },
    });
    expect(mockWaitForSlackDirectProxyWritebackResult).toHaveBeenCalledOnce();
    expect(vi.mocked(globalThis.fetch).mock.calls).not.toContainEqual([
      "https://slack.com/api/chat.postMessage",
      expect.anything(),
    ]);
  });

  it("calls Nango proxy and NOT direct Slack when writebackDispatchVia is 'bridge'", async () => {
    const { getWorkspaceIntegrationByProviderAlias } = await import(
      "./workspace-integrations"
    );

    const integration = makeIntegration({ writebackDispatchVia: "bridge" });
    vi.mocked(getWorkspaceIntegrationByProviderAlias).mockResolvedValue(integration);

    const { executeRelayfileProviderWriteback } = await import("./relayfile-writeback-bridge");

    const result = await executeRelayfileProviderWriteback({
      opId: "op_bridge_test",
      workspaceId: "ws_test123",
      path: "/slack/channels/general--C01GENERAL/messages/original-msg--1111111111_000200/replies/new-reply.json",
      revision: "rev_2",
      correlationId: "corr_2",
      action: "file_upsert",
      content: JSON.stringify({ text: "Hello from bridge!" }),
    });

    expect(result.outcome).toBe("success");
    expect(mockNangoProxy).toHaveBeenCalledOnce();
    expect(mockResolveBotToken).not.toHaveBeenCalled();
    expect(vi.mocked(globalThis.fetch).mock.calls).not.toContainEqual([
      "https://slack.com/api/chat.postMessage",
      expect.anything(),
    ]);
  });
});

describe("executeTelegramWriteback direct-proxy integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNangoProxy.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      data: { ok: true, result: { message_id: 77 } },
    });
  });

  it("sends Telegram message writebacks through the Telegram Nango proxy when writebackDispatchVia is 'cf'", async () => {
    const { getWorkspaceIntegrationByProviderAlias } = await import(
      "./workspace-integrations"
    );

    vi.mocked(getWorkspaceIntegrationByProviderAlias).mockResolvedValue(
      makeIntegration({
        provider: "telegram",
        providerConfigKey: "telegram-relay",
        connectionId: "conn_telegram_1",
        writebackDispatchVia: "cf",
      }),
    );

    const { executeRelayfileProviderWriteback } = await import("./relayfile-writeback-bridge");

    const result = await executeRelayfileProviderWriteback({
      opId: "op_telegram_direct_proxy_test",
      workspaceId: "ws_test123",
      path: "/telegram/chats/8587455921/messages/draft.json",
      revision: "rev_1",
      correlationId: "corr_1",
      action: "file_upsert",
      content: JSON.stringify({
        text: "Hello from Telegram direct proxy!",
        reply_markup: {
          inline_keyboard: [[{ text: "Open", callback_data: "open" }]],
        },
        idempotencyKey: "idem-1",
      }),
    });

    expect(result).toMatchObject({
      outcome: "success",
      provider: "telegram",
      metadata: {
        action: "send_message",
        endpoint: "/sendMessage",
        externalId: "77",
      },
    });
    expect(mockNangoProxy).toHaveBeenCalledWith(expect.objectContaining({
      method: "POST",
      endpoint: "/sendMessage",
      connectionId: "conn_telegram_1",
      providerConfigKey: "telegram-relay",
      data: expect.objectContaining({
        chat_id: "8587455921",
        text: "Hello from Telegram direct proxy!",
      }),
    }));
    const payload = mockNangoProxy.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(payload.idempotencyKey).toBeUndefined();
  });

  it("routes Telegram media message writebacks to the matching Bot API method", async () => {
    const { getWorkspaceIntegrationByProviderAlias } = await import(
      "./workspace-integrations"
    );

    vi.mocked(getWorkspaceIntegrationByProviderAlias).mockResolvedValue(
      makeIntegration({
        provider: "telegram",
        providerConfigKey: "telegram-relay",
        connectionId: "conn_telegram_1",
        writebackDispatchVia: "cf",
      }),
    );

    const { executeRelayfileProviderWriteback } = await import("./relayfile-writeback-bridge");

    const result = await executeRelayfileProviderWriteback({
      opId: "op_telegram_photo_direct_proxy_test",
      workspaceId: "ws_test123",
      path: "/telegram/chats/8587455921/messages/photo.json",
      revision: "rev_1",
      correlationId: "corr_1",
      action: "file_upsert",
      content: JSON.stringify({
        photo: "AgACAgQAAxkBAAIB",
        caption: "Build artifact",
      }),
    });

    expect(result.outcome).toBe("success");
    expect(mockNangoProxy).toHaveBeenCalledWith(expect.objectContaining({
      method: "POST",
      endpoint: "/sendPhoto",
      connectionId: "conn_telegram_1",
      providerConfigKey: "telegram-relay",
      data: expect.objectContaining({
        chat_id: "8587455921",
        photo: "AgACAgQAAxkBAAIB",
        caption: "Build artifact",
      }),
    }));
  });
});
