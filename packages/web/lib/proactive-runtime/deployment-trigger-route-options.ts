import type { DeploymentTriggerDeliveryOptions } from "@/lib/proactive-runtime/deployment-trigger-delivery";

export const DEPLOYMENT_TRIGGER_DELIVERY_OPTIONS = {
  sandboxCreateTimeoutSeconds: 120,
  runScriptTimeoutMs: 15_000,
  asyncRunScript: true,
} satisfies DeploymentTriggerDeliveryOptions;
