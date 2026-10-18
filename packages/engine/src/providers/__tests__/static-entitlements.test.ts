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
    expect(limits.api_calls).toBe(10_000_000);
    expect(limits.agents).toBe(10);
  });

  it('sizes connect between free and pro on every metric', () => {
    for (const metric of ['messages', 'agents', 'file_bytes', 'api_calls', 'rate_per_min'] as const) {
      expect(PLAN_LIMITS.connect![metric]).toBeGreaterThan(PLAN_LIMITS.free![metric]);
    }
    for (const metric of ['messages', 'agents', 'file_bytes', 'rate_per_min'] as const) {
      expect(PLAN_LIMITS.connect![metric]).toBeLessThan(PLAN_LIMITS.pro![metric]);
    }
    // A full 10-seat room polling for its whole 7-day life needs pro's monthly
    // call budget, so connect matches it rather than sitting below it.
    expect(PLAN_LIMITS.connect!.api_calls).toBeLessThanOrEqual(PLAN_LIMITS.pro!.api_calls);
  });

  it('falls back to the default plan for an unknown plan', async () => {
    const provider = new StaticEntitlementsProvider(undefined, 'free');
    expect(await provider.getLimits(workspace('platinum'))).toBe(PLAN_LIMITS.free);
  });
});
