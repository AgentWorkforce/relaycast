import { and, eq, inArray, lte } from 'drizzle-orm';
import type { FleetWireJsonValue } from '@relaycast/types';
import type { getDb } from '../db/index.js';
import { actions, actionInvocations, agents, nodes } from '../db/schema.js';
import { generateId } from './snowflake.js';
import { codedError } from '../lib/httpError.js';
import type { NodeConnectionRegistry } from '../ports/realtime.js';
import { chooseNodeForAction } from './placement.js';

type Db = ReturnType<typeof getDb>;
type ActionRow = typeof actions.$inferSelect;
type InvocationRow = typeof actionInvocations.$inferSelect;

const OPEN_INVOCATION_STATUSES = ['pending', 'dispatched', 'invoked'];
export const ACTION_DISPATCH_TIMEOUT_MS = 30_000;

function capabilityName(capability: string | { name?: string } | null | undefined): string | null {
  if (typeof capability === 'string') return capability;
  if (capability && typeof capability.name === 'string') return capability.name;
  return null;
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

function toFleetWireJson(value: unknown): FleetWireJsonValue {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(toFleetWireJson);
  if (value && typeof value === 'object') {
    const out: Record<string, FleetWireJsonValue> = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = toFleetWireJson(nested);
    }
    return out;
  }
  return null;
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

async function fetchAction(db: Db, workspaceId: string, actionName: string): Promise<ActionRow | null> {
  const [action] = await db
    .select()
    .from(actions)
    .where(
      and(
        eq(actions.workspaceId, workspaceId),
        eq(actions.name, actionName),
        eq(actions.isActive, true),
      ),
    );
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
      actionName: action?.name ?? 'spawn',
      callerId: data.caller_id ?? null,
      callerName: data.caller_name ?? null,
      input: data.input ?? {},
      status: data.status ?? 'pending',
    })
    .returning();
  return invocation;
}

