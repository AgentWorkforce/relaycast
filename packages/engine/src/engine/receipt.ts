import { eq, and, sql } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import {
  readReceipts,
  messages,
  agents,
  channelMembers,
  channels,
  deliveries,
} from '../db/schema.js';

type Db = ReturnType<typeof getDb>;

export async function markRead(
  db: Db,
  workspaceId: string,
  messageId: string,
  agentId: string,
) {
  // Verify message exists and belongs to workspace
  const [msg] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.workspaceId, workspaceId)));
  if (!msg) return null;

  // Upsert read receipt (idempotent)
  await db
    .insert(readReceipts)
    .values({ messageId, agentId })
    .onConflictDoNothing();

  // Transition delivery status: accepted → delivered
  await db
    .update(deliveries)
    .set({ status: 'delivered', updatedAt: new Date() })
    .where(
      and(
        eq(deliveries.messageId, messageId),
        eq(deliveries.agentId, agentId),
        eq(deliveries.status, 'accepted'),
      ),
    );

  // Update lastReadId for the channel membership (only move forward)
  await db
    .update(channelMembers)
    .set({ lastReadId: messageId })
    .where(
      and(
        eq(channelMembers.channelId, msg.channelId),
        eq(channelMembers.agentId, agentId),
        sql`(${channelMembers.lastReadId} IS NULL OR CAST(${channelMembers.lastReadId} AS BIGINT) < CAST(${messageId} AS BIGINT))`,
      ),
    );

  const [receipt] = await db
    .select()
    .from(readReceipts)
    .where(
      and(
        eq(readReceipts.messageId, messageId),
        eq(readReceipts.agentId, agentId),
      ),
    );

  return {
    message_id: receipt.messageId,
    agent_id: receipt.agentId,
    read_at: receipt.readAt.toISOString(),
  };
}

export async function getReaders(db: Db, workspaceId: string, messageId: string) {
  const [msg] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.workspaceId, workspaceId)));
  if (!msg) return null;

  const rows = await db
    .select({ agentId: agents.id, agentName: agents.name, readAt: readReceipts.readAt })
    .from(readReceipts)
    .innerJoin(agents, eq(readReceipts.agentId, agents.id))
    .where(eq(readReceipts.messageId, messageId));

  return rows.map((r) => ({
    agent_id: r.agentId,
    agent_name: r.agentName,
    read_at: r.readAt.toISOString(),
  }));
}

export async function getReadStatus(db: Db, workspaceId: string, channelName: string) {
  const [channel] = await db
    .select()
    .from(channels)
    .where(
      and(eq(channels.workspaceId, workspaceId), eq(channels.name, channelName)),
    );
  if (!channel) return null;

  const rows = await db
    .select({
      agentName: agents.name,
      lastReadId: channelMembers.lastReadId,
      lastReadAt: readReceipts.readAt,
    })
    .from(channelMembers)
    .innerJoin(agents, eq(channelMembers.agentId, agents.id))
    .leftJoin(
      readReceipts,
      and(
        eq(readReceipts.messageId, channelMembers.lastReadId),
        eq(readReceipts.agentId, channelMembers.agentId),
      ),
    )
    .where(eq(channelMembers.channelId, channel.id));

  return rows.map((r) => ({
    agent_name: r.agentName,
    last_read_id: r.lastReadId,
    last_read_at: r.lastReadAt ? r.lastReadAt.toISOString() : null,
  }));
}
