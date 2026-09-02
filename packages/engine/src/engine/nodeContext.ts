import { and, eq, inArray, or } from 'drizzle-orm';
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
  providerName: string;
  deliveryAdapter: string | null;
  deliveryConfig: Record<string, unknown> | null;
};

// Node kinds eligible for context updates: WebSocket nodes receive a pushed
// `context.update` frame; http_push nodes receive a best-effort POST.
const CONTEXT_NODE_KINDS = ['ws', 'fleet_ws', 'direct_ws', 'http_push'] as const;
// workspace/status/kind predicates add six bindings, so 80 agent ids leave
// comfortable room below D1's 100-bound-parameter limit.
const AGENT_CONTEXT_QUERY_CHUNK_SIZE = 80;
// A cross-workspace target can bind both workspace and agent id. Forty worst-
// case one-agent workspaces plus the status/kind predicates use 85 bindings.
const AGENT_CONTEXT_EVENT_QUERY_CHUNK_SIZE = 40;

/** Collapse the per-kind WebSocket adapter aliases onto the single `ws.node.v1` contract. */
function normalizeDeliveryAdapter(adapter: string | null | undefined, nodeKind: string | null | undefined): string | null {
  if (adapter === 'fleet.ws.v1' || adapter === 'direct.ws.v1') return 'ws.node.v1';
  if (adapter) return adapter;
  if (nodeKind === 'ws' || nodeKind === 'fleet_ws' || nodeKind === 'direct_ws') return 'ws.node.v1';
  return null;
}

type GroupedNode = {
  nodeId: string;
  providerName: string;
  nodeKind: string;
  nodeRole: string;
  deliveryAdapter: string | null;
  deliveryConfig: Record<string, unknown> | null;
  agentIds: string[];
};

/**
 * Group by (node, provider) so a WebSocket context.update lands on the provider
 * whose connection hosts those agents, not a phantom node-default provider.
 */
function groupByNodeProvider(rows: ScopedNodeRow[]): Map<string, GroupedNode> {
  const grouped = new Map<string, GroupedNode>();
  for (const row of rows) {
    // Collision-safe key: node ids and provider names are free-form and may
    // contain any separator, so encode the tuple rather than joining on a string.
    const key = JSON.stringify([row.nodeId, row.providerName]);
    const existing = grouped.get(key) ?? {
      nodeId: row.nodeId,
      providerName: row.providerName,
      nodeKind: row.nodeKind,
      nodeRole: row.nodeRole,
      deliveryAdapter: row.deliveryAdapter,
      deliveryConfig: row.deliveryConfig,
      agentIds: [],
    };
    existing.agentIds.push(row.agentId);
    grouped.set(key, existing);
  }
  return grouped;
}

/**
 * Push one context event to every (node, provider) target in `rows`.
 *
 * Targets are independent — one failing node never cancels another — but the
 * failures are not swallowed: if any send rejects, this throws an
 * `AggregateError` so callers can report the sink as failed.
 */
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
  const grouped = groupByNodeProvider(rows);
  const tasks: Promise<unknown>[] = [];
  for (const group of grouped.values()) {
    const nodeId = group.nodeId;
    const agentIds = [...new Set(group.agentIds)];
    if (normalizeDeliveryAdapter(group.deliveryAdapter, group.nodeKind) === 'ws.node.v1') {
      tasks.push(
        deps.nodeConnections.sendToProvider(deps.workspaceId, nodeId, group.providerName, {
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
  const settled = await Promise.allSettled(tasks);
  const failures = settled
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason);
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `node context push failed for ${failures.length} of ${tasks.length} node targets`,
    );
  }
}

/** Push a channel/thread context event to every node hosting a member of `channelId`. */
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
      providerName: agents.providerName,
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

/** Push a presence context event about `subjectAgentId` to every node in the workspace. */
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
      providerName: agents.providerName,
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

/** Resolve the node/provider targets for `agentIds` in D1-bound-parameter-safe chunks. */
async function listNodeContextRowsForAgents(
  deps: NodeContextDeps,
  agentIds: readonly string[],
): Promise<ScopedNodeRow[]> {
  const rows: ScopedNodeRow[] = [];
  for (let offset = 0; offset < agentIds.length; offset += AGENT_CONTEXT_QUERY_CHUNK_SIZE) {
    const chunk = agentIds.slice(offset, offset + AGENT_CONTEXT_QUERY_CHUNK_SIZE);
    rows.push(...await deps.db
      .select({
        nodeId: agentNodeBindings.nodeId,
        agentId: agentNodeBindings.agentId,
        nodeKind: nodes.kind,
        nodeRole: nodes.role,
        providerName: agents.providerName,
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
        inArray(agentNodeBindings.agentId, chunk),
        inArray(nodes.kind, CONTEXT_NODE_KINDS),
      )));
  }
  return rows;
}

/** Push an agent-scoped context event to the nodes hosting `agentIds`. */
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

  const rows = await listNodeContextRowsForAgents(deps, uniqueAgentIds);

  await sendContextToRows(deps, rows, {
    topic: 'agent',
    event: args.event,
    data: args.data,
  });
}

