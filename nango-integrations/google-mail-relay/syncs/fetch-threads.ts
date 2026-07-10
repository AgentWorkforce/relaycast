import { createSync } from 'nango';
import { z } from 'zod';

import {
    GoogleMailThread,
    compactGoogleMailThreadRecord
} from './gmail-record-shapes.js';

const CheckpointSchema = z.object({
    phase: z.string(),
    history_id: z.string(),
    page_token: z.string(),
    backfill_history_id: z.string()
});

const LegacyCheckpointSchema = z.object({
    phase: z.string().optional(),
    history_id: z.string().optional(),
    page_token: z.string().optional(),
    backfill_history_id: z.string().optional()
});

type Checkpoint = z.infer<typeof LegacyCheckpointSchema>;
type GetResponse = Awaited<ReturnType<NangoSyncLocal['get']>>;
type NormalizedCheckpoint = {
    phase: 'backfill' | 'history';
    history_id: string | undefined;
    page_token: string | undefined;
    backfill_history_id: string | undefined;
};

const EMPTY_BACKFILL_CHECKPOINT: NormalizedCheckpoint = {
    phase: 'backfill',
    history_id: undefined,
    page_token: undefined,
    backfill_history_id: undefined
};

const HistoryMessageSchema = z.object({
    id: z.string(),
    threadId: z.string(),
    labelIds: z.array(z.string()).optional(),
    historyId: z.string().optional()
});

const HistoryMessageAddedSchema = z.object({
    message: HistoryMessageSchema
});

const HistoryMessageDeletedSchema = z.object({
    message: HistoryMessageSchema
});

const HistoryLabelChangeSchema = z.object({
    message: HistoryMessageSchema,
    labelIds: z.array(z.string())
});

const HistorySchema = z.object({
    id: z.string(),
    messages: z.array(HistoryMessageSchema).optional(),
    messagesAdded: z.array(HistoryMessageAddedSchema).optional(),
    messagesDeleted: z.array(HistoryMessageDeletedSchema).optional(),
    labelsAdded: z.array(HistoryLabelChangeSchema).optional(),
    labelsRemoved: z.array(HistoryLabelChangeSchema).optional()
});

const HistoryListResponseSchema = z.object({
    history: z.array(HistorySchema).optional(),
    nextPageToken: z.string().optional(),
    historyId: z.string().optional()
});

const ThreadListItemSchema = z.object({
    id: z.string(),
    historyId: z.string().optional(),
    snippet: z.string().optional()
});

const ThreadListResponseSchema = z.object({
    threads: z.array(ThreadListItemSchema).optional(),
    nextPageToken: z.string().optional(),
    resultSizeEstimate: z.number().optional()
});

const ProfileSchema = z.object({
    historyId: z.string()
});

const sync = createSync({
    description: 'Sync Gmail threads with full conversation hydration for Relayfile.',
    version: '1.0.0',
    frequency: 'every 30 minutes',
    autoStart: true,
    endpoints: [{ path: '/gmail/threads', method: 'GET', group: 'Google Mail' }],
    checkpoint: CheckpointSchema,
    models: {
        GoogleMailThread
    },
    webhookSubscriptions: ['*'],
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],

    exec: async (nango) => {
        let checkpoint = normalizeCheckpoint(parseCheckpoint(await nango.getCheckpoint()));

        if (checkpoint.phase === 'history' && checkpoint.history_id) {
            await syncHistory(nango, checkpoint);
            return;
        }

        if (checkpoint.phase === 'backfill' && checkpoint.backfill_history_id) {
            const historyHighWater = await processBackfillHistoryDelta(nango, checkpoint, 'exec');
            checkpoint = withBackfillHistoryHighWater(checkpoint, historyHighWater);
        }

        await syncBackfill(nango, checkpoint);
    },

    onWebhook: async (nango, payload) => {
        const checkpoint = normalizeCheckpoint(parseCheckpoint(await nango.getCheckpoint()));
        const webhookHistoryId = extractWebhookHistoryId(payload);

        if (checkpoint.phase === 'history' && checkpoint.history_id) {
            if (webhookHistoryId && compareHistoryIds(webhookHistoryId, checkpoint.history_id) <= 0) {
                await nango.log(
                    `Google Mail thread webhook skipped: webhook historyId ${webhookHistoryId} is not newer than checkpoint ${checkpoint.history_id}.`
                );
                return;
            }

            await syncHistory(nango, checkpoint);
            return;
        }

        if (checkpoint.phase === 'backfill' && checkpoint.backfill_history_id) {
            const deltaBaseline = checkpoint.history_id ?? checkpoint.backfill_history_id;
            if (webhookHistoryId && compareHistoryIds(webhookHistoryId, deltaBaseline) <= 0) {
                await nango.log(
                    `Google Mail thread webhook skipped during backfill: webhook historyId ${webhookHistoryId} is not newer than backfill baseline ${deltaBaseline}.`
                );
                return;
            }

            const historyHighWater = await processBackfillHistoryDelta(nango, checkpoint, 'webhook');
            if (historyHighWater) {
                await saveBackfillHistoryHighWater(nango, checkpoint, historyHighWater);
            }
            return;
        }

        await syncBackfill(nango, checkpoint);
    }
});

