import { createSync } from 'nango';
import { z } from 'zod';

import {
    GoogleMailMessage,
    compactGoogleMailMessageRecord
} from './gmail-record-shapes.js';

const DEFAULT_MESSAGE_LOOKBACK_DAYS = 30;
const MAX_MESSAGE_LOOKBACK_DAYS = 3650;

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

const MetadataSchema = z
    .object({
        gmailMessageLookbackDays: z.coerce.number().int().positive().max(MAX_MESSAGE_LOOKBACK_DAYS).optional(),
        messageLookbackDays: z.coerce.number().int().positive().max(MAX_MESSAGE_LOOKBACK_DAYS).optional()
    })
    .passthrough();

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

const MessageListItemSchema = z.object({
    id: z.string(),
    threadId: z.string(),
    labelIds: z.array(z.string()).optional(),
    historyId: z.string().optional()
});

const MessageListResponseSchema = z.object({
    messages: z.array(MessageListItemSchema).optional(),
    nextPageToken: z.string().optional(),
    resultSizeEstimate: z.number().optional()
});

const HistoryMessageAddedSchema = z.object({
    message: MessageListItemSchema
});

const HistoryMessageDeletedSchema = z.object({
    message: MessageListItemSchema
});

const HistoryLabelChangeSchema = z.object({
    message: MessageListItemSchema,
    labelIds: z.array(z.string())
});

const HistoryRecordSchema = z.object({
    id: z.string(),
    messages: z.array(MessageListItemSchema).optional(),
    messagesAdded: z.array(HistoryMessageAddedSchema).optional(),
    messagesDeleted: z.array(HistoryMessageDeletedSchema).optional(),
    labelsAdded: z.array(HistoryLabelChangeSchema).optional(),
    labelsRemoved: z.array(HistoryLabelChangeSchema).optional()
});

const HistoryListResponseSchema = z.object({
    history: z.array(HistoryRecordSchema).optional(),
    nextPageToken: z.string().optional(),
    historyId: z.string().optional()
});

const ProfileSchema = z.object({
    historyId: z.string()
});

const sync = createSync({
    description: 'Sync Gmail messages with initial backfill and history-based updates for Relayfile.',
    version: '1.0.0',
    frequency: 'every 15 minutes',
    autoStart: true,
    checkpoint: CheckpointSchema,
    metadata: MetadataSchema,
    models: {
        GoogleMailMessage
    },
    endpoints: [{ method: 'GET', path: '/gmail/messages', group: 'Google Mail' }],
    webhookSubscriptions: ['*'],
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],

    exec: async (nango) => {
        const lookbackDays = await resolveMessageLookbackDays(nango);
        let checkpoint = normalizeCheckpoint(parseCheckpoint(await nango.getCheckpoint()));

        if (checkpoint.phase === 'history' && checkpoint.history_id) {
            await syncIncremental(nango, checkpoint, { lookbackDays });
            return;
        }

        if (checkpoint.phase === 'backfill' && checkpoint.backfill_history_id) {
            const historyHighWater = await processBackfillHistoryDelta(nango, checkpoint, 'exec', lookbackDays);
            checkpoint = withBackfillHistoryHighWater(checkpoint, historyHighWater);
        }

        await syncBackfill(nango, checkpoint, lookbackDays);
    },

    onWebhook: async (nango, payload) => {
        const lookbackDays = await resolveMessageLookbackDays(nango);
        const checkpoint = normalizeCheckpoint(parseCheckpoint(await nango.getCheckpoint()));
        const webhookHistoryId = extractWebhookHistoryId(payload);

        if (checkpoint.phase === 'history' && checkpoint.history_id) {
            if (webhookHistoryId && compareHistoryIds(webhookHistoryId, checkpoint.history_id) <= 0) {
                await nango.log(
                    `Google Mail message webhook skipped: webhook historyId ${webhookHistoryId} is not newer than checkpoint ${checkpoint.history_id}.`
                );
                return;
            }

            await syncIncremental(nango, checkpoint, { lookbackDays });
            return;
        }

        if (checkpoint.phase === 'backfill' && checkpoint.backfill_history_id) {
            const deltaBaseline = checkpoint.history_id ?? checkpoint.backfill_history_id;
            if (webhookHistoryId && compareHistoryIds(webhookHistoryId, deltaBaseline) <= 0) {
                await nango.log(
                    `Google Mail message webhook skipped during backfill: webhook historyId ${webhookHistoryId} is not newer than backfill baseline ${deltaBaseline}.`
                );
                return;
            }

            const historyHighWater = await processBackfillHistoryDelta(nango, checkpoint, 'webhook', lookbackDays);
            if (historyHighWater) {
                await saveBackfillHistoryHighWater(nango, checkpoint, historyHighWater);
            }
            return;
        }

        await syncBackfill(nango, checkpoint, lookbackDays);
    }
});

