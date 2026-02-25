import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { RelayCast } from '@relaycast/sdk';
import type { DmConversationSummary } from '@relaycast/sdk';
import { resolveRelayServerUrlFromRequest } from '../../../lib/relay-server';

export const runtime = 'edge';

/**
 * GET /api/dms
 * Lists all DM conversations using the workspace API key.
 * The observer agent isn't a participant in DMs, so we need workspace-level access.
 */
export async function GET(request: NextRequest) {
  const cookieStore = await cookies();
  const apiKey = cookieStore.get('relaycast_key')?.value;
  if (!apiKey) {
    return NextResponse.json({ conversations: [] }, { status: 401 });
  }

  try {
    const relay = new RelayCast({
      apiKey,
      baseUrl: resolveRelayServerUrlFromRequest(request),
    });
    const raw = await relay.allDmConversations();

    // Map workspace-level DM data to DmConversationSummary shape
    const conversations: DmConversationSummary[] = raw
      .filter((dm) => !dm.participants.every((p) => p.startsWith('_dashboard_')))
      .map((dm) => ({
        id: dm.id,
        type: dm.type as '1:1' | 'group',
        name: dm.type === 'group' ? null : dm.participants[0] ?? null,
        participants: dm.participants.map((agentName) => ({
          agentId: '',
          agentName,
        })),
        lastMessage: dm.lastMessage
          ? {
              id: `${dm.id}:${dm.lastMessage.createdAt}`,
              text: dm.lastMessage.text,
              agentId: '',
              createdAt: dm.lastMessage.createdAt,
            }
          : null,
        unreadCount: 0,
        createdAt: dm.lastMessage?.createdAt ?? new Date().toISOString(),
      }));

    return NextResponse.json({ conversations });
  } catch (error) {
    console.error('[api/dms] Error:', error);
    return NextResponse.json({ conversations: [] });
  }
}
