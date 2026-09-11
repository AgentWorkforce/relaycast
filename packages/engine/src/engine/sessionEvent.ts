import { eq, and, ne, desc, isNull, sql } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { agents, sessionEvents } from '../db/schema.js';
import { generateId } from './snowflake.js';
import { sha256Hex } from '../lib/crypto.js';
import { codedError } from '../lib/httpError.js';
import { runAtomicWrites } from '../ports/database.js';
import { RELEASED_AGENT_STATUS } from './agent.js';

type Db = ReturnType<typeof getDb>;

export type SessionEventType =
  | 'status.changed'
  | 'status.idle'
  | 'status.active'
  | 'status.blocked'
  | 'status.waiting'
  | 'status.offline'
  | 'tool.called'
  | 'tool.completed'
  | 'tool.failed'
  | 'tool.output'
  | 'message.received'
  | 'message.sent'
  | 'delivery.accepted'
  | 'delivery.delivered'
  | 'delivery.deferred'
  | 'delivery.failed'
  | 'action.invoked'
  | 'action.completed'
  | 'action.failed'
  | 'action.denied'
  | 'transcript.chunk'
  | 'file.changed'
  | 'command.started'
  | 'command.completed'
  | 'command.failed'
  | 'terminal.output'
  | 'terminal.screen'
  | 'usage.updated'
  | 'session.started'
  | 'session.released'
  | 'session.resumed'
  | 'session.forked'
  | 'log'
  | 'error';

const VALID_EVENT_TYPES = new Set<string>([
  'status.changed', 'status.idle', 'status.active', 'status.blocked',
  'status.waiting', 'status.offline',
  'tool.called', 'tool.completed', 'tool.failed', 'tool.output',
  'message.received', 'message.sent',
  'delivery.accepted', 'delivery.delivered', 'delivery.deferred', 'delivery.failed',
  'action.invoked', 'action.completed', 'action.failed', 'action.denied',
  'transcript.chunk',
  'file.changed',
  'command.started', 'command.completed', 'command.failed',
  'terminal.output', 'terminal.screen',
  'usage.updated',
  'session.started', 'session.released', 'session.resumed', 'session.forked',
  'log', 'error',
]);

export function isValidEventType(type: string): type is SessionEventType {
  return VALID_EVENT_TYPES.has(type);
}

/** `status.*` events are the only ones with a side-effecting agent-row mutation to track. */
export function isStatusEventType(type: string): boolean {
  return type.startsWith('status.');
}

export async function recordSessionEvent(
  db: Db,
  workspaceId: string,
  agentId: string,
  data: {
    type: SessionEventType;
    payload: Record<string, unknown>;
  },
): Promise<{ event: ReturnType<typeof toPublicEvent>; replayed: boolean; pendingStatusApplication: boolean }> {
  const id = `evt_${generateId()}`;

  // Sequence is assigned atomically via a scalar subquery — read and write in
  // one statement so concurrent inserts cannot race to the same value.
  const [event] = await db
    .insert(sessionEvents)
    .values({
      id,
      workspaceId,
      agentId,
      type: data.type,
      payload: data.payload,
      sequence: sql<number>`(SELECT COALESCE(MAX(sequence), 0) + 1 FROM session_events WHERE agent_id = ${agentId})`,
    })
    .returning();

  return {
    event: toPublicEvent(event, agentId),
    replayed: false,
    // Unkeyed events have no durable claim to replay against — the caller
    // always applies the status mutation immediately after this call, so
    // there is nothing to recover across a retry.
    pendingStatusApplication: isStatusEventType(data.type),
  };
}

/**
 * Record an event with a durable caller-provided identity.
 *
 * The key is hashed before persistence and scoped by workspace + agent in the
 * unique index. The request digest is retained beside the event so reusing a
 * key with a different event cannot accidentally replay the first event.
 */
