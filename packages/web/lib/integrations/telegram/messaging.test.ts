import { describe, expect, it, vi } from "vitest";

import {
  deriveTelegramWebhookSecret,
  handleTelegramWebhookUpdate,
  normalizeTelegramUpdate,
  TELEGRAM_CALLBACK_QUERY_EVENT,
  TELEGRAM_INLINE_QUERY_EVENT,
  TELEGRAM_MESSAGE_EVENT,
  TELEGRAM_REACTION_EVENT,
  verifyTelegramWebhookSecret,
} from "./messaging";

describe("telegram messaging integration", () => {
  it("derives and verifies connection-scoped webhook secrets", () => {
    const secret = deriveTelegramWebhookSecret({
      connectionId: "conn_123",
      nangoSecretKey: "nango-secret",
    });

    expect(secret).toHaveLength(43);
    expect(
      verifyTelegramWebhookSecret({
        connectionId: "conn_123",
        provided: secret,
        nangoSecretKey: "nango-secret",
      }),
    ).toBe(true);
    expect(
      verifyTelegramWebhookSecret({
        connectionId: "conn_123",
        provided: "wrong",
        nangoSecretKey: "nango-secret",
      }),
    ).toBe(false);
  });

  it("normalizes text message updates", () => {
    const normalized = normalizeTelegramUpdate({
      update_id: 100,
      message: {
        message_id: 42,
        chat: { id: 12345 },
        from: { id: 7, username: "khaliq" },
        text: "/status",
      },
    });

    expect(normalized).toMatchObject({
      updateId: 100,
      eventType: TELEGRAM_MESSAGE_EVENT,
      chatId: 12345,
      messageId: 42,
      text: "/status",
      fromUserId: 7,
      username: "khaliq",
      path: "/telegram/chats/12345/messages/42",
    });
  });

  it("normalizes media-only message updates without requiring text", () => {
    const normalized = normalizeTelegramUpdate({
      update_id: 100,
      message: {
        message_id: 43,
        chat: { id: 12345 },
        from: { id: 7, username: "khaliq" },
        photo: [{ file_id: "photo_1", width: 640, height: 480 }],
      },
    });

    expect(normalized).toMatchObject({
      updateId: 100,
      eventType: TELEGRAM_MESSAGE_EVENT,
      chatId: 12345,
      messageId: 43,
      fromUserId: 7,
      username: "khaliq",
      path: "/telegram/chats/12345/messages/43",
    });
    expect(normalized).not.toHaveProperty("text");
  });

  it("normalizes callback query, inline query, and reaction updates", () => {
    expect(
      normalizeTelegramUpdate({
        update_id: 101,
        callback_query: {
          id: "cb_1",
          from: { id: 7, username: "khaliq" },
          data: "approve:123",
          message: { message_id: 42, chat: { id: 12345 } },
        },
      }),
    ).toMatchObject({
      eventType: TELEGRAM_CALLBACK_QUERY_EVENT,
      path: "/telegram/callback-queries/cb_1",
      chatId: 12345,
      messageId: 42,
    });

    expect(
      normalizeTelegramUpdate({
        update_id: 102,
        inline_query: {
          id: "iq_1",
          from: { id: 7, username: "khaliq" },
          query: "run tests",
        },
      }),
    ).toMatchObject({
      eventType: TELEGRAM_INLINE_QUERY_EVENT,
      path: "/telegram/inline-queries/iq_1",
      text: "run tests",
    });

    expect(
      normalizeTelegramUpdate({
        update_id: 103,
        message_reaction: {
          chat: { id: 12345 },
          message_id: 42,
          old_reaction: [],
          new_reaction: [{ type: "emoji", emoji: "\u{1F44D}" }],
        },
      }),
    ).toMatchObject({
      eventType: TELEGRAM_REACTION_EVENT,
      path: "/telegram/chats/12345/messages/42/reactions",
    });
  });

  it("dispatches normalized webhook updates to integration watch", async () => {
    const secret = deriveTelegramWebhookSecret({
      connectionId: "conn_123",
      nangoSecretKey: "nango-secret",
    });
    const dispatchEvent = vi.fn().mockResolvedValue({
      matched: 1,
      delivered: 1,
      failed: 0,
    });
    const relayfileClient = { mocked: "relayfile-client" };
    const writeBatch = vi.fn().mockResolvedValue({
      written: 1,
      deleted: 0,
      errors: 0,
    });

    await expect(
      handleTelegramWebhookUpdate(
        {
          connectionId: "conn_123",
          secretToken: secret,
          update: {
            update_id: 104,
            inline_query: {
              id: "iq_2",
              from: { id: 7 },
              query: "deploy",
            },
          },
        },
        {
          nangoSecretKey: "nango-secret",
          findIntegrationByConnection: vi.fn().mockResolvedValue({
            workspaceId: "ws_123",
            providerConfigKey: "telegram-relay",
          }),
          dispatchEvent,
          relayfileClientFactory: vi.fn(() => relayfileClient as never),
          writeBatch: writeBatch as never,
        },
      ),
    ).resolves.toMatchObject({
      ok: true,
      status: "dispatched",
      workspaceId: "ws_123",
      deliveryId: "telegram:conn_123:104",
      relayfileWrite: {
        written: 2,
        deleted: 0,
        errors: 0,
      },
    });

    expect(writeBatch).toHaveBeenCalledTimes(2);
    expect(writeBatch.mock.calls.map((call) => call[2])).toEqual([
      expect.objectContaining({
        provider: "telegram",
        providerConfigKey: "telegram-relay",
        connectionId: "conn_123",
        model: "TelegramUpdate",
        syncName: "fetch-updates",
      }),
      expect.objectContaining({
        provider: "telegram",
        providerConfigKey: "telegram-relay",
        connectionId: "conn_123",
        model: "TelegramInlineQuery",
        syncName: "fetch-updates",
      }),
    ]);
    expect(writeBatch.mock.calls[1]?.[1]).toEqual([
      expect.objectContaining({
        id: "iq_2",
        updateId: "104",
        query: "deploy",
      }),
    ]);

    expect(dispatchEvent).toHaveBeenCalledWith({
      workspaceId: "ws_123",
      provider: "telegram",
      eventType: TELEGRAM_INLINE_QUERY_EVENT,
      connectionId: "conn_123",
      deliveryId: "telegram:conn_123:104",
      paths: ["/telegram/inline-queries/iq_2"],
      payload: expect.objectContaining({
        telegram: expect.objectContaining({
          eventType: TELEGRAM_INLINE_QUERY_EVENT,
          inlineQueryId: "iq_2",
          text: "deploy",
        }),
      }),
    });
  });
});
