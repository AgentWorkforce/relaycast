import { and, eq, inArray, isNull } from 'drizzle-orm';
import { agents, agentNodeBindings, channelMembers, dmConversations, dmParticipants, nodes } from '../db/schema.js';
import type { EngineDb } from '../ports/database.js';
import type { NodeConnectionRegistry } from '../ports/realtime.js';
import { buildDeliverFrame, buildDeliverPayload } from './deliveryWire.js';

type NodeDeliverDeps = {
  db: EngineDb;
  nodeConnections: NodeConnectionRegistry;
  workspaceId: string;
};

type NodeDeliverRecipient = {
  agentId: string;
  agentName: string;
  nodeId: string;
  nodeKind: string;
};

const WS_NODE_KINDS = ['ws', 'fleet_ws', 'direct_ws'] as const;

function eventDeliveryId(event: string, eventKey: string, agentId: string): string {
  const normalizedEvent = event.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'event';
  const normalizedKey = eventKey.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
  return `evt_${normalizedEvent}_${normalizedKey}_${agentId}`;
}

async function channelRecipients(deps: NodeDeliverDeps, channelId: string): Promise<NodeDeliverRecipient[]> {
  const [dm] = await deps.db
    .select({ id: dmConversations.id })
    .from(dmConversations)
    .where(and(eq(dmConversations.workspaceId, deps.workspaceId), eq(dmConversations.channelId, channelId)));

  if (dm) {
    return deps.db
      .select({
        agentId: dmParticipants.agentId,
        agentName: agents.name,
        nodeId: agentNodeBindings.nodeId,
        nodeKind: nodes.kind,
      })
      .from(dmParticipants)
      .innerJoin(agents, and(
        eq(agents.workspaceId, deps.workspaceId),
        eq(agents.id, dmParticipants.agentId),
      ))
      .innerJoin(agentNodeBindings, and(
        eq(agentNodeBindings.workspaceId, deps.workspaceId),
        eq(agentNodeBindings.agentId, dmParticipants.agentId),
        eq(agentNodeBindings.status, 'active'),
      ))
      .innerJoin(nodes, and(
        eq(nodes.workspaceId, deps.workspaceId),
        eq(nodes.id, agentNodeBindings.nodeId),
      ))
      .where(and(
        eq(dmParticipants.conversationId, dm.id),
        isNull(dmParticipants.leftAt),
        eq(agents.locationType, 'via_node'),
        eq(agents.locationNodeId, agentNodeBindings.nodeId),
        inArray(nodes.kind, WS_NODE_KINDS),
      ));
  }

  return deps.db
    .select({
      agentId: channelMembers.agentId,
      agentName: agents.name,
      nodeId: agentNodeBindings.nodeId,
      nodeKind: nodes.kind,
    })
    .from(channelMembers)
    .innerJoin(agents, and(
      eq(agents.workspaceId, deps.workspaceId),
      eq(agents.id, channelMembers.agentId),
    ))
    .innerJoin(agentNodeBindings, and(
      eq(agentNodeBindings.workspaceId, deps.workspaceId),
      eq(agentNodeBindings.agentId, channelMembers.agentId),
      eq(agentNodeBindings.status, 'active'),
    ))
    .innerJoin(nodes, and(
      eq(nodes.workspaceId, deps.workspaceId),
      eq(nodes.id, agentNodeBindings.nodeId),
    ))
    .where(and(
      eq(channelMembers.channelId, channelId),
      eq(agents.locationType, 'via_node'),
      eq(agents.locationNodeId, agentNodeBindings.nodeId),
      inArray(nodes.kind, WS_NODE_KINDS),
    ));
}

export async function sendNodeDeliveriesForChannel(
  deps: NodeDeliverDeps,
  args: {
    channelId: string;
    messageId: string;
    event: string;
    eventKey: string;
    data: Record<string, unknown>;
  },
): Promise<void> {
  const recipients = await channelRecipients(deps, args.channelId);
  const tasks = recipients.map((recipient) =>
    deps.nodeConnections.sendToNode(deps.workspaceId, recipient.nodeId, buildDeliverFrame({
      delivery_id: eventDeliveryId(args.event, args.eventKey, recipient.agentId),
      agent_id: recipient.agentId,
      agent: recipient.agentName,
      msg_id: args.messageId,
      seq: 0,
      mode: 'wait',
      payload: buildDeliverPayload(args.event, args.data),
    })),
  );
  await Promise.allSettled(tasks);
}

export async function sendNodeDeliveriesToAgents(
  deps: NodeDeliverDeps,
  args: {
    agentIds: string[];
    event: string;
    eventKey: string;
    data: Record<string, unknown>;
    messageId?: string;
  },
): Promise<void> {
  const unique = [...new Set(args.agentIds)].filter((id) => id.length > 0);
  if (unique.length === 0) return;

  const recipients = await deps.db
    .select({
      agentId: agents.id,
      agentName: agents.name,
      nodeId: agentNodeBindings.nodeId,
      nodeKind: nodes.kind,
    })
    .from(agents)
    .innerJoin(agentNodeBindings, and(
      eq(agentNodeBindings.workspaceId, deps.workspaceId),
      eq(agentNodeBindings.agentId, agents.id),
      eq(agentNodeBindings.status, 'active'),
    ))
    .innerJoin(nodes, and(
      eq(nodes.workspaceId, deps.workspaceId),
      eq(nodes.id, agentNodeBindings.nodeId),
    ))
    .where(and(
      eq(agents.workspaceId, deps.workspaceId),
      inArray(agents.id, unique),
      eq(agents.locationType, 'via_node'),
      eq(agents.locationNodeId, agentNodeBindings.nodeId),
      inArray(nodes.kind, WS_NODE_KINDS),
    ));

  const tasks = recipients.map((recipient) =>
    deps.nodeConnections.sendToNode(deps.workspaceId, recipient.nodeId, buildDeliverFrame({
      delivery_id: eventDeliveryId(args.event, args.eventKey, recipient.agentId),
      agent_id: recipient.agentId,
      agent: recipient.agentName,
      msg_id: args.messageId ?? args.eventKey,
      seq: 0,
      mode: 'wait',
      payload: buildDeliverPayload(args.event, args.data),
    })),
  );
  await Promise.allSettled(tasks);
}
