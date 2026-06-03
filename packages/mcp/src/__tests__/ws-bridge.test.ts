import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { WsClientEvent } from '@relaycast/sdk';

vi.mock('@relaycast/sdk/internal', () => {
  const wsClients: Array<{
    token: string;
    on: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    unsubscribe: ReturnType<typeof vi.fn>;
  }> = [];

  const createInternalWsClient = vi.fn().mockImplementation(({ token }) => {
    const unsubscribe = vi.fn();
    const client = {
      token,
      on: vi.fn().mockReturnValue(unsubscribe),
      connect: vi.fn(),
      disconnect: vi.fn(),
      unsubscribe,
    };
    wsClients.push(client);
    return client;
  });

  const createInternalRelayCast = vi.fn().mockImplementation(() => ({
    as: vi.fn(),
    agents: {
      registerOrRotate: vi.fn().mockImplementation(async ({ name }: { name: string }) => ({
        agent: { name },
        token:
          name === 'BetaBot'
            ? 'at_beta'
            : name === 'AlphaBotV2'
              ? 'at_alpha_v2'
              : 'at_alpha',
      })),
      list: vi.fn(),
    },
    webhooks: {
      create: vi.fn(),
      list: vi.fn(),
      delete: vi.fn(),
      trigger: vi.fn(),
    },
    subscriptions: {
      create: vi.fn(),
      list: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
    },
    commands: {
      register: vi.fn(),
      list: vi.fn(),
      delete: vi.fn(),
    },
  }));

  return {
    createInternalRelayCast,
    createInternalWsClient,
    __wsClients: wsClients,
  };
});

import { createRelayMcpServer } from '../server.js';
import { eventToResourceUris } from '../resources/ws-bridge.js';

describe('eventToResourceUris', () => {
  it('maps message.created to inbox and channel', () => {
    const event = {
      type: 'message.created',
      channel: 'general',
      message: { id: 'm1', agentName: 'bot', text: 'hi', attachments: [] },
    } as WsClientEvent;
    expect(eventToResourceUris(event)).toEqual([
      'relay://inbox',
      'relay://channels/general/messages',
    ]);
  });

  it('maps message.updated to channel only', () => {
    const event = {
      type: 'message.updated',
      channel: 'general',
      message: { id: 'm1', agentName: 'bot', text: 'updated' },
    } as WsClientEvent;
    expect(eventToResourceUris(event)).toEqual([
      'relay://channels/general/messages',
    ]);
  });

  it('maps thread.reply to inbox and thread', () => {
    const event = {
      type: 'thread.reply',
      parentId: 'p1',
      message: { id: 'r1', agentName: 'bot', text: 'reply' },
    } as WsClientEvent;
    expect(eventToResourceUris(event)).toEqual([
      'relay://inbox',
      'relay://messages/p1/thread',
    ]);
  });

  it('maps dm.received to inbox and dm conversation', () => {
    const event = {
      type: 'dm.received',
      conversationId: 'conv1',
      message: { id: 'd1', agentName: 'bot', text: 'hey' },
    } as WsClientEvent;
    expect(eventToResourceUris(event)).toEqual([
      'relay://inbox',
      'relay://dm/conv1',
    ]);
  });

  it('maps group_dm.received to inbox and dm conversation', () => {
    const event = {
      type: 'group_dm.received',
      conversationId: 'gconv1',
      message: { id: 'g1', agentName: 'bot', text: 'group' },
    } as WsClientEvent;
    expect(eventToResourceUris(event)).toEqual([
      'relay://inbox',
      'relay://dm/gconv1',
    ]);
  });

  it('maps agent.status.active to agents resource', () => {
    const event = {
      type: 'agent.status.active',
      agent: { name: 'bot1' },
      status: 'active',
    } as WsClientEvent;
    expect(eventToResourceUris(event)).toEqual(['relay://agents']);
  });

  it('maps agent.status.offline to agents resource', () => {
    const event = {
      type: 'agent.status.offline',
      agent: { name: 'bot1' },
      status: 'offline',
    } as WsClientEvent;
    expect(eventToResourceUris(event)).toEqual(['relay://agents']);
  });

  it('maps channel.created to channels resource', () => {
    const event = {
      type: 'channel.created',
      channel: { name: 'new-ch', topic: null },
    } as WsClientEvent;
    expect(eventToResourceUris(event)).toEqual(['relay://channels']);
  });

  it('maps channel.archived to channels resource', () => {
    const event = {
      type: 'channel.archived',
      channel: { name: 'old-ch' },
    } as WsClientEvent;
    expect(eventToResourceUris(event)).toEqual(['relay://channels']);
  });

  it('maps channel.updated to channels resource', () => {
    const event = {
      type: 'channel.updated',
      channel: { name: 'general', topic: 'New topic' },
    } as WsClientEvent;
    expect(eventToResourceUris(event)).toEqual(['relay://channels']);
  });

  it('maps member.joined to channels resource', () => {
    const event = {
      type: 'member.joined',
      channel: 'general',
      agentName: 'bot1',
    } as WsClientEvent;
    expect(eventToResourceUris(event)).toEqual(['relay://channels']);
  });

  it('maps member.left to channels resource', () => {
    const event = {
      type: 'member.left',
      channel: 'general',
      agentName: 'bot1',
    } as WsClientEvent;
    expect(eventToResourceUris(event)).toEqual(['relay://channels']);
  });

  it('maps webhook.received to channel messages', () => {
    const event = {
      type: 'webhook.received',
      webhookId: 'wh_1',
      channel: 'alerts',
      message: { id: 'm1', text: 'deploy', source: null },
    } as WsClientEvent;
    expect(eventToResourceUris(event)).toEqual([
      'relay://channels/alerts/messages',
    ]);
  });

  it('maps command.invoked to channel messages', () => {
    const event = {
      type: 'command.invoked',
      command: '/deploy',
      channel: 'general',
      invokedBy: 'agent1',
      args: null,
    } as WsClientEvent;
    expect(eventToResourceUris(event)).toEqual([
      'relay://channels/general/messages',
    ]);
  });

  it('returns empty array for unknown event types', () => {
    const event = { type: 'pong' } as WsClientEvent;
    expect(eventToResourceUris(event)).toEqual([]);
  });

  it('maps message.reacted to inbox as a soft notification signal', () => {
    const event = {
      type: 'message.reacted',
      messageId: 'm1',
      emoji: 'thumbsup',
      agentName: 'bot',
      action: 'added',
    } as WsClientEvent;
    expect(eventToResourceUris(event)).toEqual(['relay://inbox']);
  });

  it('maps removed message.reacted to inbox as a soft notification signal', () => {
    const event = {
      type: 'message.reacted',
      messageId: 'm1',
      emoji: 'thumbsup',
      agentName: 'bot',
      action: 'removed',
    } as WsClientEvent;
    expect(eventToResourceUris(event)).toEqual(['relay://inbox']);
  });
});

