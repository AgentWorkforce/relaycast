import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRelayMcpServer } from '../server.js';
import type { McpWorkspaceConfig } from '../workspaces.js';

// Mock the SDK internal modules
vi.mock('@relaycast/sdk/internal', () => {
  const mockClient = {
    send: vi.fn().mockResolvedValue({ id: 'msg1', text: 'hello' }),
    messages: vi.fn().mockResolvedValue([]),
    reply: vi.fn().mockResolvedValue({ id: 'reply1' }),
    thread: vi.fn().mockResolvedValue({ parent: {}, replies: [] }),
    dm: vi.fn().mockResolvedValue({}),
    inbox: vi.fn().mockResolvedValue({}),
    dms: {
      conversations: vi.fn().mockResolvedValue([]),
      createGroup: vi.fn().mockResolvedValue({ id: 'conv1' }),
      sendMessage: vi.fn().mockResolvedValue({ id: 'msg1' }),
    },
    channels: {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({}),
      join: vi.fn().mockResolvedValue(undefined),
      leave: vi.fn().mockResolvedValue(undefined),
      invite: vi.fn().mockResolvedValue(undefined),
      setTopic: vi.fn().mockResolvedValue({}),
      archive: vi.fn().mockResolvedValue(undefined),
    },
    react: vi.fn().mockResolvedValue(undefined),
    unreact: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
    markRead: vi.fn().mockResolvedValue(undefined),
    readers: vi.fn().mockResolvedValue([]),
    files: { upload: vi.fn().mockResolvedValue({}) },
    commands: { invoke: vi.fn().mockResolvedValue({}) },
  };

  const mockRelay = {
    as: vi.fn().mockReturnValue(mockClient),
    agents: {
      register: vi.fn().mockResolvedValue({ token: 'at_test' }),
      list: vi.fn().mockResolvedValue([]),
      spawn: vi.fn().mockResolvedValue({}),
      release: vi.fn().mockResolvedValue({
        invocationId: 'inv_release',
        actionName: 'release',
        handlerAgentId: null,
        handlerNodeId: 'node_broker',
        input: { name: 'test' },
        status: 'dispatched',
        createdAt: '2026-06-25T00:00:00.000Z',
        dispatchedNodeId: 'node_broker',
      }),
    },
    webhooks: {
      create: vi.fn().mockResolvedValue({}),
      list: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(undefined),
      trigger: vi.fn().mockResolvedValue({}),
    },
    subscriptions: {
      create: vi.fn().mockResolvedValue({}),
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    commands: {
      register: vi.fn().mockResolvedValue({}),
      list: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(undefined),
    },
  };

  return {
    createInternalRelayCast: vi.fn().mockReturnValue(mockRelay),
    createInternalWsClient: vi.fn().mockReturnValue({
      on: vi.fn(),
      connect: vi.fn(),
      close: vi.fn(),
    }),
    __mockClient: mockClient,
    __mockRelay: mockRelay,
  };
});

describe('multi-workspace server setup', () => {
  const workspaces: McpWorkspaceConfig[] = [
    {
      workspace_id: 'ws_alpha',
      workspace_alias: 'alpha',
      api_key: 'rk_live_alpha_key_full',
      agent_token: 'at_alpha',
      agent_name: 'AlphaBot',
    },
    {
      workspace_id: 'ws_beta',
      workspace_alias: 'beta',
      api_key: 'rk_live_beta_key_full',
      agent_token: 'at_beta',
      agent_name: 'BetaBot',
    },
  ];

  it('creates server with workspace configs in options', () => {
    const server = createRelayMcpServer({
      apiKey: 'rk_live_alpha_key_full',
      agentToken: 'at_alpha',
      agentName: 'AlphaBot',
      workspaces,
    });
    expect(server).toBeDefined();
  });

  it('populates workspace contexts during server creation', () => {
    // createRelayMcpServer now populates session.workspaces internally
    // from options.workspaces — no _sessionRef needed.
    const server = createRelayMcpServer({
      apiKey: 'rk_live_alpha_key_full',
      agentToken: 'at_alpha',
      agentName: 'AlphaBot',
      workspaces,
    });
    expect(server).toBeDefined();
  });

  it('message.post with workspace_id routes to correct workspace', async () => {
    const { createInternalRelayCast, __mockClient, __mockRelay } = await import('@relaycast/sdk/internal') as any;

    // Workspace contexts are now populated during server creation
    const server = createRelayMcpServer({
      apiKey: 'rk_live_alpha_key_full',
      agentToken: 'at_alpha',
      agentName: 'AlphaBot',
      workspaces,
    });

    const client = new Client({ name: 'test-client', version: '0.1.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), server.connect(st)]);

    // Call message.post with workspace_id targeting beta workspace
    __mockClient.send.mockResolvedValue({ id: 'msg_beta', text: 'hello beta' });

    const result = await client.callTool({
      name: 'message.post',
      arguments: {
        channel: 'general',
        text: 'hello beta',
        workspace_id: 'ws_beta',
      },
    });

    expect(result.content).toBeDefined();
    expect(createInternalRelayCast).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'at_beta',
      }),
      expect.anything(),
    );
    expect(__mockRelay.as).toHaveBeenLastCalledWith('at_beta');
  });

  it('message.post without workspace routing uses the active workspace identity', async () => {
    const { createInternalRelayCast, __mockClient, __mockRelay } = await import('@relaycast/sdk/internal') as any;

    const server = createRelayMcpServer({
      apiKey: 'rk_live_alpha_key_full',
      agentToken: 'at_alpha',
      agentName: 'AlphaBot',
      workspaces,
    });

    const client = new Client({ name: 'test-client', version: '0.1.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), server.connect(st)]);

    __mockClient.send.mockResolvedValue({ id: 'msg_alpha', text: 'hello alpha' });

    const result = await client.callTool({
      name: 'message.post',
      arguments: {
        channel: 'general',
        text: 'hello alpha',
      },
    });

    expect(result.content).toBeDefined();
    expect(createInternalRelayCast).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'at_alpha',
      }),
      expect.anything(),
    );
    expect(__mockRelay.as).toHaveBeenLastCalledWith('at_alpha');
  });

  it('message.post with workspace_id and as uses the registered workspace identity', async () => {
    const { createInternalRelayCast, __mockClient, __mockRelay } = await import('@relaycast/sdk/internal') as any;

    const server = createRelayMcpServer({
      apiKey: 'rk_live_alpha_key_full',
      agentToken: 'at_alpha',
      agentName: 'AlphaBot',
      workspaces,
    });

    const client = new Client({ name: 'test-client', version: '0.1.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), server.connect(st)]);

    __mockRelay.as.mockClear();
    __mockClient.send.mockResolvedValue({ id: 'msg_beta_as', text: 'hello beta as beta' });

    const result = await client.callTool({
      name: 'message.post',
      arguments: {
        channel: 'general',
        text: 'hello beta as beta',
        workspace_id: 'ws_beta',
        as: 'BetaBot',
      },
    });

    expect(result.isError).toBeFalsy();
    expect(createInternalRelayCast).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'at_beta',
      }),
      expect.anything(),
    );
    expect(__mockRelay.as).toHaveBeenLastCalledWith('at_beta');
  });

  it('message.post returns an error for unknown as identity in a routed workspace', async () => {
    const server = createRelayMcpServer({
      apiKey: 'rk_live_alpha_key_full',
      agentToken: 'at_alpha',
      agentName: 'AlphaBot',
      workspaces,
    });

    const client = new Client({ name: 'test-client', version: '0.1.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), server.connect(st)]);

    const result = await client.callTool({
      name: 'message.post',
      arguments: {
        channel: 'general',
        text: 'ghost write',
        workspace_id: 'ws_beta',
        as: 'GhostBot',
      },
    });

    expect(result.isError).toBe(true);
    const firstContent = result.content?.[0] as { text?: string } | undefined;
    expect(firstContent?.text).toContain('Unknown agent identity "GhostBot"');
  });
});
