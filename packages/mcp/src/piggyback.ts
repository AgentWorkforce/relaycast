import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentClient } from '@relaycast/sdk';
import type { SessionState } from './types.js';

const SKIP_PIGGYBACK = new Set(['check_inbox', 'register']);

export function enablePiggyback(
  mcpServer: McpServer,
  getSession: () => SessionState,
  getAgentClient: () => AgentClient,
): void {
  const original = mcpServer.registerTool.bind(mcpServer);

  (mcpServer as any).registerTool = (
    name: string,
    config: any,
    handler: any,
  ) => {
    if (SKIP_PIGGYBACK.has(name) || !handler) {
      return original(name, config, handler);
    }

    const wrapped = async (...args: any[]) => {
      const result = await handler(...args);

      if (!getSession().agentToken) return result;

      try {
        const client = getAgentClient();
        const inbox = await client.inbox();

        const hasUnread =
          (inbox.unread_channels?.length ?? 0) > 0 ||
          (inbox.mentions?.length ?? 0) > 0 ||
          (inbox.unread_dms?.length ?? 0) > 0;

        if (hasUnread) {
          result.content.push({
            type: 'text' as const,
            text: formatInbox(inbox),
          });
        }
      } catch {
        // Silently ignore — never break the original tool response
      }

      return result;
    };

    return original(name, config, wrapped);
  };
}

function formatInbox(inbox: {
  unread_channels?: Array<{ channel_name: string; unread_count: number }>;
  mentions?: Array<{ agent_name: string; channel_name: string; text: string }>;
  unread_dms?: Array<{ from: string; unread_count: number }>;
}): string {
  const lines: string[] = ['--- Pending Messages ---'];

  if (inbox.unread_channels?.length) {
    lines.push('Unread channels:');
    for (const ch of inbox.unread_channels) {
      lines.push(`  #${ch.channel_name}: ${ch.unread_count} unread`);
    }
  }

  if (inbox.mentions?.length) {
    lines.push('Mentions:');
    for (const m of inbox.mentions) {
      lines.push(`  @${m.agent_name} in #${m.channel_name}: "${m.text}"`);
    }
  }

  if (inbox.unread_dms?.length) {
    lines.push('Unread DMs:');
    for (const dm of inbox.unread_dms) {
      lines.push(`  From ${dm.from}: ${dm.unread_count} unread`);
    }
  }

  return lines.join('\n');
}
