import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { RelayCast } from '@relaycast/sdk';
import type { ActivityEvent } from '../../../types/dashboard';
import { resolveRelayServerUrlFromRequest } from '../../../lib/relay-server';

export const runtime = 'edge';

/**
 * GET /api/activity
 * Builds a full workspace activity feed using the workspace API key.
 * Sees everything: all channels, DMs, reactions, threads — not limited
 * to the observer agent's channel memberships.
 *
 */
export async function GET(request: NextRequest) {
  const cookieStore = await cookies();
  const apiKey = cookieStore.get('relaycast_key')?.value;
  if (!apiKey) {
    return NextResponse.json({ events: [] }, { status: 401 });
  }

  try {
    const relay = new RelayCast({
      apiKey,
      baseUrl: resolveRelayServerUrlFromRequest(request),
    });

    const [agentResult, presenceResult, channelResult, dmResult] = await Promise.allSettled([
      relay.agents.list(),
      relay.agents.presence(),
      relay.channels.list(),
      relay.allDmConversations(),
    ]);

    const agentList = agentResult.status === 'fulfilled' ? agentResult.value : [];
    const presenceList = presenceResult.status === 'fulfilled' ? presenceResult.value : [];
    const channelList = channelResult.status === 'fulfilled' ? channelResult.value : [];
    const dmList = dmResult.status === 'fulfilled' ? dmResult.value : [];

    // Use PresenceDO as source of truth for current online/offline state.
    const presenceByName = new Map<string, 'online' | 'offline'>();
    for (const p of presenceList) {
      presenceByName.set(p.agentName, p.status);
    }

    // Build agent_id → name lookup
    const agentNameById = new Map<string, string>();
    for (const a of agentList) {
      agentNameById.set(a.id, a.name);
    }

    const events: ActivityEvent[] = [];

    // Agent presence events
    for (const agent of agentList) {
      if (agent.name.startsWith('_dashboard_')) continue;
      const currentStatus = presenceByName.get(agent.name) ?? agent.status;
      events.push({
        id: `conn-${agent.name}`,
        type: currentStatus === 'online' ? 'connection' : 'agent_idle',
        summary: `${agent.name} is ${currentStatus}`,
        timestamp: agent.lastSeen,
        agent: agent.name,
      });
    }

    // Channel message events (fetch recent from each channel)
    const msgPromises = channelList.slice(0, 15).map(async (ch) => {
      try {
        const msgs = await relay.messages.list(ch.name, { limit: 30 });
        for (const m of msgs) {
          const fromName = m.agentName || agentNameById.get(m.agentId) || 'unknown';

          events.push({
            id: `msg-${m.id}`,
            type: 'message_sent',
            summary: `${fromName} sent a message in #${ch.name}`,
            timestamp: m.createdAt || new Date().toISOString(),
            agent: fromName,
          });

          // Reaction events
          for (const reaction of m.reactions || []) {
            const rAgents = Array.isArray(reaction.agents) ? reaction.agents : [];
            if (rAgents.length > 0) {
              for (const rAgent of rAgents) {
                events.push({
                  id: `react-${m.id}-${reaction.emoji}-${rAgent}`,
                  type: 'reaction',
                  summary: `${rAgent} reacted ${reaction.emoji} to ${fromName}'s message`,
                  timestamp: m.createdAt || new Date().toISOString(),
                  agent: rAgent,
                });
              }
            }
          }

          // Thread reply indicator
          if (m.replyCount > 0) {
            events.push({
              id: `reply-${m.id}`,
              type: 'thread_reply',
              summary: `${m.replyCount} ${m.replyCount === 1 ? 'reply' : 'replies'} in ${fromName}'s thread`,
              timestamp: m.createdAt || new Date().toISOString(),
              agent: fromName,
            });
          }
        }
      } catch {
        // Skip channels that error
      }
    });

    // DM message events
    const dmPromises = dmList.slice(0, 10).map(async (dm) => {
      try {
        const dmName = dm.participants.join(', ');
        const msgs = await relay.dmMessages(dm.id, { limit: 20 });
        for (const m of msgs) {
          const fromName = m.agentName || agentNameById.get(m.agentId) || 'unknown';
          if (fromName.startsWith('_dashboard_')) continue;
          events.push({
            id: `dm-${m.id}`,
            type: 'message_sent',
            summary: `${fromName} sent a DM to ${dmName}`,
            timestamp: m.createdAt || new Date().toISOString(),
            agent: fromName,
          });
        }
      } catch {
        // Skip DMs that error
      }
    });

    await Promise.all([...msgPromises, ...dmPromises]);

    // Sort chronologically (oldest first) and cap
    events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    return NextResponse.json({ events: events.slice(-200) });
  } catch (error) {
    console.error('[api/activity] Error:', error);
    return NextResponse.json({ events: [] });
  }
}
