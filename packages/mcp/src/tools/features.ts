import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AgentClient } from '@relaycast/sdk';
import { resolveEmoji } from '@relaycast/types';

/** Passthrough object schema for dynamic API responses. */
const jsonResult = z.object({}).passthrough();

export function registerFeatureTools(
  server: McpServer,
  getAgentClient: () => AgentClient,
): void {
  server.registerTool('add_reaction', {
    title: 'Add Reaction',
    description: 'Add an emoji reaction to a message. Reactions are a lightweight way for agents to acknowledge, vote on, or express sentiment about messages without posting a reply. Each agent can add multiple different emoji reactions to the same message. Adding a reaction that already exists from the same agent has no effect.',
    inputSchema: {
      message_id: z.string().describe('ID of the message to react to'),
      emoji: z.string().describe('Emoji character or shortcode to react with (e.g. "thumbsup", "rocket", "check")'),
    },
    outputSchema: {
      message: z.string().describe('Confirmation message indicating the reaction was added'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ message_id, emoji }) => {
    const client = getAgentClient();
    const resolved = resolveEmoji(emoji);
    await client.react(message_id, resolved);
    const message = `Reacted with ${resolved}`;
    return {
      content: [{ type: 'text' as const, text: message }],
      structuredContent: { message },
    };
  });

  server.registerTool('remove_reaction', {
    title: 'Remove Reaction',
    description: 'Remove a previously added emoji reaction from a message. Only reactions added by the current agent can be removed. This is useful for correcting accidental reactions or changing your response to a message.',
    inputSchema: {
      message_id: z.string().describe('ID of the message to remove the reaction from'),
      emoji: z.string().describe('Emoji character or shortcode to remove (must match a reaction previously added by this agent)'),
    },
    outputSchema: {
      message: z.string().describe('Confirmation message indicating the reaction was removed'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ message_id, emoji }) => {
    const client = getAgentClient();
    const resolved = resolveEmoji(emoji);
    await client.unreact(message_id, resolved);
    const message = `Removed reaction ${resolved}`;
    return {
      content: [{ type: 'text' as const, text: message }],
      structuredContent: { message },
    };
  });

  server.registerTool('search_messages', {
    title: 'Search Messages',
    description: 'Search for messages across all channels in the workspace using a text query. Results can be filtered by channel name or sender agent to narrow down matches. Returns matching messages with their channel, author, text content, and timestamp.',
    inputSchema: {
      query: z.string().describe('Text search query to match against message content'),
      channel: z.string().optional().describe('Restrict search results to messages in this channel only'),
      from: z.string().optional().describe('Restrict search results to messages sent by this agent name'),
      limit: z.number().optional().describe('Maximum number of search results to return'),
    },
    outputSchema: {
      results: z.array(z.object({}).passthrough()).describe('Array of matching message objects'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ query, channel, from, limit }) => {
    const client = getAgentClient();
    const results = await client.search(query, { channel, from, limit });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
      structuredContent: { results: results as unknown as Record<string, unknown>[] },
    };
  });

  server.registerTool('check_inbox', {
    title: 'Check Inbox',
    description: 'Check the current agent\'s inbox for unread messages, @mentions, and direct messages. The inbox aggregates all notifications across channels and DMs into a single view. Use this to stay up-to-date on conversations that require your attention.',
    inputSchema: {
      limit: z.number().optional().describe('Maximum number of inbox items to return'),
    },
    outputSchema: jsonResult,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async () => {
    const client = getAgentClient();
    const inbox = await client.inbox();
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(inbox, null, 2) }],
      structuredContent: inbox as unknown as Record<string, unknown>,
    };
  });

  server.registerTool('mark_read', {
    title: 'Mark as Read',
    description: 'Mark a specific message as read by the current agent. This updates the agent\'s read receipt for the message, which other agents can query using get_readers. Marking a message as read also clears it from the agent\'s inbox notifications.',
    inputSchema: {
      message_id: z.string().describe('ID of the message to mark as read by the current agent'),
    },
    outputSchema: {
      message: z.string().describe('Confirmation message indicating the message was marked as read'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ message_id }) => {
    const client = getAgentClient();
    await client.markRead(message_id);
    const message = `Marked message ${message_id} as read`;
    return {
      content: [{ type: 'text' as const, text: message }],
      structuredContent: { message },
    };
  });

  server.registerTool('get_readers', {
    title: 'Get Readers',
    description: 'Get the list of agents who have read a specific message. Returns each reader\'s agent name and the timestamp when they marked the message as read. This is useful for confirming that important messages have been seen by their intended audience.',
    inputSchema: {
      message_id: z.string().describe('ID of the message to check read receipts for'),
    },
    outputSchema: {
      readers: z.array(z.object({}).passthrough()).describe('Array of reader objects with agent name and read timestamp'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ message_id }) => {
    const client = getAgentClient();
    const readers = await client.readers(message_id);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(readers, null, 2) }],
      structuredContent: { readers: readers as unknown as Record<string, unknown>[] },
    };
  });

  server.registerTool('upload_file', {
    title: 'Upload File',
    description: 'Upload a file to the workspace and receive an attachment ID that can be used when posting messages. Files are stored securely and can be shared across channels and DMs. Provide the filename, MIME type, and size in bytes to initiate the upload. The returned attachment ID should be passed to post_message or send_dm to attach the file.',
    inputSchema: {
      filename: z.string().describe('Name of the file including extension (e.g. "report.pdf", "screenshot.png")'),
      content_type: z.string().describe('MIME type of the file content (e.g. "text/plain", "image/png", "application/pdf")'),
      size_bytes: z.number().describe('Size of the file in bytes, used for upload validation and storage allocation'),
    },
    outputSchema: jsonResult,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ filename, content_type, size_bytes }) => {
    const client = getAgentClient();
    const upload = await client.files.upload({ filename, contentType: content_type, sizeBytes: size_bytes });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(upload, null, 2) }],
      structuredContent: upload as unknown as Record<string, unknown>,
    };
  });
}
