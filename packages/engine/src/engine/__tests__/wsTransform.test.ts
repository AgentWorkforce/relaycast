import { describe, it, expect } from 'vitest';
import { transformForClient, type WsEvent } from '../wsTransform.js';
import { stableRelaycastEventId } from '../event-id.js';

/**
 * Focused coverage for the long tail of `transformForClient` event-type branches.
 *
 * The workspaceEvents / httpPushEphemeralEvents conformance tests already assert the
 * common `message.created` and `agent.status.active` shapes. These tests pin the exact
 * output shape of every *other* branch: field renames (from_name -> agent_name,
 * thread_id -> parent_id), snake_case wire fields, dropped internal fields
 * (workspace_id / channel_id / timestamp), fallback defaults, and the passthrough
 * default branch.
 */

const BASE = {
  workspace_id: 'ws_1',
  timestamp: '2026-07-06T00:00:00.000Z',
} as const;

function ev(partial: Partial<WsEvent> & { type: string; data: Record<string, unknown> }): WsEvent {
  return { ...BASE, ...partial } as WsEvent;
}

describe('transformForClient - message.created', () => {
  it('renames from_name -> agent_name, derives stable id, keeps channel_id, prefers data.created_at', () => {
    const out = transformForClient(
      ev({
        type: 'message.created',
        channel_id: 'chan_1',
        data: {
          id: 'msg_1',
          created_at: '2026-01-02T03:04:05.000Z',
          channel_name: 'general',
          agent_id: 'agent_1',
          from_name: 'Ada',
          text: 'hello',
          attachments: [{ file_id: 'f1' }],
          injection_mode: 'steer',
        },
      }),
    );

    expect(out).toEqual({
      id: stableRelaycastEventId('msg_1'),
      type: 'message.created',
      created_at: '2026-01-02T03:04:05.000Z',
      channel_id: 'chan_1',
      channel: 'general',
      message: {
        id: 'msg_1',
        agent_id: 'agent_1',
        agent_name: 'Ada',
        text: 'hello',
        attachments: [{ file_id: 'f1' }],
        injection_mode: 'steer',
      },
    });
  });

  it('falls back to event.timestamp when data.created_at is missing, defaults attachments to []', () => {
    const out = transformForClient(
      ev({
        type: 'message.created',
        data: {
          id: 'msg_2',
          channel_name: 'general',
          agent_id: 'agent_1',
          from_name: 'Ada',
          text: 'hi',
        },
      }),
    ) as Record<string, unknown>;

    expect(out.created_at).toBe(BASE.timestamp);
    // channel_id omitted entirely when event.channel_id is absent
    expect('channel_id' in out).toBe(false);
    expect((out.message as Record<string, unknown>).attachments).toEqual([]);
    expect((out.message as Record<string, unknown>).injection_mode).toBeUndefined();
  });
});

describe('transformForClient - message.updated', () => {
  it('produces no id, renames from_name -> agent_name', () => {
    const out = transformForClient(
      ev({
        type: 'message.updated',
        channel_id: 'chan_1',
        data: {
          id: 'msg_1',
          channel_name: 'general',
          agent_id: 'agent_1',
          from_name: 'Ada',
          text: 'edited',
        },
      }),
    );

    expect(out).toEqual({
      type: 'message.updated',
      created_at: BASE.timestamp,
      channel_id: 'chan_1',
      channel: 'general',
      message: { id: 'msg_1', agent_id: 'agent_1', agent_name: 'Ada', text: 'edited' },
    });
    expect('id' in out).toBe(false);
  });
});

describe('transformForClient - thread.reply', () => {
  it('renames thread_id -> parent_id, includes conversation_id when present', () => {
    const out = transformForClient(
      ev({
        type: 'thread.reply',
        channel_id: 'chan_1',
        data: {
          id: 'msg_3',
          conversation_id: 'conv_1',
          channel_name: 'general',
          thread_id: 'msg_root',
          agent_id: 'agent_1',
          from_name: 'Ada',
          text: 'reply',
        },
      }),
    );

    expect(out).toEqual({
      id: stableRelaycastEventId('msg_3'),
      type: 'thread.reply',
      created_at: BASE.timestamp,
      channel_id: 'chan_1',
      conversation_id: 'conv_1',
      channel: 'general',
      parent_id: 'msg_root',
      message: { id: 'msg_3', agent_id: 'agent_1', agent_name: 'Ada', text: 'reply' },
    });
  });

  it('omits conversation_id when absent', () => {
    const out = transformForClient(
      ev({
        type: 'thread.reply',
        data: { id: 'msg_4', channel_name: 'general', thread_id: 'root', from_name: 'Ada', text: 't' },
      }),
    );
    expect('conversation_id' in out).toBe(false);
  });
});

