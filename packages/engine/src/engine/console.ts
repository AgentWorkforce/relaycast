import { and, desc, eq, lt, gte, sql } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { agents, channels, messageLogs } from '../db/schema.js';
import type { AtomicWrite } from '../ports/database.js';
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

type MessageLogRow = {
  id: string;
  messageId: string;
  channelId: string;
  channelName: string | null;
  channelType: number | null;
  agentId: string;
  agentName: string | null;
  conversationId: string | null;
  deliveryKind: string;
  body: string;
  contentType: string | null;
  metadata: Record<string, unknown> | null;
  attachmentCount: number;
  mentionCount: number;
  latencyMs: number;
  createdAt: Date;
};

function clampLimit(limit?: number): number {
  return Math.min(Math.max(limit ?? 50, 1), 100);
}

function getWindowStart(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function publicMessageLog(row: MessageLogRow) {
  return {
    id: row.id,
    message_id: row.messageId,
    channel_id: row.channelId,
    channel_name: row.channelName,
    channel_type: row.channelType,
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
  };
}

export type ConsoleMessageLog = ReturnType<typeof publicMessageLog>;

function costNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function nestedRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function costMetadata(log: ConsoleMessageLog) {
  const cost = nestedRecord(nestedRecord(log.metadata)._cost);
  return {
    total_cost_usd: costNumber(cost.total_usd),
    prompt_tokens: costNumber(cost.prompt_tokens),
    completion_tokens: costNumber(cost.completion_tokens),
    total_tokens: costNumber(cost.total_tokens),
  };
}

/**
 * Build the message-log insert without executing it, so send paths can include
 * it in an atomic statement list (see {@link runAtomicWrites}).
 */
export function buildMessageLogWrite(db: Db, input: LogMessageInput): AtomicWrite {
  return db
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
      channelType: channels.channelType,
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

  return rows.map(publicMessageLog);
}

export async function listMessageLogsForWindow(
  db: Db,
  workspaceId: string,
  windowDays = 7,
): Promise<ConsoleMessageLog[]> {
  const since = getWindowStart(windowDays);
  const rows = await db
    .select({
      id: messageLogs.id,
      messageId: messageLogs.messageId,
      channelId: messageLogs.channelId,
      channelName: channels.name,
      channelType: channels.channelType,
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
    .where(and(eq(messageLogs.workspaceId, workspaceId), gte(messageLogs.createdAt, since)))
    .orderBy(desc(messageLogs.id));

  return rows.map(publicMessageLog);
}

export function summarizeConsoleOverview(logs: ConsoleMessageLog[], windowDays = 7) {
  const since = getWindowStart(windowDays);
  const latencyTotal = logs.reduce((sum, log) => sum + log.latency_ms, 0);

  return {
    window_days: windowDays,
    since: since.toISOString(),
    total_messages: logs.length,
    channel_messages: logs.filter((log) => log.delivery_kind === 'channel').length,
    dm_messages: logs.filter((log) => log.delivery_kind === 'dm').length,
    unique_agents: new Set(logs.map((log) => log.agent_id)).size,
    avg_latency_ms: logs.length > 0 ? Math.round(latencyTotal / logs.length) : 0,
    max_latency_ms: logs.reduce((max, log) => Math.max(max, log.latency_ms), 0),
    attachment_count: logs.reduce((sum, log) => sum + log.attachment_count, 0),
    mention_count: logs.reduce((sum, log) => sum + log.mention_count, 0),
  };
}

export function summarizeAgentStats(logs: ConsoleMessageLog[], limit = 20) {
  const byAgent = new Map<string, {
    agent_id: string;
    agent_name: string | null;
    message_count: number;
    channel_count: number;
    dm_count: number;
    latency_total: number;
    last_message_ms: number;
  }>();

  for (const log of logs) {
    const existing = byAgent.get(log.agent_id) ?? {
      agent_id: log.agent_id,
      agent_name: log.agent_name,
      message_count: 0,
      channel_count: 0,
      dm_count: 0,
      latency_total: 0,
      last_message_ms: 0,
    };
    existing.message_count += 1;
    existing.channel_count += log.delivery_kind === 'channel' ? 1 : 0;
    existing.dm_count += log.delivery_kind === 'dm' ? 1 : 0;
    existing.latency_total += log.latency_ms;
    existing.last_message_ms = Math.max(existing.last_message_ms, Date.parse(log.created_at) || 0);
    byAgent.set(log.agent_id, existing);
  }

  return [...byAgent.values()]
    .sort((left, right) => (
      right.message_count - left.message_count
      || right.last_message_ms - left.last_message_ms
      || (left.agent_name ?? '').localeCompare(right.agent_name ?? '')
    ))
    .slice(0, clampLimit(limit))
    .map((row) => ({
      agent_id: row.agent_id,
      agent_name: row.agent_name,
      message_count: row.message_count,
      channel_count: row.channel_count,
      dm_count: row.dm_count,
      avg_latency_ms: row.message_count > 0 ? Math.round(row.latency_total / row.message_count) : 0,
      last_message_at: row.last_message_ms > 0 ? new Date(row.last_message_ms).toISOString() : null,
    }));
}

export function summarizeCostStats(logs: ConsoleMessageLog[], windowDays = 7) {
  const byAgent = new Map<string, {
    agent_id: string;
    agent_name: string | null;
    message_count: number;
    total_cost_usd: number;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  }>();

  for (const log of logs) {
    const cost = costMetadata(log);
    const existing = byAgent.get(log.agent_id) ?? {
      agent_id: log.agent_id,
      agent_name: log.agent_name,
      message_count: 0,
      total_cost_usd: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    };
    existing.message_count += 1;
    existing.total_cost_usd += cost.total_cost_usd;
    existing.prompt_tokens += cost.prompt_tokens;
    existing.completion_tokens += cost.completion_tokens;
    existing.total_tokens += cost.total_tokens;
    byAgent.set(log.agent_id, existing);
  }

  const agentsWithCosts = [...byAgent.values()]
    .filter((row) => (
      row.total_cost_usd > 0
      || row.prompt_tokens > 0
      || row.completion_tokens > 0
      || row.total_tokens > 0
    ))
    .sort((left, right) => (
      right.total_cost_usd - left.total_cost_usd
      || right.total_tokens - left.total_tokens
      || (left.agent_name ?? '').localeCompare(right.agent_name ?? '')
    ))
    .map((row) => ({
      agent_id: row.agent_id,
      agent_name: row.agent_name,
      message_count: row.message_count,
      total_cost_usd: row.total_cost_usd,
      prompt_tokens: row.prompt_tokens,
      completion_tokens: row.completion_tokens,
      total_tokens: row.total_tokens,
    }));

  const totals = agentsWithCosts.reduce((acc, row) => {
    acc.total_cost_usd += row.total_cost_usd;
    acc.prompt_tokens += row.prompt_tokens;
    acc.completion_tokens += row.completion_tokens;
    acc.total_tokens += row.total_tokens;
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
    agents: agentsWithCosts,
  };
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
