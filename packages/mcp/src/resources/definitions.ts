import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentClient, RelayCast } from '@relaycast/sdk';

export function registerResourceDefinitions(
  server: McpServer,
  getAgentClient: () => AgentClient,
  getRelay: () => RelayCast,
): void {
  // Static resource: inbox
  server.registerResource(
    'inbox',
    'relay://inbox',
    { title: 'Inbox', description: 'Unread messages, mentions, and DMs', mimeType: 'application/json' },
    async (uri) => {
      const client = getAgentClient();
      const inbox = await client.inbox();
      return { contents: [{ uri: uri.href, text: JSON.stringify(inbox) }] };
    },
  );

  // Static resource: agents
  server.registerResource(
    'agents',
    'relay://agents',
    { title: 'Agents', description: 'Online and offline agents in the workspace', mimeType: 'application/json' },
    async (uri) => {
      const relay = getRelay();
      const agents = await relay.agents.list();
      return { contents: [{ uri: uri.href, text: JSON.stringify(agents) }] };
    },
  );

  // Static resource: channels
  server.registerResource(
    'channels',
    'relay://channels',
    { title: 'Channels', description: 'Available channels in the workspace', mimeType: 'application/json' },
    async (uri) => {
      const client = getAgentClient();
      const channels = await client.channels.list();
      return { contents: [{ uri: uri.href, text: JSON.stringify(channels) }] };
    },
  );

  // Template: channel messages
  server.registerResource(
    'channel-messages',
    new ResourceTemplate('relay://channels/{name}/messages', { list: undefined }),
    { title: 'Channel Messages', description: 'Messages in a specific channel', mimeType: 'application/json' },
    async (uri, params) => {
      const client = getAgentClient();
      const messages = await client.messages(params.name as string);
      return { contents: [{ uri: uri.href, text: JSON.stringify(messages) }] };
    },
  );

  // Template: message thread
  server.registerResource(
    'message-thread',
    new ResourceTemplate('relay://messages/{id}/thread', { list: undefined }),
    { title: 'Message Thread', description: 'Thread replies on a message', mimeType: 'application/json' },
    async (uri, params) => {
      const client = getAgentClient();
      const thread = await client.thread(params.id as string);
      return { contents: [{ uri: uri.href, text: JSON.stringify(thread) }] };
    },
  );

  // Template: DM conversation
  server.registerResource(
    'dm-conversation',
    new ResourceTemplate('relay://dm/{conversation_id}', { list: undefined }),
    { title: 'DM Conversation', description: 'Direct message conversation', mimeType: 'application/json' },
    async (uri, params) => {
      const client = getAgentClient();
      const messages = await client.dms.messages(params.conversation_id as string);
      return { contents: [{ uri: uri.href, text: JSON.stringify(messages) }] };
    },
  );
}
