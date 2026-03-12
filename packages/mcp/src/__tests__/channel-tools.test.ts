import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerChannelTools } from '../tools/channels.js';

describe('channel tools', () => {
  let mcpServer: McpServer;
  let client: Client;

  const mockAgentClient = {
    channels: {
      create: vi.fn(),
      list: vi.fn(),
      join: vi.fn(),
      leave: vi.fn(),
      invite: vi.fn(),
      setTopic: vi.fn(),
      archive: vi.fn(),
    },
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    mcpServer = new McpServer({ name: 'test', version: '0.1.0' });
    registerChannelTools(mcpServer, () => mockAgentClient as any);

    client = new Client({ name: 'test-client', version: '0.1.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), mcpServer.connect(st)]);
  });

  it('create_channel calls channels.create', async () => {
    mockAgentClient.channels.create.mockResolvedValue({
      name: 'general',
      topic: 'Main',
    });

    const result = await client.callTool({
      name: 'channel.create',
      arguments: { name: 'general', topic: 'Main' },
    });
    expect(mockAgentClient.channels.create).toHaveBeenCalledWith({
      name: 'general',
      topic: 'Main',
    });
    expect(result.content).toBeDefined();
  });

  it('list_channels calls channels.list', async () => {
    mockAgentClient.channels.list.mockResolvedValue([]);
    await client.callTool({ name: 'channel.list', arguments: {} });
    expect(mockAgentClient.channels.list).toHaveBeenCalledWith(undefined);
  });

  it('join_channel calls channels.join', async () => {
    mockAgentClient.channels.join.mockResolvedValue(undefined);
    const result = await client.callTool({
      name: 'channel.join',
      arguments: { channel: 'general' },
    });
    expect(mockAgentClient.channels.join).toHaveBeenCalledWith('general');
    expect(result.content).toEqual([
      { type: 'text', text: 'Joined channel #general' },
    ]);
  });

  it('leave_channel calls channels.leave', async () => {
    mockAgentClient.channels.leave.mockResolvedValue(undefined);
    await client.callTool({
      name: 'channel.leave',
      arguments: { channel: 'general' },
    });
    expect(mockAgentClient.channels.leave).toHaveBeenCalledWith('general');
  });

  it('invite_to_channel calls channels.invite', async () => {
    mockAgentClient.channels.invite.mockResolvedValue(undefined);
    await client.callTool({
      name: 'channel.invite',
      arguments: { channel: 'general', agent: 'bot1' },
    });
    expect(mockAgentClient.channels.invite).toHaveBeenCalledWith('general', 'bot1');
  });

  it('set_channel_topic calls channels.setTopic', async () => {
    mockAgentClient.channels.setTopic.mockResolvedValue({
      name: 'general',
      topic: 'New',
    });
    await client.callTool({
      name: 'channel.set_topic',
      arguments: { channel: 'general', topic: 'New' },
    });
    expect(mockAgentClient.channels.setTopic).toHaveBeenCalledWith('general', 'New');
  });

  it('archive_channel calls channels.archive', async () => {
    mockAgentClient.channels.archive.mockResolvedValue(undefined);
    const result = await client.callTool({
      name: 'channel.archive',
      arguments: { channel: 'old' },
    });
    expect(mockAgentClient.channels.archive).toHaveBeenCalledWith('old');
    expect(result.content).toEqual([
      { type: 'text', text: 'Archived channel #old' },
    ]);
  });
});

