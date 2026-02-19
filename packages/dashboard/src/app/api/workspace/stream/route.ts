import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { RelayCast } from '@relaycast/sdk';
import { resolveRelayServerUrlFromRequest } from '../../../../lib/relay-server';

export const runtime = 'edge';

const COOKIE_NAME = 'relaycast_key';

type StreamResponse = {
  success: boolean;
  enabled?: boolean;
  defaultEnabled?: boolean;
  override?: boolean | null;
  error?: string;
};

async function getRelay(request: NextRequest): Promise<RelayCast | null> {
  const cookieStore = await cookies();
  const apiKey = cookieStore.get(COOKIE_NAME)?.value;
  if (!apiKey?.startsWith('rk_live_')) return null;

  const baseUrl = resolveRelayServerUrlFromRequest(request);
  return new RelayCast({ apiKey, baseUrl });
}

function toPayload(data: { enabled: boolean; default_enabled: boolean; override: boolean | null }): StreamResponse {
  return {
    success: true,
    enabled: data.enabled,
    defaultEnabled: data.default_enabled,
    override: data.override,
  };
}

export async function GET(request: NextRequest) {
  const relay = await getRelay(request);
  if (!relay) {
    return NextResponse.json(
      { success: false, error: 'Not authenticated' } satisfies StreamResponse,
      { status: 401 }
    );
  }

  try {
    const data = await relay.workspace.stream.get();
    return NextResponse.json(toPayload(data));
  } catch (error) {
    console.error('[api/workspace/stream] Failed to fetch stream config:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch stream status' } satisfies StreamResponse,
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest) {
  const relay = await getRelay(request);
  if (!relay) {
    return NextResponse.json(
      { success: false, error: 'Not authenticated' } satisfies StreamResponse,
      { status: 401 }
    );
  }

  let enabled = true;
  try {
    const body = await request.json();
    if (typeof body?.enabled === 'boolean') {
      enabled = body.enabled;
    }
  } catch {
    // Default to enabling stream when no body is provided.
  }

  try {
    const data = await relay.workspace.stream.set(enabled);
    return NextResponse.json(toPayload(data));
  } catch (error) {
    console.error('[api/workspace/stream] Failed to update stream config:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to update stream status' } satisfies StreamResponse,
      { status: 500 }
    );
  }
}
