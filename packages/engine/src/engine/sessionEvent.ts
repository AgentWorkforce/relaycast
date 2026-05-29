import { eq, and, desc, sql } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { sessionEvents } from '../db/schema.js';
import { generateId } from './snowflake.js';

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

export async function recordSessionEvent(
  db: Db,
  workspaceId: string,
  agentId: string,
  data: {
    type: SessionEventType;
    payload: Record<string, unknown>;
  },
) {
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
