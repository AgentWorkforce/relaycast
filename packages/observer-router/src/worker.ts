interface Env {
  OBSERVER_ORIGIN?: string;
}

const DEFAULT_OBSERVER_ORIGIN = 'https://relaycast-observer.pages.dev';

function resolveOrigin(env: Env): URL {
  const raw = env.OBSERVER_ORIGIN?.trim() || DEFAULT_OBSERVER_ORIGIN;
  const url = new URL(raw);
  if (url.protocol !== 'https:') {
    throw new Error('OBSERVER_ORIGIN must use https://');
  }
  return url;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const incoming = new URL(request.url);
    const origin = resolveOrigin(env);
    const upstream = new URL(origin.toString());
    upstream.pathname = incoming.pathname;
    upstream.search = incoming.search;

    // Preserve original observer host so dashboard API routes can map:
    // prNN-observer.relaycast.dev -> prNN-api.relaycast.dev
    // Use both a custom header and x-forwarded-host for compatibility.
    const headers = new Headers(request.headers);
    headers.set('x-relaycast-observer-host', incoming.host);
    headers.set('x-forwarded-host', incoming.host);
    headers.set('x-forwarded-proto', incoming.protocol.replace(':', ''));
    headers.delete('host');

    const forwardedFor = request.headers.get('cf-connecting-ip');
    if (forwardedFor) {
      headers.set('x-forwarded-for', forwardedFor);
    }

    const upstreamRequest = new Request(upstream.toString(), {
      method: request.method,
      headers,
      body: request.body,
      redirect: 'manual',
    });

    return fetch(upstreamRequest);
  },
};
