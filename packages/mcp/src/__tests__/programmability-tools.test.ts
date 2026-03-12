import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerProgrammabilityTools } from '../tools/programmability.js';

describe('programmability tools', () => {
  let mcpServer: McpServer;
  let client: Client;

  const mockRelay = {
    webhooks: {
      create: vi.fn(),
      list: vi.fn(),
      delete: vi.fn(),
      trigger: vi.fn(),
    },
    subscriptions: {
      create: vi.fn(),
      list: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
    },
    commands: {
      register: vi.fn(),
      list: vi.fn(),
      delete: vi.fn(),
    },
  };

  const mockAgentClient = {
    client: {
      post: vi.fn(),
    },
    commands: {
      invoke: vi.fn(),
    },
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    mcpServer = new McpServer({ name: 'test', version: '0.1.0' });
    registerProgrammabilityTools(
      mcpServer,
      () => mockRelay as any,
      () => mockAgentClient as any,
    );
    client = new Client({ name: 'test-client', version: '0.1.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), mcpServer.connect(st)]);
  });

  // === Webhooks ===

  it('create_webhook calls relay.webhooks.create()', async () => {
    mockRelay.webhooks.create.mockResolvedValue({
      webhook_id: 'wh_1',
      name: 'GitHub',
      channel: 'dev',
      url: 'https://relay.dev/hooks/wh_1',
    });
    const result = await client.callTool({
      name: 'webhook.create',
      arguments: { name: 'GitHub', channel: 'dev' },
    });
    expect(mockRelay.webhooks.create).toHaveBeenCalledWith({
      name: 'GitHub',
      channel: 'dev',
    });
    expect(result.content).toEqual([
      { type: 'text', text: expect.stringContaining('wh_1') },
    ]);
  });

  it('list_webhooks calls relay.webhooks.list()', async () => {
    mockRelay.webhooks.list.mockResolvedValue([]);
    await client.callTool({ name: 'webhook.list', arguments: {} });
    expect(mockRelay.webhooks.list).toHaveBeenCalled();
  });

  it('delete_webhook calls relay.webhooks.delete()', async () => {
    mockRelay.webhooks.delete.mockResolvedValue(undefined);
    const result = await client.callTool({
      name: 'webhook.delete',
      arguments: { webhook_id: 'wh_1' },
    });
    expect(mockRelay.webhooks.delete).toHaveBeenCalledWith('wh_1');
    expect(result.content).toEqual([
      { type: 'text', text: 'Deleted webhook wh_1' },
    ]);
  });

  it('trigger_webhook calls relay.webhooks.trigger()', async () => {
    mockRelay.webhooks.trigger.mockResolvedValue({
      message_id: 'm_1',
      channel: 'dev',
      text: 'Alert',
    });
    await client.callTool({
      name: 'webhook.trigger',
      arguments: { webhook_id: 'wh_1', text: 'Alert', source: 'github' },
    });
    expect(mockRelay.webhooks.trigger).toHaveBeenCalledWith('wh_1', {
      text: 'Alert',
      source: 'github',
    });
  });

  // === Subscriptions ===

  it('create_subscription calls relay.subscriptions.create()', async () => {
    mockRelay.subscriptions.create.mockResolvedValue({
      id: 'sub_1',
      events: ['message.created'],
      url: 'https://example.com/hook',
    });
    await client.callTool({
      name: 'subscription.create',
      arguments: {
        events: ['message.created'],
        url: 'https://example.com/hook',
        filter_channel: 'general',
      },
    });
    expect(mockRelay.subscriptions.create).toHaveBeenCalledWith({
      events: ['message.created'],
      url: 'https://example.com/hook',
      filter: { channel: 'general', mentions: undefined },
      secret: undefined,
    });
  });

  it('create_subscription without filter passes undefined', async () => {
    mockRelay.subscriptions.create.mockResolvedValue({ id: 'sub_2' });
    await client.callTool({
      name: 'subscription.create',
      arguments: {
        events: ['reaction.added'],
        url: 'https://example.com/hook2',
      },
    });
    expect(mockRelay.subscriptions.create).toHaveBeenCalledWith({
      events: ['reaction.added'],
      url: 'https://example.com/hook2',
      filter: undefined,
      secret: undefined,
    });
  });

  it('list_subscriptions calls relay.subscriptions.list()', async () => {
    mockRelay.subscriptions.list.mockResolvedValue([]);
    await client.callTool({ name: 'subscription.list', arguments: {} });
    expect(mockRelay.subscriptions.list).toHaveBeenCalled();
  });

  it('get_subscription calls relay.subscriptions.get()', async () => {
    mockRelay.subscriptions.get.mockResolvedValue({ id: 'sub_1' });
    await client.callTool({
      name: 'subscription.get',
      arguments: { subscription_id: 'sub_1' },
    });
    expect(mockRelay.subscriptions.get).toHaveBeenCalledWith('sub_1');
  });

  it('delete_subscription calls relay.subscriptions.delete()', async () => {
    mockRelay.subscriptions.delete.mockResolvedValue(undefined);
    const result = await client.callTool({
      name: 'subscription.delete',
      arguments: { subscription_id: 'sub_1' },
    });
    expect(mockRelay.subscriptions.delete).toHaveBeenCalledWith('sub_1');
    expect(result.content).toEqual([
      { type: 'text', text: 'Deleted subscription sub_1' },
    ]);
  });

  // === Commands ===

  it('register_command calls relay.commands.register()', async () => {
    mockRelay.commands.register.mockResolvedValue({
      id: 'cmd_1',
      command: 'deploy',
    });
    await client.callTool({
      name: 'command.register',
      arguments: {
        command: 'deploy',
        description: 'Deploy the app',
        handler_agent: 'DeployBot',
      },
    });
    expect(mockRelay.commands.register).toHaveBeenCalledWith({
      command: 'deploy',
      description: 'Deploy the app',
      handlerAgent: 'DeployBot',
      parameters: undefined,
    });
  });

  it('list_commands calls relay.commands.list()', async () => {
    mockRelay.commands.list.mockResolvedValue([]);
    await client.callTool({ name: 'command.list', arguments: {} });
    expect(mockRelay.commands.list).toHaveBeenCalled();
  });

  it('delete_command calls relay.commands.delete()', async () => {
    mockRelay.commands.delete.mockResolvedValue(undefined);
    const result = await client.callTool({
      name: 'command.delete',
      arguments: { command: 'deploy' },
    });
    expect(mockRelay.commands.delete).toHaveBeenCalledWith('deploy');
    expect(result.content).toEqual([
      { type: 'text', text: 'Deleted command /deploy' },
    ]);
  });

  it('invoke_command calls agentClient.commands.invoke()', async () => {
    mockAgentClient.commands.invoke.mockResolvedValue({
      id: 'inv_1',
      command: 'deploy',
      channel: 'ops',
    });
    await client.callTool({
      name: 'command.invoke',
      arguments: {
        command: 'deploy',
        channel: 'ops',
        args: '--force',
      },
    });
    expect(mockAgentClient.commands.invoke).toHaveBeenCalledWith('deploy', {
      channel: 'ops',
      args: '--force',
      parameters: undefined,
    });
  });

  it('invoke_command parses JSON parameters string', async () => {
    mockAgentClient.commands.invoke.mockResolvedValue({
      id: 'inv_2',
      command: 'scale',
      channel: 'ops',
    });
    await client.callTool({
      name: 'command.invoke',
      arguments: {
        command: 'scale',
        channel: 'ops',
        parameters: '{"replicas": 3}',
      },
    });
    expect(mockAgentClient.commands.invoke).toHaveBeenCalledWith('scale', {
      channel: 'ops',
      args: undefined,
      parameters: { replicas: 3 },
    });
  });
});
