import { and, eq, isNull, or, sql } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { actionInvocations, nodes } from '../db/tables.js';
import { codedError } from '../lib/httpError.js';
import { databaseConstraintKind, runAtomicWrites } from '../ports/database.js';
import * as sqlx from '../db/sqlx.js';

type Db = ReturnType<typeof getDb>;
type InvocationRow = typeof actionInvocations.$inferSelect;

export async function placeStrictSpawn(
  db: Db,
  args: {
    workspaceId: string;
    invocationId: string;
    nodeId: string;
    placementToken: string;
    reserve: boolean;
  },
): Promise<InvocationRow | undefined> {
  const placedAt = new Date();
  const eligible = sql`${actionInvocations.status} = 'pending'
    AND ${actionInvocations.dispatchAttempts} = 0
    AND ${actionInvocations.dispatchedNodeId} IS NULL
    AND ${actionInvocations.spawnReservedAt} IS NULL
    AND ${actionInvocations.spawnPlacementToken} IS NULL
    AND (${actionInvocations.handlerNodeId} IS NULL OR ${actionInvocations.handlerNodeId} = ${args.nodeId})`;
  const capacityAvailable = sql`${nodes.status} = 'online'
    AND ${nodes.handlersLive} = ${sqlx.bool(db, true)}
    AND (${nodes.maxAgents} = 0
      OR ${nodes.activeAgents} + COALESCE(${nodes.reservedAgents}, 0) < ${nodes.maxAgents})`;
  if (args.reserve) {
    try {
      const results = await runAtomicWrites(db, (writeDb) => [
        // Reserve first. PostgreSQL holds this row lock through the following
        // invocation CAS; SQLite and D1 execute the same pair atomically.
        writeDb
          .update(nodes)
          .set({
            activeAgents: sql`CASE WHEN ${capacityAvailable} THEN ${nodes.activeAgents} ELSE NULL END`,
            reservedAgents: sql`CASE WHEN ${capacityAvailable}
              THEN COALESCE(${nodes.reservedAgents}, 0) + 1
              ELSE ${nodes.reservedAgents} END`,
          })
          .where(and(eq(nodes.workspaceId, args.workspaceId), eq(nodes.id, args.nodeId)))
          .returning({ id: nodes.id }),
        writeDb
          .update(actionInvocations)
          .set({
            // A missing exact node makes this sibling write violate status NOT
            // NULL, rolling the full atomic group back on every adapter.
            status: sql`CASE WHEN ${eligible} AND EXISTS (
              SELECT 1 FROM ${nodes}
              WHERE ${nodes.workspaceId} = ${args.workspaceId}
                AND ${nodes.id} = ${args.nodeId}
            ) THEN 'pending' ELSE NULL END`,
            handlerNodeId: args.nodeId,
            spawnPlacementToken: args.placementToken,
            spawnReservedAt: placedAt,
            handlerUnreachableSince: placedAt,
          })
          .where(and(
            eq(actionInvocations.workspaceId, args.workspaceId),
            eq(actionInvocations.id, args.invocationId),
          ))
          .returning(),
      ], { requireAtomic: true });
      const nodeRows = results[0] as Array<{ id: string }>;
      const invocationRows = results[1] as InvocationRow[];
      return nodeRows[0] && invocationRows[0] ? invocationRows[0] : undefined;
    } catch (error) {
      const kind = databaseConstraintKind(error);
      if (kind === 'spawn_claim_changed') return undefined;
      if (kind !== 'node_capacity') throw error;
    }
  }
  const [placed] = await db
    .update(actionInvocations)
    .set({
      handlerNodeId: args.nodeId,
      spawnPlacementToken: args.placementToken,
      handlerUnreachableSince: placedAt,
    })
    .where(and(
      eq(actionInvocations.workspaceId, args.workspaceId),
      eq(actionInvocations.id, args.invocationId),
      eq(actionInvocations.status, 'pending'),
      eq(actionInvocations.dispatchAttempts, 0),
      isNull(actionInvocations.dispatchedNodeId),
      isNull(actionInvocations.spawnReservedAt),
      isNull(actionInvocations.spawnPlacementToken),
      or(isNull(actionInvocations.handlerNodeId), eq(actionInvocations.handlerNodeId, args.nodeId)),
    ))
    .returning();
  return placed;
}

