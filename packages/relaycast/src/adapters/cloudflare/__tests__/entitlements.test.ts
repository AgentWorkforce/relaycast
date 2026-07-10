import { describe, expect, it } from 'vitest';
import type { KeyValueStore, Workspace } from '@relaycast/engine/ports';
import { CloudflareEntitlementsProvider } from '../entitlements.js';

function createKv(initial: Record<string, string> = {}): KeyValueStore {
  const values = new Map(Object.entries(initial));

  return {
    async get(key) {
      return values.get(key) ?? null;
    },
    async put(key, value) {
      values.set(key, value);
    },
    async delete(key) {
      values.delete(key);
    },
    async increment(key, delta) {
      const next = parseInt(values.get(key) ?? '0', 10) + delta;
      values.set(key, String(next));
      return next;
    },
  };
}

function workspace(plan: string | null): Workspace {
  return {
    id: 'ws_123',
    name: 'test',
    apiKeyHash: 'hash',
    ownerApiKeyHash: null,
    plan,
    systemPrompt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as Workspace;
}

describe('CloudflareEntitlementsProvider', () => {
  it('preserves paid workspace plans from the workspace row', async () => {
    const provider = new CloudflareEntitlementsProvider(createKv());

    await expect(provider.getLimits(workspace('pro'))).resolves.toMatchObject({
      messages: 1_000_000,
      agents: 100,
      rate_per_min: 6000,
    });

    await expect(provider.getLimits(workspace('enterprise'))).resolves.toMatchObject({
      messages: Infinity,
      agents: Infinity,
      rate_per_min: 30000,
    });
  });

  it('defaults hosted workspaces without a recognized plan to the free tier', async () => {
    const provider = new CloudflareEntitlementsProvider(createKv());

    await expect(provider.getLimits(workspace(null))).resolves.toMatchObject({
      messages: 10_000,
      agents: 5,
      rate_per_min: 300,
    });
    await expect(provider.getLimits(workspace('unknown'))).resolves.toMatchObject({
      messages: 10_000,
      agents: 5,
      rate_per_min: 300,
    });
  });

  it('reads usage counters from the injected KV store', async () => {
    const provider = new CloudflareEntitlementsProvider(createKv({
      'usage:ws_123:messages': '42',
    }));

    await expect(provider.getUsage('ws_123', 'messages')).resolves.toBe(42);
    await expect(provider.getUsage('ws_123', 'agents')).resolves.toBe(0);
  });
});

