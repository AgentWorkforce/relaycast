import { NextRequest, NextResponse } from 'next/server';
import { RelayError } from '@relaycast/sdk';
import { getRelayApiKey, getRelay } from '../../../../../lib/relay-api';

/**
 * GET/POST /api/messages/:id/reactions
 * Proxies to relaycast /v1/messages/:id/reactions via SDK.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const apiKey = await getRelayApiKey();
    if (!apiKey) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { id } = await params;
    const relay = getRelay(apiKey);
    const agent = relay.as(apiKey);

    const result = await agent.reactions(id);
    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    if (error instanceof RelayError) {
      return NextResponse.json(
        { ok: false, error: { code: error.code, message: error.message } },
        { status: error.status }
      );
    }
    console.error('[api/reactions] GET error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const apiKey = await getRelayApiKey();
    if (!apiKey) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { id } = await params;
    const body = await request.json();
    const relay = getRelay(apiKey);
    const agent = relay.as(apiKey);

    const result = await agent.react(id, body.emoji);
    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    if (error instanceof RelayError) {
      return NextResponse.json(
        { ok: false, error: { code: error.code, message: error.message } },
        { status: error.status }
      );
    }
    console.error('[api/reactions] POST error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
