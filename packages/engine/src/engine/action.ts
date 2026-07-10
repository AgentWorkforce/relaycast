import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { actions, actionInvocations, agents, agentNodeBindings, nodes } from '../db/schema.js';
import { generateId } from './snowflake.js';
import { codedError } from '../lib/httpError.js';
import { toFleetWireJson } from './deliveryWire.js';
import type { NodeConnectionRegistry } from '../ports/realtime.js';
import { claimSpawnNode, chooseNodeForAction, isNodeLive, releaseNodeCapacity, reserveNodeCapacity } from './placement.js';
import { DEFAULT_PROVIDER_NAME, capacityProviderName, getProvider, isProviderLive } from './nodeProvider.js';

type Db = ReturnType<typeof getDb>;
type ActionRow = typeof actions.$inferSelect;
type InvocationRow = typeof actionInvocations.$inferSelect;
type RetryableInvocationRow = Pick<
  InvocationRow,
  'id' | 'workspaceId' | 'actionName' | 'callerId' | 'input' | 'status' | 'dispatchedNodeId' | 'spawnReservedAt' | 'attemptedNodeIds' | 'dispatchAttempts'
>;

const OPEN_INVOCATION_STATUSES = ['pending', 'dispatched', 'invoked'];
export const ACTION_DISPATCH_TIMEOUT_MS = 30_000;
const ACTION_RETRY_BACKOFF_MS = 5_000;
const NODE_DRAIN_REQUEUE_RETRY_MS = 5_000;

export interface SweepTimedOutInvocationsOptions {
  timeoutMs?: number;
}

function capabilityName(capability: string | { name?: string } | null | undefined): string | null {
  if (typeof capability === 'string') return capability;
  if (capability && typeof capability.name === 'string') return capability.name;
  return null;
}

function isSpawnInvocation(actionName: string): boolean {
  return actionName === 'spawn' || actionName.startsWith('spawn:');
}

function isReleaseInvocation(actionName: string): boolean {
  return actionName === 'release';
}

function dispatchActionNameForInvocation(actionName: string, input: Record<string, unknown>): string {
  if (!isSpawnInvocation(actionName)) return actionName;
  const raw = input.capability ?? input.cli;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return actionName.startsWith('spawn:') ? actionName : 'spawn';
  }
  const value = raw.trim();
  return value.startsWith('spawn:') ? value : `spawn:${value}`;
}

function normalizeAttemptedNodeIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function nextRetryAfter(attempts: number): Date {
  const backoff = Math.min(ACTION_RETRY_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), 60_000);
  return new Date(Date.now() + backoff);
}

/**
 * Field set that moves an invocation into the live `dispatched` state once its
 * `action.invoke` frame has actually been delivered to the node. Shared by the
 * live dispatch path (`dispatchNodeAttempt`) and exported offline-queue drain
 * path (`drainNodeInvocations`) so the dispatch-timeout sweep — which keys off
 * `dispatchedAt` — and the reschedule path cover drained invocations too.
 */
function dispatchedStateFields(opts: { retryAfterAt?: Date | null } = {}): {
  status: 'dispatched';
  dispatchedAt: Date;
  retryAfterAt: Date | null;
} {
  return {
    status: 'dispatched',
    dispatchedAt: new Date(),
    retryAfterAt: opts.retryAfterAt ?? null,
  };
}

function isActionVisibleToCaller(availableTo: string[] | null, callerName?: string): boolean {
  if (!availableTo || availableTo.length === 0) return true;
  return !!callerName && availableTo.includes(callerName);
}

function requireOneHandler(data: { handler_agent?: string; handler_node?: string }) {
  const hasAgent = !!data.handler_agent;
  const hasNode = !!data.handler_node;
  if (hasAgent === hasNode) {
    throw codedError('Exactly one of handler_agent or handler_node is required', 'invalid_action_handler', 400);
  }
}

function recordInput(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function publicAction(row: {
  id: string;
  name: string;
  description: string;
  handlerAgentName: string | null;
  handlerNodeName: string | null;
  handlerNodeId: string | null;
  inputSchema: Record<string, unknown> | null;
  outputSchema: Record<string, unknown> | null;
  availableTo: string[] | null;
  isActive: boolean;
  createdAt: Date;
}) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    handler_agent: row.handlerAgentName,
    handler_node: row.handlerNodeName,
    handler_node_id: row.handlerNodeId,
    input_schema: row.inputSchema ?? {},
    output_schema: row.outputSchema ?? {},
    available_to: row.availableTo ?? null,
    is_active: row.isActive,
    created_at: row.createdAt.toISOString(),
  };
}

/** Resolution priority when a name has several handlers: agent-hosted, then a
 * node action with a workspace-global alias, then a plain node-scoped action. */
function actionResolutionRank(row: ActionRow): number {
  if (row.handlerNodeId === null) return 0;
  if (row.isGlobal) return 1;
  return 2;
}

/**
 * Resolve an action by name for invocation. The workspace-scoped invoke
 * (`POST /v1/actions/:name/invoke`) reaches only agent-hosted actions and node
 * actions that claimed a workspace-global alias — plain node-scoped actions are
 * node-addressed there. `includeNodeScoped` lifts that filter for callers that
 * bind to a name without a node (message triggers), so a trigger can fire a
 * fleet-provider action; the resolved node-scoped row is then dispatched
 * node-addressed by {@link invokeAction}. `(workspaceId, name)` is not unique
 * across nodes, so a stable id tiebreak keeps resolution deterministic.
 */
async function fetchAction(
  db: Db,
  workspaceId: string,
  actionName: string,
  includeNodeScoped = false,
): Promise<ActionRow | null> {
  const rows = await db
    .select()
    .from(actions)
    .where(
      and(
        eq(actions.workspaceId, workspaceId),
        eq(actions.name, actionName),
        eq(actions.isActive, true),
        ...(includeNodeScoped ? [] : [or(isNull(actions.handlerNodeId), eq(actions.isGlobal, true))]),
      ),
    );
  return rows.sort(
    (a, b) => actionResolutionRank(a) - actionResolutionRank(b) || a.id.localeCompare(b.id),
  )[0] ?? null;
}

/** Resolve a node-addressed action by its unique `(node, name)` key. */
async function fetchNodeAction(db: Db, workspaceId: string, nodeId: string, actionName: string): Promise<ActionRow | null> {
  const [action] = await db
    .select()
    .from(actions)
    .where(and(
      eq(actions.workspaceId, workspaceId),
      eq(actions.handlerNodeId, nodeId),
      eq(actions.name, actionName),
      eq(actions.isActive, true),
    ));
  return action ?? null;
}

