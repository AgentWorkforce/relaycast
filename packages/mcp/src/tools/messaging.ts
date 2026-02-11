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

export function registerMessagingTools(
  server: McpServer,
  getAgentClient: () => AgentClient,
): void {
  server.registerTool('post_message', {
    description: 'Post a message to a channel.',
    annotations: writeAnnotations,
    inputSchema: {
      channel: z.string().describe('Channel name'),
      text: z.string().describe('Message text'),
      attachments: z.array(z.string()).optional().describe('File IDs to attach'),
    },
  }, async ({ channel, text, attachments }) => {
    const client = getAgentClient();
    const msg = await client.send(channel, text, attachments ? { attachments } : undefined);
    return { content: [{ type: 'text' as const, text: JSON.stringify(msg, null, 2) }] };
  });

  server.registerTool('get_messages', {
    description: 'Get message history from a channel.',
    annotations: readOnlyAnnotations,
    inputSchema: {
      channel: z.string().describe('Channel name'),
      limit: z.number().optional().describe('Max messages to return'),
      before: z.string().optional().describe('Cursor: messages before this ID'),
      after: z.string().optional().describe('Cursor: messages after this ID'),
    },
  }, async ({ channel, limit, before, after }) => {
    const client = getAgentClient();
    const msgs = await client.messages(channel, { limit, before, after });
    return { content: [{ type: 'text' as const, text: JSON.stringify(msgs, null, 2) }] };
  });

  server.registerTool('reply_to_thread', {
    description: 'Reply to a message thread.',
    annotations: writeAnnotations,
    inputSchema: {
      message_id: z.string().describe('Parent message ID'),
      text: z.string().describe('Reply text'),
    },
  }, async ({ message_id, text }) => {
    const client = getAgentClient();
    const reply = await client.reply(message_id, text);
    return { content: [{ type: 'text' as const, text: JSON.stringify(reply, null, 2) }] };
  });

  server.registerTool('get_thread', {
    description: 'Get a thread (parent message + replies).',
    annotations: readOnlyAnnotations,
    inputSchema: {
      message_id: z.string().describe('Parent message ID'),
      limit: z.number().optional().describe('Max replies to return'),
    },
  }, async ({ message_id, limit }) => {
    const client = getAgentClient();
    const thread = await client.thread(message_id, limit ? { limit } : undefined);
    return { content: [{ type: 'text' as const, text: JSON.stringify(thread, null, 2) }] };
  });

  server.registerTool('send_dm', {
    description: 'Send a direct message to another agent.',
    annotations: writeAnnotations,
    inputSchema: {
      to: z.string().describe('Recipient agent name'),
      text: z.string().describe('Message text'),
    },
  }, async ({ to, text }) => {
    const client = getAgentClient();
    const result = await client.dm(to, text);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  });

  server.registerTool('get_dms', {
    description: 'List DM conversations.',
    annotations: readOnlyAnnotations,
  }, async () => {
    const client = getAgentClient();
    const convos = await client.dms.conversations();
    return { content: [{ type: 'text' as const, text: JSON.stringify(convos, null, 2) }] };
  });

  server.registerTool('send_group_dm', {
    description: 'Create a group DM conversation.',
    annotations: writeAnnotations,
    inputSchema: {
      participants: z.array(z.string()).describe('Agent names to include'),
      name: z.string().optional().describe('Group name'),
      text: z.string().describe('First message text'),
    },
  }, async ({ participants, name, text }) => {
    const client = getAgentClient();
    const result = await client.dms.createGroup({ participants, name, text });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  });
}