async function processBackfillHistoryDelta(
    nango: NangoSyncLocal,
    checkpoint: NormalizedCheckpoint,
    source: 'exec' | 'webhook'
): Promise<string | undefined> {
    if (source === 'webhook') {
        await nango.log('Google Mail thread webhook processing history delta without interrupting active backfill.');
    } else {
        await nango.log('Google Mail thread sync processing pending history delta before continuing active backfill.');
    }
    return syncHistory(
        nango,
        {
            phase: 'history',
            history_id: checkpoint.history_id ?? checkpoint.backfill_history_id,
            page_token: undefined,
            backfill_history_id: undefined
        },
        { preserveCheckpoint: true }
    );
}

async function saveBackfillHistoryHighWater(
    nango: NangoSyncLocal,
    checkpoint: NormalizedCheckpoint,
    historyId: string
): Promise<void> {
    const latest = normalizeCheckpoint(parseCheckpoint(await nango.getCheckpoint()));
    if (
        latest.phase !== 'backfill' ||
        latest.page_token !== checkpoint.page_token ||
        latest.backfill_history_id !== checkpoint.backfill_history_id
    ) {
        await nango.log('Google Mail thread webhook skipped backfill high-water checkpoint update because the active backfill checkpoint changed.');
        return;
    }

    const nextCheckpoint = withBackfillHistoryHighWater(latest, historyId);
    await saveCheckpointHandlingConflict(
        nango,
        {
        phase: 'backfill',
        history_id: nextCheckpoint.history_id ?? '',
        page_token: nextCheckpoint.page_token ?? '',
        backfill_history_id: nextCheckpoint.backfill_history_id ?? ''
        },
        'webhook backfill high-water update'
    );
}

function parseCheckpoint(checkpoint: unknown): Checkpoint | null {
    const parsed = LegacyCheckpointSchema.safeParse(checkpoint);
    return parsed.success ? parsed.data : null;
}

function normalizeCheckpoint(checkpoint: Checkpoint | null): NormalizedCheckpoint {
    if (!checkpoint) {
        return EMPTY_BACKFILL_CHECKPOINT;
    }

    if (checkpoint.phase === 'history' && checkpoint.history_id) {
        return {
            phase: 'history',
            history_id: checkpoint.history_id,
            page_token: checkpoint.page_token,
            backfill_history_id: undefined
        };
    }

    if (checkpoint.phase === 'backfill') {
        return {
            phase: 'backfill',
            history_id: checkpoint.history_id,
            page_token: checkpoint.page_token,
            backfill_history_id: checkpoint.backfill_history_id
        };
    }

    if (checkpoint.page_token) {
        return EMPTY_BACKFILL_CHECKPOINT;
    }

    if (checkpoint.history_id) {
        return {
            phase: 'history',
            history_id: checkpoint.history_id,
            page_token: undefined,
            backfill_history_id: undefined
        };
    }

    return EMPTY_BACKFILL_CHECKPOINT;
}

function withBackfillHistoryHighWater(
    checkpoint: NormalizedCheckpoint,
    historyId: string | undefined
): NormalizedCheckpoint {
    if (checkpoint.phase !== 'backfill' || !historyId) {
        return checkpoint;
    }
    return {
        ...checkpoint,
        history_id: newestHistoryId(checkpoint.history_id, historyId)
    };
}

function newestHistoryId(left: string | undefined, right: string | undefined): string | undefined {
    if (!left) {
        return right;
    }
    if (!right) {
        return left;
    }
    return compareHistoryIds(left, right) >= 0 ? left : right;
}

