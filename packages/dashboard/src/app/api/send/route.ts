import { NextRequest, NextResponse } from 'next/server';
import { RelayError } from '@relaycast/sdk';
import { getRelayApiKey, getRelay } from '../../../lib/relay-api';

/**
 * POST /api/send
 * Translates dashboard send format to relaycast /v1 API.
 * Dashboard sends: { to, message, from, thread, attachments }
 */
export async function POST(request: NextRequest) {
  try {
    const apiKey = await getRelayApiKey();
    if (!apiKey) {
      return NextResponse.json(
        { success: false, error: 'Not authenticated' },
        { status: 401 }
      );
    }

    const body = await request.json();
    const { to, message } = body;

    if (!to || !message) {
      return NextResponse.json(
        { success: false, error: 'Missing to or message' },
        { status: 400 }
      );
    }

    const relay = getRelay(apiKey);
    const agent = relay.as(apiKey);

    if (to.startsWith('#')) {
      const channelName = to.slice(1);
      const result = await agent.send(channelName, message);
      return NextResponse.json({ success: true, messageId: result.id });
    }

    // Direct message to an agent
    const result = await agent.dm(to, message);
    const messageId = result && typeof result === 'object' && 'id' in result
      ? (result as { id: string }).id
      : undefined;
    return NextResponse.json({ success: true, messageId });
  } catch (error) {
    if (error instanceof RelayError) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: error.status }
      );
    }
    console.error('[api/send] Error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal error' },
      { status: 500 }
    );
  }
}
