import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AgentClient } from '@relaycast/sdk';
import {
  identityOverrideInputShape,
  workspaceRoutingInputShape,
  workspaceRefFromArgs,
} from '../workspaces.js';

/** Passthrough object schema for dynamic API responses. */
const jsonResult = z.object({}).passthrough();

export function registerChannelTools(
  server: McpServer,
  getAgentClient: (wsRouting?: { workspace_id?: string; workspace_alias?: string }, as?: string) => AgentClient,
): void {
  server.registerTool(
    'channel.create',
    {
      title: 'Create Channel',
      description: 'Create a new communication channel in the workspace. Channels are the primary way for agents to broadcast and receive messages in a shared context. Channel names must be lowercase with no spaces, similar to Slack channel naming conventions. Optionally set an initial topic to describe the channel\'s purpose.',
      inputSchema: {
        name: z.string().describe('Unique channel name using lowercase letters, numbers, and hyphens (e.g. "build-alerts", "team-chat")'),
        topic: z.string().optional().describe('Short description of the channel\'s purpose, visible to all members when they view channel details'),
        ...identityOverrideInputShape,
      },
      outputSchema: jsonResult,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ name, topic, as: asIdentity }) => {
      const client = getAgentClient(undefined, asIdentity);
      const channel = await client.channels.create({ name, topic });
      return {
        content: [{ type: 'text', text: JSON.stringify(channel, null, 2) }],
        structuredContent: channel as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    'channel.list',
    {
      title: 'List Channels',
      description: 'List all channels available in the workspace. Returns each channel\'s name, topic, member count, and creation date. By default only active channels are shown; set include_archived to true to also see archived channels.',
      inputSchema: {
        include_archived: z.boolean().optional().describe('When true, include archived channels in the response alongside active ones'),
        ...workspaceRoutingInputShape,
        ...identityOverrideInputShape,
      },
      outputSchema: {
        channels: z.array(z.object({}).passthrough()).describe('Array of channel objects with name, topic, and member details'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ include_archived, workspace_id, workspace_alias, as: asIdentity }) => {
      const client = getAgentClient(
        workspaceRefFromArgs({ workspace_id, workspace_alias }),
        asIdentity,
      );
      const channels = await client.channels.list(
        include_archived ? { includeArchived: include_archived } : undefined,
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(channels, null, 2) }],
        structuredContent: { channels: channels as unknown as Record<string, unknown>[] },
      };
    },
  );

  server.registerTool(
    'channel.join',
    {
      title: 'Join Channel',
      description: 'Join an existing channel to start receiving its messages. The agent will appear in the channel\'s member list and can post messages after joining. This operation is idempotent — joining a channel you are already a member of has no effect.',
      inputSchema: {
        channel: z.string().describe('Name of the channel to join (e.g. "general", "build-alerts")'),
        ...identityOverrideInputShape,
      },
      outputSchema: {
        message: z.string().describe('Confirmation message indicating the channel was joined'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ channel, as: asIdentity }) => {
      const client = getAgentClient(undefined, asIdentity);
      await client.channels.join(channel);
      const message = `Joined channel #${channel}`;
      return {
        content: [{ type: 'text', text: message }],
        structuredContent: { message },
      };
    },
  );

  server.registerTool(
    'channel.leave',
    {
      title: 'Leave Channel',
      description: 'Leave a channel to stop receiving its messages. The agent is removed from the channel\'s member list but the channel and its history are preserved. You can rejoin at any time. This operation is idempotent — leaving a channel you are not a member of has no effect.',
      inputSchema: {
        channel: z.string().describe('Name of the channel to leave (e.g. "general", "build-alerts")'),
        ...identityOverrideInputShape,
      },
      outputSchema: {
        message: z.string().describe('Confirmation message indicating the channel was left'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ channel, as: asIdentity }) => {
      const client = getAgentClient(undefined, asIdentity);
      await client.channels.leave(channel);
      const message = `Left channel #${channel}`;
      return {
        content: [{ type: 'text', text: message }],
        structuredContent: { message },
      };
    },
  );

  server.registerTool(
    'channel.invite',
    {
      title: 'Invite to Channel',
      description: 'Invite another agent to join a channel. The invited agent is automatically added as a member and will begin receiving messages from the channel. This is useful for onboarding new agents into specific conversations or workflows.',
      inputSchema: {
        channel: z.string().describe('Name of the channel to invite the agent to (e.g. "general", "build-alerts")'),
        agent: z.string().describe('Name of the registered agent to invite into the channel'),
        ...identityOverrideInputShape,
      },
      outputSchema: {
        message: z.string().describe('Confirmation message indicating the agent was invited'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ channel, agent, as: asIdentity }) => {
      const client = getAgentClient(undefined, asIdentity);
      await client.channels.invite(channel, agent);
      const message = `Invited ${agent} to #${channel}`;
      return {
        content: [{ type: 'text', text: message }],
        structuredContent: { message },
      };
    },
  );

  server.registerTool(
    'channel.set_topic',
    {
      title: 'Set Channel Topic',
      description: 'Update the topic description for a channel. The topic is a short text visible to all members that describes the channel\'s current purpose or focus. Changing the topic does not send a notification to channel members.',
      inputSchema: {
        channel: z.string().describe('Name of the channel whose topic should be updated'),
        topic: z.string().describe('New topic text describing the channel\'s purpose or current focus'),
        ...workspaceRoutingInputShape,
        ...identityOverrideInputShape,
      },
      outputSchema: jsonResult,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ channel, topic, workspace_id, workspace_alias, as: asIdentity }) => {
      const client = getAgentClient(
        workspaceRefFromArgs({ workspace_id, workspace_alias }),
        asIdentity,
      );
      const updated = await client.channels.setTopic(channel, topic);
      return {
        content: [{ type: 'text', text: JSON.stringify(updated, null, 2) }],
        structuredContent: updated as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    'channel.archive',
    {
      title: 'Archive Channel',
      description: 'Archive a channel to remove it from the active channel list. Archived channels preserve their full message history but no new messages can be posted. This is a soft delete — the channel can be restored later if needed. Use this to clean up channels that are no longer in use.',
      inputSchema: {
        channel: z.string().describe('Name of the channel to archive (e.g. "old-project", "temp-discussion")'),
        ...workspaceRoutingInputShape,
        ...identityOverrideInputShape,
      },
      outputSchema: {
        message: z.string().describe('Confirmation message indicating the channel was archived'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ channel, workspace_id, workspace_alias, as: asIdentity }) => {
      const client = getAgentClient(
        workspaceRefFromArgs({ workspace_id, workspace_alias }),
        asIdentity,
      );
      await client.channels.archive(channel);
      const message = `Archived channel #${channel}`;
      return {
        content: [{ type: 'text', text: message }],
        structuredContent: { message },
      };
    },
  );
}
