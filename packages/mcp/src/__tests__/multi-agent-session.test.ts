import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpWorkspaceConfig } from '../workspaces.js';

vi.mock('@relaycast/sdk/internal', () => {
  const agentClients = new Map<string, {
    send: ReturnType<typeof vi.fn>;
    inbox: ReturnType<typeof vi.fn>;
  }>();
  const relayCalls: Array<{
    apiKey: string;
    relay: { as: ReturnType<typeof vi.fn> };
  }> = [];

  const getAgentClient = (token: string) => {
    let client = agentClients.get(token);
    if (!client) {
      client = {
        send: vi.fn().mockResolvedValue({ id: `msg-${token}` }),
        inbox: vi.fn().mockResolvedValue({
          unreadChannels: [],
          mentions: [],
          unreadDms: [],
          recentReactions: [],
        }),
      };
      agentClients.set(token, client);
    }
    return client;
  };

  const createInternalRelayCast = vi.fn().mockImplementation(({ apiKey }) => {
    const relay = {
      as: vi.fn().mockImplementation((agentToken: string) => getAgentClient(agentToken)),
      agents: {
        register: vi.fn(),
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
    };
    relayCalls.push({ apiKey, relay });
    return relay;
  });

  const createInternalWsClient = vi.fn().mockReturnValue({
    on: vi.fn().mockReturnValue(() => {}),
    connect: vi.fn(),
    disconnect: vi.fn(),
  });

  return {
    createInternalRelayCast,
    createInternalWsClient,
    __agentClients: agentClients,
    __relayCalls: relayCalls,
  };
});

import { createRelayMcpServer } from '../server.js';

describe('multi-agent routed session dispatch', () => {
  let client: Client;

  const workspaces: McpWorkspaceConfig[] = [
    {
      workspace_id: 'ws_alpha',
      workspace_alias: 'alpha',
      api_key: 'rk_live_alpha',
      agent_token: 'at_alpha',
      agent_name: 'AlphaBot',
    },
    {
      workspace_id: 'ws_beta',
      workspace_alias: 'beta',
      api_key: 'rk_live_beta',
      agent_token: 'at_beta',
      agent_name: 'BetaBot',
    },
  ];

  beforeEach(async () => {
    vi.clearAllMocks();
    const internal = await import('@relaycast/sdk/internal') as any;
    internal.__agentClients.clear();
    internal.__relayCalls.length = 0;

    const mcpServer = createRelayMcpServer({
      apiKey: 'rk_live_alpha',
      agentToken: 'at_alpha',
      agentName: 'AlphaBot',
      workspaces,
    });
    client = new Client({ name: 'multi-agent-session-client', version: '0.1.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), mcpServer.connect(st)]);
  });

  it('dispatches routed message.post calls through as(targetToken)', async () => {
    const internal = await import('@relaycast/sdk/internal') as any;

    const result = await client.callTool({
      name: 'message.post',
      arguments: {
        channel: 'general',
        text: 'hello beta',
        workspace_id: 'ws_beta',
      },
    });

    expect(result.isError).toBeFalsy();
    const betaClient = internal.__agentClients.get('at_beta');
    expect(betaClient).toBeDefined();
    expect(betaClient.send).toHaveBeenCalledWith('general', 'hello beta', undefined);

    const betaRelayCall = internal.__relayCalls.findLast((entry: any) => entry.apiKey === 'at_beta');
    expect(betaRelayCall).toBeDefined();
    expect(betaRelayCall.relay.as).toHaveBeenCalledWith('at_beta');
  });

  it('returns a clear error for unknown routed workspace contexts', async () => {
    const result = await client.callTool({
      name: 'message.post',
      arguments: {
        channel: 'general',
        text: 'hello nowhere',
        workspace_id: 'ws_unknown',
      },
    });

    expect(result.isError).toBe(true);
    const first = (result.content ?? [])[0] as { text?: string } | undefined;
    expect(first?.text).toContain('Workspace not found: ws_unknown');
    expect(first?.text).toContain('Join the workspace first');
  });
});