export async function registerAction(
  db: Db,
  workspaceId: string,
  data: {
    name: string;
    description: string;
    handler_agent?: string;
    handler_node?: string;
    input_schema?: Record<string, unknown>;
    output_schema?: Record<string, unknown>;
    available_to?: string[];
  },
) {
  requireOneHandler(data);

  let handlerAgentId: string | null = null;
  let handlerAgentName: string | null = null;
  let handlerNodeId: string | null = null;
  let handlerNodeName: string | null = null;

  if (data.handler_agent) {
    const [agent] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), eq(agents.name, data.handler_agent)));

    if (!agent) {
      throw codedError(`Agent "${data.handler_agent}" not found`, 'agent_not_found', 404);
    }
    handlerAgentId = agent.id;
    handlerAgentName = agent.name;
  }

  if (data.handler_node) {
    const [node] = await db
      .select()
      .from(nodes)
      .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.name, data.handler_node)));

    if (!node) {
      throw codedError(`Node "${data.handler_node}" not found`, 'node_not_found', 404);
    }
    const nodeCapabilities = Array.isArray(node.capabilities)
      ? node.capabilities.map(capabilityName).filter((value): value is string => !!value)
      : [];
    if (!nodeCapabilities.includes(data.name)) {
      throw codedError(`Node "${data.handler_node}" does not provide ${data.name}`, 'capability_mismatch', 409);
    }
    handlerNodeId = node.id;
    handlerNodeName = node.name;
  }

  const id = `act_${generateId()}`;
  const [action] = await db
    .insert(actions)
    .values({
      id,
      workspaceId,
      name: data.name,
      description: data.description,
      handlerAgentId,
      handlerNodeId,
      inputSchema: data.input_schema ?? {},
      outputSchema: data.output_schema ?? {},
      availableTo: data.available_to ?? null,
    })
    .returning();

  return {
    id: action.id,
    name: action.name,
    description: action.description,
    handler_agent: handlerAgentName,
    handler_node: handlerNodeName,
    handler_node_id: handlerNodeId,
    input_schema: action.inputSchema,
    output_schema: action.outputSchema,
    available_to: action.availableTo ?? null,
    is_active: action.isActive,
    created_at: action.createdAt.toISOString(),
  };
}

export async function listActions(db: Db, workspaceId: string, callerName?: string) {
  const rows = await db
    .select({
      id: actions.id,
      name: actions.name,
      description: actions.description,
      handlerAgentName: agents.name,
      handlerNodeName: nodes.name,
      handlerNodeId: actions.handlerNodeId,
      inputSchema: actions.inputSchema,
      outputSchema: actions.outputSchema,
      availableTo: actions.availableTo,
      isActive: actions.isActive,
      createdAt: actions.createdAt,
    })
    .from(actions)
    .leftJoin(agents, eq(actions.handlerAgentId, agents.id))
    .leftJoin(nodes, eq(actions.handlerNodeId, nodes.id))
    .where(eq(actions.workspaceId, workspaceId));

  return rows
    .filter((r) => isActionVisibleToCaller(r.availableTo ?? null, callerName))
    .map(publicAction);
}

export async function getAction(db: Db, workspaceId: string, name: string, callerName?: string) {
  const [row] = await db
    .select({
      id: actions.id,
      name: actions.name,
      description: actions.description,
      handlerAgentName: agents.name,
      handlerNodeName: nodes.name,
      handlerNodeId: actions.handlerNodeId,
      inputSchema: actions.inputSchema,
      outputSchema: actions.outputSchema,
      availableTo: actions.availableTo,
      isActive: actions.isActive,
      createdAt: actions.createdAt,
    })
    .from(actions)
    .leftJoin(agents, eq(actions.handlerAgentId, agents.id))
    .leftJoin(nodes, eq(actions.handlerNodeId, nodes.id))
    .where(and(eq(actions.workspaceId, workspaceId), eq(actions.name, name)));

  if (!row || !isActionVisibleToCaller(row.availableTo ?? null, callerName)) return null;
  return publicAction(row);
}

export async function deleteAction(db: Db, workspaceId: string, name: string) {
  const result = await db
    .delete(actions)
    .where(and(eq(actions.workspaceId, workspaceId), eq(actions.name, name)))
    .returning();

  return result.length > 0;
}

async function createInvocation(
  db: Db,
  workspaceId: string,
  action: Pick<ActionRow, 'id' | 'name'> | null,
  data: {
    input?: Record<string, unknown>;
    caller_id?: string | null;
    caller_name?: string | null;
    action_name?: string;
    status?: string;
  },
) {
  const invocationId = `inv_${generateId()}`;
  const [invocation] = await db
    .insert(actionInvocations)
    .values({
      id: invocationId,
      workspaceId,
      actionId: action?.id ?? null,
      actionName: action?.name ?? data.action_name ?? 'spawn',
      callerId: data.caller_id ?? null,
      callerName: data.caller_name ?? null,
      input: data.input ?? {},
      status: data.status ?? 'pending',
    })
    .returning();
  return invocation;
}

/** Is a node provider currently invokable — connection up AND heartbeat handlers_live. */
async function isNodeProviderLive(
  db: Db,
  registry: NodeConnectionRegistry,
  workspaceId: string,
  nodeId: string,
  providerName: string,
): Promise<boolean> {
  if (!registry.isProviderConnected(workspaceId, nodeId, providerName)) return false;
  const provider = await getProvider(db, workspaceId, nodeId, providerName);
  return !!provider && isProviderLive(provider);
}

/**
 * Dispatch an invoke to a specific provider on a node. When the provider is
 * offline the invoke fails fast (the invocation is failed) unless it opted into
 * the per-provider offline queue.
 */
async function dispatchNodeProviderInvocation(args: {
  db: Db;
  registry: NodeConnectionRegistry;
  workspaceId: string;
  invocationId: string;
  nodeId: string;
  providerName: string;
  action: string;
  input: Record<string, unknown>;
  agent?: { id: string; name: string } | null;
  queue: boolean;
  reservationHeld?: boolean;
}): Promise<{ accepted: boolean; pending: boolean }> {
  const live = await isNodeProviderLive(args.db, args.registry, args.workspaceId, args.nodeId, args.providerName);
  if (!live) {
    if (!args.queue) {
      // Release any capacity reserved for this fail-fast spawn so the node's
      // reserved-agent count doesn't stay inflated.
      if (args.reservationHeld) {
        await releaseNodeCapacity(args.db, args.workspaceId, args.nodeId);
      }
      await args.db
        .update(actionInvocations)
        .set({ status: 'failed', error: 'handler_unavailable', completedAt: new Date(), spawnReservedAt: null })
        .where(and(
          eq(actionInvocations.workspaceId, args.workspaceId),
          eq(actionInvocations.id, args.invocationId),
          inArray(actionInvocations.status, OPEN_INVOCATION_STATUSES),
        ));
      throw codedError(`Provider "${args.providerName}" is offline for action "${args.action}"`, 'handler_unavailable', 503);
    }
    return dispatchNodeInvocation({ ...args, pending: true });
  }
  return dispatchNodeInvocation({ ...args });
}