describe('transformForClient - message.reacted', () => {
  it('includes optional channel/conversation_id/agent_id and defaults action to "added"', () => {
    const out = transformForClient(
      ev({
        type: 'message.reacted',
        channel_id: 'chan_1',
        data: {
          channel_name: 'general',
          conversation_id: 'conv_1',
          message_id: 'msg_1',
          emoji: '👍',
          agent_id: 'agent_1',
          agent_name: 'Ada',
        },
      }),
    );

    expect(out).toEqual({
      type: 'message.reacted',
      created_at: BASE.timestamp,
      channel_id: 'chan_1',
      channel: 'general',
      conversation_id: 'conv_1',
      message_id: 'msg_1',
      emoji: '👍',
      agent_id: 'agent_1',
      agent_name: 'Ada',
      action: 'added',
    });
  });

  it('omits optional channel/conversation_id/agent_id when absent and honors explicit action', () => {
    const out = transformForClient(
      ev({
        type: 'message.reacted',
        data: { message_id: 'msg_1', emoji: '🔥', agent_name: 'Ada', action: 'removed' },
      }),
    );

    expect(out).toEqual({
      type: 'message.reacted',
      created_at: BASE.timestamp,
      message_id: 'msg_1',
      emoji: '🔥',
      agent_name: 'Ada',
      action: 'removed',
    });
  });
});

describe('transformForClient - dm.received', () => {
  it('reads from nested message bag and includes injection_mode + attachments when set', () => {
    const out = transformForClient(
      ev({
        type: 'dm.received',
        data: {
          conversation_id: 'conv_1',
          message: {
            id: 'dm_1',
            agent_id: 'agent_1',
            agent_name: 'Ada',
            text: 'hey',
            injection_mode: 'wait',
            attachments: [{ file_id: 'f1' }],
          },
        },
      }),
    );

    expect(out).toEqual({
      id: stableRelaycastEventId('dm_1'),
      type: 'dm.received',
      created_at: BASE.timestamp,
      conversation_id: 'conv_1',
      message: {
        id: 'dm_1',
        agent_id: 'agent_1',
        agent_name: 'Ada',
        text: 'hey',
        injection_mode: 'wait',
        attachments: [{ file_id: 'f1' }],
      },
    });
  });

  it('falls back to flat fields (from_agent_id / from_name) and omits empty attachments/injection_mode', () => {
    const out = transformForClient(
      ev({
        type: 'dm.received',
        data: {
          conversation_id: 'conv_2',
          id: 'dm_2',
          from_agent_id: 'agent_2',
          from_name: 'Grace',
          text: 'flat',
        },
      }),
    );

    expect(out).toEqual({
      id: stableRelaycastEventId('dm_2'),
      type: 'dm.received',
      created_at: BASE.timestamp,
      conversation_id: 'conv_2',
      message: { id: 'dm_2', agent_id: 'agent_2', agent_name: 'Grace', text: 'flat' },
    });
    expect('attachments' in (out.message as object)).toBe(false);
    expect('injection_mode' in (out.message as object)).toBe(false);
  });
});

describe('transformForClient - group_dm.received', () => {
  it('reads nested message, falling back to flat agent_id (not from_agent_id)', () => {
    const out = transformForClient(
      ev({
        type: 'group_dm.received',
        data: {
          conversation_id: 'gc_1',
          id: 'gdm_1',
          agent_id: 'agent_3',
          from_name: 'Lin',
          text: 'group',
        },
      }),
    );

    expect(out).toEqual({
      id: stableRelaycastEventId('gdm_1'),
      type: 'group_dm.received',
      created_at: BASE.timestamp,
      conversation_id: 'gc_1',
      message: { id: 'gdm_1', agent_id: 'agent_3', agent_name: 'Lin', text: 'group' },
    });
  });

  it('reads the nested message bag including injection_mode + attachments', () => {
    const out = transformForClient(
      ev({
        type: 'group_dm.received',
        data: {
          conversation_id: 'gc_2',
          message: {
            id: 'gdm_2',
            agent_id: 'agent_4',
            agent_name: 'Mae',
            text: 'nested group',
            injection_mode: 'steer',
            attachments: [{ file_id: 'f2' }],
          },
        },
      }),
    );

    expect(out).toEqual({
      id: stableRelaycastEventId('gdm_2'),
      type: 'group_dm.received',
      created_at: BASE.timestamp,
      conversation_id: 'gc_2',
      message: {
        id: 'gdm_2',
        agent_id: 'agent_4',
        agent_name: 'Mae',
        text: 'nested group',
        injection_mode: 'steer',
        attachments: [{ file_id: 'f2' }],
      },
    });
  });
});

