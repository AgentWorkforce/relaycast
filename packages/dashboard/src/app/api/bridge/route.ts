import { NextResponse } from 'next/server';
import { relayFetch } from '../../../lib/relay-api';

/**
 * GET /api/bridge
 * Constructs the multi-project view from relaycast agents and channels.
 */
export async function GET() {
  try {
    const [agentsRes, channelsRes] = await Promise.all([
      relayFetch('/v1/agents'),
      relayFetch('/v1/channels'),
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let agents: any[] = [];
    if (agentsRes.ok) {
      const data = await agentsRes.json();
      agents = (data.data || data.agents || []).map(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (a: any) => ({
          name: a.name,
          status: a.status || 'online',
          cli: a.cli || 'unknown',
          currentTask: a.current_task || a.currentTask || '',
          lastSeen: a.last_seen_at || a.lastSeen || new Date().toISOString(),
        })
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let channels: any[] = [];
    if (channelsRes.ok) {
      const data = await channelsRes.json();
      channels = data.data || data.channels || [];
    }

    // Build a single project representing the workspace
    return NextResponse.json({
      projects: [
        {
          id: 'relaycast-workspace',
          name: 'Workspace',
          path: '/',
          agents,
        },
      ],
      messages: [],
      connected: true,
      channels: channels.map(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (ch: any) => ({
          id: ch.name ? `#${ch.name}` : ch.id,
          name: ch.name || ch.id,
          description: ch.description || ch.topic || '',
          memberCount: ch.member_count || ch.memberCount || 0,
        })
      ),
    });
  } catch (error) {
    console.error('[api/bridge] Error:', error);
    return NextResponse.json(
      { projects: [], messages: [], connected: false },
      { status: 500 }
    );
  }
}
