import type { KeyValueStore } from '../ports/kv.js';

const KEY_PREFIX = 'workspace-stream:';
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

export async function getWorkspaceStreamConfig(
  kv: KeyValueStore,
  workspaceId: string,
  defaultEnabled: boolean = DEFAULT_ENABLED,
): Promise<{ enabled: boolean; defaultEnabled: boolean; override: boolean | null }> {
  const now = Date.now();
  const cached = cache.get(workspaceId);
  if (cached && cached.expiresAt > now) {
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

export async function isWorkspaceStreamEnabled(
  kv: KeyValueStore,
  workspaceId: string,
  defaultEnabled: boolean = DEFAULT_ENABLED,
): Promise<boolean> {
  const cfg = await getWorkspaceStreamConfig(kv, workspaceId, defaultEnabled);
  return cfg.enabled;
}

export async function setWorkspaceStreamOverride(
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