/**
 * Send many agent-scoped context events after resolving all target bindings in
 * bounded queries. External sends stay serialized per event, so one event's
 * failure never strands the rest; if any event failed, this throws an
 * `AggregateError` once the whole batch has been attempted.
 */
export async function sendNodeContextEventsToAgents(
  deps: Omit<NodeContextDeps, 'workspaceId'>,
  events: ReadonlyArray<{
    workspaceId: string;
    agentId: string;
    event: string;
    data: Record<string, unknown>;
  }>,
): Promise<void> {
  const targets = [...new Map(events
    .filter((event) => event.workspaceId.length > 0 && event.agentId.length > 0)
    .map((event) => [
      JSON.stringify([event.workspaceId, event.agentId]),
      { workspaceId: event.workspaceId, agentId: event.agentId },
    ])).values()];
  if (targets.length === 0) return;

  const rowsByTarget = new Map<string, ScopedNodeRow[]>();
  for (let offset = 0; offset < targets.length; offset += AGENT_CONTEXT_EVENT_QUERY_CHUNK_SIZE) {
    const chunk = targets.slice(offset, offset + AGENT_CONTEXT_EVENT_QUERY_CHUNK_SIZE);
    const agentsByWorkspace = new Map<string, string[]>();
    for (const target of chunk) {
      const agentIds = agentsByWorkspace.get(target.workspaceId) ?? [];
      agentIds.push(target.agentId);
      agentsByWorkspace.set(target.workspaceId, agentIds);
    }
    const scopes = [...agentsByWorkspace].map(([workspaceId, agentIds]) => and(
      eq(agentNodeBindings.workspaceId, workspaceId),
      inArray(agentNodeBindings.agentId, agentIds),
    ));
    const rows = await deps.db
      .select({
        workspaceId: agentNodeBindings.workspaceId,
        nodeId: agentNodeBindings.nodeId,
        agentId: agentNodeBindings.agentId,
        nodeKind: nodes.kind,
        nodeRole: nodes.role,
        providerName: agents.providerName,
        deliveryAdapter: nodes.deliveryAdapter,
        deliveryConfig: nodes.deliveryConfig,
      })
      .from(agentNodeBindings)
      .innerJoin(agents, and(
        eq(agents.workspaceId, agentNodeBindings.workspaceId),
        eq(agents.id, agentNodeBindings.agentId),
        eq(agents.locationType, 'via_node'),
        eq(agents.locationNodeId, agentNodeBindings.nodeId),
      ))
      .innerJoin(nodes, and(
        eq(nodes.workspaceId, agentNodeBindings.workspaceId),
        eq(nodes.id, agentNodeBindings.nodeId),
      ))
      .where(and(
        eq(agentNodeBindings.status, 'active'),
        inArray(nodes.kind, CONTEXT_NODE_KINDS),
        or(...scopes),
      ));
    for (const row of rows) {
      const key = JSON.stringify([row.workspaceId, row.agentId]);
      const targetRows = rowsByTarget.get(key) ?? [];
      targetRows.push(row);
      rowsByTarget.set(key, targetRows);
    }
  }

  const failures: unknown[] = [];
  for (const event of events) {
    const key = JSON.stringify([event.workspaceId, event.agentId]);
    try {
      await sendContextToRows({ ...deps, workspaceId: event.workspaceId }, rowsByTarget.get(key) ?? [], {
        topic: 'agent',
        event: event.event,
        data: event.data,
      });
    } catch (err) {
      // One failing event must not strand the rest of the batch, but the batch
      // still reports failure so the caller's sink error handler fires.
      failures.push(err);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `node context push failed for ${failures.length} of ${events.length} agent events`,
    );
  }
}
