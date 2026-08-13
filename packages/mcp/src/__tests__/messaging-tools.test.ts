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
      arguments: { channel: 'general', text: 'hello', as: 'WriterBot' },
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
      arguments: { message_id: 'msg1', text: 'reply', as: 'WriterBot' },
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
    await client.callTool({ name: 'message.dm.send', arguments: { to: 'bot2', text: 'hi', as: 'WriterBot' } });
    expect(mockAgentClient.dm).toHaveBeenCalledWith('bot2', 'hi');
  });

  it('get_dms calls dms.conversations()', async () => {
    mockAgentClient.dms.conversations.mockResolvedValue([]);
    await client.callTool({ name: 'message.dm.list', arguments: { as: 'WriterBot' } });
    expect(mockAgentClient.dms.conversations).toHaveBeenCalled();
  });

  it('get_dms forwards the requested conversation limit', async () => {
    mockAgentClient.dms.conversations.mockResolvedValue([]);
    await client.callTool({ name: 'message.dm.list', arguments: { limit: 25 } });
    expect(mockAgentClient.dms.conversations).toHaveBeenCalledWith({ limit: 25 });
  });

  it('get_dms rejects conversation limits above the server maximum', async () => {
    mockAgentClient.dms.conversations.mockResolvedValue([]);
    const result = await client.callTool({
      name: 'message.dm.list',
      arguments: { limit: 101 },
    });
    expect(result.isError).toBe(true);
    expect(mockAgentClient.dms.conversations).not.toHaveBeenCalled();
  });

  it('send_group_dm calls dms.createGroup()', async () => {
    mockAgentClient.dms.createGroup.mockResolvedValue({ id: 'conv1' });
    mockAgentClient.dms.sendMessage.mockResolvedValue({ id: 'msg1' });
    await client.callTool({
      name: 'message.dm.send_group',
      arguments: { participants: ['a', 'b'], name: 'grp', text: 'hello group', as: 'WriterBot' },
    });
    expect(mockAgentClient.dms.createGroup).toHaveBeenCalledWith({
      participants: ['a', 'b'],
      name: 'grp',
    });
    expect(mockAgentClient.dms.sendMessage).toHaveBeenCalledWith('conv1', 'hello group');
  });
});

describe('messaging tools with workspace routing and identity overrides', () => {
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
  const identityClient = {
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

  const getAgentClient = vi.fn((wsRouting?: { workspace_id?: string; workspace_alias?: string }, as?: string) => {
    if (as === 'WriterBot') {
      return identityClient as any;
    }
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
    expect(getAgentClient).toHaveBeenCalledWith(undefined, undefined);
    expect(defaultClient.send).toHaveBeenCalledWith('general', 'hello', undefined);
  });

  it('message.post with workspace_alias and as routes to identity-scoped client', async () => {
    identityClient.send.mockResolvedValue({ id: 'msg2', text: 'hello beta' });
    await client.callTool({
      name: 'message.post',
      arguments: {
        channel: 'general',
        text: 'hello beta',
        workspace_alias: 'beta',
        as: 'WriterBot',
      },
    });
    expect(getAgentClient).toHaveBeenCalledWith({ workspace_id: undefined, workspace_alias: 'beta' }, 'WriterBot');
    expect(identityClient.send).toHaveBeenCalledWith('general', 'hello beta', undefined);
  });

  it('message.reply with workspace_id and as routes to identity-scoped client', async () => {
    identityClient.reply.mockResolvedValue({ id: 'reply1' });
    await client.callTool({
      name: 'message.reply',
      arguments: { message_id: 'msg1', text: 'reply', workspace_id: 'ws_beta', as: 'WriterBot' },
    });
    expect(getAgentClient).toHaveBeenCalledWith({ workspace_id: 'ws_beta', workspace_alias: undefined }, 'WriterBot');
    expect(identityClient.reply).toHaveBeenCalledWith('msg1', 'reply');
  });

  it('message.dm.send with workspace_id and as routes to identity-scoped client', async () => {
    identityClient.dm.mockResolvedValue({});
    await client.callTool({
      name: 'message.dm.send',
      arguments: { to: 'bot2', text: 'hi', workspace_id: 'ws_beta', as: 'WriterBot' },
    });
    expect(getAgentClient).toHaveBeenCalledWith({ workspace_id: 'ws_beta', workspace_alias: undefined }, 'WriterBot');
    expect(identityClient.dm).toHaveBeenCalledWith('bot2', 'hi');
  });

  it('message.dm.list with as routes to identity-scoped client', async () => {
    identityClient.dms.conversations.mockResolvedValue([]);
    await client.callTool({
      name: 'message.dm.list',
      arguments: { as: 'WriterBot' },
    });
    expect(getAgentClient).toHaveBeenCalledWith(undefined, 'WriterBot');
    expect(identityClient.dms.conversations).toHaveBeenCalled();
  });

  it('message.dm.send_group with workspace_alias and as routes to identity-scoped client', async () => {
    identityClient.dms.createGroup.mockResolvedValue({ id: 'conv1' });
    identityClient.dms.sendMessage.mockResolvedValue({ id: 'msg1' });
    await client.callTool({
      name: 'message.dm.send_group',
      arguments: {
        participants: ['a', 'b'],
        name: 'grp',
        text: 'hello group',
        workspace_alias: 'beta',
        as: 'WriterBot',
      },
    });
    expect(getAgentClient).toHaveBeenCalledWith({ workspace_id: undefined, workspace_alias: 'beta' }, 'WriterBot');
    expect(identityClient.dms.createGroup).toHaveBeenCalledWith({ participants: ['a', 'b'], name: 'grp' });
    expect(identityClient.dms.sendMessage).toHaveBeenCalledWith('conv1', 'hello group');
  });
});
