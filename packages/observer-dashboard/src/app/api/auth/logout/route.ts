import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { RelayCast, RelayError } from '@relaycast/sdk';
import {
  orderByRemembered,
  pickRememberedEngine,
  resolveRelayServerCandidatesFromRequest,
  selectEngineForKey,
} from '../../../../lib/relay-server';

export const runtime = 'edge';

const COOKIE_NAME = 'relaycast_key';
const AGENT_COOKIE_NAME = 'relaycast_agent_token';
const ENGINE_COOKIE_NAME = 'relaycast_engine';

/**
 * POST /api/auth/logout
 * Disables workspace stream (best-effort) and clears auth cookies.
 */
export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const apiKey = cookieStore.get(COOKIE_NAME)?.value;

  if (apiKey?.startsWith('rk_live_')) {
    const candidates = resolveRelayServerCandidatesFromRequest(request);
    const remembered = pickRememberedEngine(
      cookieStore.get(ENGINE_COOKIE_NAME)?.value,
      candidates
    );
    // Disable the stream on the engine the workspace actually lives on.
    const { baseUrl } = await selectEngineForKey(
      orderByRemembered(candidates, remembered),
      apiKey
    );
    const relayServer = baseUrl ?? remembered ?? candidates[0]!;
    const relay = new RelayCast({ apiKey, baseUrl: relayServer });
    try {
      await relay.workspace.stream.set(false);
    } catch (error) {
      const relayError = error instanceof RelayError ? error : null;
      console.warn('[api/auth/logout] Failed to disable workspace stream', {
        detail: relayError
          ? `${relayError.code} (${relayError.status}): ${relayError.message}`
          : error instanceof Error
            ? error.message
            : String(error),
        baseUrl: relayServer,
        host: request.headers.get('host'),
        observerHost: request.headers.get('x-relaycast-observer-host'),
        forwardedHost: request.headers.get('x-forwarded-host'),
      });
    }
  }

  cookieStore.delete(COOKIE_NAME);
  cookieStore.delete(AGENT_COOKIE_NAME);
  cookieStore.delete(ENGINE_COOKIE_NAME);
  return NextResponse.json({ success: true });
}
