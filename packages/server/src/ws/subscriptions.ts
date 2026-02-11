import { WebSocket } from 'ws';
import type { WsClient } from './server.js';
import { getClients, getChannelIndex, getWorkspaceIndex, indexSubscribe, indexUnsubscribe } from './server.js';
import type { WsEvent } from './pubsub.js';
import { transformForClient } from './transform.js';

export interface SubscribeMessage {
  type: 'subscribe';
  channels: string[];
}

export interface UnsubscribeMessage {
  type: 'unsubscribe';
  channels: string[];
}

export interface PingMessage {
  type: 'ping';
}

export type ClientMessage = SubscribeMessage | UnsubscribeMessage | PingMessage;

export function handleClientMessage(client: WsClient, raw: string): void {
  let msg: ClientMessage;
  try {
    msg = JSON.parse(raw);
  } catch {
    client.ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
    return;
  }

  if (msg.type === 'ping') {
    client.ws.send(JSON.stringify({ type: 'pong' }));
    return;
  }

  if (msg.type === 'subscribe') {
    if (!Array.isArray(msg.channels)) {
      client.ws.send(JSON.stringify({ type: 'error', message: 'channels must be an array' }));
      return;
    }
    for (const ch of msg.channels) {
      if (typeof ch === 'string') {
        client.subscriptions.add(ch);
        indexSubscribe(client, ch);
      }
    }
    client.ws.send(JSON.stringify({
      type: 'subscribed',
      channels: Array.from(client.subscriptions),
    }));
  } else if (msg.type === 'unsubscribe') {
    if (!Array.isArray(msg.channels)) {
      client.ws.send(JSON.stringify({ type: 'error', message: 'channels must be an array' }));
      return;
    }
    for (const ch of msg.channels) {
      indexUnsubscribe(client, ch);
      client.subscriptions.delete(ch);
    }
    client.ws.send(JSON.stringify({
      type: 'unsubscribed',
      channels: Array.from(client.subscriptions),
    }));
  } else {
    client.ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type' }));
  }
}

export function broadcastToChannel(workspaceId: string, channel: string, event: WsEvent | object): void {
  const key = `${workspaceId}:${channel}`;
  const subscriberIds = getChannelIndex().get(key);
  if (!subscriberIds || subscriberIds.size === 0) return;

  const senderAgentId = extractSenderAgentId(event);
  const clientEvent = 'data' in event && 'workspace_id' in event ? transformForClient(event as WsEvent) : event;
  const payload = JSON.stringify(clientEvent);
  const clients = getClients();
  for (const id of subscriberIds) {
    const client = clients.get(id);
    if (!client || client.ws.readyState !== WebSocket.OPEN) continue;
    if (senderAgentId && client.agentId === senderAgentId) continue;
    client.ws.send(payload);
  }
}

export function broadcastToWorkspace(workspaceId: string, event: WsEvent | object): void {
  const clientIds = getWorkspaceIndex().get(workspaceId);
  if (!clientIds || clientIds.size === 0) return;

  const senderAgentId = extractSenderAgentId(event);
  const clientEvent = 'data' in event && 'workspace_id' in event ? transformForClient(event as WsEvent) : event;
  const payload = JSON.stringify(clientEvent);
  const clients = getClients();
  for (const id of clientIds) {
    const client = clients.get(id);
    if (!client || client.ws.readyState !== WebSocket.OPEN) continue;
    if (senderAgentId && client.agentId === senderAgentId) continue;
    client.ws.send(payload);
  }
}

/**
 * Extract the sender's agent ID from an event so broadcast can skip
 * echoing the event back to the originating agent.
 */
function extractSenderAgentId(event: WsEvent | object): string | undefined {
  if (!('data' in event) || !event.data) return undefined;
  const data = event.data as Record<string, unknown>;
  // DMs use from_agent_id, channel messages use agent_id
  const id = data.from_agent_id ?? data.agent_id;
  return typeof id === 'string' ? id : undefined;
}
