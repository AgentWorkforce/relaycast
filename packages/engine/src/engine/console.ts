import { and, desc, eq, lt, gte, sql } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { agents, channels, messageLogs } from '../db/schema.js';
import { generateId } from './snowflake.js';

type Db = ReturnType<typeof getDb>;

export interface LogMessageInput {
  workspaceId: string;
  messageId: string;
  channelId: string;
  agentId: string;
  conversationId?: string | null;
  deliveryKind: 'channel' | 'dm';
  body: string;
  contentType?: string | null;
  metadata?: Record<string, unknown> | null;
  attachmentCount?: number;
  mentionCount?: number;
  latencyMs?: number;
}

export interface ListMessageLogsOptions {
  limit?: number;
  before?: string;
  agentId?: string;
  channelId?: string;
  conversationId?: string;
  deliveryKind?: 'channel' | 'dm';
}

function clampLimit(limit?: number): number {
  return Math.min(Math.max(limit ?? 50, 1), 100);
}

function getWindowStart(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

export async function logMessage(db: Db, input: LogMessageInput): Promise<void> {
  await db
    .insert(messageLogs)
    .values({
      id: generateId(),
      workspaceId: input.workspaceId,
      messageId: input.messageId,
      channelId: input.channelId,
      agentId: input.agentId,
      conversationId: input.conversationId ?? null,
      deliveryKind: input.deliveryKind,
      body: input.body,
      contentType: input.contentType ?? null,
      metadata: input.metadata ?? {},
      attachmentCount: input.attachmentCount ?? 0,
      mentionCount: input.mentionCount ?? 0,
      latencyMs: input.latencyMs ?? 0,
    })
    .onConflictDoNothing();
}

export async function listMessageLogs(
  db: Db,
  workspaceId: string,
  opts: ListMessageLogsOptions = {},
) {
  const conditions = [eq(messageLogs.workspaceId, workspaceId)];
  if (opts.before) conditions.push(lt(messageLogs.id, opts.before));
  if (opts.agentId) conditions.push(eq(messageLogs.agentId, opts.agentId));
  if (opts.channelId) conditions.push(eq(messageLogs.channelId, opts.channelId));
  if (opts.conversationId) conditions.push(eq(messageLogs.conversationId, opts.conversationId));
  if (opts.deliveryKind) conditions.push(eq(messageLogs.deliveryKind, opts.deliveryKind));

  const rows = await db
    .select({
      id: messageLogs.id,
      messageId: messageLogs.messageId,
      channelId: messageLogs.channelId,
      channelName: channels.name,
      agentId: messageLogs.agentId,
      agentName: agents.name,
      conversationId: messageLogs.conversationId,
      deliveryKind: messageLogs.deliveryKind,
      body: messageLogs.body,
      contentType: messageLogs.contentType,
      metadata: messageLogs.metadata,
      attachmentCount: messageLogs.attachmentCount,
      mentionCount: messageLogs.mentionCount,
      latencyMs: messageLogs.latencyMs,
      createdAt: messageLogs.createdAt,
    })
    .from(messageLogs)
    .leftJoin(agents, eq(messageLogs.agentId, agents.id))
    .leftJoin(channels, eq(messageLogs.channelId, channels.id))
    .where(and(...conditions))
    .orderBy(desc(messageLogs.id))
    .limit(clampLimit(opts.limit));

  return rows.map((row) => ({
    id: row.id,
    message_id: row.messageId,
    channel_id: row.channelId,
    channel_name: row.channelName,
    agent_id: row.agentId,
    agent_name: row.agentName,
    conversation_id: row.conversationId,
    delivery_kind: row.deliveryKind,
    text: row.body,
    content_type: row.contentType,
    metadata: row.metadata ?? {},
    attachment_count: row.attachmentCount,
    mention_count: row.mentionCount,
    latency_ms: row.latencyMs,
    created_at: row.createdAt.toISOString(),
  }));
}

export async function getConsoleOverview(
  db: Db,
  workspaceId: string,
  windowDays = 7,
) {
  const since = getWindowStart(windowDays);
  const [row] = await db
    .select({
      totalMessages: sql<number>`count(*)`,
      channelMessages: sql<number>`sum(case when ${messageLogs.deliveryKind} = 'channel' then 1 else 0 end)`,
      dmMessages: sql<number>`sum(case when ${messageLogs.deliveryKind} = 'dm' then 1 else 0 end)`,
      uniqueAgents: sql<number>`count(distinct ${messageLogs.agentId})`,
      avgLatencyMs: sql<number>`coalesce(round(avg(${messageLogs.latencyMs})), 0)`,
      maxLatencyMs: sql<number>`coalesce(max(${messageLogs.latencyMs}), 0)`,
      attachments: sql<number>`coalesce(sum(${messageLogs.attachmentCount}), 0)`,
      mentions: sql<number>`coalesce(sum(${messageLogs.mentionCount}), 0)`,
    })
    .from(messageLogs)
    .where(and(eq(messageLogs.workspaceId, workspaceId), gte(messageLogs.createdAt, since)));

  return {
    window_days: windowDays,
    since: since.toISOString(),
    total_messages: row?.totalMessages ?? 0,
    channel_messages: row?.channelMessages ?? 0,
    dm_messages: row?.dmMessages ?? 0,
    unique_agents: row?.uniqueAgents ?? 0,
    avg_latency_ms: row?.avgLatencyMs ?? 0,
    max_latency_ms: row?.maxLatencyMs ?? 0,
    attachment_count: row?.attachments ?? 0,
    mention_count: row?.mentions ?? 0,
  };
}

export async function getAgentStats(
  db: Db,
  workspaceId: string,
  windowDays = 7,
  limit = 20,
) {
  const rows = await db.all<{
    agent_id: string;
    agent_name: string;
    message_count: number;
    channel_count: number;
    dm_count: number;
    avg_latency_ms: number;
    last_message_at: number;
  }>(sql`
    SELECT
      ml.agent_id AS agent_id,
      a.name AS agent_name,
      COUNT(*) AS message_count,
      SUM(CASE WHEN ml.delivery_kind = 'channel' THEN 1 ELSE 0 END) AS channel_count,
      SUM(CASE WHEN ml.delivery_kind = 'dm' THEN 1 ELSE 0 END) AS dm_count,
      COALESCE(ROUND(AVG(ml.latency_ms)), 0) AS avg_latency_ms,
      MAX(ml.created_at) AS last_message_at
    FROM message_logs ml
    INNER JOIN agents a ON a.id = ml.agent_id
    WHERE ml.workspace_id = ${workspaceId}
      AND ml.created_at >= unixepoch() - ${windowDays * 24 * 60 * 60}
    GROUP BY ml.agent_id, a.name
    ORDER BY message_count DESC, last_message_at DESC
    LIMIT ${clampLimit(limit)}
  `);

  return rows.map((row) => ({
    agent_id: row.agent_id,
    agent_name: row.agent_name,
    message_count: Number(row.message_count ?? 0),
    channel_count: Number(row.channel_count ?? 0),
    dm_count: Number(row.dm_count ?? 0),
    avg_latency_ms: Number(row.avg_latency_ms ?? 0),
    last_message_at: row.last_message_at
      ? new Date(Number(row.last_message_at) * 1000).toISOString()
      : null,
  }));
}

export async function getCostStats(
  db: Db,
  workspaceId: string,
  windowDays = 7,
) {
  const rows = await db.all<{
    agent_id: string;
    agent_name: string;
    message_count: number;
    total_cost_usd: number;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  }>(sql`
    SELECT
      ml.agent_id AS agent_id,
      a.name AS agent_name,
      COUNT(*) AS message_count,
      COALESCE(SUM(CAST(json_extract(ml.metadata, '$._cost.total_usd') AS REAL)), 0) AS total_cost_usd,
      COALESCE(SUM(CAST(json_extract(ml.metadata, '$._cost.prompt_tokens') AS INTEGER)), 0) AS prompt_tokens,
      COALESCE(SUM(CAST(json_extract(ml.metadata, '$._cost.completion_tokens') AS INTEGER)), 0) AS completion_tokens,
      COALESCE(SUM(CAST(json_extract(ml.metadata, '$._cost.total_tokens') AS INTEGER)), 0) AS total_tokens
    FROM message_logs ml
    INNER JOIN agents a ON a.id = ml.agent_id
    WHERE ml.workspace_id = ${workspaceId}
      AND ml.created_at >= unixepoch() - ${windowDays * 24 * 60 * 60}
    GROUP BY ml.agent_id, a.name
    HAVING total_cost_usd > 0
        OR prompt_tokens > 0
        OR completion_tokens > 0
        OR total_tokens > 0
    ORDER BY total_cost_usd DESC, total_tokens DESC
  `);

  const totals = rows.reduce((acc, row) => {
    acc.total_cost_usd += Number(row.total_cost_usd ?? 0);
    acc.prompt_tokens += Number(row.prompt_tokens ?? 0);
    acc.completion_tokens += Number(row.completion_tokens ?? 0);
    acc.total_tokens += Number(row.total_tokens ?? 0);
    return acc;
  }, {
    total_cost_usd: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  });

  return {
    window_days: windowDays,
    totals,
    agents: rows.map((row) => ({
      agent_id: row.agent_id,
      agent_name: row.agent_name,
      message_count: Number(row.message_count ?? 0),
      total_cost_usd: Number(row.total_cost_usd ?? 0),
      prompt_tokens: Number(row.prompt_tokens ?? 0),
      completion_tokens: Number(row.completion_tokens ?? 0),
      total_tokens: Number(row.total_tokens ?? 0),
    })),
  };
}