async function dispatchRelease(args: {
  db: Db;
  registry?: NodeConnectionRegistry;
  workspaceId: string;
  data: {
    input?: Record<string, unknown>;
    caller_id?: string;
    caller_name?: string;
  };
}) {
  if (!args.registry) {
    throw codedError('Node dispatch is not available', 'node_dispatch_unavailable', 503);
  }
  const input = recordInput(args.data.input);
  const name = typeof input.name === 'string' ? input.name : null;
  if (!name) {
    throw codedError('release action input.name is required', 'invalid_release_request', 400);
  }

  const [agent] = await args.db
    .select()
    .from(agents)
    .where(and(eq(agents.workspaceId, args.workspaceId), eq(agents.name, name)));
  if (!agent) {
    throw codedError(`Agent "${name}" not found`, 'agent_not_found', 404);
  }
  if (agent.locationType !== 'via_node' || !agent.locationNodeId) {
    throw codedError(`Agent "${name}" is not bound to a node`, 'agent_not_node_bound', 409);
  }

  const invocation = await createInvocation(args.db, args.workspaceId, null, {
    input,
    caller_id: args.data.caller_id,
    caller_name: args.data.caller_name,
    action_name: 'release',
  });

  // Release is a capacity operation handled by the provider hosting the agent.
  const dispatched = await dispatchNodeInvocation({
    db: args.db,
    registry: args.registry,
    workspaceId: args.workspaceId,
    invocationId: invocation.id,
    nodeId: agent.locationNodeId,
    providerName: agent.providerName,
    action: 'release',
    input,
  });

  return {
    invocation_id: invocation.id,
    action_name: 'release',
    handler_agent_id: null,
    handler_node_id: agent.locationNodeId,
    dispatched_node_id: dispatched.accepted ? agent.locationNodeId : null,
    input: recordInput(invocation.input),
    status: dispatched.accepted ? (dispatched.pending ? 'pending' : 'dispatched') : 'pending',
    created_at: invocation.createdAt.toISOString(),
  };
}

function spawnResult(
  invocation: InvocationRow,
  nodeId: string,
  dispatched: { accepted: boolean; pending: boolean },
) {
  return {
    invocation_id: invocation.id,
    action_name: 'spawn',
    handler_agent_id: null,
    handler_node_id: nodeId,
    dispatched_node_id: dispatched.accepted ? nodeId : null,
    input: recordInput(invocation.input),
    status: dispatched.accepted ? (dispatched.pending ? 'pending' : 'dispatched') : 'pending',
    created_at: invocation.createdAt.toISOString(),
  };
}

async function dispatchSpawn(args: {
  db: Db;
  registry?: NodeConnectionRegistry;
  workspaceId: string;
  data: {
    input?: Record<string, unknown>;
    caller_id?: string;
    caller_name?: string;
  };
  /** Node-address the spawn instead of placing by capacity. */
  targetNodeId?: string;
  /** Capacity-direct delegation (`ctx.spawnAgent`) — never re-enters a shadow. */
  bypassShadow?: boolean;
}) {
  if (!args.registry) {
    throw codedError('Node dispatch is not available', 'node_dispatch_unavailable', 503);
  }

  const input = recordInput(args.data.input);
  const capability = dispatchActionNameForInvocation('spawn', input);

  const invocation = await createInvocation(args.db, args.workspaceId, null, {
    input: args.data.input,
    caller_id: args.data.caller_id,
    caller_name: args.data.caller_name,
  });

  const placement = await claimSpawnNode(args.db, args.workspaceId, {
    actionName: 'spawn',
    input,
    callerId: args.data.caller_id,
    preferredNodeId: args.targetNodeId,
  });
  const nodeId = placement.node.id;

  // A registered `spawn:<harness>` action shadows native capacity on this node.
  // Capacity-direct delegation (ctx.spawnAgent) bypasses the shadow so a handler
  // that delegates cannot re-enter itself.
  if (!args.bypassShadow) {
    const shadow = await fetchNodeAction(args.db, args.workspaceId, nodeId, capability);
    if (shadow && shadow.handlerProvider) {
      if (!placement.queued) await releaseNodeCapacity(args.db, args.workspaceId, nodeId);
      const dispatched = await dispatchNodeProviderInvocation({
        db: args.db,
        registry: args.registry,
        workspaceId: args.workspaceId,
        invocationId: invocation.id,
        nodeId,
        providerName: shadow.handlerProvider,
        action: capability,
        input,
        queue: shadow.queue,
      });
      return spawnResult(invocation, nodeId, dispatched);
    }
  }

  const capProvider = (await capacityProviderName(args.db, args.workspaceId, nodeId, capability)) ?? DEFAULT_PROVIDER_NAME;
  const dispatched = await dispatchNodeInvocation({
    db: args.db,
    registry: args.registry,
    workspaceId: args.workspaceId,
    invocationId: invocation.id,
    nodeId,
    providerName: capProvider,
    action: capability,
    input,
    pending: placement.queued,
    reservationHeld: !placement.queued,
  });
  return spawnResult(invocation, nodeId, dispatched);
}

/**
 * Capacity-direct spawn used by handler-context `ctx.spawnAgent`: it targets a
 * node's capacity executor and never re-enters action dispatch, so a
 * `spawn:<harness>` shadow handler that delegates cannot recurse into itself.
 */
export async function dispatchCapacitySpawn(
  db: Db,
  workspaceId: string,
  data: { input?: Record<string, unknown>; caller_id?: string; caller_name?: string; target_node_id?: string },
  options: { nodeConnections?: NodeConnectionRegistry } = {},
) {
  return dispatchSpawn({
    db,
    registry: options.nodeConnections,
    workspaceId,
    data,
    targetNodeId: data.target_node_id,
    bypassShadow: true,
  });
}

/**
 * Invoke a node-addressed action: `POST /v1/nodes/:node/actions/:name/invoke`.
 * Resolves capability -> provider -> socket on the given node. A `spawn:*` name
 * with no shadow action falls through to native capacity on that node.
 */
