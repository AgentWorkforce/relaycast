import { createSync, type NangoSync } from 'nango';
import * as z from 'zod';

const NotionDatabase = z.object({
    id: z.string(),
    title: z.string(),
    url: z.string(),
    description: z.string(),
    properties: z.array(z.string()),
    last_edited_time: z.string(),
    archived: z.boolean().optional(),
    in_trash: z.boolean().optional()
});

const NotionCheckpointSchema = z.object({
    lastEditedTime: z.string(),
    lastEditedIdsJson: z.string()
});

type NotionDatabaseRecord = z.infer<typeof NotionDatabase>;
type NotionCheckpoint = z.infer<typeof NotionCheckpointSchema>;

interface NotionSearchDatabase {
    id: string;
    url?: string;
    last_edited_time: string;
    title?: unknown;
    description?: unknown;
    properties?: Record<string, unknown>;
    archived?: boolean;
    in_trash?: boolean;
}

// See `fetch-pages.ts` for full notes on Nango's notion webhook routing.
// Each sync file is compile-isolated so we redeclare the envelope here.
interface NotionWebhookEnvelope {
    id?: string;
    timestamp?: string;
    workspace_id?: string;
    type?: string;
    entity?: { id?: string; type?: string };
    data?: Record<string, unknown>;
}

// Database lifecycle events. Notion exposes both `database.schema_updated`
// (column changes) and `database.content_updated` (row changes) — only
// schema-level changes affect the fields we project (title, description,
// property names), so we don't subscribe to row-level updates.
const DATABASE_WEBHOOK_EVENTS = [
    'database.created',
    'database.schema_updated',
    'database.moved',
    'database.deleted',
    'database.undeleted',
] as const;

const isDeleteEvent = (type: string | undefined): boolean => {
    return type === 'database.deleted';
};

const SEARCH_PAGE_SIZE = 100;

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null;
};

const isString = (value: unknown): value is string => {
    return typeof value === 'string';
};

const getErrorMessage = (error: unknown): string => {
    return error instanceof Error ? error.message : String(error);
};

const getPlainText = (value: unknown): string => {
    if (!Array.isArray(value)) {
        return '';
    }

    return value
        .map((fragment) => {
            if (!isRecord(fragment) || !isString(fragment['plain_text'])) {
                return '';
            }

            return fragment['plain_text'];
        })
        .join('')
        .trim();
};

const getDatabaseProperties = (properties?: Record<string, unknown>): string[] => {
    return Object.keys(properties ?? {})
        .filter((property) => property.trim().length > 0)
        .sort((left, right) => left.localeCompare(right));
};

const parseCheckpointIds = (checkpoint: NotionCheckpoint | null): Set<string> => {
    if (!checkpoint?.lastEditedIdsJson) {
        return new Set();
    }

    try {
        const parsed = JSON.parse(checkpoint.lastEditedIdsJson) as unknown;
        if (!Array.isArray(parsed)) {
            return new Set();
        }

        return new Set(parsed.filter((value): value is string => typeof value === 'string'));
    } catch {
        return new Set();
    }
};

const serializeCheckpointIds = (ids: Set<string>): string => {
    return JSON.stringify(Array.from(ids).sort((left, right) => left.localeCompare(right)));
};

const updateCheckpointState = (
    state: { latestEditedTime: string; latestEditedIds: Set<string> },
    recordId: string,
    lastEditedTime: string
): void => {
    if (!lastEditedTime) {
        return;
    }

    if (lastEditedTime > state.latestEditedTime) {
        state.latestEditedTime = lastEditedTime;
        state.latestEditedIds = new Set([recordId]);
        return;
    }

    if (lastEditedTime === state.latestEditedTime) {
        state.latestEditedIds.add(recordId);
    }
};

const shouldSyncRecord = (record: { id: string; last_edited_time: string }, checkpointTime: string, checkpointIds: Set<string>): boolean => {
    if (!checkpointTime) {
        return true;
    }

    if (record.last_edited_time > checkpointTime) {
        return true;
    }

    if (record.last_edited_time < checkpointTime) {
        return false;
    }

    return !checkpointIds.has(record.id);
};

const fetchDatabaseById = async (nango: NangoSync, databaseId: string): Promise<NotionSearchDatabase | null> => {
    try {
        const response = await nango.get({
            endpoint: `/v1/databases/${encodeURIComponent(databaseId)}`,
            retries: 3
        });
        const data = response.data as NotionSearchDatabase | undefined;
        if (!data || typeof data.id !== 'string') {
            return null;
        }
        return data;
    } catch (error) {
        await nango.log(
            `Failed to fetch Notion database ${databaseId}: ${getErrorMessage(error)}`,
            { level: 'warn' }
        );
        return null;
    }
};