describe('transformForClient - agent.status.*', () => {
  const statuses: Array<[string, string]> = [
    ['agent.status.active', 'active'],
    ['agent.status.offline', 'offline'],
    ['agent.status.idle', 'idle'],
    ['agent.status.blocked', 'blocked'],
    ['agent.status.waiting', 'waiting'],
  ];

  for (const [type, status] of statuses) {
    it(`${type} yields agent ref + fixed status "${status}"`, () => {
      const out = transformForClient(
        ev({ type, data: { agent_id: 'agent_1', agent_name: 'Ada' } }),
      );
      expect(out).toEqual({
        type,
        created_at: BASE.timestamp,
        agent: { id: 'agent_1', name: 'Ada' },
        status,
      });
    });
  }

  it('agent.status.changed passes through data.status', () => {
    const out = transformForClient(
      ev({ type: 'agent.status.changed', data: { agent_id: 'agent_1', agent_name: 'Ada', status: 'thinking' } }),
    );
    expect(out).toEqual({
      type: 'agent.status.changed',
      created_at: BASE.timestamp,
      agent: { id: 'agent_1', name: 'Ada' },
      status: 'thinking',
    });
  });

  it('agent ref falls back to subject_agent_id when agent_id absent', () => {
    const out = transformForClient(
      ev({ type: 'agent.status.active', data: { subject_agent_id: 'agent_9', agent_name: 'Ada' } }),
    );
    expect((out.agent as Record<string, unknown>).id).toBe('agent_9');
  });

  it('agent ref omits id entirely when no agent id is present', () => {
    const out = transformForClient(
      ev({ type: 'agent.status.idle', data: { agent_name: 'Ada' } }),
    );
    expect(out.agent).toEqual({ name: 'Ada' });
    expect('id' in (out.agent as object)).toBe(false);
  });
});

describe('transformForClient - channel.created / channel.updated', () => {
  it('channel.created uses event.channel_id and channel_name, topic passthrough', () => {
    const out = transformForClient(
      ev({
        type: 'channel.created',
        channel_id: 'chan_1',
        data: { channel_name: 'general', topic: 'welcome' },
      }),
    );
    expect(out).toEqual({
      type: 'channel.created',
      created_at: BASE.timestamp,
      channel_id: 'chan_1',
      channel: { name: 'general', topic: 'welcome' },
    });
  });

  it('channel.updated falls back to data.id for channel_id and data.name for name, topic defaults to null', () => {
    const out = transformForClient(
      ev({ type: 'channel.updated', data: { id: 'chan_2', name: 'random' } }),
    );
    expect(out).toEqual({
      type: 'channel.updated',
      created_at: BASE.timestamp,
      channel_id: 'chan_2',
      channel: { name: 'random', topic: null },
    });
  });

  it('channel.created omits channel_id when neither event.channel_id nor data.id present', () => {
    const out = transformForClient(
      ev({ type: 'channel.created', data: { channel_name: 'general' } }),
    );
    expect('channel_id' in out).toBe(false);
    expect(out.channel).toEqual({ name: 'general', topic: null });
  });
});

describe('transformForClient - channel.archived', () => {
  it('emits only channel name (no topic)', () => {
    const out = transformForClient(
      ev({ type: 'channel.archived', channel_id: 'chan_1', data: { channel_name: 'general' } }),
    );
    expect(out).toEqual({
      type: 'channel.archived',
      created_at: BASE.timestamp,
      channel_id: 'chan_1',
      channel: { name: 'general' },
    });
  });
});

describe('transformForClient - member.joined / member.left', () => {
  it('member.joined includes agent_id when present', () => {
    const out = transformForClient(
      ev({
        type: 'member.joined',
        channel_id: 'chan_1',
        data: { channel_name: 'general', agent_id: 'agent_1', agent_name: 'Ada' },
      }),
    );
    expect(out).toEqual({
      type: 'member.joined',
      created_at: BASE.timestamp,
      channel_id: 'chan_1',
      channel: 'general',
      agent_id: 'agent_1',
      agent_name: 'Ada',
    });
  });

  it('member.left omits agent_id when absent', () => {
    const out = transformForClient(
      ev({ type: 'member.left', data: { channel_name: 'general', agent_name: 'Ada' } }),
    );
    expect(out).toEqual({
      type: 'member.left',
      created_at: BASE.timestamp,
      channel: 'general',
      agent_name: 'Ada',
    });
    expect('agent_id' in out).toBe(false);
  });
});

