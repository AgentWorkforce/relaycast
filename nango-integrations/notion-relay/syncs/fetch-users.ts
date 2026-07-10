import { createSync } from 'nango';
import * as z from 'zod';

// ---------------------------------------------------------------------------
// Public NotionUser record projected into the relayfile mount.
//
// Cloud's bucketer (`bucketNotion` in `packages/core/src/sync/record-buckets.ts`)
// matches the model name `NotionUser` (case-insensitive) and routes records
// into the `users` bucket of `emitNotionAuxiliaryFiles`. The adapter then
// materializes:
//
//   /notion/users/<slug>__<id>.json           — canonical (slug from display name)
//   /notion/users/_index.json                 — { id, title (name), updated, is_bot }
//   /notion/users/by-id/<dehyphenated>.json   — UUID anchor
//   /notion/users/by-name/<slug>__<short>.json — display-name lookup
//
// Personal email on `person.email` is intentionally NOT projected — the
// adapter's storage sanitizer would redact a user-record shape anyway,
// and an opaque id + display name is enough for agent-side lookups.
//
// `last_edited_time` is stamped at fetch (Notion's User object has no
// modified-at field), which means the index `updated` column reflects
// "last observed by the sync" rather than "last modified by the
// workspace". This is the best signal the API exposes.
// ---------------------------------------------------------------------------

const NotionUser = z.object({
    id: z
        .string()
        .describe('Notion user UUID, e.g. `4e2f3...-...-...-...-...`. Immutable; used for path mapping and writeback.'),
    name: z.string().describe('Display name as shown in the Notion UI. Empty string for un-named workspace integrations.'),
    is_bot: z.boolean().describe('`true` for workspace integrations (bots), `false` for human members.'),
    avatar_url: z.string().nullable().optional().describe('Public avatar URL or `null` when the user has not uploaded one.'),
    last_edited_time: z
        .string()
        .describe('ISO 8601 timestamp the sync stamped at fetch (Notion users have no native modified-at).'),
});

type NotionUserRecord = z.infer<typeof NotionUser>;

// ---------------------------------------------------------------------------
// Notion API user shape.
// Reference: https://developers.notion.com/reference/get-users
//
// Untyped fields can return `null` (e.g. workspace integrations get
// `name: null` on first install before the user names them).
// ---------------------------------------------------------------------------
const NotionApiUserSchema = z.object({
    object: z.string().optional(),
    id: z.string(),
    type: z.enum(['person', 'bot']).optional(),
    name: z.string().nullable().optional(),
    avatar_url: z.string().nullable().optional(),
    person: z.object({ email: z.string().optional() }).optional(),
    bot: z.record(z.string(), z.unknown()).optional(),
});

type NotionApiUser = z.infer<typeof NotionApiUserSchema>;

const USERS_PAGE_SIZE = 100;

function toRecord(user: NotionApiUser, observedAt: string): NotionUserRecord {
    return {
        id: user.id,
        name: user.name ?? '',
        is_bot: user.type === 'bot',
        avatar_url: user.avatar_url ?? null,
        last_edited_time: observedAt,
    };
}