const buildDatabaseRecord = (database: NotionSearchDatabase): NotionDatabaseRecord => {
    return {
        id: database.id,
        title: getPlainText(database.title) || 'Untitled',
        url: database.url ?? '',
        description: getPlainText(database.description),
        properties: getDatabaseProperties(database.properties),
        last_edited_time: database.last_edited_time,
        archived: database.archived === true,
        in_trash: database.in_trash === true
    };
};

const getMissingDatabaseIds = async (nango: NangoSync, currentIds: Set<string>): Promise<string[]> => {
    const idsToDelete: string[] = [];

    for await (const record of nango.listRecords<NotionDatabaseRecord>('NotionDatabase')) {
        const id = String(record.id);
        if (!currentIds.has(id)) {
            idsToDelete.push(id);
        }
    }

    return idsToDelete;
};

export default createSync({
    description: 'Fetches accessible Notion databases for structured workspace content.',
    version: '1.1.0',
    frequency: 'every 12 hours',
    autoStart: true,
    syncType: 'incremental',
    endpoints: [{ method: 'GET', path: '/notion-relay/databases', group: 'Notion' }],
    metadata: z.object({}),
    checkpoint: NotionCheckpointSchema,
    models: { NotionDatabase },

    // Subscribe to database lifecycle / schema events. Row-level
    // (`database.content_updated`) is intentionally omitted because this
    // sync only projects schema-level fields.
    webhookSubscriptions: [...DATABASE_WEBHOOK_EVENTS],

    exec: async (nango) => {
        const checkpoint = (await nango.getCheckpoint()) as NotionCheckpoint | null;
        const lastEditedTime = checkpoint?.lastEditedTime ?? '';
        const lastEditedIds = parseCheckpointIds(checkpoint);
        const checkpointState = {
            latestEditedTime: lastEditedTime,
            latestEditedIds: new Set(lastEditedIds)
        };
        const currentIds = new Set<string>();

        try {
            for await (const databaseBatch of nango.paginate({
                endpoint: '/v1/search',
                method: 'post',
                data: {
                    filter: { property: 'object', value: 'database' },
                    sort: { direction: 'descending', timestamp: 'last_edited_time' }
                },
                paginate: {
                    type: 'cursor',
                    cursor_name_in_request: 'start_cursor',
                    cursor_path_in_response: 'next_cursor',
                    response_path: 'results',
                    limit_name_in_request: 'page_size',
                    limit: SEARCH_PAGE_SIZE
                },
                retries: 3
            })) {
                const records: NotionDatabaseRecord[] = [];
                const databases = databaseBatch as NotionSearchDatabase[];

                for (const database of databases) {
                    currentIds.add(database.id);
                    updateCheckpointState(checkpointState, database.id, database.last_edited_time);

                    if (!shouldSyncRecord(database, lastEditedTime, lastEditedIds)) {
                        continue;
                    }

                    records.push(buildDatabaseRecord(database));
                }

                if (records.length > 0) {
                    await nango.batchSave(records, 'NotionDatabase');
                }
            }

            const idsToDelete = await getMissingDatabaseIds(nango, currentIds);
            if (idsToDelete.length > 0) {
                await nango.batchDelete(idsToDelete.map((id) => ({ id })), 'NotionDatabase');
            }
        } catch (error) {
            await nango.log(`Failed to sync Notion databases: ${getErrorMessage(error)}`);
            throw error;
        }

        if (checkpointState.latestEditedTime) {
            await nango.saveCheckpoint({
                lastEditedTime: checkpointState.latestEditedTime,
                lastEditedIdsJson: serializeCheckpointIds(checkpointState.latestEditedIds)
            });
        }
    },

    onWebhook: async (nango, payload) => {
        const webhook = payload as NotionWebhookEnvelope;
        const eventType = typeof webhook.type === 'string' ? webhook.type : '';
        const databaseId = webhook.entity?.id;
        if (!databaseId) {
            await nango.log(
                `Notion database webhook skipped: missing entity.id (type=${eventType || 'unknown'})`,
                { level: 'warn' }
            );
            return;
        }

        if (webhook.entity?.type && webhook.entity.type !== 'database') {
            return;
        }

        try {
            if (isDeleteEvent(eventType)) {
                await nango.batchDelete([{ id: databaseId }], 'NotionDatabase');
                return;
            }

            const database = await fetchDatabaseById(nango, databaseId);
            if (!database) {
                await nango.log(
                    `Notion database webhook skipped: database ${databaseId} could not be fetched (type=${eventType})`,
                    { level: 'warn' }
                );
                return;
            }

            await nango.batchSave([buildDatabaseRecord(database)], 'NotionDatabase');
        } catch (error) {
            await nango.log(
                `Failed to process Notion database webhook (type=${eventType}, id=${databaseId}): ${getErrorMessage(error)}`
            );
            throw error;
        }
    }
});
