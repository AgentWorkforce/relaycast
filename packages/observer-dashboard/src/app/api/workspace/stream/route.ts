import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { RelayCast, RelayError } from '@relaycast/sdk';
import { resolveRelayServerUrlFromRequest } from '../../../../lib/relay-server';

export const runtime = 'edge';

const COOKIE_NAME = 'relaycast_key';

type StreamResponse = {
  success: boolean;
  enabled?: boolean;
  defaultEnabled?: boolean;
  override?: boolean | null;
  error?: string;
  detail?: string;
  status?: number;
  baseUrl?: string;
};

async function getRelay(request: NextRequest): Promise<{ relay: RelayCast; baseUrl: string } | null> {
  const cookieStore = await cookies();
  const apiKey = cookieStore.get(COOKIE_NAME)?.value;
  if (!apiKey?.startsWith('rk_live_')) return null;

  const baseUrl = resolveRelayServerUrlFromRequest(request);
  return { relay: new RelayCast({ apiKey, baseUrl }), baseUrl };
}

function toPayload(data: { enabled: boolean; defaultEnabled: boolean; override: boolean | null }): StreamResponse {
  return {
    success: true,
    enabled: data.enabled,
    defaultEnabled: data.defaultEnabled,
    override: data.override,
  };
}

export async function GET(request: NextRequest) {
  const relayCtx = await getRelay(request);
  if (!relayCtx) {
    return NextResponse.json(
      { success: false, error: 'Not authenticated' } satisfies StreamResponse,
      { status: 401 }
    );
  }

  try {
    const data = await relayCtx.relay.workspace.stream.get();
    return NextResponse.json(toPayload(data));
  } catch (error) {
    const relayError = error instanceof RelayError ? error : null;
    const detail = relayError
      ? `${relayError.code} (${relayError.status}): ${relayError.message}`
      : error instanceof Error
        ? error.message
        : 'unknown error';
    const status = relayError?.status ?? 500;
    const host = request.headers.get('host');
    const observerHost = request.headers.get('x-relaycast-observer-host');
    const forwardedHost = request.headers.get('x-forwarded-host');

    console.error('[api/workspace/stream] Failed to fetch stream config', {
      status,
      detail,
      baseUrl: relayCtx.baseUrl,
      host,
      observerHost,
      forwardedHost,
    });
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to fetch stream status',
        detail,
        status,
        baseUrl: relayCtx.baseUrl,
      } satisfies StreamResponse,
      { status }
    );
  }
}

export async function PUT(request: NextRequest) {
  const relayCtx = await getRelay(request);
  if (!relayCtx) {
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
    const current = await relayCtx.relay.workspace.stream.get();
    if (current.enabled === enabled) {
      return NextResponse.json(toPayload(current));
    }

    const data = await relayCtx.relay.workspace.stream.set(enabled);
    return NextResponse.json(toPayload(data));
  } catch (error) {
    const relayError = error instanceof RelayError ? error : null;
    const detail = relayError
      ? `${relayError.code} (${relayError.status}): ${relayError.message}`
      : error instanceof Error
        ? error.message
        : 'unknown error';
    const status = relayError?.status ?? 500;
    const host = request.headers.get('host');
    const observerHost = request.headers.get('x-relaycast-observer-host');
    const forwardedHost = request.headers.get('x-forwarded-host');

    console.error('[api/workspace/stream] Failed to update stream config', {
      enabled,
      status,
      detail,
      baseUrl: relayCtx.baseUrl,
      host,
      observerHost,
      forwardedHost,
    });
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to update stream status',
        detail,
        status,
        baseUrl: relayCtx.baseUrl,
      } satisfies StreamResponse,
      { status }
    );
  }
}