async function dispatchNodeInvocation(args: {
  db: Db;
  registry: NodeConnectionRegistry;
  workspaceId: string;
  invocationId: string;
  nodeId: string;
  action: string;
  input: Record<string, unknown>;
}) {
  const sent = await args.registry.sendToNode(args.workspaceId, args.nodeId, {
    v: 1,
    type: 'action.invoke',
    invocation_id: args.invocationId,
    action: args.action,
    input: toFleetWireJson(args.input),
  });

  if (!sent) return false;

  await args.db
    .update(actionInvocations)
    .set({
      status: 'dispatched',
      dispatchedNodeId: args.nodeId,
      dispatchedAt: new Date(),
    })
    .where(and(
      eq(actionInvocations.workspaceId, args.workspaceId),
      eq(actionInvocations.id, args.invocationId),
      inArray(actionInvocations.status, OPEN_INVOCATION_STATUSES),
    ));
  return true;
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
}) {
  if (!args.registry) {
    throw codedError('Node dispatch is not available', 'node_dispatch_unavailable', 503);
  }

  const placement = await chooseNodeForAction(args.db, args.workspaceId, {
    actionName: 'spawn',
    input: args.data.input,
    callerId: args.data.caller_id,
  });
  const invocation = await createInvocation(args.db, args.workspaceId, null, {
    input: args.data.input,
    caller_id: args.data.caller_id,
    caller_name: args.data.caller_name,
  });

  const dispatched = await dispatchNodeInvocation({
    db: args.db,
    registry: args.registry,
    workspaceId: args.workspaceId,
    invocationId: invocation.id,
    nodeId: placement.node.id,
    action: placement.capability,
    input: recordInput(invocation.input),
  });

  return {
    invocation_id: invocation.id,
    action_name: 'spawn',
    handler_agent_id: null,
    handler_node_id: placement.node.id,
    dispatched_node_id: dispatched ? placement.node.id : null,
    input: recordInput(invocation.input),
    status: dispatched ? 'dispatched' : 'pending',
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
  } = {},
) {
  const action = await fetchAction(db, workspaceId, actionName);

  if (!action && actionName === 'spawn') {
    return dispatchSpawn({
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
    const dispatched = await dispatchNodeInvocation({
      db,
      registry: options.nodeConnections,
      workspaceId,
      invocationId: invocation.id,
      nodeId: action.handlerNodeId,
      action: action.name,
      input: recordInput(invocation.input),
    });
    return {
      invocation_id: invocation.id,
      action_name: actionName,
      handler_agent_id: null,
      handler_node_id: action.handlerNodeId,
      dispatched_node_id: dispatched ? action.handlerNodeId : null,
      input: recordInput(invocation.input),
      status: dispatched ? 'dispatched' : 'pending',
      created_at: invocation.createdAt.toISOString(),
    };
  }

  if (!action.handlerAgentId) {
    throw codedError(`Action "${actionName}" has no handler`, 'handler_unavailable', 503);
  }

  const invocation = await createInvocation(db, workspaceId, action, {
    input: data.input,
    caller_id: data.caller_id,
    caller_name: data.caller_name,
    status: 'dispatched',
  });

  return {
    invocation_id: invocation.id,
    action_name: actionName,
    handler_agent_id: action.handlerAgentId,
    handler_node_id: null,
    dispatched_node_id: null,
    input: recordInput(invocation.input),
    status: invocation.status,
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

export async function completeInvocation(
  db: Db,
  workspaceId: string,
  actionName: string,
  invocationId: string,
  data: {
    output?: Record<string, unknown>;
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

  if (existing.handlerNodeId || existing.dispatchedNodeId) {
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

  // No rows updated means either not found or already completed by a concurrent request
  if (!updated) return null;

  return publicInvocation(updated);
}

async function rescheduleNodeInvocation(
  db: Db,
  registry: NodeConnectionRegistry,
  invocation: InvocationRow,
) {
  const input = recordInput(invocation.input);
  const placement = await chooseNodeForAction(db, invocation.workspaceId, {
    actionName: invocation.actionName,
    input,
    callerId: invocation.callerId,
  });
  if (placement.node.id === invocation.dispatchedNodeId && invocation.dispatchedNodeId) {
    return false;
  }
  const actionToSend = invocation.actionName === 'spawn' ? placement.capability : invocation.actionName;
  return dispatchNodeInvocation({
    db,
    registry,
    workspaceId: invocation.workspaceId,
    invocationId: invocation.id,
    nodeId: placement.node.id,
    action: actionToSend,
    input,
  });
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
      if (await rescheduleNodeInvocation(db, registry, invocation)) {
        rescheduled++;
      }
    } catch {
      // Keep the invocation pending; another heartbeat/sweep can retry.
      await db
        .update(actionInvocations)
        .set({ status: 'pending' })
        .where(eq(actionInvocations.id, invocation.id));
    }
  }
  return rescheduled;
}

export async function completeNodeInvocation(
  db: Db,
  registry: NodeConnectionRegistry,
  workspaceId: string,
  nodeId: string,
  invocationId: string,
  data: {
    output?: Record<string, unknown>;
    error?: string;
  },
) {
  const [existing] = await db
    .select({
      id: actionInvocations.id,
      workspaceId: actionInvocations.workspaceId,
      actionId: actionInvocations.actionId,
      actionName: actionInvocations.actionName,
      callerId: actionInvocations.callerId,
      callerName: actionInvocations.callerName,
      input: actionInvocations.input,
      output: actionInvocations.output,
      status: actionInvocations.status,
      error: actionInvocations.error,
      durationMs: actionInvocations.durationMs,
      dispatchedNodeId: actionInvocations.dispatchedNodeId,
      dispatchedAt: actionInvocations.dispatchedAt,
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
      if (await rescheduleNodeInvocation(db, registry, existing)) {
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
    })
    .where(and(
      eq(actionInvocations.workspaceId, workspaceId),
      eq(actionInvocations.id, invocationId),
      eq(actionInvocations.dispatchedNodeId, nodeId),
      inArray(actionInvocations.status, OPEN_INVOCATION_STATUSES),
    ))
    .returning();

  return updated ? publicInvocation(updated) : null;
}

export async function sweepTimedOutInvocations(
  db: Db,
  registry: NodeConnectionRegistry,
  timeoutMs = ACTION_DISPATCH_TIMEOUT_MS,
) {
  const cutoff = new Date(Date.now() - timeoutMs);
  const rows = await db
    .select()
    .from(actionInvocations)
    .where(and(
      inArray(actionInvocations.status, ['dispatched']),
      lte(actionInvocations.dispatchedAt, cutoff),
    ));

  let rescheduled = 0;
  for (const invocation of rows) {
    try {
      if (await rescheduleNodeInvocation(db, registry, invocation)) {
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
