import { eq, and, sql } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { reactions, messages, agents, channels } from '../db/schema.js';
import { generateId } from './snowflake.js';

type Db = ReturnType<typeof getDb>;

export async function addReaction(
  db: Db,
  workspaceId: string,
  messageId: string,
  agentId: string,
  emoji: string,
) {
  // Verify message exists and belongs to workspace
  const [msg] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.workspaceId, workspaceId)));
  if (!msg) return null;

  // Look up agent name and channel name
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  const [ch] = await db.select({ name: channels.name }).from(channels).where(eq(channels.id, msg.channelId));

  try {
    const id = generateId();
    const [reaction] = await db
      .insert(reactions)
      .values({ id, messageId, agentId, emoji })
      .returning();

    return {
      id: reaction.id,
      message_id: reaction.messageId,
      channel_id: msg.channelId,
      channel_name: ch?.name,
      agent_name: agent?.name ?? 'unknown',
      emoji: reaction.emoji,
      created_at: reaction.createdAt.toISOString(),
    };
  } catch (err: unknown) {
    const pgErr = err as Error & { code?: string };
    // Unique constraint violation — idempotent: return existing
    if (pgErr.code === '23505') {
      const [existing] = await db
        .select()
        .from(reactions)
        .where(
          and(
            eq(reactions.messageId, messageId),
            eq(reactions.agentId, agentId),
            eq(reactions.emoji, emoji),
          ),
        );
      return {
        id: existing.id,
        message_id: existing.messageId,
        channel_id: msg.channelId,
        channel_name: ch?.name,
        agent_name: agent?.name ?? 'unknown',
        emoji: existing.emoji,
        created_at: existing.createdAt.toISOString(),
      };
    }
    throw err;
  }
}

export async function removeReaction(
  db: Db,
  workspaceId: string,
  messageId: string,
  agentId: string,
  emoji: string,
) {
  const [msg] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.workspaceId, workspaceId)));
  if (!msg) return null;

  await db
    .delete(reactions)
    .where(
      and(
        eq(reactions.messageId, messageId),
        eq(reactions.agentId, agentId),
        eq(reactions.emoji, emoji),
      ),
    );
  return true;
}

export async function getReactions(db: Db, workspaceId: string, messageId: string) {
  const [msg] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.workspaceId, workspaceId)));
  if (!msg) return null;

  const rows = await db
    .select({ emoji: reactions.emoji, agentName: agents.name })
    .from(reactions)
    .innerJoin(agents, eq(reactions.agentId, agents.id))
    .where(eq(reactions.messageId, messageId));

  // Aggregate by emoji
  const grouped: Record<string, string[]> = {};
  for (const row of rows) {
    if (!grouped[row.emoji]) grouped[row.emoji] = [];
    grouped[row.emoji].push(row.agentName);
  }

  return Object.entries(grouped).map(([emoji, agentNames]) => ({
    emoji,
    count: agentNames.length,
    agents: agentNames,
  }));
}
