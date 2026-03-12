import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentClient } from '@relaycast/sdk';
import type { SessionState } from './types.js';
import type { McpTelemetry } from './telemetry.js';

const SKIP_PIGGYBACK = new Set([
  'inbox.check',
  'workspace.create',
  'workspace.set_key',
  'agent.register',
]);
const MESSAGE_TOOLS = new Set([
  'message.post',
  'message.reply',
  'dm.send',
  'dm.send_group',
  'webhook.trigger',
  'command.invoke',
]);

type ToolHandler = (...args: unknown[]) => unknown;
type RegisterToolFn = (
  name: string,
  config: unknown,
  handler: ToolHandler | undefined,
) => unknown;
type ContentCarrier = { content: Array<Record<string, unknown>> };

function hasContentArray(value: unknown): value is ContentCarrier {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

export function enablePiggyback(
  mcpServer: McpServer,
  getSession: () => SessionState,
  getAgentClient: () => AgentClient,
  telemetry?: McpTelemetry,
): void {
  const original = mcpServer.registerTool.bind(mcpServer) as RegisterToolFn;
  const mutableServer = mcpServer as unknown as { registerTool: RegisterToolFn };

  mutableServer.registerTool = (
    name: string,
    config: unknown,
    handler: ToolHandler | undefined,
  ) => {
    if (!handler) {
      return original(name, config, handler);
    }

    const shouldPiggybackInbox = !SKIP_PIGGYBACK.has(name);

    const wrapped = async (...args: unknown[]) => {
      const startedAt = Date.now();
      telemetry?.capture('relaycast_mcp_tool_invoked', {
        source_surface: 'mcp',
        tool_name: name,
      });

      let result: unknown;
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
      } else if (name === 'inbox.check') {
        telemetry?.capture('relaycast_inbox_checked', {
          source_surface: 'mcp',
          tool_name: name,
        });
      } else if (name === 'agent.register') {
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
          (inbox.unreadChannels?.length ?? 0) > 0 ||
          (inbox.mentions?.length ?? 0) > 0 ||
          (inbox.unreadDms?.length ?? 0) > 0 ||
          (inbox.recentReactions?.length ?? 0) > 0;

        console.error('[piggyback] inbox fetch ok — channels=%d mentions=%d dms=%d reactions=%d',
          inbox.unreadChannels?.length ?? 0,
          inbox.mentions?.length ?? 0,
          inbox.unreadDms?.length ?? 0,
          inbox.recentReactions?.length ?? 0,
        );

        if (hasUnread && hasContentArray(result)) {
          const selfName = getSession().agentName;
          const inboxText = formatInbox(inbox, selfName);
          if (inboxText) {
            result.content.push({
              type: 'text' as const,
              text: inboxText,
            });
          }
        }
      } catch (err) {
        console.error('[piggyback] inbox fetch failed — %s', err instanceof Error ? err.message : String(err));
      }

      return result;
    };

    return original(name, config, wrapped);
  };
}

function formatInbox(inbox: {
  unreadChannels?: Array<{ channelName: string; unreadCount: number }>;
  mentions?: Array<{ agentName: string; channelName: string; text: string }>;
  unreadDms?: Array<{ from: string; unreadCount: number }>;
  recentReactions?: Array<{ emoji: string; channelName: string; agentName: string }>;
}, selfName?: string | null): string {
  const norm = (s: string) => s.trim().replace(/^@/, '').toLowerCase();
  const selfNorm = selfName ? norm(selfName) : null;
  const isSelf = (name: string) => selfNorm != null && norm(name) === selfNorm;

  const lines: string[] = ['--- Pending Messages ---'];

  if (inbox.unreadChannels?.length) {
    lines.push('Unread channels:');
    for (const ch of inbox.unreadChannels) {
      lines.push(`  #${ch.channelName}: ${ch.unreadCount} unread`);
    }
  }

  const mentions = selfNorm
    ? inbox.mentions?.filter((m) => !isSelf(m.agentName))
    : inbox.mentions;
  if (mentions?.length) {
    lines.push('Mentions:');
    for (const m of mentions) {
      lines.push(`  @${m.agentName} in #${m.channelName}: "${m.text}"`);
    }
  }

  const dms = selfNorm
    ? inbox.unreadDms?.filter((dm) => !isSelf(dm.from))
    : inbox.unreadDms;
  if (dms?.length) {
    lines.push('Unread DMs:');
    for (const dm of dms) {
      lines.push(`  From ${dm.from}: ${dm.unreadCount} unread`);
    }
  }

  const rxns = selfNorm
    ? inbox.recentReactions?.filter((r) => !isSelf(r.agentName))
    : inbox.recentReactions;
  if (rxns?.length) {
    lines.push('Reactions (informational — no response required):');
    for (const r of rxns) {
      lines.push(`  :${r.emoji}: on your message in #${r.channelName} by @${r.agentName}`);
    }
  }

  if (lines.length === 1) return '';

  return lines.join('\n');
}
