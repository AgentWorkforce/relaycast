import { describe, expect, it } from 'vitest';
import { rescheduleNodeInvocation } from '../action.js';
import type { NodeConnectionRegistry } from '../../ports/realtime.js';

// inventory.sync and the timeout sweep call rescheduleNodeInvocation once per
// open invocation on a node, inside a single liveness deadline. A node holding
// many dispatched built-in releases spent that whole deadline on lookups that
// could not match, and its inventory never got a reply.
function untouchable(name: string) {
  const accessed: string[] = [];
  const proxy = new Proxy({}, {
    get: (_target, key) => {
      accessed.push(`${name}.${String(key)}`);
      throw new Error(`${name} must not be touched (${String(key)})`);
    },
  });
  return { proxy, accessed };
}

function releaseRow(dispatchAttempts: number) {
  return {
    id: 'inv_release',
    workspaceId: 'ws_1',
    actionId: null,
    actionName: 'release',
    invocationOrigin: 'builtin',
    callerId: null,
    input: { name: 'worker-1', reason: 'done' },
    status: 'dispatched',
    dispatchedNodeId: 'node_1',
    providerAcceptedAttempt: null,
    spawnReservedAt: null,
    attemptedNodeIds: ['node_1'],
    dispatchAttempts,
  } as unknown as Parameters<typeof rescheduleNodeInvocation>[2];
}

describe('rescheduleNodeInvocation for a dispatched built-in release', () => {
  it('declines without any database read', async () => {
    const db = untouchable('db');
    const registry = untouchable('registry');
    await expect(rescheduleNodeInvocation(
      db.proxy as never,
      registry.proxy as unknown as NodeConnectionRegistry,
      releaseRow(1),
    )).resolves.toBe(false);
    expect(db.accessed).toEqual([]);
    expect(registry.accessed).toEqual([]);
  });

  it('still looks up a never-dispatched release, which a registered action may yet bind', async () => {
    const db = untouchable('db');
    const registry = untouchable('registry');
    await expect(rescheduleNodeInvocation(
      db.proxy as never,
      registry.proxy as unknown as NodeConnectionRegistry,
      releaseRow(0),
    )).rejects.toThrow('db must not be touched');
    expect(db.accessed.length).toBeGreaterThan(0);
  });
});
