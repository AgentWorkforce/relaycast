import { stableRelaycastEventId } from '../event-id.js';
import { describe, it, expect } from 'vitest';
import { transformForClient, type WsEvent } from '../wsTransform.js';

function makeEvent(type: string, data: Record<string, unknown>, channelId?: string): WsEvent {
  return {
    type,
    workspace_id: 'ws_123',
    channel_id: channelId,
    data,
    timestamp: '2026-01-01T00:00:00.000Z',
  };
}

describe('transformForClient', () => {
  it('transforms message.created', () => {
    const event = makeEvent('message.created', {
      id: 'msg_1',
      channel_name: 'general',
      agent_id: 'agent_1',
      from_name: 'Bot',
      agent_type: 'agent',
      text: 'hi',
      attachments: [{ file_id: 'f1', filename: 'a.txt', content_type: 'text/plain', size_bytes: 1 }],
    }, 'ch_1');

    expect(transformForClient(event)).toEqual({
      id: stableRelaycastEventId('msg_1'),
      type: 'message.created',
      channel: 'general',
      message: {
        id: 'msg_1',
        agent_id: 'agent_1',
        agent_name: 'Bot',
        agent_type: 'agent',
        text: 'hi',
        attachments: [{ file_id: 'f1', filename: 'a.txt', content_type: 'text/plain', size_bytes: 1 }],
      },
    });
  });

  it('transforms message.updated', () => {
    const event = makeEvent('message.updated', {
      id: 'msg_2',
      channel_name: 'general',
      agent_id: 'agent_1',
      from_name: 'Bot',
      text: 'edit',
    }, 'ch_1');

    expect(transformForClient(event)).toEqual({
      type: 'message.updated',
      channel: 'general',
      message: {
        id: 'msg_2',
        agent_id: 'agent_1',
        agent_name: 'Bot',
        text: 'edit',
      },
    });
  });

  it('transforms thread.reply', () => {
    const event = makeEvent('thread.reply', {
      id: 'msg_3',
      channel_name: 'general',
      agent_id: 'agent_2',
      from_name: 'Alice',
      text: 'reply',
      thread_id: 'msg_root',
    }, 'ch_1');

    expect(transformForClient(event)).toEqual({
      id: stableRelaycastEventId('msg_3'),
      type: 'thread.reply',
      channel: 'general',
      parent_id: 'msg_root',
      message: {
        id: 'msg_3',
        agent_id: 'agent_2',
        agent_name: 'Alice',
        text: 'reply',
      },
    });
  });

  it('transforms message.reacted', () => {
    const event = makeEvent('message.reacted', {
      message_id: 'msg_4',
      emoji: ':+1:',
      agent_name: 'Bob',
      action: 'added',
    }, 'ch_1');

    expect(transformForClient(event)).toEqual({
      type: 'message.reacted',
      message_id: 'msg_4',
      emoji: ':+1:',
      agent_name: 'Bob',
      action: 'added',
    });
  });

  it('maps legacy reaction events to message.reacted', () => {
    const added = makeEvent('reaction.added', {
      message_id: 'msg_4',
      emoji: ':+1:',
      agent_name: 'Bob',
    }, 'ch_1');
    const removed = makeEvent('reaction.removed', {
      message_id: 'msg_5',
      emoji: ':wave:',
      agent_name: 'Bob',
    }, 'ch_1');

    expect(transformForClient(added)).toEqual({
      type: 'message.reacted',
      message_id: 'msg_4',
      emoji: ':+1:',
      agent_name: 'Bob',
      action: 'added',
    });
    expect(transformForClient(removed)).toEqual({
      type: 'message.reacted',
      message_id: 'msg_5',
      emoji: ':wave:',
      agent_name: 'Bob',
      action: 'removed',
    });
  });

  it('transforms dm.received', () => {
    const event = makeEvent('dm.received', {
      id: 'msg_6',
      conversation_id: 'dm_1',
      from_agent_id: 'agent_3',
      from_name: 'Cara',
      text: 'dm',
    });

    expect(transformForClient(event)).toEqual({
      id: stableRelaycastEventId('msg_6'),
      type: 'dm.received',
      conversation_id: 'dm_1',
      message: {
        id: 'msg_6',
        agent_id: 'agent_3',
        agent_name: 'Cara',
        text: 'dm',
      },
    });
  });

  it('transforms dm.received nested payload with mode + attachments', () => {
    const event = makeEvent('dm.received', {
      conversation_id: 'dm_1',
      message: {
        id: 'msg_6b',
        agent_id: 'agent_3',
        agent_name: 'Cara',
        text: 'dm nested',
        injection_mode: 'steer',
        attachments: [
          { file_id: 'f1', filename: 'a.txt', content_type: 'text/plain', size_bytes: 1 },
        ],
      },
    });

    expect(transformForClient(event)).toEqual({
      id: stableRelaycastEventId('msg_6b'),
      type: 'dm.received',
      conversation_id: 'dm_1',
      message: {
        id: 'msg_6b',
        agent_id: 'agent_3',
        agent_name: 'Cara',
        text: 'dm nested',
        injection_mode: 'steer',
        attachments: [
          { file_id: 'f1', filename: 'a.txt', content_type: 'text/plain', size_bytes: 1 },
        ],
      },
    });
  });

  it('transforms group_dm.received', () => {
    const event = makeEvent('group_dm.received', {
      id: 'msg_7',
      conversation_id: 'gdm_1',
      agent_id: 'agent_4',
      from_name: 'Dan',
      text: 'group',
    });

    expect(transformForClient(event)).toEqual({
      id: stableRelaycastEventId('msg_7'),
      type: 'group_dm.received',
      conversation_id: 'gdm_1',
      message: {
        id: 'msg_7',
        agent_id: 'agent_4',
        agent_name: 'Dan',
        text: 'group',
      },
    });
  });

  it('transforms group_dm.received nested payload with attachments', () => {
    const event = makeEvent('group_dm.received', {
      conversation_id: 'gdm_1',
      message: {
        id: 'msg_7b',
        agent_id: 'agent_4',
        agent_name: 'Dan',
        text: 'group nested',
        attachments: [
          { file_id: 'f2', filename: 'b.txt', content_type: 'text/plain', size_bytes: 2 },
        ],
      },
    });

    expect(transformForClient(event)).toEqual({
      id: stableRelaycastEventId('msg_7b'),
      type: 'group_dm.received',
      conversation_id: 'gdm_1',
      message: {
        id: 'msg_7b',
        agent_id: 'agent_4',
        agent_name: 'Dan',
        text: 'group nested',
        attachments: [
          { file_id: 'f2', filename: 'b.txt', content_type: 'text/plain', size_bytes: 2 },
        ],
      },
    });
  });

  it('transforms agent.status.active', () => {
    const event = makeEvent('agent.status.active', { agent_name: 'Eve' });
    expect(transformForClient(event)).toEqual({
      type: 'agent.status.active',
      agent: { name: 'Eve' },
      status: 'active',
    });
  });

  it('transforms agent.status.offline', () => {
    const event = makeEvent('agent.status.offline', { agent_name: 'Eve' });
    expect(transformForClient(event)).toEqual({
      type: 'agent.status.offline',
      agent: { name: 'Eve' },
      status: 'offline',
    });
  });

  it('maps legacy presence events to agent.status events', () => {
    expect(transformForClient(makeEvent('agent.online', { agent_name: 'Eve' }))).toEqual({
      type: 'agent.status.active',
      agent: { name: 'Eve' },
      status: 'active',
    });
    expect(transformForClient(makeEvent('agent.offline', { agent_name: 'Eve' }))).toEqual({
      type: 'agent.status.offline',
      agent: { name: 'Eve' },
      status: 'offline',
    });
  });

  it('transforms explicit agent status lifecycle events', () => {
    expect(transformForClient(makeEvent('agent.status.changed', {
      agent_name: 'Eve',
      status: 'blocked',
    }))).toEqual({
      type: 'agent.status.changed',
      agent: { name: 'Eve' },
      status: 'blocked',
    });
    expect(transformForClient(makeEvent('agent.status.waiting', { agent_name: 'Eve' }))).toEqual({
      type: 'agent.status.waiting',
      agent: { name: 'Eve' },
      status: 'waiting',
    });
  });

  it('transforms channel.created', () => {
    const event = makeEvent('channel.created', { channel_name: 'alerts', topic: 't' });
    expect(transformForClient(event)).toEqual({
      type: 'channel.created',
      channel: { name: 'alerts', topic: 't' },
    });
  });

  it('transforms channel.updated', () => {
    const event = makeEvent('channel.updated', { channel_name: 'alerts', topic: null });
    expect(transformForClient(event)).toEqual({
      type: 'channel.updated',
      channel: { name: 'alerts', topic: null },
    });
  });

  it('transforms channel.archived', () => {
    const event = makeEvent('channel.archived', { channel_name: 'alerts' });
    expect(transformForClient(event)).toEqual({
      type: 'channel.archived',
      channel: { name: 'alerts' },
    });
  });

  it('transforms member.joined', () => {
    const event = makeEvent('member.joined', { channel_name: 'general', agent_name: 'Bot' });
    expect(transformForClient(event)).toEqual({
      type: 'member.joined',
      channel: 'general',
      agent_name: 'Bot',
    });
  });

  it('transforms member.left', () => {
    const event = makeEvent('member.left', { channel_name: 'general', agent_name: 'Bot' });
    expect(transformForClient(event)).toEqual({
      type: 'member.left',
      channel: 'general',
      agent_name: 'Bot',
    });
  });

  it('transforms channel mute lifecycle events', () => {
    expect(transformForClient(makeEvent('member.channel_muted', {
      channel_name: 'general',
      agent_name: 'Bot',
    }))).toEqual({
      type: 'member.channel_muted',
      channel: 'general',
      agent_name: 'Bot',
    });

    expect(transformForClient(makeEvent('member.channel_unmuted', {
      channel_name: 'general',
      agent_name: 'Bot',
    }))).toEqual({
      type: 'member.channel_unmuted',
      channel: 'general',
      agent_name: 'Bot',
    });
  });

  it('transforms message.read', () => {
    const event = makeEvent('message.read', { message_id: 'msg_8', agent_name: 'Bot', read_at: '2026-01-01T00:00:00.000Z' });
    expect(transformForClient(event)).toEqual({
      type: 'message.read',
      message_id: 'msg_8',
      agent_name: 'Bot',
      read_at: '2026-01-01T00:00:00.000Z',
    });
  });

  it('transforms file.uploaded', () => {
    const event = makeEvent('file.uploaded', { id: 'file_1', filename: 'a.txt', agent_id: 'agent_1' });
    expect(transformForClient(event)).toEqual({
      type: 'file.uploaded',
      file: {
        file_id: 'file_1',
        filename: 'a.txt',
        uploaded_by: 'agent_1',
      },
    });
  });

  it('transforms webhook.received', () => {
    const event = makeEvent('webhook.received', {
      webhook_id: 'wh_1',
      channel: 'general',
      message_id: 'msg_9',
      text: 'ping',
      source: null,
      author: 'PagerDuty',
    });
    expect(transformForClient(event)).toEqual({
      type: 'webhook.received',
      webhook_id: 'wh_1',
      channel: 'general',
      message: { id: 'msg_9', text: 'ping', source: null, author: 'PagerDuty' },
    });
  });

  it('transforms command.invoked', () => {
    const event = makeEvent('command.invoked', {
      command: '/hello',
      channel: 'general',
      invoked_by: 'agent_1',
      handler_agent_id: 'agent_2',
      args: 'x',
      parameters: { a: 1 },
    });
    expect(transformForClient(event)).toEqual({
      type: 'command.invoked',
      command: '/hello',
      channel: 'general',
      invoked_by: 'agent_1',
      handler_agent_id: 'agent_2',
      args: 'x',
      parameters: { a: 1 },
    });
  });

  it('transforms action lifecycle events', () => {
    expect(transformForClient(makeEvent('action.invoked', {
      invocation_id: 'inv_1',
      action_name: 'deploy',
      caller_name: 'Alice',
      handler_agent_id: 'agent_ops',
    }))).toEqual({
      type: 'action.invoked',
      invocation_id: 'inv_1',
      action_name: 'deploy',
      caller_name: 'Alice',
      handler_agent_id: 'agent_ops',
    });

    expect(transformForClient(makeEvent('action.completed', {
      invocation_id: 'inv_1',
      action_name: 'deploy',
      status: 'completed',
      output: { url: 'https://example.com' },
      error: null,
    }))).toEqual({
      type: 'action.completed',
      invocation_id: 'inv_1',
      action_name: 'deploy',
      status: 'completed',
      output: { url: 'https://example.com' },
      error: null,
    });

    expect(transformForClient(makeEvent('action.failed', {
      invocation_id: 'inv_2',
      action_name: 'deploy',
      status: 'failed',
      output: null,
      error: 'boom',
    }))).toEqual({
      type: 'action.failed',
      invocation_id: 'inv_2',
      action_name: 'deploy',
      status: 'failed',
      output: null,
      error: 'boom',
    });
  });

  it('transforms durable delivery lifecycle events', () => {
    expect(transformForClient(makeEvent('delivery.accepted', {
      delivery_id: 'del_1',
      message_id: 'msg_1',
      channel_id: 'ch_1',
      reason: 'mention',
    }))).toEqual({
      type: 'delivery.accepted',
      delivery_id: 'del_1',
      message_id: 'msg_1',
      channel_id: 'ch_1',
      reason: 'mention',
    });

    expect(transformForClient(makeEvent('delivery.delivered', {
      delivery_id: 'del_1',
      message_id: 'msg_1',
    }))).toEqual({
      type: 'delivery.delivered',
      delivery_id: 'del_1',
      message_id: 'msg_1',
    });

    expect(transformForClient(makeEvent('delivery.deferred', {
      delivery_id: 'del_1',
      message_id: 'msg_1',
      available_at: '2026-01-01T00:01:00.000Z',
      reason: 'busy',
    }))).toEqual({
      type: 'delivery.deferred',
      delivery_id: 'del_1',
      message_id: 'msg_1',
      available_at: '2026-01-01T00:01:00.000Z',
      reason: 'busy',
    });

    expect(transformForClient(makeEvent('delivery.failed', {
      delivery_id: 'del_1',
      message_id: 'msg_1',
      error: 'handler failed',
      retryable: true,
    }))).toEqual({
      type: 'delivery.failed',
      delivery_id: 'del_1',
      message_id: 'msg_1',
      error: 'handler failed',
      retryable: true,
    });
  });

  it('passes through unknown types without internal fields', () => {
    const event: WsEvent & { extra: string } = {
      type: 'custom.event',
      workspace_id: 'ws_123',
      channel_id: 'ch_1',
      timestamp: '2026-01-01T00:00:00.000Z',
      data: { foo: 'bar' },
      extra: 'x',
    };

    expect(transformForClient(event)).toEqual({
      type: 'custom.event',
      extra: 'x',
      foo: 'bar',
    });
  });
});
