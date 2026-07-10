import { createSync } from 'nango';
import { z } from 'zod';
import { assertTelegramOk } from '../actions/telegram-utils.js';

const RawRecord = z.record(z.string(), z.unknown());

const TelegramUpdate = z.object({
    id: z.string(),
    updateId: z.string(),
    eventType: z.string(),
    chatId: z.string().nullable(),
    messageId: z.string().nullable(),
    updatedAt: z.string(),
    raw: RawRecord
});

const TelegramChat = z.object({
    id: z.string(),
    title: z.string(),
    username: z.string(),
    type: z.string(),
    updatedAt: z.string(),
    raw: RawRecord
});

const TelegramMessage = z.object({
    id: z.string(),
    updateId: z.string(),
    eventType: z.string(),
    chatId: z.string(),
    messageId: z.string(),
    messageThreadId: z.string().nullable(),
    chatTitle: z.string(),
    fromId: z.string().nullable(),
    senderChatId: z.string().nullable(),
    date: z.string().nullable(),
    updatedAt: z.string(),
    text: z.string(),
    caption: z.string(),
    mediaGroupId: z.string().nullable(),
    replyToMessageId: z.string().nullable(),
    raw: RawRecord
});

const TelegramCallbackQuery = z.object({
    id: z.string(),
    updateId: z.string(),
    fromId: z.string(),
    chatId: z.string().nullable(),
    messageId: z.string().nullable(),
    inlineMessageId: z.string().nullable(),
    chatInstance: z.string(),
    data: z.string(),
    gameShortName: z.string(),
    updatedAt: z.string(),
    raw: RawRecord
});

const TelegramInlineQuery = z.object({
    id: z.string(),
    updateId: z.string(),
    fromId: z.string(),
    query: z.string(),
    offset: z.string(),
    chatType: z.string(),
    updatedAt: z.string(),
    raw: RawRecord
});

const TelegramReaction = z.object({
    id: z.string(),
    updateId: z.string(),
    chatId: z.string(),
    messageId: z.string(),
    userId: z.string().nullable(),
    actorChatId: z.string().nullable(),
    updatedAt: z.string(),
    oldReactionJson: z.string(),
    newReactionJson: z.string(),
    raw: RawRecord
});

const Checkpoint = z.object({
    offset: z.number().int().nonnegative()
});

const SyncMetadata = z.object({
    allowedUpdates: z.array(z.string().min(1)).optional(),
    limit: z.number().int().positive().max(100).optional()
});

type TelegramUpdateRecord = z.infer<typeof TelegramUpdate>;
type TelegramChatRecord = z.infer<typeof TelegramChat>;
type TelegramMessageRecord = z.infer<typeof TelegramMessage>;
type TelegramCallbackQueryRecord = z.infer<typeof TelegramCallbackQuery>;
type TelegramInlineQueryRecord = z.infer<typeof TelegramInlineQuery>;
type TelegramReactionRecord = z.infer<typeof TelegramReaction>;

type TelegramBatch = {
    updates: TelegramUpdateRecord[];
    chats: TelegramChatRecord[];
    messages: TelegramMessageRecord[];
    callbackQueries: TelegramCallbackQueryRecord[];
    inlineQueries: TelegramInlineQueryRecord[];
    reactions: TelegramReactionRecord[];
};

type NangoForUpdates = {
    getMetadata: () => Promise<unknown>;
    getCheckpoint: () => Promise<unknown>;
    saveCheckpoint: (checkpoint: z.infer<typeof Checkpoint>) => Promise<void>;
    post: (input: { endpoint: string; data?: Record<string, unknown>; retries?: number }) => Promise<{ data: unknown }>;
    batchSave: (records: Record<string, unknown>[], model: string) => Promise<void>;
    log: (message: string, options?: { level?: 'debug' | 'info' | 'warn' | 'error' }) => Promise<void>;
    ActionError: new (input: { type: string; message: string }) => Error;
};

const DEFAULT_ALLOWED_UPDATES = [
    'message',
    'edited_message',
    'channel_post',
    'edited_channel_post',
    'business_connection',
    'business_message',
    'edited_business_message',
    'deleted_business_messages',
    'message_reaction',
    'message_reaction_count',
    'inline_query',
    'chosen_inline_result',
    'callback_query',
    'shipping_query',
    'pre_checkout_query',
    'purchased_paid_media',
    'poll',
    'poll_answer',
    'my_chat_member',
    'chat_member',
    'chat_join_request',
    'chat_boost',
    'removed_chat_boost'
] as const;

