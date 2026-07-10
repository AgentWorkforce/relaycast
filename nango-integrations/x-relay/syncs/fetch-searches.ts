import { createHash } from 'crypto';
import { createSync, type NangoSync } from 'nango';
import * as z from 'zod';

const POST_READ_UNIT_USD = 0.005;
const USER_READ_UNIT_USD = 0.01;
const DEFAULT_MAX_RESULTS = 25;
const DEFAULT_MAX_USER_READS = 10;
const DEFAULT_BUDGET_USD = 1;

const XSearchMode = z.enum(['recent', 'archive']);

const XSearchConfig = z.object({
    id: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    query: z.string().min(1),
    mode: XSearchMode.optional(),
    maxResults: z.number().int().min(10).max(100).optional(),
    maxUserReads: z.number().int().min(0).max(100).optional(),
    budgetUsd: z.number().min(0).max(100).optional(),
    sinceId: z.string().min(1).optional(),
    untilId: z.string().min(1).optional(),
    startTime: z.string().datetime().optional(),
    endTime: z.string().datetime().optional()
});

const XMetadata = z.object({
    searches: z.array(XSearchConfig).max(25).optional(),
    defaultMaxResults: z.number().int().min(10).max(100).optional(),
    defaultMaxUserReads: z.number().int().min(0).max(100).optional(),
    defaultBudgetUsd: z.number().min(0).max(100).optional()
});

type XSearchConfig = z.infer<typeof XSearchConfig>;
type XMetadata = z.infer<typeof XMetadata>;

const XPublicMetrics = z
    .object({
        retweet_count: z.number().optional(),
        reply_count: z.number().optional(),
        like_count: z.number().optional(),
        quote_count: z.number().optional(),
        bookmark_count: z.number().optional(),
        impression_count: z.number().optional()
    })
    .passthrough();

const XPost = z
    .object({
        id: z.string(),
        text: z.string(),
        author_id: z.string().optional(),
        created_at: z.string().optional(),
        conversation_id: z.string().optional(),
        in_reply_to_user_id: z.string().optional(),
        lang: z.string().optional(),
        possibly_sensitive: z.boolean().optional(),
        public_metrics: XPublicMetrics.optional(),
        referenced_tweets: z.array(z.record(z.string(), z.unknown())).optional(),
        entities: z.record(z.string(), z.unknown()).optional(),
        attachments: z.record(z.string(), z.unknown()).optional(),
        edit_history_tweet_ids: z.array(z.string()).optional()
    })
    .passthrough();

const XUser = z
    .object({
        id: z.string(),
        username: z.string().optional(),
        name: z.string().optional(),
        verified: z.boolean().optional(),
        verified_type: z.string().optional(),
        profile_image_url: z.string().optional(),
        description: z.string().optional(),
        public_metrics: z.record(z.string(), z.unknown()).optional()
    })
    .passthrough();

const XApiResponse = z
    .object({
        data: z.array(XPost).optional(),
        includes: z
            .object({
                users: z.array(XUser).optional()
            })
            .passthrough()
            .optional(),
        meta: z
            .object({
                newest_id: z.string().optional(),
                oldest_id: z.string().optional(),
                result_count: z.number().optional(),
                next_token: z.string().optional()
            })
            .passthrough()
            .optional()
    })
    .passthrough();

const XSearchRun = z
    .object({
        id: z.string(),
        title: z.string(),
        query: z.string(),
        mode: XSearchMode,
        requestedAt: z.string(),
        nextToken: z.string().optional(),
        resultCount: z.number(),
        costEstimate: z.object({
            posts: z.number(),
            users: z.number(),
            postReadUnitUsd: z.number(),
            userReadUnitUsd: z.number(),
            estimatedUsd: z.number(),
            cappedByBudget: z.boolean(),
            cappedByMaxResults: z.boolean()
        }),
        budgetUsd: z.number().optional(),
        source: z.object({
            provider: z.literal('x'),
            endpoint: z.enum(['/2/tweets/search/recent', '/2/tweets/search/all']),
            docs: z.string()
        })
    })
    .passthrough();

const XSearchResult = z
    .object({
        id: z.string(),
        searchId: z.string(),
        postId: z.string(),
        rank: z.number(),
        matchedAt: z.string(),
        canonicalPath: z.string().optional(),
        query: z.string()
    })
    .passthrough();

type XPost = z.infer<typeof XPost>;
type XUser = z.infer<typeof XUser>;

