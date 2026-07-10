import { PLAN_LIMITS } from '@relaycast/engine';
import type {
  EntitlementsProvider,
  KeyValueStore,
  PlanLimits,
  UsageMetric,
  Workspace,
} from '@relaycast/engine/ports';

const CLOUD_DEFAULT_PLAN = 'free';

export class CloudflareEntitlementsProvider implements EntitlementsProvider {
  constructor(private readonly kv: KeyValueStore) {}

  async getLimits(workspace: Workspace): Promise<PlanLimits> {
    const plan = workspace.plan || CLOUD_DEFAULT_PLAN;
    return PLAN_LIMITS[plan] ?? PLAN_LIMITS[CLOUD_DEFAULT_PLAN];
  }

  async getUsage(workspaceId: string, metric: UsageMetric): Promise<number> {
    try {
      const raw = await this.kv.get(`usage:${workspaceId}:${metric}`);
      return parseInt(raw || '0', 10) || 0;
    } catch {
      return 0;
    }
  }
}

