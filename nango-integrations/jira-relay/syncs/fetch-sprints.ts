import { createSync } from 'nango';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// JiraSprint: time-boxed iteration on a Jira scrum board. Sprints are
// board-scoped (not project-scoped) — a single project with two scrum
// boards has two independent sprint streams.
//
// Cloud's bucketer (`bucketJira` → `case 'sprint'`) routes records with
// model name `JiraSprint` (mapped via adapter-jira's `normalizeJiraObjectType`)
// into the `sprints` bucket of `emitJiraAuxiliaryFiles`. The adapter
// materializes:
//
//   /jira/sprints/<slug>__<id>.json   — canonical (slug from name)
//   /jira/sprints/_index.json         — index row
//   /jira/sprints/by-id/<id>.json     — id anchor (added by relayfile-adapters#84)
//
// We deliberately omit `originBoardId` from the projected record because
// the adapter's path mapping doesn't scope sprints by board on disk; the
// `board_id` is still preserved as a payload field for agents that need
// the back-reference.
// ---------------------------------------------------------------------------

const MetadataSchema = z.object({
    cloudId: z.string().optional(),
    baseUrl: z.string().optional(),
});

// Checkpoint: track which board we're paginating through and where we
// left off in the sprint list for that board. The `boardCursor` is an
// index into the board list; `startAt` is the pagination offset within
// the board's sprint list.
const CheckpointSchema = z.object({
    deleteTrackingStarted: z.boolean(),
    boardCursor: z.number(),
    startAt: z.number(),
});

const AccessibleResourcesSchema = z.array(
    z.object({
        id: z.string(),
        url: z.string().optional(),
    }),
);

// Jira Agile Board listing — we filter for `type=scrum` because kanban
// boards don't expose sprints.
// Reference: https://developer.atlassian.com/cloud/jira/software/rest/api-group-board/#api-rest-agile-1-0-board-get
const BoardSchema = z.object({
    id: z.number(),
    name: z.string().optional(),
    type: z.string().optional(),
    location: z
        .object({
            projectId: z.number().optional(),
            projectKey: z.string().optional(),
            projectName: z.string().optional(),
        })
        .optional(),
});
type Board = z.infer<typeof BoardSchema>;

const BoardListResponseSchema = z.object({
    values: z.array(BoardSchema).optional(),
    startAt: z.number().optional(),
    maxResults: z.number().optional(),
    total: z.number().optional(),
    isLast: z.boolean().optional(),
});

