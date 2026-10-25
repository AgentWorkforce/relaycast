import { describe, expect, it } from 'vitest';
import { PLAN_LIMITS, StaticEntitlementsProvider } from '../static-entitlements.js';
import { applyWorkspacePlanLimits } from '../../engine/planCapacity.js';
import type { Workspace, WorkspacePlanLimits } from '../../ports/index.js';

function workspace(plan: string, planLimits: WorkspacePlanLimits | null = null): Workspace {
  return { id: 'ws_1', plan, planLimits } as Workspace;
}

describe('StaticEntitlementsProvider', () => {
  it('resolves the connect profile for room workspaces', async () => {
    const provider = new StaticEntitlementsProvider(undefined, 'free');
    const limits = await provider.getLimits(workspace('connect'));
    expect(limits).toBe(PLAN_LIMITS.connect);
    expect(limits.api_calls).toBe(10_000_000);
  });

  it('sizes connect between free and pro on every metered metric', () => {
    for (const metric of ['messages', 'file_bytes', 'api_calls', 'rate_per_min'] as const) {
      expect(PLAN_LIMITS.connect![metric]).toBeGreaterThan(PLAN_LIMITS.free![metric]);
    }
    for (const metric of ['messages', 'file_bytes', 'rate_per_min'] as const) {
      expect(PLAN_LIMITS.connect![metric]).toBeLessThan(PLAN_LIMITS.pro![metric]);
    }
    // Rooms poll constantly; connect's call budget is set to pro's for
    // headroom, while its other limits stay below pro.
    expect(PLAN_LIMITS.connect!.api_calls).toBeLessThanOrEqual(PLAN_LIMITS.pro!.api_calls);
  });

  it('carries the billing tiers\' registration caps', () => {
    expect(PLAN_LIMITS.intro).toMatchObject({ devices: 5, agents: 15, humans: 2 });
    expect(PLAN_LIMITS.pro).toMatchObject({ devices: 15, agents: 60, humans: 10 });
    expect(PLAN_LIMITS.enterprise).toMatchObject({ devices: null, agents: Infinity, humans: null });
    // Legacy hosted tiers predate registration caps and carry none.
    for (const plan of ['free', 'connect', 'selfhost'] as const) {
      expect(PLAN_LIMITS[plan]).toMatchObject({ devices: null, agents: Infinity, humans: null });
    }
  });

  it('falls back to the default plan for an unknown plan', async () => {
    const provider = new StaticEntitlementsProvider(undefined, 'free');
    expect(await provider.getLimits(workspace('platinum'))).toBe(PLAN_LIMITS.free);
  });

  it('overlays the workspace row\'s plan_limits on the plan table', async () => {
    const provider = new StaticEntitlementsProvider(undefined, 'free');
    const limits = await provider.getLimits(workspace('intro', { devices: 7, humans: null, session_retention_days: 7 }));
    expect(limits).toMatchObject({ devices: 7, humans: null, agents: 15, api_calls: PLAN_LIMITS.intro!.api_calls });
  });

  it('reports a registration count of zero without a database handle', async () => {
    const provider = new StaticEntitlementsProvider(undefined, 'intro');
    await expect(provider.getUsage('ws_1', 'devices')).resolves.toBe(0);
  });
});

describe('applyWorkspacePlanLimits', () => {
  const base = PLAN_LIMITS.intro!;

  it('returns the plan unchanged without overrides', () => {
    expect(applyWorkspacePlanLimits(base, null)).toBe(base);
    expect(applyWorkspacePlanLimits(base, undefined)).toBe(base);
    expect(applyWorkspacePlanLimits(base, {})).toEqual(base);
  });

  it('treats a present null as unlimited and an absent key as the plan value', () => {
    expect(applyWorkspacePlanLimits(base, { devices: null, agents: null })).toMatchObject({
      devices: null,
      agents: Infinity,
      humans: 2,
    });
  });

  it('keeps the plan value for a malformed override', () => {
    const overrides = { devices: -1, agents: 'ten', humans: Number.NaN } as unknown as WorkspacePlanLimits;
    expect(applyWorkspacePlanLimits(base, overrides)).toEqual(base);
  });
});
