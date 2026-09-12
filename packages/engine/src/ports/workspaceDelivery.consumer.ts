// Public consumer compile regression: included in the normal engine typecheck.
import type { EngineConfig } from './index.js';
export const asyncPolicyConsumer = {
  workspaceDelivery: {
    resolve: async (workspace) => {
      await Promise.resolve();
      return workspace.plan === 'enterprise' && workspace.id ? { cap: 5000, reserve: 0 } : undefined;
    },
  },
} satisfies EngineConfig;
