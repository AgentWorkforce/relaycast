import "server-only";

import { proxyRequest } from "@/lib/integrations/nango-slack";

type TelegramProxyMethod = "GET" | "POST";

type TelegramProxyConfig = {
  method: TelegramProxyMethod;
  endpoint: string;
  providerConfigKey: string;
  connectionId: string;
  params?: Record<string, string>;
  data?: unknown;
};

export type TelegramApiResponse<T = unknown> = {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: Record<string, unknown>;
};

export type TelegramBotCommand = {
  command: string;
  description: string;
};

export type TelegramInlineKeyboardMarkup = {
  inline_keyboard: Array<Array<Record<string, unknown>>>;
};

export type TelegramReplyMarkup =
  | TelegramInlineKeyboardMarkup
  | { keyboard: Array<Array<Record<string, unknown>>>; [key: string]: unknown }
  | { remove_keyboard: true; [key: string]: unknown }
  | { force_reply: true; [key: string]: unknown };

export type TelegramSendMessageInput = {
  chat_id: number | string;
  text: string;
  parse_mode?: "MarkdownV2" | "HTML" | "Markdown";
  entities?: unknown[];
  link_preview_options?: Record<string, unknown>;
  disable_notification?: boolean;
  protect_content?: boolean;
  message_thread_id?: number;
  reply_parameters?: Record<string, unknown>;
  reply_markup?: TelegramReplyMarkup;
};

export type TelegramMenuButton =
  | { type: "commands" }
  | { type: "default" }
  | { type: "web_app"; text: string; web_app: { url: string } };

export type TelegramInlineQueryResult = Record<string, unknown> & {
  type: string;
  id: string;
};

export async function telegramProxyRequest<T = unknown>(
  config: TelegramProxyConfig,
): Promise<TelegramApiResponse<T>> {
  return proxyRequest<TelegramApiResponse<T>>(config);
}

export async function getTelegramBotIdentity(
  connectionId: string,
  providerConfigKey: string,
): Promise<TelegramApiResponse> {
  return telegramProxyRequest({
    method: "GET",
    endpoint: "/getMe",
    providerConfigKey,
    connectionId,
  });
}

export async function sendTelegramMessage(
  connectionId: string,
  providerConfigKey: string,
  input: TelegramSendMessageInput,
): Promise<TelegramApiResponse> {
  return telegramProxyRequest({
    method: "POST",
    endpoint: "/sendMessage",
    providerConfigKey,
    connectionId,
    data: input,
  });
}

export async function setTelegramCommands(
  connectionId: string,
  providerConfigKey: string,
  input: {
    commands: TelegramBotCommand[];
    scope?: Record<string, unknown>;
    language_code?: string;
  },
): Promise<TelegramApiResponse<boolean>> {
  return telegramProxyRequest<boolean>({
    method: "POST",
    endpoint: "/setMyCommands",
    providerConfigKey,
    connectionId,
    data: input,
  });
}

export async function setTelegramChatMenuButton(
  connectionId: string,
  providerConfigKey: string,
  input: {
    chat_id?: number | string;
    menu_button?: TelegramMenuButton;
  },
): Promise<TelegramApiResponse<boolean>> {
  return telegramProxyRequest<boolean>({
    method: "POST",
    endpoint: "/setChatMenuButton",
    providerConfigKey,
    connectionId,
    data: input,
  });
}

export async function answerTelegramInlineQuery(
  connectionId: string,
  providerConfigKey: string,
  input: {
    inline_query_id: string;
    results: TelegramInlineQueryResult[];
    cache_time?: number;
    is_personal?: boolean;
    next_offset?: string;
    button?: Record<string, unknown>;
  },
): Promise<TelegramApiResponse<boolean>> {
  return telegramProxyRequest<boolean>({
    method: "POST",
    endpoint: "/answerInlineQuery",
    providerConfigKey,
    connectionId,
    data: input,
  });
}

export async function answerTelegramCallbackQuery(
  connectionId: string,
  providerConfigKey: string,
  input: {
    callback_query_id: string;
    text?: string;
    show_alert?: boolean;
    url?: string;
    cache_time?: number;
  },
): Promise<TelegramApiResponse<boolean>> {
  return telegramProxyRequest<boolean>({
    method: "POST",
    endpoint: "/answerCallbackQuery",
    providerConfigKey,
    connectionId,
    data: input,
  });
}

export async function setTelegramMessageReaction(
  connectionId: string,
  providerConfigKey: string,
  input: {
    chat_id: number | string;
    message_id: number;
    reaction?: Array<Record<string, unknown>>;
    is_big?: boolean;
  },
): Promise<TelegramApiResponse<boolean>> {
  return telegramProxyRequest<boolean>({
    method: "POST",
    endpoint: "/setMessageReaction",
    providerConfigKey,
    connectionId,
    data: input,
  });
}
