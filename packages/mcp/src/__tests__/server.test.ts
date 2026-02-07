import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// Mock the SDK so we don't need a real server
vi.mock('@agent-relay/sdk', () => {
  const mockAgentClient = {
    send: vi.fn().mockResolvedValue({ id: 'msg1' }),
    messages: vi.fn().mockResolvedValue([]),
    reply: vi.fn().mockResolvedValue({ id: 'reply1' }),
    thread: vi.fn().mockResolvedValue({ parent: {}, replies: [] }),
    dm: vi.fn().mockResolvedValue({}),
    dms: {
      conversations: vi.fn().mockResolvedValue([]),
      createGroup: vi.fn().mockResolvedValue({}),
    },
    channels: {
      create: vi.fn().mockResolvedValue({ name: 'test' }),
      list: vi.fn().mockResolvedValue([]),
      join: vi.fn().mockResolvedValue(undefined),
      leave: vi.fn().mockResolvedValue(undefined),
      invite: vi.fn().mockResolvedValue(undefined),
      setTopic: vi.fn().mockResolvedValue({ name: 'test', topic: 'new' }),
      archive: vi.fn().mockResolvedValue(undefined),
    },
    react: vi.fn().mockResolvedValue(undefined),
    unreact: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
    inbox: vi.fn().mockResolvedValue({ unread: 0 }),
    markRead: vi.fn().mockResolvedValue(undefined),
    readers: vi.fn().mockResolvedValue([]),
    files: { upload: vi.fn().mockResolvedValue({ id: 'f1' }) },
  };

  class MockRelay {
    agents = {
      register: vi.fn().mockResolvedValue({
        agent: { name: 'bot1' },
        token: 'tok_abc',
      }),
      list: vi.fn().mockResolvedValue([]),
    };
    as(_token: string) {
      return mockAgentClient;
    }
    constructor(_opts: any) {}
  }

  return {
    Relay: MockRelay,
    AgentClient: class {},
    HttpClient: class {},
  };
});

// Import after mock is set up
import { createRelayMcpServer } from '../server.js';

describe('createRelayMcpServer', () => {
  let client: Client;

  beforeEach(async () => {
    const mcpServer = createRelayMcpServer({ apiKey: 'test-key' });
    client = new Client({ name: 'test-client', version: '0.1.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), mcpServer.connect(st)]);
  });

  it('lists all 23 tools', async () => {
    const tools = await client.listTools();
    expect(tools.tools.length).toBe(23);
    const toolNames = tools.tools.map((t) => t.name).sort();
    expect(toolNames).toEqual([
      'add_reaction',
      'archive_channel',
      'check_inbox',
      'create_channel',
      'get_dms',
      'get_messages',
      'get_readers',
      'get_thread',
      'invite_to_channel',
      'join_channel',
      'leave_channel',
      'list_agents',
      'list_channels',
      'mark_read',
      'post_message',
      'register',
      'remove_reaction',
      'reply_to_thread',
      'search_messages',
      'send_dm',
      'send_group_dm',
      'set_channel_topic',
      'upload_file',
    ]);
  });

  it('register tool works and enables other tools', async () => {
    const result = await client.callTool({
      name: 'register',
      arguments: { name: 'bot1' },
    });
    expect(result.content).toBeDefined();

    // Now post_message should work (uses agent token from register)
    const msgResult = await client.callTool({
      name: 'post_message',
      arguments: { channel: 'general', text: 'hello' },
    });
    expect(msgResult.content).toBeDefined();
  });

  it('system prompt is available', async () => {
    const prompts = await client.listPrompts();
    expect(prompts.prompts.length).toBe(1);
    expect(prompts.prompts[0].name).toBe('system_prompt');

    const prompt = await client.getPrompt({ name: 'system_prompt' });
    expect(prompt.messages.length).toBe(1);
    expect(prompt.messages[0].role).toBe('user');
  });

  it('tool call without register returns error', async () => {
    const result = await client.callTool({
      name: 'post_message',
      arguments: { channel: 'general', text: 'hello' },
    });
    expect(result.isError).toBe(true);
  });
});
