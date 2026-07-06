import { z } from 'zod';
import {
  ClientEventSchema,
  ServerEventSchema,
  WsClientEventSchema,
} from '../index.js';

// Runtime `safeParse` coverage for the WS wire-protocol discriminated unions in
// `events.ts`. The existing `types.test.ts` runtime-validates only the four
// durable delivery variants (positive fixtures) and does compile-time
// `expectTypeOf` narrowing checks. This file covers the OTHER union members:
// every ClientEvent variant, every non-delivery ServerEvent variant, and the
// WsClient-only variants (open/error/reconnecting/permanently_disconnected/
// close/resynced), each with a valid fixture, a negative that pins the failing
// field, and discriminant-routing assertions.

// A valid RFC-4122 UUID reused by fixtures whose `id` field is `z.string().uuid()`.
const UUID = '550e8400-e29b-41d4-a716-446655440000';

// A minimal-but-schema-accurate CoreMessagePayload (id, agent_id, agent_name,
// text required; agent_type/injection_mode/attachments optional).
const coreMessage = {
  id: 'm_1',
  agent_id: 'a_1',
  agent_name: 'alice',
  text: 'hello',
};

// ChannelMessagePayload additionally *requires* `attachments` (Core makes it
// optional). Only MessageCreated uses this stricter payload.
const channelMessage = { ...coreMessage, attachments: [] };

type Parsed = ReturnType<typeof ServerEventSchema.safeParse>;

/** True when some validation issue is reported at exactly the given dotted path. */
function hasIssueAtPath(result: { success: boolean } & Partial<{ error: z.ZodError }>, dotted: string): boolean {
  if (result.success || !('error' in result) || !result.error) return false;
  return result.error.issues.some((i) => i.path.join('.') === dotted);
}

/** Assert a fixture parses and routes to the expected discriminant. */
function expectRoutes(
  schema: { safeParse: (x: unknown) => Parsed },
  fixture: unknown,
  expectedType: string,
): void {
  const r = schema.safeParse(fixture);
  expect(r.success).toBe(true);
  if (r.success) {
    expect((r.data as { type: string }).type).toBe(expectedType);
  }
}

// ============================================================================
// ClientEvent union: subscribe / unsubscribe / ping / resync
// ============================================================================
describe('ClientEventSchema', () => {
  it('accepts a subscribe event and routes it', () => {
    expectRoutes(ClientEventSchema, { type: 'subscribe', channels: ['general', 'random'] }, 'subscribe');
  });

  it('rejects a subscribe event missing channels', () => {
    const r = ClientEventSchema.safeParse({ type: 'subscribe' });
    expect(r.success).toBe(false);
    expect(hasIssueAtPath(r, 'channels')).toBe(true);
  });

  it('rejects a subscribe event whose channels is not an array of strings', () => {
    const r = ClientEventSchema.safeParse({ type: 'subscribe', channels: [1, 2] });
    expect(r.success).toBe(false);
    expect(hasIssueAtPath(r, 'channels.0')).toBe(true);
  });

  it('accepts an unsubscribe event and routes it', () => {
    expectRoutes(ClientEventSchema, { type: 'unsubscribe', channels: ['general'] }, 'unsubscribe');
  });

  it('rejects an unsubscribe event missing channels', () => {
    const r = ClientEventSchema.safeParse({ type: 'unsubscribe' });
    expect(r.success).toBe(false);
    expect(hasIssueAtPath(r, 'channels')).toBe(true);
  });

  it('accepts a ping event and routes it', () => {
    expectRoutes(ClientEventSchema, { type: 'ping' }, 'ping');
  });

  it('accepts a resync event with and without the optional since', () => {
    expectRoutes(ClientEventSchema, { type: 'resync', last_seen_seq: 42 }, 'resync');
    expectRoutes(
      ClientEventSchema,
      { type: 'resync', last_seen_seq: 42, since: '2026-06-01T00:00:00.000Z' },
      'resync',
    );
  });

  it('rejects a resync event missing last_seen_seq', () => {
    const r = ClientEventSchema.safeParse({ type: 'resync' });
    expect(r.success).toBe(false);
    expect(hasIssueAtPath(r, 'last_seen_seq')).toBe(true);
  });

  it('rejects a resync event whose last_seen_seq is not a number', () => {
    const r = ClientEventSchema.safeParse({ type: 'resync', last_seen_seq: 'x' });
    expect(r.success).toBe(false);
    expect(hasIssueAtPath(r, 'last_seen_seq')).toBe(true);
  });

  it('rejects an unknown client-event discriminant', () => {
    const r = ClientEventSchema.safeParse({ type: 'pong' });
    expect(r.success).toBe(false);
    expect(hasIssueAtPath(r, 'type')).toBe(true);
  });

  it('does not accept a server-only discriminant as a client event', () => {
    // `message.created` is a ServerEvent, not a ClientEvent.
    const r = ClientEventSchema.safeParse({ type: 'message.created', channel: 'general', message: channelMessage });
    expect(r.success).toBe(false);
  });
});

