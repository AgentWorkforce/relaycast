import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';
import type { AppEnv } from '../../env.js';
import { stableRelaycastEventId } from '../../engine/event-id.js';
import {
  fanoutToChannel,
  fanoutToAgents,
  fanoutToWorkspace,
  updateChannelMembers,
  getDmParticipantAgentIds,
} from '../../routes/fanout.js';
import { createMockBindings, FAKE_WORKSPACE } from '../../__tests__/test-helpers.js';

function createContext(bindings: AppEnv['Bindings']): Context<AppEnv> {
  return {
    env: bindings,
    get: ((key: string) => {
      if (key === 'workspace') return FAKE_WORKSPACE;
      return undefined;
    }) as any,
  } as Context<AppEnv>;
}

function createContextWithoutWorkspace(bindings: AppEnv['Bindings']): Context<AppEnv> {
  return {
    env: bindings,
    get: (() => undefined) as any,
  } as Context<AppEnv>;
}

describe('fanout helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fanoutToChannel calls ChannelDO broadcast with transformed event', async () => {
    const channelFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const bindings = createMockBindings() as AppEnv['Bindings'];
    bindings.CHANNEL_DO = {
      idFromName: vi.fn(() => 'channel-id'),
      get: vi.fn(() => ({ fetch: channelFetch })),
    } as unknown as DurableObjectNamespace;

    const c = createContext(bindings);
    await fanoutToChannel(c, 'ch_1', 'message.created', {
      id: 'msg_1',
      channel_name: 'general',
      agent_id: 'agent_1',
      from_name: 'Bot',
      text: 'hi',
      attachments: [],
    });

    expect(channelFetch).toHaveBeenCalledTimes(1);
    const req = channelFetch.mock.calls[0][0] as Request;
    expect(req.url).toBe('http://do/broadcast');
    const body = await req.json();
    expect(body.workspaceId).toBe(FAKE_WORKSPACE.id);
    expect(body.event).toEqual({
      id: stableRelaycastEventId('msg_1'),
      type: 'message.created',
      channel: 'general',
      message: {
        id: 'msg_1',
        agent_id: 'agent_1',
        agent_name: 'Bot',
        text: 'hi',
        attachments: [],
      },
    });
  });

  it('fanoutToAgents delivers to unique agents', async () => {
    const agentFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const bindings = createMockBindings() as AppEnv['Bindings'];
    bindings.AGENT_DO = {
      idFromName: vi.fn(() => 'agent-id'),
      get: vi.fn(() => ({ fetch: agentFetch })),
    } as unknown as DurableObjectNamespace;

    const c = createContext(bindings);
    await fanoutToAgents(c, ['a1', 'a2', 'a1'], 'dm.received', {
      id: 'msg_2',
      conversation_id: 'dm_1',
      from_agent_id: 'a1',
      from_name: 'Bot',
      text: 'hello',
    });

    expect(agentFetch).toHaveBeenCalledTimes(2);
    const req = agentFetch.mock.calls[0][0] as Request;
    const body = await req.json();
    expect(body.type).toBe('dm.received');
    expect(body.workspaceId).toBe(FAKE_WORKSPACE.id);
    expect(['a1', 'a2']).toContain(body.agentId);
  });

  it('fanoutToWorkspace queries PresenceDO then delivers to agents', async () => {
    const agentFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const presenceFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ agents: ['a1', 'a2'] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const bindings = createMockBindings() as AppEnv['Bindings'];
    bindings.AGENT_DO = {
      idFromName: vi.fn(() => 'agent-id'),
      get: vi.fn(() => ({ fetch: agentFetch })),
    } as unknown as DurableObjectNamespace;
    bindings.PRESENCE_DO = {
      idFromName: vi.fn(() => 'presence-id'),
      get: vi.fn(() => ({ fetch: presenceFetch })),
    } as unknown as DurableObjectNamespace;

    const c = createContext(bindings);
    await fanoutToWorkspace(c, 'file.uploaded', {
      id: 'file_1',
      filename: 'a.txt',
      agent_id: 'agent_1',
    });

    expect(presenceFetch).toHaveBeenCalledTimes(1);
    const req = presenceFetch.mock.calls[0][0] as Request;
    expect(req.url).toBe('http://do/status');
    expect(agentFetch).toHaveBeenCalledTimes(2);
  });

  it('updateChannelMembers posts members to ChannelDO', async () => {
    const channelFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const bindings = createMockBindings() as AppEnv['Bindings'];
    bindings.CHANNEL_DO = {
      idFromName: vi.fn(() => 'channel-id'),
      get: vi.fn(() => ({ fetch: channelFetch })),
    } as unknown as DurableObjectNamespace;

    const c = createContext(bindings);
    await updateChannelMembers(c, 'ch_2', ['a1', 'a2']);

    expect(channelFetch).toHaveBeenCalledTimes(1);
    const req = channelFetch.mock.calls[0][0] as Request;
    expect(req.url).toBe('http://do/update-members');
    const body = await req.json();
    expect(body.members).toEqual(['a1', 'a2']);
  });

  it('fanoutToChannel logs error when ChannelDO returns non-ok', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const channelFetch = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    const bindings = createMockBindings() as AppEnv['Bindings'];
    bindings.CHANNEL_DO = {
      idFromName: vi.fn(() => 'channel-id'),
      get: vi.fn(() => ({ fetch: channelFetch })),
    } as unknown as DurableObjectNamespace;

    const c = createContext(bindings);
    await fanoutToChannel(c, 'ch_1', 'message.created', { text: 'hi' });

    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('ChannelDO broadcast failed: 500 for channel ch_1'),
      expect.objectContaining({
        app_version: expect.any(String),
        sdk_version: expect.any(String),
      }),
    );
    consoleError.mockRestore();
  });

  it('fanoutToChannel logs on network error without throwing', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const channelFetch = vi.fn().mockRejectedValue(new Error('Network failure'));
    const bindings = createMockBindings() as AppEnv['Bindings'];
    bindings.CHANNEL_DO = {
      idFromName: vi.fn(() => 'channel-id'),
      get: vi.fn(() => ({ fetch: channelFetch })),
    } as unknown as DurableObjectNamespace;

    const c = createContext(bindings);
    await expect(fanoutToChannel(c, 'ch_1', 'message.created', { text: 'hi' }))
      .resolves.toBeUndefined();

    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('ChannelDO broadcast error for channel ch_1'),
      expect.objectContaining({
        error_message: 'Network failure',
      }),
    );
    consoleError.mockRestore();
  });

  it('fanoutToWorkspace logs error when PresenceDO status fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const presenceFetch = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    const bindings = createMockBindings() as AppEnv['Bindings'];
    bindings.PRESENCE_DO = {
      idFromName: vi.fn(() => 'presence-id'),
      get: vi.fn(() => ({ fetch: presenceFetch })),
    } as unknown as DurableObjectNamespace;

    const c = createContext(bindings);
    await fanoutToWorkspace(c, 'agent.online', { agent_name: 'Bot' });

    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('PresenceDO status failed: 500 for workspace ws_123'),
      expect.objectContaining({
        event_type: 'agent.online',
      }),
    );
    consoleError.mockRestore();
  });

  it('updateChannelMembers logs error when update-members fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const channelFetch = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    const bindings = createMockBindings() as AppEnv['Bindings'];
    bindings.CHANNEL_DO = {
      idFromName: vi.fn(() => 'channel-id'),
      get: vi.fn(() => ({ fetch: channelFetch })),
    } as unknown as DurableObjectNamespace;

    const c = createContext(bindings);
    await updateChannelMembers(c, 'ch_2', ['a1']);

    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('ChannelDO update-members failed: 500 for channel ch_2'),
      expect.objectContaining({
        channel_id: 'ch_2',
      }),
    );
    consoleError.mockRestore();
  });

  it('fanoutToChannel passes members array when provided', async () => {
    const channelFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const bindings = createMockBindings() as AppEnv['Bindings'];
    bindings.CHANNEL_DO = {
      idFromName: vi.fn(() => 'channel-id'),
      get: vi.fn(() => ({ fetch: channelFetch })),
    } as unknown as DurableObjectNamespace;

    const c = createContext(bindings);
    await fanoutToChannel(c, 'ch_1', 'message.created', { text: 'hi' }, ['agent_1', 'agent_2']);

    const req = channelFetch.mock.calls[0][0] as Request;
    const body = await req.json();
    expect(body.members).toEqual(['agent_1', 'agent_2']);
  });

  describe('getDmParticipantAgentIds', () => {
    function createDbContext(conversationRows: any[], participantRows: any[]) {
      const whereHandler = vi.fn()
        .mockResolvedValueOnce(conversationRows)
        .mockResolvedValueOnce(participantRows);

      const db = {
        select: () => ({
          from: () => ({
            where: whereHandler,
          }),
        }),
      };

      return {
        env: createMockBindings(),
        get: vi.fn((key: string) => {
          if (key === 'db') return db;
          if (key === 'workspace') return FAKE_WORKSPACE;
          return undefined;
        }),
      } as any;
    }

    it('returns agent IDs for a DM channel', async () => {
      const c = createDbContext(
        [{ id: 'conv_1' }],
        [{ agentId: 'agent_a' }, { agentId: 'agent_b' }],
      );

      const result = await getDmParticipantAgentIds(c, 'dmch_123');
      expect(result).toEqual(['agent_a', 'agent_b']);
    });

    it('returns null for a non-DM channel', async () => {
      const c = createDbContext([], []);
      const result = await getDmParticipantAgentIds(c, 'ch_regular');
      expect(result).toBeNull();
    });

    it('returns empty array when all DM participants have left', async () => {
      const c = createDbContext(
        [{ id: 'conv_2' }],
        [], // no active participants
      );

      const result = await getDmParticipantAgentIds(c, 'dmch_456');
      expect(result).toEqual([]);
    });

    it('returns null on DB error instead of throwing', async () => {
      const db = {
        select: () => ({
          from: () => ({
            where: vi.fn().mockRejectedValue(new Error('DB connection failed')),
          }),
        }),
      };

      const c = {
        env: createMockBindings(),
        get: vi.fn((key: string) => {
          if (key === 'db') return db;
          if (key === 'workspace') return FAKE_WORKSPACE;
          return undefined;
        }),
      } as any;

      const result = await getDmParticipantAgentIds(c, 'dmch_broken');
      expect(result).toBeNull();
    });
  });

  it('fanoutToChannel supports workspace override when context workspace is missing', async () => {
    const channelFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const bindings = createMockBindings() as AppEnv['Bindings'];
    bindings.CHANNEL_DO = {
      idFromName: vi.fn(() => 'channel-id'),
      get: vi.fn(() => ({ fetch: channelFetch })),
    } as unknown as DurableObjectNamespace;

    const c = createContextWithoutWorkspace(bindings);
    await fanoutToChannel(c, 'ch_1', 'webhook.received', {
      webhook_id: 'wh_1',
      channel: 'general',
      message_id: 'msg_1',
      text: 'hello',
      source: 'webhook',
    }, undefined, 'ws_999');

    const req = channelFetch.mock.calls[0][0] as Request;
    const body = await req.json();
    expect(body.workspaceId).toBe('ws_999');
  });
});
