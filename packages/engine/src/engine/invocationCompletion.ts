import { and, eq } from 'drizzle-orm';
import { transformForClient } from './wsTransform.js';
import { enqueueEvent } from './eventQueue.js';
import { actionInvocations } from '../db/schema.js';
import type { EngineDb } from '../ports/database.js';
import type { EngineDeps } from '../ports/index.js';
import { sendNodeDeliveriesToAgents } from './nodeDeliver.js';
import { appendAndPublishWorkspaceEvent } from './workspaceEvents.js';

export type InvocationCompletionDeps = Pick<EngineDeps, 'db' | 'realtime' | 'webhookQueue' | 'nodeConnections' | 'config'>;

type CompletionResult = {
  invocation_id: string;
  action_name: string;
  caller_id: string | null;
  status: string;
  output: unknown;
  error: string | null;
};

function buildEvent(type: string, workspaceId: string, data: Record<string, unknown>) {
  return {
    type,
    workspace_id: workspaceId,
    data,
    timestamp: new Date().toISOString(),
  };
}

export async function emitInvocationCompletionEffects(
  deps: InvocationCompletionDeps,
  workspaceId: string,
  result: CompletionResult,
): Promise<void> {
  const eventType = result.status === 'failed' ? 'action.failed' : 'action.completed';
  const eventPayload = {
    invocation_id: result.invocation_id,
    action_name: result.action_name,
    status: result.status,
    output: result.output,
    error: result.error,
  };
  const event = buildEvent(eventType, workspaceId, eventPayload);
  const payload = transformForClient(event);

  const fanoutTasks: Promise<unknown>[] = [];
  if (result.caller_id) {
    fanoutTasks.push(
      sendNodeDeliveriesToAgents({
        db: deps.db,
        nodeConnections: deps.nodeConnections,
        workspaceId,
        environment: deps.config?.environment,
        httpPushProxy: deps.config?.httpPushProxy,
      }, {
        agentIds: [result.caller_id],
        event: eventType,
        eventKey: result.invocation_id,
        data: eventPayload,
        messageId: result.invocation_id,
      }),
    );
  }
  // Through the durable log so observers can backfill action results too.
  fanoutTasks.push(
    appendAndPublishWorkspaceEvent(
      { db: deps.db, realtime: deps.realtime },
      workspaceId,
      { type: eventType, payload },
    ),
  );
  await Promise.allSettled(fanoutTasks);

  await enqueueAndSendWebhook(deps, workspaceId, eventType, result as Record<string, unknown>);
}

/**
 * Push one event through the durable outbox + external webhook queue. Both steps
 * are best-effort — a caller's state transition must never fail because the
 * outbox insert or queue send did.
 */
async function enqueueAndSendWebhook(
  deps: Pick<InvocationCompletionDeps, 'db' | 'webhookQueue'>,
  workspaceId: string,
  eventType: string,
  data: Record<string, unknown>,
): Promise<void> {
  let outboxId: string | undefined;
  try {
    outboxId = await enqueueEvent(deps.db, workspaceId, eventType, data);
  } catch {
    // Best-effort: if the durable outbox row can't be inserted, still try the queue send.
  }

  try {
    await deps.webhookQueue.send(outboxId ? { type: eventType, workspaceId, data, outboxId } : {
      type: eventType,
      workspaceId,
      data,
    });
  } catch {
    // Best-effort side effect; the state transition must not fail because webhook delivery did.
  }
}

/**
 * Extract the spawn invocation id an agent was registered under, if any. The
 * `metadata.fleet.invocation_id` correlation is written by `registerAgentViaNode`
 * on every via-node agent.
 */
export function fleetInvocationId(metadata: unknown): string | null {
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const fleet = (metadata as Record<string, unknown>).fleet;
    if (fleet && typeof fleet === 'object' && !Array.isArray(fleet)) {
      const invocationId = (fleet as Record<string, unknown>).invocation_id;
      if (typeof invocationId === 'string') return invocationId;
    }
  }
  return null;
}

/** Resolve the caller mailbox of a spawn invocation; best-effort (null on any error). */
async function lookupSpawnCaller(db: EngineDb, workspaceId: string, invocationId: string): Promise<string | null> {
  try {
    const [row] = await db
      .select({ callerId: actionInvocations.callerId })
      .from(actionInvocations)
      .where(and(eq(actionInvocations.workspaceId, workspaceId), eq(actionInvocations.id, invocationId)));
    return row?.callerId ?? null;
  } catch {
    return null;
  }
}

