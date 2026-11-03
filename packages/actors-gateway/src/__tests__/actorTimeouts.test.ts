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
});
