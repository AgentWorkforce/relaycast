import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { RelayCast } from '@relaycast/sdk';

const COOKIE_NAME = 'relaycast_key';
const AGENT_COOKIE_NAME = 'relaycast_agent_token';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

/**
 * POST /api/auth/login
 * Validates the API key, registers a dashboard observer agent,
 * and sets httpOnly cookies for both tokens.
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

    // Register (or re-register) the dashboard observer agent
    const agent = await relay.agents.registerOrGet({
      name: '_dashboard_observer',
      type: 'human',
      metadata: { cli: 'dashboard' },
    });

    // Join the observer to all existing channels so it receives WS events
    const observerClient = relay.as(agent.token);
    try {
      const channels = await relay.channels.list();
      await Promise.allSettled(
        channels.map((ch) => observerClient.channels.join(ch.name))
      );
    } catch {
      // Non-fatal: observer may miss some channels until next login
    }

    const cookieStore = await cookies();

    cookieStore.set(COOKIE_NAME, apiKey, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: COOKIE_MAX_AGE,
    });

    cookieStore.set(AGENT_COOKIE_NAME, agent.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: COOKIE_MAX_AGE,
    });

    return NextResponse.json({
      success: true,
      apiKey,
      agentToken: agent.token,
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
