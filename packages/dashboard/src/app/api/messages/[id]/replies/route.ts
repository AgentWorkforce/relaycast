import { NextRequest, NextResponse } from 'next/server';
import { RelayError } from '@relaycast/sdk';
import { getRelayApiKey, getRelay } from '../../../../../lib/relay-api';

/**
 * GET /api/messages/:id/replies
 * Proxies to relaycast /v1/messages/:id/replies via SDK.
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
    const relay = getRelay(apiKey);

    const searchParams = request.nextUrl.searchParams;
    const opts: { limit?: number; before?: string; after?: string } = {};
    if (searchParams.get('limit')) opts.limit = Number(searchParams.get('limit'));
    if (searchParams.get('before')) opts.before = searchParams.get('before')!;
    if (searchParams.get('after')) opts.after = searchParams.get('after')!;

    const result = await relay.messages.thread(id, opts);
    return NextResponse.json({ ok: true, data: result });
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
