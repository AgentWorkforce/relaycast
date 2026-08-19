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

// Each VALUES row binds type, channel_id, and payload. Thirty rows plus the
// workspace id stay below D1's 100-bound-parameter ceiling (91 total), while
// turning a large maintenance fanout into a small, predictable query count.
const WORKSPACE_EVENT_APPEND_BATCH_SIZE = 30;

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
export async function appendWorkspaceEvents(
  db: EngineDb,
  workspaceId: string,
  inputs: readonly WorkspaceEventInput[],
): Promise<Array<number | null>> {
  const assigned: Array<number | null> = [];

  for (let offset = 0; offset < inputs.length; offset += WORKSPACE_EVENT_APPEND_BATCH_SIZE) {
    const batch = inputs.slice(offset, offset + WORKSPACE_EVENT_APPEND_BATCH_SIZE);
    const values = sql.join(batch.map((input, index) => sql`(
      ${sql.raw(String(index))},
      ${input.type},
      ${input.channelId ?? null},
      ${JSON.stringify(input.payload)}
    )`), sql`, `);

    try {
      const rows = await db.all<{ seq: number }>(sql`
        WITH
          config(workspace_id) AS (VALUES (${workspaceId})),
          input_events(ord, type, channel_id, payload) AS (VALUES ${values}),
          base(seq) AS (
            SELECT COALESCE(MAX(we.seq), 0)
            FROM workspace_events we, config
            WHERE we.workspace_id = config.workspace_id
          )
        INSERT INTO workspace_events (workspace_id, seq, type, channel_id, payload)
        SELECT
          config.workspace_id,
          base.seq + input_events.ord + 1,
          input_events.type,
          input_events.channel_id,
          input_events.payload
        FROM input_events, base, config
        ORDER BY input_events.ord
        RETURNING seq
      `);
      const seqs = [...(rows ?? [])].map((row) => row.seq).sort((a, b) => a - b);
      if (seqs.length !== batch.length) {
        throw new Error(`expected ${batch.length} appended events, received ${seqs.length}`);
      }
      assigned.push(...seqs);
    } catch (err) {
      console.warn('[workspace.events] batch append failed', {
        workspace_id: workspaceId,
        event_count: batch.length,
        error: err instanceof Error ? err.message : String(err),
      });
      assigned.push(...batch.map(() => null));
    }
  }

  return assigned;
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
  const seqs = await appendWorkspaceEvents(deps.db, workspaceId, inputs);
  for (let index = 0; index < inputs.length; index++) {
    const input = inputs[index];
    const seq = seqs[index];
    const event = seq == null ? input.payload : { ...input.payload, seq };
    try {
      await deps.realtime.publishToWorkspaceStream({ workspaceId, event });
    } catch (err) {
      onPublishError?.(err);
    }
  }
}
