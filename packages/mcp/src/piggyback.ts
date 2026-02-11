import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentClient } from '@relaycast/sdk';
import type { SessionState } from './types.js';
import type { McpTelemetry } from './telemetry.js';

const SKIP_PIGGYBACK = new Set([
  'check_inbox',
  'create_workspace',
  'set_workspace_key',
  'register',
]);
const MESSAGE_TOOLS = new Set([
  'post_message',
  'reply_to_thread',
  'send_dm',
  'send_group_dm',
  'trigger_webhook',
  'invoke_command',
]);

export function enablePiggyback(
  mcpServer: McpServer,
  getSession: () => SessionState,
  getAgentClient: () => AgentClient,
  telemetry?: McpTelemetry,
): void {
  const original = mcpServer.registerTool.bind(mcpServer);

  (mcpServer as any).registerTool = (
    name: string,
    config: any,
    handler: any,
  ) => {
    if (!handler) {
      return original(name, config, handler);
    }

    const shouldPiggybackInbox = !SKIP_PIGGYBACK.has(name);

    const wrapped = async (...args: any[]) => {
      const startedAt = Date.now();
      telemetry?.capture('relaycast_mcp_tool_invoked', {
        source_surface: 'mcp',
        tool_name: name,
      });

      let result: any;
      try {
        result = await handler(...args);
      } catch (error) {
        telemetry?.capture('relaycast_mcp_tool_failed', {
          source_surface: 'mcp',
          tool_name: name,
          duration_ms: Math.max(Date.now() - startedAt, 0),
          error_name: error instanceof Error ? error.name : 'UnknownError',
        });
        throw error;
      }

      telemetry?.capture('relaycast_mcp_tool_completed', {
        source_surface: 'mcp',
        tool_name: name,
        duration_ms: Math.max(Date.now() - startedAt, 0),
      });

      if (MESSAGE_TOOLS.has(name)) {
        telemetry?.capture('relaycast_message_sent', {
          source_surface: 'mcp',
          tool_name: name,
          message_kind: name,
        });
      } else if (name === 'check_inbox') {
        telemetry?.capture('relaycast_inbox_checked', {
          source_surface: 'mcp',
          tool_name: name,
        });
      } else if (name === 'register') {
        telemetry?.capture('relaycast_agent_registered', {
          source_surface: 'mcp',
          tool_name: name,
        });
      }

      if (!shouldPiggybackInbox || !getSession().agentToken) return result;

      try {
        const client = getAgentClient();
        const inbox = await client.inbox();

        const hasUnread =
          (inbox.unread_channels?.length ?? 0) > 0 ||
          (inbox.mentions?.length ?? 0) > 0 ||
          (inbox.unread_dms?.length ?? 0) > 0;

        if (hasUnread && Array.isArray(result?.content)) {
          const selfName = getSession().agentName;
          const inboxText = formatInbox(inbox, selfName);
          if (inboxText) {
            result.content.push({
              type: 'text' as const,
              text: inboxText,
            });
          }
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
}, selfName?: string | null): string {
  const norm = (s: string) => s.trim().replace(/^@/, '').toLowerCase();
  const selfNorm = selfName ? norm(selfName) : null;
  const isSelf = (name: string) => selfNorm != null && norm(name) === selfNorm;

  const lines: string[] = ['--- Pending Messages ---'];

  if (inbox.unread_channels?.length) {
    lines.push('Unread channels:');
    for (const ch of inbox.unread_channels) {
      lines.push(`  #${ch.channel_name}: ${ch.unread_count} unread`);
    }
  }

  const mentions = selfNorm
    ? inbox.mentions?.filter((m) => !isSelf(m.agent_name))
    : inbox.mentions;
  if (mentions?.length) {
    lines.push('Mentions:');
    for (const m of mentions) {
      lines.push(`  @${m.agent_name} in #${m.channel_name}: "${m.text}"`);
    }
  }

  const dms = selfNorm
    ? inbox.unread_dms?.filter((dm) => !isSelf(dm.from))
    : inbox.unread_dms;
  if (dms?.length) {
    lines.push('Unread DMs:');
    for (const dm of dms) {
      lines.push(`  From ${dm.from}: ${dm.unread_count} unread`);
    }
  }

  if (lines.length === 1) return '';

  return lines.join('\n');
}