export async function invokeNodeAction(
  db: Db,
  workspaceId: string,
  nodeId: string,
  actionName: string,
  data: {
    input?: Record<string, unknown>;
    caller_id?: string;
    caller_name?: string;
  },
  options: { nodeConnections?: NodeConnectionRegistry } = {},
) {
  if (!options.nodeConnections) {
    throw codedError('Node dispatch is not available', 'node_dispatch_unavailable', 503);
  }
  const action = await fetchNodeAction(db, workspaceId, nodeId, actionName);
  if (!action) {
    if (isSpawnInvocation(actionName)) {
      // Carry the harness from the URL (`spawn:<harness>`) into placement so the
      // native fallback targets the right capacity even when the body omits it.
      const harness = actionName.startsWith('spawn:') ? actionName.slice('spawn:'.length) : undefined;
      const spawnInput = harness ? { ...(data.input ?? {}), capability: harness } : data.input;
      return dispatchSpawn({ db, registry: options.nodeConnections, workspaceId, data: { ...data, input: spawnInput }, targetNodeId: nodeId });
    }
    if (isReleaseInvocation(actionName)) {
      return dispatchRelease({ db, registry: options.nodeConnections, workspaceId, data });
    }
    throw codedError(`Action "${actionName}" not found on node`, 'action_not_found', 404);
  }

  if (action.availableTo && action.availableTo.length > 0) {
    if (!data.caller_name || !action.availableTo.includes(data.caller_name)) {
      const who = data.caller_name ? `Agent "${data.caller_name}"` : 'Caller';
      throw codedError(`${who} is not authorized to invoke action "${actionName}"`, 'action_denied', 403);
    }
  }

  const invocation = await createInvocation(db, workspaceId, action, {
    input: data.input,
    caller_id: data.caller_id,
    caller_name: data.caller_name,
  });
  const providerName = action.handlerProvider ?? DEFAULT_PROVIDER_NAME;
  const reservedNode = isSpawnInvocation(action.name)
    ? await reserveNodeCapacity(db, workspaceId, nodeId)
    : null;
  const dispatched = await dispatchNodeProviderInvocation({
    db,
    registry: options.nodeConnections,
    workspaceId,
    invocationId: invocation.id,
    nodeId,
    providerName,
    action: action.name,
    input: recordInput(invocation.input),
    queue: action.queue,
    reservationHeld: !!reservedNode,
  });
  return {
    invocation_id: invocation.id,
    action_name: actionName,
    handler_agent_id: null,
    handler_node_id: nodeId,
    dispatched_node_id: dispatched.accepted ? nodeId : null,
    input: recordInput(invocation.input),
    status: dispatched.accepted ? (dispatched.pending ? 'pending' : 'dispatched') : 'pending',
    created_at: invocation.createdAt.toISOString(),
  };
}

export async function invokeAction(
  db: Db,
  workspaceId: string,
  actionName: string,
  data: {
    input?: Record<string, unknown>;
    caller_id?: string;
    caller_name?: string;
  },
  options: {
    nodeConnections?: NodeConnectionRegistry;
    /** Resolve plain node-scoped actions too (message triggers bind by name
     * without a node); the resolved row is dispatched node-addressed. */
    includeNodeScoped?: boolean;
  } = {},
) {
  const action = await fetchAction(db, workspaceId, actionName, options.includeNodeScoped);

  if (!action && actionName === 'spawn') {
    return dispatchSpawn({
      db,
      registry: options.nodeConnections,
      workspaceId,
      data,
    });
  }

  if (!action && actionName === 'release') {
    return dispatchRelease({
      db,
      registry: options.nodeConnections,
      workspaceId,
      data,
    });
  }

  if (!action) {
    throw codedError(`Action "${actionName}" not found`, 'action_not_found', 404);
  }

  // Check availableTo access control — deny if caller is absent OR not in the list
  if (action.availableTo && action.availableTo.length > 0) {
    if (!data.caller_name || !action.availableTo.includes(data.caller_name)) {
      const who = data.caller_name ? `Agent "${data.caller_name}"` : 'Caller';
      throw codedError(`${who} is not authorized to invoke action "${actionName}"`, 'action_denied', 403);
    }
  }

  if (action.handlerNodeId) {
    if (!options.nodeConnections) {
      throw codedError('Node dispatch is not available', 'node_dispatch_unavailable', 503);
    }
    const invocation = await createInvocation(db, workspaceId, action, {
      input: data.input,
      caller_id: data.caller_id,
      caller_name: data.caller_name,
    });
    // Only mark the reservation held when we actually incremented the node's
    // reserved-capacity counter, so completion/reschedule release stays balanced.
    // If the reservation can't be taken (node offline / at capacity) the queued
    // frame reserves later on drain via the spawnReservedAt check.
    const reservedNode = isSpawnInvocation(action.name)
      ? await reserveNodeCapacity(db, workspaceId, action.handlerNodeId)
      : null;
    const providerName = action.handlerProvider ?? DEFAULT_PROVIDER_NAME;
    // Route through the per-provider liveness gate so an offline provider fails
    // fast unless the capability opted into queue. The synthetic `default`
    // provider keeps the legacy queue-on-offline behavior (broker reconnect
    // resilience), so its aliases queue and drain on reconnect as before.
    const dispatched = await dispatchNodeProviderInvocation({
      db,
      registry: options.nodeConnections,
      workspaceId,
      invocationId: invocation.id,
      nodeId: action.handlerNodeId,
      providerName,
      action: action.name,
      input: recordInput(invocation.input),
      queue: action.queue || providerName === DEFAULT_PROVIDER_NAME,
      reservationHeld: !!reservedNode,
    });
    return {
      invocation_id: invocation.id,
      action_name: actionName,
      handler_agent_id: null,
      handler_node_id: action.handlerNodeId,
      dispatched_node_id: dispatched.accepted ? action.handlerNodeId : null,
      input: recordInput(invocation.input),
      status: dispatched.accepted ? (dispatched.pending ? 'pending' : 'dispatched') : 'pending',
      created_at: invocation.createdAt.toISOString(),
    };
  }

  if (!action.handlerAgentId) {
    throw codedError(`Action "${actionName}" has no handler`, 'handler_unavailable', 503);
  }

  if (!options.nodeConnections) {
    throw codedError('Node dispatch is not available', 'node_dispatch_unavailable', 503);
  }
  const [handlerAgent] = await db
    .select({
      id: agents.id,
      name: agents.name,
      locationType: agents.locationType,
      locationNodeId: agents.locationNodeId,
      providerName: agents.providerName,
    })
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, action.handlerAgentId)));
  if (!handlerAgent || handlerAgent.locationType !== 'via_node' || !handlerAgent.locationNodeId) {
    throw codedError(`Action "${actionName}" handler is not bound to a node`, 'handler_unavailable', 503);
  }

  const invocation = await createInvocation(db, workspaceId, action, {
    input: data.input,
    caller_id: data.caller_id,
    caller_name: data.caller_name,
  });
  const dispatched = await dispatchNodeInvocation({
    db,
    registry: options.nodeConnections,
    workspaceId,
    invocationId: invocation.id,
    nodeId: handlerAgent.locationNodeId,
    providerName: handlerAgent.providerName,
    action: action.name,
    input: recordInput(invocation.input),
    agent: { id: handlerAgent.id, name: handlerAgent.name },
  });

  return {
    invocation_id: invocation.id,
    action_name: actionName,
    handler_agent_id: action.handlerAgentId,
    handler_node_id: handlerAgent.locationNodeId,
    dispatched_node_id: dispatched.accepted ? handlerAgent.locationNodeId : null,
    input: recordInput(invocation.input),
    status: dispatched.accepted ? (dispatched.pending ? 'pending' : 'dispatched') : 'pending',
    created_at: invocation.createdAt.toISOString(),
  };
}