// ============================================================================
// ServerEvent union — message.* family
// ============================================================================
describe('ServerEventSchema — message events', () => {
  it('accepts message.created and routes it', () => {
    expectRoutes(
      ServerEventSchema,
      { id: UUID, type: 'message.created', channel: 'general', message: channelMessage },
      'message.created',
    );
  });

  it('rejects message.created with a non-uuid id', () => {
    const r = ServerEventSchema.safeParse({
      id: 'not-a-uuid',
      type: 'message.created',
      channel: 'general',
      message: channelMessage,
    });
    expect(r.success).toBe(false);
    expect(hasIssueAtPath(r, 'id')).toBe(true);
  });

  it('rejects message.created missing channel', () => {
    const r = ServerEventSchema.safeParse({ id: UUID, type: 'message.created', message: channelMessage });
    expect(r.success).toBe(false);
    expect(hasIssueAtPath(r, 'channel')).toBe(true);
  });

  it('rejects message.created whose message payload omits required attachments', () => {
    // ChannelMessagePayload requires `attachments`; Core (used elsewhere) does not.
    const r = ServerEventSchema.safeParse({
      id: UUID,
      type: 'message.created',
      channel: 'general',
      message: coreMessage,
    });
    expect(r.success).toBe(false);
    expect(hasIssueAtPath(r, 'message.attachments')).toBe(true);
  });

  it('accepts message.updated and routes it', () => {
    expectRoutes(
      ServerEventSchema,
      { type: 'message.updated', channel: 'general', message: coreMessage },
      'message.updated',
    );
  });

  it('rejects message.updated whose message omits agent_name', () => {
    const { agent_name, ...noName } = coreMessage;
    void agent_name;
    const r = ServerEventSchema.safeParse({ type: 'message.updated', channel: 'general', message: noName });
    expect(r.success).toBe(false);
    expect(hasIssueAtPath(r, 'message.agent_name')).toBe(true);
  });

  it('accepts thread.reply and routes it', () => {
    expectRoutes(
      ServerEventSchema,
      { id: UUID, type: 'thread.reply', channel: 'general', parent_id: 'm_parent', message: coreMessage },
      'thread.reply',
    );
  });

  it('rejects thread.reply missing parent_id', () => {
    const r = ServerEventSchema.safeParse({
      id: UUID,
      type: 'thread.reply',
      channel: 'general',
      message: coreMessage,
    });
    expect(r.success).toBe(false);
    expect(hasIssueAtPath(r, 'parent_id')).toBe(true);
  });

  it('accepts message.reacted with and without the optional action', () => {
    expectRoutes(
      ServerEventSchema,
      { type: 'message.reacted', message_id: 'm_1', emoji: '👍', agent_name: 'alice' },
      'message.reacted',
    );
    expectRoutes(
      ServerEventSchema,
      { type: 'message.reacted', message_id: 'm_1', emoji: '👍', agent_name: 'alice', action: 'removed' },
      'message.reacted',
    );
  });

  it('rejects message.reacted missing emoji', () => {
    const r = ServerEventSchema.safeParse({ type: 'message.reacted', message_id: 'm_1', agent_name: 'alice' });
    expect(r.success).toBe(false);
    expect(hasIssueAtPath(r, 'emoji')).toBe(true);
  });

  it('rejects message.reacted with an out-of-enum action', () => {
    const r = ServerEventSchema.safeParse({
      type: 'message.reacted',
      message_id: 'm_1',
      emoji: '👍',
      agent_name: 'alice',
      action: 'toggled',
    });
    expect(r.success).toBe(false);
    expect(hasIssueAtPath(r, 'action')).toBe(true);
  });

  it('accepts message.read and routes it', () => {
    expectRoutes(
      ServerEventSchema,
      { type: 'message.read', message_id: 'm_1', agent_name: 'alice', read_at: '2026-06-01T00:00:00.000Z' },
      'message.read',
    );
  });

  it('rejects message.read missing read_at', () => {
    const r = ServerEventSchema.safeParse({ type: 'message.read', message_id: 'm_1', agent_name: 'alice' });
    expect(r.success).toBe(false);
    expect(hasIssueAtPath(r, 'read_at')).toBe(true);
  });
});

