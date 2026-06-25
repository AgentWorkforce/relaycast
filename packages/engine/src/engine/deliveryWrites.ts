import { and, eq, isNull, ne, sql, inArray } from 'drizzle-orm';
import type { SQLiteInsertSelectQueryBuilder } from 'drizzle-orm/sqlite-core';
import {
  agentNodeBindings,
  agents,
  channelMembers,
  deliveries,
  dmParticipants,
  nodes,
} from '../db/schema.js';
import type { AtomicWrite, EngineDb } from '../ports/database.js';

type DeliveryMode = 'immediate' | 'next-tool-call';
type ChannelDeliveryReason = 'message' | 'mention' | 'thread-reply';
type DeliveryInsertSelect = SQLiteInsertSelectQueryBuilder<typeof deliveries>;

export interface DeliveryFanoutRecord {
  id: string;
  agentId: string;
  agentName: string;
  messageId: string;
  seq: number;
  mode: string;
  reason: string;
  status: string;
  locationType: string;
  locationNodeId: string | null;
  routeNodeId: string | null;
  routeNodeKind: string | null;
  deliveryAdapter: string | null;
}

export interface DeliveryRejectionRecord {
  agentId: string;
  agentName: string;
  messageId: string;
  reason: 'depth_cap';
  error: string;
  retryable: false;
}

export interface DeliveryOutcomeRecords {
  deliveries: DeliveryFanoutRecord[];
  rejections: DeliveryRejectionRecord[];
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

function ttlSeconds(ttlMs: number): number {
  return Math.max(1, Math.ceil(ttlMs / 1000));
}

function nextSeqSql(workspaceId: string, agentId: unknown) {
  return sql<number>`(
    SELECT COALESCE(MAX(d.seq), 0) + 1
    FROM deliveries d
    WHERE d.workspace_id = ${workspaceId}
      AND d.agent_id = ${agentId}
  )`;
}

function belowDepthCapSql(workspaceId: string, agentId: unknown, depthCap: number) {
  // Expired-but-not-yet-swept rows are not active mailbox depth: TTL expiry is
  // only swept lazily (GET /deliveries, /inbox, node replay), so an idle/offline
  // recipient would otherwise keep rejecting new sends as `depth_cap` long after
  // its queued rows should have dead-lettered. Exclude expired rows from the count.
  return sql`(
    SELECT COUNT(*)
    FROM deliveries d
    WHERE d.workspace_id = ${workspaceId}
      AND d.agent_id = ${agentId}
      AND d.status IN ('queued', 'delivered')
      AND (d.expires_at IS NULL OR d.expires_at > unixepoch())
  ) < ${depthCap}`;
}

export function buildChannelDeliveryWrite(
  db: EngineDb,
  input: {
    workspaceId: string;
    messageId: string;
    channelId: string;
    senderAgentId: string;
    mode: DeliveryMode;
    ttlMs: number;
    depthCap: number;
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
          status: sql<string>`${'queued'}`,
          seq: nextSeqSql(input.workspaceId, channelMembers.agentId),
          locationType: sql<string>`CASE WHEN ${agentNodeBindings.nodeId} IS NOT NULL THEN 'via_node' ELSE ${agents.locationType} END`,
          locationNodeId: sql<string | null>`COALESCE(${agentNodeBindings.nodeId}, ${agents.locationNodeId})`,
          routeNodeId: sql<string | null>`COALESCE(${agentNodeBindings.nodeId}, ${agents.locationNodeId})`,
          routeNodeKind: nodes.kind,
          deliveryAdapter: nodes.deliveryAdapter,
          dispatchAttempts: sql<number>`0`,
          nextAttemptAt: sql<null>`null`,
          lastDispatchError: sql<null>`null`,
          expiresAt: sql`(unixepoch() + ${ttlSeconds(input.ttlMs)})`,
          deliveredAt: sql<null>`null`,
          ackedAt: sql<null>`null`,
          deadLetteredAt: sql<null>`null`,
          retryable: sql<null>`null`,
          availableAt: sql<null>`null`,
          error: sql<null>`null`,
          idempotencyKey: sql<null>`null`,
          createdAt: sql`(unixepoch())`,
          updatedAt: sql<null>`null`,
        })
        .from(channelMembers)
        .innerJoin(agents, eq(channelMembers.agentId, agents.id))
        .leftJoin(agentNodeBindings, and(
          eq(agentNodeBindings.workspaceId, input.workspaceId),
          eq(agentNodeBindings.agentId, channelMembers.agentId),
          eq(agentNodeBindings.status, 'active'),
          eq(agents.locationType, 'via_node'),
          eq(agents.locationNodeId, agentNodeBindings.nodeId),
        ))
        .leftJoin(nodes, and(
          eq(nodes.workspaceId, input.workspaceId),
          eq(nodes.id, sql`COALESCE(${agentNodeBindings.nodeId}, ${agents.locationNodeId})`),
        ))
        .where(
          and(
            eq(channelMembers.channelId, input.channelId),
            ne(channelMembers.agentId, input.senderAgentId),
            belowDepthCapSql(input.workspaceId, channelMembers.agentId, input.depthCap),
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
    ttlMs: number;
    depthCap: number;
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
          status: sql<string>`${'queued'}`,
          seq: nextSeqSql(input.workspaceId, dmParticipants.agentId),
          locationType: sql<string>`CASE WHEN ${agentNodeBindings.nodeId} IS NOT NULL THEN 'via_node' ELSE ${agents.locationType} END`,
          locationNodeId: sql<string | null>`COALESCE(${agentNodeBindings.nodeId}, ${agents.locationNodeId})`,
          routeNodeId: sql<string | null>`COALESCE(${agentNodeBindings.nodeId}, ${agents.locationNodeId})`,
          routeNodeKind: nodes.kind,
          deliveryAdapter: nodes.deliveryAdapter,
          dispatchAttempts: sql<number>`0`,
          nextAttemptAt: sql<null>`null`,
          lastDispatchError: sql<null>`null`,
          expiresAt: sql`(unixepoch() + ${ttlSeconds(input.ttlMs)})`,
          deliveredAt: sql<null>`null`,
          ackedAt: sql<null>`null`,
          deadLetteredAt: sql<null>`null`,
          retryable: sql<null>`null`,
          availableAt: sql<null>`null`,
          error: sql<null>`null`,
          idempotencyKey: sql<null>`null`,
          createdAt: sql`(unixepoch())`,
          updatedAt: sql<null>`null`,
        })
        .from(dmParticipants)
        .innerJoin(agents, eq(dmParticipants.agentId, agents.id))
        .leftJoin(agentNodeBindings, and(
          eq(agentNodeBindings.workspaceId, input.workspaceId),
          eq(agentNodeBindings.agentId, dmParticipants.agentId),
          eq(agentNodeBindings.status, 'active'),
          eq(agents.locationType, 'via_node'),
          eq(agents.locationNodeId, agentNodeBindings.nodeId),
        ))
        .leftJoin(nodes, and(
          eq(nodes.workspaceId, input.workspaceId),
          eq(nodes.id, sql`COALESCE(${agentNodeBindings.nodeId}, ${agents.locationNodeId})`),
        ))
        .where(
          and(
            eq(dmParticipants.conversationId, input.conversationId),
            isNull(dmParticipants.leftAt),
            ne(dmParticipants.agentId, input.senderAgentId),
            belowDepthCapSql(input.workspaceId, dmParticipants.agentId, input.depthCap),
          ),
        )),
    )
    .onConflictDoNothing();
}

