import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerProgrammabilityTools } from '../tools/programmability.js';

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
  actions: {
    register: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
  },
};

const mockAgentClient = {
  actions: {
    invoke: vi.fn(),
    completeInvocation: vi.fn(),
    getInvocation: vi.fn(),
  },
};

describe('programmability tools', () => {
  let mcpServer: McpServer;
  let client: Client;

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
      name: 'integration.webhook.create',
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
    await client.callTool({ name: 'integration.webhook.list', arguments: {} });
    expect(mockRelay.webhooks.list).toHaveBeenCalled();
  });

  it('delete_webhook calls relay.webhooks.delete()', async () => {
    mockRelay.webhooks.delete.mockResolvedValue(undefined);
    const result = await client.callTool({
      name: 'integration.webhook.delete',
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
      name: 'integration.webhook.trigger',
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
      name: 'integration.subscription.create',
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
      headers: undefined,
      secret: undefined,
    });
  });

  it('create_subscription without filter passes undefined', async () => {
    mockRelay.subscriptions.create.mockResolvedValue({ id: 'sub_2' });
    await client.callTool({
      name: 'integration.subscription.create',
      arguments: {
        events: ['message.reacted'],
        url: 'https://example.com/hook2',
      },
    });
    expect(mockRelay.subscriptions.create).toHaveBeenCalledWith({
      events: ['message.reacted'],
      url: 'https://example.com/hook2',
      filter: undefined,
      headers: undefined,
      secret: undefined,
    });
  });

  it('list_subscriptions calls relay.subscriptions.list()', async () => {
    mockRelay.subscriptions.list.mockResolvedValue([]);
    await client.callTool({ name: 'integration.subscription.list', arguments: {} });
    expect(mockRelay.subscriptions.list).toHaveBeenCalled();
  });

  it('get_subscription calls relay.subscriptions.get()', async () => {
    mockRelay.subscriptions.get.mockResolvedValue({ id: 'sub_1' });
    await client.callTool({
      name: 'integration.subscription.get',
      arguments: { subscription_id: 'sub_1' },
    });
    expect(mockRelay.subscriptions.get).toHaveBeenCalledWith('sub_1');
  });

  it('delete_subscription calls relay.subscriptions.delete()', async () => {
    mockRelay.subscriptions.delete.mockResolvedValue(undefined);
    const result = await client.callTool({
      name: 'integration.subscription.delete',
      arguments: { subscription_id: 'sub_1' },
    });
    expect(mockRelay.subscriptions.delete).toHaveBeenCalledWith('sub_1');
    expect(result.content).toEqual([
      { type: 'text', text: 'Deleted subscription sub_1' },
    ]);
  });

  // === Actions ===

  it('register_action calls relay.actions.register()', async () => {
    mockRelay.actions.register.mockResolvedValue({ id: 'act_1', name: 'deploy' });
    await client.callTool({
      name: 'integration.action.register',
      arguments: { name: 'deploy', description: 'Deploy the app', handler_agent: 'DeployBot' },
    });
    expect(mockRelay.actions.register).toHaveBeenCalledWith({
      name: 'deploy',
      description: 'Deploy the app',
      handlerAgent: 'DeployBot',
      inputSchema: undefined,
      outputSchema: undefined,
      availableTo: undefined,
    });
  });

  it('list_actions calls relay.actions.list()', async () => {
    mockRelay.actions.list.mockResolvedValue([]);
    await client.callTool({ name: 'integration.action.list', arguments: {} });
    expect(mockRelay.actions.list).toHaveBeenCalled();
  });

  it('delete_action calls relay.actions.delete()', async () => {
    mockRelay.actions.delete.mockResolvedValue(undefined);
    const result = await client.callTool({
      name: 'integration.action.delete',
      arguments: { name: 'deploy' },
    });
    expect(mockRelay.actions.delete).toHaveBeenCalledWith('deploy');
    expect(result.content).toEqual([
      { type: 'text', text: 'Deleted action deploy' },
    ]);
  });

  it('invoke_action calls agentClient.actions.invoke()', async () => {
    mockAgentClient.actions.invoke.mockResolvedValue({ invocation_id: 'inv_1', action_name: 'deploy', status: 'invoked' });
    await client.callTool({
      name: 'integration.action.invoke',
      arguments: { name: 'deploy', input: { env: 'staging' } },
    });
    expect(mockAgentClient.actions.invoke).toHaveBeenCalledWith('deploy', { env: 'staging' });
  });

  it('complete_action calls agentClient.actions.completeInvocation()', async () => {
    mockAgentClient.actions.completeInvocation.mockResolvedValue({ invocation_id: 'inv_1', status: 'completed' });
    await client.callTool({
      name: 'integration.action.complete',
      arguments: { name: 'deploy', invocation_id: 'inv_1', output: { url: 'https://x' }, duration_ms: 12 },
    });
    expect(mockAgentClient.actions.completeInvocation).toHaveBeenCalledWith('deploy', 'inv_1', {
      output: { url: 'https://x' },
      error: undefined,
      durationMs: 12,
    });
  });
});
