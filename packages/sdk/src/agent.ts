import type {
  PostMessageRequest,
  MessageListQuery,
  MessageWithMeta,
  MessageBlock,
  ThreadReplyRequest,
  SendDmRequest,
  CreateGroupDmRequest,
  DmConversationSummary,
  CreateChannelRequest,
  UpdateChannelRequest,
  Channel,
  ChannelMemberInfo,
  ReactionGroup,
  InboxResponse,
  ReaderInfo,
  ChannelReadStatus,
  UploadRequest,
  UploadResponse,
  FileInfo,
  InvokeCommandRequest,
  CommandInvocation,
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
} from '@relaycast/types';
import { HttpClient, type RequestOptions } from './client.js';
import { WsClient } from './ws.js';

function stripHash(channel: string): string {
  return channel.startsWith('#') ? channel.slice(1) : channel;
}

interface IdempotencyOption {
  idempotencyKey?: string;
}

function idempotencyHeaders(opts?: IdempotencyOption): RequestOptions | undefined {
  if (!opts?.idempotencyKey) return undefined;
  return { headers: { 'Idempotency-Key': opts.idempotencyKey } };
}

export class AgentClient {
  public readonly client: HttpClient;
  private ws: WsClient | null = null;

  constructor(client: HttpClient) {
    this.client = client;
  }

  // === WebSocket ===

  connect(): void {
    if (this.ws) return;
    this.ws = new WsClient({
      token: this.client.apiKey,
      baseUrl: this.client.baseUrl,
    });
    this.ws.connect();
  }

  disconnect(): void {
    if (this.ws) {
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
    reconnecting: (handler: (attempt: number) => void): (() => void) => {
      if (!this.ws) {
        throw new Error('WebSocket not connected. Call connect() first.');
      }
      return this.ws.on('reconnecting', (e: WsClientEvent) => handler((e as WsReconnectingEvent).attempt));
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

  async dm(agent: string, text: string, opts?: IdempotencyOption): Promise<unknown> {
    const body: SendDmRequest = { to: agent, text };
    return this.client.post('/v1/dm', body, idempotencyHeaders(opts));
  }

  dms = {
    conversations: (): Promise<DmConversationSummary[]> =>
      this.client.get('/v1/dm/conversations'),

    messages: (
      conversationId: string,
      opts?: MessageListQuery,
    ): Promise<MessageWithMeta[]> => {
      const query: Record<string, string> = {};
      if (opts?.limit) query.limit = String(opts.limit);
      if (opts?.before) query.before = opts.before;
      if (opts?.after) query.after = opts.after;
      return this.client.get(
        `/v1/dm/${encodeURIComponent(conversationId)}/messages`,
        query,
      );
    },

    createGroup: (opts: CreateGroupDmRequest): Promise<unknown> =>
      this.client.post('/v1/dm/group', opts),

    sendMessage: (
      conversationId: string,
      text: string,
      opts?: IdempotencyOption,
    ): Promise<unknown> =>
      this.client.post(
        `/v1/dm/${encodeURIComponent(conversationId)}/messages`,
        { text },
        idempotencyHeaders(opts),
      ),

    addParticipant: (
      conversationId: string,
      agent: string,
    ): Promise<unknown> =>
      this.client.post(
        `/v1/dm/${encodeURIComponent(conversationId)}/participants`,
        { agent },
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

    list: (opts?: { include_archived?: boolean }): Promise<Channel[]> => {
      const query: Record<string, string> = {};
      if (opts?.include_archived) query.include_archived = 'true';
      return this.client.get('/v1/channels', query);
    },

    get: (name: string): Promise<Channel & { members: ChannelMemberInfo[] }> =>
      this.client.get(`/v1/channels/${encodeURIComponent(name)}`),

    join: (name: string): Promise<unknown> =>
      this.client.post(`/v1/channels/${encodeURIComponent(name)}/join`),

    leave: async (name: string): Promise<void> => {
      await this.client.post(`/v1/channels/${encodeURIComponent(name)}/leave`);
    },

    setTopic: (name: string, topic: string): Promise<Channel> =>
      this.client.patch(`/v1/channels/${encodeURIComponent(name)}/topic`, { topic }),

    archive: (name: string): Promise<void> =>
      this.client.delete(`/v1/channels/${encodeURIComponent(name)}`),

    invite: (channel: string, agent: string): Promise<unknown> =>
      this.client.post(
        `/v1/channels/${encodeURIComponent(channel)}/invite`,
        { agent },
      ),

    members: (name: string): Promise<ChannelMemberInfo[]> =>
      this.client.get(`/v1/channels/${encodeURIComponent(name)}/members`),

    update: (name: string, data: UpdateChannelRequest): Promise<Channel> =>
      this.client.patch(`/v1/channels/${encodeURIComponent(name)}`, data),
  };

  // === Reactions ===

  async react(messageId: string, emoji: string): Promise<unknown> {
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
  ): Promise<unknown[]> {
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

  async markRead(messageId: string): Promise<unknown> {
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
    ): Promise<CommandInvocation> =>
      this.client.post(
        `/v1/commands/${encodeURIComponent(command)}/invoke`,
        data,
      ),
  };

  // === Files ===

  files = {
    upload: (data: UploadRequest): Promise<UploadResponse> =>
      this.client.post('/v1/files/upload', data),

    complete: (fileId: string): Promise<FileInfo> =>
      this.client.post(`/v1/files/${encodeURIComponent(fileId)}/complete`),

    get: (fileId: string): Promise<FileInfo> =>
      this.client.get(`/v1/files/${encodeURIComponent(fileId)}`),

    delete: (fileId: string): Promise<void> =>
      this.client.delete(`/v1/files/${encodeURIComponent(fileId)}`),

    list: (opts?: { uploaded_by?: string; limit?: number }): Promise<FileInfo[]> => {
      const query: Record<string, string> = {};
      if (opts?.uploaded_by) query.uploaded_by = opts.uploaded_by;
      if (opts?.limit) query.limit = String(opts.limit);
      return this.client.get('/v1/files', query);
    },
  };
}
