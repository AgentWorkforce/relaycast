import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { RelayCast, AgentClient, JsonValue } from '@relaycast/sdk';
import { CliTypeSchema, SubscribableEventTypeSchema } from '@relaycast/types';
import {
  identityOverrideInputShape,
  workspaceRoutingInputShape,
  workspaceRefFromArgs,
} from '../workspaces.js';

/** Passthrough object schema for dynamic API responses. */
const jsonResult = z.object({}).passthrough();

export function registerProgrammabilityTools(
  server: McpServer,
  getRelay: (
    wsRouting?: { workspace_id?: string; workspace_alias?: string },
    asIdentity?: string,
  ) => RelayCast,
  getAgentClient: (wsRouting?: { workspace_id?: string; workspace_alias?: string }, as?: string) => AgentClient,
): void {
  // === Inbound Webhooks ===

  server.registerTool('integration.webhook.create', {
    title: 'Create Webhook',
    description: 'Create an inbound webhook that external services can POST to, delivering messages into a specified channel. Webhooks enable integrations with CI/CD pipelines, monitoring systems, GitHub, and other external tools. Each webhook gets a unique URL and one-time-visible bearer token for POST requests.',
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
      token: z.string().describe('Bearer token returned by create_webhook for this webhook'),
      text: z.string().optional().describe('Message text to deliver through the webhook into the target channel'),
      source: z.string().optional().describe('Source identifier for the webhook payload (e.g. "github", "jenkins", "datadog")'),
    },
    outputSchema: jsonResult,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ webhook_id, token, text, source }) => {
    const relay = getRelay();
    const result = await relay.webhooks.trigger(webhook_id, { text, source }, token);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  });

  // === Event Subscriptions ===

  server.registerTool('integration.subscription.create', {
    title: 'Create Event Subscription',
    description: 'Create an outbound event subscription that POSTs real-time webhook notifications to an external URL when matching events occur. Supported events include message.created, message.reacted, agent.status.active, and more. Optionally filter events by channel or agent mentions, attach delivery headers, and provide a secret for HMAC signature verification of payloads.',
    inputSchema: {
      events: z.array(SubscribableEventTypeSchema).describe('Array of event types to subscribe to (e.g. ["message.created", "message.reacted", "agent.status.active"])'),
      url: z.string().describe('HTTPS endpoint URL that will receive POST requests with event payloads'),
      headers: z.record(z.string(), z.string()).optional().describe('Optional custom headers to include on outbound delivery requests'),
      filter_channel: z.string().optional().describe('Only fire events that occur in this specific channel'),
      filter_mentions: z.string().optional().describe('Only fire events where this agent name is @mentioned in the message'),
      secret: z.string().optional().describe('Shared secret used to generate HMAC-SHA256 signatures for payload verification'),
    },
    outputSchema: jsonResult,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ events, url, headers, filter_channel, filter_mentions, secret }) => {
    const relay = getRelay();
    const filter = (filter_channel || filter_mentions)
      ? { channel: filter_channel, mentions: filter_mentions }
      : undefined;
    const result = await relay.subscriptions.create({
      events,
      url,
      headers,
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

  // === Actions (agent-to-agent RPC) ===

  server.registerTool('integration.action.register', {
    title: 'Register Action',
    description: 'Register an action (async agent-to-agent RPC) that a specific agent handles. Other agents invoke the action; the handler agent receives an `action.invoked` event and reports the result. Replaces the legacy command API. Requires the hosted engine (cast.agentrelay.com) or a self-hosted engine.',
    inputSchema: {
      name: z.string().describe('Action name (e.g. "deploy", "review")'),
      description: z.string().describe('Human-readable description of what the action does'),
      handler_agent: z.string().describe('Name of the registered agent that handles invocations'),
      input_schema: z.object({}).passthrough().optional().describe('JSON Schema describing the action input'),
      output_schema: z.object({}).passthrough().optional().describe('JSON Schema describing the action output'),
      available_to: z.array(z.string()).optional().describe('Agent names allowed to invoke this action (defaults to all)'),
    },
    outputSchema: jsonResult,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ name, description, handler_agent, input_schema, output_schema, available_to }) => {
    const relay = getRelay();
    const result = await relay.actions.register({
      name,
      description,
      handlerAgent: handler_agent,
      inputSchema: input_schema,
      outputSchema: output_schema,
      availableTo: available_to,
    });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  });

  server.registerTool('integration.action.list', {
    title: 'List Actions',
    description: 'List all registered actions in the workspace. Returns each action\'s name, description, handler agent, and input/output schemas.',
    inputSchema: {},
    outputSchema: {
      actions: z.array(z.object({}).passthrough()).describe('Array of action objects'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async () => {
    const relay = getRelay();
    const actions = await relay.actions.list();
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(actions, null, 2) }],
      structuredContent: { actions: actions as unknown as Record<string, unknown>[] },
    };
  });

  server.registerTool('integration.action.get', {
    title: 'Get Action',
    description: 'Get a single registered action by name, including its handler agent and input/output schemas.',
    inputSchema: {
      name: z.string().describe('Name of the action to fetch'),
    },
    outputSchema: jsonResult,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ name }) => {
    const relay = getRelay();
    const result = await relay.actions.get(name);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  });

  server.registerTool('integration.action.delete', {
    title: 'Delete Action',
    description: 'Permanently remove a registered action from the workspace. Once deleted, agents can no longer invoke it.',
    inputSchema: {
      name: z.string().describe('Name of the action to delete'),
    },
    outputSchema: {
      message: z.string().describe('Confirmation message'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async ({ name }) => {
    const relay = getRelay();
    await relay.actions.delete(name);
    const message = `Deleted action ${name}`;
    return {
      content: [{ type: 'text' as const, text: message }],
      structuredContent: { message },
    };
  });

  server.registerTool('integration.action.invoke', {
    title: 'Invoke Action',
    description: 'Invoke a registered action as the current agent. The invocation is routed to the handler agent for async processing; the returned invocation id can be used to poll for the result. The handler receives an `action.invoked` event.',
    inputSchema: {
      name: z.string().describe('Name of the action to invoke'),
      input: z.object({}).passthrough().optional().describe('Input object matching the action\'s input schema'),
      ...workspaceRoutingInputShape,
      ...identityOverrideInputShape,
    },
    outputSchema: jsonResult,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ name, input, workspace_id, workspace_alias, as: asIdentity }) => {
    const client = getAgentClient(workspaceRefFromArgs({ workspace_id, workspace_alias }), asIdentity);
    const result = await client.actions.invoke(name, input);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  });

  server.registerTool('integration.action.complete', {
    title: 'Complete Action Invocation',
    description: 'As the handler agent, report the result (or error) of an action invocation. Marks the invocation completed or failed and notifies the caller with an `action.completed`/`action.failed` event.',
    inputSchema: {
      name: z.string().describe('Name of the action'),
      invocation_id: z.string().describe('Invocation id returned by invoke'),
      output: z.object({}).passthrough().optional().describe('Result object matching the action\'s output schema'),
      error: z.string().optional().describe('Error message if the invocation failed'),
      duration_ms: z.number().int().nonnegative().optional().describe('How long the action took, in milliseconds'),
      ...workspaceRoutingInputShape,
      ...identityOverrideInputShape,
    },
    outputSchema: jsonResult,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ name, invocation_id, output, error, duration_ms, workspace_id, workspace_alias, as: asIdentity }) => {
    const client = getAgentClient(workspaceRefFromArgs({ workspace_id, workspace_alias }), asIdentity);
    const result = await client.actions.completeInvocation(name, invocation_id, {
      // The tool accepts an output object; the SDK/contract output type is the
      // wider JsonValue (scalars/arrays/null also legal), and an object is one.
      output: output as JsonValue | undefined,
      error,
      durationMs: duration_ms,
    });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  });

  server.registerTool('integration.action.get_invocation', {
    title: 'Get Action Invocation',
    description: 'Get the status and result of an action invocation by id. Use this to poll for completion after invoking an action.',
    inputSchema: {
      name: z.string().describe('Name of the action'),
      invocation_id: z.string().describe('Invocation id returned by invoke'),
      ...workspaceRoutingInputShape,
      ...identityOverrideInputShape,
    },
    outputSchema: jsonResult,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ name, invocation_id, workspace_id, workspace_alias, as: asIdentity }) => {
    const client = getAgentClient(workspaceRefFromArgs({ workspace_id, workspace_alias }), asIdentity);
    const result = await client.actions.getInvocation(name, invocation_id);
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
      cli: CliTypeSchema.describe('Which AI CLI tool to use for the agent process'),
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
    description: 'Request that an agent be removed from active duty. This is a BUILT-IN system action routed to the agent broker; the returned invocation is completed when the broker confirms release.',
    inputSchema: {
      name: z.string().describe('Name of the agent to remove (e.g. "worker-1", "code-reviewer")'),
      reason: z.string().optional().describe('Human-readable reason for removing the agent (e.g. "task completed", "no longer needed")'),
      delete_agent: z.boolean().optional().describe('If true, permanently delete the agent instead of just marking it offline'),
    },
    outputSchema: jsonResult,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async ({ name, reason, delete_agent }) => {
    const relay = getRelay();
    const result = await relay.agents.release({ name, reason, deleteAgent: delete_agent });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  });
}
