import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { RelayCast } from '@relaycast/sdk';
import type { DmConversationSummary } from '@relaycast/types';

const RELAY_SERVER = process.env.RELAY_SERVER_URL || 'http://localhost:3890';

/**
 * GET /api/dms
 * Lists all DM conversations using the workspace API key.
 * The observer agent isn't a participant in DMs, so we need workspace-level access.
 */
export async function GET() {
  const cookieStore = await cookies();
  const apiKey = cookieStore.get('relaycast_key')?.value;
  if (!apiKey) {
    return NextResponse.json({ conversations: [] }, { status: 401 });
  }

  try {
    const relay = new RelayCast({ apiKey, baseUrl: RELAY_SERVER });
    const raw = await relay.allDmConversations();

    // Map workspace-level DM data to DmConversationSummary shape
    const conversations: DmConversationSummary[] = raw
      .filter((dm) => !dm.participants.every((p) => p.startsWith('_dashboard_')))
      .map((dm) => ({
        id: dm.id,
        type: dm.type as '1:1' | 'group',
        name: dm.participants.join(', '),
        participants: dm.participants,
        last_message: dm.last_message?.text ?? null,
        unread_count: 0,
      }));

    return NextResponse.json({ conversations });
  } catch (error) {
    console.error('[api/dms] Error:', error);
    return NextResponse.json({ conversations: [] });
  }
}
