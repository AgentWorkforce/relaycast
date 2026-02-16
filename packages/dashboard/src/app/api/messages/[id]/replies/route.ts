import { NextRequest, NextResponse } from 'next/server';
import { RelayError } from '@relaycast/sdk';
import { getRelayApiKey, relayFetch } from '../../../../../lib/relay-api';

/**
 * GET/POST /api/messages/:id/replies
 * Proxies to relaycast /v1/messages/:id/replies via SDK (GET) and relayFetch (POST).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const apiKey = await getRelayApiKey();
    if (!apiKey) {
      return NextResponse.json(
        { ok: false, error: { code: 'unauthorized', message: 'Not authenticated' } },
        { status: 401 }
      );
    }

    const { id } = await params;

    const searchParams = request.nextUrl.searchParams;
    const query: Record<string, string> = {};
    if (searchParams.get('limit')) query.limit = searchParams.get('limit')!;
    if (searchParams.get('before')) query.before = searchParams.get('before')!;
    if (searchParams.get('after')) query.after = searchParams.get('after')!;

    // Use relayFetch to get thread replies
    const queryString = new URLSearchParams(query).toString();
    const path = `/v1/messages/${encodeURIComponent(id)}/replies${queryString ? `?${queryString}` : ''}`;
    const res = await relayFetch(path);

    if (res.ok) {
      const data = await res.json();
      return NextResponse.json({ ok: true, data: data.data || data });
    }

    const error = await res.json().catch(() => ({ error: { code: 'unknown_error', message: 'Failed to get replies' } }));
    return NextResponse.json(
      { ok: false, error: { code: error?.error?.code || 'unknown_error', message: error?.error?.message || 'Failed to get replies' } },
      { status: res.status }
    );
  } catch (error) {
    if (error instanceof RelayError) {
      return NextResponse.json(
        { ok: false, error: { code: error.code, message: error.message } },
        { status: error.status }
      );
    }
    console.error('[api/replies] GET error:', error);
    return NextResponse.json(
      { ok: false, error: { code: 'internal_error', message: 'Internal server error' } },
      { status: 500 }
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const apiKey = await getRelayApiKey();
    if (!apiKey) {
      return NextResponse.json(
        { ok: false, error: { code: 'unauthorized', message: 'Not authenticated' } },
        { status: 401 }
      );
    }

    const { id } = await params;
    const body = await request.json();

    // Use relayFetch for write operations that require agent token
    const res = await relayFetch(`/v1/messages/${encodeURIComponent(id)}/replies`, {
      method: 'POST',
      body: JSON.stringify({ text: body.text }),
    });

    if (res.ok) {
      const data = await res.json();
      return NextResponse.json({ ok: true, data: data.data || data });
    }

    const error = await res.json().catch(() => ({ error: { code: 'unknown_error', message: 'Failed to post reply' } }));
    return NextResponse.json(
      { ok: false, error: { code: error?.error?.code || 'unknown_error', message: error?.error?.message || 'Failed to post reply' } },
      { status: res.status }
    );
  } catch (error) {
    console.error('[api/replies] POST error:', error);
    return NextResponse.json(
      { ok: false, error: { code: 'internal_error', message: 'Internal server error' } },
      { status: 500 }
    );
  }
}
