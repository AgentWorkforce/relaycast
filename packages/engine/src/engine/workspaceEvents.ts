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
