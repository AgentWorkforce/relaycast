import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AgentClient } from '@relaycast/sdk';

const readOnlyAnnotations = {
  title: 'Read-only operation',
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const writeAnnotations = {
  title: 'State-changing operation',
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

export function registerFeatureTools(
  server: McpServer,
  getAgentClient: () => AgentClient,
): void {
  server.registerTool('add_reaction', {
    description: 'Add an emoji reaction to a message.',
    annotations: writeAnnotations,
    inputSchema: {
      message_id: z.string().describe('Message ID'),
      emoji: z.string().describe('Emoji to react with'),
    },
  }, async ({ message_id, emoji }) => {
    const client = getAgentClient();
    await client.react(message_id, emoji);
    return { content: [{ type: 'text' as const, text: `Reacted with ${emoji}` }] };
  });

  server.registerTool('remove_reaction', {
    description: 'Remove an emoji reaction from a message.',
    annotations: writeAnnotations,
    inputSchema: {
      message_id: z.string().describe('Message ID'),
      emoji: z.string().describe('Emoji to remove'),
    },
  }, async ({ message_id, emoji }) => {
    const client = getAgentClient();
    await client.unreact(message_id, emoji);
    return { content: [{ type: 'text' as const, text: `Removed reaction ${emoji}` }] };
  });

  server.registerTool('search_messages', {
    description: 'Search messages across channels.',
    annotations: readOnlyAnnotations,
    inputSchema: {
      query: z.string().describe('Search query'),
      channel: z.string().optional().describe('Limit to channel'),
      from: z.string().optional().describe('Filter by sender agent'),
      limit: z.number().optional().describe('Max results'),
    },
  }, async ({ query, channel, from, limit }) => {
    const client = getAgentClient();
    const results = await client.search(query, { channel, from, limit });
    return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
  });

  server.registerTool('check_inbox', {
    description: 'Check inbox for unread messages, mentions, and DMs.',
    annotations: readOnlyAnnotations,
  }, async () => {
    const client = getAgentClient();
    const inbox = await client.inbox();
    return { content: [{ type: 'text' as const, text: JSON.stringify(inbox, null, 2) }] };
  });

  server.registerTool('mark_read', {
    description: 'Mark a message as read.',
    annotations: writeAnnotations,
    inputSchema: {
      message_id: z.string().describe('Message ID to mark as read'),
    },
  }, async ({ message_id }) => {
    const client = getAgentClient();
    await client.markRead(message_id);
    return { content: [{ type: 'text' as const, text: `Marked message ${message_id} as read` }] };
  });

  server.registerTool('get_readers', {
    description: 'Get list of agents who have read a message.',
    annotations: readOnlyAnnotations,
    inputSchema: {
      message_id: z.string().describe('Message ID'),
    },
  }, async ({ message_id }) => {
    const client = getAgentClient();
    const readers = await client.readers(message_id);
    return { content: [{ type: 'text' as const, text: JSON.stringify(readers, null, 2) }] };
  });

  server.registerTool('upload_file', {
    description: 'Upload a file and get an attachment ID.',
    annotations: writeAnnotations,
    inputSchema: {
      filename: z.string().describe('File name'),
      content_type: z.string().describe('MIME type (e.g. text/plain, image/png)'),
      size_bytes: z.number().describe('File size in bytes'),
    },
  }, async ({ filename, content_type, size_bytes }) => {
    const client = getAgentClient();
    const upload = await client.files.upload({ filename, content_type, size_bytes });
    return { content: [{ type: 'text' as const, text: JSON.stringify(upload, null, 2) }] };
  });
}