export async function claimStrictSpawnDispatch(
  db: Db,
  args: {
    workspaceId: string;
    invocationId: string;
    nodeId: string;
    providerName: string;
    placementToken: string;
    reservationHeldAt: Date | null;
    dispatchTimeoutMs: number;
  },
): Promise<{ claimed: boolean; reservedAt?: Date }> {
  const dispatchedAt = new Date();
  const reservedAt = args.reservationHeldAt ?? dispatchedAt;
  const retryAfterAt = new Date(dispatchedAt.getTime() + args.dispatchTimeoutMs);
  const nodeDispatchable = args.reservationHeldAt
    ? sql`${nodes.status} = 'online'
        AND ${nodes.handlersLive} = ${sqlx.bool(db, true)}
        AND COALESCE(${nodes.reservedAgents}, 0) > 0`
    : sql`${nodes.status} = 'online'
        AND ${nodes.handlersLive} = ${sqlx.bool(db, true)}
        AND (${nodes.maxAgents} = 0
          OR ${nodes.activeAgents} + COALESCE(${nodes.reservedAgents}, 0) < ${nodes.maxAgents})`;
  const reservationMatches = args.reservationHeldAt
    ? eq(actionInvocations.spawnReservedAt, args.reservationHeldAt)
    : isNull(actionInvocations.spawnReservedAt);
  const eligible = sql`${actionInvocations.status} = 'pending'
    AND ${actionInvocations.spawnPlacementToken} = ${args.placementToken}
    AND ${actionInvocations.handlerNodeId} = ${args.nodeId}
    AND ${actionInvocations.dispatchedNodeId} IS NULL
    AND ${reservationMatches}
    AND ${actionInvocations.dispatchAttempts} = 0
    AND EXISTS (
      SELECT 1 FROM ${nodes}
      WHERE ${nodes.workspaceId} = ${args.workspaceId}
        AND ${nodes.id} = ${args.nodeId}
        AND ${nodeDispatchable}
    )`;
  const capacityAvailable = sql`${nodes.status} = 'online'
    AND ${nodes.handlersLive} = ${sqlx.bool(db, true)}
    AND (${nodes.maxAgents} = 0
      OR ${nodes.activeAgents} + COALESCE(${nodes.reservedAgents}, 0) < ${nodes.maxAgents})`;
  try {
    const results = await runAtomicWrites(db, (writeDb) => [
      writeDb
        .update(actionInvocations)
        .set({
          status: sql`CASE WHEN ${eligible} THEN 'dispatched' ELSE NULL END`,
          dispatchedNodeId: args.nodeId,
          dispatchedProvider: args.providerName,
          dispatchedAt,
          retryAfterAt,
          spawnReservedAt: reservedAt,
          spawnPlacementToken: null,
          handlerUnreachableSince: null,
          attemptedNodeIds: sqlx.jsonAppend(
            writeDb,
            sql`COALESCE(${actionInvocations.attemptedNodeIds}, '[]')`,
            sql`${args.nodeId}`,
            'text',
          ),
          dispatchAttempts: 1,
        })
        .where(and(
          eq(actionInvocations.workspaceId, args.workspaceId),
          eq(actionInvocations.id, args.invocationId),
        ))
        .returning({ id: actionInvocations.id }),
      ...(!args.reservationHeldAt ? [writeDb
        .update(nodes)
        .set({
          activeAgents: sql`CASE WHEN ${capacityAvailable} THEN ${nodes.activeAgents} ELSE NULL END`,
          reservedAgents: sql`CASE WHEN ${capacityAvailable}
            THEN COALESCE(${nodes.reservedAgents}, 0) + 1
            ELSE ${nodes.reservedAgents} END`,
        })
        .where(and(eq(nodes.workspaceId, args.workspaceId), eq(nodes.id, args.nodeId)))
        .returning({ id: nodes.id })] : []),
    ], { requireAtomic: true });
    const invocationRows = results[0] as Array<{ id: string }>;
    const nodeRows = args.reservationHeldAt ? [{ id: args.nodeId }] : results[1] as Array<{ id: string }>;
    return invocationRows[0] && nodeRows[0]
      ? { claimed: true, reservedAt }
      : { claimed: false };
  } catch (error) {
    const kind = databaseConstraintKind(error);
    if (kind === 'spawn_claim_changed') return { claimed: false };
    if (kind === 'node_capacity') {
      throw codedError('Strict spawn target is unavailable or at capacity', 'handler_unavailable', 503);
    }
    throw error;
  }
}

export async function restoreStrictSpawnDispatch(
  db: Db,
  args: {
    workspaceId: string;
    invocationId: string;
    nodeId: string;
    placementToken: string;
    reservedAt: Date;
    preserveReservation: boolean;
  },
): Promise<void> {
  const exactClaim = sql`${actionInvocations.status} = 'dispatched'
    AND ${actionInvocations.dispatchedNodeId} = ${args.nodeId}
    AND ${actionInvocations.dispatchAttempts} = 1
    AND ${eq(actionInvocations.spawnReservedAt, args.reservedAt)}
    AND ${actionInvocations.spawnPlacementToken} IS NULL`;
  await runAtomicWrites(db, (writeDb) => [
    writeDb
      .update(actionInvocations)
      .set({
        status: sql`CASE WHEN ${exactClaim} THEN 'pending' ELSE NULL END`,
        dispatchedNodeId: null,
        dispatchedProvider: null,
        dispatchedAt: null,
        retryAfterAt: null,
        spawnReservedAt: args.preserveReservation ? args.reservedAt : null,
        spawnPlacementToken: args.placementToken,
        handlerUnreachableSince: new Date(),
        attemptedNodeIds: [],
        dispatchAttempts: 0,
      })
      .where(and(
        eq(actionInvocations.workspaceId, args.workspaceId),
        eq(actionInvocations.id, args.invocationId),
      )),
    ...(!args.preserveReservation ? [writeDb
      .update(nodes)
      .set({
        reservedAgents: sql`CASE WHEN COALESCE(${nodes.reservedAgents}, 0) > 0
          THEN ${nodes.reservedAgents} - 1 ELSE 0 END`,
      })
      .where(and(eq(nodes.workspaceId, args.workspaceId), eq(nodes.id, args.nodeId)))] : []),
  ], { requireAtomic: true });
}
