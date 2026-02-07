import type {
  PostMessageRequest,
  MessageListQuery,
  MessageWithMeta,
  ThreadReplyRequest,
  SendDmRequest,
  CreateGroupDmRequest,
  DmConversationSummary,
} from '@agent-relay/types';
import { HttpClient } from './client.js';

export class AgentClient {
  public readonly client: HttpClient;

  constructor(client: HttpClient) {
    this.client = client;
  }

  async send(
    channel: string,
    text: string,
    opts?: { attachments?: string[] },
  ): Promise<MessageWithMeta> {
    const name = channel.startsWith('#') ? channel.slice(1) : channel;
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
    const name = channel.startsWith('#') ? channel.slice(1) : channel;
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

  async reply(id: string, text: string): Promise<MessageWithMeta> {
    const body: ThreadReplyRequest = { text };
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
}
