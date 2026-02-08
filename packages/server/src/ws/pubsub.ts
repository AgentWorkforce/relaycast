import { getRedis, getRedisSub } from '../redis/index.js';
import { broadcastToChannel, broadcastToWorkspace } from './subscriptions.js';

export const EVENT_TYPES = [
  'message.created',
  'message.updated',
  'thread.reply',
  'reaction.added',
  'reaction.removed',
  'dm.received',
  'group_dm.received',
  'agent.online',
  'agent.offline',
  'channel.created',
  'channel.updated',
  'channel.archived',
  'member.joined',
  'member.left',
  'message.read',
  'file.uploaded',
  'webhook.received',
  'command.invoked',
] as const;

export type EventType = typeof EVENT_TYPES[number];

export interface WsEvent {
  type: EventType;
  workspace_id: string;
  channel_id?: string;
  data: Record<string, unknown>;
  timestamp: string;
}

const subscribedWorkspaces = new Set<string>();

export async function publishEvent(event: WsEvent): Promise<void> {
  const redis = getRedis();
  const redisChannel = `ws:${event.workspace_id}`;
  await redis.publish(redisChannel, JSON.stringify(event));
}

export async function subscribeToWorkspace(workspaceId: string): Promise<void> {
  if (subscribedWorkspaces.has(workspaceId)) return;

  const sub = getRedisSub();
  const redisChannel = `ws:${workspaceId}`;
  await sub.subscribe(redisChannel);
  subscribedWorkspaces.add(workspaceId);
}

export async function unsubscribeFromWorkspace(workspaceId: string): Promise<void> {
  if (!subscribedWorkspaces.has(workspaceId)) return;

  const sub = getRedisSub();
  const redisChannel = `ws:${workspaceId}`;
  await sub.unsubscribe(redisChannel);
  subscribedWorkspaces.delete(workspaceId);
}

export function setupPubSubListener(): void {
  const sub = getRedisSub();

  sub.on('message', (redisChannel: string, message: string) => {
    if (!redisChannel.startsWith('ws:')) return;

    let event: WsEvent;
    try {
      event = JSON.parse(message);
    } catch {
      return;
    }

    if (event.channel_id) {
      broadcastToChannel(event.workspace_id, event.channel_id, event);
    } else {
      broadcastToWorkspace(event.workspace_id, event);
    }
  });
}

export function getSubscribedWorkspaces(): Set<string> {
  return subscribedWorkspaces;
}