async function processBackfillHistoryDelta(
    nango: NangoSyncLocal,
    checkpoint: NormalizedCheckpoint,
    source: 'exec' | 'webhook',
    lookbackDays: number
): Promise<string | undefined> {
    if (source === 'webhook') {
        await nango.log('Google Mail message webhook processing history delta without interrupting active backfill.');
    } else {
        await nango.log('Google Mail message sync processing pending history delta before continuing active backfill.');
    }
    return syncIncremental(
        nango,
        {
            phase: 'history',
            history_id: checkpoint.history_id ?? checkpoint.backfill_history_id,
            page_token: undefined,
            backfill_history_id: undefined
        },
        { preserveCheckpoint: true, lookbackDays }
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
        await nango.log('Google Mail message webhook skipped backfill high-water checkpoint update because the active backfill checkpoint changed.');
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

async function syncBackfill(nango: NangoSyncLocal, checkpoint: NormalizedCheckpoint, lookbackDays: number): Promise<void> {
    const pageToken = checkpoint.phase === 'backfill' ? checkpoint.page_token : undefined;
    let backfillHistoryId = checkpoint.phase === 'backfill' ? checkpoint.backfill_history_id : undefined;

    if (!backfillHistoryId) {
        backfillHistoryId = await getCurrentHistoryId(nango);
    }

    if (!pageToken) {
        await nango.trackDeletesStart('GoogleMailMessage');
    }

    const listResponse = await nango.get({
        // https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list
        endpoint: '/gmail/v1/users/me/messages',
        params: {
            maxResults: 100,
            includeSpamTrash: 'true',
            q: `newer_than:${lookbackDays}d`,
            ...(pageToken && { pageToken })
        },
        retries: 3
    });

    const listData = MessageListResponseSchema.parse(listResponse.data);

    const messages: z.infer<typeof GoogleMailMessage>[] = [];
    for (const messageRef of listData.messages ?? []) {
        const message = await fetchMessage(nango, messageRef.id);
        if (message) {
            messages.push(message);
        }
    }

    if (messages.length > 0) {
        await nango.batchSave(messages, 'GoogleMailMessage');
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

    await nango.trackDeletesEnd('GoogleMailMessage');

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

async function syncIncremental(
    nango: NangoSyncLocal,
    checkpoint: NormalizedCheckpoint,
    options: { preserveCheckpoint?: boolean; lookbackDays: number }
): Promise<string | undefined> {
    const startHistoryId = checkpoint.history_id;
    if (!startHistoryId) {
        await syncBackfill(nango, EMPTY_BACKFILL_CHECKPOINT, options.lookbackDays);
        return undefined;
    }

    let historyResponse: GetResponse;
    try {
        historyResponse = await nango.get({
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
                await syncBackfill(nango, EMPTY_BACKFILL_CHECKPOINT, options.lookbackDays);
            } else {
                await nango.log(
                    `Google Mail message webhook history baseline ${startHistoryId} is no longer available; active backfill checkpoint preserved.`
                );
            }
            return undefined;
        }

        throw error;
    }

    const historyData = HistoryListResponseSchema.parse(historyResponse.data);
    const messageIdsToRefresh = new Set<string>();
    const messageIdsToDelete = new Set<string>();

    for (const record of historyData.history ?? []) {
        for (const message of record.messages ?? []) {
            messageIdsToRefresh.add(message.id);
        }

        for (const added of record.messagesAdded ?? []) {
            messageIdsToRefresh.add(added.message.id);
        }

        for (const labelChange of record.labelsAdded ?? []) {
            messageIdsToRefresh.add(labelChange.message.id);
        }

        for (const labelChange of record.labelsRemoved ?? []) {
            messageIdsToRefresh.add(labelChange.message.id);
        }

        for (const deleted of record.messagesDeleted ?? []) {
            messageIdsToDelete.add(deleted.message.id);
            messageIdsToRefresh.delete(deleted.message.id);
        }
    }

    const messagesToSave: z.infer<typeof GoogleMailMessage>[] = [];
    for (const messageId of messageIdsToRefresh) {
        const message = await fetchMessage(nango, messageId);
        if (message) {
            messagesToSave.push(message);
            continue;
        }

        messageIdsToDelete.add(messageId);
    }

    if (messagesToSave.length > 0) {
        await nango.batchSave(messagesToSave, 'GoogleMailMessage');
    }

    if (messageIdsToDelete.size > 0) {
        await nango.batchDelete(
            Array.from(messageIdsToDelete).map((id) => ({ id })),
            'GoogleMailMessage'
        );
    }

    if (historyData.nextPageToken) {
        if (options.preserveCheckpoint) {
            return syncIncremental(
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

async function resolveMessageLookbackDays(nango: NangoSyncLocal): Promise<number> {
    const parsed = MetadataSchema.safeParse((await nango.getMetadata()) ?? {});
    if (!parsed.success) {
        await nango.log(`Google Mail message sync using default ${DEFAULT_MESSAGE_LOOKBACK_DAYS}-day lookback: metadata did not match schema.`);
        return DEFAULT_MESSAGE_LOOKBACK_DAYS;
    }

    const metadata = parsed.data;
    return metadata.gmailMessageLookbackDays ?? metadata.messageLookbackDays ?? DEFAULT_MESSAGE_LOOKBACK_DAYS;
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
            await nango.log(`Google Mail message sync skipped checkpoint save during ${context}: checkpoint was concurrently updated.`);
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

async function fetchMessage(nango: NangoSyncLocal, messageId: string): Promise<z.infer<typeof GoogleMailMessage> | null> {
    let messageResponse: GetResponse;
    try {
        messageResponse = await nango.get({
            // https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get
            endpoint: `/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`,
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

    return compactGoogleMailMessageRecord(messageResponse.data);
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