function publicInvocation(row: InvocationRow) {
  return {
    invocation_id: row.id,
    action_name: row.actionName,
    caller_id: row.callerId,
    caller_name: row.callerName,
    input: row.input,
    output: row.output,
    status: row.status,
    error: row.error,
    duration_ms: row.durationMs,
    dispatched_node_id: row.dispatchedNodeId,
    dispatched_at: row.dispatchedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    completed_at: row.completedAt?.toISOString() ?? null,
  };
}

async function applyReleaseCompletionEffect(
  db: Db,
  workspaceId: string,
  nodeId: string,
  invocation: Pick<InvocationRow, 'actionName' | 'input'>,
  data: { error?: string },
): Promise<void> {
  if (!isReleaseInvocation(invocation.actionName) || data.error) return;

  const input = recordInput(invocation.input);
  const name = typeof input.name === 'string' ? input.name : null;
  if (!name) return;

  const [agent] = await db
    .select()
    .from(agents)
    .where(and(
      eq(agents.workspaceId, workspaceId),
      eq(agents.name, name),
      eq(agents.locationType, 'via_node'),
      eq(agents.locationNodeId, nodeId),
    ));
  if (!agent) return;

  // Only proceed if an active binding actually flipped to inactive. This guards
  // against a second release (e.g. a retry) double-decrementing activeAgents for
  // an agent that was already released from this node.
  const [deactivatedBinding] = await db
    .update(agentNodeBindings)
    .set({ status: 'inactive', updatedAt: new Date() })
    .where(and(
      eq(agentNodeBindings.workspaceId, workspaceId),
      eq(agentNodeBindings.nodeId, nodeId),
      eq(agentNodeBindings.agentId, agent.id),
      eq(agentNodeBindings.status, 'active'),
    ))
    .returning({ id: agentNodeBindings.id });
  if (!deactivatedBinding) return;

  await db
    .update(nodes)
    .set({
      activeAgents: sql`CASE WHEN ${nodes.activeAgents} > 0 THEN ${nodes.activeAgents} - 1 ELSE 0 END`,
    })
    .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.id, nodeId)));

  if (input.delete_agent === true) {
    await db.delete(agents).where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, agent.id)));
    return;
  }

  const existingMetadata = agent.metadata ?? {};
  const { spawn: _spawn, cli: _cli, ...restMetadata } = existingMetadata;
  await db
    .update(agents)
    .set({
      status: 'offline',
      // Clear the node location so the agent is no longer routable to the released
      // node and a repeat release can't re-decrement the node's active count.
      locationType: 'self_connected',
      locationNodeId: null,
      lastSeen: new Date(),
      metadata: {
        ...restMetadata,
        release: {
          reason: typeof input.reason === 'string' ? input.reason : null,
          released_at: new Date().toISOString(),
        },
      },
    })
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, agent.id)));
}

async function dispatchNodeAttempt(
  db: Db,
  workspaceId: string,
  invocationId: string,
  nodeId: string,
  opts: {
    pending?: boolean;
    retryAfterAt?: Date | null;
    reservationHeld?: boolean;
    skipIncrementAttempts?: boolean;
  } = {},
) {
  const stateFields = opts.pending
    ? { status: 'pending' as const, dispatchedAt: null, retryAfterAt: opts.retryAfterAt ?? null }
    : dispatchedStateFields({ retryAfterAt: opts.retryAfterAt });
  const attemptFields = opts.skipIncrementAttempts
    ? {}
    : {
      attemptedNodeIds: sql`json_insert(COALESCE(${actionInvocations.attemptedNodeIds}, '[]'), '$[#]', ${nodeId})`,
      dispatchAttempts: sql`COALESCE(${actionInvocations.dispatchAttempts}, 0) + 1`,
    };
  const [updated] = await db
    .update(actionInvocations)
    .set({
      ...stateFields,
      dispatchedNodeId: nodeId,
      spawnReservedAt: opts.reservationHeld ? new Date() : null,
      ...attemptFields,
    })
    .where(and(
      eq(actionInvocations.workspaceId, workspaceId),
      eq(actionInvocations.id, invocationId),
      inArray(actionInvocations.status, OPEN_INVOCATION_STATUSES),
    ))
    .returning();
  return !!updated;
}

/**
 * Transition a drained offline-queue invocation into the live `dispatched` state
 * once its queued `action.invoke` frame is actually delivered on node
 * reconnect/drain. Reuses the same dispatched-state fields as the live dispatch
 * path (stamping `dispatchedAt` and `retryAfterAt`) so the dispatch-timeout sweep
 * and reschedule cover drained invocations. This is the SAME attempt that was
 * queued, so `dispatchAttempts`/`attemptedNodeIds` are intentionally left intact.
 * Guarded on the invocation still being `pending` on this node so a completion or
 * reschedule that raced the drain is never clobbered.
 */
export async function markDrainedInvocationDispatched(
  db: Db,
  workspaceId: string,
  invocationId: string,
  nodeId: string,
): Promise<boolean> {
  const [updated] = await db
    .update(actionInvocations)
    .set(dispatchedStateFields({ retryAfterAt: new Date(Date.now() + ACTION_DISPATCH_TIMEOUT_MS) }))
    .where(and(
      eq(actionInvocations.workspaceId, workspaceId),
      eq(actionInvocations.id, invocationId),
      eq(actionInvocations.dispatchedNodeId, nodeId),
      eq(actionInvocations.status, 'pending'),
    ))
    .returning({ id: actionInvocations.id });
  return !!updated;
}

async function dispatchNodeInvocation(args: {
  db: Db;
  registry: NodeConnectionRegistry;
  workspaceId: string;
  invocationId: string;
  nodeId: string;
  /** When set, route to this provider's socket; otherwise the node default. */
  providerName?: string;
  action: string;
  input: Record<string, unknown>;
  agent?: { id: string; name: string } | null;
  pending?: boolean;
  retryAfterAt?: Date | null;
  reservationHeld?: boolean;
  skipIncrementAttempts?: boolean;
}): Promise<{ accepted: boolean; pending: boolean }> {
  const frame = {
    v: 1 as const,
    type: 'action.invoke' as const,
    invocation_id: args.invocationId,
    action: args.action,
    ...(args.agent ? { agent_id: args.agent.id, agent_name: args.agent.name } : {}),
    input: toFleetWireJson(args.input),
  };
  const connectedBefore = args.providerName
    ? args.registry.isProviderConnected(args.workspaceId, args.nodeId, args.providerName)
    : args.registry.isNodeConnected(args.workspaceId, args.nodeId);
  const sent = args.providerName
    ? await args.registry.sendToProvider(args.workspaceId, args.nodeId, args.providerName, frame)
    : await args.registry.sendToNode(args.workspaceId, args.nodeId, frame);

  if (!sent) return { accepted: false, pending: false };

  const pending = !!args.pending || !connectedBefore;
  const accepted = await dispatchNodeAttempt(
    args.db,
    args.workspaceId,
    args.invocationId,
    args.nodeId,
    {
      pending,
      retryAfterAt: args.retryAfterAt,
      reservationHeld: args.reservationHeld,
      skipIncrementAttempts: args.skipIncrementAttempts,
    },
  );
  return { accepted, pending };
}

