import type {
  RealtimeBus,
  ConnectionRegistry,
  NodeConnectionRegistry,
  NodeUpgradeArgs,
  EngineEvent,
  UpgradeArgs,
} from '@relaycast/engine/ports';
import type { CloudflareBindings } from '../../env.js';
import { drainNodeInvocations, sendToNode } from '../../durable-objects/node.js';

/**
 * The fleet control frame the engine 4.0 `NodeConnectionRegistry.sendToNode`
 * port accepts (`FleetRelaycastToBrokerMessage` from `@relaycast/types` 4.0).
 * Derived from the port so we don't import `@relaycast/types` directly — the
 * hoisted top-level `@relaycast/types` is the older 0.5.x line without the
 * fleet-wire exports; the 4.0 contract is only reachable through the engine.
 */
type FleetRelaycastToBrokerMessage = Parameters<NodeConnectionRegistry['sendToNode']>[2];

const JSON_HEADERS = { 'Content-Type': 'application/json' };

const MESSAGE_EVENT_TYPES = new Set([
  'message.created',
  'message.updated',
  'thread.reply',
  'dm.received',
  'group_dm.received',
]);

async function withAgentType(
  env: CloudflareBindings,
  workspaceId: string,
  event: EngineEvent,
): Promise<EngineEvent> {
  if (!MESSAGE_EVENT_TYPES.has(String(event.type))) return event;
  const message = event.message as Record<string, unknown> | undefined;
  if (!message || typeof message.agent_type === 'string') return event;
  const agentId = typeof message.agent_id === 'string' ? message.agent_id : null;
  if (!agentId) return event;

  try {
    const row = await env.DB
      .prepare('SELECT type FROM agents WHERE workspace_id = ? AND id = ? LIMIT 1')
      .bind(workspaceId, agentId)
      .first<{ type?: string }>();
    const agentType = row?.type;
    if (agentType !== 'agent' && agentType !== 'human' && agentType !== 'system') return event;
    return {
      ...event,
      message: {
        ...message,
        agent_type: agentType,
      },
    };
  } catch {
    return event;
  }
}

/**
 * Cloudflare Durable Object implementation of the engine's realtime ports.
 *
 * Thin wrappers that translate each port call into the same
 * `env.X_DO.idFromName(...).fetch(...)` request the original cloud worker made.
 * The DO classes (ChannelDO, AgentDO, WorkspaceStreamDO) hold the actual
 * sequencing / hibernation / resync logic; this adapter just routes to them.
 */
export function createCloudflareRealtime(env: CloudflareBindings) {
  const realtime = {
    /* ---------------------------- RealtimeBus ---------------------------- */

    async deliverToAgents(args: { workspaceId: string; agentIds: string[]; event: EngineEvent }): Promise<void> {
      const { workspaceId, agentIds, event } = args;
      const enrichedEvent = await withAgentType(env, workspaceId, event);
      await Promise.allSettled(agentIds.map((agentId) => {
        const stub = env.AGENT_DO.get(env.AGENT_DO.idFromName(`${workspaceId}:${agentId}`));
        return stub.fetch(new Request('http://do/deliver', {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ ...enrichedEvent, workspaceId, agentId }),
        }));
      }));
    },

    async publishToWorkspaceStream(args: { workspaceId: string; event: EngineEvent }): Promise<void> {
      const event = await withAgentType(env, args.workspaceId, args.event);
      const stub = env.WORKSPACE_STREAM_DO.get(env.WORKSPACE_STREAM_DO.idFromName(args.workspaceId));
      await stub.fetch(new Request('http://do/deliver', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(event),
      }));
    },

    async setChannelMembers(workspaceId: string, channelId: string, members: string[]): Promise<void> {
      const stub = env.CHANNEL_DO.get(env.CHANNEL_DO.idFromName(`${workspaceId}:${channelId}`));
      await stub.fetch(new Request('http://do/update-members', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ members }),
      }));
    },

    async setChannelMuted(workspaceId: string, channelId: string, muted: string[]): Promise<void> {
      const stub = env.CHANNEL_DO.get(env.CHANNEL_DO.idFromName(`${workspaceId}:${channelId}`));
      await stub.fetch(new Request('http://do/update-muted', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ muted }),
      }));
    },

    /* ------------------------- ConnectionRegistry ------------------------ */

    async upgrade(args: UpgradeArgs): Promise<Response> {
      const { request, workspaceId, origin, originActor } = args;
      const url = new URL(request.url);
      url.pathname = '/ws';
      url.searchParams.set('workspace_id', workspaceId);
      url.searchParams.set('origin_client', origin.client);
      url.searchParams.set('origin_version', origin.version);
      url.searchParams.set('origin_actor', originActor ?? 'unknown');
      const stub = env.WORKSPACE_STREAM_DO.get(env.WORKSPACE_STREAM_DO.idFromName(workspaceId));
      return stub.fetch(new Request(url.toString(), request));
    },

    async pushToAgent(workspaceId: string, agentId: string, event: EngineEvent): Promise<{ agentSeq: number }> {
      const enrichedEvent = await withAgentType(env, workspaceId, event);
      const stub = env.AGENT_DO.get(env.AGENT_DO.idFromName(`${workspaceId}:${agentId}`));
      const res = await stub.fetch(new Request('http://do/deliver', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ ...enrichedEvent, workspaceId, agentId }),
      }));
      const data = (await res.json().catch(() => ({}))) as { agent_seq?: number };
      return { agentSeq: data.agent_seq ?? 0 };
    },

    async disconnectAgent(workspaceId: string, agentId: string): Promise<void> {
      const stub = env.AGENT_DO.get(env.AGENT_DO.idFromName(`${workspaceId}:${agentId}`));
      await stub.fetch(new Request('http://do/force-disconnect', { method: 'POST' }));
    },
  };
  // Compile-time verification: adapter satisfies the engine's RealtimeBus & ConnectionRegistry ports.
  const _: RealtimeBus & ConnectionRegistry = realtime;
  void _;
  return realtime;
}

