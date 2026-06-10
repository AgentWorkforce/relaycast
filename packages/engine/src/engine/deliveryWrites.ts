import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import type { SQLiteInsertSelectQueryBuilder } from 'drizzle-orm/sqlite-core';
import {
  agents,
  channelMembers,
  deliveries,
  dmParticipants,
} from '../db/schema.js';
import type { AtomicWrite, EngineDb } from '../ports/database.js';

type DeliveryMode = 'immediate' | 'next-tool-call';
type ChannelDeliveryReason = 'message' | 'mention' | 'thread-reply';
type DeliveryInsertSelect = SQLiteInsertSelectQueryBuilder<typeof deliveries>;

export interface DeliveryFanoutRecord {
  id: string;
  agentId: string;
  reason: string;
}

function deliveryId(messageId: string, agentId: unknown) {
  return sql<string>`'del_' || ${messageId} || '_' || ${agentId}`;
}

function channelReasonSql(
  mentionHandles: readonly string[],
  fallback: ChannelDeliveryReason,
) {
  if (fallback !== 'message' || mentionHandles.length === 0) {
    return sql<string>`${fallback}`;
  }

  const mentionList = sql.join(mentionHandles.map((handle) => sql`${handle}`), sql`, `);
  return sql<string>`case when ${agents.name} in (${mentionList}) then ${'mention'} else ${'message'} end`;
}

function asDeliveryInsertSelect(query: unknown): DeliveryInsertSelect {
  return query as DeliveryInsertSelect;
}

export function buildChannelDeliveryWrite(
  db: EngineDb,
  input: {
    workspaceId: string;
    messageId: string;
    channelId: string;
    senderAgentId: string;
    mode: DeliveryMode;
    reason?: ChannelDeliveryReason;
    mentionHandles?: readonly string[];
  },
): AtomicWrite {
  const reason = channelReasonSql(input.mentionHandles ?? [], input.reason ?? 'message');
  return db
    .insert(deliveries)
    .select((qb) =>
      asDeliveryInsertSelect(qb
        .select({
          id: deliveryId(input.messageId, channelMembers.agentId),
          workspaceId: sql<string>`${input.workspaceId}`,
          messageId: sql<string>`${input.messageId}`,
          agentId: channelMembers.agentId,
          mode: sql<string>`${input.mode}`,
          reason,
          priority: sql<string>`${'normal'}`,
          deadline: sql<null>`null`,
          status: sql<string>`${'accepted'}`,
          retryable: sql<null>`null`,
          availableAt: sql<null>`null`,
          error: sql<null>`null`,
          idempotencyKey: sql<null>`null`,
          createdAt: sql`(unixepoch())`,
          updatedAt: sql<null>`null`,
        })
        .from(channelMembers)
        .innerJoin(agents, eq(channelMembers.agentId, agents.id))
        .where(
          and(
            eq(channelMembers.channelId, input.channelId),
            ne(channelMembers.agentId, input.senderAgentId),
          ),
        )),
    )
    .onConflictDoNothing();
}

export function buildGroupDmDeliveryWrite(
  db: EngineDb,
  input: {
    workspaceId: string;
    messageId: string;
    conversationId: string;
    senderAgentId: string;
    mode: DeliveryMode;
  },
): AtomicWrite {
  return db
    .insert(deliveries)
    .select((qb) =>
      asDeliveryInsertSelect(qb
        .select({
          id: deliveryId(input.messageId, dmParticipants.agentId),
          workspaceId: sql<string>`${input.workspaceId}`,
          messageId: sql<string>`${input.messageId}`,
          agentId: dmParticipants.agentId,
          mode: sql<string>`${input.mode}`,
          reason: sql<string>`${'dm'}`,
          priority: sql<string>`${'normal'}`,
          deadline: sql<null>`null`,
          status: sql<string>`${'accepted'}`,
          retryable: sql<null>`null`,
          availableAt: sql<null>`null`,
          error: sql<null>`null`,
          idempotencyKey: sql<null>`null`,
          createdAt: sql`(unixepoch())`,
          updatedAt: sql<null>`null`,
        })
        .from(dmParticipants)
        .where(
          and(
            eq(dmParticipants.conversationId, input.conversationId),
            isNull(dmParticipants.leftAt),
            ne(dmParticipants.agentId, input.senderAgentId),
          ),
        )),
    )
    .onConflictDoNothing();
}

export async function fetchDeliveryFanoutRecords(
  db: EngineDb,
  messageId: string,
): Promise<DeliveryFanoutRecord[]> {
  const rows = await db
    .select({
      id: deliveries.id,
      agentId: deliveries.agentId,
      reason: deliveries.reason,
    })
    .from(deliveries)
    .where(eq(deliveries.messageId, messageId));

  return rows.map((row) => ({
    id: row.id,
    agentId: row.agentId,
    reason: row.reason ?? 'message',
  }));
}