async function syncBackfill(nango: NangoSyncLocal, checkpoint: NormalizedCheckpoint): Promise<void> {
    const pageToken = checkpoint.phase === 'backfill' ? checkpoint.page_token : undefined;
    let backfillHistoryId = checkpoint.phase === 'backfill' ? checkpoint.backfill_history_id : undefined;

    if (!backfillHistoryId) {
        backfillHistoryId = await getCurrentHistoryId(nango);
    }

    if (!pageToken) {
        await nango.trackDeletesStart('GoogleMailThread');
    }

    const listResponse = await nango.get({
        // https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.threads/list
        endpoint: '/gmail/v1/users/me/threads',
        params: {
            maxResults: 100,
            includeSpamTrash: 'true',
            ...(pageToken && { pageToken })
        },
        retries: 3
    });

    const listData = ThreadListResponseSchema.parse(listResponse.data);
    const threads: Array<z.infer<typeof GoogleMailThread>> = [];

    for (const threadSummary of listData.threads ?? []) {
        const thread = await fetchThread(nango, threadSummary.id);
        if (thread) {
            threads.push(thread);
        }
    }

    if (threads.length > 0) {
        await nango.batchSave(threads, 'GoogleMailThread');
    }

    if (listData.nextPageToken) {
        const checkpointSaved = await saveCheckpointHandlingConflict(
            nango,
            {
                phase: 'backfill',
                history_id: checkpoint.history_id ?? '',
                page_token: listData.nextPageToken,
                backfill_history_id: backfillHistoryId ?? ''
            },
            'backfill pagination progress'
        );
        if (!checkpointSaved) {
            return;
        }
        return;
    }

    await nango.trackDeletesEnd('GoogleMailThread');

    const finalHistoryId =
        newestHistoryId(backfillHistoryId, checkpoint.history_id) ?? (await getCurrentHistoryId(nango));
    await saveCheckpointHandlingConflict(
        nango,
        {
            phase: 'history',
            history_id: finalHistoryId,
            page_token: '',
            backfill_history_id: ''
        },
        'backfill completion transition'
    );
}

async function syncHistory(
    nango: NangoSyncLocal,
    checkpoint: NormalizedCheckpoint,
    options: { preserveCheckpoint?: boolean } = {}
): Promise<string | undefined> {
    const startHistoryId = checkpoint.history_id;
    if (!startHistoryId) {
        await syncBackfill(nango, EMPTY_BACKFILL_CHECKPOINT);
        return undefined;
    }

    let response: GetResponse;
    try {
        response = await nango.get({
            // https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list
            endpoint: '/gmail/v1/users/me/history',
            params: {
                startHistoryId,
                ...(checkpoint.page_token && { pageToken: checkpoint.page_token })
            },
            retries: 3
        });
    } catch (error) {
        if (isNotFoundError(error)) {
            if (!options.preserveCheckpoint) {
                await syncBackfill(nango, EMPTY_BACKFILL_CHECKPOINT);
            } else {
                await nango.log(
                    `Google Mail thread webhook history baseline ${startHistoryId} is no longer available; active backfill checkpoint preserved.`
                );
            }
            return undefined;
        }

        throw error;
    }

    const historyData = HistoryListResponseSchema.parse(response.data);
    const threadIdsToRefresh = new Set<string>();

    for (const history of historyData.history ?? []) {
        for (const message of history.messages ?? []) {
            threadIdsToRefresh.add(message.threadId);
        }

        for (const added of history.messagesAdded ?? []) {
            threadIdsToRefresh.add(added.message.threadId);
        }

        for (const deleted of history.messagesDeleted ?? []) {
            threadIdsToRefresh.add(deleted.message.threadId);
        }

        for (const labelChange of history.labelsAdded ?? []) {
            threadIdsToRefresh.add(labelChange.message.threadId);
        }

        for (const labelChange of history.labelsRemoved ?? []) {
            threadIdsToRefresh.add(labelChange.message.threadId);
        }
    }

    const threads: Array<z.infer<typeof GoogleMailThread>> = [];
    const threadIdsToDelete = new Set<string>();

    for (const threadId of threadIdsToRefresh) {
        const thread = await fetchThread(nango, threadId);
        if (thread) {
            threads.push(thread);
            continue;
        }

        threadIdsToDelete.add(threadId);
    }

    if (threads.length > 0) {
        await nango.batchSave(threads, 'GoogleMailThread');
    }

    if (threadIdsToDelete.size > 0) {
        await nango.batchDelete(
            Array.from(threadIdsToDelete).map((id) => ({ id })),
            'GoogleMailThread'
        );
    }

    if (historyData.nextPageToken) {
        if (options.preserveCheckpoint) {
            return syncHistory(
                nango,
                {
                    ...checkpoint,
                    page_token: historyData.nextPageToken
                },
                options
            );
        }

        const checkpointSaved = await saveCheckpointHandlingConflict(
            nango,
            {
                phase: 'history',
                history_id: startHistoryId,
                page_token: historyData.nextPageToken,
                backfill_history_id: ''
            },
            'history pagination progress'
        );
        if (!checkpointSaved) {
            return;
        }
        return;
    }

    if (options.preserveCheckpoint) {
        return historyData.historyId ?? startHistoryId;
    }

    await saveCheckpointHandlingConflict(
        nango,
        {
            phase: 'history',
            history_id: historyData.historyId ?? startHistoryId,
            page_token: '',
            backfill_history_id: ''
        },
        'history high-water update'
    );
    return historyData.historyId ?? startHistoryId;
}

