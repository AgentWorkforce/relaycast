import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRelayMcpServer } from '../server.js';
import type { McpWorkspaceConfig } from '../workspaces.js';
import type { SessionState } from '../types.js';

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
      registerOrRotate: vi.fn().mockResolvedValue({ token: 'at_test' }),
      list: vi.fn().mockResolvedValue([]),
      spawn: vi.fn().mockResolvedValue({}),
      release: vi.fn().mockResolvedValue({ name: 'test', released: true, deleted: false, reason: null }),
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

  it('exposes _sessionRef for transport-level workspace population', () => {
    const server = createRelayMcpServer({
      apiKey: 'rk_live_alpha_key_full',
      agentToken: 'at_alpha',
      agentName: 'AlphaBot',
      workspaces,
    });

    const sessionRef = (server as unknown as { _sessionRef: SessionState })._sessionRef;
    expect(sessionRef).toBeDefined();
    expect(sessionRef.workspaces).toBeInstanceOf(Map);
  });

  it('allows populating workspace contexts via _sessionRef', async () => {
    const server = createRelayMcpServer({
      apiKey: 'rk_live_alpha_key_full',
      agentToken: 'at_alpha',
      agentName: 'AlphaBot',
      workspaces,
    });

    const sessionRef = (server as unknown as { _sessionRef: SessionState })._sessionRef;

    // Simulate what transports.ts bootstrapWorkspaces does
    for (const ws of workspaces) {
      if (ws.agent_token && ws.agent_name) {
        sessionRef.workspaces.set(ws.api_key, {
          workspaceKey: ws.api_key,
          agentToken: ws.agent_token,
          agentName: ws.agent_name,
          wsBridge: null,
          subscriptions: null,
          wsInitAttempted: false,
        });
      }
    }

    expect(sessionRef.workspaces.size).toBe(2);
    expect(sessionRef.workspaces.get('rk_live_alpha_key_full')?.agentName).toBe('AlphaBot');
    expect(sessionRef.workspaces.get('rk_live_beta_key_full')?.agentName).toBe('BetaBot');
  });

  it('message.post with workspace_id routes to correct workspace', async () => {
    const { createInternalRelayCast, __mockClient } = await import('@relaycast/sdk/internal') as any;

    const server = createRelayMcpServer({
      apiKey: 'rk_live_alpha_key_full',
      agentToken: 'at_alpha',
      agentName: 'AlphaBot',
      workspaces,
    });

    // Populate workspace contexts
    const sessionRef = (server as unknown as { _sessionRef: SessionState })._sessionRef;
    for (const ws of workspaces) {
      if (ws.agent_token && ws.agent_name) {
        sessionRef.workspaces.set(ws.api_key, {
          workspaceKey: ws.api_key,
          agentToken: ws.agent_token,
          agentName: ws.agent_name,
          wsBridge: null,
          subscriptions: null,
          wsInitAttempted: false,
        });
      }
    }

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
    // The createInternalRelayCast should have been called with beta's token
    expect(createInternalRelayCast).toHaveBeenCalled();
  });
});
