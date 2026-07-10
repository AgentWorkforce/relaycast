import { z } from 'zod';

export const TelegramParseMode = z.enum(['Markdown', 'MarkdownV2', 'HTML']);

export const TelegramSendMessageInput = z.object({
    chatId: z.union([z.string().min(1), z.number()]),
    text: z.string().min(1),
    parseMode: TelegramParseMode.optional(),
    disableWebPagePreview: z.boolean().optional(),
    disableNotification: z.boolean().optional(),
    replyToMessageId: z.union([z.string(), z.number()]).optional(),
    replyMarkup: z.record(z.string(), z.unknown()).optional()
});

export const TelegramSendMessageOutput = z.object({
    ok: z.boolean(),
    messageId: z.number().optional(),
    chatId: z.union([z.string(), z.number()]).optional(),
    raw: z.unknown().optional()
});

export const TelegramSetWebhookInput = z.object({
    url: z.string().url(),
    secretToken: z.string().min(1).max(256).optional(),
    allowedUpdates: z.array(z.string().min(1)).optional(),
    dropPendingUpdates: z.boolean().optional(),
    maxConnections: z.number().int().min(1).max(100).optional()
});

export const TelegramSetWebhookOutput = z.object({
    ok: z.boolean(),
    result: z.boolean().optional(),
    description: z.string().optional()
});

export const TelegramDeleteWebhookInput = z.object({
    dropPendingUpdates: z.boolean().optional()
});

export const TelegramBotApiMethod = z.enum([
    'getMe',
    'getUpdates',
    'setWebhook',
    'deleteWebhook',
    'getWebhookInfo',
    'sendMessage',
    'sendRichMessage',
    'sendRichMessageDraft',
    'sendMessageDraft',
    'forwardMessage',
    'forwardMessages',
    'copyMessage',
    'copyMessages',
    'sendPhoto',
    'sendAudio',
    'sendDocument',
    'sendVideo',
    'sendAnimation',
    'sendVoice',
    'sendVideoNote',
    'sendPaidMedia',
    'sendMediaGroup',
    'sendLocation',
    'editMessageLiveLocation',
    'stopMessageLiveLocation',
    'sendVenue',
    'sendContact',
    'sendPoll',
    'sendChecklist',
    'sendDice',
    'sendChatAction',
    'setMessageReaction',
    'deleteMessageReaction',
    'deleteAllMessageReactions',
    'answerCallbackQuery',
    'answerInlineQuery',
    'answerWebAppQuery',
    'answerGuestQuery',
    'answerChatJoinRequestQuery',
    'sendChatJoinRequestWebApp',
    'savePreparedInlineMessage',
    'savePreparedKeyboardButton',
    'editMessageText',
    'editMessageCaption',
    'editMessageMedia',
    'editMessageReplyMarkup',
    'editMessageChecklist',
    'stopPoll',
    'deleteMessage',
    'deleteMessages',
    'setMyCommands',
    'deleteMyCommands',
    'getMyCommands',
    'setMyName',
    'getMyName',
    'setMyDescription',
    'getMyDescription',
    'setMyShortDescription',
    'getMyShortDescription',
    'setChatMenuButton',
    'getChatMenuButton',
    'setMyDefaultAdministratorRights',
    'getManagedBotAccessSettings',
    'setManagedBotAccessSettings'
]);

export const TelegramBotApiActionInput = z.object({
    method: TelegramBotApiMethod,
    httpMethod: z.enum(['GET', 'POST']).optional(),
    data: z.record(z.string(), z.unknown()).optional(),
    params: z.record(z.string(), z.string()).optional()
});

export const TelegramBotApiActionOutput = z.object({
    ok: z.boolean(),
    result: z.unknown().optional(),
    raw: z.unknown()
});

export function toTelegramSendMessagePayload(
    input: z.infer<typeof TelegramSendMessageInput>
): Record<string, unknown> {
    return {
        chat_id: input.chatId,
        text: input.text,
        ...(input.parseMode ? { parse_mode: input.parseMode } : {}),
        ...(input.disableWebPagePreview !== undefined ? { disable_web_page_preview: input.disableWebPagePreview } : {}),
        ...(input.disableNotification !== undefined ? { disable_notification: input.disableNotification } : {}),
        ...(input.replyToMessageId !== undefined ? { reply_to_message_id: input.replyToMessageId } : {}),
        ...(input.replyMarkup !== undefined ? { reply_markup: input.replyMarkup } : {})
    };
}

export function toTelegramSetWebhookPayload(
    input: z.infer<typeof TelegramSetWebhookInput>
): Record<string, unknown> {
    return {
        url: input.url,
        ...(input.secretToken ? { secret_token: input.secretToken } : {}),
        ...(input.allowedUpdates ? { allowed_updates: input.allowedUpdates } : {}),
        ...(input.dropPendingUpdates !== undefined ? { drop_pending_updates: input.dropPendingUpdates } : {}),
        ...(input.maxConnections !== undefined ? { max_connections: input.maxConnections } : {})
    };
}

export function toTelegramDeleteWebhookPayload(
    input: z.infer<typeof TelegramDeleteWebhookInput>
): Record<string, unknown> {
    return {
        ...(input.dropPendingUpdates !== undefined ? { drop_pending_updates: input.dropPendingUpdates } : {})
    };
}

export function assertTelegramOk(
    nango: { ActionError: new (input: { type: string; message: string }) => Error },
    response: unknown,
    errorType: string
): Record<string, unknown> {
    if (!response || typeof response !== 'object') {
        throw new nango.ActionError({
            type: errorType,
            message: 'Telegram returned an empty response.'
        });
    }
    const record = response as Record<string, unknown>;
    if (record['ok'] !== true) {
        throw new nango.ActionError({
            type: errorType,
            message: typeof record['description'] === 'string'
                ? record['description']
                : 'Telegram request failed.'
        });
    }
    return record;
}
