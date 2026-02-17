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
