import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { resolveRelayServerUrlFromRequest } from '../../../../lib/relay-server';

export const runtime = 'edge';

const COOKIE_NAME = 'relaycast_key';
const ALLOWED_RESOURCES = new Set(['messages', 'stats', 'agents', 'costs']);

interface RouteContext {
  params: {
    resource: string;
  };
}

export async function GET(request: NextRequest, context: RouteContext) {
  const cookieStore = await cookies();
  const apiKey = cookieStore.get(COOKIE_NAME)?.value;

  if (!apiKey) {
    return NextResponse.json(
      { ok: false, error: { code: 'unauthorized', message: 'Missing auth cookie' } },
      { status: 401 },
    );
  }

  const resource = context.params.resource;
  if (!ALLOWED_RESOURCES.has(resource)) {
    return NextResponse.json(
      { ok: false, error: { code: 'not_found', message: 'Console resource not found' } },
      { status: 404 },
    );
  }

  const relayServer = resolveRelayServerUrlFromRequest(request);
  const target = new URL(`${relayServer}/v1/console/${resource}`);
  request.nextUrl.searchParams.forEach((value, key) => {
    target.searchParams.set(key, value);
  });

  try {
    const response = await fetch(target.toString(), {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
    });

    const body = await response.text();

    return new NextResponse(body, {
      status: response.status,
      headers: {
        'content-type': response.headers.get('content-type') ?? 'application/json',
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'relay_unreachable',
          message: error instanceof Error ? error.message : 'Relay server unavailable',
        },
      },
      { status: 502 },
    );
  }
}
