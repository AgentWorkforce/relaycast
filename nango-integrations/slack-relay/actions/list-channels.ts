import { createAction } from 'nango';
import { z } from 'zod';

// Slack has no server search on conversations.list, so picker queries are
// filtered by channel name server-side while paging only on Slack upstream
// cursor boundaries. Do not slice mid-page; Slack cursors resume after a full
// upstream page.
// Powers the deploy-time "which channel should the agent post to?" picker
// (e.g. Watchdog's SLACK_CHANNEL input). Triggered right after the Slack
// OAuth connect so the operator selects a channel instead of pasting a C… id.
// Mirrors `syncs/fetch-channels.ts` normalization but returns the list
// synchronously (no sync run required).

const ListChannelsInput = z
    .object({
        query: z.string().optional(),
        cursor: z.string().optional(),
        limit: z.number().optional()
    })
    .optional();

const SlackChannel = z.object({
    id: z.string(),
    name: z.string(),
    is_private: z.boolean(),
    is_member: z.boolean()
});

const ListChannelsOutput = z.object({
    channels: z.array(SlackChannel),
    nextCursor: z.string().optional()
});

const DEFAULT_LIMIT = 50;
const MIN_LIMIT = 1;
const MAX_LIMIT = 200;
const FILTERED_UPSTREAM_PAGE_LIMIT = 200;
const MAX_UPSTREAM_PAGES = 10;

type SlackChannelRaw = {
    id?: string;
    name?: string;
    name_normalized?: string;
    is_private?: boolean;
    is_archived?: boolean;
    is_member?: boolean;
};

function normalizeChannel(raw: SlackChannelRaw): z.infer<typeof SlackChannel> | null {
    // Skip archived channels — an agent can't post into them.
    if (!raw.id || raw.is_archived === true) {
        return null;
    }

    return {
        id: raw.id,
        name: raw.name ?? raw.name_normalized ?? '',
        is_private: raw.is_private === true,
        is_member: raw.is_member === true
    };
}

function clampLimit(value: number | undefined): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isSafeInteger(value) || value < MIN_LIMIT) {
        return DEFAULT_LIMIT;
    }
    return Math.min(value, MAX_LIMIT);
}

const action = createAction({
    description: 'Lists non-archived Slack channels (onboarding channel picker).',
    version: '1.0.0',
    endpoint: {
        method: 'GET',
        path: '/slack/channels/list',
        group: 'Slack'
    },
    input: ListChannelsInput,
    output: ListChannelsOutput,
    scopes: ['channels:read', 'groups:read'],

    exec: async (nango, input): Promise<z.infer<typeof ListChannelsOutput>> => {
        const limit = clampLimit(input?.limit);
        const query = input?.query?.trim().toLowerCase() || undefined;
        const upstreamLimit = query ? FILTERED_UPSTREAM_PAGE_LIMIT : limit;
        let cursor = input?.cursor?.trim() || undefined;
        let pages = 0;
        let nextCursor: string | undefined;
        const matched: Array<z.infer<typeof SlackChannel>> = [];

        while (true) {
            const response: { data?: { channels?: SlackChannelRaw[]; response_metadata?: { next_cursor?: string } } } =
                await nango.get({
                    // https://api.slack.com/methods/conversations.list
                    endpoint: '/conversations.list',
                    params: {
                        types: 'public_channel,private_channel',
                        exclude_archived: 'true',
                        limit: upstreamLimit,
                        ...(cursor ? { cursor } : {})
                    },
                    retries: 3
                });

            for (const raw of response.data?.channels ?? []) {
                const channel = normalizeChannel(raw);
                if (!channel) {
                    continue;
                }
                if (query && !channel.name.toLowerCase().includes(query)) {
                    continue;
                }
                matched.push(channel);
            }

            pages += 1;
            const slackNext = response.data?.response_metadata?.next_cursor || '';
            if (matched.length >= limit) {
                nextCursor = slackNext || undefined;
                break;
            }
            if (!slackNext) {
                nextCursor = undefined;
                break;
            }
            if (pages >= MAX_UPSTREAM_PAGES) {
                nextCursor = slackNext;
                break;
            }
            cursor = slackNext;
        }

        return { channels: matched, ...(nextCursor ? { nextCursor } : {}) };
    }
});

export type NangoActionLocal = Parameters<(typeof action)['exec']>[0];
export default action;
