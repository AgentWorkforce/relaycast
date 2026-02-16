import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

const COOKIE_NAME = 'relaycast_key';

/**
 * GET /api/auth/check
 * Validates the auth cookie against the relay server.
 */
export async function GET() {
  const cookieStore = await cookies();
  const cookie = cookieStore.get(COOKIE_NAME);

  if (!cookie?.value || !cookie.value.startsWith('rk_live_')) {
    return NextResponse.json(
      { authenticated: false },
      { status: 401 }
    );
  }

  // Validate key against the relay server
  try {
    const relayServer = process.env.RELAY_SERVER_URL || 'http://localhost:3890';
    const res = await fetch(`${relayServer}/v1/workspace`, {
      headers: { Authorization: `Bearer ${cookie.value}` },
    });

    if (!res.ok) {
      // Key is revoked or invalid — clear the cookie
      cookieStore.delete(COOKIE_NAME);
      return NextResponse.json(
        { authenticated: false },
        { status: 401 }
      );
    }
  } catch {
    // Relay server unreachable — allow session to continue
    // (downstream API calls will fail with proper errors)
  }

  return NextResponse.json({ authenticated: true });
}
