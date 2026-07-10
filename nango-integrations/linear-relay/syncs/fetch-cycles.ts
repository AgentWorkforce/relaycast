import { createSync } from 'nango';
import * as z from 'zod';

import {
    INITIAL_UPDATED_AFTER,
    LinearCheckpointSchema,
    formatError,
    requireLinearConnection,
    toIsoString,
    toNullableIsoString,
    type LinearConnection,
    type LinearCheckpoint,
    type LinearGraphqlResponse,
} from './helpers.js';

// ---------------------------------------------------------------------------
// LinearCycle: a time-boxed iteration scoped to one team. Linear's GraphQL
// schema treats cycles as first-class entities orthogonal to projects;
// agents need them for "what's the current sprint planning around" lookups
// that cannot be answered from issue-state alone.
//
// Cloud's bucketer (`bucketLinear` → `case 'cycle'`) routes records with
// model name `LinearCycle` (mapped from `NANGO_MODEL_MAP` in
// adapter-linear/path-mapper) into the `cycles` bucket of
// `emitLinearAuxiliaryFiles`, which materializes the canonical record
// and any LAYOUT-documented alias subtrees the adapter implements.
// ---------------------------------------------------------------------------

const LinearCycle = z.object({
    id: z.string().describe('Linear cycle UUID, e.g. `5b1a3b9e-1f4c-4f3e-9c8e-2e8e0e6c7c2a`.'),
    name: z.string().describe('Human-readable cycle name; may be empty if Linear auto-numbered the cycle.'),
    number: z.number().describe('Sequential cycle number within the owning team (starts at 1).'),
    description: z.string().nullable().describe('Free-text cycle description, or `null` if unset.'),
    team_id: z.string().describe('Owning team UUID. Every cycle is team-scoped.'),
    starts_at: z.string().nullable().describe('ISO 8601 cycle start (cycles can be scheduled with no fixed start in some teams).'),
    ends_at: z.string().nullable().describe('ISO 8601 cycle end.'),
    completed_at: z.string().nullable().describe('ISO 8601 completion timestamp, or `null` until the cycle closes.'),
    progress: z.number().nullable().describe('Fraction completed in [0, 1].'),
    created_at: z.string().describe('ISO 8601 creation timestamp.'),
    updated_at: z
        .string()
        .describe('ISO 8601 last-modified timestamp. Drives the incremental checkpoint cursor.'),
});

type LinearCycleRecord = z.infer<typeof LinearCycle>;

interface LinearCycleNode {
    id: string;
    name?: string | null;
    number?: number | null;
    description?: string | null;
    team?: { id?: string | null } | null;
    startsAt?: string | null;
    endsAt?: string | null;
    completedAt?: string | null;
    progress?: number | null;
    createdAt?: string | null;
    updatedAt?: string | null;
}

interface LinearCyclesData {
    cycles?: LinearConnection<LinearCycleNode>;
}

const LINEAR_CYCLE_FIELDS = `
    id
    name
    number
    description
    team { id }
    startsAt
    endsAt
    completedAt
    progress
    createdAt
    updatedAt
`;

