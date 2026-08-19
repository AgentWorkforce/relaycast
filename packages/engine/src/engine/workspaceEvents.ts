import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { workspaceEvents } from '../db/schema.js';
import type { EngineDb } from '../ports/database.js';

/** Default page size for {@link listWorkspaceEvents}. */
export const WORKSPACE_EVENT_LIST_DEFAULT_LIMIT = 200;
/** Max page size for {@link listWorkspaceEvents}. */
export const WORKSPACE_EVENT_LIST_MAX_LIMIT = 500;

export interface WorkspaceEventInput {
  type: string;
  channelId?: string | null;
  /** The exact `transformForClient(event)` frame published to the workspace stream (without `seq`). */
  payload: Record<string, unknown>;
}

export interface WorkspaceEventRecord {
  seq: number;
  type: string;
  channel_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

// Each VALUES row binds workspace_id, type, channel_id, and payload. Twenty-four
// rows use 96 bindings, below D1's 100-bound-parameter ceiling, while allowing
// one maintenance statement to append events for many workspaces.
const WORKSPACE_EVENT_APPEND_BATCH_SIZE = 24;

export interface ScopedWorkspaceEventInput {
  workspaceId: string;
  input: WorkspaceEventInput;
}

function nextSeqSql(workspaceId: string) {
  return sql<number>`(
    SELECT COALESCE(MAX(we.seq), 0) + 1
    FROM workspace_events we
    WHERE we.workspace_id = ${workspaceId}
  )`;
}

/**
 * Append one event to the durable workspace event log. `seq` is per-workspace
 * monotonic from 1, assigned inside the INSERT itself (same pattern as the
 * deliveries mailbox `nextSeqSql`).
 *
 * Best-effort by contract: on any failure this logs a warning and returns
 * `null` — callers still publish to the live stream and must never fail the
 * request because the log append did.
 *
 * @returns The assigned seq, or `null` when the append failed.
 */
export async function appendWorkspaceEvent(
  db: EngineDb,
  workspaceId: string,
  input: WorkspaceEventInput,
): Promise<number | null> {
  try {
    const [row] = await db
      .insert(workspaceEvents)
      .values({
        workspaceId,
        seq: nextSeqSql(workspaceId),
        type: input.type,
        channelId: input.channelId ?? null,
        payload: JSON.stringify(input.payload),
      })
      .returning({ seq: workspaceEvents.seq });
    return row?.seq ?? null;
  } catch (err) {
    console.warn('[workspace.events] append failed', {
      workspace_id: workspaceId,
      event_type: input.type,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Append several events with one monotonic sequence allocation per SQL batch.
 * The MAX(seq) read and all inserts live in the same statement, so concurrent
 * appenders cannot reserve the same sequence range. Results align with inputs;
 * a failed batch is represented by nulls and does not stop later batches.
 */
export async function appendWorkspaceEventBatch(
  db: EngineDb,
  inputs: readonly ScopedWorkspaceEventInput[],
): Promise<Array<number | null>> {
  const assigned: Array<number | null> = [];

  for (let offset = 0; offset < inputs.length; offset += WORKSPACE_EVENT_APPEND_BATCH_SIZE) {
    const batch = inputs.slice(offset, offset + WORKSPACE_EVENT_APPEND_BATCH_SIZE);
    const values = sql.join(batch.map((event, index) => sql`(
      ${sql.raw(String(index))},
      ${event.workspaceId},
      ${event.input.type},
      ${event.input.channelId ?? null},
      ${JSON.stringify(event.input.payload)}
    )`), sql`, `);

    try {
      const rows = await db.all<{ workspace_id: string; seq: number }>(sql`
        WITH
          input_events(global_ord, workspace_id, type, channel_id, payload) AS (VALUES ${values}),
          ranked AS (
            SELECT
              input_events.*,
              ROW_NUMBER() OVER (
                PARTITION BY input_events.workspace_id
                ORDER BY input_events.global_ord
              ) AS workspace_ord
            FROM input_events
          ),
          bases AS (
            SELECT
              workspaces.workspace_id,
              COALESCE(MAX(we.seq), 0) AS base_seq
            FROM (SELECT DISTINCT workspace_id FROM input_events) workspaces
            LEFT JOIN workspace_events we ON we.workspace_id = workspaces.workspace_id
            GROUP BY workspaces.workspace_id
          )
        INSERT INTO workspace_events (workspace_id, seq, type, channel_id, payload)
        SELECT
          ranked.workspace_id,
          bases.base_seq + ranked.workspace_ord,
          ranked.type,
          ranked.channel_id,
          ranked.payload
        FROM ranked
        INNER JOIN bases ON bases.workspace_id = ranked.workspace_id
        ORDER BY ranked.global_ord
        RETURNING workspace_id, seq
      `);
      if ((rows ?? []).length !== batch.length) {
        throw new Error(`expected ${batch.length} appended events, received ${(rows ?? []).length}`);
      }
      const seqsByWorkspace = new Map<string, number[]>();
      for (const row of rows ?? []) {
        const seqs = seqsByWorkspace.get(row.workspace_id) ?? [];
        seqs.push(row.seq);
        seqsByWorkspace.set(row.workspace_id, seqs);
      }
      for (const seqs of seqsByWorkspace.values()) seqs.sort((a, b) => a - b);
      assigned.push(...batch.map((event) => seqsByWorkspace.get(event.workspaceId)?.shift() ?? null));
    } catch (err) {
      console.warn('[workspace.events] batch append failed', {
        workspace_count: new Set(batch.map((event) => event.workspaceId)).size,
        event_count: batch.length,
        error: err instanceof Error ? err.message : String(err),
      });
      assigned.push(...batch.map(() => null));
    }
  }

  return assigned;
}

export async function appendWorkspaceEvents(
  db: EngineDb,
  workspaceId: string,
  inputs: readonly WorkspaceEventInput[],
): Promise<Array<number | null>> {
  return appendWorkspaceEventBatch(
    db,
    inputs.map((input) => ({ workspaceId, input })),
  );
}

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through — a corrupt row must not fail the whole page.
  }
  return {};
}

/**
 * List workspace events with `seq > since`, ordered by seq ascending.
 * `latestSeq` is `MAX(seq)` for the workspace (0 when the log is empty), so
 * clients can tell whether they are caught up.
 */
export async function listWorkspaceEvents(
  db: EngineDb,
  workspaceId: string,
  opts: { since?: number; limit?: number } = {},
): Promise<{ events: WorkspaceEventRecord[]; latestSeq: number }> {
  const since = Math.max(0, opts.since ?? 0);
  const limit = Math.min(
    Math.max(1, opts.limit ?? WORKSPACE_EVENT_LIST_DEFAULT_LIMIT),
    WORKSPACE_EVENT_LIST_MAX_LIMIT,
  );

  const [rows, [latest]] = await Promise.all([
    db
      .select()
      .from(workspaceEvents)
      .where(and(eq(workspaceEvents.workspaceId, workspaceId), gt(workspaceEvents.seq, since)))
      .orderBy(asc(workspaceEvents.seq))
      .limit(limit),
    db
      .select({ latestSeq: sql<number>`COALESCE(MAX(${workspaceEvents.seq}), 0)` })
      .from(workspaceEvents)
      .where(eq(workspaceEvents.workspaceId, workspaceId)),
  ]);

  return {
    events: rows.map((row) => ({
      seq: row.seq,
      type: row.type,
      channel_id: row.channelId,
      payload: parsePayload(row.payload),
      created_at: row.createdAt.toISOString(),
    })),
    latestSeq: latest?.latestSeq ?? 0,
  };
}

interface WorkspaceStreamPublisher {
  publishToWorkspaceStream(args: { workspaceId: string; event: Record<string, unknown> }): Promise<void>;
}

/**
 * Shared "append + stamp + publish" path used by every workspace stream call
 * site: append the frame to the durable log first, stamp the assigned seq onto
 * the published frame as a top-level `seq` field, then publish. Both steps are
 * best-effort — an append failure publishes the unstamped frame, and a publish
 * failure is reported via `onPublishError` rather than thrown.
 */
export async function appendAndPublishWorkspaceEvent(
  deps: { db: EngineDb; realtime: WorkspaceStreamPublisher },
  workspaceId: string,
  input: WorkspaceEventInput,
  onPublishError?: (err: unknown) => void,
): Promise<void> {
  const seq = await appendWorkspaceEvent(deps.db, workspaceId, input);
  const event = seq == null ? input.payload : { ...input.payload, seq };
  try {
    await deps.realtime.publishToWorkspaceStream({ workspaceId, event });
  } catch (err) {
    onPublishError?.(err);
  }
}

/** Batch form used by bounded maintenance jobs to stay under D1 query limits. */
export async function appendAndPublishWorkspaceEvents(
  deps: { db: EngineDb; realtime: WorkspaceStreamPublisher },
  workspaceId: string,
  inputs: readonly WorkspaceEventInput[],
  onPublishError?: (err: unknown) => void,
): Promise<void> {
  await appendAndPublishWorkspaceEventBatch(
    deps,
    inputs.map((input) => ({ workspaceId, input })),
    onPublishError,
  );
}

/** Batch form that can append and publish events across several workspaces. */
export async function appendAndPublishWorkspaceEventBatch(
  deps: { db: EngineDb; realtime: WorkspaceStreamPublisher },
  events: readonly ScopedWorkspaceEventInput[],
  onPublishError?: (err: unknown) => void,
): Promise<void> {
  const seqs = await appendWorkspaceEventBatch(deps.db, events);
  for (let index = 0; index < events.length; index++) {
    const { workspaceId, input } = events[index];
    const seq = seqs[index];
    const event = seq == null ? input.payload : { ...input.payload, seq };
    try {
      await deps.realtime.publishToWorkspaceStream({ workspaceId, event });
    } catch (err) {
      onPublishError?.(err);
    }
  }
}
