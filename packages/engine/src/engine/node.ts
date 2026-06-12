import { and, eq, inArray, ne, or, sql } from 'drizzle-orm';
import type {
  FleetAgentRegisterMessage,
  FleetBrokerToRelaycastMessage,
  FleetInventoryAgent,
  FleetNodeHeartbeatMessage,
  FleetNodeRegisterMessage,
  FleetCapability,
} from '@relaycast/types';
import { parseFleetBrokerToRelaycastMessage } from '@relaycast/types';
import type { getDb } from '../db/index.js';
import { actionInvocations, actions, agents, channelMembers, channels, nodes } from '../db/schema.js';
import { randomHex, sha256Hex } from '../lib/crypto.js';
import { codedError } from '../lib/httpError.js';
import { runAtomic } from '../ports/database.js';
import type { NodeConnectionRegistry } from '../ports/realtime.js';
import { generateId } from './snowflake.js';
import { isNodeLive, nodeHasCapability } from './placement.js';
import { completeNodeInvocation, rescheduleInvocationsForLostNode } from './action.js';
import { emitInvocationCompletionEffects } from './invocationCompletion.js';
import type { InvocationCompletionDeps } from './invocationCompletion.js';

type Db = ReturnType<typeof getDb>;
type NodeRow = typeof nodes.$inferSelect;

interface NodeSocketLike {
  send(data: string): void;
}

type CapabilityLike = string | FleetCapability;

function capabilityName(capability: CapabilityLike | null | undefined): string | null {
  if (typeof capability === 'string') return capability;
  return capability?.name ?? null;
}

function normalizeCapabilities(capabilities: CapabilityLike[]): FleetCapability[] {
  return capabilities.map((capability) => (
    typeof capability === 'string' ? { name: capability } : capability
  ));
}

function requestId(message: { id?: string }): string {
  return message.id ?? generateId();
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { value };
}

function publicNode(row: NodeRow) {
  const live = isNodeLive(row);
  return {
    id: row.id,
    name: row.name,
    capabilities: row.capabilities,
    tags: row.tags,
    version: row.version,
    status: live ? 'online' : 'offline',
    live,
    handlers_live: live && row.handlersLive,
    load: row.load,
    active_agents: row.activeAgents,
    max_agents: row.maxAgents,
    last_heartbeat_at: row.lastHeartbeatAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  };
}

async function ensureCapabilityActions(db: Db, workspaceId: string, nodeId: string, capabilities: CapabilityLike[]) {
  for (const capability of capabilities) {
    const name = capabilityName(capability);
    if (!name || name.startsWith('spawn:')) continue;
    const [existing] = await db
      .select()
      .from(actions)
      .where(and(eq(actions.workspaceId, workspaceId), eq(actions.name, name)));
    if (!existing) {
      await db.insert(actions).values({
        id: `act_${generateId()}`,
        workspaceId,
        name,
        description: `Node handler ${name}`,
        handlerAgentId: null,
        handlerNodeId: nodeId,
        inputSchema: {},
        outputSchema: {},
        availableTo: null,
      });
    } else if (!existing.handlerAgentId && (!existing.handlerNodeId || existing.handlerNodeId === nodeId)) {
      await db
        .update(actions)
        .set({ handlerNodeId: nodeId, isActive: true })
        .where(eq(actions.id, existing.id));
    }
  }
}

export async function createNodeToken(
  db: Db,
  workspaceId: string,
  data: {
    node_id?: string;
    name: string;
    capabilities?: CapabilityLike[];
    max_agents?: number;
    tags?: string[];
    version?: string;
  },
) {
  const token = `nt_live_${randomHex(24)}`;
  const tokenHash = await sha256Hex(token);
  const existing = await getNodeByName(db, workspaceId, data.name);
  const now = new Date();

  if (existing) {
    const [updated] = await db
      .update(nodes)
      .set({
        tokenHash,
        capabilities: normalizeCapabilities(data.capabilities ?? existing.capabilities),
        maxAgents: data.max_agents ?? existing.maxAgents,
        tags: data.tags ?? existing.tags,
        version: data.version ?? existing.version,
        status: 'offline',
        handlersLive: false,
      })
      .where(eq(nodes.id, existing.id))
      .returning();
    return { ...publicNode(updated), token };
  }

  const [created] = await db
    .insert(nodes)
    .values({
      id: data.node_id ?? `node_${generateId()}`,
      workspaceId,
      name: data.name,
      tokenHash,
      capabilities: normalizeCapabilities(data.capabilities ?? []),
      maxAgents: data.max_agents ?? 0,
      tags: data.tags ?? [],
      version: data.version ?? 'unknown',
      status: 'offline',
      handlersLive: false,
      load: 0,
      activeAgents: 0,
      createdAt: now,
    })
    .returning();
  return { ...publicNode(created), token };
}

