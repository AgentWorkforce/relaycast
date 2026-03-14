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
      arguments: { name: 'general', topic: 'Main', as: 'OwnerBot' },
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
      arguments: { channel: 'general', as: 'OwnerBot' },
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
      arguments: { channel: 'general', as: 'OwnerBot' },
    });
    expect(mockAgentClient.channels.leave).toHaveBeenCalledWith('general');
  });

  it('invite_to_channel calls channels.invite', async () => {
    mockAgentClient.channels.invite.mockResolvedValue(undefined);
    await client.callTool({
      name: 'channel.invite',
      arguments: { channel: 'general', agent: 'bot1', as: 'OwnerBot' },
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
      arguments: { channel: 'general', topic: 'New', as: 'OwnerBot' },
    });
    expect(mockAgentClient.channels.setTopic).toHaveBeenCalledWith('general', 'New');
  });

  it('archive_channel calls channels.archive', async () => {
    mockAgentClient.channels.archive.mockResolvedValue(undefined);
    const result = await client.callTool({
      name: 'channel.archive',
      arguments: { channel: 'old', as: 'OwnerBot' },
    });
    expect(mockAgentClient.channels.archive).toHaveBeenCalledWith('old');
    expect(result.content).toEqual([
      { type: 'text', text: 'Archived channel #old' },
    ]);
  });
});

describe('channel tools with identity overrides', () => {
  let mcpServer: McpServer;
  let client: Client;

  const defaultClient = {
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
  const identityClient = {
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

  const getAgentClient = vi.fn((_wsRouting?: { workspace_id?: string; workspace_alias?: string }, as?: string) => {
    if (as === 'OwnerBot') {
      return identityClient as any;
    }
    return defaultClient as any;
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    mcpServer = new McpServer({ name: 'test', version: '0.1.0' });
    registerChannelTools(mcpServer, getAgentClient);

    client = new Client({ name: 'test-client', version: '0.1.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), mcpServer.connect(st)]);
  });

  it('channel.create passes as to getAgentClient', async () => {
    identityClient.channels.create.mockResolvedValue({ name: 'general', topic: 'Main' });
    await client.callTool({
      name: 'channel.create',
      arguments: { name: 'general', topic: 'Main', as: 'OwnerBot' },
    });
    expect(getAgentClient).toHaveBeenCalledWith(undefined, 'OwnerBot');
    expect(identityClient.channels.create).toHaveBeenCalledWith({ name: 'general', topic: 'Main' });
  });

  it('channel.list passes workspace routing and as to getAgentClient', async () => {
    identityClient.channels.list.mockResolvedValue([]);
    await client.callTool({
      name: 'channel.list',
      arguments: { workspace_alias: 'beta', as: 'OwnerBot' },
    });
    expect(getAgentClient).toHaveBeenCalledWith({ workspace_id: undefined, workspace_alias: 'beta' }, 'OwnerBot');
    expect(identityClient.channels.list).toHaveBeenCalledWith(undefined);
  });

  it('channel.join falls back to the active identity when as is omitted', async () => {
    defaultClient.channels.join.mockResolvedValue(undefined);
    await client.callTool({
      name: 'channel.join',
      arguments: { channel: 'general' },
    });
    expect(getAgentClient).toHaveBeenCalledWith(undefined, undefined);
    expect(defaultClient.channels.join).toHaveBeenCalledWith('general');
  });

  it('channel.leave passes as to getAgentClient', async () => {
    identityClient.channels.leave.mockResolvedValue(undefined);
    await client.callTool({
      name: 'channel.leave',
      arguments: { channel: 'general', as: 'OwnerBot' },
    });
    expect(getAgentClient).toHaveBeenCalledWith(undefined, 'OwnerBot');
    expect(identityClient.channels.leave).toHaveBeenCalledWith('general');
  });

  it('channel.invite passes as to getAgentClient', async () => {
    identityClient.channels.invite.mockResolvedValue(undefined);
    await client.callTool({
      name: 'channel.invite',
      arguments: { channel: 'general', agent: 'bot1', as: 'OwnerBot' },
    });
    expect(getAgentClient).toHaveBeenCalledWith(undefined, 'OwnerBot');
    expect(identityClient.channels.invite).toHaveBeenCalledWith('general', 'bot1');
  });

  it('channel.set_topic passes as to getAgentClient', async () => {
    identityClient.channels.setTopic.mockResolvedValue({ name: 'general', topic: 'New' });
    await client.callTool({
      name: 'channel.set_topic',
      arguments: { channel: 'general', topic: 'New', workspace_id: 'ws_beta', as: 'OwnerBot' },
    });
    expect(getAgentClient).toHaveBeenCalledWith({ workspace_id: 'ws_beta', workspace_alias: undefined }, 'OwnerBot');
    expect(identityClient.channels.setTopic).toHaveBeenCalledWith('general', 'New');
  });

  it('channel.archive passes workspace routing and as to getAgentClient', async () => {
    identityClient.channels.archive.mockResolvedValue(undefined);
    await client.callTool({
      name: 'channel.archive',
      arguments: { channel: 'old', workspace_alias: 'beta', as: 'OwnerBot' },
    });
    expect(getAgentClient).toHaveBeenCalledWith({ workspace_id: undefined, workspace_alias: 'beta' }, 'OwnerBot');
    expect(identityClient.channels.archive).toHaveBeenCalledWith('old');
  });
});
