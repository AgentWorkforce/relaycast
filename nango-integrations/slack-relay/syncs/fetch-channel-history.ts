import { createSync } from 'nango';
import { z } from 'zod';
import { isSupportedSlackMessageSubtype } from '../shared/message-subtypes.js';

const SlackMessage = z.object({
    id: z.string(),
    channel: z.string(),
    channel_name: z.string(),
    channel_is_private: z.boolean(),
    user: z.string(),
    user_name: z.string(),
    user_real_name: z.string(),
    user_display_name: z.string(),
    user_email: z.string(),
    user_is_bot: z.boolean(),
    text: z.string(),
    ts: z.string(),
    thread_ts: z.string().nullable(),
    is_thread_parent: z.boolean(),
    reply_count: z.number().int().nonnegative(),
    reply_users_count: z.number().int().nonnegative(),
    edited_ts: z.string().nullable(),
    permalink: z.string(),
    has_files: z.boolean(),
    file_count: z.number().int().nonnegative(),
    reactions_json: z.string(),
    mentions_json: z.string()
});

const Checkpoint = z.object({
    perChannelTsJson: z.string()
});

const SyncMetadata = z.object({
    lookbackDays: z.number().int().positive().max(365).optional(),
    maxChannels: z.number().int().positive().max(5000).optional()
});

type SlackMessageRecord = z.infer<typeof SlackMessage>;
type CheckpointRecord = z.infer<typeof Checkpoint>;
type SyncMetadataRecord = z.infer<typeof SyncMetadata>;

type SlackChannelRecordType = {
    id: string;
    name: string;
    is_private: boolean;
};

type SlackUserRecord = {
    id: string;
    name: string;
    real_name: string;
    display_name: string;
    email: string;
    is_bot: boolean;
};

type SlackChannelRaw = {
    id?: string;
    name?: string;
    name_normalized?: string;
    is_member?: boolean;
    is_private?: boolean;
};

type SlackFileRaw = {
    id?: string;
};

type SlackReactionRaw = {
    name?: string;
    count?: number;
    users?: string[];
};

type SlackHistoryMessage = {
    ts?: string;
    user?: string;
    bot_id?: string;
    text?: string;
    thread_ts?: string;
    reply_count?: number;
    reply_users_count?: number;
    subtype?: string;
    edited?: { ts?: string };
    files?: SlackFileRaw[];
    reactions?: SlackReactionRaw[];
};

type SlackWebhookMessage = SlackHistoryMessage & {
    channel?: string;
};

type SlackWebhookEvent = {
    type?: string;
    subtype?: string;
    channel?: string | SlackChannelRaw;
    user?: string | { id?: string };
    bot_id?: string;
    text?: string;
    ts?: string;
    thread_ts?: string;
    event_ts?: string;
    deleted_ts?: string;
    message?: SlackWebhookMessage;
    previous_message?: SlackWebhookMessage;
};

type SlackEventPayload = {
    event?: SlackWebhookEvent;
};

const CHANNEL_LIST_LIMIT = 200;
const HISTORY_LIMIT = 200;
const MESSAGE_MODEL = 'SlackMessage';
const CHANNEL_MODEL = 'SlackChannel';
const USER_MODEL = 'SlackUser';
const DEFAULT_LOOKBACK_DAYS = 7;
const USER_MENTION_PATTERN = /<@([A-Z0-9]+)(?:\|[^>]+)?>/g;
const CHANNEL_MENTION_PATTERN = /<#([A-Z0-9]+)(?:\|[^>]+)?>/g;
const MESSAGE_WEBHOOK_SUBSCRIPTIONS = ['app_mention', 'message'] as const;

function nowMinusDaysAsSlackTs(days: number): string {
    return Math.floor((Date.now() - days * 24 * 60 * 60 * 1000) / 1000).toString();
}

function toComparableTs(ts?: string | null): number {
    if (!ts) {
        return 0;
    }

    const parsed = Number.parseFloat(ts);
    return Number.isFinite(parsed) ? parsed : 0;
}