export async function getNodeByTokenHash(db: Db, tokenHash: string) {
  const [node] = await db.select().from(nodes).where(eq(nodes.tokenHash, tokenHash));
  return node ?? null;
}

export async function getNodeByName(db: Db, workspaceId: string, name: string) {
  const normalized = name.startsWith('#') ? name.slice(1) : name;
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.name, normalized)));
  return node ?? null;
}

export async function registerNode(
  db: Db,
  workspaceId: string,
  authenticatedNodeId: string,
  message: FleetNodeRegisterMessage,
) {
  if (message.node_id !== authenticatedNodeId) {
    throw codedError('node_id does not match the authenticated node token', 'node_id_mismatch', 403);
  }

  const now = new Date();
  const [existingByName] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.name, message.name)));

  if (existingByName && existingByName.id !== authenticatedNodeId) {
    throw codedError(`Node name "${message.name}" is already enrolled`, 'node_name_conflict', 409);
  }

  const [updated] = await db
    .update(nodes)
    .set({
      name: message.name,
      capabilities: message.capabilities,
      maxAgents: message.max_agents,
      tags: message.tags,
      version: message.version,
      status: 'online',
      handlersLive: message.capabilities.length > 0,
      lastHeartbeatAt: now,
    })
    .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.id, authenticatedNodeId)))
    .returning();

  if (!updated) {
    throw codedError('Node token is not enrolled in this workspace', 'node_not_found', 404);
  }

  await ensureCapabilityActions(db, workspaceId, updated.id, message.capabilities);
  return publicNode(updated);
}

export async function heartbeatNode(
  db: Db,
  workspaceId: string,
  nodeId: string,
  message: FleetNodeHeartbeatMessage,
) {
  const [updated] = await db
    .update(nodes)
    .set({
      status: 'online',
      load: message.load,
      activeAgents: message.active_agents,
      handlersLive: message.handlers_live,
      lastHeartbeatAt: new Date(),
    })
    .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.id, nodeId)))
    .returning();
  return updated ? publicNode(updated) : null;
}

export async function markNodeOffline(
  db: Db,
  registry: NodeConnectionRegistry,
  workspaceId: string,
  nodeId: string,
) {
  await db
    .update(nodes)
    .set({
      status: 'offline',
      handlersLive: false,
      load: 0,
      activeAgents: 0,
      lastHeartbeatAt: new Date(),
    })
    .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.id, nodeId)));

  await db
    .update(agents)
    .set({ status: 'offline', lastSeen: new Date() })
    .where(and(
      eq(agents.workspaceId, workspaceId),
      eq(agents.locationType, 'via_node'),
      eq(agents.locationNodeId, nodeId),
    ));

  await rescheduleInvocationsForLostNode(db, registry, workspaceId, nodeId);
}

export async function deregisterNode(
  db: Db,
  registry: NodeConnectionRegistry,
  workspaceId: string,
  nodeId: string,
) {
  await markNodeOffline(db, registry, workspaceId, nodeId);
}

export async function sweepOfflineNodes(db: Db, registry: NodeConnectionRegistry): Promise<number> {
  const rows = await db.select().from(nodes).where(eq(nodes.status, 'online'));
  const stale = rows.filter((node) => !isNodeLive(node));
  for (const node of stale) {
    await markNodeOffline(db, registry, node.workspaceId, node.id);
  }
  return stale.length;
}

