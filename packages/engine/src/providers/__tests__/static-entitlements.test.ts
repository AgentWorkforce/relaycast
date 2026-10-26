import { describe, expect, it } from 'vitest';
import { StaticEntitlementsProvider } from '../static-entitlements.js';
import { UNLIMITED_LIMITS, resolveLimits } from '../../ports/entitlements.js';
import type { EngineDb, Workspace } from '../../ports/index.js';

const workspace = { id: 'ws_1', plan: 'anything' } as Workspace;

describe('StaticEntitlementsProvider', () => {
  it('is unlimited by default, whatever the workspace row says', async () => {
    const provider = new StaticEntitlementsProvider();
    await expect(provider.getLimits(workspace)).resolves.toEqual(UNLIMITED_LIMITS);
    await expect(provider.getLimits({ id: 'ws_2', plan: 'other' } as Workspace)).resolves.toEqual(UNLIMITED_LIMITS);
  });

  it('applies the operator\'s configured limits over unlimited', async () => {
    const provider = new StaticEntitlementsProvider(undefined, { devices: 5, rate_per_min: 600 }, {} as EngineDb);
    await expect(provider.getLimits(workspace)).resolves.toEqual({
      ...UNLIMITED_LIMITS,
      devices: 5,
      rate_per_min: 600,
    });
  });

  it('carries no tier names or numbers of its own', () => {
    for (const value of Object.values(UNLIMITED_LIMITS)) expect(value).toBeNull();
    expect(Object.keys(UNLIMITED_LIMITS).sort()).toEqual([
      'agents', 'api_calls', 'devices', 'file_bytes', 'humans', 'message_retention_days', 'messages', 'rate_per_min',
    ]);
  });

  it('refuses registration caps it has no database to count against', () => {
    expect(() => new StaticEntitlementsProvider(undefined, { devices: 1 }))
      .toThrow(/registration caps \(devices\) require a database handle/);
    // Metered-only limits need no database.
    expect(() => new StaticEntitlementsProvider(undefined, { rate_per_min: 60 })).not.toThrow();
  });

  it('reports zero metered usage without a key/value store', async () => {
    const provider = new StaticEntitlementsProvider();
    await expect(provider.getUsage('ws_1', 'api_calls')).resolves.toBe(0);
  });
});

describe('resolveLimits', () => {
  it('fills absent keys with unlimited', () => {
    expect(resolveLimits()).toEqual(UNLIMITED_LIMITS);
    expect(resolveLimits(null)).toEqual(UNLIMITED_LIMITS);
    expect(resolveLimits({ agents: 3 })).toEqual({ ...UNLIMITED_LIMITS, agents: 3 });
  });

  it('keeps an explicit null as unlimited', () => {
    expect(resolveLimits({ agents: null, humans: 2 })).toEqual({ ...UNLIMITED_LIMITS, humans: 2 });
  });
});
