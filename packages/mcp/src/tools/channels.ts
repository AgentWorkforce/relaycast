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
      description: 'Create a new channel in the workspace.',
      inputSchema: {
        name: z.string().describe('Channel name (no spaces, lowercase)'),
        topic: z.string().optional().describe('Channel topic/description'),
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
      description: 'List all channels in the workspace.',
      inputSchema: {
        include_archived: z.boolean().optional().describe('Include archived channels'),
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
      description: 'Join a channel.',
      inputSchema: {
        channel: z.string().describe('Channel name to join'),
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
      description: 'Leave a channel.',
      inputSchema: {
        channel: z.string().describe('Channel name to leave'),
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
      description: 'Invite an agent to a channel.',
      inputSchema: {
        channel: z.string().describe('Channel name'),
        agent: z.string().describe('Agent name to invite'),
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
      description: 'Set the topic for a channel.',
      inputSchema: {
        channel: z.string().describe('Channel name'),
        topic: z.string().describe('New topic text'),
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
      description: 'Archive a channel (soft delete).',
      inputSchema: {
        channel: z.string().describe('Channel name to archive'),
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

