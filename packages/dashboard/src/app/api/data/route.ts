import { NextResponse } from 'next/server';
import { relayFetch } from '../../../lib/relay-api';

/**
 * GET /api/data
 * Aggregates agents and recent messages from the relaycast /v1 API
 * into the format the dashboard App component expects.
 */
export async function GET() {
  try {
    const [agentsRes, channelsRes] = await Promise.all([
      relayFetch('/v1/agents'),
      relayFetch('/v1/channels'),
    ]);

    if (!agentsRes.ok) {
      return NextResponse.json(
        { agents: [], messages: [], sessions: [] },
        { status: agentsRes.status }
      );
    }

    const agentsData = await agentsRes.json();
    const agents = (agentsData.data || agentsData.agents || []).map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (a: any) => ({
        name: a.name,
        status: a.status || 'online',
        cli: a.cli || 'unknown',
        currentTask: a.current_task || a.currentTask || '',
        lastSeen: a.last_seen_at || a.lastSeen || new Date().toISOString(),
      })
    );

    // Fetch recent messages from each channel
    let messages: unknown[] = [];
    if (channelsRes.ok) {
      const channelsData = await channelsRes.json();
      const channels = channelsData.data || channelsData.channels || [];

      const messagePromises = channels.slice(0, 10).map(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async (ch: any) => {
          const name = ch.name || ch.id;
          try {
            const res = await relayFetch(
              `/v1/channels/${encodeURIComponent(name)}/messages?limit=50`
            );
            if (res.ok) {
              const data = await res.json();
              return (data.data || data.messages || []).map(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (m: any) => ({
                  id: m.id,
                  from: m.from || m.agent_name || 'unknown',
                  to: m.to || m.channel || name,
                  content: m.content || m.body || '',
                  timestamp: m.created_at || m.timestamp || new Date().toISOString(),
                  thread: m.thread_id || m.thread,
                  reactions: m.reactions || [],
                  replyCount: m.reply_count || m.replyCount || 0,
                })
              );
            }
          } catch {
            // Skip channels that fail
          }
          return [];
        }
      );

      const channelMessages = await Promise.all(messagePromises);
      messages = channelMessages.flat();
    }

    return NextResponse.json({ agents, messages, sessions: [] });
  } catch (error) {
    console.error('[api/data] Error:', error);
    return NextResponse.json(
      { agents: [], messages: [], sessions: [] },
      { status: 500 }
    );
  }
}
