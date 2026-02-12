import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Relay, AgentClient } from '@relaycast/sdk';

export function registerProgrammabilityTools(
  server: McpServer,
  getRelay: () => Relay,
  getAgentClient: () => AgentClient,
): void {
  // === Inbound Webhooks ===

  server.registerTool('create_webhook', {
    title: 'Create Webhook',
    description: 'Create an inbound webhook that external services can POST to, delivering messages into a channel.',
    inputSchema: {
      name: z.string().describe('Webhook name (e.g. "GitHub Alerts")'),
      channel: z.string().describe('Target channel name'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ name, channel }) => {
    const client = getAgentClient();
    const result = await client.client.post('/v1/webhooks', { name, channel });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  });

  server.registerTool('list_webhooks', {
    title: 'List Webhooks',
    description: 'List all inbound webhooks in the workspace.',
    inputSchema: {
      channel: z.string().optional().describe('Filter webhooks by target channel name'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async () => {
    const relay = getRelay();
    const webhooks = await relay.webhooks.list();
    return { content: [{ type: 'text' as const, text: JSON.stringify(webhooks, null, 2) }] };
  });

  server.registerTool('delete_webhook', {
    title: 'Delete Webhook',
    description: 'Delete an inbound webhook by ID.',
    inputSchema: {
      webhook_id: z.string().describe('Webhook ID to delete'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async ({ webhook_id }) => {
    const relay = getRelay();
    await relay.webhooks.delete(webhook_id);
    return { content: [{ type: 'text' as const, text: `Deleted webhook ${webhook_id}` }] };
  });

  server.registerTool('trigger_webhook', {
    title: 'Trigger Webhook',
    description: 'Trigger an inbound webhook to post a message into its channel.',
    inputSchema: {
      webhook_id: z.string().describe('Webhook ID to trigger'),
      text: z.string().optional().describe('Message text'),
      source: z.string().optional().describe('Source identifier (e.g. "github")'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ webhook_id, text, source }) => {
    const relay = getRelay();
    const result = await relay.webhooks.trigger(webhook_id, { text, source });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  });

  // === Event Subscriptions ===

  server.registerTool('create_subscription', {
    title: 'Create Event Subscription',
    description: 'Create an outbound event subscription. The server will POST to the given URL when matching events occur.',
    inputSchema: {
      events: z.array(z.string()).describe('Event types to subscribe to (e.g. ["message.created", "reaction.added"])'),
      url: z.string().describe('URL to POST events to'),
      filter_channel: z.string().optional().describe('Only fire for this channel'),
      filter_mentions: z.string().optional().describe('Only fire when this agent is mentioned'),
      secret: z.string().optional().describe('Secret for HMAC signature verification'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ events, url, filter_channel, filter_mentions, secret }) => {
    const relay = getRelay();
    const filter = (filter_channel || filter_mentions)
      ? { channel: filter_channel, mentions: filter_mentions }
      : undefined;
    const result = await relay.subscriptions.create({
      events: events as any,
      url,
      filter,
      secret,
    });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  });

  server.registerTool('list_subscriptions', {
    title: 'List Subscriptions',
    description: 'List all outbound event subscriptions in the workspace.',
    inputSchema: {
      event: z.string().optional().describe('Filter subscriptions by event type (e.g. "message.created")'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async () => {
    const relay = getRelay();
    const subs = await relay.subscriptions.list();
    return { content: [{ type: 'text' as const, text: JSON.stringify(subs, null, 2) }] };
  });

  server.registerTool('get_subscription', {
    title: 'Get Subscription',
    description: 'Get details of a specific event subscription.',
    inputSchema: {
      subscription_id: z.string().describe('Subscription ID'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async ({ subscription_id }) => {
    const relay = getRelay();
    const sub = await relay.subscriptions.get(subscription_id);
    return { content: [{ type: 'text' as const, text: JSON.stringify(sub, null, 2) }] };
  });

  server.registerTool('delete_subscription', {
    title: 'Delete Subscription',
    description: 'Delete an event subscription by ID.',
    inputSchema: {
      subscription_id: z.string().describe('Subscription ID to delete'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async ({ subscription_id }) => {
    const relay = getRelay();
    await relay.subscriptions.delete(subscription_id);
    return { content: [{ type: 'text' as const, text: `Deleted subscription ${subscription_id}` }] };
  });

  // === Agent Commands ===

  server.registerTool('register_command', {
    title: 'Register Command',
    description: 'Register a slash command that an agent can handle. Other agents can invoke it.',
    inputSchema: {
      command: z.string().describe('Command name (e.g. "deploy")'),
      description: z.string().describe('What the command does'),
      handler_agent: z.string().describe('Name of the agent that handles this command'),
      parameters: z.array(z.object({
        name: z.string().describe('Parameter name'),
        description: z.string().optional().describe('Parameter description'),
        type: z.enum(['string', 'number', 'boolean']).describe('Parameter type'),
        required: z.boolean().optional().describe('Whether the parameter is required'),
      })).optional().describe('Command parameters'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ command, description, handler_agent, parameters }) => {
    const relay = getRelay();
    const result = await relay.commands.register({
      command,
      description,
      handler_agent,
      parameters,
    });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  });

  server.registerTool('list_commands', {
    title: 'List Commands',
    description: 'List all registered agent commands in the workspace.',
    inputSchema: {
      handler_agent: z.string().optional().describe('Filter commands by handler agent name'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async () => {
    const relay = getRelay();
    const commands = await relay.commands.list();
    return { content: [{ type: 'text' as const, text: JSON.stringify(commands, null, 2) }] };
  });

  server.registerTool('delete_command', {
    title: 'Delete Command',
    description: 'Delete a registered command.',
    inputSchema: {
      command: z.string().describe('Command name to delete'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async ({ command }) => {
    const relay = getRelay();
    await relay.commands.delete(command);
    return { content: [{ type: 'text' as const, text: `Deleted command /${command}` }] };
  });

  server.registerTool('invoke_command', {
    title: 'Invoke Command',
    description: 'Invoke a registered slash command as the current agent.',
    inputSchema: {
      command: z.string().describe('Command name to invoke'),
      channel: z.string().describe('Channel context for invocation'),
      args: z.string().optional().describe('Raw argument string'),
      parameters: z.string().optional().describe('JSON-encoded structured parameters object'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ command, channel, args, parameters }) => {
    const client = getAgentClient();
    const parsedParams = parameters ? JSON.parse(parameters) : undefined;
    const result = await client.commands.invoke(command, { channel, args, parameters: parsedParams });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  });
}
