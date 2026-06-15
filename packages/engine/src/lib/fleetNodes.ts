import type { KeyValueStore } from '../ports/kv.js';

/**
 * Per-workspace rollout flag for the fleet node control surface (Phase 6).
 *
 * The node registry, node control WS, declarative triggers, and spawn/node-action
 * placement are all gated behind this flag so the feature can be dark-launched and
 * enabled workspace-by-workspace during migration. The default is OFF: a workspace
 * with no explicit override inherits the engine-wide default
 * (`EngineConfig.fleetNodesEnabled`, also false unless the deployment opts in).
 *
 * Mirrors {@link ./workspaceStream.ts} — a KV override with a short in-memory cache,
 * so the hot paths (every message post, every node frame) pay at most one KV read
 * per workspace per {@link CACHE_TTL_MS} window.
 */

const KEY_PREFIX = 'fleet-nodes-enabled:';
const CACHE_TTL_MS = 10_000;
const DEFAULT_ENABLED = false;

type CacheEntry = {
  enabled: boolean;
  defaultEnabled: boolean;
  override: boolean | null;
  expiresAt: number;
};

const cache = new Map<string, CacheEntry>();

function parseBool(value: string | null | undefined): boolean | null {
  if (value == null) return null;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return null;
}

function getKey(workspaceId: string): string {
  return `${KEY_PREFIX}${workspaceId}`;
}

export async function getFleetNodesConfig(
  kv: KeyValueStore,
  workspaceId: string,
  defaultEnabled: boolean = DEFAULT_ENABLED,
): Promise<{ enabled: boolean; defaultEnabled: boolean; override: boolean | null }> {
  const now = Date.now();
  const cached = cache.get(workspaceId);
  if (cached && cached.expiresAt > now && cached.defaultEnabled === defaultEnabled) {
    return {
      enabled: cached.enabled,
      defaultEnabled: cached.defaultEnabled,
      override: cached.override,
    };
  }

  const raw = await kv.get(getKey(workspaceId));
  const override = parseBool(raw);
  const enabled = override ?? defaultEnabled;

  cache.set(workspaceId, {
    enabled,
    defaultEnabled,
    override,
    expiresAt: now + CACHE_TTL_MS,
  });

  return { enabled, defaultEnabled, override };
}

export async function isFleetNodesEnabled(
  kv: KeyValueStore,
  workspaceId: string,
  defaultEnabled: boolean = DEFAULT_ENABLED,
): Promise<boolean> {
  const cfg = await getFleetNodesConfig(kv, workspaceId, defaultEnabled);
  return cfg.enabled;
}

export async function setFleetNodesOverride(
  kv: KeyValueStore,
  workspaceId: string,
  override: boolean | null,
): Promise<void> {
  const key = getKey(workspaceId);
  if (override === null) {
    await kv.delete(key);
  } else {
    await kv.put(key, override ? 'true' : 'false');
  }
  cache.delete(workspaceId);
}