async function autoJoinGeneral(db: Db, workspaceId: string, agentId: string) {
  const [generalChannel] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.workspaceId, workspaceId), eq(channels.name, 'general')));
  if (generalChannel) {
    await db.insert(channelMembers).values({
      channelId: generalChannel.id,
      agentId,
      role: 'member',
    }).onConflictDoNothing();
  }
}

export async function registerAgentViaNode(
  db: Db,
  workspaceId: string,
  nodeId: string,
  message: FleetAgentRegisterMessage,
) {
  return runAtomic(db, async (tx) => {
    const token = `at_live_${randomHex(16)}`;
    const tokenHash = await sha256Hex(token);
    const now = new Date().toISOString();
    const fleetMetadata = sql`json_object(
      'node_id', ${nodeId},
      'invocation_id', ${message.invocation_id ?? null},
      'registered_at', ${now}
    )`;
    const [result] = await tx
      .insert(agents)
      .values({
        id: generateId(),
        workspaceId,
        name: message.name,
        handle: `@${message.name}`,
        type: 'agent',
        tokenHash,
        status: 'active',
        persona: null,
        metadata: { fleet: { node_id: nodeId, invocation_id: message.invocation_id ?? null, registered_at: now } },
        locationType: 'via_node',
        locationNodeId: nodeId,
        originNodeId: nodeId,
        resumable: message.resumable ?? false,
        sessionRef: message.session_ref ?? null,
      })
      .onConflictDoUpdate({
        target: [agents.workspaceId, agents.name],
        set: {
          tokenHash,
          status: 'active',
          lastSeen: new Date(),
          metadata: sql`json_patch(COALESCE(${agents.metadata}, '{}'), ${fleetMetadata})`,
          locationType: 'via_node',
          locationNodeId: nodeId,
          originNodeId: sql`COALESCE(${agents.originNodeId}, ${nodeId})`,
          resumable: message.resumable ?? false,
          sessionRef: message.session_ref ?? null,
        },
        setWhere: or(
          ne(agents.status, 'active'),
          and(eq(agents.locationType, 'via_node'), eq(agents.locationNodeId, nodeId)),
        ),
      })
      .returning();

    if (!result) {
      throw codedError(`Agent "${message.name}" already has an active location`, 'agent_location_conflict', 409);
    }

    await autoJoinGeneral(tx, workspaceId, result.id);
    return {
      agent_id: result.id,
      name: result.name,
      token,
      invocation_id: message.invocation_id ?? null,
      session_ref: result.sessionRef,
    };
  });
}

export async function deregisterAgentViaNode(
  db: Db,
  workspaceId: string,
  nodeId: string,
  message: { agent_id?: string; name?: string },
) {
  const conditions = [
    eq(agents.workspaceId, workspaceId),
    eq(agents.locationType, 'via_node'),
    eq(agents.locationNodeId, nodeId),
  ];
  if (message.agent_id) {
    conditions.push(eq(agents.id, message.agent_id));
  } else if (message.name) {
    conditions.push(eq(agents.name, message.name));
  } else {
    return null;
  }

  const [updated] = await db
    .update(agents)
    .set({ status: 'offline', lastSeen: new Date() })
    .where(and(...conditions))
    .returning();
  return updated ?? null;
}

export async function reconcileInventory(
  db: Db,
  workspaceId: string,
  nodeId: string,
  inventoryAgents: FleetInventoryAgent[],
) {
  const names = new Set(inventoryAgents.map((agent) => agent.name));
  for (const item of inventoryAgents) {
    const [existing] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), eq(agents.name, item.name)));
    if (!existing) continue;
    await db
      .update(agents)
      .set({
        status: 'active',
        lastSeen: new Date(),
        locationType: 'via_node',
        locationNodeId: nodeId,
        originNodeId: existing.originNodeId ?? nodeId,
        sessionRef: item.session_ref ?? existing.sessionRef,
      })
      .where(eq(agents.id, existing.id));
  }

  const nodeAgents = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(and(
      eq(agents.workspaceId, workspaceId),
      eq(agents.locationType, 'via_node'),
      eq(agents.locationNodeId, nodeId),
      eq(agents.status, 'active'),
    ));
  const missing = nodeAgents.filter((agent) => !names.has(agent.name)).map((agent) => agent.id);
  if (missing.length > 0) {
    await db
      .update(agents)
      .set({ status: 'offline', lastSeen: new Date() })
      .where(inArray(agents.id, missing));
  }

  const openInvocations = await db
    .select({ id: actionInvocations.id })
    .from(actionInvocations)
    .where(and(
      eq(actionInvocations.workspaceId, workspaceId),
      eq(actionInvocations.dispatchedNodeId, nodeId),
      inArray(actionInvocations.status, ['pending', 'dispatched']),
    ));
  return { rebound_agents: inventoryAgents.length, open_invocations: openInvocations.length };
}