// Atlassian Agile sprint payload.
// Reference: https://developer.atlassian.com/cloud/jira/software/rest/api-group-board/#api-rest-agile-1-0-board-boardid-sprint-get
const ProviderSprintSchema = z.object({
    id: z.number(),
    self: z.string().optional(),
    state: z.enum(['active', 'closed', 'future']).optional(),
    name: z.string(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    completeDate: z.string().optional(),
    activatedDate: z.string().optional(),
    originBoardId: z.number().optional(),
    goal: z.string().optional(),
});
type ProviderSprint = z.infer<typeof ProviderSprintSchema>;

const SprintListResponseSchema = z.object({
    values: z.array(ProviderSprintSchema).optional(),
    startAt: z.number().optional(),
    maxResults: z.number().optional(),
    total: z.number().optional(),
    isLast: z.boolean().optional(),
});

const JiraSprint = z.object({
    id: z.string().describe('Sprint id (stringified). Stable across renames; used by emit-aux for path mapping.'),
    name: z.string().describe('Human-readable sprint name.'),
    state: z.enum(['active', 'closed', 'future']).describe('Lifecycle state.'),
    board_id: z.string().optional().describe('Originating scrum board id; the sprint is board-scoped.'),
    goal: z.string().optional().describe('Sprint goal text.'),
    start_date: z.string().optional().describe('ISO 8601 planned start.'),
    end_date: z.string().optional().describe('ISO 8601 planned end.'),
    complete_date: z.string().optional().describe('ISO 8601 actual completion (set when state transitions to closed).'),
    activated_date: z.string().optional().describe('ISO 8601 timestamp when the sprint was activated.'),
    web_url: z.string().optional().describe('Browser link for the sprint board view.'),
});

const DeletedSprintSchema = z.object({
    id: z.union([z.number(), z.string()]),
});

type JiraSprintRecord = z.infer<typeof JiraSprint>;
type NangoSyncLocal = Parameters<(typeof sync)['exec']>[0];

const BOARD_PAGE_SIZE = 50;
const SPRINT_PAGE_SIZE = 50;

const sync = createSync({
    description:
        'Syncs Jira sprints across all scrum boards accessible to the connection. Emits JiraSprint records consumed by adapter-jira `emitSprints`.',
    // ----------------------------------------------------------------------
    // Sync Strategy Gate (per skill `building-nango-functions-locally`):
    //
    // **Change source**: Atlassian's Agile sprint listing endpoint does
    //   NOT support a `since` / `modified_after` filter (verified
    //   against https://developer.atlassian.com/cloud/jira/software/rest/api-group-board/#api-rest-agile-1-0-board-boardid-sprint-get).
    //   The endpoint returns the full sprint history for the board.
    // **Full refresh blocker**: Sprint lifecycle events are exposed via
    //   webhooks (`sprint_started`, `sprint_closed`, etc.), so we use
    //   full refresh on a schedule for safety + webhook for live deltas.
    // **Checkpoint schema**: `{ deleteTrackingStarted, boardCursor, startAt }`
    //   — `boardCursor` indexes into the board list, `startAt` is the
    //   pagination offset within that board's sprint stream. Persisted
    //   after each board completes so a mid-run crash resumes at the
    //   next board (not the start of all boards).
    // **Delete strategy**: full refresh, opened with
    //   `trackDeletesStart('JiraSprint')` before the first board's first
    //   page and closed with `trackDeletesEnd('JiraSprint')` only after
    //   every board has been fully enumerated. Per the skill, the end
    //   call runs ONLY on the successful path.
    // ----------------------------------------------------------------------
    version: '1.0.0',
    frequency: 'every 6 hours',
    autoStart: true,
    syncType: 'full',
    endpoints: [{ method: 'GET', path: '/jira/sprints', group: 'Jira' }],
    metadata: MetadataSchema,
    checkpoint: CheckpointSchema,
    models: {
        JiraSprint,
    },
    scopes: [
        'read:board-scope:jira-software',
        'read:sprint:jira-software',
        'read:project:jira',
    ],
    webhookSubscriptions: [
        'sprint_created',
        'sprint_updated',
        'sprint_started',
        'sprint_closed',
        'sprint_deleted',
        'jira:sprint_created',
        'jira:sprint_updated',
        'jira:sprint_started',
        'jira:sprint_closed',
        'jira:sprint_deleted',
    ],

    exec: async (nango) => {
        const site = await getJiraSite(nango);

        const parsedCheckpoint = CheckpointSchema.safeParse(await nango.getCheckpoint());
        const checkpoint = parsedCheckpoint.success
            ? parsedCheckpoint.data
            : { deleteTrackingStarted: false, boardCursor: 0, startAt: 0 };

        if (!checkpoint.deleteTrackingStarted) {
            await nango.trackDeletesStart('JiraSprint');
            await nango.saveCheckpoint({
                deleteTrackingStarted: true,
                boardCursor: checkpoint.boardCursor,
                startAt: checkpoint.startAt,
            });
        }

        // Step 1: enumerate scrum boards (gathering all of them first
        // is simpler than interleaving — boards are typically O(10s),
        // not O(1000s)).
        const boards: Board[] = [];
        let boardStartAt = 0;
        while (true) {
            const response = await nango.get({
                // https://developer.atlassian.com/cloud/jira/software/rest/api-group-board/#api-rest-agile-1-0-board-get
                endpoint: `/ex/jira/${site.cloudId}/rest/agile/1.0/board`,
                params: {
                    startAt: boardStartAt,
                    maxResults: BOARD_PAGE_SIZE,
                    type: 'scrum',
                },
                retries: 3,
            });

            const data = BoardListResponseSchema.parse(response.data);
            const batch = data.values ?? [];
            boards.push(...batch);

            const nextStartAt = boardStartAt + (data.maxResults ?? batch.length);
            const hasMore = data.isLast === false || (data.total !== undefined && nextStartAt < data.total);
            if (!hasMore || batch.length === 0) {
                break;
            }
            boardStartAt = nextStartAt;
        }

        // Step 2: for each board (starting from the checkpoint cursor),
        // enumerate sprints. `startAt` resumes mid-board on a previous
        // crash; once a board completes, `startAt` resets to 0 and
        // `boardCursor` advances.
        for (let boardIdx = checkpoint.boardCursor; boardIdx < boards.length; boardIdx += 1) {
            const board = boards[boardIdx];
            if (!board) {
                continue;
            }
            let startAt = boardIdx === checkpoint.boardCursor ? checkpoint.startAt : 0;

            while (true) {
                const response = await nango.get({
                    // https://developer.atlassian.com/cloud/jira/software/rest/api-group-board/#api-rest-agile-1-0-board-boardid-sprint-get
                    endpoint: `/ex/jira/${site.cloudId}/rest/agile/1.0/board/${board.id}/sprint`,
                    params: {
                        startAt,
                        maxResults: SPRINT_PAGE_SIZE,
                    },
                    retries: 3,
                });

                const data = SprintListResponseSchema.parse(response.data);
                const sprintRecords = (data.values ?? []).map((sprint) =>
                    toJiraSprintRecord(sprint, board.id, site.baseUrl),
                );

                if (sprintRecords.length > 0) {
                    await nango.batchSave(sprintRecords, 'JiraSprint');
                }

                const nextStartAt = startAt + (data.maxResults ?? sprintRecords.length);
                const hasMore = data.isLast === false || (data.total !== undefined && nextStartAt < data.total);
                if (!hasMore || sprintRecords.length === 0) {
                    break;
                }

                startAt = nextStartAt;
                await nango.saveCheckpoint({
                    deleteTrackingStarted: true,
                    boardCursor: boardIdx,
                    startAt,
                });
            }

            // Advance the board cursor after fully enumerating this board.
            await nango.saveCheckpoint({
                deleteTrackingStarted: true,
                boardCursor: boardIdx + 1,
                startAt: 0,
            });
        }

        // Only close the deletion window after every board completed.
        await nango.trackDeletesEnd('JiraSprint');
        await nango.clearCheckpoint();
    },

    onWebhook: async (nango, payload) => {
        const webhook = payload as { webhookEvent?: string; sprint?: unknown };
        const rawSprint = webhook.sprint ?? payload;
        const event = (webhook.webhookEvent ?? '').toLowerCase();
        if (event.includes('deleted')) {
            const deleted = DeletedSprintSchema.safeParse(rawSprint);
            if (!deleted.success) {
                await nango.log('Jira sprint delete webhook skipped because sprint.id was missing.', { level: 'warn' });
                return;
            }
            await nango.batchDelete([{ id: String(deleted.data.id) }], 'JiraSprint');
            return;
        }

        const sprint = ProviderSprintSchema.safeParse(rawSprint);
        if (!sprint.success) {
            await nango.log('Jira sprint webhook skipped because the sprint payload was missing or invalid.', {
                level: 'warn',
            });
            return;
        }

        const site = await getJiraSite(nango);
        await nango.batchSave(
            [toJiraSprintRecord(sprint.data, sprint.data.originBoardId, site.baseUrl)],
            'JiraSprint',
        );
    },
});

export default sync;

function toJiraSprintRecord(
    sprint: ProviderSprint,
    boardId: number | undefined,
    baseUrl: string,
): JiraSprintRecord {
    const record: JiraSprintRecord = {
        id: String(sprint.id),
        name: sprint.name,
        state: sprint.state ?? 'future',
    };
    if (boardId !== undefined) {
        record.board_id = String(boardId);
        // The Jira UI's RapidBoard view links to `?rapidView=<boardId>&view=planning&selectedIssue=`.
        // We point at the sprint via its `useStoredSettings=true` deeplink instead.
        record.web_url = `${baseUrl}/jira/software/c/projects/-/boards/${boardId}/timeline?sprint=${sprint.id}`;
    }
    if (sprint.goal) record.goal = sprint.goal;
    if (sprint.startDate) record.start_date = sprint.startDate;
    if (sprint.endDate) record.end_date = sprint.endDate;
    if (sprint.completeDate) record.complete_date = sprint.completeDate;
    if (sprint.activatedDate) record.activated_date = sprint.activatedDate;
    return record;
}

async function getJiraSite(nango: NangoSyncLocal): Promise<{ cloudId: string; baseUrl: string }> {
    const metadata = await getMetadata(nango);
    if (metadata.cloudId && metadata.baseUrl) {
        return { cloudId: metadata.cloudId, baseUrl: metadata.baseUrl };
    }

    const connection = await nango.getConnection();
    const configCloudId = connection.connection_config?.['cloudId'];
    const configBaseUrl = connection.connection_config?.['baseUrl'];
    if (typeof configCloudId === 'string' && typeof configBaseUrl === 'string') {
        return { cloudId: configCloudId, baseUrl: configBaseUrl };
    }

    const response = await nango.get({
        // https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/#2-get-the-cloudid-for-your-site
        endpoint: 'oauth/token/accessible-resources',
        baseUrlOverride: 'https://api.atlassian.com',
        retries: 3,
    });

    const resources = AccessibleResourcesSchema.parse(response.data);
    const resource = selectAccessibleResource(resources, {
        cloudId: typeof configCloudId === 'string' ? configCloudId : metadata.cloudId,
        baseUrl: typeof configBaseUrl === 'string' ? configBaseUrl : metadata.baseUrl,
    });
    if (!resource?.id || !resource.url) {
        throw new Error(
            resources.length > 1
                ? `Multiple accessible Jira resources found (${resources
                      .map((item) => `${item.id}:${item.url ?? 'unknown-url'}`)
                      .join(', ')}); configure cloudId/baseUrl metadata before syncing.`
                : 'No accessible Jira resource found.',
        );
    }

    await nango.updateMetadata({ ...metadata, cloudId: resource.id, baseUrl: resource.url });
    return { cloudId: resource.id, baseUrl: resource.url };
}

async function getMetadata(nango: NangoSyncLocal): Promise<z.infer<typeof MetadataSchema>> {
    try {
        return MetadataSchema.parse((await nango.getMetadata()) ?? {});
    } catch {
        return {};
    }
}

function selectAccessibleResource(
    resources: Array<{ id: string; url?: string | undefined }>,
    hint: { cloudId?: string | undefined; baseUrl?: string | undefined },
): { id: string; url?: string | undefined } | undefined {
    // Mirror the safety pattern in fetch-projects.ts / fetch-issues.ts:
    // when a hint is provided but does not match any resource, refuse
    // rather than silently picking the wrong tenant. Only auto-select
    // when a single resource exists; otherwise force the caller to
    // configure cloudId/baseUrl metadata.
    const normalizedHintUrl = normalizeBaseUrl(hint.baseUrl);
    const hinted = resources.find(
        (resource) =>
            (hint.cloudId && resource.id === hint.cloudId) ||
            (normalizedHintUrl && normalizeBaseUrl(resource.url) === normalizedHintUrl),
    );
    if (hinted) {
        return hinted;
    }
    if (hint.cloudId || hint.baseUrl) {
        // Hint was provided but matched nothing — refuse so the caller's
        // error path surfaces the misconfiguration rather than silently
        // syncing the wrong tenant.
        return undefined;
    }
    if (resources.length === 1) {
        return resources[0];
    }
    return undefined;
}

function normalizeBaseUrl(url: string | undefined): string | undefined {
    return url ? url.replace(/\/$/u, '').toLowerCase() : undefined;
}
