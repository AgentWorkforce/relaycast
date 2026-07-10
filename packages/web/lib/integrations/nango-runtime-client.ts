import { Resource } from "sst";
import { Nango } from "@nangohq/node";
import { optionalEnv } from "../env";
import {
  getWorkspaceIntegrationProviderDefinition,
  type WorkspaceIntegrationProvider,
} from "./providers";

const DEFAULT_NANGO_HOST = "https://api.nango.dev";
let nangoClient: Nango | null = null;

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function resolveOverrideProviderConfigKey(
  envName: string,
  canonicalKey: string,
  aliases: readonly string[],
): string | null {
  const configured = optionalEnv(envName);
  if (!configured) {
    return null;
  }
  if (configured === canonicalKey) {
    return configured;
  }
  if (aliases.includes(configured)) {
    console.warn(
      `${envName} is set to a demoted alias (${configured}); ignoring in favor of registry canonical key ${canonicalKey}. Unset the env var on this deployment.`,
    );
    return null;
  }
  console.warn(
    `${envName} is set to an unrecognized value (${configured}); ignoring in favor of registry canonical key ${canonicalKey}.`,
  );
  return null;
}

export function getNangoHost(): string {
  return trimTrailingSlash(
    optionalEnv("NANGO_HOST") ?? DEFAULT_NANGO_HOST,
  );
}

export function getNangoSecretKey(): string | null {
  try {
    return Resource.NangoSecretKey.value;
  } catch {
    return optionalEnv("NANGO_SECRET_KEY") ?? null;
  }
}

export function getNangoClient(): Nango {
  if (!nangoClient) {
    const secretKey = getNangoSecretKey();
    if (!secretKey) {
      throw new Error("NANGO_SECRET_KEY is not configured.");
    }

    nangoClient = new Nango({
      secretKey,
      host: getNangoHost(),
    });
  }

  return nangoClient;
}

export function getProviderConfigKey(
  provider: WorkspaceIntegrationProvider,
): string {
  const definition = getWorkspaceIntegrationProviderDefinition(provider);
  const canonicalKey = definition.defaultConfigKey;
  const override = resolveOverrideProviderConfigKey(
    `NANGO_${provider.toUpperCase()}_PROVIDER_CONFIG_KEY`,
    canonicalKey,
    definition.aliases,
  );
  return override ?? canonicalKey;
}