// ============================================================================
// ServerEvent union — DM events
// ============================================================================
describe('ServerEventSchema — dm events', () => {
  it('accepts dm.received and routes it', () => {
    expectRoutes(
      ServerEventSchema,
      { id: UUID, type: 'dm.received', conversation_id: 'conv_1', message: coreMessage },
      'dm.received',
    );
  });

  it('rejects dm.received missing conversation_id', () => {
    const r = ServerEventSchema.safeParse({ id: UUID, type: 'dm.received', message: coreMessage });
    expect(r.success).toBe(false);
    expect(hasIssueAtPath(r, 'conversation_id')).toBe(true);
  });

  it('accepts group_dm.received and routes it', () => {
    expectRoutes(
      ServerEventSchema,
      { id: UUID, type: 'group_dm.received', conversation_id: 'conv_1', message: coreMessage },
      'group_dm.received',
    );
  });

  it('rejects group_dm.received with a non-uuid id', () => {
    const r = ServerEventSchema.safeParse({
      id: 'nope',
      type: 'group_dm.received',
      conversation_id: 'conv_1',
      message: coreMessage,
    });
    expect(r.success).toBe(false);
    expect(hasIssueAtPath(r, 'id')).toBe(true);
  });
});

// ============================================================================
// ServerEvent union — agent.status.* family
// ============================================================================
describe('ServerEventSchema — agent status events', () => {
  const statuses = ['active', 'idle', 'blocked', 'waiting', 'offline'] as const;

  for (const status of statuses) {
    it(`accepts agent.status.${status} and routes it`, () => {
      expectRoutes(
        ServerEventSchema,
        { type: `agent.status.${status}`, agent: { name: 'alice' }, status },
        `agent.status.${status}`,
      );
    });

    it(`rejects agent.status.${status} whose status literal is mismatched`, () => {
      // Each fixed-status variant pins `status` to its own literal.
      const wrong = status === 'active' ? 'idle' : 'active';
      const r = ServerEventSchema.safeParse({
        type: `agent.status.${status}`,
        agent: { name: 'alice' },
        status: wrong,
      });
      expect(r.success).toBe(false);
      expect(hasIssueAtPath(r, 'status')).toBe(true);
    });
  }

  it('rejects an agent.status.active event missing agent.name', () => {
    const r = ServerEventSchema.safeParse({ type: 'agent.status.active', agent: {}, status: 'active' });
    expect(r.success).toBe(false);
    expect(hasIssueAtPath(r, 'agent.name')).toBe(true);
  });

  it('accepts agent.status.changed for every allowed status', () => {
    for (const status of statuses) {
      expectRoutes(
        ServerEventSchema,
        { type: 'agent.status.changed', agent: { name: 'alice' }, status },
        'agent.status.changed',
      );
    }
  });

  it('rejects agent.status.changed with an out-of-enum status', () => {
    const r = ServerEventSchema.safeParse({
      type: 'agent.status.changed',
      agent: { name: 'alice' },
      status: 'sleeping',
    });
    expect(r.success).toBe(false);
    expect(hasIssueAtPath(r, 'status')).toBe(true);
  });
});

