/**
 * Server-side helper for calling the relaycast API.
 * Reads the API key from the cookie and provides SDK access.
 */

import { cookies } from 'next/headers';
import { RelayCast } from '@relaycast/sdk';

const RELAY_SERVER = process.env.RELAY_SERVER_URL || 'http://localhost:3890';

export async function getRelayApiKey(): Promise<string | null> {
  const cookieStore = await cookies();
  const cookie = cookieStore.get('relaycast_key');
  return cookie?.value || null;
}

export function getRelay(apiKey: string): RelayCast {
  return new RelayCast({ apiKey, baseUrl: RELAY_SERVER });
}

/**
 * relayFetch - Makes authenticated requests to the Relay API
 * Uses the workspace key from the cookie for authentication
 */
export async function relayFetch(path: string, init?: RequestInit): Promise<Response> {
  const apiKey = await getRelayApiKey();
  if (!apiKey) {
    throw new Error('No API key found');
  }

  const url = new URL(path, RELAY_SERVER);
  return fetch(url.toString(), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...init?.headers,
    },
  });
}
