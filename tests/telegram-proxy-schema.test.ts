import { describe, expect, it } from "vitest";

import {
  getAllowedTelegramProxyMethods,
  isAllowedTelegramProxyRoute,
  normalizeTelegramProxyEndpoint,
  telegramProxyRequestSchema,
} from "../packages/web/lib/integrations/telegram-proxy-schema";

describe("telegram proxy schema", () => {
  it("normalizes Bot API method names into proxy endpoints", () => {
    expect(normalizeTelegramProxyEndpoint("sendMessage")).toBe("/sendMessage");
    expect(normalizeTelegramProxyEndpoint(" /answerInlineQuery ")).toBe(
      "/answerInlineQuery",
    );
  });

  it("allowlists rich Telegram bot primitives", () => {
    expect(isAllowedTelegramProxyRoute("/sendMessage", "POST")).toBe(true);
    expect(isAllowedTelegramProxyRoute("/setMyCommands", "POST")).toBe(true);
    expect(isAllowedTelegramProxyRoute("/setChatMenuButton", "POST")).toBe(true);
    expect(isAllowedTelegramProxyRoute("/answerInlineQuery", "POST")).toBe(true);
    expect(isAllowedTelegramProxyRoute("/answerCallbackQuery", "POST")).toBe(true);
    expect(isAllowedTelegramProxyRoute("/setMessageReaction", "POST")).toBe(true);
    expect(isAllowedTelegramProxyRoute("/sendRichMessage", "POST")).toBe(true);
  });

  it("rejects arbitrary method names", () => {
    expect(isAllowedTelegramProxyRoute("/deleteEverything", "POST")).toBe(false);
    expect(getAllowedTelegramProxyMethods("/deleteEverything")).toEqual([]);
  });

  it("rejects managed bot token endpoints", () => {
    expect(isAllowedTelegramProxyRoute("/getManagedBotToken", "POST")).toBe(false);
    expect(isAllowedTelegramProxyRoute("/replaceManagedBotToken", "POST")).toBe(false);
  });

  it("rejects a method mismatch for read-friendly endpoints", () => {
    expect(isAllowedTelegramProxyRoute("/getMe", "GET")).toBe(true);
    expect(isAllowedTelegramProxyRoute("/getMe", "POST")).toBe(true);
    expect(isAllowedTelegramProxyRoute("/sendMessage", "GET")).toBe(false);
    expect(getAllowedTelegramProxyMethods("/sendMessage")).toEqual(["POST"]);
  });

  it("parses proxy request bodies and trims empty params", () => {
    const parsed = telegramProxyRequestSchema.parse({
      endpoint: "sendMessage",
      method: "POST",
      data: { chat_id: "123", text: "hello" },
      params: { ok: "1", "": "ignored", empty: "" },
    });

    expect(parsed).toEqual({
      endpoint: "/sendMessage",
      method: "POST",
      data: { chat_id: "123", text: "hello" },
      params: { ok: "1" },
    });
  });
});
