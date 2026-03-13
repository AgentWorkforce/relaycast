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

  beforeEach(async () => {
    vi.clearAllMocks();
    mcpServer = new McpServer({ name: 'test', version: '0.1.0' });
    registerMessagingTools(mcpServer, () => mockAgentClient as any);
    client = new Client({ name: 'test-client', version: '0.1.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), mcpServer.connect(st)]);
  });

  it('post_message calls send()', async () => {
    mockAgentClient.send.mockResolvedValue({ id: 'msg1', text: 'hello' });
    const result = await client.callTool({
      name: 'message.post',
      arguments: { channel: 'general', text: 'hello' },
    });
    expect(mockAgentClient.send).toHaveBeenCalledWith('general', 'hello', undefined);
    expect(result.content).toBeDefined();
  });

  it('get_messages calls messages()', async () => {
    mockAgentClient.messages.mockResolvedValue([]);
    await client.callTool({ name: 'message.list', arguments: { channel: 'general' } });
    expect(mockAgentClient.messages).toHaveBeenCalledWith('general', {
      limit: undefined,
      before: undefined,
      after: undefined,
    });
  });

  it('reply_to_thread calls reply()', async () => {
    mockAgentClient.reply.mockResolvedValue({ id: 'reply1' });
    await client.callTool({
      name: 'message.reply',
      arguments: { message_id: 'msg1', text: 'reply' },
    });
    expect(mockAgentClient.reply).toHaveBeenCalledWith('msg1', 'reply');
  });

  it('get_thread calls thread()', async () => {
    mockAgentClient.thread.mockResolvedValue({ parent: {}, replies: [] });
    await client.callTool({ name: 'message.get_thread', arguments: { message_id: 'msg1' } });
    expect(mockAgentClient.thread).toHaveBeenCalledWith('msg1', undefined);
  });

  it('send_dm calls dm()', async () => {
    mockAgentClient.dm.mockResolvedValue({});
    await client.callTool({ name: 'message.dm.send', arguments: { to: 'bot2', text: 'hi' } });
    expect(mockAgentClient.dm).toHaveBeenCalledWith('bot2', 'hi');
  });

  it('get_dms calls dms.conversations()', async () => {
    mockAgentClient.dms.conversations.mockResolvedValue([]);
    await client.callTool({ name: 'message.dm.list', arguments: {} });
    expect(mockAgentClient.dms.conversations).toHaveBeenCalled();
  });

  it('send_group_dm calls dms.createGroup()', async () => {
    mockAgentClient.dms.createGroup.mockResolvedValue({ id: 'conv1' });
    mockAgentClient.dms.sendMessage.mockResolvedValue({ id: 'msg1' });
    await client.callTool({
      name: 'message.dm.send_group',
      arguments: { participants: ['a', 'b'], name: 'grp', text: 'hello group' },
    });
    expect(mockAgentClient.dms.createGroup).toHaveBeenCalledWith({
      participants: ['a', 'b'],
      name: 'grp',
    });
    expect(mockAgentClient.dms.sendMessage).toHaveBeenCalledWith('conv1', 'hello group');
  });
});

describe('messaging tools with workspace routing', () => {
  let mcpServer: McpServer;
  let client: Client;
  const defaultClient = {
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
  const routedClient = {
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

  const getAgentClient = vi.fn((wsRouting?: { workspace_id?: string; workspace_alias?: string }) => {
    if (wsRouting?.workspace_id === 'ws_beta' || wsRouting?.workspace_alias === 'beta') {
      return routedClient as any;
    }
    return defaultClient as any;
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    mcpServer = new McpServer({ name: 'test', version: '0.1.0' });
    registerMessagingTools(mcpServer, getAgentClient);
    client = new Client({ name: 'test-client', version: '0.1.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), mcpServer.connect(st)]);
  });

  it('message.post without routing uses default client', async () => {
    defaultClient.send.mockResolvedValue({ id: 'msg1', text: 'hello' });
    await client.callTool({
      name: 'message.post',
      arguments: { channel: 'general', text: 'hello' },
    });
    expect(getAgentClient).toHaveBeenCalledWith(undefined);
    expect(defaultClient.send).toHaveBeenCalledWith('general', 'hello', undefined);
  });

  it('message.post with workspace_id routes to correct client', async () => {
    routedClient.send.mockResolvedValue({ id: 'msg2', text: 'hello beta' });
    await client.callTool({
      name: 'message.post',
      arguments: { channel: 'general', text: 'hello beta', workspace_id: 'ws_beta' },
    });
    expect(getAgentClient).toHaveBeenCalledWith({ workspace_id: 'ws_beta', workspace_alias: undefined });
    expect(routedClient.send).toHaveBeenCalledWith('general', 'hello beta', undefined);
  });

  it('message.post with workspace_alias routes to correct client', async () => {
    routedClient.send.mockResolvedValue({ id: 'msg3', text: 'hello beta alias' });
    await client.callTool({
      name: 'message.post',
      arguments: { channel: 'general', text: 'hello beta alias', workspace_alias: 'beta' },
    });
    expect(getAgentClient).toHaveBeenCalledWith({ workspace_id: undefined, workspace_alias: 'beta' });
    expect(routedClient.send).toHaveBeenCalledWith('general', 'hello beta alias', undefined);
  });

  it('message.dm.send with workspace_id routes correctly', async () => {
    routedClient.dm.mockResolvedValue({});
    await client.callTool({
      name: 'message.dm.send',
      arguments: { to: 'bot2', text: 'hi', workspace_id: 'ws_beta' },
    });
    expect(getAgentClient).toHaveBeenCalledWith({ workspace_id: 'ws_beta', workspace_alias: undefined });
    expect(routedClient.dm).toHaveBeenCalledWith('bot2', 'hi');
  });

  it('message.list with workspace_alias routes correctly', async () => {
    routedClient.messages.mockResolvedValue([]);
    await client.callTool({
      name: 'message.list',
      arguments: { channel: 'general', workspace_alias: 'beta' },
    });
    expect(getAgentClient).toHaveBeenCalledWith({ workspace_id: undefined, workspace_alias: 'beta' });
    expect(routedClient.messages).toHaveBeenCalled();
  });
});
