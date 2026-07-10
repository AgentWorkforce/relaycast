import { z } from "zod";

export const TELEGRAM_PROXY_ALLOW_LIST = [
  { endpoint: "/getMe", method: "GET" },
  { endpoint: "/getMe", method: "POST" },
  { endpoint: "/logOut", method: "POST" },
  { endpoint: "/close", method: "POST" },
  { endpoint: "/getUpdates", method: "POST" },
  { endpoint: "/setWebhook", method: "POST" },
  { endpoint: "/deleteWebhook", method: "POST" },
  { endpoint: "/getWebhookInfo", method: "GET" },
  { endpoint: "/getWebhookInfo", method: "POST" },
  { endpoint: "/sendMessage", method: "POST" },
  { endpoint: "/sendRichMessage", method: "POST" },
  { endpoint: "/sendRichMessageDraft", method: "POST" },
  { endpoint: "/sendMessageDraft", method: "POST" },
  { endpoint: "/forwardMessage", method: "POST" },
  { endpoint: "/forwardMessages", method: "POST" },
  { endpoint: "/copyMessage", method: "POST" },
  { endpoint: "/copyMessages", method: "POST" },
  { endpoint: "/sendPhoto", method: "POST" },
  { endpoint: "/sendAudio", method: "POST" },
  { endpoint: "/sendDocument", method: "POST" },
  { endpoint: "/sendVideo", method: "POST" },
  { endpoint: "/sendAnimation", method: "POST" },
  { endpoint: "/sendVoice", method: "POST" },
  { endpoint: "/sendVideoNote", method: "POST" },
  { endpoint: "/sendPaidMedia", method: "POST" },
  { endpoint: "/sendMediaGroup", method: "POST" },
  { endpoint: "/sendLocation", method: "POST" },
  { endpoint: "/editMessageLiveLocation", method: "POST" },
  { endpoint: "/stopMessageLiveLocation", method: "POST" },
  { endpoint: "/sendVenue", method: "POST" },
  { endpoint: "/sendContact", method: "POST" },
  { endpoint: "/sendPoll", method: "POST" },
  { endpoint: "/sendChecklist", method: "POST" },
  { endpoint: "/sendDice", method: "POST" },
  { endpoint: "/sendChatAction", method: "POST" },
  { endpoint: "/setMessageReaction", method: "POST" },
  { endpoint: "/deleteMessageReaction", method: "POST" },
  { endpoint: "/deleteAllMessageReactions", method: "POST" },
  { endpoint: "/getUserProfilePhotos", method: "POST" },
  { endpoint: "/getFile", method: "POST" },
  { endpoint: "/banChatMember", method: "POST" },
  { endpoint: "/unbanChatMember", method: "POST" },
  { endpoint: "/restrictChatMember", method: "POST" },
  { endpoint: "/promoteChatMember", method: "POST" },
  { endpoint: "/setChatAdministratorCustomTitle", method: "POST" },
  { endpoint: "/banChatSenderChat", method: "POST" },
  { endpoint: "/unbanChatSenderChat", method: "POST" },
  { endpoint: "/setChatPermissions", method: "POST" },
  { endpoint: "/exportChatInviteLink", method: "POST" },
  { endpoint: "/createChatInviteLink", method: "POST" },
  { endpoint: "/editChatInviteLink", method: "POST" },
  { endpoint: "/createChatSubscriptionInviteLink", method: "POST" },
  { endpoint: "/editChatSubscriptionInviteLink", method: "POST" },
  { endpoint: "/revokeChatInviteLink", method: "POST" },
  { endpoint: "/approveChatJoinRequest", method: "POST" },
  { endpoint: "/declineChatJoinRequest", method: "POST" },
  { endpoint: "/setChatPhoto", method: "POST" },
  { endpoint: "/deleteChatPhoto", method: "POST" },
  { endpoint: "/setChatTitle", method: "POST" },
  { endpoint: "/setChatDescription", method: "POST" },
  { endpoint: "/pinChatMessage", method: "POST" },
  { endpoint: "/unpinChatMessage", method: "POST" },
  { endpoint: "/unpinAllChatMessages", method: "POST" },
  { endpoint: "/leaveChat", method: "POST" },
  { endpoint: "/getChat", method: "POST" },
  { endpoint: "/getChatAdministrators", method: "POST" },
  { endpoint: "/getChatMemberCount", method: "POST" },
  { endpoint: "/getChatMember", method: "POST" },
  { endpoint: "/setChatStickerSet", method: "POST" },
  { endpoint: "/deleteChatStickerSet", method: "POST" },
  { endpoint: "/getForumTopicIconStickers", method: "POST" },
  { endpoint: "/createForumTopic", method: "POST" },
  { endpoint: "/editForumTopic", method: "POST" },
  { endpoint: "/closeForumTopic", method: "POST" },
  { endpoint: "/reopenForumTopic", method: "POST" },
  { endpoint: "/deleteForumTopic", method: "POST" },
  { endpoint: "/unpinAllForumTopicMessages", method: "POST" },
  { endpoint: "/editGeneralForumTopic", method: "POST" },
  { endpoint: "/closeGeneralForumTopic", method: "POST" },
  { endpoint: "/reopenGeneralForumTopic", method: "POST" },
  { endpoint: "/hideGeneralForumTopic", method: "POST" },
  { endpoint: "/unhideGeneralForumTopic", method: "POST" },
  { endpoint: "/unpinAllGeneralForumTopicMessages", method: "POST" },
  { endpoint: "/answerCallbackQuery", method: "POST" },
  { endpoint: "/answerInlineQuery", method: "POST" },
  { endpoint: "/answerWebAppQuery", method: "POST" },
  { endpoint: "/answerGuestQuery", method: "POST" },
  { endpoint: "/answerChatJoinRequestQuery", method: "POST" },
  { endpoint: "/sendChatJoinRequestWebApp", method: "POST" },
  { endpoint: "/savePreparedInlineMessage", method: "POST" },
  { endpoint: "/savePreparedKeyboardButton", method: "POST" },
  { endpoint: "/editMessageText", method: "POST" },
  { endpoint: "/editMessageCaption", method: "POST" },
  { endpoint: "/editMessageMedia", method: "POST" },
  { endpoint: "/editMessageReplyMarkup", method: "POST" },
  { endpoint: "/editMessageChecklist", method: "POST" },
  { endpoint: "/stopPoll", method: "POST" },
  { endpoint: "/deleteMessage", method: "POST" },
  { endpoint: "/deleteMessages", method: "POST" },
  { endpoint: "/approveSuggestedPost", method: "POST" },
  { endpoint: "/declineSuggestedPost", method: "POST" },
  { endpoint: "/sendSticker", method: "POST" },
  { endpoint: "/getStickerSet", method: "POST" },
  { endpoint: "/getCustomEmojiStickers", method: "POST" },
  { endpoint: "/uploadStickerFile", method: "POST" },
  { endpoint: "/createNewStickerSet", method: "POST" },
  { endpoint: "/addStickerToSet", method: "POST" },
  { endpoint: "/setStickerPositionInSet", method: "POST" },
  { endpoint: "/deleteStickerFromSet", method: "POST" },
  { endpoint: "/replaceStickerInSet", method: "POST" },
  { endpoint: "/setStickerEmojiList", method: "POST" },
  { endpoint: "/setStickerKeywords", method: "POST" },
  { endpoint: "/setStickerMaskPosition", method: "POST" },
  { endpoint: "/setStickerSetTitle", method: "POST" },
  { endpoint: "/setStickerSetThumbnail", method: "POST" },
  { endpoint: "/setCustomEmojiStickerSetThumbnail", method: "POST" },
  { endpoint: "/deleteStickerSet", method: "POST" },
  { endpoint: "/sendInvoice", method: "POST" },
  { endpoint: "/createInvoiceLink", method: "POST" },
  { endpoint: "/answerShippingQuery", method: "POST" },
  { endpoint: "/answerPreCheckoutQuery", method: "POST" },
  { endpoint: "/getMyStarBalance", method: "POST" },
  { endpoint: "/getStarTransactions", method: "POST" },
  { endpoint: "/refundStarPayment", method: "POST" },
  { endpoint: "/editUserStarSubscription", method: "POST" },
  { endpoint: "/sendGame", method: "POST" },
  { endpoint: "/setGameScore", method: "POST" },
  { endpoint: "/getGameHighScores", method: "POST" },
  { endpoint: "/setMyCommands", method: "POST" },
  { endpoint: "/deleteMyCommands", method: "POST" },
  { endpoint: "/getMyCommands", method: "POST" },
  { endpoint: "/setMyName", method: "POST" },
  { endpoint: "/getMyName", method: "POST" },
  { endpoint: "/setMyDescription", method: "POST" },
  { endpoint: "/getMyDescription", method: "POST" },
  { endpoint: "/setMyShortDescription", method: "POST" },
  { endpoint: "/getMyShortDescription", method: "POST" },
  { endpoint: "/setChatMenuButton", method: "POST" },
  { endpoint: "/getChatMenuButton", method: "POST" },
  { endpoint: "/setMyDefaultAdministratorRights", method: "POST" },
  { endpoint: "/getManagedBotAccessSettings", method: "POST" },
  { endpoint: "/setManagedBotAccessSettings", method: "POST" },
] as const;