describe('transformForClient - message.read', () => {
  it('includes message_id, read_at and optional conversation_id/agent_id', () => {
    const out = transformForClient(
      ev({
        type: 'message.read',
        channel_id: 'chan_1',
        data: {
          message_id: 'msg_1',
          conversation_id: 'conv_1',
          agent_id: 'agent_1',
          agent_name: 'Ada',
          read_at: '2026-07-06T01:00:00.000Z',
        },
      }),
    );
    expect(out).toEqual({
      type: 'message.read',
      created_at: BASE.timestamp,
      channel_id: 'chan_1',
      message_id: 'msg_1',
      conversation_id: 'conv_1',
      agent_id: 'agent_1',
      agent_name: 'Ada',
      read_at: '2026-07-06T01:00:00.000Z',
    });
  });

  it('omits optional conversation_id/agent_id/channel_id when absent', () => {
    const out = transformForClient(
      ev({
        type: 'message.read',
        data: { message_id: 'msg_2', agent_name: 'Ada', read_at: '2026-07-06T02:00:00.000Z' },
      }),
    );
    expect(out).toEqual({
      type: 'message.read',
      created_at: BASE.timestamp,
      message_id: 'msg_2',
      agent_name: 'Ada',
      read_at: '2026-07-06T02:00:00.000Z',
    });
  });
});

describe('transformForClient - file.uploaded', () => {
  it('builds file bag with snake_case file_id, filename, uploaded_by', () => {
    const out = transformForClient(
      ev({
        type: 'file.uploaded',
        data: {
          file_id: 'file_1',
          filename: 'report.pdf',
          uploaded_by: 'agent_1',
          agent_id: 'agent_1',
        },
      }),
    );
    expect(out).toEqual({
      type: 'file.uploaded',
      created_at: BASE.timestamp,
      agent_id: 'agent_1',
      file: { file_id: 'file_1', filename: 'report.pdf', uploaded_by: 'agent_1' },
    });
  });

  it('falls back to data.id for file_id and data.agent_id for uploaded_by; omits top-level agent_id when absent', () => {
    const out = transformForClient(
      ev({
        type: 'file.uploaded',
        data: { id: 'file_2', filename: 'notes.txt' },
      }),
    );
    expect(out).toEqual({
      type: 'file.uploaded',
      created_at: BASE.timestamp,
      file: { file_id: 'file_2', filename: 'notes.txt', uploaded_by: undefined },
    });
    expect('agent_id' in out).toBe(false);
  });
});

describe('transformForClient - webhook.received', () => {
  it('nests message with source/author defaulting to null', () => {
    const out = transformForClient(
      ev({
        type: 'webhook.received',
        channel_id: 'chan_1',
        data: {
          webhook_id: 'wh_1',
          channel: 'general',
          message_id: 'msg_1',
          text: 'ping',
        },
      }),
    );
    expect(out).toEqual({
      type: 'webhook.received',
      created_at: BASE.timestamp,
      channel_id: 'chan_1',
      webhook_id: 'wh_1',
      channel: 'general',
      message: { id: 'msg_1', text: 'ping', source: null, author: null },
    });
  });

  it('passes through source/author when provided', () => {
    const out = transformForClient(
      ev({
        type: 'webhook.received',
        data: {
          webhook_id: 'wh_2',
          channel: 'general',
          message_id: 'msg_2',
          text: 'ping',
          source: 'github',
          author: 'octocat',
        },
      }),
    );
    expect((out.message as Record<string, unknown>)).toEqual({
      id: 'msg_2',
      text: 'ping',
      source: 'github',
      author: 'octocat',
    });
  });
});

describe('transformForClient - default (passthrough) branch', () => {
  it('strips workspace_id/channel_id/timestamp and data wrapper, spreads type + data + created_at', () => {
    const out = transformForClient(
      ev({
        type: 'some.unknown.event',
        channel_id: 'chan_1',
        data: { foo: 'bar', nested: { a: 1 }, created_at: '2026-05-05T00:00:00.000Z' },
      }),
    );

    expect(out).toEqual({
      type: 'some.unknown.event',
      foo: 'bar',
      nested: { a: 1 },
      created_at: '2026-05-05T00:00:00.000Z',
    });
    // internal-only fields must not leak to clients
    expect('workspace_id' in out).toBe(false);
    expect('channel_id' in out).toBe(false);
    expect('timestamp' in out).toBe(false);
    expect('data' in out).toBe(false);
  });

  it('default branch falls back to event.timestamp for created_at when data has none', () => {
    const out = transformForClient(
      ev({ type: 'other.event', data: { hello: 'world' } }),
    );
    expect(out).toEqual({
      type: 'other.event',
      hello: 'world',
      created_at: BASE.timestamp,
    });
  });

  it('default branch: a string data.created_at is preserved as created_at', () => {
    // createdAt is derived from d.created_at when it is a string, then re-applied last
    // via withCreatedAt, so the client-facing created_at reflects the data value.
    const out = transformForClient(
      ev({ type: 'other.event', data: { created_at: '2020-01-01T00:00:00.000Z' } }),
    );
    expect(out.created_at).toBe('2020-01-01T00:00:00.000Z');
  });
});
