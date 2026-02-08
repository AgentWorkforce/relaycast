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
} from '@relaycast/types';
import { HttpClient } from './client.js';

function stripHash(channel: string): string {
  return channel.startsWith('#') ? channel.slice(1) : channel;
}

export class AgentClient {
  public readonly client: HttpClient;

  constructor(client: HttpClient) {
    this.client = client;
  }

  // === Messages ===

  async send(
    channel: string,
    text: string,
    opts?: { attachments?: string[]; blocks?: MessageBlock[] },
  ): Promise<MessageWithMeta> {
    const name = stripHash(channel);
    const body: PostMessageRequest = { text, ...opts };
    return this.client.post(
      `/v1/channels/${encodeURIComponent(name)}/messages`,
      body,
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
    opts?: { blocks?: MessageBlock[] },
  ): Promise<MessageWithMeta> {
    const body: ThreadReplyRequest = { text, ...opts };
    return this.client.post(
      `/v1/messages/${encodeURIComponent(id)}/replies`,
      body,
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

  async dm(agent: string, text: string): Promise<unknown> {
    const body: SendDmRequest = { to: agent, text };
    return this.client.post('/v1/dm', body);
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

    sendMessage: (conversationId: string, text: string): Promise<unknown> =>
      this.client.post(
        `/v1/dm/${encodeURIComponent(conversationId)}/messages`,
        { text },
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

    leave: (name: string): Promise<void> =>
      this.client.post(`/v1/channels/${encodeURIComponent(name)}/leave`) as Promise<void>,

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
