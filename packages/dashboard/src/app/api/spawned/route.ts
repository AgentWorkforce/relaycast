import { NextResponse } from 'next/server';
import { getRelayApiKey } from '../../../lib/relay-api';

/**
 * GET /api/spawned
 * Relaycast doesn't support spawning agents from the dashboard yet.
 * Returns an empty list but requires auth.
 */
export async function GET() {
  const apiKey = await getRelayApiKey();
  if (!apiKey) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }
  return NextResponse.json({ success: true, agents: [] });
}
