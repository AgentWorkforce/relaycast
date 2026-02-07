import { describe, it, expect, vi, beforeEach } from 'vitest';
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

  const mockRelay = {
    agents: {
      register: vi.fn(),
      list: vi.fn(),
    },
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    session = createInitialSession();
    mcpServer = new McpServer({ name: 'test', version: '0.1.0' });

    registerRegistrationTools(
      mcpServer,
      () => mockRelay as any,
      () => session,
      (partial) => {
        Object.assign(session, partial);
      },
    );

    client = new Client({ name: 'test-client', version: '0.1.0' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      mcpServer.connect(serverTransport),
    ]);
  });

  it('register tool calls relay.agents.register and stores token', async () => {
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
    mockRelay.agents.list.mockResolvedValue([{ name: 'bot1', status: 'online' }]);

    const result = await client.callTool({ name: 'list_agents', arguments: {} });
    expect(mockRelay.agents.list).toHaveBeenCalledWith(undefined);
    expect(result.content).toBeDefined();
  });

  it('list_agents with status filter', async () => {
    mockRelay.agents.list.mockResolvedValue([]);
    await client.callTool({
      name: 'list_agents',
      arguments: { status: 'online' },
    });
    expect(mockRelay.agents.list).toHaveBeenCalledWith({ status: 'online' });
  });
});

