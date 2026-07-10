import { createAction } from 'nango';
import { z } from 'zod';

// Slack has no server search on users.list, so picker queries are filtered
// server-side while paging only on Slack upstream cursor boundaries. Do not
// slice mid-page; Slack cursors resume after a full upstream page.
// Powers the deploy-time "who should the agent DM / which person is this?"
// picker (e.g. Watchdog's BENJAMIN input). The onboarding CLI triggers this
// right after the Slack OAuth connect so the operator selects a teammate
// instead of pasting a U… id. Mirrors `syncs/fetch-users.ts` normalization
// but returns the list synchronously (no sync run required).

const ListUsersInput = z
    .object({
        query: z.string().optional(),
        cursor: z.string().optional(),
        limit: z.number().optional()
    })
    .optional();

const SlackUser = z.object({
    id: z.string(),
    name: z.string(),
    real_name: z.string(),
    display_name: z.string(),
    email: z.string()
});

const ListUsersOutput = z.object({
    users: z.array(SlackUser),
    nextCursor: z.string().optional()
});

const DEFAULT_LIMIT = 50;
const MIN_LIMIT = 1;
const MAX_LIMIT = 200;
const FILTERED_UPSTREAM_PAGE_LIMIT = 200;
const MAX_UPSTREAM_PAGES = 10;

type SlackUserProfile = {
    real_name?: string;
    display_name?: string;
    display_name_normalized?: string;
    real_name_normalized?: string;
    email?: string;
};

type SlackUserRaw = {
    id?: string;
    name?: string;
    real_name?: string;
    deleted?: boolean;
    is_bot?: boolean;
    profile?: SlackUserProfile;
};

function normalizeUser(raw: SlackUserRaw): z.infer<typeof SlackUser> | null {
    // Real humans only: bots, deleted accounts, and Slackbot can't be DM'd
    // by a person in a meaningful onboarding pick.
    if (!raw.id || raw.deleted === true || raw.is_bot === true || raw.id === 'USLACKBOT') {
        return null;
    }

    const profile = raw.profile ?? {};
    return {
        id: raw.id,
        name: raw.name ?? '',
        real_name: raw.real_name ?? profile.real_name ?? '',
        display_name: profile.display_name ?? profile.display_name_normalized ?? raw.name ?? '',
        email: profile.email ?? ''
    };
}

function clampLimit(value: number | undefined): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isSafeInteger(value) || value < MIN_LIMIT) {
        return DEFAULT_LIMIT;
    }
    return Math.min(value, MAX_LIMIT);
}

function userMatchesQuery(user: z.infer<typeof SlackUser>, query: string): boolean {
    return [user.name, user.real_name, user.display_name, user.email].some((value) =>
        value.toLowerCase().includes(query)
    );
}

const action = createAction({
    description: 'Lists active Slack workspace members (onboarding user picker).',
    version: '1.0.0',
    endpoint: {
        method: 'GET',
        path: '/slack/users/list',
        group: 'Slack'
    },
    input: ListUsersInput,
    output: ListUsersOutput,
    scopes: ['users:read', 'users:read.email'],

    exec: async (nango, input): Promise<z.infer<typeof ListUsersOutput>> => {
        const limit = clampLimit(input?.limit);
        const query = input?.query?.trim().toLowerCase() || undefined;
        const upstreamLimit = query ? FILTERED_UPSTREAM_PAGE_LIMIT : limit;
        let cursor = input?.cursor?.trim() || undefined;
        let pages = 0;
        let nextCursor: string | undefined;
        const matched: Array<z.infer<typeof SlackUser>> = [];

        while (true) {
            const response: { data?: { members?: SlackUserRaw[]; response_metadata?: { next_cursor?: string } } } =
                await nango.get({
                    // https://api.slack.com/methods/users.list
                    endpoint: '/users.list',
                    params: {
                        limit: upstreamLimit,
                        ...(cursor ? { cursor } : {})
                    },
                    retries: 3
                });

            for (const raw of response.data?.members ?? []) {
                const user = normalizeUser(raw);
                if (!user) {
                    continue;
                }
                if (query && !userMatchesQuery(user, query)) {
                    continue;
                }
                matched.push(user);
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

        return { users: matched, ...(nextCursor ? { nextCursor } : {}) };
    }
});

export type NangoActionLocal = Parameters<(typeof action)['exec']>[0];
export default action;
