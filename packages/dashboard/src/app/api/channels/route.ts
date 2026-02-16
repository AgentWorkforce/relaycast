import { NextResponse } from 'next/server';
import { RelayError } from '@relaycast/sdk';
import { getRelayApiKey, getRelay } from '../../../lib/relay-api';

/**
 * GET /api/channels
 * Translates relaycast /v1/channels to the dashboard's expected format.
 */
export async function GET() {
  try {
    const apiKey = await getRelayApiKey();
    if (!apiKey) {
      return NextResponse.json(
        { success: false, channels: [], archivedChannels: [] },
        { status: 401 }
      );
    }

    const relay = getRelay(apiKey);
    const raw = await relay.channels.list({ include_archived: true });

    const channels = raw.filter((ch) => !ch.is_archived).map((ch) => ({
      id: ch.name ? `#${ch.name}` : ch.id,
      name: ch.name || ch.id,
      description: ch.topic || '',
      visibility: 'public',
      status: 'active',
      createdAt: ch.created_at || new Date().toISOString(),
      createdBy: ch.created_by || 'system',
      memberCount: ch.member_count || 0,
      unreadCount: 0,
      hasMentions: false,
      isDm: false,
    }));

    const archivedChannels = raw.filter((ch) => ch.is_archived).map((ch) => ({
      id: ch.name ? `#${ch.name}` : ch.id,
      name: ch.name || ch.id,
      description: ch.topic || '',
      visibility: 'public',
      status: 'archived',
      createdAt: ch.created_at || new Date().toISOString(),
      createdBy: ch.created_by || 'system',
      memberCount: ch.member_count || 0,
      unreadCount: 0,
      hasMentions: false,
      isDm: false,
    }));

    return NextResponse.json({ success: true, channels, archivedChannels });
  } catch (error) {
    if (error instanceof RelayError) {
      return NextResponse.json(
        { ok: false, error: { code: error.code, message: error.message } },
        { status: error.status }
      );
    }
    console.error('[api/channels] Error:', error);
    return NextResponse.json(
      { success: false, channels: [], archivedChannels: [] },
      { status: 500 }
    );
  }
}
