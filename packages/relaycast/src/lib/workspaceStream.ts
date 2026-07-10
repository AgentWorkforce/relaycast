import type { CloudflareBindings } from '../env.js';

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
  env: CloudflareBindings,
  workspaceId: string,
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

  const defaultEnabled = DEFAULT_ENABLED;
  const raw = await env.KV.get(getKey(workspaceId));
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
  env: CloudflareBindings,
  workspaceId: string,
): Promise<boolean> {
  const cfg = await getWorkspaceStreamConfig(env, workspaceId);
  return cfg.enabled;
}

export async function setWorkspaceStreamOverride(
  env: CloudflareBindings,
  workspaceId: string,
  override: boolean | null,
): Promise<void> {
  const key = getKey(workspaceId);
  if (override === null) {
    await env.KV.delete(key);
  } else {
    await env.KV.put(key, override ? 'true' : 'false');
  }
  cache.delete(workspaceId);
}
