import { describe, it, expect, expectTypeOf } from 'vitest';
import { DeliverySchema, DeliveryItemSchema, ServerEventSchema } from '../index.js';
import type {
  Workspace,
  CreateWorkspaceRequest,
  CreateWorkspaceResponse,
  WorkspaceLookup,
  UpdateWorkspaceRequest,
  Agent,
  AgentType,
  AgentStatus,
  CreateAgentRequest,
  CreateAgentResponse,
  UpdateAgentRequest,
  Channel,
  ChannelMember,
  CreateChannelRequest,
  ChannelMemberInfo,
  Message,
  MessageWithMeta,
  PostMessageRequest,
  MessageListQuery,
  Reaction,
  AddReactionRequest,
  ReactionGroup,
  FileRecord,
  FileStatus,
  UploadRequest,
  UploadResponse,
  FileAttachment,
  FileInfo,
  ReadReceipt,
  ReaderInfo,
  ChannelReadStatus,
  DmConversation,
  DmType,
  DmParticipant,
  DmMessage,
  SendDmRequest,
  CreateGroupDmRequest,
  DmConversationSummary,
  ApiSuccess,
  ApiError,
  ApiResponse,
  InboxResponse,
  ClientEvent,
  ServerEvent,
  MessageCreatedEvent,
  MessageReactedEvent,
  AgentStatusActiveEvent,
  PongEvent,
} from '../index.js';