export async function listNodes(
  db: Db,
  workspaceId: string,
  filters: { capability?: string; name?: string } = {},
) {
  const rows = await db.select().from(nodes).where(eq(nodes.workspaceId, workspaceId));
  return rows
    .filter((node) => !filters.name || node.name === filters.name)
    .filter((node) => !filters.capability || nodeHasCapability(node, filters.capability))
    .map(publicNode);
}

export async function getPublicNode(db: Db, workspaceId: string, name: string) {
  const node = await getNodeByName(db, workspaceId, name);
  return node ? publicNode(node) : null;
}

function sendControl(socket: NodeSocketLike | undefined, payload: Record<string, unknown>): void {
  if (!socket) return;
  try {
    socket.send(JSON.stringify(payload));
  } catch {
    // The close handler will clean up the socket.
  }
}

export async function handleNodeControlMessage(args: {
  db: Db;
  registry: NodeConnectionRegistry;
  completionDeps?: InvocationCompletionDeps;
  workspaceId: string;
  nodeId: string;
  socket?: NodeSocketLike;
  raw: string;
}) {
  let message: FleetBrokerToRelaycastMessage;
  try {
    message = parseFleetBrokerToRelaycastMessage(JSON.parse(args.raw));
  } catch (err) {
    sendControl(args.socket, {
      v: 1,
      id: generateId(),
      type: 'error',
      ok: false,
      code: 'invalid_message',
      message: err instanceof Error ? err.message : 'Invalid node control message',
    });
    return;
  }

  try {
    switch (message.type) {
      case 'node.register': {
        const registered = await registerNode(args.db, args.workspaceId, args.nodeId, message);
        sendControl(args.socket, {
          v: 1,
          id: requestId(message),
          type: 'reply',
          ok: true,
          data: registered,
        });
        return;
      }
      case 'node.heartbeat':
        await heartbeatNode(args.db, args.workspaceId, args.nodeId, message);
        return;
      case 'node.deregister':
        await deregisterNode(args.db, args.registry, args.workspaceId, args.nodeId);
        return;
      case 'agent.register': {
        const registered = await registerAgentViaNode(args.db, args.workspaceId, args.nodeId, message);
        sendControl(args.socket, {
          v: 1,
          id: requestId(message),
          type: 'reply',
          ok: true,
          data: registered,
        });
        return;
      }
      case 'agent.deregister':
        await deregisterAgentViaNode(args.db, args.workspaceId, args.nodeId, message);
        return;
      case 'inventory.sync': {
        const result = await reconcileInventory(args.db, args.workspaceId, args.nodeId, message.agents);
        sendControl(args.socket, {
          v: 1,
          id: requestId(message),
          type: 'reply',
          ok: true,
          data: result,
        });
        return;
      }
      case 'action.result': {
        const completed = await completeNodeInvocation(args.db, args.registry, args.workspaceId, args.nodeId, message.invocation_id, {
          ...(Object.prototype.hasOwnProperty.call(message, 'output') ? { output: asObject(message.output) } : {}),
          ...(message.error ? { error: message.error } : {}),
        });
        if (completed && args.completionDeps) {
          await emitInvocationCompletionEffects(args.completionDeps, args.workspaceId, completed);
        }
        return;
      }
      case 'delivery.ack':
        return;
    }
  } catch (err) {
    const error = err as Error & { code?: string };
    sendControl(args.socket, {
      v: 1,
      id: requestId(message),
      type: 'error',
      ok: false,
      code: error.code ?? 'node_control_failed',
      message: error.message,
    });
  }
}