// ============================================================================
// ServerEvent union — channel.* and member.* families
// ============================================================================
describe('ServerEventSchema — channel and member events', () => {
  it('accepts channel.created and routes it', () => {
    expectRoutes(
      ServerEventSchema,
      { type: 'channel.created', channel: { name: 'general', topic: 'chatter' } },
      'channel.created',
    );
  });

  it('accepts channel.created with a null topic', () => {
    expectRoutes(
      ServerEventSchema,
      { type: 'channel.created', channel: { name: 'general', topic: null } },
      'channel.created',
    );
  });

  it('rejects channel.created whose channel omits topic', () => {
    // topic is `.nullable()` (must be present, may be null) — not optional.
    const r = ServerEventSchema.safeParse({ type: 'channel.created', channel: { name: 'general' } });
    expect(r.success).toBe(false);
    expect(hasIssueAtPath(r, 'channel.topic')).toBe(true);
  });

  it('accepts channel.updated and routes it', () => {
    expectRoutes(
      ServerEventSchema,
      { type: 'channel.updated', channel: { name: 'general', topic: null } },
      'channel.updated',
    );
  });

  it('rejects channel.updated missing channel.name', () => {
    const r = ServerEventSchema.safeParse({ type: 'channel.updated', channel: { topic: null } });
    expect(r.success).toBe(false);
    expect(hasIssueAtPath(r, 'channel.name')).toBe(true);
  });

  it('accepts channel.archived and routes it', () => {
    expectRoutes(ServerEventSchema, { type: 'channel.archived', channel: { name: 'general' } }, 'channel.archived');
  });

  it('rejects channel.archived missing channel.name', () => {
    const r = ServerEventSchema.safeParse({ type: 'channel.archived', channel: {} });
    expect(r.success).toBe(false);
    expect(hasIssueAtPath(r, 'channel.name')).toBe(true);
  });

  it('accepts member.joined and routes it', () => {
    expectRoutes(ServerEventSchema, { type: 'member.joined', channel: 'general', agent_name: 'alice' }, 'member.joined');
  });

  it('rejects member.joined missing agent_name', () => {
    const r = ServerEventSchema.safeParse({ type: 'member.joined', channel: 'general' });
    expect(r.success).toBe(false);
    expect(hasIssueAtPath(r, 'agent_name')).toBe(true);
  });

  it('accepts member.left and routes it', () => {
    expectRoutes(ServerEventSchema, { type: 'member.left', channel: 'general', agent_name: 'alice' }, 'member.left');
  });

  it('rejects member.left missing channel', () => {
    const r = ServerEventSchema.safeParse({ type: 'member.left', agent_name: 'alice' });
    expect(r.success).toBe(false);
    expect(hasIssueAtPath(r, 'channel')).toBe(true);
  });

  it('accepts member.channel_muted and routes it', () => {
    expectRoutes(
      ServerEventSchema,
      { type: 'member.channel_muted', channel: 'general', agent_name: 'alice' },
      'member.channel_muted',
    );
  });

  it('rejects member.channel_muted missing agent_name', () => {
    const r = ServerEventSchema.safeParse({ type: 'member.channel_muted', channel: 'general' });
    expect(r.success).toBe(false);
    expect(hasIssueAtPath(r, 'agent_name')).toBe(true);
  });

  it('accepts member.channel_unmuted and routes it', () => {
    expectRoutes(
      ServerEventSchema,
      { type: 'member.channel_unmuted', channel: 'general', agent_name: 'alice' },
      'member.channel_unmuted',
    );
  });

  it('rejects member.channel_unmuted missing channel', () => {
    const r = ServerEventSchema.safeParse({ type: 'member.channel_unmuted', agent_name: 'alice' });
    expect(r.success).toBe(false);
    expect(hasIssueAtPath(r, 'channel')).toBe(true);
  });
});

