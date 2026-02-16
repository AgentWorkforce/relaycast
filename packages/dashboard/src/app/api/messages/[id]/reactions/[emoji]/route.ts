import { NextRequest, NextResponse } from 'next/server';
import { relayFetch } from '../../../../../../lib/relay-api';

/**
 * DELETE /api/messages/:id/reactions/:emoji
 * Proxies to relaycast /v1/messages/:id/reactions/:emoji with auth.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; emoji: string }> }
) {
  const { id, emoji } = await params;
  const res = await relayFetch(
    `/v1/messages/${encodeURIComponent(id)}/reactions/${encodeURIComponent(emoji)}`,
    { method: 'DELETE' }
  );
  const data = await res.json().catch(() => ({}));
  return NextResponse.json(data, { status: res.status });
}
