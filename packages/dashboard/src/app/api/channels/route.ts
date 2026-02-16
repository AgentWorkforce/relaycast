import { NextResponse } from 'next/server';
import { relayFetch } from '../../../lib/relay-api';

/**
 * GET /api/channels
 * Translates relaycast /v1/channels to the dashboard's expected format.
 */
export async function GET() {
  try {
    const res = await relayFetch('/v1/channels');
    if (!res.ok) {
      return NextResponse.json({ success: false, channels: [], archivedChannels: [] });
    }

    const data = await res.json();
    const raw = data.data || data.channels || [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const channels = raw.filter((ch: any) => !ch.is_archived).map((ch: any) => ({
      id: ch.name ? `#${ch.name}` : ch.id,
      name: ch.name || ch.id,
      description: ch.description || ch.topic || '',
      visibility: ch.is_private ? 'private' : 'public',
      status: 'active',
      createdAt: ch.created_at || new Date().toISOString(),
      createdBy: ch.created_by || 'system',
      memberCount: ch.member_count || 0,
      unreadCount: 0,
      hasMentions: false,
      isDm: false,
    }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const archivedChannels = raw.filter((ch: any) => ch.is_archived).map((ch: any) => ({
      id: ch.name ? `#${ch.name}` : ch.id,
      name: ch.name || ch.id,
      description: ch.description || ch.topic || '',
      visibility: ch.is_private ? 'private' : 'public',
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
    console.error('[api/channels] Error:', error);
    return NextResponse.json({ success: false, channels: [], archivedChannels: [] });
  }
}
