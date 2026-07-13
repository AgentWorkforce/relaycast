import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Import through the public `@relaycast/engine/node-control` entrypoint (its
// source module) — this doubles as an assertion that the policy is actually
// exported for out-of-process socket owners like the relaycast-cloud NodeDO.
import { providerAttachDecision, PROVIDER_ATTACH_LIVENESS_MS } from '../../node-control.js';
import { makeNodeStack, FakeSocket, type TestStack } from './harness.js';

// The exported `providerAttachDecision` policy must be the single source of truth
// for the in-process `InProcessRealtime.providerAttachConflict` adapter — the same
// decision the relaycast-cloud NodeDO mirrors. Drive the adapter with a bound
// incumbent provider and assert its conflict verdict agrees with the pure policy
// across all three spec §3.1 branches (reconnect, live duplicate, stale supersede).

const WS = 'ws_attach';
const NODE = 'node_attach';
const PROVIDER = 'broker';
const INCUMBENT = 'inst-A';
const T0 = 1_700_000_000_000;

describe('providerAttachDecision', () => {
  it('accepts an unbound provider regardless of a recent last-seen timestamp', () => {
    expect(providerAttachDecision({
      existingInstanceId: undefined,
      existingLastSeen: T0,
      incomingInstanceId: 'inst-B',
      now: T0 + 1_000,
    })).toEqual({ conflict: false });
  });
});

describe('providerAttachDecision matches InProcessRealtime.providerAttachConflict', () => {
  let stack: TestStack;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    stack = makeNodeStack();
  });
  afterEach(async () => {
    // `attachNodeSocket` fires a best-effort `drainNode` (a detached DB read);
    // let it settle on a real macrotask before closing the connection so its
    // query can't land on a closed database.
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 0));
    stack.close();
  });

  // Bind an incumbent provider instance (lastSeen = T0), then return the id of a
  // second, competing connection on the same node.
  function bindIncumbentAndChallenger(): string {
    const realtime = stack.runtime.realtime;
    const incumbent = realtime.attachNodeSocket(WS, NODE, new FakeSocket());
    realtime.attachProvider(WS, NODE, PROVIDER, INCUMBENT, incumbent.connectionId!);
    const challenger = realtime.attachNodeSocket(WS, NODE, new FakeSocket());
    return challenger.connectionId!;
  }

  // Assert the adapter's conflict result and the pure decision agree for the same
  // incumbent (instance INCUMBENT, lastSeen T0) at clock `now`.
  function assertAgreement(challengerConnId: string, now: number, incomingInstanceId: string) {
    vi.setSystemTime(now);
    const adapter = stack.runtime.realtime.providerAttachConflict(WS, NODE, PROVIDER, incomingInstanceId, challengerConnId);
    const decision = providerAttachDecision({
      existingInstanceId: INCUMBENT,
      existingLastSeen: T0,
      incomingInstanceId,
      now,
    });
    expect(adapter !== null).toBe(decision.conflict);
    if (decision.conflict) expect(adapter?.code).toBe(decision.code);
    return { adapter, decision };
  }

  it('same instance re-registering is a reconnect, not a conflict', () => {
    const challenger = bindIncumbentAndChallenger();
    const { adapter, decision } = assertAgreement(challenger, T0 + 1_000, INCUMBENT);
    expect(decision.conflict).toBe(false);
    expect(adapter).toBeNull();
  });

  it('a different instance still framing within the window is a live duplicate', () => {
    const challenger = bindIncumbentAndChallenger();
    const { adapter, decision } = assertAgreement(challenger, T0 + PROVIDER_ATTACH_LIVENESS_MS - 1, 'inst-B');
    expect(decision.conflict).toBe(true);
    expect(adapter?.code).toBe('provider_instance_conflict');
  });

  it('a different instance silent past the window supersedes the stale binding', () => {
    const challenger = bindIncumbentAndChallenger();
    const { adapter, decision } = assertAgreement(challenger, T0 + PROVIDER_ATTACH_LIVENESS_MS + 1, 'inst-B');
    expect(decision.conflict).toBe(false);
    expect(adapter).toBeNull();
  });
});