const sync = createSync({
    description:
        'Runs configured X recent/archive searches with per-search budget caps. Emits XSearchBundle records for Relayfile social search.',
    version: '1.0.0',
    frequency: 'every 6 hours',
    autoStart: false,
    endpoints: [{ method: 'GET', path: '/x/searches', group: 'X' }],
    metadata: XMetadata,
    models: {
        XSearchBundle: z
            .object({
                id: z.string(),
                run: XSearchRun,
                posts: z.array(XPost),
                users: z.array(XUser),
                results: z.array(XSearchResult),
                rawResponses: z.array(XApiResponse)
            })
            .passthrough()
    },
    scopes: ['tweet.read', 'users.read', 'offline.access'],

    exec: async (nango) => {
        const metadata = XMetadata.parse((await nango.getMetadata()) ?? {});
        const searches = metadata.searches ?? [];
        if (searches.length === 0) {
            await nango.log('X search sync skipped because no metadata.searches are configured.', { level: 'warn' });
            return;
        }

        for (const search of searches) {
            await runSearch(nango, metadata, search);
        }
    }
});

async function runSearch(nango: NangoSync, metadata: XMetadata, search: XSearchConfig): Promise<void> {
    const mode = search.mode ?? 'recent';
    const searchId = search.id ?? deriveSearchId(search.query, mode);
    const title = search.title ?? search.query;
    const requestedAt = new Date().toISOString();
    const endpoint = mode === 'archive' ? '/2/tweets/search/all' : '/2/tweets/search/recent';
    const maxResults = Math.min(search.maxResults ?? metadata.defaultMaxResults ?? DEFAULT_MAX_RESULTS, 100);
    const maxUserReads = Math.min(search.maxUserReads ?? metadata.defaultMaxUserReads ?? DEFAULT_MAX_USER_READS, 100);
    const budgetUsd = search.budgetUsd ?? metadata.defaultBudgetUsd ?? DEFAULT_BUDGET_USD;

    const pageCost = estimateCost(maxResults, Math.min(maxResults, maxUserReads));
    if (pageCost.estimatedUsd > budgetUsd) {
        await nango.log(
            `X search "${title}" skipped because estimated page cost $${pageCost.estimatedUsd.toFixed(2)} exceeds budget $${budgetUsd.toFixed(2)}.`,
            { level: 'warn' }
        );
        return;
    }

    const response = await nango.get<unknown>({
        endpoint,
        params: {
            query: search.query,
            max_results: maxResults,
            'tweet.fields': 'author_id,conversation_id,created_at,entities,lang,public_metrics,referenced_tweets,text',
            expansions: 'author_id',
            'user.fields': 'id,name,username,verified,verified_type,profile_image_url,description,public_metrics',
            ...(search.sinceId ? { since_id: search.sinceId } : {}),
            ...(search.untilId ? { until_id: search.untilId } : {}),
            ...(search.startTime ? { start_time: search.startTime } : {}),
            ...(search.endTime ? { end_time: search.endTime } : {})
        },
        retries: 2
    });
    const parsed = XApiResponse.parse(response.data);
    const posts = (parsed.data ?? []).slice(0, maxResults);
    const users = dedupeById(parsed.includes?.users ?? []).slice(0, maxUserReads);
    const costEstimate = estimateCost(posts.length, users.length);
    const run = XSearchRun.parse({
        id: searchId,
        title,
        query: search.query,
        mode,
        requestedAt,
        ...(parsed.meta?.next_token ? { nextToken: parsed.meta.next_token } : {}),
        resultCount: posts.length,
        costEstimate,
        budgetUsd,
        source: {
            provider: 'x',
            endpoint,
            docs: 'https://docs.x.com/x-api/posts/search/introduction'
        }
    });
    const results = posts.map((post, index) =>
        XSearchResult.parse({
            id: `${searchId}:${post.id}`,
            searchId,
            postId: post.id,
            rank: index + 1,
            matchedAt: requestedAt,
            query: search.query
        })
    );

    await nango.batchSave(
        [{
            id: searchId,
            run,
            posts,
            users,
            results,
            rawResponses: [parsed]
        }],
        'XSearchBundle'
    );
}

function estimateCost(posts: number, users: number) {
    const estimatedUsd = roundUsd(posts * POST_READ_UNIT_USD + users * USER_READ_UNIT_USD);
    return {
        posts,
        users,
        postReadUnitUsd: POST_READ_UNIT_USD,
        userReadUnitUsd: USER_READ_UNIT_USD,
        estimatedUsd,
        cappedByBudget: false,
        cappedByMaxResults: false
    };
}

function dedupeById(users: readonly XUser[]): XUser[] {
    return [...new Map(users.map((user) => [user.id, user])).values()];
}

function deriveSearchId(query: string, mode: string): string {
    return createHash('sha256').update(`${mode}\0${query}`).digest('hex').slice(0, 16);
}

function roundUsd(value: number): number {
    return Math.round(value * 100_000) / 100_000;
}

export default sync;
