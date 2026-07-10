import { Resource } from "sst";

import { optionalEnv } from "../env";
import type {
  IntegrationBackend,
  ProviderBackendConfig,
} from "./backend/types";

export class BackendNotConfiguredError extends Error {
  constructor(public readonly backend: IntegrationBackend) {
    super(`backend not configured: ${backend}`);
    this.name = "BackendNotConfiguredError";
  }
}

export class BackendNotAllowedError extends Error {
  constructor(
    public readonly backend: IntegrationBackend,
    public readonly provider: string,
  ) {
    super(`backend ${backend} not allowed for provider ${provider}`);
    this.name = "BackendNotAllowedError";
  }
}

function nonEmptyValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function allowLocalEnvSecretFallback(): boolean {
  const stage = optionalEnv("NEXT_PUBLIC_SST_STAGE") ?? optionalEnv("SST_STAGE");
  return (
    stage === "development" ||
    process.env.NODE_ENV === "development" ||
    process.env.NODE_ENV === "test"
  );
}

function localEnvSecret(name: string): string | undefined {
  return allowLocalEnvSecretFallback() ? optionalEnv(name) : undefined;
}

function readNangoSecretKey(): string | undefined {
  try {
    return (
      nonEmptyValue(Resource.NangoSecretKey.value) ??
      localEnvSecret("NANGO_SECRET_KEY")
    );
  } catch {
    return localEnvSecret("NANGO_SECRET_KEY");
  }
}

function readComposioApiKey(): string | undefined {
  try {
    const resource = Resource as unknown as Record<string, { value?: unknown }>;
    return (
      nonEmptyValue(resource.ComposioApiKey?.value) ??
      localEnvSecret("COMPOSIO_API_KEY")
    );
  } catch {
    return localEnvSecret("COMPOSIO_API_KEY");
  }
}

export function resolveProviderBackendConfig(
  backend: IntegrationBackend,
): ProviderBackendConfig {
  switch (backend) {
    case "nango": {
      const apiKey = readNangoSecretKey();
      if (!apiKey) {
        throw new BackendNotConfiguredError(backend);
      }

      const baseUrl = optionalEnv("NANGO_HOST");
      return {
        backend,
        apiKey,
        ...(baseUrl ? { baseUrl } : {}),
      };
    }

    case "composio": {
      const apiKey = readComposioApiKey();
      if (!apiKey) {
        throw new BackendNotConfiguredError(backend);
      }

      const baseUrl = optionalEnv("COMPOSIO_BASE_URL");
      return {
        backend,
        apiKey,
        ...(baseUrl ? { baseUrl } : {}),
      };
    }

    default: {
      const unreachableBackend: never = backend;
      throw new Error(
        `Unknown integration backend: ${String(unreachableBackend)}`,
      );
    }
  }
}
