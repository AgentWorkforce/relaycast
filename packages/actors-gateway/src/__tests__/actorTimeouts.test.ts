import { describe, expect, it } from 'vitest';
import { ActorCallError, createActorClient } from '../actors.js';

const REQUEST = { method: 'GET', url: 'http://gw/v1/agents', headers: [] as [string, string][], body: null };
const RESPONSE = { status: 200, headers: [] as [string, string][], body: '{"ok":true}' };

/** A control plane that answers every invoke after `delayMs`, unless aborted first. */
function slowControlPlane(delayMs: number): typeof globalThis.fetch {
  return (_input, init) => new Promise((resolve, reject) => {
    const signal = init?.signal ?? undefined;
    const timer = setTimeout(() => {
      resolve(new Response(JSON.stringify({ outcome: { type: 'completed', result: RESPONSE } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    }, delayMs);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(Object.assign(new TypeError('fetch failed'), { cause: signal.reason }));
    });
  });
}

describe('actor call budgets', () => {
  it('gives create its own, longer budget than handle', async () => {
    const client = createActorClient({
      controlPlaneUrl: 'http://cp',
      projectId: 'local',
      fetch: slowControlPlane(120),
      invokeTimeoutMs: 40,
      createTimeoutMs: 1000,
    });
    await expect(client.handle('1', REQUEST)).rejects.toMatchObject({ code: 'outcome_unknown' } satisfies Partial<ActorCallError>);
    await expect(client.create('1', REQUEST, 'tag')).resolves.toEqual(RESPONSE);
  });

  it('reports a reply body lost to the client leaving as aborted, and to the timeout as outcome_unknown', async () => {
    // Headers arrive at once; the body errors when the request signal fires.
    const bodyFailsOnAbort: typeof globalThis.fetch = async (_url, init) => {
      const signal = init?.signal as AbortSignal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"outcome":'));
          signal.addEventListener('abort', () => controller.error(new Error('body read failed')), { once: true });
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const request = { method: 'GET', url: 'https://x/v1/agents', headers: [] as [string, string][], body: null };
    const client = createActorClient({ controlPlaneUrl: 'http://127.0.0.1:1', projectId: 'p', fetch: bodyFailsOnAbort, invokeTimeoutMs: 100 });
    const controller = new AbortController();
    const gone = client.handle('1', request, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(gone).rejects.toMatchObject({ name: 'ActorCallError', code: 'aborted' });
    await expect(client.handle('1', request)).rejects.toMatchObject({ name: 'ActorCallError', code: 'outcome_unknown' });
  });

  it('maps a 401/403 to unauthenticated before reading the body', async () => {
    const refusing: typeof globalThis.fetch = async () => new Response('<html>denied</html>', { status: 403, headers: { 'content-type': 'text/html' } });
    const client = createActorClient({ controlPlaneUrl: 'http://127.0.0.1:1', projectId: 'p', fetch: refusing });
    await expect(client.handle('1', { method: 'GET', url: 'https://x/v1/agents', headers: [], body: null })).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(client.findWebsocket('1', {})).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});
