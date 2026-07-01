import { and, eq, inArray } from 'drizzle-orm';
import type { EngineDb } from '../ports/database.js';
import type { NodeConnectionRegistry, RealtimeBus } from '../ports/realtime.js';
import { agents, agentNodeBindings, channelMembers, nodes } from '../db/schema.js';
import { toFleetWireJson } from './deliveryWire.js';
import { postEphemeralEventToHttpPushNode, strictHttpPushDispatch, type HttpPushProxyConfig } from './httpPushDispatch.js';

type NodeContextTopic = 'presence' | 'channel' | 'thread' | 'agent';

type NodeContextDeps = {
  db: EngineDb;
  nodeConnections: NodeConnectionRegistry;
  realtime: RealtimeBus;
  workspaceId: string;
  /** Defaults to strict SSRF hardening when omitted (production-safe). */
  environment?: string;
  /** Egress proxy for http_push nodes that opt in with `delivery.use_proxy`. */
  httpPushProxy?: HttpPushProxyConfig;
};

type ScopedNodeRow = {
  nodeId: string;
  agentId: string;
  nodeKind: string;
  nodeRole: string;
  deliveryAdapter: string | null;
  deliveryConfig: Record<string, unknown> | null;
};

// Node kinds eligible for context updates: WebSocket nodes receive a pushed
// `context.update` frame; http_push nodes receive a best-effort POST.
const CONTEXT_NODE_KINDS = ['ws', 'fleet_ws', 'direct_ws', 'http_push'] as const;

function normalizeDeliveryAdapter(adapter: string | null | undefined, nodeKind: string | null | undefined): string | null {
  if (adapter === 'fleet.ws.v1' || adapter === 'direct.ws.v1') return 'ws.node.v1';
  if (adapter) return adapter;
  if (nodeKind === 'ws' || nodeKind === 'fleet_ws' || nodeKind === 'direct_ws') return 'ws.node.v1';
  return null;
}

type GroupedNode = {
  nodeKind: string;
  nodeRole: string;
  deliveryAdapter: string | null;
  deliveryConfig: Record<string, unknown> | null;
  agentIds: string[];
};

function groupByNode(rows: ScopedNodeRow[]): Map<string, GroupedNode> {
  const grouped = new Map<string, GroupedNode>();
  for (const row of rows) {
    const existing = grouped.get(row.nodeId) ?? {
      nodeKind: row.nodeKind,
      nodeRole: row.nodeRole,
      deliveryAdapter: row.deliveryAdapter,
      deliveryConfig: row.deliveryConfig,
      agentIds: [],
    };
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
  const tasks: Promise<unknown>[] = [];
  for (const [nodeId, group] of grouped.entries()) {
    const agentIds = [...new Set(group.agentIds)];
    if (normalizeDeliveryAdapter(group.deliveryAdapter, group.nodeKind) === 'ws.node.v1') {
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
    if (group.nodeKind === 'http_push') {
      tasks.push(
        postEphemeralEventToHttpPushNode({
          deliveryConfig: group.deliveryConfig,
          strict: strictHttpPushDispatch(deps.environment),
          proxy: deps.httpPushProxy,
          event: {
            workspaceId: deps.workspaceId,
            eventType: message.event,
            eventData: message.data,
            extra: {
              topic: message.topic,
              channel_id: message.channelId ?? null,
              agent_ids: agentIds,
            },
          },
        }),
      );
      continue;
    }
    console.warn('[node.context] unsupported node kind for context update', {
      workspace_id: deps.workspaceId,
      node_id: nodeId,
      node_kind: group.nodeKind,
      node_role: group.nodeRole,
      delivery_adapter: group.deliveryAdapter,
      agent_ids: agentIds,
      topic: message.topic,
      event: message.event,
    });
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
      nodeRole: nodes.role,
      deliveryAdapter: nodes.deliveryAdapter,
      deliveryConfig: nodes.deliveryConfig,
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
      inArray(nodes.kind, CONTEXT_NODE_KINDS),
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
  const rows = await deps.db
    .select({
      nodeId: agentNodeBindings.nodeId,
      agentId: agentNodeBindings.agentId,
      nodeKind: nodes.kind,
      nodeRole: nodes.role,
      deliveryAdapter: nodes.deliveryAdapter,
      deliveryConfig: nodes.deliveryConfig,
    })
    .from(agentNodeBindings)
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
      eq(agentNodeBindings.workspaceId, deps.workspaceId),
      eq(agentNodeBindings.status, 'active'),
      inArray(nodes.kind, CONTEXT_NODE_KINDS),
    ));

  await sendContextToRows(deps, rows, {
    topic: 'presence',
    event: args.event,
    data: args.data,
  });
}

export async function sendNodeContextToAgents(
  deps: NodeContextDeps,
  args: {
    agentIds: string[];
    event: string;
    data: Record<string, unknown>;
  },
): Promise<void> {
  const uniqueAgentIds = [...new Set(args.agentIds)].filter((id) => id.length > 0);
  if (uniqueAgentIds.length === 0) return;

  const rows = await deps.db
    .select({
      nodeId: agentNodeBindings.nodeId,
      agentId: agentNodeBindings.agentId,
      nodeKind: nodes.kind,
      nodeRole: nodes.role,
      deliveryAdapter: nodes.deliveryAdapter,
      deliveryConfig: nodes.deliveryConfig,
    })
    .from(agentNodeBindings)
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
      eq(agentNodeBindings.workspaceId, deps.workspaceId),
      eq(agentNodeBindings.status, 'active'),
      inArray(agentNodeBindings.agentId, uniqueAgentIds),
      inArray(nodes.kind, CONTEXT_NODE_KINDS),
    ));

  await sendContextToRows(deps, rows, {
    topic: 'agent',
    event: args.event,
    data: args.data,
  });
}