const LIST_CYCLES_QUERY = `
  query ListCycles($first: Int, $after: String, $updatedAfter: DateTimeOrDuration!) {
    cycles(first: $first, after: $after, filter: { updatedAt: { gte: $updatedAfter } }) {
      nodes {
${LINEAR_CYCLE_FIELDS}
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const CYCLES_PAGE_SIZE = 100;

export default createSync({
    description:
        'Fetches Linear cycles (per-team time-boxed iterations) for Sage. Emits LinearCycle records consumed by adapter-linear `emitCycles`.',
    version: '1.0.0',
    // ----------------------------------------------------------------------
    // Sync Strategy Gate (per skill `building-nango-functions-locally`):
    //
    // **Change source**: Linear's GraphQL `cycles` query exposes a
    //   `filter: { updatedAt: { gte: $updatedAfter } }` argument, so
    //   incremental-by-`updatedAt` is the correct path.
    // **Checkpoint schema**: `{ updatedAtCursor: ISO-8601 string, pageCursor }`
    //   — shared with the other linear-relay syncs via
    //   `LinearCheckpointSchema`. During pagination, `updatedAtCursor`
    //   stays fixed at the original window and only advances after all
    //   pages complete successfully; `pageCursor` resumes mid-window crashes.
    // **How it changes the request**: the checkpoint value is fed back
    //   into `$updatedAfter` on the next run; the API returns only rows
    //   modified at-or-after that timestamp.
    // **Resumption**: per-page — mid-run `saveCheckpoint()` stores the
    //   original updatedAt window plus GraphQL page cursor; the final
    //   checkpoint clears `pageCursor` (by omission) and advances the timestamp.
    // **Walks full dataset?**: No — changed rows only.
    // **Delete strategy**: changed-only checkpoints cannot use
    //   `trackDeletesStart()` / `trackDeletesEnd()` per the skill
    //   (the API omits unchanged rows, so end-of-window would
    //   falsely tombstone them). Linear's GraphQL `cycles` query also
    //   does not emit deletion tombstones in the changed set. Cycles
    //   are not commonly deleted (they archive into history), so
    //   for now stale cycles persist on disk; a follow-up should
    //   periodically reconcile via a full-team sweep keyed on team.
    // ----------------------------------------------------------------------
    frequency: 'every 12 hours',
    autoStart: true,
    syncType: 'incremental',
    endpoints: [{ method: 'GET', path: '/linear/cycles', group: 'Linear' }],
    metadata: z.object({}),
    checkpoint: LinearCheckpointSchema,
    models: { LinearCycle },

    exec: async (nango) => {
        // `ignore_if_modified_after`: matches the existing
        // fetch-projects.ts / fetch-active-issues.ts pattern. Keeps
        // locally-modified writeback results from being clobbered by a
        // stale sync read.
        await nango.setMergingStrategy({ strategy: 'ignore_if_modified_after' }, 'LinearCycle');

        const checkpoint = (await nango.getCheckpoint()) as LinearCheckpoint | null | undefined;
        const initialUpdatedAfter = checkpoint?.updatedAtCursor ?? INITIAL_UPDATED_AFTER;
        let cursor: string | null = checkpoint?.pageCursor ?? null;
        let hasNextPage = true;
        let latestUpdatedAt = initialUpdatedAfter;

        try {
            while (hasNextPage) {
                // Linear GraphQL endpoint (auth handled by Nango).
                // Reference: https://developers.linear.app/docs/graphql/working-with-the-graphql-api
                const response: { data: unknown } = await nango.post({
                    endpoint: '/graphql',
                    data: {
                        query: LIST_CYCLES_QUERY,
                        variables: {
                            first: CYCLES_PAGE_SIZE,
                            after: cursor,
                            updatedAfter: initialUpdatedAfter,
                        },
                    },
                    retries: 3,
                });

                const cycles: LinearConnection<LinearCycleNode> = requireLinearConnection(
                    response.data as LinearGraphqlResponse<LinearCyclesData> | undefined,
                    (data) => data.cycles,
                    'cycles',
                );

                const batch: LinearCycleRecord[] = [];
                for (const cycle of cycles.nodes ?? []) {
                    if (!cycle?.team?.id) {
                        // Defensive: every cycle in Linear is team-scoped;
                        // a missing team id means the API returned a
                        // malformed node. Skip rather than emit a
                        // record that would fail downstream path mapping.
                        await nango.log(
                            `fetch-cycles: skipping cycle id=${cycle?.id ?? 'unknown'} with no team — likely API anomaly`,
                            { level: 'warn' },
                        );
                        continue;
                    }
                    if (typeof cycle.number !== 'number' || !Number.isFinite(cycle.number)) {
                        // Defensive: Linear assigns every cycle a sequential
                        // `number`. A missing/invalid number means the API
                        // returned a malformed node; skip rather than emit
                        // a synthetic sentinel like `0`.
                        await nango.log(
                            `fetch-cycles: skipping cycle id=${cycle.id} with missing/invalid number — likely API anomaly`,
                            { level: 'warn' },
                        );
                        continue;
                    }
                    const record = toLinearCycleRecord(cycle);
                    batch.push(record);
                    if (record.updated_at > latestUpdatedAt) {
                        latestUpdatedAt = record.updated_at;
                    }
                }

                if (batch.length > 0) {
                    await nango.batchSave(batch, 'LinearCycle');
                }

                const nextCursor = cycles.pageInfo?.endCursor ?? null;
                const nextHasPage = Boolean(cycles.pageInfo?.hasNextPage && nextCursor);

                if (nextHasPage) {
                    await nango.saveCheckpoint({
                        updatedAtCursor: initialUpdatedAfter,
                        pageCursor: nextCursor,
                    } as any);
                }

                cursor = nextCursor;
                hasNextPage = nextHasPage;
            }

            await nango.saveCheckpoint({
                updatedAtCursor: latestUpdatedAt,
            });
        } catch (error) {
            await nango.log(`Failed to sync Linear cycles: ${formatError(error)}`, { level: 'error' });
            throw error;
        }
    },
});

function toLinearCycleRecord(cycle: LinearCycleNode): LinearCycleRecord {
    // Callers must filter out cycles with missing team.id / number before
    // invoking this — see the guards in the exec loop. The non-null
    // assertions reflect that invariant and avoid emitting synthetic
    // sentinel values that would mislead downstream consumers.
    return {
        id: cycle.id,
        name: cycle.name ?? '',
        number: cycle.number as number,
        description: cycle.description ?? null,
        team_id: cycle.team!.id as string,
        starts_at: toNullableIsoString(cycle.startsAt),
        ends_at: toNullableIsoString(cycle.endsAt),
        completed_at: toNullableIsoString(cycle.completedAt),
        progress: typeof cycle.progress === 'number' ? cycle.progress : null,
        created_at: toIsoString(cycle.createdAt),
        updated_at: toIsoString(cycle.updatedAt),
    };
}