// ============================================================================
// ServerEvent union — file and webhook events
// ============================================================================
describe('ServerEventSchema — file and webhook events', () => {
  it('accepts file.uploaded and routes it', () => {
    expectRoutes(
      ServerEventSchema,
      { type: 'file.uploaded', file: { file_id: 'f_1', filename: 'a.png', uploaded_by: 'alice' } },
      'file.uploaded',
    );
  });

  it('rejects file.uploaded whose file omits uploaded_by', () => {
    const r = ServerEventSchema.safeParse({ type: 'file.uploaded', file: { file_id: 'f_1', filename: 'a.png' } });
    expect(r.success).toBe(false);
    expect(hasIssueAtPath(r, 'file.uploaded_by')).toBe(true);
  });

  it('accepts webhook.received with a null source and no author', () => {
    expectRoutes(
      ServerEventSchema,
      {
        type: 'webhook.received',
        webhook_id: 'wh_1',
        channel: 'general',
        message: { id: 'm_1', text: 'hi', source: null },
      },
      'webhook.received',
    );
  });

  it('accepts webhook.received with an author present', () => {
    expectRoutes(
      ServerEventSchema,
      {
        type: 'webhook.received',
        webhook_id: 'wh_1',
        channel: 'general',
        message: { id: 'm_1', text: 'hi', source: 'github', author: 'octocat' },
      },
      'webhook.received',
    );
  });

  it('rejects webhook.received whose message omits the required source', () => {
    // source is `.nullable()` and NOT `.optional()`, so it must be present.
    const r = ServerEventSchema.safeParse({
      type: 'webhook.received',
      webhook_id: 'wh_1',
      channel: 'general',
      message: { id: 'm_1', text: 'hi' },
    });
    expect(r.success).toBe(false);
    expect(hasIssueAtPath(r, 'message.source')).toBe(true);
  });

  it('rejects webhook.received missing webhook_id', () => {
    const r = ServerEventSchema.safeParse({
      type: 'webhook.received',
      channel: 'general',
      message: { id: 'm_1', text: 'hi', source: null },
    });
    expect(r.success).toBe(false);
    expect(hasIssueAtPath(r, 'webhook_id')).toBe(true);
  });
});

