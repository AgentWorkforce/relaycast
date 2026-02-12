import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AgentClient } from '@relaycast/sdk';

export function registerChannelTools(
  server: McpServer,
  getAgentClient: () => AgentClient,
): void {
  // Tool 3: create_channel
  server.registerTool(
    'create_channel',
    {
      title: 'Create Channel',
      description: 'Create a new communication channel in the workspace. Channels are the primary way for agents to broadcast and receive messages in a shared context. Channel names must be lowercase with no spaces, similar to Slack channel naming conventions. Optionally set an initial topic to describe the channel\'s purpose.',
      inputSchema: {
        name: z.string().describe('Unique channel name using lowercase letters, numbers, and hyphens (e.g. "build-alerts", "team-chat")'),
        topic: z.string().optional().describe('Short description of the channel\'s purpose, visible to all members when they view channel details'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ name, topic }) => {
      const client = getAgentClient();
      const channel = await client.channels.create({ name, topic });
      return { content: [{ type: 'text', text: JSON.stringify(channel, null, 2) }] };
    },
  );

  // Tool 4: list_channels
  server.registerTool(
    'list_channels',
    {
      title: 'List Channels',
      description: 'List all channels available in the workspace. Returns each channel\'s name, topic, member count, and creation date. By default only active channels are shown; set include_archived to true to also see archived channels.',
      inputSchema: {
        include_archived: z.boolean().optional().describe('When true, include archived channels in the response alongside active ones'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ include_archived }) => {
      const client = getAgentClient();
      const channels = await client.channels.list(
        include_archived ? { include_archived } : undefined,
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(channels, null, 2) }],
      };
    },
  );

  // Tool 5: join_channel
  server.registerTool(
    'join_channel',
    {
      title: 'Join Channel',
      description: 'Join an existing channel to start receiving its messages. The agent will appear in the channel\'s member list and can post messages after joining. This operation is idempotent — joining a channel you are already a member of has no effect.',
      inputSchema: {
        channel: z.string().describe('Name of the channel to join (e.g. "general", "build-alerts")'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ channel }) => {
      const client = getAgentClient();
      await client.channels.join(channel);
      return { content: [{ type: 'text', text: `Joined channel #${channel}` }] };
    },
  );

  // Tool 6: leave_channel
  server.registerTool(
    'leave_channel',
    {
      title: 'Leave Channel',
      description: 'Leave a channel to stop receiving its messages. The agent is removed from the channel\'s member list but the channel and its history are preserved. You can rejoin at any time. This operation is idempotent — leaving a channel you are not a member of has no effect.',
      inputSchema: {
        channel: z.string().describe('Name of the channel to leave (e.g. "general", "build-alerts")'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ channel }) => {
      const client = getAgentClient();
      await client.channels.leave(channel);
      return { content: [{ type: 'text', text: `Left channel #${channel}` }] };
    },
  );

  // Tool 7: invite_to_channel
  server.registerTool(
    'invite_to_channel',
    {
      title: 'Invite to Channel',
      description: 'Invite another agent to join a channel. The invited agent is automatically added as a member and will begin receiving messages from the channel. This is useful for onboarding new agents into specific conversations or workflows.',
      inputSchema: {
        channel: z.string().describe('Name of the channel to invite the agent to (e.g. "general", "build-alerts")'),
        agent: z.string().describe('Name of the registered agent to invite into the channel'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ channel, agent }) => {
      const client = getAgentClient();
      await client.channels.invite(channel, agent);
      return { content: [{ type: 'text', text: `Invited ${agent} to #${channel}` }] };
    },
  );

  // Tool 8: set_channel_topic
  server.registerTool(
    'set_channel_topic',
    {
      title: 'Set Channel Topic',
      description: 'Update the topic description for a channel. The topic is a short text visible to all members that describes the channel\'s current purpose or focus. Changing the topic does not send a notification to channel members.',
      inputSchema: {
        channel: z.string().describe('Name of the channel whose topic should be updated'),
        topic: z.string().describe('New topic text describing the channel\'s purpose or current focus'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ channel, topic }) => {
      const client = getAgentClient();
      const updated = await client.channels.setTopic(channel, topic);
      return { content: [{ type: 'text', text: JSON.stringify(updated, null, 2) }] };
    },
  );

  // Tool 9: archive_channel
  server.registerTool(
    'archive_channel',
    {
      title: 'Archive Channel',
      description: 'Archive a channel to remove it from the active channel list. Archived channels preserve their full message history but no new messages can be posted. This is a soft delete — the channel can be restored later if needed. Use this to clean up channels that are no longer in use.',
      inputSchema: {
        channel: z.string().describe('Name of the channel to archive (e.g. "old-project", "temp-discussion")'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ channel }) => {
      const client = getAgentClient();
      await client.channels.archive(channel);
      return { content: [{ type: 'text', text: `Archived channel #${channel}` }] };
    },
  );
}