/** Distinguishes the three server-observable sources of an agent exit. */
export type AgentExitedReason = 'deregistered' | 'missing_from_inventory' | 'released';

export interface AgentExitedInput {
  agentId: string;
  agentName: string;
  /** The node the agent exited from (authoritative), or null when unknown. */
  nodeId: string | null;
  /** The spawn invocation the agent was registered under, if correlated. */
  invocationId: string | null;
  reason: AgentExitedReason;
}

/**
 * Fan out a durable `agent.exited` event across the same three channels as
 * invocation completion: (1) the spawn caller's mailbox (when the exit
 * correlates to a spawn invocation with a live caller), (2) the durable
 * workspace event log + live observer stream, and (3) the webhook outbox.
 *
 * Best-effort by contract — every channel is isolated so the underlying agent
 * state transition (deregister / inventory reconcile / release) never fails
 * because an emission did.
 */
export async function emitAgentExitedEffects(
  deps: InvocationCompletionDeps,
  workspaceId: string,
  input: AgentExitedInput,
): Promise<void> {
  const eventType = 'agent.exited';
  const eventData: Record<string, unknown> = {
    agent_id: input.agentId,
    agent_name: input.agentName,
    node_id: input.nodeId,
    invocation_id: input.invocationId,
    reason: input.reason,
  };
  const event = buildEvent(eventType, workspaceId, eventData);
  const payload = transformForClient(event);

  const fanoutTasks: Promise<unknown>[] = [];
  // Notify the spawn caller's mailbox so a spawner learns its agent exited. The
  // stable eventKey dedupes redundant emissions of the same logical exit.
  const callerId = input.invocationId ? await lookupSpawnCaller(deps.db, workspaceId, input.invocationId) : null;
  if (callerId) {
    fanoutTasks.push(
      sendNodeDeliveriesToAgents({
        db: deps.db,
        nodeConnections: deps.nodeConnections,
        workspaceId,
        environment: deps.config?.environment,
        httpPushProxy: deps.config?.httpPushProxy,
      }, {
        agentIds: [callerId],
        event: eventType,
        eventKey: `${input.agentId}_${input.invocationId ?? 'none'}_${input.reason}`,
        data: eventData,
        messageId: `agent_exited_${input.agentId}`,
      }),
    );
  }
  fanoutTasks.push(
    appendAndPublishWorkspaceEvent(
      { db: deps.db, realtime: deps.realtime },
      workspaceId,
      { type: eventType, payload },
    ),
  );
  await Promise.allSettled(fanoutTasks);

  await enqueueAndSendWebhook(deps, workspaceId, eventType, eventData);
}

/** Reason a node flipped offline, when cheaply known at the transition point. */
export type NodeOfflineReason = 'liveness_timeout' | 'disconnected' | 'deregistered';

export interface NodeStatusInput {
  status: 'online' | 'offline';
  nodeId: string;
  nodeName: string | null;
  /** Only meaningful for `offline`; omitted for `online`. */
  reason?: NodeOfflineReason;
}

/**
 * Fan out a durable `node.status.online` / `node.status.offline` event. Node
 * death has no single caller mailbox, so only the durable workspace log + live
 * stream and the webhook outbox apply. Best-effort by contract.
 */
export async function emitNodeStatusEffects(
  deps: Pick<InvocationCompletionDeps, 'db' | 'realtime' | 'webhookQueue'>,
  workspaceId: string,
  input: NodeStatusInput,
): Promise<void> {
  const eventType = input.status === 'online' ? 'node.status.online' : 'node.status.offline';
  const eventData: Record<string, unknown> = {
    node_id: input.nodeId,
    node_name: input.nodeName,
    ...(input.status === 'offline' && input.reason ? { reason: input.reason } : {}),
  };
  const event = buildEvent(eventType, workspaceId, eventData);
  const payload = transformForClient(event);

  await Promise.allSettled([
    appendAndPublishWorkspaceEvent(
      { db: deps.db, realtime: deps.realtime },
      workspaceId,
      { type: eventType, payload },
    ),
  ]);

  await enqueueAndSendWebhook(deps, workspaceId, eventType, eventData);
}
