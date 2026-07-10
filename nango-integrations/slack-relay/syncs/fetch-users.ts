import { createSync } from 'nango';
import { z } from 'zod';

const SlackUser = z.object({
    id: z.string(),
    team_id: z.string(),
    name: z.string(),
    real_name: z.string(),
    display_name: z.string(),
    email: z.string(),
    title: z.string(),
    is_bot: z.boolean(),
    is_admin: z.boolean(),
    is_deleted: z.boolean(),
    timezone: z.string(),
    updated: z.number()
});

type SlackUserRecord = z.infer<typeof SlackUser>;

type SlackUserProfile = {
    real_name?: string;
    display_name?: string;
    display_name_normalized?: string;
    real_name_normalized?: string;
    email?: string;
    title?: string;
};

type SlackUserRaw = {
    id?: string;
    team_id?: string;
    name?: string;
    real_name?: string;
    deleted?: boolean;
    is_bot?: boolean;
    is_admin?: boolean;
    tz?: string;
    updated?: number;
    profile?: SlackUserProfile;
};

type SlackUserEventPayload = {
    event?: {
        type?: string;
        user?: SlackUserRaw;
    };
};

const USER_MODEL = 'SlackUser';
const USER_LIST_LIMIT = 200;
const USER_WEBHOOK_EVENTS = ['team_join', 'user_change'] as const;

function normalizeUser(raw: SlackUserRaw): SlackUserRecord | null {
    if (!raw.id) {
        return null;
    }

    const profile = raw.profile ?? {};
    return {
        id: raw.id,
        team_id: raw.team_id ?? '',
        name: raw.name ?? '',
        real_name: raw.real_name ?? profile.real_name ?? '',
        display_name: profile.display_name ?? profile.display_name_normalized ?? raw.name ?? '',
        email: profile.email ?? '',
        title: profile.title ?? '',
        is_bot: raw.is_bot === true,
        is_admin: raw.is_admin === true,
        is_deleted: raw.deleted === true,
        timezone: raw.tz ?? '',
        updated: typeof raw.updated === 'number' ? raw.updated : 0
    };
}

const sync = createSync({
    description: 'Syncs Slack workspace users via users.list and emits SlackUser records.',
    version: '1.0.0',
    endpoints: [{ method: 'GET', path: '/slack-relay/users', group: 'Slack' }],
    frequency: 'every 12 hours',
    autoStart: true,
    syncType: 'full',
    metadata: z.void(),
    models: {
        SlackUser
    },
    webhookSubscriptions: [...USER_WEBHOOK_EVENTS],

    exec: async (nango) => {
        await nango.setMergingStrategy({ strategy: 'override' }, USER_MODEL);
        await nango.trackDeletesStart(USER_MODEL);

        // Slack API docs: https://api.slack.com/methods/users.list
        for await (const usersPage of nango.paginate<SlackUserRaw>({
            endpoint: '/users.list',
            retries: 3,
            paginate: {
                type: 'cursor',
                response_path: 'members',
                cursor_name_in_request: 'cursor',
                cursor_path_in_response: 'response_metadata.next_cursor',
                limit_name_in_request: 'limit',
                limit: USER_LIST_LIMIT
            }
        })) {
            const records = usersPage
                .map((user) => normalizeUser(user))
                .filter((user): user is SlackUserRecord => user !== null);

            if (records.length > 0) {
                await nango.batchSave(records, USER_MODEL);
            }
        }

        await nango.trackDeletesEnd(USER_MODEL);
    },

    onWebhook: async (nango, payload) => {
        await nango.setMergingStrategy({ strategy: 'override' }, USER_MODEL);

        const event = (payload as SlackUserEventPayload).event;
        if (!event || (event.type !== 'team_join' && event.type !== 'user_change')) {
            return;
        }

        const user = event.user ? normalizeUser(event.user) : null;
        if (!user) {
            return;
        }

        await nango.batchSave([user], USER_MODEL);
    }
});

export default sync;