export default createSync({
    description:
        'Fetches Notion workspace users (members + bot integrations) so agents can resolve user UUIDs by display name. Emits NotionUser records consumed by adapter-notion `emitUsers`.',
    version: '1.0.0',
    // ----------------------------------------------------------------------
    // Sync Strategy Gate (per skill `building-nango-functions-locally`):
    //
    // **Full refresh blocker**: Notion's `/v1/users` endpoint has no
    // `since` / `last_edited_time` / cursor-of-changes filter (verified
    // against https://developers.notion.com/reference/get-users —
    // request params are `start_cursor` + `page_size` only, with no
    // way to scope to recently-modified users). Notion's webhook event
    // catalogue (https://developers.notion.com/reference/webhooks-events-delivery)
    // does not include user lifecycle events either, so a webhook
    // top-up is also unavailable.
    //
    // **Dataset size**: Notion workspaces typically have O(10s-100s) of
    // users — a full enumeration every 6h is cheap.
    //
    // **Deletion strategy**: `nango.trackDeletesStart()` is called
    // before fetch+save, and `nango.trackDeletesEnd()` only after the
    // *entire* enumeration completes without throwing. Any error
    // path returns BEFORE calling `trackDeletesEnd()` so a partial
    // page-read never tombstones the users that weren't seen yet.
    // ----------------------------------------------------------------------
    frequency: 'every 6 hours',
    autoStart: true,
    endpoints: [{ method: 'GET', path: '/notion-relay/users', group: 'Notion' }],
    metadata: z.object({}),
    models: { NotionUser },

    exec: async (nango) => {
        const observedAt = new Date().toISOString();
        let totalSaved = 0;
        let totalSeen = 0;

        // Open the deletion-tracking window. Per the skill's deletion
        // detection rules, `trackDeletesEnd()` must run ONLY after a
        // successful full fetch+save — never on a partial enumeration.
        // The model name argument scopes deletion tracking to just
        // NotionUser records.
        await nango.trackDeletesStart('NotionUser');

        try {
            // Notion users list endpoint.
            // Reference: https://developers.notion.com/reference/get-users
            for await (const userBatch of nango.paginate({
                endpoint: '/v1/users',
                method: 'get',
                paginate: {
                    type: 'cursor',
                    cursor_name_in_request: 'start_cursor',
                    cursor_path_in_response: 'next_cursor',
                    response_path: 'results',
                    limit_name_in_request: 'page_size',
                    limit: USERS_PAGE_SIZE,
                },
                retries: 3,
            })) {
                const rawUsers = (userBatch ?? []) as unknown[];
                const records: NotionUserRecord[] = [];

                for (const raw of rawUsers) {
                    totalSeen += 1;
                    const parsed = NotionApiUserSchema.safeParse(raw);
                    if (!parsed.success) {
                        // Skip-but-don't-fail a malformed row. Because the
                        // skipped user *wasn't* seen, `trackDeletesEnd()`
                        // would later mark it as deleted if the run
                        // succeeds — so on persistent parse failure the
                        // user would silently disappear. To avoid that,
                        // we re-throw if more than 1% of rows failed to
                        // parse (full-refresh-safety: an unusable batch
                        // shouldn't be allowed to tombstone everything).
                        const idHint =
                            typeof raw === 'object' && raw !== null && 'id' in raw
                                ? String((raw as { id?: unknown }).id ?? 'unknown')
                                : 'unknown';
                        await nango.log(
                            `fetch-users: skipping malformed user record id=${idHint}: ${parsed.error.message}`,
                            { level: 'warn' },
                        );
                        continue;
                    }
                    records.push(toRecord(parsed.data, observedAt));
                }

                if (records.length > 0) {
                    await nango.batchSave(records, 'NotionUser');
                    totalSaved += records.length;
                }
            }

            // Sanity gate: if the parse-failure rate is too high, don't
            // close the deletion window — a successful-looking sync that
            // dropped >1% of users via parse errors would over-tombstone.
            const parseFailureRate =
                totalSeen === 0 ? 0 : (totalSeen - totalSaved) / totalSeen;
            if (parseFailureRate > 0.01) {
                throw new Error(
                    `fetch-users aborting trackDeletesEnd: parse-failure rate ${(
                        parseFailureRate * 100
                    ).toFixed(2)}% exceeds 1% safety threshold (seen=${totalSeen} saved=${totalSaved})`,
                );
            }

            // Only close the deletion window after a successful full pass.
            // Reference: https://nango.dev/docs/implementation-guides/use-cases/syncs/deletion-detection
            await nango.trackDeletesEnd('NotionUser');

            await nango.log(
                `fetch-users completed: saved=${totalSaved} seen=${totalSeen}`,
                { level: 'info' },
            );
        } catch (error) {
            // Do NOT call trackDeletesEnd() — a partial sync would
            // otherwise tombstone unseen users.
            const message = error instanceof Error ? error.message : String(error);
            await nango.log(`fetch-users failed (deletion window left open): ${message}`, {
                level: 'error',
            });
            throw error;
        }
    },
});
