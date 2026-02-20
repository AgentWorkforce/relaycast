import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

export const runtime = 'edge';

/**
 * GET /api/spawned
 * Relaycast doesn't support spawning agents from the dashboard yet.
 * Returns an empty list but requires auth.
 */
export async function GET() {
  const cookieStore = await cookies();
  const apiKey = cookieStore.get('relaycast_key')?.value;
  if (!apiKey) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }
  return NextResponse.json({ success: true, agents: [] });
}
