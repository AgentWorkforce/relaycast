import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { RelayCast, RelayError } from '@relaycast/sdk';
import { resolveRelayServerUrlFromRequest } from '../../../lib/relay-server';

export const runtime = 'edge';

/**
 * GET /api/bridge
 * Constructs the multi-project view from relaycast agents and channels.
 */
export async function GET(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const apiKey = cookieStore.get('relaycast_key')?.value;
    if (!apiKey) {
      return NextResponse.json(
        { projects: [], messages: [], connected: false },
        { status: 401 }
      );
    }

    const relay = new RelayCast({
      apiKey,
      baseUrl: resolveRelayServerUrlFromRequest(request),
    });
    const [agentList, channelList] = await Promise.allSettled([
      relay.agents.list(),
      relay.channels.list(),
    ]);

    const agents = agentList.status === 'fulfilled'
      ? agentList.value.map((a) => ({
          name: a.name,
          status: a.status || 'online',
          cli: (a.metadata?.cli as string) || 'unknown',
          currentTask: (a.metadata?.current_task as string) || '',
          lastSeen: a.lastSeen || new Date().toISOString(),
        }))
      : [];

    const channels = channelList.status === 'fulfilled'
      ? channelList.value.map((ch) => ({
          id: ch.name ? `#${ch.name}` : ch.id,
          name: ch.name || ch.id,
          description: ch.topic || '',
          memberCount: ch.memberCount || 0,
        }))
      : [];

    const connected = agentList.status === 'fulfilled' || channelList.status === 'fulfilled';

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
      connected,
      channels,
    });
  } catch (error) {
    if (error instanceof RelayError) {
      return NextResponse.json(
        { ok: false, error: { code: error.code, message: error.message } },
        { status: error.status }
      );
    }
    console.error('[api/bridge] Error:', error);
    return NextResponse.json(
      { projects: [], messages: [], connected: false },
      { status: 500 }
    );
  }
}