function maxTs(left?: string | null, right?: string | null): string | null {
    if (!left) {
        return right ?? null;
    }

    if (!right) {
        return left;
    }

    return toComparableTs(left) >= toComparableTs(right) ? left : right;
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function asStringRecord(value: unknown): Record<string, string> {
    if (!value || typeof value !== 'object') {
        return {};
    }

    return Object.fromEntries(
        Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    );
}

function parsePerChannelTs(checkpoint: CheckpointRecord | null): Record<string, string> {
    if (!checkpoint) {
        return {};
    }

    try {
        return asStringRecord(JSON.parse(checkpoint.perChannelTsJson) as unknown);
    } catch {
        return {};
    }
}

function serializePerChannelTs(perChannelTs: Record<string, string>): CheckpointRecord {
    return {
        perChannelTsJson: JSON.stringify(perChannelTs)
    };
}

function normalizeChannel(raw: SlackChannelRaw): SlackChannelRecordType | null {
    if (!raw.id) {
        return null;
    }

    return {
        id: raw.id,
        name: raw.name ?? raw.name_normalized ?? '',
        is_private: raw.is_private === true
    };
}

function normalizeCachedChannel(raw: unknown): SlackChannelRecordType | null {
    if (!raw || typeof raw !== 'object') {
        return null;
    }

    const record = raw as Partial<{ id: string; name: string; is_private: boolean }>;
    if (!record.id || typeof record.id !== 'string') {
        return null;
    }

    return {
        id: record.id,
        name: typeof record.name === 'string' ? record.name : '',
        is_private: record.is_private === true
    };
}

function normalizeCachedUser(raw: unknown): SlackUserRecord | null {
    if (!raw || typeof raw !== 'object') {
        return null;
    }

    const record = raw as Partial<SlackUserRecord>;
    if (!record.id || typeof record.id !== 'string') {
        return null;
    }

    return {
        id: record.id,
        name: typeof record.name === 'string' ? record.name : '',
        real_name: typeof record.real_name === 'string' ? record.real_name : '',
        display_name: typeof record.display_name === 'string' ? record.display_name : '',
        email: typeof record.email === 'string' ? record.email : '',
        is_bot: record.is_bot === true
    };
}

function extractMentions(text: string): { users: string[]; channels: string[] } {
    const users = new Set<string>();
    const channels = new Set<string>();

    for (const match of text.matchAll(USER_MENTION_PATTERN)) {
        if (match[1]) {
            users.add(match[1]);
        }
    }

    for (const match of text.matchAll(CHANNEL_MENTION_PATTERN)) {
        if (match[1]) {
            channels.add(match[1]);
        }
    }

    return {
        users: Array.from(users),
        channels: Array.from(channels)
    };
}

function serializeReactions(reactions?: SlackReactionRaw[]): string {
    if (!Array.isArray(reactions) || reactions.length === 0) {
        return '[]';
    }

    const normalized = reactions
        .map((reaction) => ({
            name: reaction.name ?? '',
            count: typeof reaction.count === 'number' ? reaction.count : 0,
            users: Array.isArray(reaction.users) ? reaction.users : []
        }))
        .filter((reaction) => reaction.name.length > 0);

    return JSON.stringify(normalized);
}

function buildPermalink(teamDomain: string, channelId: string, ts: string, threadTs: string | null): string {
    if (!teamDomain) {
        return '';
    }

    const tsToken = `p${ts.replace('.', '')}`;
    const base = `https://${teamDomain}.slack.com/archives/${channelId}/${tsToken}`;
    if (threadTs && threadTs !== ts) {
        return `${base}?thread_ts=${threadTs}&cid=${channelId}`;
    }
    return base;
}

function extractDomainFromSlackUrl(url: string | undefined): string {
    if (!url) {
        return '';
    }
    const match = /^https?:\/\/([^.]+)\.slack\.com/i.exec(url);
    return match?.[1] ?? '';
}

function buildMessageRecord(
    channel: SlackChannelRecordType,
    message: SlackHistoryMessage,
    userRecord: SlackUserRecord | null,
    permalink: string
): SlackMessageRecord | null {
    if (!message.ts || !isSupportedSlackMessageSubtype(message.subtype)) {
        return null;
    }

    const threadTs = message.thread_ts ?? null;
    const isThreadParent = Boolean(threadTs && threadTs === message.ts);
    const files = Array.isArray(message.files) ? message.files : [];
    const mentions = extractMentions(message.text ?? '');
    const userId = message.user ?? message.bot_id ?? 'unknown';

    return {
        id: `${channel.id}-${message.ts}`,
        channel: channel.id,
        channel_name: channel.name,
        channel_is_private: channel.is_private,
        user: userId,
        user_name: userRecord?.name ?? '',
        user_real_name: userRecord?.real_name ?? '',
        user_display_name: userRecord?.display_name ?? '',
        user_email: userRecord?.email ?? '',
        user_is_bot: userRecord?.is_bot ?? Boolean(message.bot_id),
        text: message.text ?? '',
        ts: message.ts,
        thread_ts: threadTs,
        is_thread_parent: isThreadParent,
        reply_count: message.reply_count ?? 0,
        reply_users_count: message.reply_users_count ?? 0,
        edited_ts: message.edited?.ts ?? null,
        permalink,
        has_files: files.length > 0,
        file_count: files.length,
        reactions_json: serializeReactions(message.reactions),
        mentions_json: JSON.stringify(mentions)
    };
}

function readChannelId(value: string | SlackChannelRaw | undefined): string | null {
    if (typeof value === 'string' && value.trim()) {
        return value;
    }

    if (value && typeof value === 'object') {
        return value.id ?? null;
    }

    return null;
}

function readUserId(value: string | { id?: string } | undefined): string | null {
    if (typeof value === 'string' && value.trim()) {
        return value;
    }

    if (value && typeof value === 'object') {
        return value.id ?? null;
    }

    return null;
}

function materializeWebhookMessageEvent(event: SlackWebhookEvent): {
    channelId: string;
    deleted: boolean;
    message: SlackHistoryMessage;
} | null {
    if (event.type !== 'message' && event.type !== 'app_mention') {
        return null;
    }

    const changedMessage = event.subtype === 'message_changed' ? event.message : undefined;
    const previousMessage = event.previous_message;
    const source = changedMessage ?? previousMessage ?? event;
    const channelId = readChannelId(event.channel) ?? readChannelId(source.channel);
    const ts = source.ts ?? event.deleted_ts ?? event.ts ?? event.event_ts;

    if (!channelId || !ts) {
        return null;
    }

    const sourceMessage = source as Partial<SlackHistoryMessage>;
    const message: SlackHistoryMessage = { ts };
    const threadTs = sourceMessage.thread_ts ?? event.thread_ts;
    const userId = readUserId(source.user) ?? readUserId(event.user);
    const botId = sourceMessage.bot_id ?? event.bot_id;
    const text = sourceMessage.text ?? event.text;
    if (threadTs) {
        message.thread_ts = threadTs;
    }
    if (userId) {
        message.user = userId;
    }
    if (botId) {
        message.bot_id = botId;
    }
    if (text) {
        message.text = text;
    }
    if (typeof sourceMessage.reply_count === 'number') {
        message.reply_count = sourceMessage.reply_count;
    }
    if (typeof sourceMessage.reply_users_count === 'number') {
        message.reply_users_count = sourceMessage.reply_users_count;
    }
    if (sourceMessage.edited) {
        message.edited = sourceMessage.edited;
    }
    if (Array.isArray(sourceMessage.files)) {
        message.files = sourceMessage.files;
    }
    if (Array.isArray(sourceMessage.reactions)) {
        message.reactions = sourceMessage.reactions;
    }

    return {
        channelId,
        deleted: event.subtype === 'message_deleted',
        message
    };
}

async function loadUsersById(nango: any): Promise<Map<string, SlackUserRecord>> {
    const users = new Map<string, SlackUserRecord>();
    for await (const raw of nango.listRecords(USER_MODEL)) {
        const user = normalizeCachedUser(raw);
        if (!user) {
            continue;
        }
        users.set(user.id, user);
    }
    return users;
}

async function loadChannelsById(nango: any): Promise<Map<string, SlackChannelRecordType>> {
    const channels = new Map<string, SlackChannelRecordType>();
    for await (const raw of nango.listRecords(CHANNEL_MODEL)) {
        const channel = normalizeCachedChannel(raw);
        if (!channel) {
            continue;
        }
        channels.set(channel.id, channel);
    }
    return channels;
}

const sync = createSync({
    description:
        'Sync Slack channel messages from channels the Slack app has joined. Emits SlackMessage records and resolves users/channels from dedicated SlackUser/SlackChannel syncs.',
    version: '2.0.0',
    endpoints: [{ method: 'GET', path: '/slack-relay/channel-messages', group: 'Slack' }],
    frequency: 'every hour',
    autoStart: true,
    syncType: 'incremental',
    metadata: SyncMetadata,
    checkpoint: Checkpoint,
    models: {
        SlackMessage
    },
    webhookSubscriptions: [...MESSAGE_WEBHOOK_SUBSCRIPTIONS],

    exec: async (nango) => {
        await nango.setMergingStrategy({ strategy: 'ignore_if_modified_after' }, MESSAGE_MODEL);

        const metadata = (await nango.getMetadata<SyncMetadataRecord>()) as SyncMetadataRecord | null;
        const lookbackDays = metadata?.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
        const maxChannels = metadata?.maxChannels ?? 1000;
        const checkpoint = (await nango.getCheckpoint()) as CheckpointRecord | null;
        const perChannelTs: Record<string, string> = parsePerChannelTs(checkpoint);
        const lookbackTs = nowMinusDaysAsSlackTs(lookbackDays);

        const usersById = await loadUsersById(nango);
        const channelsById = await loadChannelsById(nango);

        let teamDomain = '';
        try {
            // Slack API docs: https://api.slack.com/methods/auth.test
            const authResponse = await nango.get({
                endpoint: '/auth.test',
                retries: 3
            });
            const data = authResponse.data as { ok?: boolean; error?: string; url?: string } | undefined;
            teamDomain = extractDomainFromSlackUrl(data?.url);
            if (!teamDomain) {
                await nango.log(
                    `Slack auth.test did not return a usable team URL (ok=${data?.ok}, error=${data?.error ?? 'none'}); permalinks will be empty`,
                    { level: 'warn' }
                );
            }
        } catch (error) {
            await nango.log(
                `Slack auth.test failed: ${toErrorMessage(error)}; permalinks will be empty`,
                { level: 'warn' }
            );
        }

        const channelsToSync: SlackChannelRecordType[] = [];

        try {
            // Slack API docs: https://api.slack.com/methods/conversations.list
            for await (const channelsPage of nango.paginate<SlackChannelRaw>({
                endpoint: '/conversations.list',
                params: {
                    types: 'public_channel,private_channel',
                    exclude_archived: 'true'
                },
                retries: 3,
                paginate: {
                    type: 'cursor',
                    response_path: 'channels',
                    cursor_name_in_request: 'cursor',
                    cursor_path_in_response: 'response_metadata.next_cursor',
                    limit_name_in_request: 'limit',
                    limit: CHANNEL_LIST_LIMIT
                }
            })) {
                for (const raw of channelsPage) {
                    const normalized = normalizeChannel(raw);
                    if (!normalized || raw.is_member !== true) {
                        continue;
                    }

                    const hydrated = channelsById.get(normalized.id) ?? normalized;
                    channelsById.set(hydrated.id, hydrated);

                    if (channelsToSync.length < maxChannels) {
                        channelsToSync.push(hydrated);
                    }
                }
            }
        } catch (error) {
            await nango.log(`Failed to list Slack channels: ${toErrorMessage(error)}`, { level: 'error' });
            throw error;
        }

        for (const channel of channelsToSync) {
            try {
                const previousTs: string | null = perChannelTs[channel.id] ?? null;
                const oldest = maxTs(previousTs, lookbackTs) ?? lookbackTs;
                let newestSeenTs: string | null = previousTs;

                // Slack API docs: https://api.slack.com/methods/conversations.history
                for await (const messagesPage of nango.paginate<SlackHistoryMessage>({
                    endpoint: '/conversations.history',
                    params: {
                        channel: channel.id,
                        oldest
                    },
                    retries: 3,
                    paginate: {
                        type: 'cursor',
                        response_path: 'messages',
                        cursor_name_in_request: 'cursor',
                        cursor_path_in_response: 'response_metadata.next_cursor',
                        limit_name_in_request: 'limit',
                        limit: HISTORY_LIMIT
                    }
                })) {
                    const records: SlackMessageRecord[] = [];

                    for (const message of messagesPage) {
                        if (!message.ts || !isSupportedSlackMessageSubtype(message.subtype)) {
                            continue;
                        }

                        const userId = message.user ?? message.bot_id;
                        const userRecord = userId ? usersById.get(userId) ?? null : null;
                        const permalink = buildPermalink(
                            teamDomain,
                            channel.id,
                            message.ts,
                            message.thread_ts ?? null
                        );
                        const record = buildMessageRecord(channel, message, userRecord, permalink);
                        if (!record) {
                            continue;
                        }

                        records.push(record);
                        newestSeenTs = maxTs(newestSeenTs, record.ts);
                    }

                    if (records.length > 0) {
                        await nango.batchSave(records, MESSAGE_MODEL);
                    }
                }

                if (newestSeenTs) {
                    perChannelTs[channel.id] = newestSeenTs;
                    await nango.saveCheckpoint(serializePerChannelTs(perChannelTs));
                }
            } catch (error) {
                await nango.log(
                    `Failed to sync Slack history for channel ${channel.id}: ${toErrorMessage(error)}`,
                    { level: 'error' }
                );
            }
        }
    },

    onWebhook: async (nango, payload) => {
        await nango.setMergingStrategy({ strategy: 'ignore_if_modified_after' }, MESSAGE_MODEL);

        const webhook = payload as SlackEventPayload;
        const event = webhook.event;
        if (!event) {
            return;
        }

        const messageEvent = materializeWebhookMessageEvent(event);
        if (!messageEvent) {
            return;
        }

        const { channelId, deleted, message } = messageEvent;
        try {
            if (deleted) {
                await nango.batchDelete([{ id: `${channelId}-${message.ts}` }], MESSAGE_MODEL);
                return;
            }

            const usersById = await loadUsersById(nango);
            const channelsById = await loadChannelsById(nango);
            const channel = channelsById.get(channelId) ?? {
                id: channelId,
                name: '',
                is_private: false
            };

            let teamDomain = '';
            try {
                // Slack API docs: https://api.slack.com/methods/auth.test
                const authResponse = await nango.get({
                    endpoint: '/auth.test',
                    retries: 3
                });
                const data = authResponse.data as { url?: string } | undefined;
                teamDomain = extractDomainFromSlackUrl(data?.url);
            } catch {
                teamDomain = '';
            }

            const userId = message.user ?? message.bot_id;
            const userRecord = userId ? usersById.get(userId) ?? null : null;
            const permalink = message.ts
                ? buildPermalink(teamDomain, channelId, message.ts, message.thread_ts ?? null)
                : '';

            const record = buildMessageRecord(channel, message, userRecord, permalink);
            if (!record) {
                return;
            }

            await nango.batchSave([record], MESSAGE_MODEL);

            const checkpoint = (await nango.getCheckpoint()) as CheckpointRecord | null;
            const perChannelTs: Record<string, string> = parsePerChannelTs(checkpoint);
            const newestSeenTs = maxTs(perChannelTs[channelId] ?? null, record.ts);

            if (newestSeenTs) {
                perChannelTs[channelId] = newestSeenTs;
                await nango.saveCheckpoint(serializePerChannelTs(perChannelTs));
            }
        } catch (error) {
            await nango.log(
                `Failed to process Slack webhook for channel ${channelId}: ${toErrorMessage(error)}`,
                { level: 'error' }
            );
            throw error;
        }
    }
});

export default sync;
