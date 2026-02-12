import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AgentClient } from '@relaycast/sdk';

export function registerMessagingTools(
  server: McpServer,
  getAgentClient: () => AgentClient,
): void {
  server.registerTool('post_message', {
    title: 'Post Message',
    description: 'Post a message to a channel.',
    inputSchema: {
      channel: z.string().describe('Channel name'),
      text: z.string().describe('Message text'),
      attachments: z.array(z.string()).optional().describe('File IDs to attach'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ channel, text, attachments }) => {
    const client = getAgentClient();
    const msg = await client.send(channel, text, attachments ? { attachments } : undefined);
    return { content: [{ type: 'text' as const, text: JSON.stringify(msg, null, 2) }] };
  });

  server.registerTool('get_messages', {
    title: 'Get Messages',
    description: 'Get message history from a channel.',
    inputSchema: {
      channel: z.string().describe('Channel name'),
      limit: z.number().optional().describe('Max messages to return'),
      before: z.string().optional().describe('Cursor: messages before this ID'),
      after: z.string().optional().describe('Cursor: messages after this ID'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async ({ channel, limit, before, after }) => {
    const client = getAgentClient();
    const msgs = await client.messages(channel, { limit, before, after });
    return { content: [{ type: 'text' as const, text: JSON.stringify(msgs, null, 2) }] };
  });

  server.registerTool('reply_to_thread', {
    title: 'Reply to Thread',
    description: 'Reply to a message thread.',
    inputSchema: {
      message_id: z.string().describe('Parent message ID'),
      text: z.string().describe('Reply text'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ message_id, text }) => {
    const client = getAgentClient();
    const reply = await client.reply(message_id, text);
    return { content: [{ type: 'text' as const, text: JSON.stringify(reply, null, 2) }] };
  });

  server.registerTool('get_thread', {
    title: 'Get Thread',
    description: 'Get a thread (parent message + replies).',
    inputSchema: {
      message_id: z.string().describe('Parent message ID'),
      limit: z.number().optional().describe('Max replies to return'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async ({ message_id, limit }) => {
    const client = getAgentClient();
    const thread = await client.thread(message_id, limit ? { limit } : undefined);
    return { content: [{ type: 'text' as const, text: JSON.stringify(thread, null, 2) }] };
  });

  server.registerTool('send_dm', {
    title: 'Send Direct Message',
    description: 'Send a direct message to another agent.',
    inputSchema: {
      to: z.string().describe('Recipient agent name'),
      text: z.string().describe('Message text'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ to, text }) => {
    const client = getAgentClient();
    const result = await client.dm(to, text);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  });

  server.registerTool('get_dms', {
    title: 'List DM Conversations',
    description: 'List DM conversations.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async () => {
    const client = getAgentClient();
    const convos = await client.dms.conversations();
    return { content: [{ type: 'text' as const, text: JSON.stringify(convos, null, 2) }] };
  });

  server.registerTool('send_group_dm', {
    title: 'Send Group DM',
    description: 'Create a group DM conversation.',
    inputSchema: {
      participants: z.array(z.string()).describe('Agent names to include'),
      name: z.string().optional().describe('Group name'),
      text: z.string().describe('First message text'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ participants, name, text }) => {
    const client = getAgentClient();
    const result = await client.dms.createGroup({ participants, name, text });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  });
}