describe('Type definitions', () => {
  // ============================================
  // Workspace types
  // ============================================
  it('Workspace has required fields', () => {
    expectTypeOf<Workspace>().toHaveProperty('id');
    expectTypeOf<Workspace>().toHaveProperty('name');
    expectTypeOf<Workspace>().toHaveProperty('api_key_hash');
    expectTypeOf<Workspace>().toHaveProperty('system_prompt');
    expectTypeOf<Workspace>().toHaveProperty('plan');
    expectTypeOf<Workspace>().toHaveProperty('created_at');
    expectTypeOf<Workspace>().toHaveProperty('metadata');
  });

  it('Workspace plan is a union type', () => {
    expectTypeOf<'free'>().toMatchTypeOf<Workspace['plan']>();
    expectTypeOf<'pro'>().toMatchTypeOf<Workspace['plan']>();
    expectTypeOf<'enterprise'>().toMatchTypeOf<Workspace['plan']>();
  });

  it('CreateWorkspaceRequest has name', () => {
    expectTypeOf<CreateWorkspaceRequest>().toHaveProperty('name');
  });

  it('CreateWorkspaceResponse has api_key', () => {
    expectTypeOf<CreateWorkspaceResponse>().toHaveProperty('api_key');
    expectTypeOf<CreateWorkspaceResponse>().toHaveProperty('workspace_id');
  });

  it('WorkspaceLookup exposes public lookup fields', () => {
    expectTypeOf<WorkspaceLookup>().toHaveProperty('id');
    expectTypeOf<WorkspaceLookup>().toHaveProperty('name');
    expectTypeOf<WorkspaceLookup>().toHaveProperty('created_at');
  });

  it('UpdateWorkspaceRequest fields are optional', () => {
    const empty: UpdateWorkspaceRequest = {};
    expectTypeOf(empty).toMatchTypeOf<UpdateWorkspaceRequest>();
  });

  // ============================================
  // Agent types
  // ============================================
  it('Agent has required fields', () => {
    expectTypeOf<Agent>().toHaveProperty('id');
    expectTypeOf<Agent>().toHaveProperty('name');
    expectTypeOf<Agent>().toHaveProperty('type');
    expectTypeOf<Agent>().toHaveProperty('status');
    expectTypeOf<Agent>().toHaveProperty('persona');
    expectTypeOf<Agent>().toHaveProperty('metadata');
    expectTypeOf<Agent>().toHaveProperty('last_seen');
    expectTypeOf<Agent>().toHaveProperty('created_at');
    expectTypeOf<Agent>().toHaveProperty('channels');
  });

  it('AgentType union', () => {
    expectTypeOf<'agent'>().toMatchTypeOf<AgentType>();
    expectTypeOf<'human'>().toMatchTypeOf<AgentType>();
    expectTypeOf<'system'>().toMatchTypeOf<AgentType>();
  });

  it('AgentStatus union', () => {
    expectTypeOf<'online'>().toMatchTypeOf<AgentStatus>();
    expectTypeOf<'offline'>().toMatchTypeOf<AgentStatus>();
    expectTypeOf<'away'>().toMatchTypeOf<AgentStatus>();
  });

  it('CreateAgentResponse has token', () => {
    expectTypeOf<CreateAgentResponse>().toHaveProperty('token');
  });

  // ============================================
  // Channel types
  // ============================================
  it('Channel has required fields', () => {
    expectTypeOf<Channel>().toHaveProperty('id');
    expectTypeOf<Channel>().toHaveProperty('workspace_id');
    expectTypeOf<Channel>().toHaveProperty('name');
    expectTypeOf<Channel>().toHaveProperty('channel_type');
    expectTypeOf<Channel>().toHaveProperty('is_archived');
  });

  it('ChannelMember has composite key fields', () => {
    expectTypeOf<ChannelMember>().toHaveProperty('channel_id');
    expectTypeOf<ChannelMember>().toHaveProperty('agent_id');
    expectTypeOf<ChannelMember>().toHaveProperty('role');
    expectTypeOf<ChannelMember>().toHaveProperty('last_read_id');
  });

  // ============================================
  // Message types
  // ============================================
  it('Message has required fields', () => {
    expectTypeOf<Message>().toHaveProperty('id');
    expectTypeOf<Message>().toHaveProperty('workspace_id');
    expectTypeOf<Message>().toHaveProperty('channel_id');
    expectTypeOf<Message>().toHaveProperty('agent_id');
    expectTypeOf<Message>().toHaveProperty('thread_id');
    expectTypeOf<Message>().toHaveProperty('body');
    expectTypeOf<Message>().toHaveProperty('has_attachments');
  });

  it('MessageWithMeta has enriched fields', () => {
    expectTypeOf<MessageWithMeta>().toHaveProperty('reply_count');
    expectTypeOf<MessageWithMeta>().toHaveProperty('reactions');
    expectTypeOf<MessageWithMeta>().toHaveProperty('read_by_count');
    expectTypeOf<MessageWithMeta>().toHaveProperty('attachments');
  });

  // ============================================
  // Reaction types
  // ============================================
  it('Reaction has required fields', () => {
    expectTypeOf<Reaction>().toHaveProperty('id');
    expectTypeOf<Reaction>().toHaveProperty('message_id');
    expectTypeOf<Reaction>().toHaveProperty('emoji');
  });

  it('ReactionGroup has aggregation fields', () => {
    expectTypeOf<ReactionGroup>().toHaveProperty('emoji');
    expectTypeOf<ReactionGroup>().toHaveProperty('count');
    expectTypeOf<ReactionGroup>().toHaveProperty('agents');
  });

  // ============================================
  // File types
  // ============================================
  it('FileRecord has required fields', () => {
    expectTypeOf<FileRecord>().toHaveProperty('id');
    expectTypeOf<FileRecord>().toHaveProperty('filename');
    expectTypeOf<FileRecord>().toHaveProperty('content_type');
    expectTypeOf<FileRecord>().toHaveProperty('size_bytes');
    expectTypeOf<FileRecord>().toHaveProperty('storage_key');
    expectTypeOf<FileRecord>().toHaveProperty('status');
  });

  it('FileStatus union', () => {
    expectTypeOf<'pending'>().toMatchTypeOf<FileStatus>();
    expectTypeOf<'complete'>().toMatchTypeOf<FileStatus>();
    expectTypeOf<'deleted'>().toMatchTypeOf<FileStatus>();
  });

  it('FileAttachment has url', () => {
    expectTypeOf<FileAttachment>().toHaveProperty('file_id');
    expectTypeOf<FileAttachment>().toHaveProperty('url');
  });

  // ============================================
  // Receipt types
  // ============================================
  it('ReadReceipt has required fields', () => {
    expectTypeOf<ReadReceipt>().toHaveProperty('message_id');
    expectTypeOf<ReadReceipt>().toHaveProperty('agent_id');
    expectTypeOf<ReadReceipt>().toHaveProperty('read_at');
  });

  it('ChannelReadStatus has read position', () => {
    expectTypeOf<ChannelReadStatus>().toHaveProperty('agent_name');
    expectTypeOf<ChannelReadStatus>().toHaveProperty('last_read_id');
  });

  // ============================================
  // DM types
  // ============================================
  it('DmConversation has required fields', () => {
    expectTypeOf<DmConversation>().toHaveProperty('id');
    expectTypeOf<DmConversation>().toHaveProperty('channel_id');
    expectTypeOf<DmConversation>().toHaveProperty('dm_type');
  });

  it('DmType union', () => {
    expectTypeOf<'1:1'>().toMatchTypeOf<DmType>();
    expectTypeOf<'group'>().toMatchTypeOf<DmType>();
  });

  it('DmConversationSummary has unread info', () => {
    expectTypeOf<DmConversationSummary>().toHaveProperty('unread_count');
    expectTypeOf<DmConversationSummary>().toHaveProperty('participants');
  });

  it('DmMessage includes sender identity fields', () => {
    expectTypeOf<DmMessage>().toHaveProperty('agent_id');
    expectTypeOf<DmMessage>().toHaveProperty('agent_name');
    expectTypeOf<DmMessage>().toHaveProperty('agent_type');
  });

  // ============================================
  // API Response types (discriminated union)
  // ============================================
  it('ApiResponse discriminated union works', () => {
    const success: ApiResponse<string> = { ok: true, data: 'hello' };
    const error: ApiResponse<string> = { ok: false, error: { code: 'err', message: 'msg' } };
    expectTypeOf(success).toMatchTypeOf<ApiResponse<string>>();
    expectTypeOf(error).toMatchTypeOf<ApiResponse<string>>();
  });

  it('ApiSuccess has data and optional cursor', () => {
    expectTypeOf<ApiSuccess<number>>().toHaveProperty('ok');
    expectTypeOf<ApiSuccess<number>>().toHaveProperty('data');
  });

  it('ApiError has error object', () => {
    expectTypeOf<ApiError>().toHaveProperty('ok');
    expectTypeOf<ApiError>().toHaveProperty('error');
  });

  it('InboxResponse has all sections', () => {
    expectTypeOf<InboxResponse>().toHaveProperty('unread_channels');
    expectTypeOf<InboxResponse>().toHaveProperty('mentions');
    expectTypeOf<InboxResponse>().toHaveProperty('unread_dms');
  });

  // ============================================
  // WebSocket event types
  // ============================================
  it('ClientEvent is a discriminated union', () => {
    const sub: ClientEvent = { type: 'subscribe', channels: ['general'] };
    const unsub: ClientEvent = { type: 'unsubscribe', channels: ['general'] };
    const ping: ClientEvent = { type: 'ping' };
    expectTypeOf(sub).toMatchTypeOf<ClientEvent>();
    expectTypeOf(unsub).toMatchTypeOf<ClientEvent>();
    expectTypeOf(ping).toMatchTypeOf<ClientEvent>();
  });

  it('ServerEvent is a discriminated union', () => {
    const msg: ServerEvent = {
      type: 'message.created',
      channel: 'general',
      message: { id: '1', agent_name: 'a', text: 't', attachments: [] },
    };
    const pong: ServerEvent = { type: 'pong' };
    expectTypeOf(msg).toMatchTypeOf<ServerEvent>();
    expectTypeOf(pong).toMatchTypeOf<ServerEvent>();
  });

  it('ServerEvent narrows by type field', () => {
    function handleEvent(event: ServerEvent) {
      if (event.type === 'message.created') {
        expectTypeOf(event).toMatchTypeOf<MessageCreatedEvent>();
      }
      if (event.type === 'message.reacted') {
        expectTypeOf(event).toMatchTypeOf<MessageReactedEvent>();
      }
      if (event.type === 'agent.status.active') {
        expectTypeOf(event).toMatchTypeOf<AgentStatusActiveEvent>();
      }
      if (event.type === 'pong') {
        expectTypeOf(event).toMatchTypeOf<PongEvent>();
      }
    }
    handleEvent({ type: 'pong' });
  });

  // ============================================
  // Durable delivery
  // ============================================
  it('DeliverySchema validates a delivery record', () => {
    const parsed = DeliverySchema.safeParse({
      id: 'del_1',
      message_id: 'm_1',
      channel_id: 'c_1',
      agent_id: 'a_1',
      status: 'accepted',
      mode: 'immediate',
      reason: 'mention',
      priority: 'normal',
      retryable: null,
      error: null,
      available_at: null,
      deadline: null,
      created_at: '2026-06-01T00:00:00.000Z',
      updated_at: null,
    });
    expect(parsed.success).toBe(true);
  });

  it('DeliverySchema rejects an unknown status', () => {
    const parsed = DeliverySchema.safeParse({
      id: 'del_1', message_id: 'm_1', channel_id: 'c_1', agent_id: 'a_1',
      status: 'bogus', mode: 'immediate', reason: null, priority: 'normal',
      retryable: null, error: null, available_at: null, deadline: null,
      created_at: '2026-06-01T00:00:00.000Z', updated_at: null,
    });
    expect(parsed.success).toBe(false);
  });

  it('DeliveryItemSchema carries an optional message payload', () => {
    const parsed = DeliveryItemSchema.safeParse({
      id: 'del_1', message_id: 'm_1', channel_id: 'c_1', agent_id: 'a_1',
      status: 'deferred', mode: 'immediate', reason: null, priority: 'normal',
      retryable: null, error: null, available_at: '2026-06-01T00:01:00.000Z',
      deadline: null, created_at: '2026-06-01T00:00:00.000Z', updated_at: null,
      message: null,
    });
    expect(parsed.success).toBe(true);
  });

  it('ServerEventSchema parses durable delivery events', () => {
    for (const event of [
      { type: 'delivery.accepted', delivery_id: 'del_1', message_id: 'm_1', channel_id: 'c_1', reason: 'message' },
      { type: 'delivery.delivered', delivery_id: 'del_1', message_id: 'm_1' },
      { type: 'delivery.deferred', delivery_id: 'del_1', message_id: 'm_1', available_at: '2026-06-01T00:01:00.000Z' },
      { type: 'delivery.failed', delivery_id: 'del_1', message_id: 'm_1', error: 'boom', retryable: true },
    ]) {
      expect(ServerEventSchema.safeParse(event).success).toBe(true);
    }
  });
});
