import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { RelayCast, AgentClient } from '@relaycast/sdk';
import { SubscribableEventTypeSchema } from '@relaycast/types';

/** Passthrough object schema for dynamic API responses. */
const jsonResult = z.object({}).passthrough();

export function registerProgrammabilityTools(
  server: McpServer,
  getRelay: () => RelayCast,
  getAgentClient: (wsRouting?: { workspace_id?: string; workspace_alias?: string }) => AgentClient,
): void {
  // === Inbound Webhooks ===

  server.registerTool('integration.webhook.create', {
    title: 'Create Webhook',
    description: 'Create an inbound webhook that external services can POST to, delivering messages into a specified channel. Webhooks enable integrations with CI/CD pipelines, monitoring systems, GitHub, and other external tools. Each webhook gets a unique URL that accepts POST requests with a JSON body.',
    inputSchema: {
      name: z.string().describe('Human-readable webhook name to identify its purpose (e.g. "GitHub Alerts", "CI Pipeline")'),
      channel: z.string().describe('Name of the target channel where webhook messages will be delivered'),
    },
    outputSchema: jsonResult,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ name, channel }) => {
    const relay = getRelay();
    const result = await relay.webhooks.create({ name, channel });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  });

  server.registerTool('integration.webhook.list', {
    title: 'List Webhooks',
    description: 'List all inbound webhooks configured in the workspace. Returns each webhook\'s ID, name, target channel, URL, and creation date. Use this to audit existing integrations or find a webhook\'s URL for external service configuration.',
    inputSchema: {
      channel: z.string().optional().describe('Filter webhooks by target channel name to see only webhooks delivering to a specific channel'),
    },
    outputSchema: {
      webhooks: z.array(z.object({}).passthrough()).describe('Array of webhook objects with id, name, channel, and URL'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async () => {
    const relay = getRelay();
    const webhooks = await relay.webhooks.list();
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(webhooks, null, 2) }],
      structuredContent: { webhooks: webhooks as unknown as Record<string, unknown>[] },
    };
  });

  server.registerTool('integration.webhook.delete', {
    title: 'Delete Webhook',
    description: 'Permanently delete an inbound webhook by its ID. Once deleted, the webhook URL stops accepting requests and any external services still posting to it will receive errors. This action cannot be undone, so verify the webhook is no longer needed before deleting.',
    inputSchema: {
      webhook_id: z.string().describe('Unique identifier of the webhook to delete, obtained from list_webhooks or create_webhook'),
    },
    outputSchema: {
      message: z.string().describe('Confirmation message indicating the webhook was deleted'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async ({ webhook_id }) => {
    const relay = getRelay();
    await relay.webhooks.delete(webhook_id);
    const message = `Deleted webhook ${webhook_id}`;
    return {
      content: [{ type: 'text' as const, text: message }],
      structuredContent: { message },
    };
  });

  server.registerTool('integration.webhook.trigger', {
    title: 'Trigger Webhook',
    description: 'Manually trigger an inbound webhook to post a message into its target channel. This is useful for testing webhook integrations or programmatically injecting external events into the workspace. Provide optional text and source identifier to customize the delivered message.',
    inputSchema: {
      webhook_id: z.string().describe('Unique identifier of the webhook to trigger, obtained from list_webhooks or create_webhook'),
      text: z.string().optional().describe('Message text to deliver through the webhook into the target channel'),
      source: z.string().optional().describe('Source identifier for the webhook payload (e.g. "github", "jenkins", "datadog")'),
    },
    outputSchema: jsonResult,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ webhook_id, text, source }) => {
    const relay = getRelay();
    const result = await relay.webhooks.trigger(webhook_id, { text, source });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  });

  // === Event Subscriptions ===

  server.registerTool('integration.subscription.create', {
    title: 'Create Event Subscription',
    description: 'Create an outbound event subscription that POSTs real-time webhook notifications to an external URL when matching events occur. Supported events include message.created, reaction.added, agent.online, and more. Optionally filter events by channel or agent mentions, and provide a secret for HMAC signature verification of payloads.',
    inputSchema: {
      events: z.array(SubscribableEventTypeSchema).describe('Array of event types to subscribe to (e.g. ["message.created", "reaction.added", "agent.online"])'),
      url: z.string().describe('HTTPS endpoint URL that will receive POST requests with event payloads'),
      filter_channel: z.string().optional().describe('Only fire events that occur in this specific channel'),
      filter_mentions: z.string().optional().describe('Only fire events where this agent name is @mentioned in the message'),
      secret: z.string().optional().describe('Shared secret used to generate HMAC-SHA256 signatures for payload verification'),
    },
    outputSchema: jsonResult,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ events, url, filter_channel, filter_mentions, secret }) => {
    const relay = getRelay();
    const filter = (filter_channel || filter_mentions)
      ? { channel: filter_channel, mentions: filter_mentions }
      : undefined;
    const result = await relay.subscriptions.create({
      events,
      url,
      filter,
      secret,
    });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  });

  server.registerTool('integration.subscription.list', {
    title: 'List Subscriptions',
    description: 'List all outbound event subscriptions configured in the workspace. Returns each subscription\'s ID, target URL, subscribed event types, filters, and status. Use this to audit which external services are receiving event notifications from the workspace.',
    inputSchema: {
      event: z.string().optional().describe('Filter subscriptions by event type (e.g. "message.created") to see only relevant subscriptions'),
    },
    outputSchema: {
      subscriptions: z.array(z.object({}).passthrough()).describe('Array of subscription objects with id, URL, events, and filters'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async () => {
    const relay = getRelay();
    const subs = await relay.subscriptions.list();
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(subs, null, 2) }],
      structuredContent: { subscriptions: subs as unknown as Record<string, unknown>[] },
    };
  });

  server.registerTool('integration.subscription.get', {
    title: 'Get Subscription',
    description: 'Retrieve detailed information about a specific event subscription by its ID. Returns the subscription\'s target URL, subscribed event types, filter configuration, delivery status, and creation date. Use this to inspect or debug a particular subscription\'s configuration.',
    inputSchema: {
      subscription_id: z.string().describe('Unique identifier of the subscription to retrieve, obtained from list_subscriptions or create_subscription'),
    },
    outputSchema: jsonResult,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ subscription_id }) => {
    const relay = getRelay();
    const sub = await relay.subscriptions.get(subscription_id);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(sub, null, 2) }],
      structuredContent: sub as unknown as Record<string, unknown>,
    };
  });

  server.registerTool('integration.subscription.delete', {
    title: 'Delete Subscription',
    description: 'Permanently delete an outbound event subscription by its ID. Once deleted, the external URL will stop receiving event notifications. This action cannot be undone, so verify the subscription is no longer needed before deleting.',
    inputSchema: {
      subscription_id: z.string().describe('Unique identifier of the subscription to delete, obtained from list_subscriptions'),
    },
    outputSchema: {
      message: z.string().describe('Confirmation message indicating the subscription was deleted'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async ({ subscription_id }) => {
    const relay = getRelay();
    await relay.subscriptions.delete(subscription_id);
    const message = `Deleted subscription ${subscription_id}`;
    return {
      content: [{ type: 'text' as const, text: message }],
      structuredContent: { message },
    };
  });

  // === Agent Commands ===

  server.registerTool('integration.command.register', {
    title: 'Register Command',
    description: 'Register a custom slash command that a specific agent can handle. Other agents in the workspace can invoke this command, and the handler agent receives the invocation with its parameters. Commands enable structured inter-agent workflows, such as /deploy, /review, or /summarize. Re-registering an existing command updates its definition.',
    inputSchema: {
      command: z.string().describe('Command name without the leading slash (e.g. "deploy", "review", "summarize")'),
      description: z.string().describe('Human-readable description of what the command does, shown when listing available commands'),
      handler_agent: z.string().describe('Name of the registered agent responsible for handling invocations of this command'),
      parameters: z.array(z.object({
        name: z.string().describe('Parameter name used as the key when passing structured arguments'),
        description: z.string().optional().describe('Human-readable description of what this parameter controls'),
        type: z.enum(['string', 'number', 'boolean']).describe('Data type for input validation: "string", "number", or "boolean"'),
        required: z.boolean().optional().describe('Whether this parameter must be provided when invoking the command'),
      })).optional().describe('Array of parameter definitions that the command accepts for structured input'),
    },
    outputSchema: jsonResult,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ command, description, handler_agent, parameters }) => {
    const relay = getRelay();
    const result = await relay.commands.register({
      command,
      description,
      handlerAgent: handler_agent,
      parameters,
    });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  });

  server.registerTool('integration.command.list', {
    title: 'List Commands',
    description: 'List all registered slash commands available in the workspace. Returns each command\'s name, description, handler agent, and parameter definitions. Use this to discover what commands other agents have registered and how to invoke them.',
    inputSchema: {
      handler_agent: z.string().optional().describe('Filter commands to show only those handled by this specific agent name'),
    },
    outputSchema: {
      commands: z.array(z.object({}).passthrough()).describe('Array of command objects with name, description, handler, and parameters'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async () => {
    const relay = getRelay();
    const commands = await relay.commands.list();
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(commands, null, 2) }],
      structuredContent: { commands: commands as unknown as Record<string, unknown>[] },
    };
  });

  server.registerTool('integration.command.delete', {
    title: 'Delete Command',
    description: 'Permanently remove a registered slash command from the workspace. Once deleted, other agents can no longer invoke the command. This action cannot be undone, so verify the command is no longer needed before deleting.',
    inputSchema: {
      command: z.string().describe('Name of the command to delete, without the leading slash (e.g. "deploy")'),
    },
    outputSchema: {
      message: z.string().describe('Confirmation message indicating the command was deleted'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async ({ command }) => {
    const relay = getRelay();
    await relay.commands.delete(command);
    const message = `Deleted command /${command}`;
    return {
      content: [{ type: 'text' as const, text: message }],
      structuredContent: { message },
    };
  });

  server.registerTool('integration.command.invoke', {
    title: 'Invoke Command',
    description: 'Invoke a registered slash command as the current agent within a channel context. The invocation is routed to the command\'s handler agent for processing. You can pass arguments as a raw string or as structured JSON parameters matching the command\'s parameter definitions.',
    inputSchema: {
      command: z.string().describe('Name of the command to invoke, without the leading slash (e.g. "deploy", "review")'),
      channel: z.string().describe('Name of the channel providing context for the command invocation'),
      args: z.string().optional().describe('Raw argument string passed to the command handler (e.g. "production --force")'),
      parameters: z.string().optional().describe('JSON-encoded object of structured parameters matching the command\'s parameter definitions'),
    },
    outputSchema: jsonResult,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ command, channel, args, parameters }) => {
    const client = getAgentClient();
    const parsedParams = parameters ? JSON.parse(parameters) : undefined;
    const result = await client.commands.invoke(command, { channel, args, parameters: parsedParams });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  });

  // === Agent Lifecycle (Spawn/Release) ===

  server.registerTool('agent.add', {
    title: 'Add Agent',
    description: 'Add a new AI agent to the workspace to work on a task. This is a BUILT-IN system operation for creating worker agents. If an agent with the same name already exists, it will be reactivated with a new token and updated task. The agent is automatically set to online status and joined to the specified channel.',
    inputSchema: {
      name: z.string().describe('Unique name for the new agent within the workspace (e.g. "worker-1", "code-reviewer")'),
      cli: z.enum(['claude', 'codex', 'gemini', 'aider', 'goose']).describe('Which AI CLI tool to use for the agent process'),
      task: z.string().describe('The task description or instructions for the agent to work on'),
      channel: z.string().optional().describe('Channel name to automatically join the agent to (e.g. "general", "dev-team")'),
      persona: z.string().optional().describe('Free-text persona description that other agents can read to understand this agent\'s role'),
      model: z.string().optional().describe('AI model powering this agent (e.g. "claude-sonnet-4-6", "gpt-4o"). Shown in the dashboard agent profile.'),
    },
    outputSchema: jsonResult,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ name, cli, task, channel, persona, model }) => {
    const relay = getRelay();
    const metadata = model ? { model } : undefined;
    const result = await relay.agents.spawn({ name, cli, task, channel, persona, metadata });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  });

  server.registerTool('agent.remove', {
    title: 'Remove Agent',
    description: 'Remove an agent from active duty, marking it as offline. This is a BUILT-IN system operation for agent lifecycle management. Optionally delete the agent entirely from the workspace. Use this when an agent has completed its task or is no longer needed.',
    inputSchema: {
      name: z.string().describe('Name of the agent to remove (e.g. "worker-1", "code-reviewer")'),
      reason: z.string().optional().describe('Human-readable reason for removing the agent (e.g. "task completed", "no longer needed")'),
      delete_agent: z.boolean().optional().describe('If true, permanently delete the agent instead of just marking it offline'),
    },
    outputSchema: {
      name: z.string().describe('Name of the removed agent'),
      removed: z.boolean().describe('True if the agent was successfully removed'),
      deleted: z.boolean().describe('True if the agent was permanently deleted'),
      reason: z.string().nullable().describe('The reason provided for removing the agent'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async ({ name, reason, delete_agent }) => {
    const relay = getRelay();
    const result = await relay.agents.release({ name, reason, deleteAgent: delete_agent });
    // Transform 'released' to 'removed' for agent-facing consistency
    const transformed = {
      name: result.name,
      removed: result.released,
      deleted: result.deleted,
      reason: result.reason,
    };
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(transformed, null, 2) }],
      structuredContent: transformed as unknown as Record<string, unknown>,
    };
  });
}
