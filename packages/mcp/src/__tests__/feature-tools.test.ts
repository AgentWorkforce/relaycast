import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerFeatureTools } from '../tools/features.js';

describe('feature tools', () => {
  let mcpServer: McpServer;
  let client: Client;
  const mockAgentClient = {
    react: vi.fn(),
    unreact: vi.fn(),
    search: vi.fn(),
    inbox: vi.fn(),
    markRead: vi.fn(),
    readers: vi.fn(),
    files: { upload: vi.fn() },
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    mcpServer = new McpServer({ name: 'test', version: '0.1.0' });
    registerFeatureTools(mcpServer, () => mockAgentClient as any);
    client = new Client({ name: 'test-client', version: '0.1.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), mcpServer.connect(st)]);
  });

  it('add_reaction calls react()', async () => {
    mockAgentClient.react.mockResolvedValue(undefined);
    const result = await client.callTool({
      name: 'message.reaction.add',
      arguments: { message_id: 'msg1', emoji: '👍' },
    });
    expect(mockAgentClient.react).toHaveBeenCalledWith('msg1', '👍');
    expect(result.content).toEqual([{ type: 'text', text: 'Reacted with 👍' }]);
  });

  it('remove_reaction calls unreact()', async () => {
    mockAgentClient.unreact.mockResolvedValue(undefined);
    await client.callTool({
      name: 'message.reaction.remove',
      arguments: { message_id: 'msg1', emoji: '👍' },
    });
    expect(mockAgentClient.unreact).toHaveBeenCalledWith('msg1', '👍');
  });

  it('search_messages calls search()', async () => {
    mockAgentClient.search.mockResolvedValue([]);
    await client.callTool({
      name: 'message.search',
      arguments: { query: 'hello' },
    });
    expect(mockAgentClient.search).toHaveBeenCalledWith('hello', {
      channel: undefined,
      from: undefined,
      limit: undefined,
    });
  });

  it('check_inbox calls inbox()', async () => {
    mockAgentClient.inbox.mockResolvedValue({ unread: 0 });
    await client.callTool({ name: 'message.inbox.check', arguments: {} });
    expect(mockAgentClient.inbox).toHaveBeenCalled();
  });

  it('mark_read calls markRead()', async () => {
    mockAgentClient.markRead.mockResolvedValue(undefined);
    const result = await client.callTool({
      name: 'message.inbox.mark_read',
      arguments: { message_id: 'msg1' },
    });
    expect(mockAgentClient.markRead).toHaveBeenCalledWith('msg1');
    expect(result.content).toEqual([
      { type: 'text', text: 'Marked message msg1 as read' },
    ]);
  });

  it('get_readers calls readers()', async () => {
    mockAgentClient.readers.mockResolvedValue([
      { agent: 'bot1', read_at: '2025-01-01' },
    ]);
    await client.callTool({
      name: 'message.inbox.get_readers',
      arguments: { message_id: 'msg1' },
    });
    expect(mockAgentClient.readers).toHaveBeenCalledWith('msg1');
  });

  it('upload_file calls files.upload()', async () => {
    mockAgentClient.files.upload.mockResolvedValue({
      id: 'f1',
      upload_url: 'https://...',
    });
    await client.callTool({
      name: 'file.upload',
      arguments: {
        filename: 'test.txt',
        content_type: 'text/plain',
        size_bytes: 100,
      },
    });
    expect(mockAgentClient.files.upload).toHaveBeenCalledWith({
      filename: 'test.txt',
      contentType: 'text/plain',
      sizeBytes: 100,
    });
  });
});
