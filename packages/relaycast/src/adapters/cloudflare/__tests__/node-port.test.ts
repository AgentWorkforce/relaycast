import { describe, expect, it } from 'vitest';
import type { NodeConnectionRegistry } from '@relaycast/engine/ports';
import type { CloudflareBindings } from '../../../env.js';
import { createCloudflareNodeConnections } from '../realtime.js';

type Delivered = { name: string; pathname: string; method: string; body: unknown };

function fakeEnv(delivered: Delivered[], opts: { delivered?: boolean } = {}): CloudflareBindings {
  return {
    // drainNode queries action_invocations via D1; an empty result set keeps the
    // drain a no-op so the disconnect/drain routing test stays focused on the DO.
    DB: {
      prepare: () => ({
        bind: () => ({
          all: async () => ({ results: [] }),
          first: async () => null,
          run: async () => ({}),
        }),
      }),
    },
    NODE_DO: {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        fetch: async (request: Request) => {
          delivered.push({
            name,
            pathname: new URL(request.url).pathname,
            method: request.method,
            body: await request.json().catch(() => null),
          });
          return Response.json({ ok: true, delivered: opts.delivered ?? true });
        },
      }),
    },
  } as unknown as CloudflareBindings;
}

describe('Cloudflare fleet node engine port', () => {
  it('exposes the full engine 4.0 NodeConnectionRegistry port surface', () => {
    // Typed as the engine port: compile-time proof that the cloud adapter
    // satisfies `EngineDeps.nodeConnections` in @relaycast/engine 4.0. The
    // runtime loop is the backstop (test files are excluded from the package
    // tsconfig), asserting every method the engine calls is a real function.
    const registry: NodeConnectionRegistry = createCloudflareNodeConnections(fakeEnv([]));
    for (const method of ['upgradeNode', 'sendToNode', 'isNodeConnected', 'disconnectNode', 'drainNode'] as const) {
      expect(typeof registry[method]).toBe('function');
    }
  });

  it('routes action.invoke dispatch to the NodeDO via sendToNode', async () => {
    const delivered: Delivered[] = [];
    const registry = createCloudflareNodeConnections(fakeEnv(delivered));

    const sent = await registry.sendToNode('rw_test', 'node_test', {
      v: 1,
      type: 'action.invoke',
      invocation_id: 'inv_test',
      action: 'github.pr.review',
      input: { pull: 2090 },
    });

    expect(sent).toBe(true);
    expect(delivered).toEqual([
      {
        name: 'rw_test:node_test',
        pathname: '/send',
        method: 'POST',
        body: {
          v: 1,
          type: 'action.invoke',
          invocation_id: 'inv_test',
          action: 'github.pr.review',
          input: { pull: 2090 },
        },
      },
    ]);
  });

  it('reports sendToNode delivery failure when the NodeDO has no live socket', async () => {
    const delivered: Delivered[] = [];
    const registry = createCloudflareNodeConnections(fakeEnv(delivered, { delivered: false }));
    const sent = await registry.sendToNode('rw_test', 'node_test', { v: 1, type: 'ping' });
    expect(sent).toBe(false);
  });

  it('routes disconnectNode to the NodeDO and drains parked invocations on drainNode', async () => {
    const delivered: Delivered[] = [];
    const registry = createCloudflareNodeConnections(fakeEnv(delivered));

    await registry.disconnectNode('rw_test', 'node_test');
    // drainNode re-dispatches parked invocations from D1 (no DO round-trip with
    // an empty queue), so only the disconnect hits the NodeDO here.
    await registry.drainNode('rw_test', 'node_test');

    expect(delivered.map((d) => d.pathname)).toEqual(['/disconnect']);
    expect(delivered.every((d) => d.method === 'POST')).toBe(true);
  });

  it('isNodeConnected reports false from the edge isolate (DO socket state is not synchronous)', () => {
    const registry = createCloudflareNodeConnections(fakeEnv([]));
    expect(registry.isNodeConnected('rw_test', 'node_test')).toBe(false);
  });
});
