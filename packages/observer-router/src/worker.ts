interface Env {
  // Service binding to the OpenNext observer dashboard worker.
  OBSERVER: { fetch(request: Request): Promise<Response> };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const incoming = new URL(request.url);

    // Preserve the original observer host so dashboard API routes can resolve
    // the hosted engine (cast.agentrelay.com) for the request.
    // Use both a custom header and x-forwarded-host for compatibility.
    const headers = new Headers(request.headers);
    headers.set('x-relaycast-observer-host', incoming.host);
    headers.set('x-forwarded-host', incoming.host);
    headers.set('x-forwarded-proto', incoming.protocol.replace(':', ''));

    const forwardedFor = request.headers.get('cf-connecting-ip');
    if (forwardedFor) {
      headers.set('x-forwarded-for', forwardedFor);
    }

    const upstreamRequest = new Request(incoming.toString(), {
      method: request.method,
      headers,
      body: request.body,
      redirect: 'manual',
    });

    return env.OBSERVER.fetch(upstreamRequest);
  },
};