// ============================================================================
// ServerEvent union — action.* family
// ============================================================================
describe('ServerEventSchema — action events', () => {
  it('accepts action.invoked with and without optional input/handler_agent_name', () => {
    expectRoutes(
      ServerEventSchema,
      {
        type: 'action.invoked',
        invocation_id: 'inv_1',
        action_name: 'do_thing',
        caller_name: 'alice',
        handler_agent_id: 'ag_1',
      },
      'action.invoked',
    );
    expectRoutes(
      ServerEventSchema,
      {
        type: 'action.invoked',
        invocation_id: 'inv_1',
        action_name: 'do_thing',
        caller_name: 'alice',
        handler_agent_id: 'ag_1',
        handler_agent_name: 'bob',
        input: { foo: 'bar' },
      },
      'action.invoked',
    );
  });

  it('rejects action.invoked missing handler_agent_id', () => {
    const r = ServerEventSchema.safeParse({
      type: 'action.invoked',
      invocation_id: 'inv_1',
      action_name: 'do_thing',
      caller_name: 'alice',
    });
    expect(r.success).toBe(false);
    expect(hasIssueAtPath(r, 'handler_agent_id')).toBe(true);
  });

  it('accepts action.completed with a null output and null error', () => {
    expectRoutes(
      ServerEventSchema,
      {
        type: 'action.completed',
        invocation_id: 'inv_1',
        action_name: 'do_thing',
        status: 'completed',
        output: null,
        error: null,
      },
      'action.completed',
    );
  });

  it('accepts action.completed with a record output', () => {
    expectRoutes(
      ServerEventSchema,
      {
        type: 'action.completed',
        invocation_id: 'inv_1',
        action_name: 'do_thing',
        status: 'completed',
        output: { result: 42 },
        error: null,
      },
      'action.completed',
    );
  });

  it('rejects action.completed whose status literal is wrong', () => {
    const r = ServerEventSchema.safeParse({
      type: 'action.completed',
      invocation_id: 'inv_1',
      action_name: 'do_thing',
      status: 'failed',
      output: null,
      error: null,
    });
    expect(r.success).toBe(false);
    expect(hasIssueAtPath(r, 'status')).toBe(true);
  });

  it('rejects action.completed missing the required (nullable) output key', () => {
    const r = ServerEventSchema.safeParse({
      type: 'action.completed',
      invocation_id: 'inv_1',
      action_name: 'do_thing',
      status: 'completed',
      error: null,
    });
    expect(r.success).toBe(false);
    expect(hasIssueAtPath(r, 'output')).toBe(true);
  });

  it('accepts action.failed and routes it', () => {
    expectRoutes(
      ServerEventSchema,
      {
        type: 'action.failed',
        invocation_id: 'inv_1',
        action_name: 'do_thing',
        status: 'failed',
        output: null,
        error: 'boom',
      },
      'action.failed',
    );
  });

  it('rejects action.failed whose status literal is wrong', () => {
    const r = ServerEventSchema.safeParse({
      type: 'action.failed',
      invocation_id: 'inv_1',
      action_name: 'do_thing',
      status: 'completed',
      output: null,
      error: 'boom',
    });
    expect(r.success).toBe(false);
    expect(hasIssueAtPath(r, 'status')).toBe(true);
  });

  it('accepts action.denied with a null caller_name', () => {
    expectRoutes(
      ServerEventSchema,
      { type: 'action.denied', action_name: 'do_thing', caller_name: null, error: 'not allowed' },
      'action.denied',
    );
  });

  it('rejects action.denied missing error', () => {
    const r = ServerEventSchema.safeParse({ type: 'action.denied', action_name: 'do_thing', caller_name: 'alice' });
    expect(r.success).toBe(false);
    expect(hasIssueAtPath(r, 'error')).toBe(true);
  });
});

// ============================================================================
// ServerEvent union — control frames: pong / resync_ack
// ============================================================================
describe('ServerEventSchema — control frames', () => {
  it('accepts pong and routes it', () => {
    expectRoutes(ServerEventSchema, { type: 'pong' }, 'pong');
  });

  it('accepts resync_ack and routes it', () => {
    expectRoutes(
      ServerEventSchema,
      { type: 'resync_ack', last_seen_seq: 1, current_seq: 5, replayed: 4, gap_detected: false },
      'resync_ack',
    );
  });

  it('rejects resync_ack missing gap_detected', () => {
    const r = ServerEventSchema.safeParse({ type: 'resync_ack', last_seen_seq: 1, current_seq: 5, replayed: 4 });
    expect(r.success).toBe(false);
    expect(hasIssueAtPath(r, 'gap_detected')).toBe(true);
  });

  it('rejects resync_ack whose replayed is not a number', () => {
    const r = ServerEventSchema.safeParse({
      type: 'resync_ack',
      last_seen_seq: 1,
      current_seq: 5,
      replayed: 'four',
      gap_detected: false,
    });
    expect(r.success).toBe(false);
    expect(hasIssueAtPath(r, 'replayed')).toBe(true);
  });
});

