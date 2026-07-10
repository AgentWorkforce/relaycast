import { Resource } from "sst";
import { eq } from "drizzle-orm";
import type { getDb } from "@/lib/db";
import { users } from "@/lib/db/schema";

const DEFAULT_CLOUD_AGENT_SPAWN_QUOTA = 8;
const MIN_CLOUD_AGENT_SPAWN_QUOTA = 1;
const MAX_CLOUD_AGENT_SPAWN_QUOTA = 256;

type Db = ReturnType<typeof getDb>;

function readCloudAgentSpawnQuotaDefaultResource(): string | undefined {
  const proxy = Resource as unknown as Record<string, { value?: unknown } | undefined>;
  try {
    const value = proxy.CloudAgentSpawnQuotaDefault?.value;
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function parseQuota(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(MIN_CLOUD_AGENT_SPAWN_QUOTA, Math.min(MAX_CLOUD_AGENT_SPAWN_QUOTA, parsed));
}

export function getDefaultCloudAgentSpawnQuota(): number {
  return (
    parseQuota(readCloudAgentSpawnQuotaDefaultResource()) ??
    parseQuota(process.env.CLOUD_AGENT_SPAWN_QUOTA_DEFAULT) ??
    DEFAULT_CLOUD_AGENT_SPAWN_QUOTA
  );
}

export async function getEffectiveCloudAgentSpawnQuota(
  db: Db,
  userId: string,
): Promise<number> {
  const defaultQuota = getDefaultCloudAgentSpawnQuota();
  const [row] = await db
    .select({ override: users.cloudAgentSpawnQuotaOverride })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return row?.override ?? defaultQuota;
}

export function assertCloudAgentSpawnQuota(count: number, quota: number): void {
  if (count > quota) {
    throw new Error(`Requested ${count} cloud agents exceeds quota of ${quota}`);
  }
}
