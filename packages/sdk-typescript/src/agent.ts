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
  InvokeCommandRequest,
  CommandInvokeResult,
  WsClientEvent,
  MessageCreatedEvent,
  MessageUpdatedEvent,
  ThreadReplyEvent,
  MessageReadEvent,
  ReactionAddedEvent,
  ReactionRemovedEvent,
  DmReceivedEvent,
  GroupDmReceivedEvent,
  AgentOnlineEvent,
  AgentOfflineEvent,
  ChannelCreatedEvent,
  ChannelUpdatedEvent,
  ChannelArchivedEvent,
  MemberJoinedEvent,
  MemberLeftEvent,
  FileUploadedEvent,
  WebhookReceivedEvent,
  CommandInvokedEvent,
  WsReconnectingEvent,
  WsPermanentlyDisconnectedEvent,
} from './types.js';
import { HttpClient, type RequestOptions } from './client.js';
import { WsClient, type WsClientOptions, withInternalWsOrigin } from './ws.js';

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

export interface AgentClientWsHandlers {
  any?: (event: WsClientEvent) => void;
  connected?: () => void;
  disconnected?: () => void;
  error?: () => void;
  reconnecting?: (attempt: number) => void;
  permanentlyDisconnected?: (attempt: number) => void;
}

export class AgentClient {
  public readonly client: HttpClient;
  private ws: WsClient | null = null;
  private autoHeartbeatMs: number | false;
  private autoHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private wsOptions: Omit<WsClientOptions, 'token' | 'baseUrl'>;

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
      void this.presence.heartbeat().catch(() => {});
    }, this.autoHeartbeatMs);
  }

  private stopAutoHeartbeat(): void {
    if (this.autoHeartbeatTimer) {
      clearInterval(this.autoHeartbeatTimer);
      this.autoHeartbeatTimer = null;
    }
  }

  private createWsClient(): WsClient {
    const ws = new WsClient(withInternalWsOrigin(
      {
        token: this.client.apiKey,
        baseUrl: this.client.baseUrl,
        ...this.wsOptions,
      },
      {
        surface: this.client.originSurface,
        client: this.client.originClient,
        version: this.client.originVersion,
      },
    ));
    ws.on('open', () => {
      void this.presence.markOnline().catch(() => {});
      this.startAutoHeartbeat();
    });
    ws.on('close', () => {
      this.stopAutoHeartbeat();
    });
    ws.on('permanently_disconnected', () => {
      this.stopAutoHeartbeat();
    });
    return ws;
  }

  private ensureWs(): WsClient {
    if (!this.ws) {
      this.ws = this.createWsClient();
    }
    return this.ws;
  }

  // === WebSocket ===

  connect(): void {
    this.ensureWs().connect();
  }

  attachWsHandlers(handlers: AgentClientWsHandlers): () => void {
    const ws = this.ensureWs();
    const unsubscribers: Array<() => void> = [];

    if (handlers.any) {
      unsubscribers.push(ws.on('*', handlers.any));
    }
    if (handlers.connected) {
      unsubscribers.push(ws.on('open', () => {
        handlers.connected?.();
      }));
    }
    if (handlers.disconnected) {
      unsubscribers.push(ws.on('close', () => {
        handlers.disconnected?.();
      }));
    }
    if (handlers.error) {
      unsubscribers.push(ws.on('error', () => {
        handlers.error?.();
      }));
    }
    if (handlers.reconnecting) {
      unsubscribers.push(ws.on('reconnecting', (event) => {
        handlers.reconnecting?.((event as WsReconnectingEvent).attempt);
      }));
    }
    if (handlers.permanentlyDisconnected) {
      unsubscribers.push(ws.on('permanently_disconnected', (event) => {
        handlers.permanentlyDisconnected?.((event as WsPermanentlyDisconnectedEvent).attempt);
      }));
    }

    return () => {
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
    };
  }

  /** Send a REST heartbeat to keep this agent online in PresenceDO without a WebSocket. */
  async heartbeat(): Promise<void> {
    await this.presence.heartbeat();
  }

  async disconnect(): Promise<void> {
    this.stopAutoHeartbeat();
    if (this.ws) {
      // Notify the server before closing the WebSocket so presence
      // updates immediately (works around local DO hibernation issues).
      await this.presence.markOffline().catch(() => {});
      this.ws.disconnect();
      this.ws = null;
    }
  }

  subscribe(channels: string[]): void {
    this.ws?.subscribe(channels);
  }

  unsubscribe(channels: string[]): void {
    this.ws?.unsubscribe(channels);
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
    reactionAdded:   (handler: (e: ReactionAddedEvent) => void): (() => void)   => this.onEvent('reaction.added', handler),
    reactionRemoved: (handler: (e: ReactionRemovedEvent) => void): (() => void) => this.onEvent('reaction.removed', handler),
    dmReceived:      (handler: (e: DmReceivedEvent) => void): (() => void)      => this.onEvent('dm.received', handler),
    groupDmReceived: (handler: (e: GroupDmReceivedEvent) => void): (() => void) => this.onEvent('group_dm.received', handler),
    agentOnline:     (handler: (e: AgentOnlineEvent) => void): (() => void)     => this.onEvent('agent.online', handler),
    agentOffline:    (handler: (e: AgentOfflineEvent) => void): (() => void)    => this.onEvent('agent.offline', handler),
    channelCreated:  (handler: (e: ChannelCreatedEvent) => void): (() => void)  => this.onEvent('channel.created', handler),
    channelUpdated:  (handler: (e: ChannelUpdatedEvent) => void): (() => void)  => this.onEvent('channel.updated', handler),
    channelArchived: (handler: (e: ChannelArchivedEvent) => void): (() => void) => this.onEvent('channel.archived', handler),
    memberJoined:    (handler: (e: MemberJoinedEvent) => void): (() => void)    => this.onEvent('member.joined', handler),
    memberLeft:      (handler: (e: MemberLeftEvent) => void): (() => void)      => this.onEvent('member.left', handler),
    fileUploaded:    (handler: (e: FileUploadedEvent) => void): (() => void)    => this.onEvent('file.uploaded', handler),
    webhookReceived: (handler: (e: WebhookReceivedEvent) => void): (() => void) => this.onEvent('webhook.received', handler),
    commandInvoked:  (handler: (e: CommandInvokedEvent) => void): (() => void)  => this.onEvent('command.invoked', handler),
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
    // Wildcard
    any: (handler: (e: WsClientEvent) => void): (() => void) => {
      if (!this.ws) {
        throw new Error('WebSocket not connected. Call connect() first.');
      }
      return this.ws.on('*', handler);
    },
  };

  // === Messages ===

  async send(
    channel: string,
    text: string,
    opts?: { attachments?: string[]; blocks?: MessageBlock[]; idempotencyKey?: string },
  ): Promise<MessageWithMeta> {
    const name = stripHash(channel);
    const body: PostMessageRequest = {
      text,
      ...(opts?.attachments ? { attachments: opts.attachments } : {}),
      ...(opts?.blocks ? { blocks: opts.blocks } : {}),
    };
    return this.client.post(
      `/v1/channels/${encodeURIComponent(name)}/messages`,
      body,
      idempotencyHeaders(opts),
    );
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

  async dm(agent: string, text: string, opts?: IdempotencyOption): Promise<SendDmResponse> {
    const body: SendDmRequest = { to: agent, text };
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
      opts?: IdempotencyOption,
    ): Promise<GroupDmMessageResponse> =>
      this.client.post(
        `/v1/dm/${encodeURIComponent(conversationId)}/messages`,
        { text },
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

  async inbox(): Promise<InboxResponse> {
    return this.client.get('/v1/inbox');
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

  // === Commands ===

  commands = {
    invoke: (
      command: string,
      data: InvokeCommandRequest,
    ): Promise<CommandInvokeResult> =>
      this.client.post(
        `/v1/commands/${encodeURIComponent(command)}/invoke`,
        data,
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
