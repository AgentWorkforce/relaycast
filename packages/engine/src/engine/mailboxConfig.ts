import type { EngineConfig } from '../ports/index.js';

export const DEFAULT_MAILBOX_TTL_MS = 60 * 60 * 1000;
export const DEFAULT_MAILBOX_DEPTH_CAP = 1000;

export interface MailboxConfig {
  ttlMs: number;
  depthCap: number;
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

export function resolveMailboxConfig(config: EngineConfig | undefined, workspaceId: string): MailboxConfig {
  const globalConfig = config?.mailbox;
  const workspaceConfig = globalConfig?.workspaces?.[workspaceId];
  return {
    ttlMs: positiveInt(workspaceConfig?.deliveryTtlMs ?? globalConfig?.deliveryTtlMs, DEFAULT_MAILBOX_TTL_MS),
    depthCap: positiveInt(workspaceConfig?.depthCap ?? globalConfig?.depthCap, DEFAULT_MAILBOX_DEPTH_CAP),
  };
}