export function buildDirectDeliveryWrite(
  db: EngineDb,
  input: {
    workspaceId: string;
    messageId: string;
    agentId: string;
    mode: DeliveryMode;
    reason: string;
    ttlMs: number;
    depthCap: number;
    deliveryId?: string;
  },
): AtomicWrite {
  return db
    .insert(deliveries)
    .select((qb) =>
      asDeliveryInsertSelect(qb
        .select({
          id: sql<string>`${input.deliveryId ?? `del_${input.messageId}_${input.agentId}`}`,
          workspaceId: sql<string>`${input.workspaceId}`,
          messageId: sql<string>`${input.messageId}`,
          agentId: agents.id,
          mode: sql<string>`${input.mode}`,
          reason: sql<string>`${input.reason}`,
          priority: sql<string>`${'normal'}`,
          deadline: sql<null>`null`,
          status: sql<string>`${'queued'}`,
          seq: nextSeqSql(input.workspaceId, agents.id),
          locationType: sql<string>`CASE WHEN ${agentNodeBindings.nodeId} IS NOT NULL THEN 'via_node' ELSE ${agents.locationType} END`,
          locationNodeId: sql<string | null>`COALESCE(${agentNodeBindings.nodeId}, ${agents.locationNodeId})`,
          routeNodeId: sql<string | null>`COALESCE(${agentNodeBindings.nodeId}, ${agents.locationNodeId})`,
          routeNodeKind: nodes.kind,
          deliveryAdapter: nodes.deliveryAdapter,
          dispatchAttempts: sql<number>`0`,
          nextAttemptAt: sql<null>`null`,
          lastDispatchError: sql<null>`null`,
          expiresAt: sql`(unixepoch() + ${ttlSeconds(input.ttlMs)})`,
          deliveredAt: sql<null>`null`,
          ackedAt: sql<null>`null`,
          deadLetteredAt: sql<null>`null`,
          retryable: sql<null>`null`,
          availableAt: sql<null>`null`,
          error: sql<null>`null`,
          idempotencyKey: sql<null>`null`,
          createdAt: sql`(unixepoch())`,
          updatedAt: sql<null>`null`,
        })
        .from(agents)
        .leftJoin(agentNodeBindings, and(
          eq(agentNodeBindings.workspaceId, input.workspaceId),
          eq(agentNodeBindings.agentId, agents.id),
          eq(agentNodeBindings.status, 'active'),
          eq(agents.locationType, 'via_node'),
          eq(agents.locationNodeId, agentNodeBindings.nodeId),
        ))
        .leftJoin(nodes, and(
          eq(nodes.workspaceId, input.workspaceId),
          eq(nodes.id, sql`COALESCE(${agentNodeBindings.nodeId}, ${agents.locationNodeId})`),
        ))
        .where(and(
          eq(agents.id, input.agentId),
          belowDepthCapSql(input.workspaceId, agents.id, input.depthCap),
        ))),
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
      agentName: agents.name,
      messageId: deliveries.messageId,
      seq: deliveries.seq,
      mode: deliveries.mode,
      reason: deliveries.reason,
      status: deliveries.status,
      locationType: deliveries.locationType,
      locationNodeId: deliveries.locationNodeId,
      routeNodeId: deliveries.routeNodeId,
      routeNodeKind: deliveries.routeNodeKind,
      deliveryAdapter: deliveries.deliveryAdapter,
    })
    .from(deliveries)
    .innerJoin(agents, eq(deliveries.agentId, agents.id))
    .where(eq(deliveries.messageId, messageId));

  return rows.map((row) => ({
    id: row.id,
    agentId: row.agentId,
    agentName: row.agentName,
    messageId: row.messageId,
    seq: row.seq,
    mode: row.mode,
    reason: row.reason ?? 'message',
    status: row.status,
    locationType: row.locationType,
    locationNodeId: row.locationNodeId,
    routeNodeId: row.routeNodeId,
    routeNodeKind: row.routeNodeKind,
    deliveryAdapter: row.deliveryAdapter,
  }));
}