function attemptedNodeSet(invocation: Pick<InvocationRow, 'attemptedNodeIds' | 'dispatchedNodeId'>): string[] {
  return Array.from(new Set([
    ...normalizeAttemptedNodeIds(invocation.attemptedNodeIds),
    invocation.dispatchedNodeId,
  ].filter((nodeId): nodeId is string => !!nodeId)));
}

async function selectRetryPlacement(
  db: Db,
  invocation: RetryableInvocationRow,
  excludeNodeIds: string[],
) {
  const input = recordInput(invocation.input);
  if (isSpawnInvocation(invocation.actionName)) {
    return claimSpawnNode(db, invocation.workspaceId, {
      actionName: 'spawn',
      input,
      callerId: invocation.callerId,
      excludeNodeIds,
    });
  }
  return chooseNodeForAction(db, invocation.workspaceId, {
    actionName: invocation.actionName,
    input,
    callerId: invocation.callerId,
    excludeNodeIds,
  });
}

async function targetAgentForInvocation(
  db: Db,
  invocation: Pick<InvocationRow, 'id' | 'workspaceId'>,
): Promise<{ agentId: string; agentName: string; nodeId: string; providerName: string } | null> {
  const [row] = await db
    .select({
      agentId: agents.id,
      agentName: agents.name,
      locationType: agents.locationType,
      nodeId: agents.locationNodeId,
      providerName: agents.providerName,
    })
    .from(actionInvocations)
    .innerJoin(actions, eq(actionInvocations.actionId, actions.id))
    .innerJoin(agents, eq(actions.handlerAgentId, agents.id))
    .where(and(
      eq(actionInvocations.workspaceId, invocation.workspaceId),
      eq(actionInvocations.id, invocation.id),
    ));
  if (!row || row.locationType !== 'via_node' || !row.nodeId) return null;
  return { agentId: row.agentId, agentName: row.agentName, nodeId: row.nodeId, providerName: row.providerName };
}

export async function drainNodeInvocations(
  db: Db,
  registry: NodeConnectionRegistry,
  workspaceId: string,
  nodeId: string,
): Promise<number> {
  const now = new Date();
  const rows = await db
    .select({
      id: actionInvocations.id,
      workspaceId: actionInvocations.workspaceId,
      actionName: actionInvocations.actionName,
      input: actionInvocations.input,
      spawnReservedAt: actionInvocations.spawnReservedAt,
      dispatchedNodeId: actionInvocations.dispatchedNodeId,
      handlerNodeId: actions.handlerNodeId,
      handlerProvider: actions.handlerProvider,
      handlerAgentId: agents.id,
      handlerAgentName: agents.name,
      handlerAgentLocationType: agents.locationType,
      handlerAgentNodeId: agents.locationNodeId,
      handlerAgentProvider: agents.providerName,
    })
    .from(actionInvocations)
    .leftJoin(actions, eq(actionInvocations.actionId, actions.id))
    .leftJoin(agents, eq(actions.handlerAgentId, agents.id))
    .where(and(
      eq(actionInvocations.workspaceId, workspaceId),
      eq(actionInvocations.status, 'pending'),
      or(isNull(actionInvocations.retryAfterAt), lte(actionInvocations.retryAfterAt, now)),
      or(
        eq(actionInvocations.dispatchedNodeId, nodeId),
        eq(actions.handlerNodeId, nodeId),
        and(eq(agents.locationType, 'via_node'), eq(agents.locationNodeId, nodeId)),
      ),
    ))
    .orderBy(asc(actionInvocations.createdAt));

  let drained = 0;
  for (const row of rows) {
    const targetAgent = row.handlerAgentId
      && row.handlerAgentName
      && row.handlerAgentLocationType === 'via_node'
      && row.handlerAgentNodeId
      ? { id: row.handlerAgentId, name: row.handlerAgentName, nodeId: row.handlerAgentNodeId }
      : null;
    const targetNodeId = targetAgent?.nodeId ?? row.handlerNodeId ?? row.dispatchedNodeId;
    if (targetNodeId !== nodeId) continue;

    const input = recordInput(row.input);
    // Resolve the target provider so the offline queue drains per provider. A
    // spawn with a registered shadow re-dispatches to the shadow (no capacity
    // reservation); otherwise native capacity handles it.
    let shadowProvider: string | null = null;
    if (isSpawnInvocation(row.actionName)) {
      const shadow = await fetchNodeAction(db, workspaceId, nodeId, dispatchActionNameForInvocation(row.actionName, input));
      shadowProvider = shadow?.handlerProvider ?? null;
    }
    const providerName = targetAgent
      ? row.handlerAgentProvider ?? DEFAULT_PROVIDER_NAME
      : row.handlerNodeId
        ? row.handlerProvider ?? DEFAULT_PROVIDER_NAME
        : shadowProvider
          ?? (isSpawnInvocation(row.actionName)
            ? (await capacityProviderName(db, workspaceId, nodeId, dispatchActionNameForInvocation(row.actionName, input))) ?? DEFAULT_PROVIDER_NAME
            : DEFAULT_PROVIDER_NAME);
    const nativeSpawn = isSpawnInvocation(row.actionName) && !shadowProvider;

    // Skip draining to a provider that isn't connected yet (e.g. a named
    // provider reconnecting before it re-registers). Dispatching here would mark
    // the frame delivered and push retryAfterAt out by the dispatch timeout,
    // leaving it idle; leave it pending so the post-register drain re-sends it.
    if (!registry.isProviderConnected(workspaceId, nodeId, providerName)) continue;

    let reservedForDrain = false;
    try {
      let reservationHeld = nativeSpawn && !!row.spawnReservedAt;
      if (nativeSpawn && !reservationHeld) {
        const reserved = await reserveNodeCapacity(db, workspaceId, nodeId);
        if (!reserved) {
          const [node] = await db
            .select({
              status: nodes.status,
              handlersLive: nodes.handlersLive,
              lastHeartbeatAt: nodes.lastHeartbeatAt,
            })
            .from(nodes)
            .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.id, nodeId)));
          if (node && isNodeLive(node) && node.handlersLive) {
            await db
              .update(actionInvocations)
              .set({ retryAfterAt: new Date(Date.now() + NODE_DRAIN_REQUEUE_RETRY_MS) })
              .where(and(
                eq(actionInvocations.workspaceId, workspaceId),
                eq(actionInvocations.id, row.id),
                eq(actionInvocations.status, 'pending'),
              ));
          }
          continue;
        }
        reservationHeld = true;
        reservedForDrain = true;
      }

      const dispatched = await dispatchNodeInvocation({
        db,
        registry,
        workspaceId,
        invocationId: row.id,
        nodeId,
        providerName,
        action: dispatchActionNameForInvocation(row.actionName, input),
        input,
        agent: targetAgent ? { id: targetAgent.id, name: targetAgent.name } : null,
        retryAfterAt: new Date(Date.now() + ACTION_DISPATCH_TIMEOUT_MS),
        reservationHeld,
        skipIncrementAttempts: row.dispatchedNodeId === nodeId,
      });
      if (dispatched.accepted) {
        drained++;
      } else if (reservedForDrain) {
        await releaseNodeCapacity(db, workspaceId, nodeId);
      }
    } catch {
      if (reservedForDrain) {
        await releaseNodeCapacity(db, workspaceId, nodeId).catch(() => {});
      }
      // Leave the invocation pending; a later drain or timeout sweep can retry.
    }
  }
  return drained;
}

