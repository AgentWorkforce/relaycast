import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

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

  const createInternalRelayCast = vi.fn().mockImplementation(({ apiKey }) => ({
    as: vi.fn(),
    agents: {
      register: vi.fn().mockImplementation(async ({ name }: { name?: string }) => ({
        agent: { name: apiKey === 'rk_live_beta' ? 'BetaBot' : (name ?? 'AlphaBot') },
        token: apiKey === 'rk_live_beta'
          ? 'at_beta'
          : name === 'AlphaBotRenamed'
            ? 'at_alpha_2'
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

describe('multi-agent wsBridge lifecycle', () => {
  let client: Client;
  let mcpServer: ReturnType<typeof createRelayMcpServer>;
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

    mcpServer = createRelayMcpServer({
      apiKey: 'rk_live_alpha',
      agentToken: 'at_alpha',
      agentName: 'AlphaBot',
      baseUrl: 'https://api.test.dev',
    });

    client = new Client({ name: 'multi-agent-bridge-client', version: '0.1.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), mcpServer.connect(st)]);
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('stops and recreates the bridge when the active agent token changes across workspaces', async () => {
    const internal = await import('@relaycast/sdk/internal') as any;
    const resourceUpdatedSpy = vi.spyOn(mcpServer.server, 'sendResourceUpdated').mockResolvedValue(undefined);

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

    await client.subscribeResource({ uri: 'relay://inbox' });
    await client.subscribeResource({ uri: 'relay://channels' });
    resourceUpdatedSpy.mockClear();

    const switchBackResult = await client.callTool({
      name: 'workspace.switch',
      arguments: { api_key: 'rk_live_beta' },
    });
    expect(switchBackResult.isError).toBeFalsy();

    expect(resourceUpdatedSpy).toHaveBeenCalledWith({ uri: 'relay://inbox' });
    expect(resourceUpdatedSpy).toHaveBeenCalledWith({ uri: 'relay://channels' });
  });

  it('does not recreate the bridge when the agent token changes inside the same workspace', async () => {
    const internal = await import('@relaycast/sdk/internal') as any;
    const resourceUpdatedSpy = vi.spyOn(mcpServer.server, 'sendResourceUpdated').mockResolvedValue(undefined);

    expect(internal.__wsClients).toHaveLength(1);
    expect(internal.__wsClients[0].token).toBe('at_alpha');

    await client.subscribeResource({ uri: 'relay://inbox' });
    await client.subscribeResource({ uri: 'relay://channels' });
    resourceUpdatedSpy.mockClear();

    const registerResult = await client.callTool({
      name: 'agent.register',
      arguments: { name: 'AlphaBotRenamed' },
    });
    expect(registerResult.isError).toBeFalsy();

    expect(internal.__wsClients).toHaveLength(1);
    expect(internal.__wsClients[0].unsubscribe).not.toHaveBeenCalled();
    expect(internal.__wsClients[0].disconnect).not.toHaveBeenCalled();
    expect(internal.__wsClients[0].connect).toHaveBeenCalledTimes(1);
    expect(resourceUpdatedSpy).toHaveBeenCalledWith({ uri: 'relay://inbox' });
    expect(resourceUpdatedSpy).toHaveBeenCalledWith({ uri: 'relay://channels' });
  });
});
