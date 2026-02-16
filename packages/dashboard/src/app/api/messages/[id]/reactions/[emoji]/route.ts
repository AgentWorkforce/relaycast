import { NextRequest, NextResponse } from 'next/server';
import { RelayError } from '@relaycast/sdk';
import { getRelayApiKey, relayFetch } from '../../../../../../lib/relay-api';

/**
 * DELETE /api/messages/:id/reactions/:emoji
 * Proxies to relaycast /v1/messages/:id/reactions/:emoji via relayFetch.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; emoji: string }> }
) {
  try {
    const apiKey = await getRelayApiKey();
    if (!apiKey) {
      return NextResponse.json(
        { ok: false, error: { code: 'unauthorized', message: 'Not authenticated' } },
        { status: 401 }
      );
    }

    const { id, emoji } = await params;

    // Use relayFetch for write operations that require agent token
    const res = await relayFetch(
      `/v1/messages/${encodeURIComponent(id)}/reactions/${encodeURIComponent(emoji)}`,
      { method: 'DELETE' }
    );

    if (res.ok) {
      return NextResponse.json({ ok: true });
    }

    const error = await res.json().catch(() => ({ error: { code: 'unknown_error', message: 'Failed to remove reaction' } }));
    return NextResponse.json(
      { ok: false, error: { code: error?.error?.code || 'unknown_error', message: error?.error?.message || 'Failed to remove reaction' } },
      { status: res.status }
    );
  } catch (error) {
    if (error instanceof RelayError) {
      return NextResponse.json(
        { ok: false, error: { code: error.code, message: error.message } },
        { status: error.status }
      );
    }
    console.error('[api/reactions] DELETE error:', error);
    return NextResponse.json(
      { ok: false, error: { code: 'internal_error', message: 'Internal server error' } },
      { status: 500 }
    );
  }
}
