import type { WsClient } from '@relaycast/sdk';
import type { SubscriptionManager } from './subscriptions.js';

type ResourceEvent = {
  type?: string;
} & Record<string, unknown>;

function getStringEventField(event: ResourceEvent, field: string): string | null {
  const candidate = event[field];
  return typeof candidate === 'string' ? candidate : null;
}

/**
 * Maps a WebSocket ServerEvent to the relay:// resource URIs it affects.
 */
export function eventToResourceUris(event: ResourceEvent): string[] {
  switch (event.type) {
    case 'message.created': {
      const channel = getStringEventField(event, 'channel');
      return channel
        ? ['relay://inbox', `relay://channels/${channel}/messages`]
        : ['relay://inbox'];
    }
    case 'message.updated': {
      const channel = getStringEventField(event, 'channel');
      return channel ? [`relay://channels/${channel}/messages`] : [];
    }
    case 'thread.reply': {
      const parentId = getStringEventField(event, 'parentId');
      return parentId
        ? ['relay://inbox', `relay://messages/${parentId}/thread`]
        : ['relay://inbox'];
    }
    case 'dm.received':
    case 'group_dm.received': {
      const conversationId = getStringEventField(event, 'conversationId');
      return conversationId
        ? ['relay://inbox', `relay://dm/${conversationId}`]
        : ['relay://inbox'];
    }
    case 'agent.online':
    case 'agent.offline':
      return ['relay://agents'];
    case 'channel.created':
    case 'channel.updated':
    case 'channel.archived':
    case 'member.joined':
    case 'member.left':
      return ['relay://channels'];
    case 'webhook.received':
    case 'command.invoked': {
      const channel = getStringEventField(event, 'channel');
      return channel ? [`relay://channels/${channel}/messages`] : [];
    }
    case 'message.read':
      return [];
    case 'file.uploaded':
      return [];
    case 'reaction.added':
    case 'reaction.removed':
      // Reactions are informational activity: surface them as a soft inbox
      // signal so agents can observe updates without implying a required reply.
      return ['relay://inbox'];
    default:
      return [];
  }
}

export type NotifyCallback = (uri: string) => void;

/**
 * Bridges WebSocket events to MCP resource update notifications.
 * Connects a WsClient to the SubscriptionManager and fires a callback
 * for each subscribed resource URI affected by an incoming event.
 */
export class WsBridge {
  private wsClient: WsClient;
  private subscriptions: SubscriptionManager;
  private notifyCallback: NotifyCallback;
  private unsubscribeFn: (() => void) | null = null;

  constructor(
    wsClient: WsClient,
    subscriptions: SubscriptionManager,
    notifyCallback: NotifyCallback,
  ) {
    this.wsClient = wsClient;
    this.subscriptions = subscriptions;
    this.notifyCallback = notifyCallback;
  }

  /**
   * Start listening to WebSocket events and dispatching resource notifications.
   */
  start(): void {
    this.unsubscribeFn = this.wsClient.on('*', (event) => {
      const wsEvent = event as ResourceEvent;
      // Filter out client-only events (open, close, error, reconnecting)
      // Only process server events that affect resources
      if (
        wsEvent.type === 'open'
        || wsEvent.type === 'close'
        || wsEvent.type === 'error'
        || wsEvent.type === 'reconnecting'
      ) {
        return;
      }
      const uris = eventToResourceUris(wsEvent);
      const matched = this.subscriptions.getMatchingSubscriptions(uris);
      for (const uri of matched) {
        this.notifyCallback(uri);
      }
    });

    this.wsClient.connect();
  }

  /**
   * Stop listening and disconnect the WebSocket.
   */
  stop(): void {
    if (this.unsubscribeFn) {
      this.unsubscribeFn();
      this.unsubscribeFn = null;
    }
    this.wsClient.disconnect();
  }
}
