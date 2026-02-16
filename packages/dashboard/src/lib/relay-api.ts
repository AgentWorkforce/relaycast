/**
 * Server-side helper for calling the relaycast API.
 * Reads the API key from the cookie and forwards requests
 * with the Authorization: Bearer header.
 */

import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

const RELAY_SERVER = process.env.RELAY_SERVER_URL || 'http://localhost:3890';

export async function getRelayApiKey(): Promise<string | null> {
  const cookieStore = await cookies();
  const cookie = cookieStore.get('relaycast_key');
  if (!cookie?.value) return null;
  try {
    return decodeURIComponent(cookie.value);
  } catch {
    return null;
  }
}

/**
 * Fetch from the relaycast server with auth. Returns a 401 NextResponse
 * if no API key is found in cookies.
 */
export async function relayFetch(
  path: string,
  init?: RequestInit
): Promise<Response> {
  const apiKey = await getRelayApiKey();
  if (!apiKey) {
    return NextResponse.json(
      { error: 'Not authenticated' },
      { status: 401 }
    );
  }
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string>),
    'Authorization': `Bearer ${apiKey}`,
  };
  // Only set Content-Type for requests with a body
  if (init?.body) {
    headers['Content-Type'] = 'application/json';
  }
  return fetch(`${RELAY_SERVER}${path}`, {
    ...init,
    headers,
  });
}
