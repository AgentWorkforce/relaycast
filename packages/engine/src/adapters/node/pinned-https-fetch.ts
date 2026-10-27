import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import { Readable } from 'node:stream';

/** Statuses whose response must not carry a body (`new Response` rejects one). */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * A minimal `fetch` over `node:https` whose connection resolves the hostname
 * through `lookup`, so the socket opens to exactly the address `lookup`
 * approved, while TLS still verifies the certificate against the URL hostname
 * (SNI and the Host header keep the hostname).
 *
 * This exists for Bun: Bun replaces the `undici` package with a built-in shim
 * whose `fetch` ignores `dispatcher`, so undici's `connect.lookup` pinning
 * silently stops applying. Bun's `node:https` honours `lookup`.
 *
 * Redirects are never followed (callers use `redirect: 'manual'`); the 3xx
 * response is returned as-is.
 */
export function createLookupPinnedHttpsFetch(lookup: LookupFunction): typeof globalThis.fetch {
  return async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.protocol !== 'https:') throw new TypeError(`Pinned fetch only supports https: (${url.protocol})`);
    const signal = init?.signal ?? req.signal;
    signal?.throwIfAborted();

    const body = req.body ? Buffer.from(await req.arrayBuffer()) : undefined;
    // The signal may have aborted while the body was buffered.
    signal?.throwIfAborted();
    const headers: Record<string, string> = {};
    req.headers.forEach((value, key) => {
      headers[key] = value;
    });
    if (body && headers['content-length'] === undefined) headers['content-length'] = String(body.length);
    // Response bodies are passed through undecoded, so ask for an unencoded one.
    if (headers['accept-encoding'] === undefined) headers['accept-encoding'] = 'identity';

    return new Promise<Response>((resolve, reject) => {
      const client = httpsRequest(
        {
          protocol: 'https:',
          hostname: url.hostname.replace(/^\[(.*)\]$/, '$1'),
          port: url.port || 443,
          path: `${url.pathname}${url.search}`,
          method: req.method,
          headers,
          lookup,
          agent: false,
        },
        (res) => {
          // This callback runs outside the executor, so a throw here (e.g.
          // `new Response` refusing a status outside 200-599) would escape as
          // an uncaught exception instead of rejecting the fetch.
          try {
            const responseHeaders = new Headers();
            for (const [key, value] of Object.entries(res.headers)) {
              if (value === undefined) continue;
              for (const item of Array.isArray(value) ? value : [value]) responseHeaders.append(key, item);
            }
            const status = res.statusCode ?? 502;
            if (status < 200 || status > 599) throw new TypeError(`Unsupported response status ${status}`);
            const responseBody = NULL_BODY_STATUSES.has(status) || req.method === 'HEAD'
              ? null
              : (Readable.toWeb(res) as ReadableStream<Uint8Array>);
            if (responseBody === null) res.resume();
            resolve(new Response(responseBody, { status, statusText: res.statusMessage, headers: responseHeaders }));
          } catch (err) {
            res.destroy();
            reject(err);
          }
        },
      );
      const onAbort = () => client.destroy(signal?.reason instanceof Error ? signal.reason : new Error('The operation was aborted'));
      signal?.addEventListener('abort', onAbort, { once: true });
      client.on('close', () => signal?.removeEventListener('abort', onAbort));
      client.on('error', reject);
      client.end(body);
    });
  };
}