// ============================================================================
// ServerEvent union — cross-variant routing / discriminant integrity
// ============================================================================
describe('ServerEventSchema — discriminant routing', () => {
  it('rejects an entirely unknown discriminant', () => {
    const r = ServerEventSchema.safeParse({ type: 'not.a.real.event' });
    expect(r.success).toBe(false);
    expect(hasIssueAtPath(r, 'type')).toBe(true);
  });

  it('does not validate a message.reacted payload wearing a message.created type', () => {
    // The union must route by `type`: a reacted-shaped body labelled
    // `message.created` fails MessageCreated's required channel/message/id.
    const r = ServerEventSchema.safeParse({
      type: 'message.created',
      message_id: 'm_1',
      emoji: '👍',
      agent_name: 'alice',
    });
    expect(r.success).toBe(false);
    expect(hasIssueAtPath(r, 'channel')).toBe(true);
  });

  it('does not validate a message.created payload wearing a member.joined type', () => {
    const r = ServerEventSchema.safeParse({
      type: 'member.joined',
      id: UUID,
      channel: 'general',
      message: channelMessage,
    });
    expect(r.success).toBe(false);
    // member.joined requires agent_name, which the message.created body lacks.
    expect(hasIssueAtPath(r, 'agent_name')).toBe(true);
  });

  it('rejects a payload with no type at all', () => {
    const r = ServerEventSchema.safeParse({ channel: 'general' });
    expect(r.success).toBe(false);
    expect(hasIssueAtPath(r, 'type')).toBe(true);
  });
});

// ============================================================================
// WsClientEvent union — client-only frames not present in ServerEvent
// ============================================================================
describe('WsClientEventSchema — client-only frames', () => {
  it('accepts open and routes it', () => {
    expectRoutes(WsClientEventSchema, { type: 'open' }, 'open');
  });

  it('accepts error and routes it', () => {
    expectRoutes(WsClientEventSchema, { type: 'error' }, 'error');
  });

  it('accepts close and routes it', () => {
    expectRoutes(WsClientEventSchema, { type: 'close' }, 'close');
  });

  it('accepts reconnecting with an attempt count', () => {
    expectRoutes(WsClientEventSchema, { type: 'reconnecting', attempt: 3 }, 'reconnecting');
  });

  it('rejects reconnecting missing attempt', () => {
    const r = WsClientEventSchema.safeParse({ type: 'reconnecting' });
    expect(r.success).toBe(false);
    expect(hasIssueAtPath(r, 'attempt')).toBe(true);
  });

  it('accepts permanently_disconnected with an attempt count', () => {
    expectRoutes(WsClientEventSchema, { type: 'permanently_disconnected', attempt: 7 }, 'permanently_disconnected');
  });

  it('rejects permanently_disconnected whose attempt is not a number', () => {
    const r = WsClientEventSchema.safeParse({ type: 'permanently_disconnected', attempt: 'many' });
    expect(r.success).toBe(false);
    expect(hasIssueAtPath(r, 'attempt')).toBe(true);
  });

  it('accepts resynced and routes it', () => {
    expectRoutes(WsClientEventSchema, { type: 'resynced', replayed: 2, gap_detected: true }, 'resynced');
  });

  it('rejects resynced missing gap_detected', () => {
    const r = WsClientEventSchema.safeParse({ type: 'resynced', replayed: 2 });
    expect(r.success).toBe(false);
    expect(hasIssueAtPath(r, 'gap_detected')).toBe(true);
  });

  it('also carries server events (e.g. pong) in the WsClient union', () => {
    expectRoutes(WsClientEventSchema, { type: 'pong' }, 'pong');
  });

  it('rejects the client-only open frame on the ServerEvent union', () => {
    // `open` is emitted by WsClient only; it is not a ServerEvent.
    const r = ServerEventSchema.safeParse({ type: 'open' });
    expect(r.success).toBe(false);
    expect(hasIssueAtPath(r, 'type')).toBe(true);
  });
});