async function saveCheckpointHandlingConflict(
    nango: NangoSyncLocal,
    checkpoint: z.infer<typeof CheckpointSchema>,
    context: string
): Promise<boolean> {
    try {
        await nango.saveCheckpoint(checkpoint);
        return true;
    } catch (error) {
        if (isCheckpointConflictError(error)) {
            await nango.log(`Google Mail thread sync skipped checkpoint save during ${context}: checkpoint was concurrently updated.`);
            return false;
        }

        throw error;
    }
}

function isCheckpointConflictError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
        return false;
    }

    const message = 'message' in error && typeof error.message === 'string' ? error.message : '';
    if (message.includes('checkpoint_conflict') || message.includes('Checkpoint has been updated since last read')) {
        return true;
    }

    const payload = 'payload' in error ? error.payload : undefined;
    if (!payload || typeof payload !== 'object') {
        return false;
    }

    const nestedError = 'error' in payload ? payload.error : undefined;
    if (!nestedError || typeof nestedError !== 'object') {
        return false;
    }

    const code = 'code' in nestedError ? nestedError.code : undefined;
    if (code === 'checkpoint_conflict') {
        return true;
    }

    const nestedMessage = 'message' in nestedError && typeof nestedError.message === 'string' ? nestedError.message : '';
    return nestedMessage.includes('Checkpoint has been updated since last read');
}

async function getCurrentHistoryId(nango: NangoSyncLocal): Promise<string> {
    const profileResponse = await nango.get({
        // https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile
        endpoint: '/gmail/v1/users/me/profile',
        retries: 3
    });

    return ProfileSchema.parse(profileResponse.data).historyId;
}

async function fetchThread(nango: NangoSyncLocal, threadId: string): Promise<z.infer<typeof GoogleMailThread> | null> {
    let response: GetResponse;
    try {
        response = await nango.get({
            // https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.threads/get
            endpoint: `/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}`,
            params: {
                format: 'full'
            },
            retries: 3
        });
    } catch (error) {
        if (isNotFoundError(error)) {
            return null;
        }

        throw error;
    }

    return compactGoogleMailThreadRecord(response.data);
}

function isNotFoundError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
        return false;
    }

    const status = 'status' in error ? error.status : undefined;
    if (status === 404) {
        return true;
    }

    const payload = 'payload' in error ? error.payload : undefined;
    if (!payload || typeof payload !== 'object') {
        return false;
    }

    const nestedError = 'error' in payload ? payload.error : undefined;
    if (!nestedError || typeof nestedError !== 'object') {
        return false;
    }

    return 'code' in nestedError && nestedError.code === 404;
}

function extractWebhookHistoryId(payload: unknown): string | undefined {
    const payloadRecord = asRecord(payload);
    const forwardedPayload = asRecord(payloadRecord?.['payload']);
    const webhookBody = forwardedPayload ?? payloadRecord;
    const messageRecord = asRecord(webhookBody?.['message']);
    const encodedData = messageRecord?.['data'];

    if (typeof encodedData !== 'string' || encodedData.length === 0) {
        return undefined;
    }

    try {
        const decoded = Buffer.from(encodedData, 'base64').toString('utf8');
        const parsed = JSON.parse(decoded) as unknown;
        const parsedRecord = asRecord(parsed);
        const historyId = parsedRecord?.['historyId'];
        if (typeof historyId === 'string' && historyId.length > 0) {
            return historyId;
        }
        if (typeof historyId === 'number' && Number.isFinite(historyId)) {
            return String(historyId);
        }
    } catch {
        return undefined;
    }

    return undefined;
}

function compareHistoryIds(left: string, right: string): number {
    try {
        const leftBigInt = BigInt(left);
        const rightBigInt = BigInt(right);
        if (leftBigInt > rightBigInt) {
            return 1;
        }
        if (leftBigInt < rightBigInt) {
            return -1;
        }
        return 0;
    } catch {
        if (left.length !== right.length) {
            return left.length > right.length ? 1 : -1;
        }
        if (left === right) {
            return 0;
        }
        return left > right ? 1 : -1;
    }
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export type NangoSyncLocal = Parameters<(typeof sync)['exec']>[0];
export default sync;
