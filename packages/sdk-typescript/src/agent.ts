import type {
  PostMessageRequest,
  MessageListQuery,
  MessageWithMeta,
  SearchMessageResult,
  MessageBlock,
  ThreadReplyRequest,
  SendDmRequest,
  SendDmResponse,
  DmMessage,
  CreateGroupDmRequest,
  CreateGroupDmResponse,
  GroupDmMessageResponse,
  GroupDmParticipantResponse,
  DmConversationSummary,
  CreateChannelRequest,
  UpdateChannelRequest,
  Channel,
  ChannelMemberInfo,
  JoinChannelResponse,
  InviteChannelResponse,
  AddedReaction,
  ReadReceipt,
  ReactionGroup,
  InboxResponse,
  ReaderInfo,
  ChannelReadStatus,
  UploadRequest,
  UploadResponse,
  CompleteUploadResponse,
  FileInfo,
  Agent,
  InvokeActionResult,
  CompleteInvocationRequest,
  ActionInvocation,
  WsClientEvent,
  MessageCreatedEvent,
  MessageUpdatedEvent,
  ThreadReplyEvent,
  MessageReadEvent,
  MessageReactedEvent,
  DmReceivedEvent,
  GroupDmReceivedEvent,
  RelaycastMessageEvent,
  AgentStatusActiveEvent,
  AgentStatusChangedEvent,
  AgentStatusOfflineEvent,
  ChannelCreatedEvent,
  ChannelUpdatedEvent,
  ChannelArchivedEvent,
  MemberJoinedEvent,
  MemberLeftEvent,
  ChannelMutedEvent,
  ChannelUnmutedEvent,
  FileUploadedEvent,
  WebhookReceivedEvent,
  ActionInvokedEvent,
  ActionCompletedEvent,
  ActionDeniedEvent,
  ActionFailedEvent,
  Delivery,
  DeliveryItem,
  DeliveryStatus,
  FailDeliveryRequest,
  DeferDeliveryRequest,
  DeliveryAcceptedEvent,
  DeliveryDeliveredEvent,
  DeliveryDeferredEvent,
  DeliveryFailedEvent,
  WsReconnectingEvent,
  WsPermanentlyDisconnectedEvent,
  WsResyncedEvent,
} from './types.js';
import { HttpClient, type RequestOptions } from './client.js';
import { WsClient, type WsClientOptions, withInternalWsOrigin } from './ws.js';
import type { Subscription } from './subscription.js';
import { stableRelaycastEventId } from './event-id.js';

function stripHash(channel: string): string {
  return channel.startsWith('#') ? channel.slice(1) : channel;
}

interface IdempotencyOption {
  idempotencyKey?: string;
}

interface ChannelListOptions {
  includeArchived?: boolean;
}

interface FileListOptions {
  uploadedBy?: string;
  limit?: number;
}

function normalizeAutoHeartbeatMs(value?: number | false): number | false {
  if (value === false) return false;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return 30_000;
}