/**
 * Cloudflare DO-backed node-control registry for the hosted worker.
 *
 * @relaycast/engine 4.0 added the fleet node-control surface (#192-194), which
 * requires a {@link NodeConnectionRegistry} on `EngineDeps`. This adapter wires
 * the engine port to the NodeDO: `upgradeNode` forwards the WS upgrade to the
 * per-node Durable Object, `sendToNode` pushes a typed
 * {@link FleetRelaycastToBrokerMessage} frame to the node's live socket, and
 * `disconnectNode`/`drainNode` route control requests to the DO.
 *
 * Fleet still ships *dark* on the hosted worker: `config.fleetNodesEnabled` is
 * false and there is no per-workspace KV override, so the engine's node routes
 * and the node-control WS upgrade return `fleet_nodes_disabled` (404) before any
 * of these methods are reached. They become live only once a workspace opts in
 * via the engine's `fleet-nodes-enabled:<workspaceId>` KV flag.
 */
export function createCloudflareNodeConnections(
  env: CloudflareBindings,
): NodeConnectionRegistry {
  return {
    async upgradeNode(args: NodeUpgradeArgs): Promise<Response> {
      const { request, workspaceId, nodeId, nodeName, origin, originActor } = args;
      const url = new URL(request.url);
      url.pathname = '/ws';
      url.searchParams.set('workspace_id', workspaceId);
      url.searchParams.set('node_id', nodeId);
      url.searchParams.set('node_name', nodeName);
      url.searchParams.set('origin_client', origin.client);
      url.searchParams.set('origin_version', origin.version);
      url.searchParams.set('origin_actor', originActor ?? 'unknown');
      const stub = env.NODE_DO.get(env.NODE_DO.idFromName(`${workspaceId}:${nodeId}`));
      return stub.fetch(new Request(url.toString(), request));
    },

    sendToNode(
      workspaceId: string,
      nodeId: string,
      message: FleetRelaycastToBrokerMessage,
    ): Promise<boolean> {
      return sendToNode(env, workspaceId, nodeId, message);
    },

    isNodeConnected(_workspaceId: string, _nodeId: string): boolean {
      // Cloudflare DO socket state is not synchronously observable from the
      // edge isolate; dispatch uses sendToNode's delivered=false response.
      return false;
    },

    async disconnectNode(workspaceId: string, nodeId: string): Promise<void> {
      const stub = env.NODE_DO.get(env.NODE_DO.idFromName(`${workspaceId}:${nodeId}`));
      await stub.fetch(new Request('http://do/disconnect', { method: 'POST' }));
    },

    async drainNode(workspaceId: string, nodeId: string): Promise<void> {
      // Cloud has no per-node frame queue (frames are dispatched eagerly via
      // sendToNode), so "drain" means: now that the node is online again, push
      // any invocations that were parked for it back through dispatch. The
      // engine 4.0 calls this after node.register / node.heartbeat so queued
      // spawns can reserve capacity and dispatch.
      await drainNodeInvocations(env, workspaceId, nodeId);
    },
  };
}
