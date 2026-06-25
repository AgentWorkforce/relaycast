import { and, eq, inArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { transformForClient } from './wsTransform.js';
import type { EngineDb } from '../ports/database.js';
import type { NodeConnectionRegistry, RealtimeBus } from '../ports/realtime.js';
import { agents, agentNodeBindings, channelMembers, nodes } from '../db/schema.js';
import { toFleetWireJson } from './deliveryWire.js';

type NodeContextTopic = 'presence' | 'channel' | 'thread';

type NodeContextDeps = {
  db: EngineDb;
  nodeConnections: NodeConnectionRegistry;
  realtime: RealtimeBus;
  workspaceId: string;
};

type ScopedNodeRow = {
  nodeId: string;
  agentId: string;
  nodeKind: string;
};

const DELIVERY_ROUTED_EVENTS = new Set(['message.created', 'thread.reply', 'dm.received', 'group_dm.received']);

function groupByNode(rows: ScopedNodeRow[]): Map<string, { nodeKind: string; agentIds: string[] }> {
  const grouped = new Map<string, { nodeKind: string; agentIds: string[] }>();
  for (const row of rows) {
    const existing = grouped.get(row.nodeId) ?? { nodeKind: row.nodeKind, agentIds: [] };
    existing.agentIds.push(row.agentId);
    grouped.set(row.nodeId, existing);
  }
  return grouped;
}

async function sendContextToRows(
  deps: NodeContextDeps,
  rows: ScopedNodeRow[],
  message: {
    topic: NodeContextTopic;
    event: string;
    channelId?: string | null;
    data: Record<string, unknown>;
  },
): Promise<void> {
  const grouped = groupByNode(rows);
  const directAgentIds: string[] = [];
  const tasks: Promise<unknown>[] = [];
  for (const [nodeId, group] of grouped.entries()) {
    const agentIds = [...new Set(group.agentIds)];
    if (group.nodeKind === 'fleet_ws') {
      tasks.push(
        deps.nodeConnections.sendToNode(deps.workspaceId, nodeId, {
          v: 1,
          type: 'context.update',
          topic: message.topic,
          event: message.event,
          channel_id: message.channelId ?? null,
          agent_ids: agentIds,
          data: toFleetWireJson(message.data),
        }),
      );
      continue;
    }
    if (group.nodeKind === 'direct_ws') {
      if (!DELIVERY_ROUTED_EVENTS.has(message.event)) {
        directAgentIds.push(...agentIds);
      }
      continue;
    }
    console.warn('[node.context] unsupported node kind for context update', {
      workspace_id: deps.workspaceId,
      node_id: nodeId,
      node_kind: group.nodeKind,
      agent_ids: agentIds,
      topic: message.topic,
      event: message.event,
    });
  }
  if (directAgentIds.length > 0) {
    tasks.push(
      deps.realtime.deliverToAgents({
        workspaceId: deps.workspaceId,
        agentIds: [...new Set(directAgentIds)],
        event: transformForClient({
          type: message.event,
          workspace_id: deps.workspaceId,
          ...(message.channelId ? { channel_id: message.channelId } : {}),
          data: message.data,
          timestamp: new Date().toISOString(),
        }),
      }),
    );
  }
  await Promise.allSettled(tasks);
}

export async function sendNodeContextForChannel(
  deps: NodeContextDeps,
  args: {
    channelId: string;
    topic?: NodeContextTopic;
    event: string;
    data: Record<string, unknown>;
  },
): Promise<void> {
  const rows = await deps.db
    .select({
      nodeId: agentNodeBindings.nodeId,
      agentId: agentNodeBindings.agentId,
      nodeKind: nodes.kind,
    })
    .from(channelMembers)
    .innerJoin(agentNodeBindings, and(
      eq(agentNodeBindings.agentId, channelMembers.agentId),
      eq(agentNodeBindings.workspaceId, deps.workspaceId),
      eq(agentNodeBindings.status, 'active'),
    ))
    .innerJoin(agents, and(
      eq(agents.workspaceId, deps.workspaceId),
      eq(agents.id, agentNodeBindings.agentId),
      eq(agents.locationType, 'via_node'),
      eq(agents.locationNodeId, agentNodeBindings.nodeId),
    ))
    .innerJoin(nodes, and(
      eq(nodes.workspaceId, deps.workspaceId),
      eq(nodes.id, agentNodeBindings.nodeId),
    ))
    .where(and(
      eq(channelMembers.channelId, args.channelId),
      inArray(nodes.kind, ['fleet_ws', 'direct_ws']),
    ));

  await sendContextToRows(deps, rows, {
    topic: args.topic ?? 'channel',
    event: args.event,
    channelId: args.channelId,
    data: args.data,
  });
}

export async function sendNodePresenceContext(
  deps: NodeContextDeps,
  args: {
    subjectAgentId: string;
    event: string;
    data: Record<string, unknown>;
  },
): Promise<void> {
  const subjectMemberships = alias(channelMembers, 'subject_memberships');
  const peerMemberships = alias(channelMembers, 'peer_memberships');
  const rows = await deps.db
    .select({
      nodeId: agentNodeBindings.nodeId,
      agentId: agentNodeBindings.agentId,
      nodeKind: nodes.kind,
    })
    .from(subjectMemberships)
    .innerJoin(peerMemberships, eq(peerMemberships.channelId, subjectMemberships.channelId))
    .innerJoin(agentNodeBindings, and(
      eq(agentNodeBindings.agentId, peerMemberships.agentId),
      eq(agentNodeBindings.workspaceId, deps.workspaceId),
      eq(agentNodeBindings.status, 'active'),
    ))
    .innerJoin(agents, and(
      eq(agents.workspaceId, deps.workspaceId),
      eq(agents.id, agentNodeBindings.agentId),
      eq(agents.locationType, 'via_node'),
      eq(agents.locationNodeId, agentNodeBindings.nodeId),
    ))
    .innerJoin(nodes, and(
      eq(nodes.workspaceId, deps.workspaceId),
      eq(nodes.id, agentNodeBindings.nodeId),
    ))
    .where(and(
      eq(subjectMemberships.agentId, args.subjectAgentId),
      inArray(nodes.kind, ['fleet_ws', 'direct_ws']),
    ));

  await sendContextToRows(deps, rows, {
    topic: 'presence',
    event: args.event,
    data: args.data,
  });
}
