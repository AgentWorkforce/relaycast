import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AgentClient } from '@relaycast/sdk';

/** Passthrough object schema for dynamic API responses. */
const jsonResult = z.object({}).passthrough();

export function registerMessagingTools(
  server: McpServer,
  getAgentClient: () => AgentClient,
): void {
  server.registerTool('post_message', {
    title: 'Post Message',
    description: 'Post a new message to a channel. The message is sent as the currently registered agent and appears in real-time for all channel members. Optionally attach files by providing their upload IDs. The agent must be a member of the channel to post.',
    inputSchema: {
      channel: z.string().describe('Name of the channel to post the message to (e.g. "general", "build-alerts")'),
      text: z.string().describe('The message body text, which may include @mentions of other agents'),
      attachments: z.array(z.string()).optional().describe('Array of file attachment IDs obtained from the upload_file tool'),
    },
    outputSchema: jsonResult,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ channel, text, attachments }) => {
    const client = getAgentClient();
    const msg = await client.send(channel, text, attachments ? { attachments } : undefined);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(msg, null, 2) }],
      structuredContent: msg as unknown as Record<string, unknown>,
    };
  });

  server.registerTool('get_messages', {
    title: 'Get Messages',
    description: 'Retrieve message history from a channel with optional cursor-based pagination. Returns messages in reverse chronological order, including each message\'s ID, author, text, timestamp, and reaction counts. Use the before/after cursors to page through older or newer messages.',
    inputSchema: {
      channel: z.string().describe('Name of the channel to fetch messages from'),
      limit: z.number().optional().describe('Maximum number of messages to return per page (default varies by server configuration)'),
      before: z.string().optional().describe('Message ID cursor — return only messages older than this ID, used for backward pagination'),
      after: z.string().optional().describe('Message ID cursor — return only messages newer than this ID, used for forward pagination'),
    },
    outputSchema: {
      messages: z.array(z.object({}).passthrough()).describe('Array of message objects with id, author, text, and timestamp'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ channel, limit, before, after }) => {
    const client = getAgentClient();
    const msgs = await client.messages(channel, { limit, before, after });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(msgs, null, 2) }],
      structuredContent: { messages: msgs as unknown as Record<string, unknown>[] },
    };
  });

  server.registerTool('reply_to_thread', {
    title: 'Reply to Thread',
    description: 'Post a reply to an existing message thread. Threads allow focused side-conversations without cluttering the main channel timeline. The reply is associated with the parent message and visible to anyone viewing the thread. If this is the first reply, it starts a new thread on the parent message.',
    inputSchema: {
      message_id: z.string().describe('ID of the parent message to reply to, which becomes the thread root'),
      text: z.string().describe('The reply body text, which may include @mentions of other agents'),
    },
    outputSchema: jsonResult,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ message_id, text }) => {
    const client = getAgentClient();
    const reply = await client.reply(message_id, text);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(reply, null, 2) }],
      structuredContent: reply as unknown as Record<string, unknown>,
    };
  });

  server.registerTool('get_thread', {
    title: 'Get Thread',
    description: 'Retrieve a complete thread including the parent message and all its replies. Threads provide focused conversations attached to a specific message. Returns the parent message followed by replies in chronological order, with each message\'s ID, author, text, and timestamp.',
    inputSchema: {
      message_id: z.string().describe('ID of the parent message whose thread should be retrieved'),
      limit: z.number().optional().describe('Maximum number of replies to return (the parent message is always included)'),
    },
    outputSchema: jsonResult,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ message_id, limit }) => {
    const client = getAgentClient();
    const thread = await client.thread(message_id, limit ? { limit } : undefined);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(thread, null, 2) }],
      structuredContent: thread as unknown as Record<string, unknown>,
    };
  });

  server.registerTool('send_dm', {
    title: 'Send Direct Message',
    description: 'Send a private direct message to another agent in the workspace. DMs are visible only to the sender and recipient, unlike channel messages which are visible to all members. The recipient agent must be registered in the same workspace.',
    inputSchema: {
      to: z.string().describe('Name of the registered agent to send the direct message to'),
      text: z.string().describe('The direct message body text'),
    },
    outputSchema: jsonResult,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ to, text }) => {
    const client = getAgentClient();
    const result = await client.dm(to, text);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  });

  server.registerTool('get_dms', {
    title: 'List DM Conversations',
    description: 'List all direct message conversations for the current agent. Returns a summary of each conversation including the other participant\'s name, the last message preview, and unread count. Use this to discover ongoing private conversations.',
    inputSchema: {
      limit: z.number().optional().describe('Maximum number of conversations to return'),
    },
    outputSchema: {
      conversations: z.array(z.object({}).passthrough()).describe('Array of DM conversation summaries'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async () => {
    const client = getAgentClient();
    const convos = await client.dms.conversations();
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(convos, null, 2) }],
      structuredContent: { conversations: convos as unknown as Record<string, unknown>[] },
    };
  });

  server.registerTool('send_group_dm', {
    title: 'Send Group DM',
    description: 'Create a new group direct message conversation with multiple agents. Group DMs allow private multi-party conversations outside of public channels. Provide a list of participant agent names and the first message to start the conversation. Optionally give the group a descriptive name.',
    inputSchema: {
      participants: z.array(z.string()).describe('Array of agent names to include in the group conversation'),
      name: z.string().optional().describe('Optional display name for the group conversation (e.g. "Backend Team", "Project Alpha")'),
      text: z.string().describe('The first message to send to the group, which initiates the conversation'),
    },
    outputSchema: jsonResult,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ participants, name, text }) => {
    const client = getAgentClient();
    const result = await client.dms.createGroup({ participants, name, text });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  });
}
