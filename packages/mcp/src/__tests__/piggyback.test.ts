import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { enablePiggyback } from '../piggyback.js';
import type { SessionState } from '../types.js';

describe('piggyback unread messages', () => {
  let mcpServer: McpServer;
  let client: Client;
  let session: SessionState;
  const mockInbox = vi.fn();
  const mockAgentClient = { inbox: mockInbox } as any;

  beforeEach(async () => {
    vi.clearAllMocks();
    session = { agentToken: 'tok_test', agentName: 'bot1' };
    mcpServer = new McpServer({ name: 'test', version: '0.1.0' });

    enablePiggyback(
      mcpServer,
      () => session,
      () => mockAgentClient,
    );

    mcpServer.registerTool(
      'dummy_tool',
      {
        description: 'A test tool',
        inputSchema: { arg: z.string() },
      },
      async () => ({
        content: [{ type: 'text' as const, text: 'original result' }],
      }),
    );

    client = new Client({ name: 'test-client', version: '0.1.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), mcpServer.connect(st)]);
  });

  it('appends unread channels to tool response', async () => {
    mockInbox.mockResolvedValue({
      unread_channels: [{ channel_name: 'general', unread_count: 3 }],
      mentions: [],
      unread_dms: [],
    });

    const result = await client.callTool({
      name: 'dummy_tool',
      arguments: { arg: 'test' },
    });

    expect(result.content).toHaveLength(2);
    const piggyback = (result.content as any[])[1];
    expect(piggyback.type).toBe('text');
    expect(piggyback.text).toContain('--- Pending Messages ---');
    expect(piggyback.text).toContain('#general: 3 unread');
  });

  it('appends unread DMs to tool response', async () => {
    mockInbox.mockResolvedValue({
      unread_channels: [],
      mentions: [],
      unread_dms: [{ from: 'alice', unread_count: 2 }],
    });

    const result = await client.callTool({
      name: 'dummy_tool',
      arguments: { arg: 'test' },
    });

    expect(result.content).toHaveLength(2);
    const piggyback = (result.content as any[])[1];
    expect(piggyback.text).toContain('Unread DMs:');
    expect(piggyback.text).toContain('From alice: 2 unread');
  });

  it('appends mentions to tool response', async () => {
    mockInbox.mockResolvedValue({
      unread_channels: [],
      mentions: [
        { agent_name: 'bob', channel_name: 'dev', text: 'hey @bot1' },
      ],
      unread_dms: [],
    });

    const result = await client.callTool({
      name: 'dummy_tool',
      arguments: { arg: 'test' },
    });

    expect(result.content).toHaveLength(2);
    const piggyback = (result.content as any[])[1];
    expect(piggyback.text).toContain('Mentions:');
    expect(piggyback.text).toContain('@bob in #dev');
  });

  it('does not append when inbox is empty', async () => {
    mockInbox.mockResolvedValue({
      unread_channels: [],
      mentions: [],
      unread_dms: [],
    });

    const result = await client.callTool({
      name: 'dummy_tool',
      arguments: { arg: 'test' },
    });

    expect(result.content).toHaveLength(1);
    expect((result.content as any[])[0].text).toBe('original result');
  });

  it('skips piggyback for check_inbox tool', async () => {
    const server2 = new McpServer({ name: 'test2', version: '0.1.0' });
    enablePiggyback(server2, () => session, () => mockAgentClient);
    server2.registerTool(
      'check_inbox',
      { description: 'Check inbox', inputSchema: { arg: z.string() } },
      async () => ({ content: [{ type: 'text' as const, text: 'inbox data' }] }),
    );
    const client2 = new Client({ name: 'test-client2', version: '0.1.0' });
    const [ct2, st2] = InMemoryTransport.createLinkedPair();
    await Promise.all([client2.connect(ct2), server2.connect(st2)]);

    await client2.callTool({ name: 'check_inbox', arguments: { arg: 'test' } });

    expect(mockInbox).not.toHaveBeenCalled();
  });

  it('skips piggyback for register tool', async () => {
    const server2 = new McpServer({ name: 'test2', version: '0.1.0' });
    enablePiggyback(server2, () => session, () => mockAgentClient);
    server2.registerTool(
      'register',
      { description: 'Register', inputSchema: { arg: z.string() } },
      async () => ({ content: [{ type: 'text' as const, text: 'registered' }] }),
    );
    const client2 = new Client({ name: 'test-client2', version: '0.1.0' });
    const [ct2, st2] = InMemoryTransport.createLinkedPair();
    await Promise.all([client2.connect(ct2), server2.connect(st2)]);

    await client2.callTool({ name: 'register', arguments: { arg: 'test' } });

    expect(mockInbox).not.toHaveBeenCalled();
  });

  it('skips piggyback when agent is not registered', async () => {
    session.agentToken = null;

    mockInbox.mockResolvedValue({
      unread_channels: [{ channel_name: 'general', unread_count: 1 }],
      mentions: [],
      unread_dms: [],
    });

    const result = await client.callTool({
      name: 'dummy_tool',
      arguments: { arg: 'test' },
    });

    expect(result.content).toHaveLength(1);
    expect(mockInbox).not.toHaveBeenCalled();
  });

  it('handles inbox error gracefully', async () => {
    mockInbox.mockRejectedValue(new Error('Network error'));

    const result = await client.callTool({
      name: 'dummy_tool',
      arguments: { arg: 'test' },
    });

    expect(result.content).toHaveLength(1);
    expect((result.content as any[])[0].text).toBe('original result');
  });
});
