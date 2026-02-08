import type { ServerEvent } from '@agent-relay/types';
import type { WsClient } from '@agent-relay/sdk';
import type { SubscriptionManager } from './subscriptions.js';

/**
 * Maps a WebSocket ServerEvent to the relay:// resource URIs it affects.
 */
export function eventToResourceUris(event: ServerEvent): string[] {
  switch (event.type) {
    case 'message.created':
      return [
        'relay://inbox',
        `relay://channels/${(event as any).channel}/messages`,
      ];
    case 'message.updated':
      return [`relay://channels/${(event as any).channel}/messages`];
    case 'thread.reply':
      return [
        'relay://inbox',
        `relay://messages/${(event as any).parent_id}/thread`,
      ];
    case 'dm.received':
      return [
        'relay://inbox',
        `relay://dm/${(event as any).conversation_id}`,
      ];
    case 'group_dm.received':
      return [
        'relay://inbox',
        `relay://dm/${(event as any).conversation_id}`,
      ];
    case 'agent.online':
    case 'agent.offline':
      return ['relay://agents'];
    case 'channel.created':
    case 'channel.archived':
      return ['relay://channels'];
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
    this.unsubscribeFn = this.wsClient.on('*', (event: ServerEvent) => {
      const uris = eventToResourceUris(event);
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
