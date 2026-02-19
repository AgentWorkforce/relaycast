import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { RelayCast } from '@relaycast/sdk';

const COOKIE_NAME = 'relaycast_key';
const AGENT_COOKIE_NAME = 'relaycast_agent_token';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

/**
 * POST /api/auth/login
 * Validates the API key and sets httpOnly cookies.
 * WebSocket stream now authenticates directly with workspace key.
 */
export async function POST(request: NextRequest) {
  try {
    const { apiKey } = await request.json();

    if (!apiKey || !apiKey.startsWith('rk_live_')) {
      return NextResponse.json(
        { success: false, error: 'Invalid API key format' },
        { status: 400 }
      );
    }

    // Always validate against the server-configured relay URL (prevents SSRF)
    const relayServer = process.env.RELAY_SERVER_URL || 'http://localhost:3890';
    const relay = new RelayCast({ apiKey, baseUrl: relayServer });

    // Validate key by fetching workspace
    try {
      await relay.workspace.info();
    } catch {
      return NextResponse.json(
        { success: false, error: 'Invalid API key' },
        { status: 401 }
      );
    }

    // Enable workspace stream for this workspace so observer dashboard
    // receives full realtime event fanout.
    try {
      await relay.workspace.stream.set(true);
    } catch {
      return NextResponse.json(
        { success: false, error: 'Failed to enable workspace stream' },
        { status: 500 }
      );
    }

    const cookieStore = await cookies();

    cookieStore.set(COOKIE_NAME, apiKey, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: COOKIE_MAX_AGE,
    });

    // Agent cookie remains for compatibility with existing client shape.
    // Workspace keys are accepted by read-only endpoints used in dashboard.
    cookieStore.set(AGENT_COOKIE_NAME, apiKey, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: COOKIE_MAX_AGE,
    });

    return NextResponse.json({
      success: true,
      apiKey,
      agentToken: apiKey,
      wsToken: apiKey,
      baseUrl: relayServer,
    });
  } catch (error) {
    console.error('[api/auth/login] Error:', error);
    return NextResponse.json(
      { success: false, error: 'Login failed' },
      { status: 500 }
    );
  }
}