function missingDepthCapRejections(
  intended: Array<{ agentId: string; agentName: string }>,
  deliveries: DeliveryFanoutRecord[],
  messageId: string,
): DeliveryRejectionRecord[] {
  const inserted = new Set(deliveries.map((delivery) => delivery.agentId));
  return intended
    .filter((recipient) => !inserted.has(recipient.agentId))
    .map((recipient) => ({
      agentId: recipient.agentId,
      agentName: recipient.agentName,
      messageId,
      reason: 'depth_cap' as const,
      error: 'mailbox depth cap exceeded',
      retryable: false as const,
    }));
}

export async function fetchChannelDeliveryOutcomes(
  db: EngineDb,
  input: {
    messageId: string;
    channelId: string;
    senderAgentId: string;
  },
): Promise<DeliveryOutcomeRecords> {
  const [deliveries, intended] = await Promise.all([
    fetchDeliveryFanoutRecords(db, input.messageId),
    db
      .select({
        agentId: channelMembers.agentId,
        agentName: agents.name,
      })
      .from(channelMembers)
      .innerJoin(agents, eq(channelMembers.agentId, agents.id))
      .where(and(
        eq(channelMembers.channelId, input.channelId),
        ne(channelMembers.agentId, input.senderAgentId),
      )),
  ]);
  return {
    deliveries,
    rejections: missingDepthCapRejections(intended, deliveries, input.messageId),
  };
}

export async function fetchGroupDeliveryOutcomes(
  db: EngineDb,
  input: {
    messageId: string;
    conversationId: string;
    senderAgentId: string;
  },
): Promise<DeliveryOutcomeRecords> {
  const [deliveries, intended] = await Promise.all([
    fetchDeliveryFanoutRecords(db, input.messageId),
    db
      .select({
        agentId: dmParticipants.agentId,
        agentName: agents.name,
      })
      .from(dmParticipants)
      .innerJoin(agents, eq(dmParticipants.agentId, agents.id))
      .where(and(
        eq(dmParticipants.conversationId, input.conversationId),
        isNull(dmParticipants.leftAt),
        ne(dmParticipants.agentId, input.senderAgentId),
      )),
  ]);
  return {
    deliveries,
    rejections: missingDepthCapRejections(intended, deliveries, input.messageId),
  };
}

export async function fetchDirectDeliveryOutcomes(
  db: EngineDb,
  input: {
    messageId: string;
    recipientAgentId: string;
  },
): Promise<DeliveryOutcomeRecords> {
  const [deliveries, intended] = await Promise.all([
    fetchDeliveryFanoutRecords(db, input.messageId),
    db
      .select({
        agentId: agents.id,
        agentName: agents.name,
      })
      .from(agents)
      .where(inArray(agents.id, [input.recipientAgentId])),
  ]);
  return {
    deliveries,
    rejections: missingDepthCapRejections(intended, deliveries, input.messageId),
  };
}
