import { createServer, type Server, type Socket } from 'node:net';
import type { LookupFunction } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createLookupPinnedHttpsFetch } from '../pinned-https-fetch.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

/** A raw TCP listener: enough to observe where the client's socket lands. */
async function listen(onSocket: (socket: Socket) => void): Promise<number> {
  const server = createServer(onSocket);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return (server.address() as { port: number }).port;
}

describe('createLookupPinnedHttpsFetch', () => {
  it('resolves the hostname only through the pinned lookup and fails closed when it rejects', async () => {
    const looked: string[] = [];
    const deny: LookupFunction = (hostname, _options, callback) => {
      looked.push(hostname);
      callback(Object.assign(new Error(`denied ${hostname}`), { code: 'ENOTFOUND' }), '', 0);
    };
    const pinnedFetch = createLookupPinnedHttpsFetch(deny);
    await expect(pinnedFetch('https://hooks.example.test/deliver', { method: 'POST', body: '{}' }))
      .rejects.toThrow('denied hooks.example.test');
    expect(looked).toEqual(['hooks.example.test']);
  });

  it('connects to the address the lookup returned, not the name in the URL', async () => {
    let connections = 0;
    const port = await listen((socket) => {
      connections += 1;
      socket.destroy();
    });
    const toLoopback: LookupFunction = (_hostname, options, callback) => {
      if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
      else callback(null, '127.0.0.1', 4);
    };
    const pinnedFetch = createLookupPinnedHttpsFetch(toLoopback);
    // The TLS handshake fails against a raw TCP listener; reaching it at all
    // proves the socket went to the pinned address.
    await expect(pinnedFetch(`https://pinned.example.test:${port}/`)).rejects.toThrow();
    expect(connections).toBe(1);
  });

  it('rejects non-https URLs and already-aborted signals before connecting', async () => {
    const neverCalled: LookupFunction = () => {
      throw new Error('lookup must not run');
    };
    const pinnedFetch = createLookupPinnedHttpsFetch(neverCalled);
    await expect(pinnedFetch('http://plain.example.test/')).rejects.toThrow(/only supports https/);
    await expect(pinnedFetch('https://hooks.example.test/', { signal: AbortSignal.abort() })).rejects.toThrow();
  });
});
