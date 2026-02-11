import { describe, it, expect } from 'vitest';
import { transformForClient } from '../transform.js';
import type { WsEvent } from '../pubsub.js';

function makeEvent(type: string, data: Record<string, unknown>, channelId?: string): WsEvent {
  return {
    type: type as WsEvent['type'],
    workspace_id: 'ws_test',
    channel_id: channelId,
    data,
    timestamp: '2025-01-01T00:00:00.000Z',
  };
}

describe('transformForClient', () => {
  it('transforms message.created to ServerEvent shape', () => {
    const event = makeEvent('message.created', {
      id: 'msg_1',
      channel_name: 'general',
      from_name: 'alice',
      text: 'hello world',
      attachments: [{ file_id: 'f1', filename: 'test.txt', url: '/files/f1', size: 100 }],
    }, 'ch_1');

    const result = transformForClient(event) as Record<string, unknown>;
    expect(result).toEqual({
      type: 'message.created',
      channel: 'general',
      message: {
        id: 'msg_1',
        agent_name: 'alice',
        text: 'hello world',
        attachments: [{ file_id: 'f1', filename: 'test.txt', url: '/files/f1', size: 100 }],
      },
    });
  });

  it('transforms message.created with no attachments', () => {
    const event = makeEvent('message.created', {
      id: 'msg_2',
      channel_name: 'dev',
      from_name: 'bob',
      text: 'test',
    }, 'ch_2');

    const result = transformForClient(event) as Record<string, unknown>;
    expect(result).toEqual({
      type: 'message.created',
      channel: 'dev',
      message: {
        id: 'msg_2',
        agent_name: 'bob',
        text: 'test',
        attachments: [],
      },
    });
  });

  it('transforms message.updated', () => {
    const event = makeEvent('message.updated', {
      id: 'msg_1',
      channel_name: 'general',
      from_name: 'alice',
      text: 'updated text',
    }, 'ch_1');

    const result = transformForClient(event) as Record<string, unknown>;
    expect(result).toEqual({
      type: 'message.updated',
      channel: 'general',
      message: {
        id: 'msg_1',
        agent_name: 'alice',
        text: 'updated text',
      },
    });
  });

  it('transforms thread.reply', () => {
    const event = makeEvent('thread.reply', {
      id: 'msg_reply',
      thread_id: 'msg_parent',
      from_name: 'bob',
      text: 'a reply',
    }, 'ch_1');

    const result = transformForClient(event) as Record<string, unknown>;
    expect(result).toEqual({
      type: 'thread.reply',
      parent_id: 'msg_parent',
      message: {
        id: 'msg_reply',
        agent_name: 'bob',
        text: 'a reply',
      },
    });
  });

  it('transforms reaction.added', () => {
    const event = makeEvent('reaction.added', {
      message_id: 'msg_1',
      emoji: '👍',
      agent_name: 'alice',
    }, 'ch_1');

    const result = transformForClient(event) as Record<string, unknown>;
    expect(result).toEqual({
      type: 'reaction.added',
      message_id: 'msg_1',
      emoji: '👍',
      agent_name: 'alice',
    });
  });

  it('transforms reaction.removed', () => {
    const event = makeEvent('reaction.removed', {
      message_id: 'msg_1',
      emoji: '👍',
      agent_name: 'bob',
    });

    const result = transformForClient(event) as Record<string, unknown>;
    expect(result).toEqual({
      type: 'reaction.removed',
      message_id: 'msg_1',
      emoji: '👍',
      agent_name: 'bob',
    });
  });

  it('transforms dm.received', () => {
    const event = makeEvent('dm.received', {
      id: 'dm_1',
      conversation_id: 'conv_1',
      from_name: 'alice',
      text: 'private message',
    });

    const result = transformForClient(event) as Record<string, unknown>;
    expect(result).toEqual({
      type: 'dm.received',
      conversation_id: 'conv_1',
      message: {
        id: 'dm_1',
        agent_name: 'alice',
        text: 'private message',
      },
    });
  });

  it('transforms group_dm.received', () => {
    const event = makeEvent('group_dm.received', {
      id: 'gdm_1',
      conversation_id: 'conv_2',
      from_name: 'bob',
      text: 'group message',
    });

    const result = transformForClient(event) as Record<string, unknown>;
    expect(result).toEqual({
      type: 'group_dm.received',
      conversation_id: 'conv_2',
      message: {
        id: 'gdm_1',
        agent_name: 'bob',
        text: 'group message',
      },
    });
  });

  it('transforms agent.online', () => {
    const event = makeEvent('agent.online', {
      agent_id: 'agent_1',
      agent_name: 'alice',
    });

    const result = transformForClient(event) as Record<string, unknown>;
    expect(result).toEqual({
      type: 'agent.online',
      agent: { name: 'alice' },
    });
  });

  it('transforms agent.offline', () => {
    const event = makeEvent('agent.offline', {
      agent_id: 'agent_1',
      agent_name: 'bob',
    });

    const result = transformForClient(event) as Record<string, unknown>;
    expect(result).toEqual({
      type: 'agent.offline',
      agent: { name: 'bob' },
    });
  });

  it('transforms channel.created', () => {
    const event = makeEvent('channel.created', {
      channel_name: 'new-channel',
      name: 'new-channel',
      topic: 'A new channel',
    });

    const result = transformForClient(event) as Record<string, unknown>;
    expect(result).toEqual({
      type: 'channel.created',
      channel: { name: 'new-channel', topic: 'A new channel' },
    });
  });

  it('transforms channel.updated', () => {
    const event = makeEvent('channel.updated', {
      channel_name: 'dev',
      name: 'dev',
      topic: 'Updated topic',
    });

    const result = transformForClient(event) as Record<string, unknown>;
    expect(result).toEqual({
      type: 'channel.updated',
      channel: { name: 'dev', topic: 'Updated topic' },
    });
  });

  it('transforms channel.archived', () => {
    const event = makeEvent('channel.archived', {
      channel_name: 'old-channel',
    });

    const result = transformForClient(event) as Record<string, unknown>;
    expect(result).toEqual({
      type: 'channel.archived',
      channel: { name: 'old-channel' },
    });
  });

  it('transforms member.joined', () => {
    const event = makeEvent('member.joined', {
      channel_name: 'general',
      agent_name: 'alice',
    });

    const result = transformForClient(event) as Record<string, unknown>;
    expect(result).toEqual({
      type: 'member.joined',
      channel: 'general',
      agent_name: 'alice',
    });
  });

  it('transforms member.left', () => {
    const event = makeEvent('member.left', {
      channel_name: 'general',
      agent_name: 'bob',
    });

    const result = transformForClient(event) as Record<string, unknown>;
    expect(result).toEqual({
      type: 'member.left',
      channel: 'general',
      agent_name: 'bob',
    });
  });

  it('transforms message.read', () => {
    const event = makeEvent('message.read', {
      message_id: 'msg_1',
      agent_name: 'alice',
      read_at: '2025-01-01T00:00:00.000Z',
    });

    const result = transformForClient(event) as Record<string, unknown>;
    expect(result).toEqual({
      type: 'message.read',
      message_id: 'msg_1',
      agent_name: 'alice',
      read_at: '2025-01-01T00:00:00.000Z',
    });
  });

  it('transforms file.uploaded', () => {
    const event = makeEvent('file.uploaded', {
      file_id: 'f1',
      id: 'f1',
      filename: 'image.png',
      uploaded_by: 'alice',
      agent_id: 'agent_1',
    });

    const result = transformForClient(event) as Record<string, unknown>;
    expect(result).toEqual({
      type: 'file.uploaded',
      file: { file_id: 'f1', filename: 'image.png', uploaded_by: 'alice' },
    });
  });

  it('transforms webhook.received', () => {
    const event = makeEvent('webhook.received', {
      webhook_id: 'wh_1',
      channel: 'alerts',
      message_id: 'msg_wh',
      text: 'Alert triggered',
      source: 'github',
    });

    const result = transformForClient(event) as Record<string, unknown>;
    expect(result).toEqual({
      type: 'webhook.received',
      webhook_id: 'wh_1',
      channel: 'alerts',
      message: { id: 'msg_wh', text: 'Alert triggered', source: 'github' },
    });
  });

  it('transforms command.invoked', () => {
    const event = makeEvent('command.invoked', {
      command: 'deploy',
      channel: 'ops',
      invoked_by: 'agent_1',
      args: '--env production',
    });

    const result = transformForClient(event) as Record<string, unknown>;
    expect(result).toEqual({
      type: 'command.invoked',
      command: 'deploy',
      channel: 'ops',
      invoked_by: 'agent_1',
      args: '--env production',
      parameters: null,
    });
  });

  it('transforms command.invoked with parameters', () => {
    const event = makeEvent('command.invoked', {
      command: 'spawn',
      channel: 'general',
      invoked_by: 'agent_1',
      args: null,
      parameters: { name: 'Worker1', cli: 'codex', args: ['--full-auto'] },
    });

    const result = transformForClient(event) as Record<string, unknown>;
    expect(result).toEqual({
      type: 'command.invoked',
      command: 'spawn',
      channel: 'general',
      invoked_by: 'agent_1',
      args: null,
      parameters: { name: 'Worker1', cli: 'codex', args: ['--full-auto'] },
    });
  });

  it('strips workspace_id, channel_id, and timestamp from output', () => {
    const event = makeEvent('agent.online', { agent_name: 'alice' });
    const result = transformForClient(event) as Record<string, unknown>;
    expect(result).not.toHaveProperty('workspace_id');
    expect(result).not.toHaveProperty('channel_id');
    expect(result).not.toHaveProperty('timestamp');
    expect(result).not.toHaveProperty('data');
  });

  it('strips internal fields for unknown event types (default case)', () => {
    const event: WsEvent = {
      type: 'some.future.event' as WsEvent['type'],
      workspace_id: 'ws_secret',
      channel_id: 'ch_internal',
      data: { foo: 'bar', baz: 42 },
      timestamp: '2025-01-01T00:00:00.000Z',
    };

    const result = transformForClient(event) as Record<string, unknown>;

    // Internal fields must be stripped
    expect(result).not.toHaveProperty('workspace_id');
    expect(result).not.toHaveProperty('channel_id');
    expect(result).not.toHaveProperty('timestamp');
    expect(result).not.toHaveProperty('data');

    // Data fields should be spread into the result
    expect(result.type).toBe('some.future.event');
    expect(result.foo).toBe('bar');
    expect(result.baz).toBe(42);
  });
});
