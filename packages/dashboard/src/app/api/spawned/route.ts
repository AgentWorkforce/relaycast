import { NextResponse } from 'next/server';

/**
 * GET /api/spawned
 * Stub — relaycast doesn't support spawning agents from the dashboard yet.
 */
export async function GET() {
  return NextResponse.json({ success: true, agents: [] });
}
