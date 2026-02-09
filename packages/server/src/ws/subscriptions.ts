import { WebSocket } from 'ws';
import type { WsClient } from './server.js';
import { getClients, getChannelIndex, getWorkspaceIndex, indexSubscribe, indexUnsubscribe } from './server.js';

export interface SubscribeMessage {
  type: 'subscribe';
  channels: string[];
}

export interface UnsubscribeMessage {
  type: 'unsubscribe';
  channels: string[];
}

export type ClientMessage = SubscribeMessage | UnsubscribeMessage;

export function handleClientMessage(client: WsClient, raw: string): void {
  let msg: ClientMessage;
  try {
    msg = JSON.parse(raw);
  } catch {
    client.ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
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

export function broadcastToChannel(workspaceId: string, channel: string, event: object): void {
  const key = `${workspaceId}:${channel}`;
  const subscriberIds = getChannelIndex().get(key);
  if (!subscriberIds || subscriberIds.size === 0) return;

  const payload = JSON.stringify(event);
  const clients = getClients();
  for (const id of subscriberIds) {
    const client = clients.get(id);
    if (client && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(payload);
    }
  }
}

export function broadcastToWorkspace(workspaceId: string, event: object): void {
  const clientIds = getWorkspaceIndex().get(workspaceId);
  if (!clientIds || clientIds.size === 0) return;

  const payload = JSON.stringify(event);
  const clients = getClients();
  for (const id of clientIds) {
    const client = clients.get(id);
    if (client && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(payload);
    }
  }
}