export type TelegramProxyAllowedRoute = (typeof TELEGRAM_PROXY_ALLOW_LIST)[number];
export type TelegramProxyMethod = TelegramProxyAllowedRoute["method"];
export type TelegramProxyEndpoint = TelegramProxyAllowedRoute["endpoint"];

const allowedRouteKeys = new Set(
  TELEGRAM_PROXY_ALLOW_LIST.map((entry) => `${entry.method}:${entry.endpoint}`),
);

const allowedMethodsByEndpoint = new Map<string, TelegramProxyMethod[]>();
for (const entry of TELEGRAM_PROXY_ALLOW_LIST) {
  const existing = allowedMethodsByEndpoint.get(entry.endpoint);
  if (existing) {
    existing.push(entry.method);
  } else {
    allowedMethodsByEndpoint.set(entry.endpoint, [entry.method]);
  }
}

function normalizeRecord(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(value).filter(([key]) => key.trim().length > 0),
  );
}

export function normalizeTelegramProxyEndpoint(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }

  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export const telegramProxyRequestSchema = z
  .object({
    endpoint: z.string().trim().min(1).transform(normalizeTelegramProxyEndpoint),
    method: z.enum(["GET", "POST"]),
    data: z.record(z.string(), z.unknown()).optional().transform(normalizeRecord),
    params: z.record(z.string(), z.string()).optional().transform((value) => {
      if (!value) {
        return undefined;
      }

      return Object.fromEntries(
        Object.entries(value)
          .map(([key, entry]) => [key.trim(), entry.trim()])
          .filter(([key, entry]) => key.length > 0 && entry.length > 0),
      );
    }),
  })
  .strict();

export type TelegramProxyRequestBody = z.infer<typeof telegramProxyRequestSchema>;

export function isAllowedTelegramProxyRoute(
  endpoint: string,
  method: TelegramProxyMethod,
): endpoint is TelegramProxyEndpoint {
  return allowedRouteKeys.has(`${method}:${normalizeTelegramProxyEndpoint(endpoint)}`);
}

export function getAllowedTelegramProxyMethods(
  endpoint: string,
): TelegramProxyMethod[] {
  return allowedMethodsByEndpoint.get(normalizeTelegramProxyEndpoint(endpoint)) ?? [];
}
