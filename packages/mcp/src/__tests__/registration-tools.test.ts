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
      name: 'create_workspace',
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

  it('set_workspace_key stores key and clears agent identity when switching key', async () => {
    session.workspaceKey = 'rk_live_old';
    session.agentToken = 'at_live_old';
    session.agentName = 'old-agent';

    const result = await client.callTool({
      name: 'set_workspace_key',
      arguments: { api_key: 'rk_live_new' },
    });

    expect(result.isError).toBeFalsy();
    expect(session.workspaceKey).toBe('rk_live_new');
    expect(session.agentToken).toBeNull();
    expect(session.agentName).toBeNull();
  });

  it('register returns error when workspace key is not configured', async () => {
    const result = await client.callTool({
      name: 'register',
      arguments: { name: 'bot1' },
    });
    expect(result.isError).toBe(true);
    expect(mockRelay.agents.register).not.toHaveBeenCalled();
  });

  it('register tool calls relay.agents.register and stores token', async () => {
    session.workspaceKey = 'rk_live_test';
    mockRelay.agents.register.mockResolvedValue({
      agent: { name: 'bot1' },
      token: 'tok_abc',
    });

    const result = await client.callTool({
      name: 'register',
      arguments: { name: 'bot1' },
    });

    expect(mockRelay.agents.register).toHaveBeenCalledWith({
      name: 'bot1',
      type: undefined,
      persona: undefined,
    });
    expect(session.agentToken).toBe('tok_abc');
    expect(session.agentName).toBe('bot1');
    expect(result.content).toBeDefined();
  });

  it('list_agents tool calls relay.agents.list', async () => {
    session.workspaceKey = 'rk_live_test';
    mockRelay.agents.list.mockResolvedValue([{ name: 'bot1', status: 'online' }]);

    const result = await client.callTool({ name: 'list_agents', arguments: {} });
    expect(mockRelay.agents.list).toHaveBeenCalledWith(undefined);
    expect(result.content).toBeDefined();
  });

  it('list_agents with status filter', async () => {
    session.workspaceKey = 'rk_live_test';
    mockRelay.agents.list.mockResolvedValue([]);
    await client.callTool({
      name: 'list_agents',
      arguments: { status: 'online' },
    });
    expect(mockRelay.agents.list).toHaveBeenCalledWith({ status: 'online' });
  });
});