export async function rescheduleNodeInvocation(
  db: Db,
  registry: NodeConnectionRegistry,
  invocation: RetryableInvocationRow,
  opts: { allowAttemptedFallback?: boolean; retryAfterAt?: Date | null } = {},
) {
  // Only release capacity the invocation actually holds. A shadowed spawn
  // dropped its native reservation at dispatch (spawnReservedAt is null), so it
  // must not release capacity that now belongs to another spawn.
  if (invocation.dispatchedNodeId && isSpawnInvocation(invocation.actionName) && invocation.spawnReservedAt) {
    await releaseNodeCapacity(db, invocation.workspaceId, invocation.dispatchedNodeId);
  }
  // A shadowed spawn stays pinned to its node: while a `spawn:<harness>` shadow
  // is registered there, native capacity for that harness is unreachable — even
  // across a node loss — so it never falls through to generic placement (which
  // would silently bypass the shadow). It re-drains when the provider returns.
  if (invocation.dispatchedNodeId && isSpawnInvocation(invocation.actionName)) {
    const capability = dispatchActionNameForInvocation(invocation.actionName, recordInput(invocation.input));
    const shadow = await fetchNodeAction(db, invocation.workspaceId, invocation.dispatchedNodeId, capability);
    if (shadow) {
      await db
        .update(actionInvocations)
        .set({ status: 'pending', dispatchedAt: null, spawnReservedAt: null, retryAfterAt: null })
        .where(and(
          eq(actionInvocations.workspaceId, invocation.workspaceId),
          eq(actionInvocations.id, invocation.id),
          inArray(actionInvocations.status, OPEN_INVOCATION_STATUSES),
        ));
      return false;
    }
  }
  const targetAgent = await targetAgentForInvocation(db, invocation);
  if (targetAgent) {
    const dispatched = await dispatchNodeInvocation({
      db,
      registry,
      workspaceId: invocation.workspaceId,
      invocationId: invocation.id,
      nodeId: targetAgent.nodeId,
      providerName: targetAgent.providerName,
      action: invocation.actionName,
      input: recordInput(invocation.input),
      agent: { id: targetAgent.agentId, name: targetAgent.agentName },
      retryAfterAt: opts.retryAfterAt ?? null,
    });
    return dispatched.accepted;
  }
  // Release invocations carry no actionId, so targetAgentForInvocation() returns
  // null. They must never fall through to generic node placement, which could
  // route a release to an unrelated node that doesn't own the agent.
  if (isReleaseInvocation(invocation.actionName)) {
    return false;
  }
  const attempted = attemptedNodeSet(invocation);
  const current = invocation.dispatchedNodeId ? [invocation.dispatchedNodeId] : [];
  const input = recordInput(invocation.input);
  const actionToSend = dispatchActionNameForInvocation(invocation.actionName, input);
  const baseExclude = Array.from(new Set([...attempted, ...current]));
  const candidates = opts.allowAttemptedFallback ? [baseExclude, []] : [baseExclude];

  for (const excludeNodeIds of candidates) {
    try {
      const placement = await selectRetryPlacement(db, invocation, excludeNodeIds);
      if (placement.queued) {
        await dispatchNodeAttempt(db, invocation.workspaceId, invocation.id, placement.node.id, {
          pending: true,
          retryAfterAt: opts.retryAfterAt ?? null,
          reservationHeld: false,
        });
        return true;
      }
      const dispatched = await dispatchNodeInvocation({
        db,
        registry,
        workspaceId: invocation.workspaceId,
        invocationId: invocation.id,
        nodeId: placement.node.id,
        action: actionToSend,
        input,
        reservationHeld: isSpawnInvocation(invocation.actionName) && !placement.queued,
      });
      return dispatched.accepted;
    } catch {
      // Try the next candidate set.
    }
  }

  await db
    .update(actionInvocations)
    .set({
      status: 'pending',
      dispatchedNodeId: null,
      dispatchedAt: null,
      spawnReservedAt: null,
      retryAfterAt: opts.retryAfterAt ?? nextRetryAfter(invocation.dispatchAttempts + 1),
    })
    .where(and(
      eq(actionInvocations.workspaceId, invocation.workspaceId),
      eq(actionInvocations.id, invocation.id),
      inArray(actionInvocations.status, OPEN_INVOCATION_STATUSES),
    ));
  return false;
}

export async function rescheduleInvocationsForLostNode(
  db: Db,
  registry: NodeConnectionRegistry,
  workspaceId: string,
  nodeId: string,
) {
  const rows = await db
    .select()
    .from(actionInvocations)
    .where(and(
      eq(actionInvocations.workspaceId, workspaceId),
      eq(actionInvocations.dispatchedNodeId, nodeId),
      inArray(actionInvocations.status, OPEN_INVOCATION_STATUSES),
    ));

  let rescheduled = 0;
  for (const invocation of rows) {
    try {
      if (await rescheduleNodeInvocation(db, registry, invocation, { retryAfterAt: nextRetryAfter(invocation.dispatchAttempts + 1) })) {
        rescheduled++;
      }
    } catch {
      // Keep the invocation pending; another heartbeat/sweep can retry.
      await db
        .update(actionInvocations)
        .set({
          status: 'pending',
          dispatchedNodeId: null,
          dispatchedAt: null,
          spawnReservedAt: null,
          retryAfterAt: nextRetryAfter(invocation.dispatchAttempts + 1),
        })
        .where(eq(actionInvocations.id, invocation.id));
    }
  }
  return rescheduled;
}

