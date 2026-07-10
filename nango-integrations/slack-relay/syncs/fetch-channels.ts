import { createSync } from 'nango';
import { z } from 'zod';

const SlackChannel = z.object({
    id: z.string(),
    name: z.string(),
    is_private: z.boolean(),
    is_archived: z.boolean(),
    is_shared: z.boolean(),
    is_member: z.boolean(),
    topic: z.string(),
    purpose: z.string(),
    creator: z.string(),
    created: z.number(),
    member_count: z.number().int().nonnegative()
});

type SlackChannelRecord = z.infer<typeof SlackChannel>;

type SlackChannelRaw = {
    id?: string;
    name?: string;
    name_normalized?: string;
    is_member?: boolean;
    is_private?: boolean;
    is_archived?: boolean;
    is_shared?: boolean;
    creator?: string;
    created?: number;
    num_members?: number;
    topic?: { value?: string };
    purpose?: { value?: string };
};

type SlackChannelEvent = {
    type?: string;
    channel?: string | SlackChannelRaw;
};

type SlackChannelEventPayload = {
    event?: SlackChannelEvent;
};

const CHANNEL_MODEL = 'SlackChannel';
const CHANNEL_LIST_LIMIT = 200;
const CHANNEL_WEBHOOK_EVENTS = [
    'channel_archive',
    'channel_created',
    'channel_deleted',
    'channel_rename',
    'channel_unarchive',
    'group_archive',
    'group_deleted',
    'group_rename',
    'group_unarchive',
    'member_joined_channel',
    'member_left_channel'
] as const;

function normalizeChannel(raw: SlackChannelRaw): SlackChannelRecord | null {
    if (!raw.id) {
        return null;
    }

    return {
        id: raw.id,
        name: raw.name ?? raw.name_normalized ?? '',
        is_private: raw.is_private === true,
        is_archived: raw.is_archived === true,
        is_shared: raw.is_shared === true,
        is_member: raw.is_member === true,
        topic: raw.topic?.value ?? '',
        purpose: raw.purpose?.value ?? '',
        creator: raw.creator ?? '',
        created: typeof raw.created === 'number' ? raw.created : 0,
        member_count: typeof raw.num_members === 'number' ? raw.num_members : 0
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

function isChannelDeleteEvent(eventType: string): boolean {
    return eventType === 'channel_deleted' || eventType === 'group_deleted';
}

function isChannelLifecycleEvent(eventType: string): boolean {
    return eventType.startsWith('channel_')
        || eventType.startsWith('group_')
        || eventType === 'member_joined_channel'
        || eventType === 'member_left_channel';
}

const sync = createSync({
    description: 'Syncs Slack channel metadata via conversations.list and emits SlackChannel records.',
    version: '1.0.0',
    endpoints: [{ method: 'GET', path: '/slack-relay/channels', group: 'Slack' }],
    frequency: 'every 12 hours',
    autoStart: true,
    syncType: 'full',
    metadata: z.void(),
    models: {
        SlackChannel
    },
    webhookSubscriptions: [...CHANNEL_WEBHOOK_EVENTS],

    exec: async (nango) => {
        await nango.setMergingStrategy({ strategy: 'override' }, CHANNEL_MODEL);
        await nango.trackDeletesStart(CHANNEL_MODEL);

        // Slack API docs: https://api.slack.com/methods/conversations.list
        for await (const channelsPage of nango.paginate<SlackChannelRaw>({
            endpoint: '/conversations.list',
            params: {
                types: 'public_channel,private_channel'
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
            const records = channelsPage
                .map((channel) => normalizeChannel(channel))
                .filter((channel): channel is SlackChannelRecord => channel !== null);

            if (records.length > 0) {
                await nango.batchSave(records, CHANNEL_MODEL);
            }
        }

        await nango.trackDeletesEnd(CHANNEL_MODEL);
    },

    onWebhook: async (nango, payload) => {
        await nango.setMergingStrategy({ strategy: 'override' }, CHANNEL_MODEL);

        const event = (payload as SlackChannelEventPayload).event;
        const eventType = event?.type ?? '';
        if (!event || !isChannelLifecycleEvent(eventType)) {
            return;
        }

        const channelId = readChannelId(event.channel);
        if (!channelId) {
            return;
        }

        if (isChannelDeleteEvent(eventType)) {
            await nango.batchDelete([{ id: channelId }], CHANNEL_MODEL);
            return;
        }

        let record = typeof event.channel === 'object' ? normalizeChannel(event.channel) : null;

        try {
            // Slack API docs: https://api.slack.com/methods/conversations.info
            const response = await nango.get({
                endpoint: '/conversations.info',
                params: { channel: channelId },
                retries: 3
            });
            const raw = (response.data as { channel?: SlackChannelRaw } | undefined)?.channel;
            const resolved = raw ? normalizeChannel(raw) : null;
            if (resolved) {
                record = resolved;
            }
        } catch (error) {
            await nango.log(`Failed to resolve Slack channel ${channelId}: ${error instanceof Error ? error.message : String(error)}`, {
                level: 'warn'
            });
        }

        if (record) {
            await nango.batchSave([record], CHANNEL_MODEL);
        }
    }
});

export default sync;
