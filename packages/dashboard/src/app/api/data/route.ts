import { NextResponse } from 'next/server';
import { RelayError } from '@relaycast/sdk';
import { getRelayApiKey, getRelay } from '../../../lib/relay-api';

/**
 * GET /api/data
 * Aggregates agents and recent messages from the relaycast /v1 API.
 */
export async function GET() {
  try {
    const apiKey = await getRelayApiKey();
    if (!apiKey) {
      return NextResponse.json({ agents: [], messages: [], sessions: [] });
    }

    const relay = getRelay(apiKey);
    const [agentResult, channelResult] = await Promise.allSettled([
      relay.agents.list(),
      relay.channels.list(),
    ]);

    const agentList = agentResult.status === 'fulfilled' ? agentResult.value : [];
    const channelList = channelResult.status === 'fulfilled' ? channelResult.value : [];

    const agents = agentList.map((a) => ({
      name: a.name,
      status: a.status || 'online',
      type: a.type || 'agent',
      cli: (a.metadata?.cli as string) || 'unknown',
      currentTask: (a.metadata?.current_task as string) || '',
      persona: a.persona || null,
      metadata: a.metadata || {},
      lastSeen: a.last_seen || new Date().toISOString(),
      createdAt: a.created_at || new Date().toISOString(),
    }));

    // Build agent_id → name lookup from agent list
    const agentNameById = new Map<string, string>();
    for (const a of agentList) {
      agentNameById.set(a.id, a.name);
    }

    // Fetch recent messages from each channel
    const messagePromises = channelList.slice(0, 10).map(async (ch) => {
      try {
        const msgs = await relay.messages.list(ch.name, { limit: 50 });
        return msgs.map((m) => {
          // The API may return agent_name or only agent_id — resolve to a name
          const fromName =
            (m as Record<string, unknown>).agent_name as string ||
            agentNameById.get((m as Record<string, unknown>).agent_id as string) ||
            'unknown';
          return {
            id: m.id,
            from: fromName,
            to: `#${ch.name}`,
            content: m.text || '',
            timestamp: m.created_at || new Date().toISOString(),
            thread: undefined,
            reactions: m.reactions || [],
            replyCount: m.reply_count || 0,
          };
        });
      } catch {
        return [];
      }
    });

    const channelMessages = await Promise.all(messagePromises);
    const messages = channelMessages.flat();

    return NextResponse.json({ agents, messages, sessions: [] });
  } catch (error) {
    if (error instanceof RelayError) {
      console.error('[api/data] RelayError:', error.code, error.message);
    } else {
      console.error('[api/data] Error:', error);
    }
    return NextResponse.json({ agents: [], messages: [], sessions: [] });
  }
}
