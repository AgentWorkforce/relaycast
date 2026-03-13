import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createInternalWsClient } from '@relaycast/sdk/internal';

// Mock the SDK so we don't need a real server
vi.mock('@relaycast/sdk', () => {
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
    commands: { invoke: vi.fn().mockResolvedValue({ id: 'inv1' }) },
  };

  class MockRelay {
    agents = {
      register: vi.fn().mockResolvedValue({
        agent: { name: 'bot1' },
        token: 'tok_abc',
      }),
      registerOrRotate: vi.fn().mockResolvedValue({
        agent: { name: 'bot1' },
        token: 'tok_abc',
      }),
      list: vi.fn().mockResolvedValue([]),
    };
    webhooks = {
      create: vi.fn().mockResolvedValue({ webhook_id: 'wh_1' }),
      list: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(undefined),
      trigger: vi.fn().mockResolvedValue({ message_id: 'm_1' }),
    };
    subscriptions = {
      create: vi.fn().mockResolvedValue({ id: 'sub_1' }),
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue({ id: 'sub_1' }),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    commands = {
      register: vi.fn().mockResolvedValue({ id: 'cmd_1' }),
      list: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    as(_token: string) {
      return mockAgentClient;
    }
    constructor(_opts: any) {}
  }

  return {
    AgentClient: class {},
    HttpClient: class {},
    Relay: MockRelay,
  };
});

vi.mock('@relaycast/sdk/internal', () => {
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
    commands: { invoke: vi.fn().mockResolvedValue({ id: 'inv1' }) },
  };

  class MockRelay {
    agents = {
      register: vi.fn().mockResolvedValue({
        agent: { name: 'bot1' },
        token: 'tok_abc',
      }),
      registerOrRotate: vi.fn().mockResolvedValue({
        agent: { name: 'bot1' },
        token: 'tok_abc',
      }),
      list: vi.fn().mockResolvedValue([]),
    };
    webhooks = {
      create: vi.fn().mockResolvedValue({ webhook_id: 'wh_1' }),
      list: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(undefined),
      trigger: vi.fn().mockResolvedValue({ message_id: 'm_1' }),
    };
    subscriptions = {
      create: vi.fn().mockResolvedValue({ id: 'sub_1' }),
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue({ id: 'sub_1' }),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    commands = {
      register: vi.fn().mockResolvedValue({ id: 'cmd_1' }),
      list: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    as(_token: string) {
      return mockAgentClient;
    }
    constructor(_opts: any) {}
  }

  return {
    createInternalRelayCast: vi.fn().mockImplementation(() => new MockRelay({})),
    createInternalWsClient: vi.fn().mockImplementation(() => ({
      on: vi.fn().mockReturnValue(() => {}),
      connect: vi.fn(),
      disconnect: vi.fn(),
    })),
  };
});

// Import after mock is set up
import { createRelayMcpServer } from '../server.js';

describe('createRelayMcpServer', () => {
  let client: Client;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mcpServer = createRelayMcpServer({ apiKey: 'test-key' });
    client = new Client({ name: 'test-client', version: '0.1.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), mcpServer.connect(st)]);
  });

  it('lists all 42 tools', async () => {
    const tools = await client.listTools();
    expect(tools.tools.length).toBe(42);
    const toolNames = tools.tools.map((t) => t.name).sort();
    expect(toolNames).toEqual([
      'agent.add',
      'agent.list',
      'agent.register',
      'agent.remove',
      'channel.archive',
      'channel.create',
      'channel.invite',
      'channel.join',
      'channel.leave',
      'channel.list',
      'channel.set_topic',
      'command.delete',
      'command.invoke',
      'command.list',
      'command.register',
      'message.dm.list',
      'message.dm.send',
      'message.dm.send_group',
      'message.file.upload',
      'message.get_thread',
      'message.inbox.check',
      'message.inbox.get_readers',
      'message.inbox.mark_read',
      'message.list',
      'message.post',
      'message.reaction.add',
      'message.reaction.remove',
      'message.reply',
      'message.search',
      'subscription.create',
      'subscription.delete',
      'subscription.get',
      'subscription.list',
      'webhook.create',
      'webhook.delete',
      'webhook.list',
      'webhook.trigger',
      'workspace.create',
      'workspace.join',
      'workspace.list',
      'workspace.set_key',
      'workspace.switch',
    ]);
  });

  it('supports legacy flat tool calls without advertising legacy names', async () => {
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);
    expect(toolNames).not.toContain('register');
    expect(toolNames).not.toContain('post_message');

    const registerResult = await client.callTool({
      name: 'register',
      arguments: { name: 'bot1' },
    });
    expect(registerResult.isError).toBeFalsy();

    const messageResult = await client.callTool({
      name: 'post_message',
      arguments: { channel: 'general', text: 'hello from legacy alias' },
    });
    expect(messageResult.isError).toBeFalsy();
  });

  it('register tool works and enables other tools', async () => {
    const result = await client.callTool({
      name: 'agent.register',
      arguments: { name: 'bot1' },
    });
    expect(result.content).toBeDefined();

    // Now post_message should work (uses agent token from register)
    const msgResult = await client.callTool({
      name: 'message.post',
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
      name: 'message.post',
      arguments: { channel: 'general', text: 'hello' },
    });
    expect(result.isError).toBe(true);
  });

  it('auto-bootstraps when agentToken and agentName are provided', async () => {
    const bootstrappedServer = createRelayMcpServer({
      apiKey: 'test-key',
      agentToken: 'tok_preregistered',
      agentName: 'pre-registered-bot',
    });
    const bootstrappedClient = new Client({ name: 'bootstrap-client', version: '0.1.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([bootstrappedClient.connect(ct), bootstrappedServer.connect(st)]);

    // Should be able to call tools immediately without calling register first
    const result = await bootstrappedClient.callTool({
      name: 'message.post',
      arguments: { channel: 'general', text: 'hello from pre-registered agent' },
    });
    expect(result.isError).toBeFalsy();
  });

  it('enforces strict configured agent identity during register', async () => {
    const strictServer = createRelayMcpServer({
      apiKey: 'test-key',
      agentName: 'Lead',
      agentType: 'agent',
      strictAgentName: true,
    });
    const strictClient = new Client({ name: 'strict-client', version: '0.1.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([strictClient.connect(ct), strictServer.connect(st)]);

    const result = await strictClient.callTool({
      name: 'agent.register',
      arguments: { name: 'Claude', type: 'human' },
    });

    expect(result.isError).toBeFalsy();
    const firstContent = result.content?.[0] as { text?: string } | undefined;
    const text = typeof firstContent?.text === 'string' ? firstContent.text : '{}';
    const payload = JSON.parse(text) as {
      registered_name?: string;
      warnings?: string[];
    };
    expect(payload.registered_name).toBe('Lead');
    expect(payload.warnings?.some((warning) => warning.includes('ignoring requested name'))).toBe(
      true,
    );
    expect(payload.warnings?.some((warning) => warning.includes('ignoring requested type'))).toBe(
      true,
    );
  });

  it('supports keyless startup and bootstrap via set_workspace_key', async () => {
    const keylessServer = createRelayMcpServer({});
    const keylessClient = new Client({ name: 'keyless-client', version: '0.1.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([keylessClient.connect(ct), keylessServer.connect(st)]);

    const result = await keylessClient.callTool({
      name: 'workspace.set_key',
      arguments: { api_key: 'rk_live_bootstrap123' },
    });

    expect(result.isError).toBeFalsy();
  });

  it('retries WS bridge initialization after switching away from a token that failed WS init', async () => {
    const wsFactory = vi.mocked(createInternalWsClient);
    wsFactory.mockImplementationOnce(() => {
      throw new Error('ws unsupported');
    });

    const bootstrappedServer = createRelayMcpServer({
      apiKey: 'rk_live_bootstrap123',
      agentToken: 'tok_old',
      agentName: 'pre-registered-bot',
    });
    const bootstrappedClient = new Client({ name: 'ws-retry-client', version: '0.1.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([bootstrappedClient.connect(ct), bootstrappedServer.connect(st)]);

    expect(wsFactory).toHaveBeenCalledTimes(1);

    const setKeyResult = await bootstrappedClient.callTool({
      name: 'workspace.set_key',
      arguments: { api_key: 'rk_live_retry456' },
    });
    expect(setKeyResult.isError).toBeFalsy();

    const registerResult = await bootstrappedClient.callTool({
      name: 'agent.register',
      arguments: { name: 'retry-bot' },
    });
    expect(registerResult.isError).toBeFalsy();
    expect(wsFactory).toHaveBeenCalledTimes(2);
  });
});
