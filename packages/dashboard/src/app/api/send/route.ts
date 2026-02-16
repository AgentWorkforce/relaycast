import { NextRequest, NextResponse } from 'next/server';
import { relayFetch } from '../../../lib/relay-api';

/**
 * POST /api/send
 * Translates dashboard send format to relaycast /v1 API.
 * Dashboard sends: { to, message, from, thread, attachments }
 * Relaycast expects: POST /v1/channels/:name/messages { content } or POST /v1/dm { to, content }
 */
export async function POST(request: NextRequest) {
  try {
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
            content: message,
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

      const error = await res.json().catch(() => ({ message: 'Send failed' }));
      return NextResponse.json(
        { success: false, error: error.message || 'Failed to send' },
        { status: res.status }
      );
    }

    // Direct message to an agent
    const res = await relayFetch('/v1/dm', {
      method: 'POST',
      body: JSON.stringify({
        to,
        content: message,
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

    const error = await res.json().catch(() => ({ message: 'Send failed' }));
    return NextResponse.json(
      { success: false, error: error.message || 'Failed to send' },
      { status: res.status }
    );
  } catch (error) {
    console.error('[api/send] Error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal error' },
      { status: 500 }
    );
  }
}