const MESSAGE_EVENT_KEYS = [
    'message',
    'edited_message',
    'channel_post',
    'edited_channel_post',
    'business_message',
    'edited_business_message'
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
    const value = record[key];
    return isRecord(value) ? value : null;
}

function readString(record: Record<string, unknown>, key: string): string {
    const value = record[key];
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
    return '';
}

function readNullableString(record: Record<string, unknown>, key: string): string | null {
    const value = readString(record, key);
    return value || null;
}

function eventType(update: Record<string, unknown>): string {
    const key = Object.keys(update).find((candidate) => candidate !== 'update_id' && candidate !== 'id');
    return key ?? 'unknown';
}

function telegramDateToIso(value: unknown): string | null {
    return typeof value === 'number' ? new Date(value * 1000).toISOString() : null;
}

function updatedAtFor(payload: Record<string, unknown> | null): string {
    const date = payload ? telegramDateToIso(payload['date'] ?? payload['edit_date']) : null;
    return date ?? new Date().toISOString();
}

function chatTitle(chat: Record<string, unknown> | null): string {
    if (!chat) return '';
    return readString(chat, 'title') || readString(chat, 'username') || [readString(chat, 'first_name'), readString(chat, 'last_name')]
        .filter(Boolean)
        .join(' ');
}

function normalizeChat(chat: Record<string, unknown> | null, updatedAt: string): TelegramChatRecord | null {
    if (!chat) return null;
    const id = readString(chat, 'id');
    if (!id) return null;
    return {
        id,
        title: chatTitle(chat),
        username: readString(chat, 'username'),
        type: readString(chat, 'type'),
        updatedAt,
        raw: chat
    };
}

function normalizeMessage(
    update: Record<string, unknown>,
    key: string,
    payload: Record<string, unknown>
): { chat: TelegramChatRecord | null; message: TelegramMessageRecord | null } {
    const updateId = readString(update, 'update_id');
    const messageId = readString(payload, 'message_id');
    const chat = readRecord(payload, 'chat');
    const chatId = chat ? readString(chat, 'id') : '';
    const updatedAt = updatedAtFor(payload);
    if (!updateId || !messageId || !chatId) {
        return { chat: normalizeChat(chat, updatedAt), message: null };
    }
    const from = readRecord(payload, 'from');
    const senderChat = readRecord(payload, 'sender_chat');
    const reply = readRecord(payload, 'reply_to_message');

    return {
        chat: normalizeChat(chat, updatedAt),
        message: {
            id: `${chatId}:${messageId}`,
            updateId,
            eventType: key,
            chatId,
            messageId,
            messageThreadId: readNullableString(payload, 'message_thread_id'),
            chatTitle: chatTitle(chat),
            fromId: from ? readNullableString(from, 'id') : null,
            senderChatId: senderChat ? readNullableString(senderChat, 'id') : null,
            date: telegramDateToIso(payload['date']),
            updatedAt,
            text: readString(payload, 'text'),
            caption: readString(payload, 'caption'),
            mediaGroupId: readNullableString(payload, 'media_group_id'),
            replyToMessageId: reply ? readNullableString(reply, 'message_id') : null,
            raw: payload
        }
    };
}

function normalizeCallbackQuery(update: Record<string, unknown>, payload: Record<string, unknown>): TelegramCallbackQueryRecord | null {
    const id = readString(payload, 'id');
    const updateId = readString(update, 'update_id');
    if (!id || !updateId) return null;
    const from = readRecord(payload, 'from');
    const message = readRecord(payload, 'message');
    const chat = message ? readRecord(message, 'chat') : null;
    return {
        id,
        updateId,
        fromId: from ? readString(from, 'id') : '',
        chatId: chat ? readNullableString(chat, 'id') : null,
        messageId: message ? readNullableString(message, 'message_id') : null,
        inlineMessageId: readNullableString(payload, 'inline_message_id'),
        chatInstance: readString(payload, 'chat_instance'),
        data: readString(payload, 'data'),
        gameShortName: readString(payload, 'game_short_name'),
        updatedAt: updatedAtFor(message),
        raw: payload
    };
}

