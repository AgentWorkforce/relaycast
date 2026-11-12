import { and, asc, eq, gt, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { workspaceEvents } from '../db/tables.js';
import type { EngineDb } from '../ports/database.js';
import * as sqlx from '../db/sqlx.js';
import { withSeqLock } from './seqLock.js';

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
 * The sequence lock that serializes `nextSeqSql` for one workspace on
 * PostgreSQL (a no-op on SQLite, whose writers are already serialized).
 */
function workspaceSeqLock(workspaceId: string): sqlx.SeqLockTarget {
  return { kind: 'workspace_event', workspaceId };
}

/**
 * Build a strict append for callers that atomically admit the event with a mutation.
 * On PostgreSQL wrap it in `seqLockedWrite(db, { kind: 'workspace_event', workspaceId }, ...)`
 * so the per-workspace sequence lock is taken in the same transaction.
 */
export function buildWorkspaceEventWrite(db: EngineDb, workspaceId: string, input: WorkspaceEventInput) {
  return db.insert(workspaceEvents).values({
    workspaceId, seq: nextSeqSql(workspaceId), type: input.type,
    channelId: input.channelId ?? null, payload: JSON.stringify(input.payload),
  }).returning({ seq: workspaceEvents.seq });
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
  if (coalesces(db)) return (await coalescedAppend(db, [{ workspaceId, input }]))[0];
  try {
    const [row] = await withSeqLock(db, workspaceSeqLock(workspaceId), (tx) => buildWorkspaceEventWrite(tx, workspaceId, input));
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
 * The high-water lookup and all inserts live in the same statement, so concurrent
 * appenders cannot reserve the same sequence range. Results align with inputs;
 * a failed batch is represented by nulls and does not stop later batches.
 */
export async function appendWorkspaceEventBatch(
  db: EngineDb,
  inputs: readonly ScopedWorkspaceEventInput[],
): Promise<Array<number | null>> {
  if (coalesces(db)) return coalescedAppend(db, inputs);
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
      // A grouped MAX over a join walks all retained events. Seek the end of
      // the existing (workspace_id, seq) key once per distinct workspace instead.
      // Materialize before inserting so every event uses the same base even if
      // SQLite would otherwise inline the CTE and observe this batch's inserts.
      const locks = [...new Set(batch.map((event) => event.workspaceId))].sort().map(workspaceSeqLock);
      const rows = await withSeqLock(db, locks, (tx) => sqlx.all<{ workspace_id: string; seq: number }>(tx, sql`
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
          bases AS MATERIALIZED (
            SELECT
              workspaces.workspace_id,
              COALESCE((
                SELECT we.seq
                FROM workspace_events we
                WHERE we.workspace_id = workspaces.workspace_id
                ORDER BY we.seq DESC
                LIMIT 1
              ), 0) AS base_seq
            FROM (SELECT DISTINCT workspace_id FROM input_events) workspaces
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
      `));
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

// --- PostgreSQL append coalescing ---------------------------------------------
//
// Every append holds the workspace's sequence lock through its commit, so one
// workspace's log takes about one commit per append (relaycast#658). On a
// PostgreSQL pool handle, appends to the same workspace are group-committed
// instead: while one flush transaction runs, later appends queue, and the next
// flush writes all of them in one transaction under the same lock. Seq stays
// commit-ordered and gapless (each flush allocates MAX + 1.. under the lock),
// queue order is seq order, and each caller still receives its own seq.
// Transaction handles and SQLite/D1 keep the direct path.

/** Rows per INSERT inside a flush (4 bound parameters each, far below PostgreSQL's limit). */
const COALESCED_STATEMENT_ROWS = 200;
/** Events per flush transaction; the rest wait for the next flush. */
const COALESCED_FLUSH_MAX = 1000;

interface PendingAppend {
  input: WorkspaceEventInput;
  resolve: (seq: number | null) => void;
}

interface WorkspaceAppendQueue {
  pending: PendingAppend[];
  flushing: boolean;
}

const appendQueues = new WeakMap<object, Map<string, WorkspaceAppendQueue>>();

/** True for a PostgreSQL pool handle (not a transaction): appends there are coalesced. */
function coalesces(db: EngineDb): boolean {
  try {
    return !sqlx.isNoopLock(db) && !sqlx.inPgTransaction(db);
  } catch {
    // A handle without a known dialect takes the direct, best-effort path.
    return false;
  }
}

/** Enqueue each event on its workspace's queue; resolves to seqs aligned with `inputs`. */
function coalescedAppend(db: EngineDb, inputs: readonly ScopedWorkspaceEventInput[]): Promise<Array<number | null>> {
  let queues = appendQueues.get(db);
  if (!queues) appendQueues.set(db, queues = new Map());
  const byQueue = queues;
  return Promise.all(inputs.map(({ workspaceId, input }) => new Promise<number | null>((resolve) => {
    let queue = byQueue.get(workspaceId);
    if (!queue) byQueue.set(workspaceId, queue = { pending: [], flushing: false });
    queue.pending.push({ input, resolve });
    if (!queue.flushing) void drainAppendQueue(db, byQueue, workspaceId, queue);
  })));
}

async function drainAppendQueue(
  db: EngineDb,
  queues: Map<string, WorkspaceAppendQueue>,
  workspaceId: string,
  queue: WorkspaceAppendQueue,
): Promise<void> {
  queue.flushing = true;
  try {
    // Let appends issued in the same tick join the first flush.
    await Promise.resolve();
    while (queue.pending.length > 0) {
      const batch = queue.pending.splice(0, COALESCED_FLUSH_MAX);
      const seqs = await flushAppends(db, workspaceId, batch.map((item) => item.input));
      batch.forEach((item, index) => item.resolve(seqs[index]));
    }
  } finally {
    queue.flushing = false;
    if (queue.pending.length === 0) queues.delete(workspaceId);
    else void drainAppendQueue(db, queues, workspaceId, queue);
  }
}

/** Append `inputs` in order in one transaction; per-event fallback if that fails. Never throws. */
async function flushAppends(db: EngineDb, workspaceId: string, inputs: readonly WorkspaceEventInput[]): Promise<Array<number | null>> {
  try {
    return await withSeqLock(db, workspaceSeqLock(workspaceId), async (tx) => {
      const seqs: number[] = [];
      for (let offset = 0; offset < inputs.length; offset += COALESCED_STATEMENT_ROWS) {
        const chunk = inputs.slice(offset, offset + COALESCED_STATEMENT_ROWS);
        const values = sql.join(chunk.map((input, index) => sql`(
          ${sql.raw(String(index + 1))}, ${input.type}, ${input.channelId ?? null}, ${JSON.stringify(input.payload)}
        )`), sql`, `);
        const rows = await sqlx.all<{ seq: number }>(tx, sql`
          WITH
            input_events(ord, type, channel_id, payload) AS (VALUES ${values}),
            base AS MATERIALIZED (
              SELECT COALESCE((
                SELECT we.seq FROM workspace_events we
                WHERE we.workspace_id = ${workspaceId}
                ORDER BY we.seq DESC
                LIMIT 1
              ), 0) AS seq
            )
          INSERT INTO workspace_events (workspace_id, seq, type, channel_id, payload)
          SELECT ${workspaceId}, base.seq + input_events.ord::int, input_events.type, input_events.channel_id, input_events.payload
          FROM input_events CROSS JOIN base
          ORDER BY input_events.ord
          RETURNING seq
        `);
        if (rows.length !== chunk.length) {
          throw new Error(`expected ${chunk.length} appended events, received ${rows.length}`);
        }
        seqs.push(...rows.map((row) => Number(row.seq)).sort((a, b) => a - b));
      }
      return seqs;
    });
  } catch (err) {
    if (inputs.length === 1) {
      console.warn('[workspace.events] append failed', {
        workspace_id: workspaceId,
        event_type: inputs[0].type,
        error: err instanceof Error ? err.message : String(err),
      });
      return [null];
    }
    // One bad event must not drop the events coalesced with it.
    const seqs: Array<number | null> = [];
    for (const input of inputs) seqs.push(...await flushAppends(db, workspaceId, [input]));
    return seqs;
  }
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

/**
 * Append and publish only when a database predicate is still true at the
 * insertion point. The predicate and INSERT are one statement, so a competing
 * state transition either follows the appended event or wins and suppresses
 * it; there is no check-then-publish window.
 */
export async function appendAndPublishWorkspaceEventWhen(
  deps: { db: EngineDb; realtime: WorkspaceStreamPublisher },
  workspaceId: string,
  input: WorkspaceEventInput,
  predicate: SQL,
  onPublishError?: (err: unknown) => void,
): Promise<boolean> {
  let seq: number;
  try {
    const rows = await withSeqLock(deps.db, workspaceSeqLock(workspaceId), (tx) => sqlx.all<{ seq: number }>(tx, sql`
      INSERT INTO workspace_events (workspace_id, seq, type, channel_id, payload)
      SELECT
        ${workspaceId},
        ${nextSeqSql(workspaceId)},
        ${input.type},
        ${input.channelId ?? null},
        ${JSON.stringify(input.payload)}
      WHERE ${predicate}
      RETURNING seq
    `));
    const row = rows?.[0];
    if (!row) return false;
    seq = row.seq;
  } catch (err) {
    console.warn('[workspace.events] guarded append failed', {
      workspace_id: workspaceId,
      event_type: input.type,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }

  try {
    await deps.realtime.publishToWorkspaceStream({
      workspaceId,
      event: { ...input.payload, seq },
    });
  } catch (err) {
    onPublishError?.(err);
  }
  return true;
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
