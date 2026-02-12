import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AgentClient } from '@relaycast/sdk';

export function registerFeatureTools(
  server: McpServer,
  getAgentClient: () => AgentClient,
): void {
  server.registerTool('add_reaction', {
    title: 'Add Reaction',
    description: 'Add an emoji reaction to a message.',
    inputSchema: {
      message_id: z.string().describe('Message ID'),
      emoji: z.string().describe('Emoji to react with'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ message_id, emoji }) => {
    const client = getAgentClient();
    await client.react(message_id, emoji);
    return { content: [{ type: 'text' as const, text: `Reacted with ${emoji}` }] };
  });

  server.registerTool('remove_reaction', {
    title: 'Remove Reaction',
    description: 'Remove an emoji reaction from a message.',
    inputSchema: {
      message_id: z.string().describe('Message ID'),
      emoji: z.string().describe('Emoji to remove'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ message_id, emoji }) => {
    const client = getAgentClient();
    await client.unreact(message_id, emoji);
    return { content: [{ type: 'text' as const, text: `Removed reaction ${emoji}` }] };
  });

  server.registerTool('search_messages', {
    title: 'Search Messages',
    description: 'Search messages across channels.',
    inputSchema: {
      query: z.string().describe('Search query'),
      channel: z.string().optional().describe('Limit to channel'),
      from: z.string().optional().describe('Filter by sender agent'),
      limit: z.number().optional().describe('Max results'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async ({ query, channel, from, limit }) => {
    const client = getAgentClient();
    const results = await client.search(query, { channel, from, limit });
    return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
  });

  server.registerTool('check_inbox', {
    title: 'Check Inbox',
    description: 'Check inbox for unread messages, mentions, and DMs.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async () => {
    const client = getAgentClient();
    const inbox = await client.inbox();
    return { content: [{ type: 'text' as const, text: JSON.stringify(inbox, null, 2) }] };
  });

  server.registerTool('mark_read', {
    title: 'Mark as Read',
    description: 'Mark a message as read.',
    inputSchema: {
      message_id: z.string().describe('Message ID to mark as read'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ message_id }) => {
    const client = getAgentClient();
    await client.markRead(message_id);
    return { content: [{ type: 'text' as const, text: `Marked message ${message_id} as read` }] };
  });

  server.registerTool('get_readers', {
    title: 'Get Readers',
    description: 'Get list of agents who have read a message.',
    inputSchema: {
      message_id: z.string().describe('Message ID'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async ({ message_id }) => {
    const client = getAgentClient();
    const readers = await client.readers(message_id);
    return { content: [{ type: 'text' as const, text: JSON.stringify(readers, null, 2) }] };
  });

  server.registerTool('upload_file', {
    title: 'Upload File',
    description: 'Upload a file and get an attachment ID.',
    inputSchema: {
      filename: z.string().describe('File name'),
      content_type: z.string().describe('MIME type (e.g. text/plain, image/png)'),
      size_bytes: z.number().describe('File size in bytes'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ filename, content_type, size_bytes }) => {
    const client = getAgentClient();
    const upload = await client.files.upload({ filename, content_type, size_bytes });
    return { content: [{ type: 'text' as const, text: JSON.stringify(upload, null, 2) }] };
  });
}