describe('WsBridge lifecycle', () => {
  let client: Client;
  let originalFetch: typeof global.fetch;

  beforeEach(async () => {
    vi.clearAllMocks();
    const internal = await import('@relaycast/sdk/internal') as any;
    internal.__wsClients.length = 0;

    originalFetch = global.fetch;
    global.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(url.toString()).pathname;
      const headers = new Headers(init?.headers);
      const auth = headers.get('Authorization');

      if (path === '/v1/workspace') {
        return new Response(JSON.stringify({
          ok: true,
          data: {
            id: auth === 'Bearer rk_live_beta' ? 'ws_beta' : 'ws_alpha',
            name: auth === 'Bearer rk_live_beta' ? 'Beta Workspace' : 'Alpha Workspace',
            system_prompt: null,
            plan: 'free',
            created_at: new Date().toISOString(),
            metadata: {},
          },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ ok: true, data: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof global.fetch;

    const mcpServer = createRelayMcpServer({
      apiKey: 'rk_live_alpha',
      agentToken: 'at_alpha',
      agentName: 'AlphaBot',
      baseUrl: 'https://api.test.dev',
    });

    client = new Client({ name: 'ws-bridge-client', version: '0.1.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), mcpServer.connect(st)]);
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('does not recreate the bridge when the active agent token changes inside the same workspace', async () => {
    const internal = await import('@relaycast/sdk/internal') as any;

    expect(internal.__wsClients).toHaveLength(1);
    expect(internal.__wsClients[0].token).toBe('at_alpha');
    expect(internal.__wsClients[0].connect).toHaveBeenCalledTimes(1);

    const registerResult = await client.callTool({
      name: 'agent.register',
      arguments: { name: 'AlphaBotV2' },
    });
    expect(registerResult.isError).toBeFalsy();

    expect(internal.__wsClients).toHaveLength(1);
    expect(internal.__wsClients[0].unsubscribe).not.toHaveBeenCalled();
    expect(internal.__wsClients[0].disconnect).not.toHaveBeenCalled();
    expect(internal.__wsClients[0].connect).toHaveBeenCalledTimes(1);
  });

  it('stops and recreates the bridge when the active workspace changes', async () => {
    const internal = await import('@relaycast/sdk/internal') as any;

    expect(internal.__wsClients).toHaveLength(1);
    expect(internal.__wsClients[0].token).toBe('at_alpha');
    expect(internal.__wsClients[0].connect).toHaveBeenCalledTimes(1);

    const setKeyResult = await client.callTool({
      name: 'workspace.set_key',
      arguments: { api_key: 'rk_live_beta' },
    });
    expect(setKeyResult.isError).toBeFalsy();

    const registerResult = await client.callTool({
      name: 'agent.register',
      arguments: { name: 'BetaBot' },
    });
    expect(registerResult.isError).toBeFalsy();

    expect(internal.__wsClients[0].unsubscribe).toHaveBeenCalledTimes(1);
    expect(internal.__wsClients[0].disconnect).toHaveBeenCalledTimes(1);
    expect(internal.__wsClients).toHaveLength(2);
    expect(internal.__wsClients[1].token).toBe('at_beta');
    expect(internal.__wsClients[1].connect).toHaveBeenCalledTimes(1);

    const switchResult = await client.callTool({
      name: 'workspace.switch',
      arguments: { api_key: 'rk_live_alpha' },
    });
    expect(switchResult.isError).toBeFalsy();

    expect(internal.__wsClients[1].unsubscribe).toHaveBeenCalledTimes(1);
    expect(internal.__wsClients[1].disconnect).toHaveBeenCalledTimes(1);
    expect(internal.__wsClients).toHaveLength(3);
    expect(internal.__wsClients[2].token).toBe('at_alpha');
    expect(internal.__wsClients[2].connect).toHaveBeenCalledTimes(1);
  });
});