function normalizeInlineQuery(update: Record<string, unknown>, payload: Record<string, unknown>): TelegramInlineQueryRecord | null {
    const id = readString(payload, 'id');
    const updateId = readString(update, 'update_id');
    if (!id || !updateId) return null;
    const from = readRecord(payload, 'from');
    return {
        id,
        updateId,
        fromId: from ? readString(from, 'id') : '',
        query: readString(payload, 'query'),
        offset: readString(payload, 'offset'),
        chatType: readString(payload, 'chat_type'),
        updatedAt: updatedAtFor(null),
        raw: payload
    };
}

function normalizeReaction(update: Record<string, unknown>, payload: Record<string, unknown>): TelegramReactionRecord | null {
    const updateId = readString(update, 'update_id');
    const chat = readRecord(payload, 'chat');
    const chatId = chat ? readString(chat, 'id') : '';
    const messageId = readString(payload, 'message_id');
    if (!updateId || !chatId || !messageId) return null;
    const user = readRecord(payload, 'user');
    const actorChat = readRecord(payload, 'actor_chat');
    return {
        id: `${chatId}:${messageId}:${updateId}`,
        updateId,
        chatId,
        messageId,
        userId: user ? readNullableString(user, 'id') : null,
        actorChatId: actorChat ? readNullableString(actorChat, 'id') : null,
        updatedAt: updatedAtFor(payload),
        oldReactionJson: JSON.stringify(payload['old_reaction'] ?? []),
        newReactionJson: JSON.stringify(payload['new_reaction'] ?? payload['reactions'] ?? []),
        raw: payload
    };
}

function extractChatAndMessageId(update: Record<string, unknown>, key: string): { chatId: string | null; messageId: string | null } {
    const payload = readRecord(update, key);
    if (!payload) return { chatId: null, messageId: null };
    if (MESSAGE_EVENT_KEYS.includes(key as typeof MESSAGE_EVENT_KEYS[number])) {
        const chat = readRecord(payload, 'chat');
        return {
            chatId: chat ? readNullableString(chat, 'id') : null,
            messageId: readNullableString(payload, 'message_id')
        };
    }
    if (key === 'callback_query') {
        const message = readRecord(payload, 'message');
        const chat = message ? readRecord(message, 'chat') : null;
        return {
            chatId: chat ? readNullableString(chat, 'id') : null,
            messageId: message ? readNullableString(message, 'message_id') : null
        };
    }
    if (key === 'message_reaction' || key === 'message_reaction_count') {
        const chat = readRecord(payload, 'chat');
        return {
            chatId: chat ? readNullableString(chat, 'id') : null,
            messageId: readNullableString(payload, 'message_id')
        };
    }
    return { chatId: null, messageId: null };
}

function normalizeTelegramUpdates(rawUpdates: unknown[]): TelegramBatch {
    const batch: TelegramBatch = {
        updates: [],
        chats: [],
        messages: [],
        callbackQueries: [],
        inlineQueries: [],
        reactions: []
    };

    for (const rawUpdate of rawUpdates) {
        if (!isRecord(rawUpdate)) continue;
        const key = eventType(rawUpdate);
        const payload = readRecord(rawUpdate, key);
        const updateId = readString(rawUpdate, 'update_id');
        if (!updateId) continue;

        const { chatId, messageId } = extractChatAndMessageId(rawUpdate, key);
        batch.updates.push({
            id: updateId,
            updateId,
            eventType: key,
            chatId,
            messageId,
            updatedAt: updatedAtFor(payload),
            raw: rawUpdate
        });

        if (payload && MESSAGE_EVENT_KEYS.includes(key as typeof MESSAGE_EVENT_KEYS[number])) {
            const normalized = normalizeMessage(rawUpdate, key, payload);
            if (normalized.chat) batch.chats.push(normalized.chat);
            if (normalized.message) batch.messages.push(normalized.message);
        } else if (payload && key === 'callback_query') {
            const callbackQuery = normalizeCallbackQuery(rawUpdate, payload);
            if (callbackQuery) batch.callbackQueries.push(callbackQuery);
            const message = readRecord(payload, 'message');
            if (message) {
                const normalized = normalizeMessage(rawUpdate, key, message);
                if (normalized.chat) batch.chats.push(normalized.chat);
                if (normalized.message) batch.messages.push(normalized.message);
            }
        } else if (payload && key === 'inline_query') {
            const inlineQuery = normalizeInlineQuery(rawUpdate, payload);
            if (inlineQuery) batch.inlineQueries.push(inlineQuery);
        } else if (payload && (key === 'message_reaction' || key === 'message_reaction_count')) {
            const reaction = normalizeReaction(rawUpdate, payload);
            if (reaction) batch.reactions.push(reaction);
            batch.chats.push(...[normalizeChat(readRecord(payload, 'chat'), updatedAtFor(payload))].filter((chat): chat is TelegramChatRecord => chat !== null));
        }
    }

    return batch;
}

