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
    const [agentResult, channelResult, dmResult] = await Promise.allSettled([
      relay.agents.list(),
      relay.channels.list(),
      relay.allDmConversations(),
    ]);

    const agentList = agentResult.status === 'fulfilled' ? agentResult.value : [];
    const channelList = channelResult.status === 'fulfilled' ? channelResult.value : [];
    const dmList = dmResult.status === 'fulfilled' ? dmResult.value : [];

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

    // Fetch DM messages for each conversation
    const dmPromises = dmList.slice(0, 10).map(async (dm) => {
      try {
        const dmName = dm.participants.join(', ');
        const msgs = await relay.dmMessages(dm.id, { limit: 50 });
        return msgs.map((m) => ({
          id: m.id,
          from: m.agent_name || agentNameById.get(m.agent_id) || 'unknown',
          to: `dm:${dmName}`,
          content: m.text || '',
          timestamp: m.created_at || new Date().toISOString(),
          thread: undefined,
          reactions: [] as Array<{ emoji: string; count: number; agents: string[] }>,
          replyCount: 0,
        }));
      } catch {
        return [];
      }
    });

    const [channelMessages, ...dmMessages] = await Promise.all([
      Promise.all(messagePromises),
      ...dmPromises,
    ]);
    let messages = [...channelMessages.flat(), ...dmMessages.flat()];

    // Fetch thread replies for messages that have them, so activity feed can show individual repliers
    const threaded = messages.filter((m) => m.replyCount > 0);
    if (threaded.length > 0) {
      const replyResults = await Promise.allSettled(
        threaded.slice(0, 20).map(async (m) => {
          const thread = await relay.messages.thread(m.id, { limit: 10 });
          return {
            id: m.id,
            replies: (thread.replies || []).map((r) => ({
              from:
                (r as Record<string, unknown>).agent_name as string ||
                agentNameById.get((r as Record<string, unknown>).agent_id as string) ||
                'unknown',
              timestamp: r.created_at || m.timestamp,
            })),
          };
        })
      );

      const replyMap = new Map<string, { from: string; timestamp: string }[]>();
      for (const result of replyResults) {
        if (result.status === 'fulfilled') {
          replyMap.set(result.value.id, result.value.replies);
        }
      }

      messages = messages.map((m) => {
        const replies = replyMap.get(m.id);
        return replies ? { ...m, replies } : m;
      });
    }

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
