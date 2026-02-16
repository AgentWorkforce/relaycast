import { NextRequest, NextResponse } from 'next/server';
import { relayFetch, getRelayApiKey } from '../../../lib/relay-api';

/**
 * POST /api/send
 * Translates dashboard send format to relaycast /v1 API.
 * Dashboard sends: { to, message, from, thread, attachments }
 * 
 * Note: This endpoint requires an agent token on the server side.
 * We use relayFetch with the workspace key which the server will accept.
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
    const { to, message, from, thread } = body;

    if (!to || !message) {
      return NextResponse.json(
        { success: false, error: 'Missing to or message' },
        { status: 400 }
      );
    }

    // If "to" starts with #, it's a channel message
    if (to.startsWith('#')) {
      const channelName = to.slice(1);
      const res = await relayFetch(
        `/v1/channels/${encodeURIComponent(channelName)}/messages`,
        {
          method: 'POST',
          body: JSON.stringify({
            text: message,
            from: from || 'dashboard',
            thread_id: thread,
          }),
        }
      );

      if (res.ok) {
        const data = await res.json();
        return NextResponse.json({
          success: true,
          messageId: data.data?.id || data.id,
        });
      }

      const error = await res.json().catch(() => ({ error: { message: 'Send failed' } }));
      const errorMsg = error?.error?.message || error?.message || 'Failed to send';
      return NextResponse.json(
        { success: false, error: errorMsg },
        { status: res.status }
      );
    }

    // Direct message to an agent
    const res = await relayFetch('/v1/dm', {
      method: 'POST',
      body: JSON.stringify({
        to,
        text: message,
        from: from || 'dashboard',
        thread_id: thread,
      }),
    });

    if (res.ok) {
      const data = await res.json();
      return NextResponse.json({
        success: true,
        messageId: data.data?.id || data.id,
      });
    }

    const error = await res.json().catch(() => ({ error: { message: 'Send failed' } }));
    const errorMsg = error?.error?.message || error?.message || 'Failed to send';
    return NextResponse.json(
      { success: false, error: errorMsg },
      { status: res.status }
    );
  } catch (error) {
    console.error('[api/send] Error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
