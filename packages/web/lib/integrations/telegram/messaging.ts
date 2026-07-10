import { createHmac, timingSafeEqual } from "node:crypto";

import {
  createWebhookSyncJob,
  writeBatchToRelayfile,
} from "@cloud/core/sync/record-writer.js";

import { getConfiguredAppOrigin } from "@/lib/app-origin";
import { createGitHubRelayfileClient } from "@/lib/integrations/github-relayfile";
import { getNangoSecretKey, getProviderConfigKey } from "@/lib/integrations/nango-service";
import { proxyRequest } from "@/lib/integrations/nango-slack";
import {
  findWorkspaceIntegrationByConnection,
  getWorkspaceIntegration,
  type WorkspaceIntegrationRecord,
} from "@/lib/integrations/workspace-integrations";
import { logger } from "@/lib/logger";
import {
  dispatchIntegrationWatchEvent,
  type IntegrationWatchDispatchResult,
} from "@/lib/proactive-runtime/integration-watch-dispatcher";

export const TELEGRAM_PROVIDER = "telegram";
export const TELEGRAM_MESSAGE_EVENT = "message";
export const TELEGRAM_CALLBACK_QUERY_EVENT = "callback_query";
export const TELEGRAM_INLINE_QUERY_EVENT = "inline_query";
export const TELEGRAM_REACTION_EVENT = "message_reaction";
export const TELEGRAM_WEBHOOK_SECRET_HEADER =
  "x-telegram-bot-api-secret-token";

type TelegramChatId = number | string;

type TelegramApiResponse<T = unknown> = {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
};

type TelegramSendMessageResult = {
  message_id?: number;
  chat?: { id?: TelegramChatId };
};

export type TelegramSendMessageInput = {
  workspaceId: string;
  chatId: TelegramChatId;
  text: string;
  parseMode?: "Markdown" | "MarkdownV2" | "HTML";
  disableWebPagePreview?: boolean;
  disableNotification?: boolean;
  replyToMessageId?: number | string;
  replyMarkup?: Record<string, unknown>;
};

export type TelegramEgressResult =
  | { ok: true; messageId?: number; chatId?: TelegramChatId; raw: unknown }
  | { ok: false; error: string };

type TelegramNormalizedMessage = {
  updateId: number | string;
  eventType: string;
  chatId?: TelegramChatId;
  messageId?: number | string;
  text?: string;
  fromUserId?: TelegramChatId;
  username?: string;
  path: string;
  payload: Record<string, unknown>;
};

type TelegramWebhookResult =
  | { ok: true; status: "ignored" }
  | {
      ok: true;
      status: "dispatched";
      workspaceId: string;
      deliveryId: string;
      dispatch: IntegrationWatchDispatchResult;
      relayfileWrite?: TelegramRelayfileWriteSummary;
    }
  | { ok: false; status: "unauthorized"; error: string }
  | { ok: false; status: "configuration_error"; error: string }
  | { ok: false; status: "integration_not_found"; error: string };

type TelegramWebhookDependencies = {
  findIntegrationByConnection?: typeof findWorkspaceIntegrationByConnection;
  dispatchEvent?: typeof dispatchIntegrationWatchEvent;
  relayfileClientFactory?: typeof createGitHubRelayfileClient;
  writeBatch?: typeof writeBatchToRelayfile;
  nangoSecretKey?: string;
};

type TelegramRelayfileWriteSummary = {
  written: number;
  deleted: number;
  errors: number;
};

