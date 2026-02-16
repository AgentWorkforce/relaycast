import { NextRequest, NextResponse } from 'next/server';
import { relayFetch } from '../../../../../lib/relay-api';

/**
 * GET/POST /api/messages/:id/replies
 * Proxies to relaycast /v1/messages/:id/replies with auth.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const searchParams = request.nextUrl.searchParams.toString();
    const qs = searchParams ? `?${searchParams}` : '';
    const res = await relayFetch(
      `/v1/messages/${encodeURIComponent(id)}/replies${qs}`
    );
    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  } catch (error) {
    console.error('[api/replies] GET error:', error);
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
      `/v1/messages/${encodeURIComponent(id)}/replies`,
      { method: 'POST', body: JSON.stringify(body) }
    );
    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  } catch (error) {
    console.error('[api/replies] POST error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
