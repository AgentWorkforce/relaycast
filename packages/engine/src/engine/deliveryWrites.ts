import { and, eq, isNull, ne, or, sql, inArray, getTableColumns, type SQL, type SQLWrapper } from 'drizzle-orm';
import {
  agentNodeBindings,
  agents,
  channelMembers,
  deliveries,
  dmParticipants,
  nodes,
} from '../db/schema.js';
import type { AtomicWrite, EngineDb } from '../ports/database.js';
import {
  workspaceActiveDepthSql,
  workspaceGrowthLimit,
  type DeliveryAudience,
  type WorkspaceDeliveryPolicy,
} from './workspaceDeliveryPolicy.js';

type DeliveryMode = 'immediate' | 'next-tool-call';
type ChannelDeliveryReason = 'message' | 'mention' | 'thread-reply';

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
  routeNodeRole: string | null;
  deliveryAdapter: string | null;
  nextAttemptAt?: Date | null;
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
  if (mentionHandles.length === 0) {
    return sql<string>`${fallback}`;
  }

  const mentionList = sql.join(mentionHandles.map((handle) => sql`${handle}`), sql`, `);
  return sql<string>`case when ${agents.name} in (${mentionList}) then ${'mention'} else ${fallback} end`;
}

function channelMuteDeliveryFilter(mentionHandles: readonly string[]) {
  if (mentionHandles.length === 0) {
    return eq(channelMembers.isMuted, false);
  }
  return or(eq(channelMembers.isMuted, false), inArray(agents.name, mentionHandles));
}

/** Materialize the exact rows that will be inserted, including routing, mute,
 * mailbox, and duplicate filters. Admission and insertion share this snapshot;
 * neither re-evaluates recipient membership after sequence triggers run.
 */
function deliveryAdmissionSelect(
  workspaceId: string,
  policy: WorkspaceDeliveryPolicy | undefined,
  audience: DeliveryAudience,
): (query: SQLWrapper) => SQL {
  return (query) => {
    if (!policy) return query.getSQL();
    const columns = Object.values(getTableColumns(deliveries));
    const names = sql.join(columns.map(column => sql.identifier(column.name)), sql`, `);
    const values = sql.join(columns.map(column => column.name === 'status'
      ? sql`CASE WHEN capacity_admission.allowed THEN capacity_candidates.status ELSE NULL END`
      : sql`capacity_candidates.${sql.identifier(column.name)}`), sql`, `);
    const limit = workspaceGrowthLimit(policy, audience);
    return sql`WITH capacity_candidates (${names}) AS MATERIALIZED (${query.getSQL()}),
      capacity_admission AS MATERIALIZED (
        SELECT (${workspaceActiveDepthSql(workspaceId)} + (SELECT COUNT(*) FROM capacity_candidates)) <= ${limit} AS allowed
      )
      SELECT ${values} FROM capacity_candidates CROSS JOIN capacity_admission WHERE 1`;
  };
}

function ttlSeconds(ttlMs: number): number {
  return Math.max(1, Math.ceil(ttlMs / 1000));
}

function nextDeliverySeqSql() {
  // deliverySeq is normally >= deliveryAckSeq. Including the cursor keeps a
  // future/stale cumulative ACK from making the next allocation replay-hidden.
  return sql<number>`MAX(${agents.deliverySeq}, ${agents.deliveryAckSeq}) + 1`;
}

/** Test live mailbox depth with indexed branches capped at the admission limit. */
function belowDepthCapSql(workspaceId: string, agentId: unknown, depthCap: number) {
  // Expired-but-not-yet-swept rows are not active mailbox depth: TTL expiry is
  // only swept lazily (GET /deliveries, /inbox, node replay), so an idle/offline
  // recipient would otherwise keep rejecting new sends as `depth_cap` long after
  // its queued rows should have dead-lettered. Exclude expired rows from the count.
  return sql`(
    SELECT COUNT(*) FROM (
      SELECT 1 FROM deliveries d INDEXED BY idx_deliveries_agent_active_expiry
      WHERE d.workspace_id = ${workspaceId}
        AND d.agent_id = ${agentId}
        AND d.status IN ('queued', 'delivered')
        AND d.expires_at IS NULL
      UNION ALL
      SELECT 1 FROM deliveries d INDEXED BY idx_deliveries_agent_active_expiry
      WHERE d.workspace_id = ${workspaceId}
        AND d.agent_id = ${agentId}
        AND d.status IN ('queued', 'delivered')
        AND d.expires_at > unixepoch()
      LIMIT ${depthCap}
    )
  ) < ${depthCap}`;
}

