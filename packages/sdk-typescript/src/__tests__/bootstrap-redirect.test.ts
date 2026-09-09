import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RelayCast } from '../relay.js';

const servers: Server[] = [];

async function listen(server: Server): Promise<{ server: Server; url: string }> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind a TCP port');
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

describe('anonymous bootstrap redirect safety', () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(servers.splice(0).map(close));
  });

  it('uses Workers-compatible manual redirect handling and rejects before parsing', async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.redirect).toBe('manual');
      return new Response(null, {
        status: 307,
        headers: { location: 'https://attacker.invalid/v1/workspaces' },
      });
    });
    vi.stubGlobal('fetch', fetch);

    await expect(
      RelayCast.createWorkspace('redirected', {
        idempotencyKey: 'bootstrap-run-1-9f3a7c1e5b8d2f4a6c0e8b2d4f6a8c0e',
        bootstrapSecret: 'do-not-forward',
        baseUrl: 'http://127.0.0.1:43117',
      }),
    ).rejects.toThrow('Refusing to follow an anonymous bootstrap redirect');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('fails closed on a redirect and never sends the bootstrap secret to the redirected server', async () => {
    let redirectedRequests = 0;
    let redirectedSecret: string | undefined;
    const redirected = await listen(createServer((request, response) => {
      redirectedRequests += 1;
      redirectedSecret = request.headers['x-workspace-bootstrap-secret'] as string | undefined;
      request.resume();
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, data: { workspace_id: 'unexpected' } }));
    }));
    let originRequests = 0;
    const origin = await listen(createServer((request, response) => {
      originRequests += 1;
      request.resume();
      response.writeHead(307, { location: `${redirected.url}/v1/workspaces` });
      response.end();
    }));

    await expect(RelayCast.createWorkspace('redirected', {
      idempotencyKey: 'bootstrap-run-1-9f3a7c1e5b8d2f4a6c0e8b2d4f6a8c0e',
      bootstrapSecret: 'do-not-forward',
      baseUrl: origin.url,
    })).rejects.toBeInstanceOf(Error);

    expect(originRequests).toBe(1);
    expect(redirectedRequests).toBe(0);
    expect(redirectedSecret).toBeUndefined();
  });

  it('still permits a direct loopback HTTP bootstrap request', async () => {
    let requests = 0;
    const origin = await listen(createServer((request, response) => {
      requests += 1;
      expect(request.headers['x-workspace-bootstrap-secret']).toBe('local-only');
      request.resume();
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        ok: true,
        data: { workspace_id: 'ws_local', api_key: 'rk_live_local', created_at: '2026-09-09' },
      }));
    }));

    const result = await RelayCast.createWorkspace('local', {
      idempotencyKey: 'bootstrap-run-1-9f3a7c1e5b8d2f4a6c0e8b2d4f6a8c0e',
      bootstrapSecret: 'local-only',
      baseUrl: origin.url,
    });

    expect(result.workspaceId).toBe('ws_local');
    expect(requests).toBe(1);
  });
});