type TelegramModelWrite = {
  model: string;
  syncName: string;
  records: Record<string, unknown>[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasContent(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function readTelegramMessage(update: Record<string, unknown>): Record<string, unknown> | null {
  for (const key of [
    "message",
    "edited_message",
    "channel_post",
    "edited_channel_post",
    "business_message",
    "edited_business_message",
    "guest_message",
  ]) {
    const candidate = update[key];
    if (isRecord(candidate)) {
      return candidate;
    }
  }
  return null;
}

function readStringOrNumber(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

function telegramDateToIso(value: unknown): string | null {
  return typeof value === "number" ? new Date(value * 1000).toISOString() : null;
}

function chatTitle(chat: Record<string, unknown> | null): string {
  if (!chat) return "";
  const title = readStringOrNumber(chat.title) ?? readStringOrNumber(chat.username);
  if (title) return title;
  return [readStringOrNumber(chat.first_name), readStringOrNumber(chat.last_name)]
    .filter((part): part is string => Boolean(part))
    .join(" ");
}

function updatedAtForPayload(payload: Record<string, unknown> | null): string {
  return telegramDateToIso(payload?.date ?? payload?.edit_date) ?? new Date().toISOString();
}

function buildTelegramChatRecord(
  chat: Record<string, unknown> | null,
  updatedAt: string,
): Record<string, unknown> | null {
  const id = chat ? readStringOrNumber(chat.id) : null;
  if (!id || !chat) return null;
  return {
    id,
    title: chatTitle(chat),
    username: readStringOrNumber(chat.username) ?? "",
    type: readStringOrNumber(chat.type) ?? "",
    updatedAt,
    raw: chat,
  };
}

function buildTelegramMessageRecord(input: {
  updateId: string;
  eventType: string;
  message: Record<string, unknown>;
}): { chat: Record<string, unknown> | null; message: Record<string, unknown> | null } {
  const chat = isRecord(input.message.chat) ? input.message.chat : null;
  const chatId = chat ? readStringOrNumber(chat.id) : null;
  const messageId = readStringOrNumber(input.message.message_id);
  const updatedAt = updatedAtForPayload(input.message);
  if (!chatId || !messageId) {
    return { chat: buildTelegramChatRecord(chat, updatedAt), message: null };
  }

  const from = isRecord(input.message.from) ? input.message.from : null;
  const senderChat = isRecord(input.message.sender_chat) ? input.message.sender_chat : null;
  const reply = isRecord(input.message.reply_to_message) ? input.message.reply_to_message : null;
  return {
    chat: buildTelegramChatRecord(chat, updatedAt),
    message: {
      id: `${chatId}:${messageId}`,
      updateId: input.updateId,
      eventType: input.eventType,
      chatId,
      messageId,
      messageThreadId: readStringOrNumber(input.message.message_thread_id),
      chatTitle: chatTitle(chat),
      fromId: from ? readStringOrNumber(from.id) : null,
      senderChatId: senderChat ? readStringOrNumber(senderChat.id) : null,
      date: telegramDateToIso(input.message.date),
      updatedAt,
      text: typeof input.message.text === "string" ? input.message.text : "",
      caption: typeof input.message.caption === "string" ? input.message.caption : "",
      mediaGroupId: readStringOrNumber(input.message.media_group_id),
      replyToMessageId: reply ? readStringOrNumber(reply.message_id) : null,
      raw: input.message,
    },
  };
}

function pushModelWrite(
  writes: TelegramModelWrite[],
  model: string,
  syncName: string,
  record: Record<string, unknown> | null,
): void {
  if (!record) return;
  let existing = writes.find((write) => write.model === model);
  if (!existing) {
    existing = { model, syncName, records: [] };
    writes.push(existing);
  }
  existing.records.push(record);
}

function buildTelegramWebhookModelWrites(
  update: unknown,
  normalized: TelegramNormalizedMessage,
): TelegramModelWrite[] {
  if (!isRecord(update)) return [];
  const entry = readTelegramUpdateEntry(update);
  if (!entry) return [];

  const updateId = String(normalized.updateId);
  const writes: TelegramModelWrite[] = [];
  pushModelWrite(writes, "TelegramUpdate", "fetch-updates", {
    id: updateId,
    updateId,
    eventType: normalized.eventType,
    chatId: readStringOrNumber(normalized.chatId),
    messageId: readStringOrNumber(normalized.messageId),
    updatedAt: updatedAtForPayload(entry.value),
    raw: update,
  });

  if (
    entry.eventType === "message" ||
    entry.eventType === "edited_message" ||
    entry.eventType === "channel_post" ||
    entry.eventType === "edited_channel_post" ||
    entry.eventType === "business_message" ||
    entry.eventType === "edited_business_message" ||
    entry.eventType === "guest_message"
  ) {
    const built = buildTelegramMessageRecord({
      updateId,
      eventType: entry.eventType,
      message: entry.value,
    });
    pushModelWrite(writes, "TelegramChat", "fetch-updates", built.chat);
    pushModelWrite(writes, "TelegramMessage", "fetch-updates", built.message);
  }

  if (entry.eventType === "callback_query") {
    const from = isRecord(entry.value.from) ? entry.value.from : null;
    const message = isRecord(entry.value.message) ? entry.value.message : null;
    const chat = isRecord(message?.chat) ? message.chat : null;
    const updatedAt = updatedAtForPayload(message);
    pushModelWrite(writes, "TelegramCallbackQuery", "fetch-updates", {
      id: readStringOrNumber(entry.value.id) ?? "",
      updateId,
      fromId: from ? readStringOrNumber(from.id) ?? "" : "",
      chatId: chat ? readStringOrNumber(chat.id) : null,
      messageId: message ? readStringOrNumber(message.message_id) : null,
      inlineMessageId: readStringOrNumber(entry.value.inline_message_id),
      chatInstance: readStringOrNumber(entry.value.chat_instance) ?? "",
      data: typeof entry.value.data === "string" ? entry.value.data : "",
      gameShortName: typeof entry.value.game_short_name === "string" ? entry.value.game_short_name : "",
      updatedAt,
      raw: entry.value,
    });
    if (message) {
      const built = buildTelegramMessageRecord({ updateId, eventType: entry.eventType, message });
      pushModelWrite(writes, "TelegramChat", "fetch-updates", built.chat);
      pushModelWrite(writes, "TelegramMessage", "fetch-updates", built.message);
    }
  }

  if (entry.eventType === "inline_query") {
    const from = isRecord(entry.value.from) ? entry.value.from : null;
    pushModelWrite(writes, "TelegramInlineQuery", "fetch-updates", {
      id: readStringOrNumber(entry.value.id) ?? "",
      updateId,
      fromId: from ? readStringOrNumber(from.id) ?? "" : "",
      query: typeof entry.value.query === "string" ? entry.value.query : "",
      offset: typeof entry.value.offset === "string" ? entry.value.offset : "",
      chatType: typeof entry.value.chat_type === "string" ? entry.value.chat_type : "",
      updatedAt: new Date().toISOString(),
      raw: entry.value,
    });
  }

  if (entry.eventType === "message_reaction" || entry.eventType === "message_reaction_count") {
    const chat = isRecord(entry.value.chat) ? entry.value.chat : null;
    const chatId = chat ? readStringOrNumber(chat.id) : null;
    const messageId = readStringOrNumber(entry.value.message_id);
    if (chatId && messageId) {
      const user = isRecord(entry.value.user) ? entry.value.user : null;
      const actorChat = isRecord(entry.value.actor_chat) ? entry.value.actor_chat : null;
      const updatedAt = updatedAtForPayload(entry.value);
      pushModelWrite(writes, "TelegramChat", "fetch-updates", buildTelegramChatRecord(chat, updatedAt));
      pushModelWrite(writes, "TelegramReaction", "fetch-updates", {
        id: `${chatId}:${messageId}:${updateId}`,
        updateId,
        chatId,
        messageId,
        userId: user ? readStringOrNumber(user.id) : null,
        actorChatId: actorChat ? readStringOrNumber(actorChat.id) : null,
        updatedAt,
        oldReactionJson: JSON.stringify(entry.value.old_reaction ?? []),
        newReactionJson: JSON.stringify(entry.value.new_reaction ?? entry.value.reactions ?? []),
        raw: entry.value,
      });
    }
  }

  return writes.filter((write) => write.records.length > 0);
}

async function writeTelegramWebhookRecords(input: {
  workspaceId: string;
  connectionId: string;
  providerConfigKey?: string | null;
  update: unknown;
  normalized: TelegramNormalizedMessage;
  deps: TelegramWebhookDependencies;
}): Promise<TelegramRelayfileWriteSummary | undefined> {
  const modelWrites = buildTelegramWebhookModelWrites(input.update, input.normalized);
  if (modelWrites.length === 0) return undefined;

  const clientFactory = input.deps.relayfileClientFactory ?? createGitHubRelayfileClient;
  const writeBatch = input.deps.writeBatch ?? writeBatchToRelayfile;
  const client = clientFactory(input.workspaceId);
  const summary: TelegramRelayfileWriteSummary = { written: 0, deleted: 0, errors: 0 };

  for (const modelWrite of modelWrites) {
    const result = await writeBatch(
      client,
      modelWrite.records,
      createWebhookSyncJob({
        workspaceId: input.workspaceId,
        connectionId: input.connectionId,
        providerConfigKey: input.providerConfigKey || "telegram-relay",
        provider: TELEGRAM_PROVIDER,
        syncName: modelWrite.syncName,
        model: modelWrite.model,
      }),
      {
        materializeContract: true,
        materializeAuxiliaryFiles: true,
      },
    );
    summary.written += result.written;
    summary.deleted += result.deleted;
    summary.errors += result.errors;
  }

  return summary;
}

function readTelegramUpdateEntry(update: Record<string, unknown>): {
  eventType: string;
  value: Record<string, unknown>;
} | null {
  const supportedKeys = [
    "message",
    "edited_message",
    "channel_post",
    "edited_channel_post",
    "business_message",
    "edited_business_message",
    "guest_message",
    "callback_query",
    "inline_query",
    "chosen_inline_result",
    "message_reaction",
    "message_reaction_count",
    "poll",
    "poll_answer",
    "my_chat_member",
    "chat_member",
    "chat_join_request",
    "chat_boost",
    "removed_chat_boost",
    "managed_bot",
  ];

  for (const key of supportedKeys) {
    const value = update[key];
    if (isRecord(value)) {
      return { eventType: key, value };
    }
  }

  return null;
}

function timingSafeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function deriveTelegramWebhookSecret(input: {
  connectionId: string;
  nangoSecretKey?: string | null;
}): string {
  const secretKey = input.nangoSecretKey ?? getNangoSecretKey();
  if (!hasContent(secretKey)) {
    throw new Error("NANGO_SECRET_KEY is required to derive Telegram webhook secrets.");
  }

  return createHmac("sha256", secretKey)
    .update(`telegram-webhook:${input.connectionId}`)
    .digest("base64url");
}

export function verifyTelegramWebhookSecret(input: {
  connectionId: string;
  provided: string | null | undefined;
  nangoSecretKey?: string | null;
}): boolean {
  if (!hasContent(input.provided)) {
    return false;
  }

  const expected = deriveTelegramWebhookSecret({
    connectionId: input.connectionId,
    nangoSecretKey: input.nangoSecretKey,
  });
  return timingSafeEquals(expected, input.provided.trim());
}

export function telegramWebhookUrl(connectionId: string): string {
  const origin = getConfiguredAppOrigin();
  return `${origin}/api/v1/webhooks/telegram/${encodeURIComponent(connectionId)}`;
}

export function normalizeTelegramUpdate(
  update: unknown,
): TelegramNormalizedMessage | null {
  if (!isRecord(update)) {
    return null;
  }

  const entry = readTelegramUpdateEntry(update);
  if (!entry) {
    return null;
  }

  const updateId = update.update_id;
  if (typeof updateId !== "string" && typeof updateId !== "number") {
    return null;
  }

  if (entry.eventType === "callback_query") {
    const callbackId = entry.value['id'];
    const message = isRecord(entry.value['message']) ? entry.value['message'] : null;
    const chat = isRecord(message?.['chat']) ? message['chat'] : null;
    const from = isRecord(entry.value['from']) ? entry.value['from'] : null;
    if (typeof callbackId !== "string" || callbackId.trim().length === 0) {
      return null;
    }

    const chatId = chat?.['id'];
    const messageId = message?.['message_id'];
    const fromUserId = from?.['id'];
    const username = from?.['username'];
    const normalized = {
      updateId,
      eventType: TELEGRAM_CALLBACK_QUERY_EVENT,
      callbackQueryId: callbackId,
      data: entry.value['data'],
      ...(typeof chatId === "string" || typeof chatId === "number" ? { chatId } : {}),
      ...(typeof messageId === "string" || typeof messageId === "number" ? { messageId } : {}),
      ...(typeof fromUserId === "string" || typeof fromUserId === "number"
        ? { fromUserId }
        : {}),
      ...(typeof username === "string" && username.trim().length > 0 ? { username } : {}),
    };

    return {
      ...normalized,
      path: `/telegram/callback-queries/${encodeURIComponent(callbackId)}`,
      payload: {
        ...update,
        telegram: normalized,
      },
    };
  }

  if (entry.eventType === "inline_query") {
    const inlineQueryId = entry.value['id'];
    const from = isRecord(entry.value['from']) ? entry.value['from'] : null;
    if (typeof inlineQueryId !== "string" || inlineQueryId.trim().length === 0) {
      return null;
    }

    const fromUserId = from?.['id'];
    const username = from?.['username'];
    const query = entry.value['query'];
    const normalized = {
      updateId,
      eventType: TELEGRAM_INLINE_QUERY_EVENT,
      inlineQueryId,
      ...(typeof query === "string" ? { text: query } : {}),
      ...(typeof fromUserId === "string" || typeof fromUserId === "number"
        ? { fromUserId }
        : {}),
      ...(typeof username === "string" && username.trim().length > 0 ? { username } : {}),
    };

    return {
      ...normalized,
      path: `/telegram/inline-queries/${encodeURIComponent(inlineQueryId)}`,
      payload: {
        ...update,
        telegram: normalized,
      },
    };
  }

  if (entry.eventType === "message_reaction" || entry.eventType === "message_reaction_count") {
    const chat = isRecord(entry.value['chat']) ? entry.value['chat'] : null;
    const chatId = chat?.['id'];
    const messageId = entry.value['message_id'];
    if (
      (typeof chatId !== "string" && typeof chatId !== "number") ||
      (typeof messageId !== "string" && typeof messageId !== "number")
    ) {
      return null;
    }

    const normalized = {
      updateId,
      eventType: TELEGRAM_REACTION_EVENT,
      chatId,
      messageId,
    };

    return {
      ...normalized,
      path: `/telegram/chats/${encodeURIComponent(String(chatId))}/messages/${encodeURIComponent(String(messageId))}/reactions`,
      payload: {
        ...update,
        telegram: normalized,
      },
    };
  }

  const message = readTelegramMessage(update);
  const chat = isRecord(message?.chat) ? message.chat : null;
  if (!message || !chat) {
    return null;
  }

  const chatId = chat.id;
  const messageId = message.message_id;
  const text = typeof message.text === "string"
    ? message.text
    : typeof message.caption === "string"
      ? message.caption
      : undefined;
  if (
    (typeof chatId !== "string" && typeof chatId !== "number") ||
    (typeof messageId !== "string" && typeof messageId !== "number")
  ) {
    return null;
  }

  const from = isRecord(message.from) ? message.from : null;
  const fromUserId = from?.id;
  const username = from?.username;
  const normalized = {
    updateId,
    eventType: TELEGRAM_MESSAGE_EVENT,
    chatId,
    messageId,
    ...(typeof text === "string" ? { text } : {}),
    ...(typeof fromUserId === "string" || typeof fromUserId === "number"
      ? { fromUserId }
      : {}),
    ...(typeof username === "string" && username.trim().length > 0
      ? { username }
      : {}),
  };

  return {
    ...normalized,
    path: `/telegram/chats/${encodeURIComponent(String(chatId))}/messages/${encodeURIComponent(String(messageId))}`,
    payload: {
      ...update,
      telegram: normalized,
    },
  };
}

export async function handleTelegramWebhookUpdate(
  input: {
    connectionId: string;
    secretToken: string | null | undefined;
    update: unknown;
  },
  deps: TelegramWebhookDependencies = {},
): Promise<TelegramWebhookResult> {
  let verified = false;
  try {
    verified = verifyTelegramWebhookSecret({
      connectionId: input.connectionId,
      provided: input.secretToken,
      nangoSecretKey: deps.nangoSecretKey,
    });
  } catch (error) {
    await logger.error("Telegram webhook secret verification failed", {
      area: "telegram-webhook",
      connectionId: input.connectionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      status: "configuration_error",
      error: "Telegram webhook secret verification is not configured.",
    };
  }

  if (!verified) {
    return {
      ok: false,
      status: "unauthorized",
      error: "Invalid Telegram webhook secret token.",
    };
  }

  const normalized = normalizeTelegramUpdate(input.update);
  if (!normalized) {
    return { ok: true, status: "ignored" };
  }

  const findIntegration =
    deps.findIntegrationByConnection ?? findWorkspaceIntegrationByConnection;
  const integration = await findIntegration(TELEGRAM_PROVIDER, input.connectionId);
  if (!integration) {
    await logger.warn("Telegram webhook has no workspace integration", {
      area: "telegram-webhook",
      connectionId: input.connectionId,
      updateId: normalized.updateId,
    });
    return {
      ok: false,
      status: "integration_not_found",
      error: "Telegram integration not found for connection.",
    };
  }

  const deliveryId = `telegram:${input.connectionId}:${normalized.updateId}`;
  const relayfileWrite = await writeTelegramWebhookRecords({
    workspaceId: integration.workspaceId,
    connectionId: input.connectionId,
    providerConfigKey: integration.providerConfigKey,
    update: input.update,
    normalized,
    deps,
  }).catch(async (error: unknown) => {
    await logger.error("Telegram webhook Relayfile write failed; continuing fanout", {
      area: "telegram-webhook",
      workspaceId: integration.workspaceId,
      connectionId: input.connectionId,
      updateId: normalized.updateId,
      eventType: normalized.eventType,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  });
  const dispatchEvent = deps.dispatchEvent ?? dispatchIntegrationWatchEvent;
  const dispatch = await dispatchEvent({
    workspaceId: integration.workspaceId,
    provider: TELEGRAM_PROVIDER,
    eventType: normalized.eventType,
    connectionId: input.connectionId,
    deliveryId,
    paths: [normalized.path],
    payload: normalized.payload,
  });

  return {
    ok: true,
    status: "dispatched",
    workspaceId: integration.workspaceId,
    deliveryId,
    dispatch,
    ...(relayfileWrite ? { relayfileWrite } : {}),
  };
}

function telegramMessagePayload(input: TelegramSendMessageInput): Record<string, unknown> {
  return {
    chat_id: input.chatId,
    text: input.text,
    ...(input.parseMode ? { parse_mode: input.parseMode } : {}),
    ...(input.disableWebPagePreview !== undefined
      ? { disable_web_page_preview: input.disableWebPagePreview }
      : {}),
    ...(input.disableNotification !== undefined
      ? { disable_notification: input.disableNotification }
      : {}),
    ...(input.replyToMessageId !== undefined
      ? { reply_to_message_id: input.replyToMessageId }
      : {}),
    ...(input.replyMarkup !== undefined ? { reply_markup: input.replyMarkup } : {}),
  };
}

function providerConfigForIntegration(integration: WorkspaceIntegrationRecord): string {
  return integration.providerConfigKey?.trim() || getProviderConfigKey(TELEGRAM_PROVIDER);
}

export async function sendTelegramRuntimeMessage(
  input: TelegramSendMessageInput,
): Promise<TelegramEgressResult> {
  const integration = await getWorkspaceIntegration(input.workspaceId, TELEGRAM_PROVIDER);
  if (!integration) {
    return { ok: false, error: "Telegram is not connected for this workspace." };
  }

  try {
    const response = await proxyRequest<TelegramApiResponse<TelegramSendMessageResult>>({
      method: "POST",
      endpoint: "/sendMessage",
      providerConfigKey: providerConfigForIntegration(integration),
      connectionId: integration.connectionId,
      data: telegramMessagePayload(input),
    });
    if (response.ok !== true) {
      return {
        ok: false,
        error: response.description || "Telegram sendMessage failed.",
      };
    }

    return {
      ok: true,
      ...(typeof response.result?.message_id === "number"
        ? { messageId: response.result.message_id }
        : {}),
      ...(typeof response.result?.chat?.id === "string" ||
      typeof response.result?.chat?.id === "number"
        ? { chatId: response.result.chat.id }
        : {}),
      raw: response,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Telegram sendMessage failed.",
    };
  }
}
