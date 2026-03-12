import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerRegistrationTools } from '../tools/registration.js';
import type { SessionState } from '../types.js';
import { createInitialSession } from '../types.js';

// Test using the in-memory transport round-trip approach
describe('registration tools', () => {
  let mcpServer: McpServer;
  let client: Client;
  let session: SessionState;
  let originalFetch: typeof global.fetch;

  const mockRelay = {
    agents: {
      register: vi.fn(),
      registerOrRotate: vi.fn(),
      list: vi.fn(),
    },
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    originalFetch = global.fetch;
    session = createInitialSession();
    mcpServer = new McpServer({ name: 'test', version: '0.1.0' });

    registerRegistrationTools(
      mcpServer,
      () => mockRelay as any,
      () => session,
      (partial) => {
        Object.assign(session, partial);
      },
      'https://api.test.dev',
    );

    client = new Client({ name: 'test-client', version: '0.1.0' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      mcpServer.connect(serverTransport),
    ]);
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('create_workspace creates workspace and stores workspace key in session', async () => {
    global.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            workspace_id: 'ws_123',
            api_key: 'rk_live_created123',
          },
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof global.fetch;

    const result = await client.callTool({
      name: 'workspace.create',
      arguments: { name: 'project-alpha' },
    });

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.test.dev/v1/workspaces',
      expect.objectContaining({
        method: 'POST',
      }),
    );
    expect(session.workspaceKey).toBe('rk_live_created123');
    expect(session.agentToken).toBeNull();
    expect(session.agentName).toBeNull();
    expect(result.content).toBeDefined();
  });

  it('set_workspace_key saves prior context and clears identity for new workspace', async () => {
    session.workspaceKey = 'rk_live_old';
    session.agentToken = 'at_live_old';
    session.agentName = 'old-agent';

    const result = await client.callTool({
      name: 'workspace.set_key',
      arguments: { api_key: 'rk_live_new' },
    });

    expect(result.isError).toBeFalsy();
    expect(session.workspaceKey).toBe('rk_live_new');
    expect(session.agentToken).toBeNull();
    expect(session.agentName).toBeNull();
    // Previous workspace context should be saved.
    const saved = session.workspaces.get('rk_live_old');
    expect(saved).toBeDefined();
    expect(saved!.agentToken).toBe('at_live_old');
    expect(saved!.agentName).toBe('old-agent');
  });

  it('set_workspace_key restores saved context when switching back', async () => {
    // Simulate a previously joined workspace.
    session.workspaceKey = 'rk_live_ws1';
    session.agentToken = 'at_live_ws1';
    session.agentName = 'bot-ws1';
    session.workspaces.set('rk_live_ws2', {
      workspaceKey: 'rk_live_ws2',
      agentToken: 'at_live_ws2',
      agentName: 'bot-ws2',
      wsBridge: null,
      subscriptions: null,
      wsInitAttempted: false,
    });

    await client.callTool({
      name: 'workspace.set_key',
      arguments: { api_key: 'rk_live_ws2' },
    });

    expect(session.workspaceKey).toBe('rk_live_ws2');
    expect(session.agentToken).toBe('at_live_ws2');
    expect(session.agentName).toBe('bot-ws2');
  });

  it('register returns error when workspace key is not configured', async () => {
    const result = await client.callTool({
      name: 'agent.register',
      arguments: { name: 'bot1' },
    });
    expect(result.isError).toBe(true);
    expect(mockRelay.agents.register).not.toHaveBeenCalled();
  });

  it('register tool calls relay.agents.register and stores token', async () => {
    session.workspaceKey = 'rk_live_test';
    mockRelay.agents.registerOrRotate.mockResolvedValue({
      agent: { name: 'bot1' },
      token: 'tok_abc',
    });

    const result = await client.callTool({
      name: 'agent.register',
      arguments: { name: 'bot1' },
    });

    expect(mockRelay.agents.registerOrRotate).toHaveBeenCalledWith({
      name: 'bot1',
      type: undefined,
      persona: undefined,
      metadata: undefined,
    });
    expect(session.agentToken).toBe('tok_abc');
    expect(session.agentName).toBe('bot1');
    expect(result.content).toBeDefined();
  });

  it('list_agents tool calls relay.agents.list', async () => {
    session.workspaceKey = 'rk_live_test';
    mockRelay.agents.list.mockResolvedValue([{ name: 'bot1', status: 'online' }]);

    const result = await client.callTool({ name: 'agent.list', arguments: {} });
    expect(mockRelay.agents.list).toHaveBeenCalledWith(undefined);
    expect(result.content).toBeDefined();
  });

  it('list_agents with status filter', async () => {
    session.workspaceKey = 'rk_live_test';
    mockRelay.agents.list.mockResolvedValue([]);
    await client.callTool({
      name: 'agent.list',
      arguments: { status: 'online' },
    });
    expect(mockRelay.agents.list).toHaveBeenCalledWith({ status: 'online' });
  });

  // Multi-workspace tools

  it('list_workspaces returns empty when no workspaces joined', async () => {
    const result = await client.callTool({ name: 'workspace.list', arguments: {} });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as any)[0].text);
    expect(parsed.workspaces).toEqual([]);
  });

  it('list_workspaces returns joined workspaces', async () => {
    session.workspaceKey = 'rk_live_ws1_abcdefgh';
    session.workspaces.set('rk_live_ws1_abcdefgh', {
      workspaceKey: 'rk_live_ws1_abcdefgh',
      agentToken: 'at_live_ws1',
      agentName: 'bot1',
      wsBridge: null,
      subscriptions: null,
      wsInitAttempted: false,
    });
    session.workspaces.set('rk_live_ws2_abcdefgh', {
      workspaceKey: 'rk_live_ws2_abcdefgh',
      agentToken: 'at_live_ws2',
      agentName: 'bot2',
      wsBridge: null,
      subscriptions: null,
      wsInitAttempted: false,
    });

    const result = await client.callTool({ name: 'workspace.list', arguments: {} });
    const parsed = JSON.parse((result.content as any)[0].text);
    expect(parsed.workspaces).toHaveLength(2);
    const active = parsed.workspaces.find((w: any) => w.is_active);
    expect(active.agent_name).toBe('bot1');
  });

  it('join_workspace registers in new workspace and saves context', async () => {
    session.workspaceKey = 'rk_live_ws1';
    session.agentToken = 'at_live_ws1';
    session.agentName = 'bot1';

    mockRelay.agents.registerOrRotate.mockResolvedValue({
      agent: { name: 'bot2' },
      token: 'at_live_ws2',
    });

    const result = await client.callTool({
      name: 'workspace.join',
      arguments: { api_key: 'rk_live_ws2', name: 'bot2' },
    });

    expect(result.isError).toBeFalsy();
    expect(session.workspaceKey).toBe('rk_live_ws2');
    expect(session.agentToken).toBe('at_live_ws2');
    expect(session.agentName).toBe('bot2');
    // Previous workspace should be saved.
    expect(session.workspaces.get('rk_live_ws1')?.agentName).toBe('bot1');
    // New workspace should also be saved.
    expect(session.workspaces.get('rk_live_ws2')?.agentName).toBe('bot2');
  });

  it('join_workspace returns existing context if already joined', async () => {
    session.workspaceKey = 'rk_live_ws1';
    session.agentToken = 'at_live_ws1';
    session.agentName = 'bot1';
    session.workspaces.set('rk_live_ws2', {
      workspaceKey: 'rk_live_ws2',
      agentToken: 'at_live_ws2',
      agentName: 'bot2',
      wsBridge: null,
      subscriptions: null,
      wsInitAttempted: false,
    });

    const result = await client.callTool({
      name: 'workspace.join',
      arguments: { api_key: 'rk_live_ws2', name: 'bot2' },
    });

    expect(result.isError).toBeFalsy();
    expect(mockRelay.agents.registerOrRotate).not.toHaveBeenCalled();
    expect(session.workspaceKey).toBe('rk_live_ws2');
    expect(session.agentToken).toBe('at_live_ws2');
    expect(session.agentName).toBe('bot2');
  });

  it('switch_workspace restores saved context', async () => {
    session.workspaceKey = 'rk_live_ws1';
    session.agentToken = 'at_live_ws1';
    session.agentName = 'bot1';
    session.workspaces.set('rk_live_ws1', {
      workspaceKey: 'rk_live_ws1',
      agentToken: 'at_live_ws1',
      agentName: 'bot1',
      wsBridge: null,
      subscriptions: null,
      wsInitAttempted: false,
    });
    session.workspaces.set('rk_live_ws2', {
      workspaceKey: 'rk_live_ws2',
      agentToken: 'at_live_ws2',
      agentName: 'bot2',
      wsBridge: null,
      subscriptions: null,
      wsInitAttempted: false,
    });

    const result = await client.callTool({
      name: 'workspace.switch',
      arguments: { api_key: 'rk_live_ws2' },
    });

    expect(result.isError).toBeFalsy();
    expect(session.workspaceKey).toBe('rk_live_ws2');
    expect(session.agentToken).toBe('at_live_ws2');
    expect(session.agentName).toBe('bot2');
  });

  it('switch_workspace errors for unknown workspace', async () => {
    session.workspaceKey = 'rk_live_ws1';

    const result = await client.callTool({
      name: 'workspace.switch',
      arguments: { api_key: 'rk_live_unknown' },
    });

    expect(result.isError).toBe(true);
  });

  it('register saves context to workspaces map', async () => {
    session.workspaceKey = 'rk_live_test';
    mockRelay.agents.registerOrRotate.mockResolvedValue({
      agent: { name: 'bot1' },
      token: 'tok_abc',
    });

    await client.callTool({
      name: 'agent.register',
      arguments: { name: 'bot1' },
    });

    const saved = session.workspaces.get('rk_live_test');
    expect(saved).toBeDefined();
    expect(saved!.agentToken).toBe('tok_abc');
    expect(saved!.agentName).toBe('bot1');
  });
});
