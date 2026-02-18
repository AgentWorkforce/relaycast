import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { RelayCast } from '@relaycast/sdk';

const RELAY_SERVER = process.env.RELAY_SERVER_URL || 'http://localhost:3890';

/**
 * GET /api/dms/:id/messages
 * Fetches messages for a DM conversation using the workspace API key.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const cookieStore = await cookies();
  const apiKey = cookieStore.get('relaycast_key')?.value;
  if (!apiKey) {
    return NextResponse.json({ messages: [] }, { status: 401 });
  }

  try {
    const relay = new RelayCast({ apiKey, baseUrl: RELAY_SERVER });
    const messages = await relay.dmMessages(id, { limit: 50 });
    return NextResponse.json({ messages });
  } catch (error) {
    console.error('[api/dms/messages] Error:', error);
    return NextResponse.json({ messages: [] });
  }
}