export async function completeInvocation(
  db: Db,
  workspaceId: string,
  actionName: string,
  invocationId: string,
  data: {
    output?: unknown;
    error?: string;
    duration_ms?: number;
    caller_agent_id?: string;
  },
) {
  // Fetch the invocation joined with its action — verify action name matches URL param
  const [existing] = await db
    .select({
      id: actionInvocations.id,
      status: actionInvocations.status,
      actionName: actionInvocations.actionName,
      attemptedNodeIds: actionInvocations.attemptedNodeIds,
      dispatchAttempts: actionInvocations.dispatchAttempts,
      dispatchedNodeId: actionInvocations.dispatchedNodeId,
      handlerAgentId: actions.handlerAgentId,
      handlerNodeId: actions.handlerNodeId,
    })
    .from(actionInvocations)
    .leftJoin(actions, eq(actionInvocations.actionId, actions.id))
    .where(
      and(
        eq(actionInvocations.workspaceId, workspaceId),
        eq(actionInvocations.id, invocationId),
        eq(actionInvocations.actionName, actionName),
      ),
    );

  if (!existing) return null;

  if (existing.handlerNodeId || (!existing.handlerAgentId && existing.dispatchedNodeId)) {
    throw codedError('Node-owned invocations must be completed over the node control channel', 'node_owned_invocation', 403);
  }

  // Agent tokens must belong to the handler agent
  if (data.caller_agent_id && existing.handlerAgentId && data.caller_agent_id !== existing.handlerAgentId) {
    throw codedError('Only the handler agent can complete this invocation', 'forbidden', 403);
  }

  const status = data.error ? 'failed' : 'completed';

  const [updated] = await db
    .update(actionInvocations)
    .set({
      output: data.output ?? null,
      error: data.error ?? null,
      status,
      durationMs: data.duration_ms ?? null,
      completedAt: new Date(),
    })
    .where(
      and(
        eq(actionInvocations.workspaceId, workspaceId),
        eq(actionInvocations.id, invocationId),
        eq(actionInvocations.actionName, actionName),
        inArray(actionInvocations.status, OPEN_INVOCATION_STATUSES),
      ),
    )
    .returning();

  if (!updated) return null;

  return publicInvocation(updated);
}

export async function completeNodeInvocation(
  db: Db,
  registry: NodeConnectionRegistry,
  workspaceId: string,
  nodeId: string,
  invocationId: string,
  data: {
    output?: unknown;
    error?: string;
  },
) {
  const [existing] = await db
    .select({
      id: actionInvocations.id,
      workspaceId: actionInvocations.workspaceId,
      actionName: actionInvocations.actionName,
      callerId: actionInvocations.callerId,
      input: actionInvocations.input,
      output: actionInvocations.output,
      status: actionInvocations.status,
      error: actionInvocations.error,
      durationMs: actionInvocations.durationMs,
      dispatchedNodeId: actionInvocations.dispatchedNodeId,
      dispatchedAt: actionInvocations.dispatchedAt,
      spawnReservedAt: actionInvocations.spawnReservedAt,
      attemptedNodeIds: actionInvocations.attemptedNodeIds,
      dispatchAttempts: actionInvocations.dispatchAttempts,
      createdAt: actionInvocations.createdAt,
      completedAt: actionInvocations.completedAt,
    })
    .from(actionInvocations)
    .where(and(eq(actionInvocations.workspaceId, workspaceId), eq(actionInvocations.id, invocationId)));

  if (!existing) return null;

  if (existing.dispatchedNodeId && existing.dispatchedNodeId !== nodeId) {
    return null;
  }

  if (existing.status === 'completed' || existing.status === 'failed') {
    return null;
  }

  if (data.error === 'handler_unavailable') {
    await db
      .update(nodes)
      .set({ handlersLive: false })
      .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.id, nodeId)));
    try {
      if (await rescheduleNodeInvocation(db, registry, existing, { retryAfterAt: nextRetryAfter(existing.dispatchAttempts + 1) })) {
        return null;
      }
    } catch {
      // Fall through and fail the invocation if no eligible node exists.
    }
  }

  const [updated] = await db
    .update(actionInvocations)
    .set({
      output: data.output ?? null,
      error: data.error ?? null,
      status: data.error ? 'failed' : 'completed',
      completedAt: new Date(),
      spawnReservedAt: null,
    })
    .where(and(
      eq(actionInvocations.workspaceId, workspaceId),
      eq(actionInvocations.id, invocationId),
      eq(actionInvocations.dispatchedNodeId, nodeId),
      inArray(actionInvocations.status, OPEN_INVOCATION_STATUSES),
    ))
    .returning();

  // Release only capacity this invocation actually reserved. A shadowed spawn
  // holds no native reservation (spawnReservedAt is null), so releasing here
  // would decrement capacity owned by another spawn.
  if (updated && isSpawnInvocation(updated.actionName) && updated.dispatchedNodeId && existing.spawnReservedAt) {
    await releaseNodeCapacity(db, workspaceId, updated.dispatchedNodeId);
  }

  if (updated) {
    await applyReleaseCompletionEffect(db, workspaceId, nodeId, existing, data);
  }

  return updated ? publicInvocation(updated) : null;
}

export async function sweepTimedOutInvocations(
  db: Db,
  registry: NodeConnectionRegistry,
  opts: SweepTimedOutInvocationsOptions | number | null = {},
) {
  const timeoutMs = typeof opts === 'number' ? opts : opts?.timeoutMs ?? ACTION_DISPATCH_TIMEOUT_MS;
  const now = new Date();
  const cutoff = new Date(Date.now() - timeoutMs);
  const rows = await db
    .select()
    .from(actionInvocations)
    .where(and(
      inArray(actionInvocations.status, ['dispatched']),
      lte(actionInvocations.dispatchedAt, cutoff),
    ));

  const pendingRows = await db
    .select()
    .from(actionInvocations)
    .where(and(
      eq(actionInvocations.status, 'pending'),
      lte(actionInvocations.retryAfterAt, now),
    ));

  let rescheduled = 0;
  for (const invocation of [...rows, ...pendingRows]) {
    try {
      const allowFallback = invocation.status === 'pending';
      if (await rescheduleNodeInvocation(db, registry, invocation, {
        allowAttemptedFallback: allowFallback,
        retryAfterAt: allowFallback ? null : nextRetryAfter(invocation.dispatchAttempts + 1),
      })) {
        rescheduled++;
      }
    } catch {
      // Leave the invocation for the next sweep.
    }
  }
  return rescheduled;
}

export async function getInvocation(db: Db, workspaceId: string, actionName: string, invocationId: string) {
  const [row] = await db
    .select()
    .from(actionInvocations)
    .where(
      and(
        eq(actionInvocations.workspaceId, workspaceId),
        eq(actionInvocations.id, invocationId),
        eq(actionInvocations.actionName, actionName),
      ),
    );

  if (!row) return null;
  return publicInvocation(row);
}
