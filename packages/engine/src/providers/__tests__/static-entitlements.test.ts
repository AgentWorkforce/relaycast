import { describe, expect, it } from 'vitest';
import { PLAN_LIMITS, StaticEntitlementsProvider } from '../static-entitlements.js';
import type { Workspace } from '../../ports/index.js';

function workspace(plan: string): Workspace {
  return { id: 'ws_1', plan } as Workspace;
}

describe('StaticEntitlementsProvider', () => {
  it('resolves the connect profile for room workspaces', async () => {
    const provider = new StaticEntitlementsProvider(undefined, 'free');
    const limits = await provider.getLimits(workspace('connect'));
    expect(limits).toBe(PLAN_LIMITS.connect);
    expect(limits.api_calls).toBe(8_000_000);
    expect(limits.agents).toBe(10);
  });

  it('sizes connect between free and pro on every metric', () => {
    for (const metric of ['messages', 'agents', 'file_bytes', 'api_calls', 'rate_per_min'] as const) {
      expect(PLAN_LIMITS.connect![metric]).toBeGreaterThan(PLAN_LIMITS.free![metric]);
      expect(PLAN_LIMITS.connect![metric]).toBeLessThan(PLAN_LIMITS.pro![metric]);
    }
  });

  it('covers a full room polling for its maximum lifetime', () => {
    // Relay Connect: up to 8 seats, rooms live up to 43,200 minutes, and a
    // seat polls deliveries every 3s plus a heartbeat every 30s.
    const seats = 8;
    const minutes = 43_200;
    const callsPerSeatPerMinute = 60 / 3 + 60 / 30;
    expect(PLAN_LIMITS.connect!.api_calls).toBeGreaterThanOrEqual(seats * minutes * callsPerSeatPerMinute);
    expect(PLAN_LIMITS.connect!.rate_per_min).toBeGreaterThanOrEqual(seats * callsPerSeatPerMinute);
  });

  it('falls back to the default plan for an unknown plan', async () => {
    const provider = new StaticEntitlementsProvider(undefined, 'free');
    expect(await provider.getLimits(workspace('platinum'))).toBe(PLAN_LIMITS.free);
  });
});