export async function recordSessionEventWithIdempotency(
  db: Db,
  workspaceId: string,
  agentId: string,
  data: {
    type: SessionEventType;
    payload: Record<string, unknown>;
  },
  idempotencyKey: string,
): Promise<{ event: ReturnType<typeof toPublicEvent>; replayed: boolean; pendingStatusApplication: boolean }> {
  const [idempotencyKeyHash, requestDigest] = await Promise.all([
    sha256Hex(`session-event-key-v1\0${idempotencyKey}`),
    sha256Hex(`session-event-payload-v1\0${canonicalJson({ type: data.type, payload: data.payload })}`),
  ]);
  const id = `evt_${generateId()}`;

  // The insert and the unique identity claim are one durable operation. A
  // conflict is followed by a scoped lookup so concurrent retries return the
  // winner's exact event rather than allocating a second sequence number.
  const [created] = await db
    .insert(sessionEvents)
    .values({
      id,
      workspaceId,
      agentId,
      type: data.type,
      payload: data.payload,
      idempotencyKeyHash,
      requestDigest,
      sequence: sql<number>`(SELECT COALESCE(MAX(sequence), 0) + 1 FROM session_events WHERE agent_id = ${agentId})`,
    })
    .onConflictDoNothing()
    .returning();

  if (created) {
    return {
      event: toPublicEvent(created, agentId),
      replayed: false,
      pendingStatusApplication: isStatusEventType(data.type),
    };
  }

  const [existing] = await db
    .select()
    .from(sessionEvents)
    .where(and(
      eq(sessionEvents.workspaceId, workspaceId),
      eq(sessionEvents.agentId, agentId),
      eq(sessionEvents.idempotencyKeyHash, idempotencyKeyHash),
    ));
  if (!existing) {
    throw codedError(
      'The event idempotency claim could not be read after a storage conflict; retry with the same Idempotency-Key',
      'idempotency_unavailable',
      503,
    );
  }
  if (existing.requestDigest !== requestDigest) {
    throw codedError(
      'Idempotency-Key was reused with a different request payload',
      'idempotency_key_reused',
      409,
    );
  }
  return {
    event: toPublicEvent(existing, agentId),
    replayed: true,
    // `status_applied_at` is set atomically with the agent-row status write
    // (see `applyStatusEventEffect`). NULL here means either the mutation
    // never ran, or it ran but the process crashed before marking it durable
    // — both cases are indistinguishable from "not yet applied" and safe to
    // retry, because the write that sets this column is the same atomic unit
    // as the status mutation itself. A replay that is still pending finishes
    // the interrupted work instead of returning 201 with a stale agent row.
    pendingStatusApplication: isStatusEventType(existing.type) && existing.statusAppliedAt == null,
  };
}

/**
 * Apply a `status.*` event's agent-row mutation and claim its completion
 * durably, as one atomic unit.
 *
 * This is the fix for the crash window between "the event/idempotency claim
 * committed" and "the agent's status row is updated": if either statement
 * here failed independently, a retry could see `replayed: true` and return
 * 201 while the agent row stayed stale forever. Batching both writes through
 * `runAtomicWrites` means a failure here rolls back *both* the status change
 * and the completion marker, so `pendingStatusApplication` stays true and the
 * next replay retries the whole mutation — it can never observe "claimed but
 * never applied" as a terminal state.
 *
 * The conditional completion update is also the single-winner claim for
 * side effects: a replay that loses a concurrent claim gets `false` and must
 * not fan out or enqueue another webhook. A released agent's row is
 * intentionally not updated (matching
 * `updateAgentById`), but the event is still marked applied: there is no
 * agent row left to reconcile, and retrying forever would just repeat the
 * same no-op.
 */
export async function applyStatusEventEffect(
  db: Db,
  workspaceId: string,
  agentId: string,
  eventId: string,
  status: string,
): Promise<boolean> {
  const [claimResult] = await runAtomicWrites(db, (tx) => [
    tx.update(sessionEvents)
      .set({ statusAppliedAt: sql`(unixepoch())` })
      .where(and(
        eq(sessionEvents.id, eventId),
        eq(sessionEvents.workspaceId, workspaceId),
        eq(sessionEvents.agentId, agentId),
        isNull(sessionEvents.statusAppliedAt),
      ))
      .returning({ id: sessionEvents.id }),
    tx.update(agents)
      .set({ status })
      .where(and(
        eq(agents.workspaceId, workspaceId),
        eq(agents.id, agentId),
        ne(agents.status, RELEASED_AGENT_STATUS),
      )),
  ], { requireAtomic: true });

  // The conditional completion update is the single-winner claim. Under both
  // Node transactions and D1 batches, only the caller that changed NULL to a
  // timestamp may emit external side effects. The agent update remains in the
  // same atomic unit, so a failed mutation rolls the claim back for recovery.
  return Array.isArray(claimResult) && claimResult.length > 0;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function toPublicEvent(event: typeof sessionEvents.$inferSelect, agentId: string) {
  return {
    id: event.id,
    agent_id: agentId,
    type: event.type,
    payload: event.payload,
    sequence: event.sequence,
    created_at: event.createdAt.toISOString(),
  };
}

export async function listSessionEvents(
  db: Db,
  workspaceId: string,
  agentId: string,
  options?: {
    type?: string;
    limit?: number;
  },
) {
  const requested = options?.limit;
  const limit = Math.min(Math.max(Number.isFinite(requested) ? (requested as number) : 100, 1), 500);

  const query = db
    .select()
    .from(sessionEvents)
    .where(and(
      eq(sessionEvents.workspaceId, workspaceId),
      eq(sessionEvents.agentId, agentId),
      ...(options?.type ? [eq(sessionEvents.type, options.type)] : []),
    ))
    .orderBy(desc(sessionEvents.createdAt))
    .limit(limit);

  const rows = await query;

  return rows.map((r) => ({
    id: r.id,
    agent_id: r.agentId,
    type: r.type,
    payload: r.payload,
    sequence: r.sequence,
    created_at: r.createdAt.toISOString(),
  }));
}

export function resolveStatusFromEvent(
  eventType: SessionEventType,
): string | null {
  switch (eventType) {
    case 'status.active': return 'active';
    case 'status.idle': return 'idle';
    case 'status.blocked': return 'blocked';
    case 'status.waiting': return 'waiting';
    case 'status.offline': return 'offline';
    case 'status.changed': return null; // payload carries the status
    default: return null;
  }
}
