import { eq, and, sql, gte } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import {
  agents,
  channels,
  messages,
  dmConversations,
  files,
} from '../db/schema.js';

type Db = ReturnType<typeof getDb>;

export async function getWorkspaceStats(db: Db, workspaceId: string) {
  // Agents: total, online, offline
  const agentRows = await db
    .select({ status: agents.status })
    .from(agents)
    .where(eq(agents.workspaceId, workspaceId));

  const agentTotal = agentRows.length;
  const agentOnline = agentRows.filter((a) => a.status === 'online').length;
  const agentOffline = agentTotal - agentOnline;

  // Channels: total, archived
  const channelRows = await db
    .select({ isArchived: channels.isArchived })
    .from(channels)
    .where(
      and(
        eq(channels.workspaceId, workspaceId),
        eq(channels.channelType, 0),
      ),
    );

  const channelTotal = channelRows.length;
  const channelArchived = channelRows.filter((c) => c.isArchived).length;

  // Messages: total + today
  const [msgTotalRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(messages)
    .where(eq(messages.workspaceId, workspaceId));

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [msgTodayRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(messages)
    .where(
      and(
        eq(messages.workspaceId, workspaceId),
        gte(messages.createdAt, todayStart),
      ),
    );

  // DM conversations
  const [dmRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(dmConversations)
    .where(eq(dmConversations.workspaceId, workspaceId));

  // Files: total + storage bytes
  const [fileRow] = await db
    .select({
      count: sql<number>`count(*)`,
      bytes: sql<number>`coalesce(sum(size_bytes), 0)`,
    })
    .from(files)
    .where(eq(files.workspaceId, workspaceId));

  return {
    agents: { total: agentTotal, online: agentOnline, offline: agentOffline },
    channels: { total: channelTotal, archived: channelArchived },
    messages: {
      total: msgTotalRow?.count ?? 0,
      today: msgTodayRow?.count ?? 0,
    },
    dms: { total_conversations: dmRow?.count ?? 0 },
    files: {
      total: fileRow?.count ?? 0,
      storage_bytes: Number(fileRow?.bytes ?? 0),
    },
  };
}
