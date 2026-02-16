import { NextRequest, NextResponse } from 'next/server';
import { relayFetch } from '../../../../../lib/relay-api';

/**
 * GET/POST /api/messages/:id/reactions
 * Proxies to relaycast /v1/messages/:id/reactions with auth.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const res = await relayFetch(`/v1/messages/${encodeURIComponent(id)}/reactions`);
    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  } catch (error) {
    console.error('[api/reactions] GET error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const res = await relayFetch(
      `/v1/messages/${encodeURIComponent(id)}/reactions`,
      { method: 'POST', body: JSON.stringify(body) }
    );
    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  } catch (error) {
    console.error('[api/reactions] POST error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