function generateIdempotencyKey(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (typeof randomUuid === 'string' && randomUuid.length > 0) {
    return randomUuid;
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
}

function idempotencyHeaders(opts?: IdempotencyOption): RequestOptions {
  const key = opts?.idempotencyKey?.trim() || generateIdempotencyKey();
  return {
    headers: {
      'Idempotency-Key': key,
      'X-Idempotency-Key': key,
    },
  };
}

export interface AgentClientOptions {
  autoHeartbeatMs?: number | false;
  ws?: Omit<WsClientOptions, 'token' | 'baseUrl'>;
}

type RelaycastMessageHandler = (event: RelaycastMessageEvent) => void | Promise<void>;
type ManagedSubscription = {
  channels: Set<string>;
  handler: RelaycastMessageHandler;
  stops: Array<() => void>;
};

function normalizeSubscriptionChannel(channel: string): string {
  const trimmed = channel.trim();
  if (trimmed === '@self') return trimmed;
  return stripHash(trimmed);
}

function ensureRelaycastMessageEventId(event: RelaycastMessageEvent): RelaycastMessageEvent {
  if (typeof event.id === 'string' && event.id.length > 0) {
    return event;
  }
  return {
    ...event,
    id: stableRelaycastEventId(event.message.id),
  } as RelaycastMessageEvent;
}

export class AgentClient {
  public readonly client: HttpClient;
  private ws: WsClient | null = null;
  private autoHeartbeatMs: number | false;
  private autoHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pendingHeartbeat: Promise<void> | null = null;
  private wsOptions: Omit<WsClientOptions, 'token' | 'baseUrl'>;
  private manualSubscriptions = new Set<string>();
  private managedSubscriptions = new Map<symbol, ManagedSubscription>();
  private activeWsChannels = new Set<string>();

  constructor(client: HttpClient, options: AgentClientOptions = {}) {
    this.client = client;
    this.autoHeartbeatMs = normalizeAutoHeartbeatMs(options.autoHeartbeatMs);
    this.wsOptions = options.ws ?? {};
  }

  /**
   * Presence lifecycle ownership:
   * - worker identities should call `markOnline`/`heartbeat`/`markOffline`.
   * - broker identities should signal presence only when they directly own worker lifecycle.
   * - reader identities should not publish presence.
   */
  presence = {
    markOnline: async (): Promise<void> => {
      await this.client.post('/v1/agents/heartbeat', {});
    },
    heartbeat: async (): Promise<void> => {
      await this.client.post('/v1/agents/heartbeat', {});
    },
    markOffline: async (): Promise<void> => {
      this.stopAutoHeartbeat();
      await this.client.post('/v1/agents/disconnect', {});
    },
  };

  private startAutoHeartbeat(): void {
    this.stopAutoHeartbeat();
    if (this.autoHeartbeatMs === false) return;
    this.autoHeartbeatTimer = setInterval(() => {
      this.pendingHeartbeat = this.presence.heartbeat()
        .catch(() => {})
        .finally(() => { this.pendingHeartbeat = null; });
    }, this.autoHeartbeatMs);
  }

  private stopAutoHeartbeat(): void {
    if (this.autoHeartbeatTimer) {
      clearInterval(this.autoHeartbeatTimer);
      this.autoHeartbeatTimer = null;
    }
  }

  // === WebSocket ===

  connect(): void {
    if (this.ws) return;
    this.ws = new WsClient(withInternalWsOrigin(
      {
        token: this.client.apiKey,
        baseUrl: this.client.baseUrl,
        ...this.wsOptions,
      },
      {
        client: this.client.originClient,
        version: this.client.originVersion,
        ...(this.client.originActor ? { originActor: this.client.originActor } : {}),
        ...(this.client.agentRelayDistinctId ? { agentRelayDistinctId: this.client.agentRelayDistinctId } : {}),
      },
    ));
    this.ws.on('open', () => {
      void this.presence.markOnline().catch(() => {});
      this.startAutoHeartbeat();
      this.syncDesiredSubscriptions({ resetRemoteState: true });
    });
    this.ws.on('close', () => {
      this.stopAutoHeartbeat();
      this.activeWsChannels.clear();
    });
    this.ws.on('permanently_disconnected', () => {
      this.stopAutoHeartbeat();
      this.activeWsChannels.clear();
    });
    this.ws.connect();
  }

  /** Send a REST heartbeat to keep this agent online in PresenceDO without a WebSocket. */
  async heartbeat(): Promise<void> {
    await this.presence.heartbeat();
  }

  async disconnect(): Promise<void> {
    this.stopAutoHeartbeat();
    // Wait for any in-flight auto heartbeat to settle at PresenceDO so the
    // HTTP disconnect below is guaranteed to be the last presence mutation.
    if (this.pendingHeartbeat) {
      await this.pendingHeartbeat;
      this.pendingHeartbeat = null;
    }
    for (const subscription of this.managedSubscriptions.values()) {
      for (const stop of subscription.stops) {
        stop();
      }
    }
    this.managedSubscriptions.clear();
    this.manualSubscriptions.clear();
    if (this.ws) {
      this.ws.disconnect();
      this.ws = null;
    }
    this.activeWsChannels.clear();
    // Always send the HTTP disconnect — it works even without a WS and
    // serves as the authoritative presence update.
    await this.client.post('/v1/agents/disconnect', {}).catch(() => {});
  }

  subscribe(channels: string[]): void;
  subscribe(channels: string[], onMessage: RelaycastMessageHandler): Subscription;
  subscribe(channels: string[], onMessage?: RelaycastMessageHandler): void | Subscription {
    const normalized = [...new Set(channels.map(normalizeSubscriptionChannel).filter(Boolean))];
    if (normalized.length === 0) {
      if (onMessage) {
        return { channels: [], unsubscribe() {} };
      }
      return;
    }

    if (!onMessage) {
      for (const channel of normalized) {
        this.manualSubscriptions.add(channel);
      }
      this.syncDesiredSubscriptions();
      return;
    }

    this.connect();
    const key = Symbol('relaycast.subscription');
    const channelSet = new Set(normalized);
    const invoke = (event: RelaycastMessageEvent): void => {
      if (!this.matchesSubscription(channelSet, event)) {
        return;
      }
      void Promise.resolve()
        .then(() => onMessage(ensureRelaycastMessageEventId(event)))
        .catch((err) => {
          console.error('[relaycast] Subscription handler failed', err);
        });
    };

    const stops = [
      this.on.messageCreated((event) => invoke(event)),
      this.on.threadReply((event) => invoke(event)),
      this.on.dmReceived((event) => invoke(event)),
      this.on.groupDmReceived((event) => invoke(event)),
    ];

    this.managedSubscriptions.set(key, {
      channels: channelSet,
      handler: onMessage,
      stops,
    });
    this.syncDesiredSubscriptions();

    return {
      channels: Object.freeze([...normalized]),
      unsubscribe: () => {
        const current = this.managedSubscriptions.get(key);
        if (!current) return;
        this.managedSubscriptions.delete(key);
        for (const stop of current.stops) {
          stop();
        }
        this.syncDesiredSubscriptions();
      },
    };
  }

  unsubscribe(channels: string[]): void {
    const normalized = [...new Set(channels.map(normalizeSubscriptionChannel).filter(Boolean))];
    for (const channel of normalized) {
      this.manualSubscriptions.delete(channel);
    }
    this.syncDesiredSubscriptions();
  }

  private onEvent<T extends WsClientEvent>(eventType: string, handler: (e: T) => void): () => void {
    if (!this.ws) {
      throw new Error('WebSocket not connected. Call connect() first.');
    }
    return this.ws.on(eventType, handler as (e: WsClientEvent) => void);
  }

  on = {
    messageCreated:  (handler: (e: MessageCreatedEvent) => void): (() => void)  => this.onEvent('message.created', handler),
    messageUpdated:  (handler: (e: MessageUpdatedEvent) => void): (() => void)  => this.onEvent('message.updated', handler),
    threadReply:     (handler: (e: ThreadReplyEvent) => void): (() => void)     => this.onEvent('thread.reply', handler),
    messageRead:     (handler: (e: MessageReadEvent) => void): (() => void)     => this.onEvent('message.read', handler),
    messageReacted:  (handler: (e: MessageReactedEvent) => void): (() => void)  => this.onEvent('message.reacted', handler),
    dmReceived:      (handler: (e: DmReceivedEvent) => void): (() => void)      => this.onEvent('dm.received', handler),
    groupDmReceived: (handler: (e: GroupDmReceivedEvent) => void): (() => void) => this.onEvent('group_dm.received', handler),
    agentStatusChanged: (handler: (e: AgentStatusChangedEvent) => void): (() => void) => this.onEvent('agent.status.changed', handler),
    agentActive:     (handler: (e: AgentStatusActiveEvent) => void): (() => void)  => this.onEvent('agent.status.active', handler),
    agentOffline:    (handler: (e: AgentStatusOfflineEvent) => void): (() => void) => this.onEvent('agent.status.offline', handler),
    channelCreated:  (handler: (e: ChannelCreatedEvent) => void): (() => void)  => this.onEvent('channel.created', handler),
    channelUpdated:  (handler: (e: ChannelUpdatedEvent) => void): (() => void)  => this.onEvent('channel.updated', handler),
    channelArchived: (handler: (e: ChannelArchivedEvent) => void): (() => void) => this.onEvent('channel.archived', handler),
    memberJoined:    (handler: (e: MemberJoinedEvent) => void): (() => void)    => this.onEvent('member.joined', handler),
    memberLeft:      (handler: (e: MemberLeftEvent) => void): (() => void)      => this.onEvent('member.left', handler),
    channelMuted:    (handler: (e: ChannelMutedEvent) => void): (() => void)    => this.onEvent('member.channel_muted', handler),
    channelUnmuted:  (handler: (e: ChannelUnmutedEvent) => void): (() => void)  => this.onEvent('member.channel_unmuted', handler),
    fileUploaded:    (handler: (e: FileUploadedEvent) => void): (() => void)    => this.onEvent('file.uploaded', handler),
    webhookReceived: (handler: (e: WebhookReceivedEvent) => void): (() => void) => this.onEvent('webhook.received', handler),
    // Actions (agent-to-agent RPC)
    actionInvoked:   (handler: (e: ActionInvokedEvent) => void): (() => void)   => this.onEvent('action.invoked', handler),
    actionCompleted: (handler: (e: ActionCompletedEvent) => void): (() => void) => this.onEvent('action.completed', handler),
    actionFailed:    (handler: (e: ActionFailedEvent) => void): (() => void)    => this.onEvent('action.failed', handler),
    actionDenied:    (handler: (e: ActionDeniedEvent) => void): (() => void)    => this.onEvent('action.denied', handler),
    // Durable delivery lifecycle
    deliveryAccepted:  (handler: (e: DeliveryAcceptedEvent) => void): (() => void)  => this.onEvent('delivery.accepted', handler),
    deliveryDelivered: (handler: (e: DeliveryDeliveredEvent) => void): (() => void) => this.onEvent('delivery.delivered', handler),
    deliveryDeferred:  (handler: (e: DeliveryDeferredEvent) => void): (() => void)  => this.onEvent('delivery.deferred', handler),
    deliveryFailed:    (handler: (e: DeliveryFailedEvent) => void): (() => void)    => this.onEvent('delivery.failed', handler),
    // Lifecycle
    connected:    (handler: () => void): (() => void) => this.onEvent('open', handler as (e: never) => void),
    disconnected: (handler: () => void): (() => void) => this.onEvent('close', handler as (e: never) => void),
    error:        (handler: () => void): (() => void) => this.onEvent('error', handler as (e: never) => void),
    reconnecting: (handler: (attempt: number) => void): (() => void) => {
      if (!this.ws) {
        throw new Error('WebSocket not connected. Call connect() first.');
      }
      return this.ws.on('reconnecting', (e: WsClientEvent) => handler((e as WsReconnectingEvent).attempt));
    },
    permanentlyDisconnected: (handler: (attempt: number) => void): (() => void) => {
      if (!this.ws) {
        throw new Error('WebSocket not connected. Call connect() first.');
      }
      return this.ws.on('permanently_disconnected', (e: WsClientEvent) =>
        handler((e as WsPermanentlyDisconnectedEvent).attempt));
    },
    resynced: (handler: (info: { replayed: number; gapDetected: boolean }) => void): (() => void) => {
      if (!this.ws) {
        throw new Error('WebSocket not connected. Call connect() first.');
      }
      return this.ws.on('resynced', (e: WsClientEvent) => {
        const event = e as WsResyncedEvent;
        handler({ replayed: event.replayed, gapDetected: event.gapDetected });
      });
    },
    // Wildcard
    any: (handler: (e: WsClientEvent) => void): (() => void) => {
      if (!this.ws) {
        throw new Error('WebSocket not connected. Call connect() first.');
      }
      return this.ws.on('*', handler);
    },
  };

  // === Messages ===

  async me(): Promise<Agent> {
    return this.client.get('/v1/agent');
  }

  async send(
    channel: string,
    text: string,
    opts?: {
      attachments?: string[];
      blocks?: MessageBlock[];
      mode?: 'wait' | 'steer';
      idempotencyKey?: string;
    },
  ): Promise<MessageWithMeta> {
    const name = stripHash(channel);
    const body: PostMessageRequest = {
      text,
      ...(opts?.attachments ? { attachments: opts.attachments } : {}),
      ...(opts?.blocks ? { blocks: opts.blocks } : {}),
      mode: opts?.mode ?? 'wait',
    };
    return this.client.post(
      `/v1/channels/${encodeURIComponent(name)}/messages`,
      body,
      idempotencyHeaders(opts),
    );
  }

  post(
    channel: string,
    text: string,
    opts?: {
      attachments?: string[];
      blocks?: MessageBlock[];
      mode?: 'wait' | 'steer';
      idempotencyKey?: string;
    },
  ): Promise<MessageWithMeta> {
    return this.send(channel, text, opts);
  }

  async messages(
    channel: string,
    opts?: MessageListQuery,
  ): Promise<MessageWithMeta[]> {
    const name = stripHash(channel);
    const query: Record<string, string> = {};
    if (opts?.limit) query.limit = String(opts.limit);
    if (opts?.before) query.before = opts.before;
    if (opts?.after) query.after = opts.after;
    return this.client.get(
      `/v1/channels/${encodeURIComponent(name)}/messages`,
      query,
    );
  }

  async message(id: string): Promise<MessageWithMeta> {
    return this.client.get(`/v1/messages/${encodeURIComponent(id)}`);
  }

  async reply(
    id: string,
    text: string,
    opts?: { blocks?: MessageBlock[]; idempotencyKey?: string },
  ): Promise<MessageWithMeta> {
    const body: ThreadReplyRequest = {
      text,
      ...(opts?.blocks ? { blocks: opts.blocks } : {}),
    };
    return this.client.post(
      `/v1/messages/${encodeURIComponent(id)}/replies`,
      body,
      idempotencyHeaders(opts),
    );
  }

  async thread(
    id: string,
    opts?: MessageListQuery,
  ): Promise<{ parent: MessageWithMeta; replies: MessageWithMeta[] }> {
    const query: Record<string, string> = {};
    if (opts?.limit) query.limit = String(opts.limit);
    if (opts?.before) query.before = opts.before;
    if (opts?.after) query.after = opts.after;
    return this.client.get(
      `/v1/messages/${encodeURIComponent(id)}/replies`,
      query,
    );
  }

  // === DMs ===

  async dm(
    agent: string,
    text: string,
    opts?: (IdempotencyOption & { mode?: 'wait' | 'steer'; attachments?: string[] }),
  ): Promise<SendDmResponse> {
    const body: SendDmRequest = {
      to: agent,
      text,
      ...(opts?.attachments ? { attachments: opts.attachments } : {}),
      mode: opts?.mode ?? 'wait',
    };
    return this.client.post('/v1/dm', body, idempotencyHeaders(opts));
  }

  dms = {
    conversations: (): Promise<DmConversationSummary[]> =>
      this.client.get('/v1/dm/conversations'),

    messages: (
      conversationId: string,
      opts?: MessageListQuery,
    ): Promise<DmMessage[]> => {
      const query: Record<string, string> = {};
      if (opts?.limit) query.limit = String(opts.limit);
      if (opts?.before) query.before = opts.before;
      if (opts?.after) query.after = opts.after;
      return this.client.get(
        `/v1/dm/${encodeURIComponent(conversationId)}/messages`,
        query,
      );
    },

    createGroup: (
      opts: CreateGroupDmRequest,
      idempotency?: IdempotencyOption,
    ): Promise<CreateGroupDmResponse> =>
      this.client.post('/v1/dm/group', opts, idempotencyHeaders(idempotency)),

    sendMessage: (
      conversationId: string,
      text: string,
      opts?: (IdempotencyOption & { attachments?: string[]; mode?: 'wait' | 'steer' }),
    ): Promise<GroupDmMessageResponse> =>
      this.client.post(
        `/v1/dm/${encodeURIComponent(conversationId)}/messages`,
        {
          text,
          ...(opts?.attachments ? { attachments: opts.attachments } : {}),
          mode: opts?.mode ?? 'wait',
        },
        idempotencyHeaders(opts),
      ),

    addParticipant: (
      conversationId: string,
      agent: string,
    ): Promise<GroupDmParticipantResponse> =>
      this.client.post(
        `/v1/dm/${encodeURIComponent(conversationId)}/participants`,
        { agentName: agent },
      ),

    removeParticipant: (
      conversationId: string,
      agent: string,
    ): Promise<void> =>
      this.client.delete(
        `/v1/dm/${encodeURIComponent(conversationId)}/participants/${encodeURIComponent(agent)}`,
      ),
  };

  private matchesSubscription(channels: Set<string>, event: RelaycastMessageEvent): boolean {
    switch (event.type) {
      case 'dm.received':
      case 'group_dm.received':
        return channels.has('@self');
      case 'message.created':
      case 'thread.reply':
        return channels.has(stripHash(event.channel));
      default:
        return false;
    }
  }

  private desiredWsChannels(): Set<string> {
    const desired = new Set<string>();
    for (const channel of this.manualSubscriptions) {
      if (channel !== '@self') {
        desired.add(channel);
      }
    }
    for (const subscription of this.managedSubscriptions.values()) {
      for (const channel of subscription.channels) {
        if (channel !== '@self') {
          desired.add(channel);
        }
      }
    }
    return desired;
  }

  private syncDesiredSubscriptions(options: { resetRemoteState?: boolean } = {}): void {
    if (!this.ws) {
      return;
    }

    const desired = this.desiredWsChannels();
    if (!this.ws.connected) {
      if (options.resetRemoteState) {
        this.activeWsChannels.clear();
      }
      return;
    }

    if (options.resetRemoteState) {
      this.activeWsChannels.clear();
    }

    const toSubscribe = [...desired].filter((channel) => !this.activeWsChannels.has(channel));
    const toUnsubscribe = [...this.activeWsChannels].filter((channel) => !desired.has(channel));

    if (toSubscribe.length > 0) {
      this.ws.subscribe(toSubscribe);
    }
    if (toUnsubscribe.length > 0) {
      this.ws.unsubscribe(toUnsubscribe);
    }

    this.activeWsChannels = desired;
  }

  // === Channels ===

  channels = {
    create: (data: CreateChannelRequest): Promise<Channel> =>
      this.client.post('/v1/channels', data),

    list: (opts?: ChannelListOptions): Promise<Channel[]> => {
      const query: Record<string, string> = {};
      if (opts?.includeArchived) query.includeArchived = 'true';
      return this.client.get('/v1/channels', query);
    },

    get: (name: string): Promise<Channel & { members: ChannelMemberInfo[] }> =>
      this.client.get(`/v1/channels/${encodeURIComponent(name)}`),

    join: (name: string): Promise<JoinChannelResponse> =>
      this.client.post(`/v1/channels/${encodeURIComponent(name)}/join`),

    leave: async (name: string): Promise<void> => {
      await this.client.post(`/v1/channels/${encodeURIComponent(name)}/leave`);
    },

    setTopic: (name: string, topic: string): Promise<Channel> =>
      this.client.patch(`/v1/channels/${encodeURIComponent(name)}/topic`, { topic }),

    archive: (name: string): Promise<void> =>
      this.client.delete(`/v1/channels/${encodeURIComponent(name)}`),

    invite: (channel: string, agent: string): Promise<InviteChannelResponse> =>
      this.client.post(
        `/v1/channels/${encodeURIComponent(channel)}/invite`,
        { agentName: agent },
      ),

    members: (name: string): Promise<ChannelMemberInfo[]> =>
      this.client.get(`/v1/channels/${encodeURIComponent(name)}/members`),

    update: (name: string, data: UpdateChannelRequest): Promise<Channel> =>
      this.client.patch(`/v1/channels/${encodeURIComponent(name)}`, data),

    mute: async (name: string): Promise<void> => {
      await this.client.post(`/v1/channels/${encodeURIComponent(name)}/mute`);
    },

    unmute: async (name: string): Promise<void> => {
      await this.client.post(`/v1/channels/${encodeURIComponent(name)}/unmute`);
    },
  };

  // === Reactions ===

  async react(messageId: string, emoji: string): Promise<AddedReaction> {
    return this.client.post(
      `/v1/messages/${encodeURIComponent(messageId)}/reactions`,
      { emoji },
    );
  }

  async unreact(messageId: string, emoji: string): Promise<void> {
    return this.client.delete(
      `/v1/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(emoji)}`,
    );
  }

  async reactions(messageId: string): Promise<ReactionGroup[]> {
    return this.client.get(
      `/v1/messages/${encodeURIComponent(messageId)}/reactions`,
    );
  }

  // === Search ===

  async search(
    query: string,
    opts?: {
      channel?: string;
      from?: string;
      limit?: number;
      before?: string;
      after?: string;
    },
  ): Promise<SearchMessageResult[]> {
    const params: Record<string, string> = { q: query };
    if (opts?.channel) params.channel = opts.channel;
    if (opts?.from) params.from = opts.from;
    if (opts?.limit) params.limit = String(opts.limit);
    if (opts?.before) params.before = opts.before;
    if (opts?.after) params.after = opts.after;
    return this.client.get('/v1/search', params);
  }

  // === Inbox ===

  async inbox(options?: { limit?: number }): Promise<InboxResponse> {
    const params: Record<string, string> = {};
    if (options?.limit != null) params.limit = String(options.limit);
    return this.client.get('/v1/inbox', params);
  }

  // === Read Receipts ===

  async markRead(messageId: string): Promise<ReadReceipt> {
    return this.client.post(
      `/v1/messages/${encodeURIComponent(messageId)}/read`,
    );
  }

  async readers(messageId: string): Promise<ReaderInfo[]> {
    return this.client.get(
      `/v1/messages/${encodeURIComponent(messageId)}/readers`,
    );
  }

  async readStatus(channel: string): Promise<ChannelReadStatus[]> {
    const name = stripHash(channel);
    return this.client.get(
      `/v1/channels/${encodeURIComponent(name)}/read-status`,
    );
  }

  // === Durable Delivery ===

  /**
   * List durable delivery items queued for this agent. Defaults to the
   * non-terminal queue (queued + delivered) so an offline consumer can replay
   * what it missed on reconnect. Each item carries the message payload.
   */
  async deliveries(options?: { status?: DeliveryStatus; limit?: number }): Promise<DeliveryItem[]> {
    const params: Record<string, string> = {};
    if (options?.status) params.status = options.status;
    if (options?.limit != null) params.limit = String(options.limit);
    return this.client.get('/v1/deliveries', params);
  }

  /** Idempotently acknowledge a delivery, transitioning it to `acked`. */
  async ackDelivery(deliveryId: string): Promise<Delivery> {
    return this.client.post(
      `/v1/deliveries/${encodeURIComponent(deliveryId)}/ack`,
    );
  }

  /** Idempotently record a delivery as `failed` with optional error/retryability. */
  async failDelivery(deliveryId: string, options?: FailDeliveryRequest): Promise<Delivery> {
    return this.client.post(
      `/v1/deliveries/${encodeURIComponent(deliveryId)}/fail`,
      options ?? {},
    );
  }

  /** Idempotently defer a delivery until `availableAt`. */
  async deferDelivery(deliveryId: string, options: DeferDeliveryRequest): Promise<Delivery> {
    return this.client.post(
      `/v1/deliveries/${encodeURIComponent(deliveryId)}/defer`,
      options,
    );
  }

  // === Actions ===

  actions = {
    invoke: (
      name: string,
      input?: Record<string, unknown>,
    ): Promise<InvokeActionResult> =>
      this.client.post(`/v1/actions/${encodeURIComponent(name)}/invoke`, { input }),

    completeInvocation: (
      name: string,
      invocationId: string,
      data: CompleteInvocationRequest,
    ): Promise<ActionInvocation> =>
      this.client.post(
        `/v1/actions/${encodeURIComponent(name)}/invocations/${encodeURIComponent(invocationId)}/complete`,
        data,
      ),

    getInvocation: (name: string, invocationId: string): Promise<ActionInvocation> =>
      this.client.get(
        `/v1/actions/${encodeURIComponent(name)}/invocations/${encodeURIComponent(invocationId)}`,
      ),
  };

  // === Files ===

  files = {
    upload: (data: UploadRequest): Promise<UploadResponse> =>
      this.client.post('/v1/files/upload', data),

    complete: (fileId: string): Promise<CompleteUploadResponse> =>
      this.client.post(`/v1/files/${encodeURIComponent(fileId)}/complete`),

    get: (fileId: string): Promise<FileInfo> =>
      this.client.get(`/v1/files/${encodeURIComponent(fileId)}`),

    delete: (fileId: string): Promise<void> =>
      this.client.delete(`/v1/files/${encodeURIComponent(fileId)}`),

    list: (opts?: FileListOptions): Promise<FileInfo[]> => {
      const query: Record<string, string> = {};
      if (opts?.uploadedBy) query.uploadedBy = opts.uploadedBy;
      if (opts?.limit) query.limit = String(opts.limit);
      return this.client.get('/v1/files', query);
    },
  };
}
