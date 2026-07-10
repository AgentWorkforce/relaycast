import type { RelayfileTriggerDescriptor, RelayfileTriggerIntegrations } from "../relayfile/path-scopes.js";
import { resolveRelayfileProviderContract } from "../relayfile/provider-contracts.js";

export type DeploymentAgentSpec = Record<string, unknown> & {
  triggers?: Record<string, RelayfileTriggerDescriptor[]>;
  schedules?: unknown[];
  watch?: unknown[];
};

export type DeploymentSpecSnapshot = {
  persona: Record<string, unknown>;
  agent: DeploymentAgentSpec;
  sandbox?: boolean;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isDeploymentSpecSnapshot(value: unknown): value is DeploymentSpecSnapshot {
  return isRecord(value) && isRecord(value.persona) && isRecord(value.agent);
}

export function deploymentPersonaSpec(value: unknown): Record<string, unknown> | null {
  if (isDeploymentSpecSnapshot(value)) {
    return value.persona;
  }
  return isRecord(value) ? value : null;
}

export function deploymentAgentSpec(value: unknown): DeploymentAgentSpec | null {
  return isDeploymentSpecSnapshot(value) ? value.agent : null;
}

function normalizeTriggerArray(value: unknown): RelayfileTriggerDescriptor[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const triggers = value.filter(
    (entry): entry is RelayfileTriggerDescriptor =>
      typeof entry === "string" || isRecord(entry),
  );
  return triggers.length > 0 ? triggers : undefined;
}

function triggerIntegrationsFromAgent(agent: unknown): RelayfileTriggerIntegrations | undefined {
  if (!isRecord(agent) || !isRecord(agent.triggers)) {
    return undefined;
  }

  const integrations = new Map<string, { triggers?: RelayfileTriggerDescriptor[] }>();
  for (const [provider, rawTriggers] of Object.entries(agent.triggers)) {
    const normalizedProvider = provider.trim().toLowerCase();
    const triggers = normalizeTriggerArray(rawTriggers);
    if (normalizedProvider && triggers) {
      integrations.set(normalizedProvider, { triggers });
    }
  }
  return integrations.size > 0 ? Object.fromEntries(integrations) : undefined;
}

function triggerIntegrationsFromLegacyPersonaIntegrations(
  integrations: unknown,
): RelayfileTriggerIntegrations | undefined {
  if (!isRecord(integrations)) {
    return undefined;
  }

  const out = new Map<string, { triggers?: RelayfileTriggerDescriptor[] }>();
  for (const [provider, config] of Object.entries(integrations)) {
    const normalizedProvider = provider.trim().toLowerCase();
    if (!normalizedProvider || !isRecord(config)) {
      continue;
    }
    const triggers = normalizeTriggerArray(config.triggers);
    if (triggers) {
      out.set(normalizedProvider, { triggers });
    }
  }
  return out.size > 0 ? Object.fromEntries(out) : undefined;
}

export function relayfileTriggerIntegrationsFromAgentOrLegacy(input: {
  agent?: unknown;
  integrations?: unknown;
}): RelayfileTriggerIntegrations | undefined {
  if (input.agent !== undefined) {
    return triggerIntegrationsFromAgent(input.agent);
  }
  return triggerIntegrationsFromLegacyPersonaIntegrations(input.integrations);
}

export function relayfileTriggerIntegrationsFromDeploymentSpec(
  spec: unknown,
): RelayfileTriggerIntegrations | undefined {
  const agent = deploymentAgentSpec(spec);
  if (agent) {
    return triggerIntegrationsFromAgent(agent);
  }

  const persona = deploymentPersonaSpec(spec);
  return triggerIntegrationsFromLegacyPersonaIntegrations(persona?.integrations);
}

export function providerTriggersFromDeploymentSpec(
  spec: unknown,
  provider: string,
): RelayfileTriggerDescriptor[] {
  const contract = resolveRelayfileProviderContract(provider);
  const integrations = relayfileTriggerIntegrationsFromDeploymentSpec(spec) ?? {};
  const triggers: RelayfileTriggerDescriptor[] = [];
  for (const [candidateProvider, config] of Object.entries(integrations)) {
    const candidateContract = resolveRelayfileProviderContract(candidateProvider);
    if (!contract || !candidateContract || candidateContract.id !== contract.id) {
      continue;
    }
    for (const trigger of normalizeTriggerArray(config.triggers) ?? []) {
      triggers.push(trigger);
    }
  }
  return triggers;
}
