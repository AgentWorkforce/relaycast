import { createHash } from 'crypto';
import { createSync, type NangoSync } from 'nango';
import * as z from 'zod';
import { createRequestThrottle, type NotionRequestHook } from '../utils.js';
// Single source of truth for record shapes + extraction helpers shared with
// the cloud forward-webhook handler. See header of that file for parity
// guarantees.
import {
    NotionPageSchema as NotionPage,
    NotionPageContentSchema as NotionPageContent,
    extractNotionPageTitle,
    extractNotionParentInfo,
    extractNotionContentPreview,
    type NotionPageRecord,
    type NotionPageContentRecord
} from '../shared/notion-record-shapes.js';

const NotionCheckpointSchema = z.object({
    lastEditedTime: z.string(),
    lastEditedIdsJson: z.string()
});

type NotionCheckpoint = z.infer<typeof NotionCheckpointSchema>;

interface NotionSearchPage {
    id: string;
    url?: string;
    last_edited_time: string;
    properties?: Record<string, unknown>;
    parent?: Record<string, unknown>;
    archived?: boolean;
    in_trash?: boolean;
    object?: string;
}

interface NotionBlocksResponse {
    results?: Array<Record<string, unknown>>;
}

interface NotionMarkdownResponse {
    object?: string;
    id?: string;
    markdown?: string;
    truncated?: boolean;
}

// Notion webhook envelope. The Nango notion provider's
// `webhook_routing_script` (notionWebhookRouting) forwards the verified
// payload to syncs whose `webhookSubscriptions` array matches the envelope's
// `type` field. Shape per Notion's webhook docs — `entity.id` is the page
// (or database/block/comment) id; `data` carries event-specific extras (e.g.
// `data.parent` for moves). See:
// https://developers.notion.com/reference/webhooks-events-delivery
interface NotionWebhookEnvelope {
    id?: string;
    timestamp?: string;
    workspace_id?: string;
    type?: string;
    entity?: { id?: string; type?: string };
    data?: Record<string, unknown>;
}

// Webhook event types this sync subscribes to. Covers everything that
// could change a page's projected metadata OR body — both records are
// emitted from the same handler so they stay in lockstep.
const PAGE_WEBHOOK_EVENTS = [
    'page.created',
    'page.content_updated',
    'page.properties_updated',
    'page.moved',
    'page.deleted',
    'page.undeleted',
    'page.locked',
    'page.unlocked'
] as const;

const isDeleteEvent = (type: string | undefined): boolean => {
    return type === 'page.deleted';
};

const BLOCK_PAGE_SIZE = 20;
const SEARCH_PAGE_SIZE = 100;
const NOTION_REQUEST_INTERVAL_MS = 400;
// Notion's `/v1/pages/{id}/markdown` endpoint requires the markdown-aware
// API version. Must stay aligned with `DEFAULT_NOTION_MARKDOWN_API_VERSION`
// in `@relayfile/adapter-notion/types`.
const NOTION_MARKDOWN_API_VERSION = '2026-03-11';