/**
 * Compose the `workspace_id` value for a delivery insert.
 *
 * `deliveries.workspace_id` is NOT NULL, so emitting NULL for a failing
 * condition turns it into a real statement error that rolls back the enclosing
 * atomic write — the mechanism the existing `rejectOnOverflow` per-recipient
 * guard already relies on. The workspace growth condition is scalar (constant
 * across the fanout), so when it fails the *whole* broadcast is refused, never
 * silently truncated or partially admitted.
 */
/** The `workspace_id` sentinel for the per-recipient / required-mailbox guard. */
function guardedWorkspaceIdSql(args: {
  workspaceId: string;
  perRecipientOk?: SQL;
}): SQL<string> {
  if (!args.perRecipientOk) return sql<string>`${args.workspaceId}`;
  return sql<string>`CASE WHEN ${args.perRecipientOk} THEN ${args.workspaceId} ELSE NULL END`;
}

function newDeliveryIdentitySql(messageId: string, agentId: unknown) {
  return sql`NOT EXISTS (SELECT 1 FROM deliveries existing
    WHERE existing.message_id = ${messageId} AND existing.agent_id = ${agentId})`;
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
    /** Abort the enclosing atomic write when ANY recipient has no capacity. */
    rejectOnOverflow?: boolean;
    /** Server-resolved workspace growth policy; absent => no workspace guard. */
    workspacePolicy?: WorkspaceDeliveryPolicy;
    /** Server-classified audience; broadcasts may not consume the reserve. */
    audience?: DeliveryAudience;
  },
): AtomicWrite {
  const mentionHandles = input.mentionHandles ?? [];
  const reason = channelReasonSql(mentionHandles, input.reason ?? 'message');
  const workspaceId = guardedWorkspaceIdSql({
    workspaceId: input.workspaceId,
    perRecipientOk: input.rejectOnOverflow
      ? belowDepthCapSql(input.workspaceId, channelMembers.agentId, input.depthCap)
      : undefined,
  });
  const guardedSelect = deliveryAdmissionSelect(input.workspaceId, input.workspacePolicy, input.audience ?? 'broadcast');
  const status = sql<string>`${'queued'}`;
  return db
    .insert(deliveries)
    .select((qb) =>
      guardedSelect(qb
        .select({
          id: deliveryId(input.messageId, channelMembers.agentId),
          // A NOT NULL guard runs inside the same INSERT SELECT as capacity
          // evaluation. Unlike a preflight count, it cannot race another send.
          // The enclosing atomic write rolls back the message and every recipient.
          workspaceId,
          messageId: sql<string>`${input.messageId}`,
          agentId: channelMembers.agentId,
          mode: sql<string>`${input.mode}`,
          reason,
          priority: sql<string>`${'normal'}`,
          deadline: sql<null>`null`,
          status,
          // Migration 0029 installs an AFTER INSERT trigger that advances the
          // same agent row to this value. Allocation and high-water advancement
          // therefore happen in one SQLite statement on every adapter.
          seq: nextDeliverySeqSql(),
          locationType: sql<string>`CASE WHEN ${agentNodeBindings.nodeId} IS NOT NULL THEN 'via_node' ELSE ${agents.locationType} END`,
          locationNodeId: sql<string | null>`COALESCE(${agentNodeBindings.nodeId}, ${agents.locationNodeId})`,
          routeNodeId: sql<string | null>`COALESCE(${agentNodeBindings.nodeId}, ${agents.locationNodeId})`,
          routeNodeKind: nodes.kind,
          routeNodeRole: nodes.role,
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
            channelMuteDeliveryFilter(mentionHandles),
            ne(channelMembers.agentId, input.senderAgentId),
            newDeliveryIdentitySql(input.messageId, channelMembers.agentId),
            input.rejectOnOverflow ? undefined : belowDepthCapSql(input.workspaceId, channelMembers.agentId, input.depthCap),
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
    /** Server-resolved workspace growth policy; absent => no workspace guard. */
    workspacePolicy?: WorkspaceDeliveryPolicy;
  },
): AtomicWrite {
  const workspaceId = guardedWorkspaceIdSql({ workspaceId: input.workspaceId });
  const guardedSelect = deliveryAdmissionSelect(input.workspaceId, input.workspacePolicy, 'targeted');
  const status = sql<string>`${'queued'}`;
  return db
    .insert(deliveries)
    .select((qb) =>
      guardedSelect(qb
        .select({
          id: deliveryId(input.messageId, dmParticipants.agentId),
          workspaceId,
          messageId: sql<string>`${input.messageId}`,
          agentId: dmParticipants.agentId,
          mode: sql<string>`${input.mode}`,
          reason: sql<string>`${'dm'}`,
          priority: sql<string>`${'normal'}`,
          deadline: sql<null>`null`,
          status,
          seq: nextDeliverySeqSql(),
          locationType: sql<string>`CASE WHEN ${agentNodeBindings.nodeId} IS NOT NULL THEN 'via_node' ELSE ${agents.locationType} END`,
          locationNodeId: sql<string | null>`COALESCE(${agentNodeBindings.nodeId}, ${agents.locationNodeId})`,
          routeNodeId: sql<string | null>`COALESCE(${agentNodeBindings.nodeId}, ${agents.locationNodeId})`,
          routeNodeKind: nodes.kind,
          routeNodeRole: nodes.role,
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
            newDeliveryIdentitySql(input.messageId, dmParticipants.agentId),
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
    /** Server-resolved workspace growth policy; absent => no workspace guard. */
    workspacePolicy?: WorkspaceDeliveryPolicy;
  },
): AtomicWrite {
  const workspaceId = guardedWorkspaceIdSql({ workspaceId: input.workspaceId });
  const guardedSelect = deliveryAdmissionSelect(input.workspaceId, input.workspacePolicy, 'targeted');
  const status = sql<string>`${'queued'}`;
  return db
    .insert(deliveries)
    .select((qb) =>
      guardedSelect(qb
        .select({
          id: sql<string>`${input.deliveryId ?? `del_${input.messageId}_${input.agentId}`}`,
          workspaceId,
          messageId: sql<string>`${input.messageId}`,
          agentId: agents.id,
          mode: sql<string>`${input.mode}`,
          reason: sql<string>`${input.reason}`,
          priority: sql<string>`${'normal'}`,
          deadline: sql<null>`null`,
          status,
          seq: nextDeliverySeqSql(),
          locationType: sql<string>`CASE WHEN ${agentNodeBindings.nodeId} IS NOT NULL THEN 'via_node' ELSE ${agents.locationType} END`,
          locationNodeId: sql<string | null>`COALESCE(${agentNodeBindings.nodeId}, ${agents.locationNodeId})`,
          routeNodeId: sql<string | null>`COALESCE(${agentNodeBindings.nodeId}, ${agents.locationNodeId})`,
          routeNodeKind: nodes.kind,
          routeNodeRole: nodes.role,
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
        eq(agents.workspaceId, input.workspaceId),
        newDeliveryIdentitySql(input.messageId, agents.id),
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
      routeNodeRole: deliveries.routeNodeRole,
      deliveryAdapter: deliveries.deliveryAdapter,
      nextAttemptAt: deliveries.nextAttemptAt,
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
    routeNodeRole: row.routeNodeRole,
    deliveryAdapter: row.deliveryAdapter,
    nextAttemptAt: row.nextAttemptAt,
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
    mentionHandles?: readonly string[];
  },
): Promise<DeliveryOutcomeRecords> {
  const mentionHandles = input.mentionHandles ?? [];
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
        channelMuteDeliveryFilter(mentionHandles),
        ne(channelMembers.agentId, input.senderAgentId),
            newDeliveryIdentitySql(input.messageId, channelMembers.agentId),
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
            newDeliveryIdentitySql(input.messageId, dmParticipants.agentId),
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
