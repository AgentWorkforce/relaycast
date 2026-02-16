import { NextRequest, NextResponse } from 'next/server';
import { RelayError } from '@relaycast/sdk';
import { getRelayApiKey, relayFetch } from '../../../../../lib/relay-api';

/**
 * GET/POST /api/messages/:id/reactions
 * Proxies to relaycast /v1/messages/:id/reactions via SDK (GET) and relayFetch (POST).
 */
export async function GET(
  _request: NextRequest,
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

    // Use relayFetch for reading reactions
    const res = await relayFetch(`/v1/messages/${encodeURIComponent(id)}/reactions`);
    if (res.ok) {
      const data = await res.json();
      return NextResponse.json({ ok: true, data: data.data || data });
    }

    const error = await res.json().catch(() => ({ error: { code: 'unknown_error', message: 'Failed to get reactions' } }));
    return NextResponse.json(
      { ok: false, error: { code: error?.error?.code || 'unknown_error', message: error?.error?.message || 'Failed to get reactions' } },
      { status: res.status }
    );
  } catch (error) {
    if (error instanceof RelayError) {
      return NextResponse.json(
        { ok: false, error: { code: error.code, message: error.message } },
        { status: error.status }
      );
    }
    console.error('[api/reactions] GET error:', error);
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
    const res = await relayFetch(`/v1/messages/${encodeURIComponent(id)}/reactions`, {
      method: 'POST',
      body: JSON.stringify({ emoji: body.emoji }),
    });

    if (res.ok) {
      const data = await res.json();
      return NextResponse.json({ ok: true, data: data.data || data });
    }

    const error = await res.json().catch(() => ({ error: { code: 'unknown_error', message: 'Failed to add reaction' } }));
    return NextResponse.json(
      { ok: false, error: { code: error?.error?.code || 'unknown_error', message: error?.error?.message || 'Failed to add reaction' } },
      { status: res.status }
    );
  } catch (error) {
    if (error instanceof RelayError) {
      return NextResponse.json(
        { ok: false, error: { code: error.code, message: error.message } },
        { status: error.status }
      );
    }
    console.error('[api/reactions] POST error:', error);
    return NextResponse.json(
      { ok: false, error: { code: 'internal_error', message: 'Internal server error' } },
      { status: 500 }
    );
  }
}
