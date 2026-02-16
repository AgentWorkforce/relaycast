import { NextRequest, NextResponse } from 'next/server';
import { RelayError } from '@relaycast/sdk';
import { getRelayApiKey, getRelay } from '../../../../../../lib/relay-api';

/**
 * DELETE /api/messages/:id/reactions/:emoji
 * Proxies to relaycast /v1/messages/:id/reactions/:emoji via SDK.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; emoji: string }> }
) {
  try {
    const apiKey = await getRelayApiKey();
    if (!apiKey) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { id, emoji } = await params;
    const relay = getRelay(apiKey);
    const agent = relay.as(apiKey);

    await agent.unreact(id, emoji);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof RelayError) {
      return NextResponse.json(
        { ok: false, error: { code: error.code, message: error.message } },
        { status: error.status }
      );
    }
    console.error('[api/reactions] DELETE error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
