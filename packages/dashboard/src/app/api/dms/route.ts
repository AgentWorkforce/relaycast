import { NextResponse } from 'next/server';
import { getRelayApiKey, getRelay } from '../../../lib/relay-api';

/**
 * GET /api/dms
 * Returns all DM conversations in the workspace.
 */
export async function GET() {
  try {
    const apiKey = await getRelayApiKey();
    if (!apiKey) {
      return NextResponse.json({ ok: true, conversations: [] });
    }

    const relay = getRelay(apiKey);
    const conversations = await relay.allDmConversations();

    return NextResponse.json({ ok: true, conversations });
  } catch (error) {
    console.error('[api/dms] Error:', error);
    return NextResponse.json({ ok: true, conversations: [] });
  }
}