const getErrorMessage = (error: unknown): string => {
    return error instanceof Error ? error.message : String(error);
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

// SHA-256 over the markdown body. Lets workspace consumers short-circuit
// re-processing when the body hasn't changed. Uses node:crypto rather than
// Web Crypto because Nango's sandbox doesn't define `TextEncoder` as a
// global; `crypto.createHash` is on Nango's import allowlist.
const sha256Hex = (input: string): string => {
    return createHash('sha256').update(input, 'utf8').digest('hex');
};

const fetchContentPreview = async (nango: NangoSync, pageId: string, beforeRequest: NotionRequestHook): Promise<string> => {
    try {
        await beforeRequest();
        const response = await nango.get({
            endpoint: `/v1/blocks/${pageId}/children`,
            params: { page_size: String(BLOCK_PAGE_SIZE) },
            retries: 10
        });

        const data = response.data as NotionBlocksResponse | undefined;
        return extractNotionContentPreview((data?.results ?? []) as Array<Record<string, unknown>>);
    } catch {
        return '';
    }
};

const fetchPageMarkdown = async (
    nango: NangoSync,
    pageId: string,
    beforeRequest: NotionRequestHook
): Promise<string | null> => {
    try {
        await beforeRequest();
        const response = await nango.get({
            endpoint: `/v1/pages/${encodeURIComponent(pageId)}/markdown`,
            // The markdown endpoint is only available on the `2026-03-11`
            // API version. Older versions 404.
            headers: { 'Notion-Version': NOTION_MARKDOWN_API_VERSION },
            retries: 10
        });

        const data = response.data as NotionMarkdownResponse | undefined;
        if (!data || typeof data.markdown !== 'string') {
            return null;
        }
        return data.markdown;
    } catch (error) {
        await nango.log(
            `Failed to fetch markdown for Notion page ${pageId}: ${getErrorMessage(error)}`,
            { level: 'warn' }
        );
        return null;
    }
};

const fetchPageById = async (nango: NangoSync, pageId: string): Promise<NotionSearchPage | null> => {
    try {
        const response = await nango.get({
            endpoint: `/v1/pages/${encodeURIComponent(pageId)}`,
            retries: 3
        });
        const data = response.data as NotionSearchPage | undefined;
        if (!data || typeof data.id !== 'string') {
            return null;
        }
        return data;
    } catch (error) {
        await nango.log(
            `Failed to fetch Notion page ${pageId}: ${getErrorMessage(error)}`,
            { level: 'warn' }
        );
        return null;
    }
};

// Per-sync database-title cache. Page records whose parent is a database need
// `database_title` to flow through the adapter-notion by-database alias emit
// gate. Notion's /v1/databases/{id} response carries the title; we look it up
// once per unique database referenced in this sync run and reuse. Empty-string
// values are stored on lookup failure so we don't re-call the API repeatedly
// for an inaccessible database within the same run.
const fetchDatabaseTitle = async (
    nango: NangoSync,
    databaseId: string,
    cache: Map<string, string>,
    requestThrottle: NotionRequestHook
): Promise<string> => {
    const cached = cache.get(databaseId);
    if (cached !== undefined) {
        return cached;
    }
    try {
        await requestThrottle();
        const response = await nango.get({
            endpoint: `/v1/databases/${encodeURIComponent(databaseId)}`,
            retries: 3
        });
        const data = response.data as { title?: unknown } | undefined;
        const title = extractDatabaseTitlePlainText(data?.title);
        cache.set(databaseId, title);
        return title;
    } catch (error) {
        await nango.log(
            `Failed to fetch Notion database ${databaseId} for title enrichment: ${getErrorMessage(error)}`,
            { level: 'warn' }
        );
        // Cache empty so we don't retry within this run; the next sync run
        // will try again with a fresh cache.
        cache.set(databaseId, '');
        return '';
    }
};

const extractDatabaseTitlePlainText = (value: unknown): string => {
    if (!Array.isArray(value)) {
        return '';
    }
    return value
        .map((fragment) => {
            if (
                fragment !== null &&
                typeof fragment === 'object' &&
                !Array.isArray(fragment) &&
                typeof (fragment as Record<string, unknown>)['plain_text'] === 'string'
            ) {
                return (fragment as Record<string, unknown>)['plain_text'] as string;
            }
            return '';
        })
        .join('')
        .trim();
};

const buildPageRecord = async (
    nango: NangoSync,
    page: NotionSearchPage,
    requestThrottle: NotionRequestHook,
    databaseTitleCache: Map<string, string>
): Promise<NotionPageRecord> => {
    const parentInfo = extractNotionParentInfo(page.parent);
    const base: NotionPageRecord = {
        id: page.id,
        title: extractNotionPageTitle(page.properties),
        url: page.url ?? '',
        ...parentInfo,
        last_edited_time: page.last_edited_time,
        content_preview: page.archived === true || page.in_trash === true
            ? ''
            : await fetchContentPreview(nango, page.id, requestThrottle),
        archived: page.archived === true,
        in_trash: page.in_trash === true
    };
    // Only database-rooted pages need the by-database alias enrichment.
    if (parentInfo.parent_type === 'database' && parentInfo.parent_id) {
        const databaseId = parentInfo.parent_id;
        const databaseTitle = await fetchDatabaseTitle(nango, databaseId, databaseTitleCache, requestThrottle);
        base.database_id = databaseId;
        if (databaseTitle) {
            base.database_title = databaseTitle;
        }
    }
    return base;
};

const buildContentRecord = (page: NotionSearchPage, markdown: string): NotionPageContentRecord => {
    return {
        id: page.id,
        pageId: page.id,
        content: markdown,
        contentHash: sha256Hex(markdown),
        lastEditedTime: page.last_edited_time
    };
};

const collectExistingIds = async (nango: NangoSync, model: 'NotionPage' | 'NotionPageContent'): Promise<Set<string>> => {
    const ids = new Set<string>();
    if (model === 'NotionPage') {
        for await (const record of nango.listRecords<NotionPageRecord>('NotionPage')) {
            ids.add(String(record.id));
        }
    } else {
        for await (const record of nango.listRecords<NotionPageContentRecord>('NotionPageContent')) {
            ids.add(String(record.id));
        }
    }
    return ids;
};

export default createSync({
    description: 'Fetches accessible Notion pages with metadata + markdown body, kept current via Notion page webhooks. Emits NotionPage (metadata) and NotionPageContent (rendered markdown) in lockstep so workspace subscribers see metadata and body materialized atomically.',
    version: '2.0.0',
    frequency: 'every 12 hours',
    autoStart: true,
    syncType: 'incremental',
    endpoints: [
        { method: 'GET', path: '/notion-relay/pages', group: 'Notion' },
        { method: 'GET', path: '/notion-relay/page-content', group: 'Notion' }
    ],
    metadata: z.object({}),
    checkpoint: NotionCheckpointSchema,
    models: { NotionPage, NotionPageContent },

    // Subscribe to Notion's full page lifecycle, INCLUDING content edits.
    // The webhook handler emits both NotionPage and NotionPageContent, so
    // there's no second sync to coordinate with.
    webhookSubscriptions: [...PAGE_WEBHOOK_EVENTS],

    exec: async (nango) => {
        const requestThrottle = createRequestThrottle(NOTION_REQUEST_INTERVAL_MS);
        const checkpoint = (await nango.getCheckpoint()) as NotionCheckpoint | null;
        const lastEditedTime = checkpoint?.lastEditedTime ?? '';
        const lastEditedIds = parseCheckpointIds(checkpoint);
        const checkpointState = {
            latestEditedTime: lastEditedTime,
            latestEditedIds: new Set(lastEditedIds)
        };
        const currentIds = new Set<string>();
        // Per-run cache so each unique parent-database is looked up once.
        // See `fetchDatabaseTitle` for the empty-string-on-failure sentinel.
        const databaseTitleCache = new Map<string, string>();

        // Snapshot of NotionPageContent ids we've materialized previously.
        // Used to force-fetch the body for any page whose metadata sits
        // at-or-before the checkpoint but whose body is still missing.
        // This covers every "page existed, body never landed" edge case
        // (failed prior fetch, sync interrupted between metadata and body
        // batches, etc.) and is robust without needing any cross-sync
        // listRecords semantics — both models live in this sync now.
        const existingContentIds = await collectExistingIds(nango, 'NotionPageContent');

        try {
            for await (const pageBatch of nango.paginate({
                endpoint: '/v1/search',
                method: 'post',
                data: {
                    filter: { property: 'object', value: 'page' },
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
                const pageRecords: NotionPageRecord[] = [];
                const contentRecords: NotionPageContentRecord[] = [];
                const pages = pageBatch as NotionSearchPage[];

                for (const page of pages) {
                    currentIds.add(page.id);

                    const isCheckpointEligible = shouldSyncRecord(page, lastEditedTime, lastEditedIds);
                    const isBodyMissing = !existingContentIds.has(page.id);
                    if (!isCheckpointEligible && !isBodyMissing) {
                        // Already at-or-before the checkpoint AND we have
                        // both metadata and body for it — skip. The prior
                        // run's checkpoint already covers this page, so we
                        // don't need to (and shouldn't) re-advance state
                        // here.
                        continue;
                    }

                    pageRecords.push(
                        await buildPageRecord(nango, page, requestThrottle, databaseTitleCache)
                    );

                    if (page.archived === true || page.in_trash === true) {
                        updateCheckpointState(checkpointState, page.id, page.last_edited_time);
                        continue;
                    }

                    const markdown = await fetchPageMarkdown(nango, page.id, requestThrottle);
                    if (markdown !== null) {
                        contentRecords.push(buildContentRecord(page, markdown));
                        // Advance the watermark ONLY after a successful body
                        // fetch. If markdown was null (transient failure or
                        // body not yet available), leave the watermark
                        // untouched so the next cycle retries the body —
                        // critical for pages that already have a stale
                        // `NotionPageContent` row, where advancing the
                        // watermark would pin them as "skip" forever
                        // (`shouldSyncRecord` false AND `isBodyMissing`
                        // false) until the user re-edits. (Codex P1 on PR
                        // #484; same discipline as the deleted
                        // `fetch-page-content` sync had.)
                        updateCheckpointState(checkpointState, page.id, page.last_edited_time);
                    }
                    // The metadata record is still queued; that's safe to
                    // ship — the body just retries on the next cycle.
                }

                if (pageRecords.length > 0) {
                    await nango.batchSave(pageRecords, 'NotionPage');
                }
                if (contentRecords.length > 0) {
                    await nango.batchSave(contentRecords, 'NotionPageContent');
                }
            }

            const pageIdsToDelete: string[] = [];
            for await (const record of nango.listRecords<NotionPageRecord>('NotionPage')) {
                const id = String(record.id);
                if (!currentIds.has(id)) {
                    pageIdsToDelete.push(id);
                }
            }
            if (pageIdsToDelete.length > 0) {
                await nango.batchDelete(pageIdsToDelete.map((id) => ({ id })), 'NotionPage');
            }

            // Clean stale content rows in the same pass — anything in
            // NotionPageContent whose page is no longer accessible.
            const contentIdsToDelete = Array.from(existingContentIds).filter((id) => !currentIds.has(id));
            if (contentIdsToDelete.length > 0) {
                await nango.batchDelete(contentIdsToDelete.map((id) => ({ id })), 'NotionPageContent');
            }
        } catch (error) {
            await nango.log(`Failed to sync Notion pages: ${getErrorMessage(error)}`);
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
        // The Notion provider's webhook routing script verifies the
        // `webhook_user_defined_secret` HMAC and forwards the payload here
        // for any event in `webhookSubscriptions`. The envelope's
        // `entity.id` is the page id; we re-fetch the page to get fresh
        // title/parent/URL rather than trusting the (possibly partial)
        // data inlined in the webhook.
        const webhook = payload as NotionWebhookEnvelope;
        const eventType = typeof webhook.type === 'string' ? webhook.type : '';
        const pageId = webhook.entity?.id;
        if (!pageId) {
            await nango.log(
                `Notion webhook skipped: missing entity.id (type=${eventType || 'unknown'})`,
                { level: 'warn' }
            );
            return;
        }

        // Only react to page events. The same sync may receive other types
        // if the dashboard subscription is misconfigured — be defensive.
        if (webhook.entity?.type && webhook.entity.type !== 'page') {
            return;
        }

        try {
            if (isDeleteEvent(eventType)) {
                await nango.batchDelete([{ id: pageId }], 'NotionPage');
                await nango.batchDelete([{ id: pageId }], 'NotionPageContent');
                return;
            }

            const requestThrottle = createRequestThrottle(NOTION_REQUEST_INTERVAL_MS);
            const page = await fetchPageById(nango, pageId);
            if (!page) {
                await nango.log(
                    `Notion page webhook skipped: page ${pageId} could not be fetched (type=${eventType})`,
                    { level: 'warn' }
                );
                return;
            }

            // Webhook handlers don't share a cache across invocations — the
            // worst case is one extra databases.retrieve per parent-database
            // per webhook delivery, which is far cheaper than batch syncs.
            const webhookDatabaseTitleCache = new Map<string, string>();
            const pageRecord = await buildPageRecord(nango, page, requestThrottle, webhookDatabaseTitleCache);
            await nango.batchSave([pageRecord], 'NotionPage');

            if (page.archived === true || page.in_trash === true) {
                return;
            }

            const markdown = await fetchPageMarkdown(nango, page.id, requestThrottle);
            if (markdown !== null) {
                await nango.batchSave([buildContentRecord(page, markdown)], 'NotionPageContent');
            }
        } catch (error) {
            await nango.log(
                `Failed to process Notion page webhook (type=${eventType}, id=${pageId}): ${getErrorMessage(error)}`
            );
            throw error;
        }
    }
});