function isWebhookConflict(error: unknown): boolean {
    const text = error instanceof Error ? error.message : String(error);
    return /webhook|conflict|409/i.test(text);
}

const sync = createSync({
    description: 'Optionally polls Telegram Bot API getUpdates and materializes event-sourced chats, messages, reactions, callbacks, inline queries, and raw updates.',
    version: '1.0.0',
    endpoints: [
        { method: 'GET', path: '/telegram-relay/updates', group: 'Telegram' },
        { method: 'GET', path: '/telegram-relay/chats', group: 'Telegram' },
        { method: 'GET', path: '/telegram-relay/messages', group: 'Telegram' },
        { method: 'GET', path: '/telegram-relay/callback-queries', group: 'Telegram' },
        { method: 'GET', path: '/telegram-relay/inline-queries', group: 'Telegram' },
        { method: 'GET', path: '/telegram-relay/reactions', group: 'Telegram' }
    ],
    frequency: 'every 5 minutes',
    autoStart: false,
    syncType: 'incremental',
    metadata: SyncMetadata,
    checkpoint: Checkpoint,
    models: {
        TelegramUpdate,
        TelegramChat,
        TelegramMessage,
        TelegramCallbackQuery,
        TelegramInlineQuery,
        TelegramReaction
    },

    exec: async (nango) => {
        const metadata = SyncMetadata.parse((await nango.getMetadata()) ?? {});
        const parsedCheckpoint = Checkpoint.safeParse(await nango.getCheckpoint());
        const checkpoint: { offset?: number } = parsedCheckpoint.success ? parsedCheckpoint.data : {};

        let rawUpdates: unknown[] = [];
        try {
            const response = await nango.post({
                endpoint: '/getUpdates',
                data: {
                    ...(checkpoint.offset !== undefined ? { offset: checkpoint.offset } : {}),
                    limit: metadata.limit ?? 100,
                    timeout: 0,
                    allowed_updates: metadata.allowedUpdates ?? [...DEFAULT_ALLOWED_UPDATES]
                },
                retries: 3
            });
            const body = assertTelegramOk(nango as unknown as NangoForUpdates, response.data, 'telegram_get_updates_failed');
            rawUpdates = Array.isArray(body['result']) ? body['result'] : [];
        } catch (error) {
            if (isWebhookConflict(error)) {
                await nango.log('Telegram getUpdates skipped because an active webhook is configured. Disable the webhook or leave this optional sync off when webhook delivery owns history.', {
                    level: 'warn'
                });
                return;
            }
            throw error;
        }

        const batch = normalizeTelegramUpdates(rawUpdates);
        if (batch.updates.length > 0) await nango.batchSave(batch.updates, 'TelegramUpdate');
        if (batch.chats.length > 0) await nango.batchSave(batch.chats, 'TelegramChat');
        if (batch.messages.length > 0) await nango.batchSave(batch.messages, 'TelegramMessage');
        if (batch.callbackQueries.length > 0) await nango.batchSave(batch.callbackQueries, 'TelegramCallbackQuery');
        if (batch.inlineQueries.length > 0) await nango.batchSave(batch.inlineQueries, 'TelegramInlineQuery');
        if (batch.reactions.length > 0) await nango.batchSave(batch.reactions, 'TelegramReaction');

        const maxUpdateId = rawUpdates.reduce<number | null>((max, rawUpdate) => {
            if (!isRecord(rawUpdate)) return max;
            const updateId = Number(readString(rawUpdate, 'update_id'));
            if (!Number.isFinite(updateId)) return max;
            return max === null || updateId > max ? updateId : max;
        }, null);

        if (maxUpdateId !== null) {
            await nango.saveCheckpoint({ offset: maxUpdateId + 1 });
        }
    }
});

export default sync;
