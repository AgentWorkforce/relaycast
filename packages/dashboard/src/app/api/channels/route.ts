import { NextResponse } from 'next/server';
import { RelayError } from '@relaycast/sdk';
import { getRelayApiKey, getRelay } from '../../../lib/relay-api';

/**
 * GET /api/channels
 * Translates relaycast /v1/channels to the dashboard's expected format.
 * Also includes DM conversations as isDm channels.
 */
export async function GET() {
  try {
    const apiKey = await getRelayApiKey();
    if (!apiKey) {
      return NextResponse.json(
        { ok: false, error: { code: 'unauthorized', message: 'Not authenticated' }, channels: [], archivedChannels: [] },
        { status: 401 }
      );
    }

    const relay = getRelay(apiKey);
    const [raw, dmConversations] = await Promise.all([
      relay.channels.list({ include_archived: true }),
      relay.allDmConversations().catch(() => []),
    ]);

    const channels = raw.filter((ch) => !ch.is_archived).map((ch) => ({
      id: ch.name ? `#${ch.name}` : ch.id,
      name: ch.name || ch.id,
      description: ch.topic || '',
      visibility: 'public',
      status: 'active',
      createdAt: ch.created_at || new Date().toISOString(),
      createdBy: ch.created_by || 'system',
      memberCount: ch.member_count || 0,
      messageCount: 0,
      unreadCount: 0,
      hasMentions: false,
      isDm: false,
    }));

    // Add DM conversations as channels
    for (const dm of dmConversations) {
      const dmName = dm.participants.join(', ');
      channels.push({
        id: `dm:${dm.id}`,
        name: dmName,
        description: dm.last_message ? `${dm.last_message.agent_name}: ${dm.last_message.text}` : '',
        visibility: 'private',
        status: 'active',
        createdAt: dm.last_message?.created_at || new Date().toISOString(),
        createdBy: dm.participants[0] || 'system',
        memberCount: dm.participants.length,
        messageCount: dm.message_count || 0,
        unreadCount: 0,
        hasMentions: false,
        isDm: true,
      });
    }

    const archivedChannels = raw.filter((ch) => ch.is_archived).map((ch) => ({
      id: ch.name ? `#${ch.name}` : ch.id,
      name: ch.name || ch.id,
      description: ch.topic || '',
      visibility: 'public',
      status: 'archived',
      createdAt: ch.created_at || new Date().toISOString(),
      createdBy: ch.created_by || 'system',
      memberCount: ch.member_count || 0,
      messageCount: 0,
      unreadCount: 0,
      hasMentions: false,
      isDm: false,
    }));

    return NextResponse.json({ ok: true, channels, archivedChannels });
  } catch (error) {
    if (error instanceof RelayError) {
      return NextResponse.json(
        { ok: false, error: { code: error.code, message: error.message } },
        { status: error.status }
      );
    }
    console.error('[api/channels] Error:', error);
    return NextResponse.json(
      { ok: false, error: { code: 'internal_error', message: 'Internal server error' }, channels: [], archivedChannels: [] },
      { status: 500 }
    );
  }
}
