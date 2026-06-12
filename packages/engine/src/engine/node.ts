import { and, eq, inArray } from 'drizzle-orm';
import type {
  FleetAgentRegisterMessage,
  FleetBrokerToRelaycastMessage,
  FleetInventoryAgent,
  FleetNodeHeartbeatMessage,
  FleetNodeRegisterMessage,
} from '@relaycast/types';
import { parseFleetBrokerToRelaycastMessage } from '@relaycast/types';
import type { getDb } from '../db/index.js';
import { actionInvocations, actions, agents, channelMembers, channels, nodes } from '../db/schema.js';
import { randomHex, sha256Hex } from '../lib/crypto.js';
import { codedError } from '../lib/httpError.js';
import { runAtomic } from '../ports/database.js';
import type { NodeConnectionRegistry } from '../ports/realtime.js';
import { generateId } from './snowflake.js';
import { isNodeLive } from './placement.js';
import { completeNodeInvocation, rescheduleInvocationsForLostNode } from './action.js';

type Db = ReturnType<typeof getDb>;
type NodeRow = typeof nodes.$inferSelect;

interface NodeSocketLike {
  send(data: string): void;
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

async function ensureCapabilityActions(db: Db, workspaceId: string, nodeId: string, capabilities: string[]) {
  for (const capability of capabilities) {
    if (!capability || capability.startsWith('spawn:')) continue;
    const [existing] = await db
      .select()
      .from(actions)
      .where(and(eq(actions.workspaceId, workspaceId), eq(actions.name, capability)));
    if (!existing) {
      await db.insert(actions).values({
        id: `act_${generateId()}`,
        workspaceId,
        name: capability,
        description: `Node handler ${capability}`,
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
    capabilities?: string[];
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
        capabilities: data.capabilities ?? existing.capabilities,
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
      capabilities: data.capabilities ?? [],
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
    const [existing] = await tx
      .select()
      .from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), eq(agents.name, message.name)));

    if (
      existing &&
      existing.status === 'active' &&
      (existing.locationType !== 'via_node' || existing.locationNodeId !== nodeId)
    ) {
      throw codedError(`Agent "${message.name}" already has an active location`, 'agent_location_conflict', 409);
    }

    const token = `at_live_${randomHex(16)}`;
    const tokenHash = await sha256Hex(token);
    const metadata = {
      ...(existing?.metadata ?? {}),
      fleet: {
        node_id: nodeId,
        invocation_id: message.invocation_id ?? null,
        registered_at: new Date().toISOString(),
      },
    };

    if (existing) {
      const [updated] = await tx
        .update(agents)
        .set({
          tokenHash,
          status: 'active',
          lastSeen: new Date(),
          metadata,
          locationType: 'via_node',
          locationNodeId: nodeId,
          originNodeId: existing.originNodeId ?? nodeId,
          resumable: message.resumable ?? false,
          sessionRef: message.session_ref ?? null,
        })
        .where(eq(agents.id, existing.id))
        .returning();
      return {
        agent_id: updated.id,
        name: updated.name,
        token,
        invocation_id: message.invocation_id ?? null,
        session_ref: updated.sessionRef,
      };
    }

    const agentId = generateId();
    const [created] = await tx
      .insert(agents)
      .values({
        id: agentId,
        workspaceId,
        name: message.name,
        handle: `@${message.name}`,
        type: 'agent',
        tokenHash,
        status: 'active',
        persona: null,
        metadata,
        locationType: 'via_node',
        locationNodeId: nodeId,
        originNodeId: nodeId,
        resumable: message.resumable ?? false,
        sessionRef: message.session_ref ?? null,
      })
      .returning();

    await autoJoinGeneral(tx, workspaceId, agentId);
    return {
      agent_id: created.id,
      name: created.name,
      token,
      invocation_id: message.invocation_id ?? null,
      session_ref: created.sessionRef,
    };
  });
}

export async function deregisterAgentViaNode(
  db: Db,
  workspaceId: string,
  nodeId: string,
  name: string,
) {
  const [updated] = await db
    .update(agents)
    .set({ status: 'offline', lastSeen: new Date() })
    .where(and(
      eq(agents.workspaceId, workspaceId),
      eq(agents.name, name),
      eq(agents.locationType, 'via_node'),
      eq(agents.locationNodeId, nodeId),
    ))
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
    .filter((node) => !filters.capability || node.capabilities.includes(filters.capability))
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
      type: 'error',
      code: 'invalid_message',
      message: err instanceof Error ? err.message : 'Invalid node control message',
    });
    return;
  }

  try {
    switch (message.type) {
      case 'node.register': {
        const registered = await registerNode(args.db, args.workspaceId, args.nodeId, message);
        sendControl(args.socket, { v: 1, type: 'node.registered', node_id: registered.id });
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
        sendControl(args.socket, { v: 1, type: 'agent.registered', ...registered });
        return;
      }
      case 'agent.deregister':
        await deregisterAgentViaNode(args.db, args.workspaceId, args.nodeId, message.name);
        return;
      case 'inventory.sync': {
        const result = await reconcileInventory(args.db, args.workspaceId, args.nodeId, message.agents);
        sendControl(args.socket, { v: 1, type: 'inventory.synced', ...result });
        return;
      }
      case 'action.result':
        await completeNodeInvocation(args.db, args.registry, args.workspaceId, args.nodeId, message.invocation_id, {
          ...(Object.prototype.hasOwnProperty.call(message, 'output') ? { output: asObject(message.output) } : {}),
          ...(message.error ? { error: message.error } : {}),
        });
        return;
      case 'delivery.ack':
        return;
    }
  } catch (err) {
    const error = err as Error & { code?: string };
    sendControl(args.socket, {
      v: 1,
      type: `${message.type}.failed`,
      code: error.code ?? 'node_control_failed',
      message: error.message,
    });
  }
}
