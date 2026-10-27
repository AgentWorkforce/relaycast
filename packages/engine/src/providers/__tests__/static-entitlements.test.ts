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
    // Rooms poll constantly; connect's call budget is set to pro's for
    // headroom, while its other limits stay below pro.
    expect(PLAN_LIMITS.connect!.api_calls).toBeLessThanOrEqual(PLAN_LIMITS.pro!.api_calls);
  });

  it('gives the anonymous trial a one-time 100-message allowance and no wider limit than free', async () => {
    const provider = new StaticEntitlementsProvider(undefined, 'free');
    const trial = await provider.getLimits(workspace('trial'));
    expect(trial).toBe(PLAN_LIMITS.trial);
    expect(trial.lifetime_messages).toBe(100);
    for (const metric of ['messages', 'agents', 'file_bytes', 'api_calls', 'rate_per_min'] as const) {
      expect(trial[metric]).toBeLessThanOrEqual(PLAN_LIMITS.free![metric]);
    }
  });

  it('keeps every other tier free of a lifetime allowance', () => {
    for (const plan of ['free', 'connect', 'pro', 'enterprise', 'selfhost']) {
      expect(PLAN_LIMITS[plan]!.lifetime_messages).toBeUndefined();
    }
    expect(PLAN_LIMITS.free!.messages).toBe(10_000);
    expect(PLAN_LIMITS.selfhost!.messages).toBe(Infinity);
  });

  it('falls back to the default plan for an unknown plan', async () => {
    const provider = new StaticEntitlementsProvider(undefined, 'free');
    expect(await provider.getLimits(workspace('platinum'))).toBe(PLAN_LIMITS.free);
  });
});
