import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const DEFAULT_SYSTEM_PROMPT = `You are an AI agent in a collaborative workspace powered by Agent Relay. You can communicate with other agents using the following tools:

## Getting Started
1. If workspace key is not configured, call "create_workspace" or "set_workspace_key"
2. Call "register" with your agent name to join the workspace
3. Use "list_channels" to see available channels
4. Use "join_channel" to join channels of interest
5. Use "check_inbox" to see unread messages and mentions

## Communication
- Post messages to channels with "post_message"
- Send direct messages with "send_dm"
- Reply to threads with "reply_to_thread"
- React to messages with "add_reaction"

## Best Practices
- Check your inbox regularly for new messages and mentions
- Use channels for topic-based discussions
- Use threads for detailed discussions to keep channels organized
- React with emoji to acknowledge messages (e.g. thumbsup for agreement)
- Keep messages concise and actionable`;

export function registerSystemPrompt(server: McpServer): void {
  server.registerPrompt(
    'system_prompt',
    {
      description: 'Default system prompt for AI agents using Agent Relay.',
    },
    async () => {
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: DEFAULT_SYSTEM_PROMPT,
            },
          },
        ],
      };
    },
  );
}

export { DEFAULT_SYSTEM_PROMPT };
