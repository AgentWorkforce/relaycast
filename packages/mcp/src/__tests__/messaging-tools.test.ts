import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerMessagingTools } from '../tools/messaging.js';

describe('messaging tools', () => {
  let mcpServer: McpServer;
  let client: Client;
  const mockAgentClient = {
    send: vi.fn(),
    messages: vi.fn(),
    reply: vi.fn(),
    thread: vi.fn(),
    dm: vi.fn(),
    dms: {
      conversations: vi.fn(),
      createGroup: vi.fn(),
      sendMessage: vi.fn(),
    },
  };
  const betaAgentClient = {
    send: vi.fn(),
    messages: vi.fn(),
    reply: vi.fn(),
    thread: vi.fn(),
    dm: vi.fn(),
    dms: {
      conversations: vi.fn(),
      createGroup: vi.fn(),
      sendMessage: vi.fn(),
    },
  };
  const getAgentClient = vi.fn((workspace?: { workspaceId?: string; workspaceAlias?: string }) => {
    if (workspace?.workspaceId === 'ws_beta' || workspace?.workspaceAlias === 'beta') {
      return betaAgentClient as any;
    }
    return mockAgentClient as any;
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    mcpServer = new McpServer({ name: 'test', version: '0.1.0' });
    registerMessagingTools(mcpServer, getAgentClient);
    client = new Client({ name: 'test-client', version: '0.1.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), mcpServer.connect(st)]);
  });

  it('post_message calls send()', async () => {
    mockAgentClient.send.mockResolvedValue({ id: 'msg1', text: 'hello' });
    const result = await client.callTool({
      name: 'post_message',
      arguments: { channel: 'general', text: 'hello' },
    });
    expect(mockAgentClient.send).toHaveBeenCalledWith('general', 'hello', undefined);
    expect(result.content).toBeDefined();
  });

  it('post_message routes by workspace_alias', async () => {
    betaAgentClient.send.mockResolvedValue({ id: 'msg-beta', text: 'hello beta' });
    await client.callTool({
      name: 'post_message',
      arguments: { workspace_alias: 'beta', channel: 'ops', text: 'hello beta' },
    });
    expect(getAgentClient).toHaveBeenCalledWith({ workspaceAlias: 'beta' });
    expect(betaAgentClient.send).toHaveBeenCalledWith('ops', 'hello beta', undefined);
    expect(mockAgentClient.send).not.toHaveBeenCalled();
  });

  it('get_messages calls messages()', async () => {
    mockAgentClient.messages.mockResolvedValue([]);
    await client.callTool({ name: 'get_messages', arguments: { channel: 'general' } });
    expect(mockAgentClient.messages).toHaveBeenCalledWith('general', {
      limit: undefined,
      before: undefined,
      after: undefined,
    });
  });

  it('get_messages routes by workspace_id', async () => {
    betaAgentClient.messages.mockResolvedValue([]);
    await client.callTool({
      name: 'get_messages',
      arguments: { workspace_id: 'ws_beta', channel: 'ops' },
    });
    expect(getAgentClient).toHaveBeenCalledWith({ workspaceId: 'ws_beta' });
    expect(betaAgentClient.messages).toHaveBeenCalledWith('ops', {
      limit: undefined,
      before: undefined,
      after: undefined,
    });
  });

  it('reply_to_thread calls reply()', async () => {
    mockAgentClient.reply.mockResolvedValue({ id: 'reply1' });
    await client.callTool({
      name: 'reply_to_thread',
      arguments: { message_id: 'msg1', text: 'reply' },
    });
    expect(mockAgentClient.reply).toHaveBeenCalledWith('msg1', 'reply');
  });

  it('reply_to_thread routes by workspace_alias', async () => {
    betaAgentClient.reply.mockResolvedValue({ id: 'reply_beta' });
    await client.callTool({
      name: 'reply_to_thread',
      arguments: { workspace_alias: 'beta', message_id: 'msg1', text: 'reply' },
    });
    expect(getAgentClient).toHaveBeenCalledWith({ workspaceAlias: 'beta' });
    expect(betaAgentClient.reply).toHaveBeenCalledWith('msg1', 'reply');
  });

  it('get_thread calls thread()', async () => {
    mockAgentClient.thread.mockResolvedValue({ parent: {}, replies: [] });
    await client.callTool({ name: 'get_thread', arguments: { message_id: 'msg1' } });
    expect(mockAgentClient.thread).toHaveBeenCalledWith('msg1', undefined);
  });

  it('send_dm calls dm()', async () => {
    mockAgentClient.dm.mockResolvedValue({});
    await client.callTool({ name: 'send_dm', arguments: { to: 'bot2', text: 'hi' } });
    expect(mockAgentClient.dm).toHaveBeenCalledWith('bot2', 'hi');
  });

  it('send_dm routes by workspace_id', async () => {
    betaAgentClient.dm.mockResolvedValue({});
    await client.callTool({
      name: 'send_dm',
      arguments: { workspace_id: 'ws_beta', to: 'bot2', text: 'hi' },
    });
    expect(getAgentClient).toHaveBeenCalledWith({ workspaceId: 'ws_beta' });
    expect(betaAgentClient.dm).toHaveBeenCalledWith('bot2', 'hi');
  });

  it('get_dms calls dms.conversations()', async () => {
    mockAgentClient.dms.conversations.mockResolvedValue([]);
    await client.callTool({ name: 'get_dms', arguments: {} });
    expect(mockAgentClient.dms.conversations).toHaveBeenCalled();
  });

  it('send_group_dm calls dms.createGroup()', async () => {
    mockAgentClient.dms.createGroup.mockResolvedValue({ id: 'conv1' });
    mockAgentClient.dms.sendMessage.mockResolvedValue({ id: 'msg1' });
    await client.callTool({
      name: 'send_group_dm',
      arguments: { participants: ['a', 'b'], name: 'grp', text: 'hello group' },
    });
    expect(mockAgentClient.dms.createGroup).toHaveBeenCalledWith({
      participants: ['a', 'b'],
      name: 'grp',
    });
    expect(mockAgentClient.dms.sendMessage).toHaveBeenCalledWith('conv1', 'hello group');
  });

  it('returns an error when multiple workspaces exist and no target is specified', async () => {
    getAgentClient.mockImplementation(() => {
      throw new Error('Ambiguous workspace selection. Provide workspace_id or workspace_alias.');
    });

    const result = await client.callTool({
      name: 'post_message',
      arguments: { channel: 'general', text: 'hello' },
    });

    expect(result.isError).toBe(true);
    expect((result.content?.[0] as { text?: string } | undefined)?.text).toContain(
      'Ambiguous workspace selection. Provide workspace_id or workspace_alias.',
    );
  });
});
