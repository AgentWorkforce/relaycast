import {
  inferSecretEnvVarName,
  readWorkspaceSecret,
} from "@/lib/proactive-runtime/secret-store";
import { tryResourceValue } from "@/lib/env";

export type HostedProviderConfig = {
  mode: "managed" | "byok";
  secretRef?: string;
};

export type ManagedProviderResolutionSource = "web-deploy-manager";

type HostedProviderKind = "openai" | "anthropic" | "openrouter" | "google";

const PROVIDER_API_KEY_ENV: Record<HostedProviderKind, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  google: "GOOGLE_API_KEY",
};

const MANAGED_ENV_ALLOWLIST: Record<HostedProviderKind, string[]> = {
  openai: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_API_BASE"],
  anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"],
  openrouter: ["OPENROUTER_API_KEY", "OPENAI_BASE_URL", "OPENAI_API_BASE"],
  google: ["GOOGLE_API_KEY", "GOOGLE_API_BASE"],
};

const MANAGED_RESOURCE_BY_ENV: Partial<Record<string, string>> = {
  OPENROUTER_API_KEY: "SpecialistOpenrouterApiKey",
};

export function inferHostedProviderKind(
  model: string,
  secretRef?: string,
): HostedProviderKind {
  const normalizedModel = model.trim().toLowerCase();
  const normalizedSecretRef = secretRef?.trim().toLowerCase() ?? "";

  if (normalizedSecretRef.includes("openrouter") || normalizedModel.startsWith("openrouter/")) {
    return "openrouter";
  }
  if (
    normalizedSecretRef.includes("anthropic")
    || normalizedSecretRef.includes("claude")
    || normalizedModel.startsWith("claude")
    || normalizedModel.startsWith("anthropic/")
  ) {
    return "anthropic";
  }
  if (
    normalizedSecretRef.includes("google")
    || normalizedSecretRef.includes("gemini")
    || normalizedModel.startsWith("gemini")
    || normalizedModel.startsWith("google/")
  ) {
    return "google";
  }
  return "openai";
}

function readManagedEnvironmentValue(key: string): string | undefined {
  const resourceName = MANAGED_RESOURCE_BY_ENV[key];
  const resourceValue = resourceName ? tryResourceValue(resourceName)?.trim() : undefined;
  if (resourceValue) {
    return resourceValue;
  }

  const envValue = process.env[key]?.trim();
  return envValue || undefined;
}

function pickManagedEnvironment(
  kind: HostedProviderKind,
  source: ManagedProviderResolutionSource | undefined,
): Record<string, string> {
  if (source !== "web-deploy-manager") {
    throw new Error(
      "Managed provider credentials may only be resolved from the web deploy-manager runtime",
    );
  }

  const envVars: Record<string, string> = {};
  for (const key of MANAGED_ENV_ALLOWLIST[kind]) {
    const value = readManagedEnvironmentValue(key);
    if (value) {
      envVars[key] = value;
    }
  }

  if (!envVars[PROVIDER_API_KEY_ENV[kind]]) {
    throw new Error(`Managed provider credentials for ${kind} are not configured`);
  }

  return envVars;
}

export async function resolveHostedProviderEnvironment(input: {
  relayWorkspaceId: string;
  model: string;
  provider: HostedProviderConfig;
  managedResolutionSource?: ManagedProviderResolutionSource;
  deploymentId?: string;
  agentId?: string;
}): Promise<Record<string, string>> {
  const kind = inferHostedProviderKind(input.model, input.provider.secretRef);

  if (input.provider.mode === "managed") {
    return pickManagedEnvironment(kind, input.managedResolutionSource);
  }

  const secretRef = input.provider.secretRef?.trim();
  if (!secretRef) {
    throw new Error("provider.secretRef is required when provider.mode is byok");
  }

  const stored = await readWorkspaceSecret(input.relayWorkspaceId, secretRef, {
    includeValue: true,
    provider: kind,
    deploymentId: input.deploymentId,
    agentId: input.agentId,
    source: "hosted-provider",
  });
  if (!stored?.value) {
    throw new Error(`Workspace secret ${secretRef} is not configured`);
  }

  return {
    [(stored.envVar?.trim() || PROVIDER_API_KEY_ENV[kind] || inferSecretEnvVarName(secretRef))]: stored.value,
  };
}
