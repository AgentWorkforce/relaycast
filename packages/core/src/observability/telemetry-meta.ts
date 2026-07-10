export type TelemetryMeta = {
  service: string;
  environment: string;
  version: string;
  deployId?: string;
};

type VersionMetadata = {
  id?: unknown;
  tag?: unknown;
  timestamp?: unknown;
};

type TelemetryEnv = {
  ENVIRONMENT?: string;
  SST_STAGE?: string;
  NEXT_PUBLIC_SST_STAGE?: string;
  DEPLOY_VERSION?: string;
  DEPLOY_ID?: string;
  CF_VERSION_METADATA?: VersionMetadata;
};

function trimmed(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function resolveTelemetryMeta(
  env: TelemetryEnv,
  serviceName: string,
): TelemetryMeta {
  const versionMetadata = env.CF_VERSION_METADATA;
  const deployId = trimmed(env.DEPLOY_ID) ?? trimmed(versionMetadata?.tag);

  return {
    service: serviceName,
    environment:
      trimmed(env.ENVIRONMENT)
      ?? trimmed(env.SST_STAGE)
      ?? trimmed(env.NEXT_PUBLIC_SST_STAGE)
      ?? "dev",
    version:
      trimmed(env.DEPLOY_VERSION)
      ?? trimmed(versionMetadata?.id)
      ?? trimmed(env.SST_STAGE)
      ?? "unknown",
    ...(deployId ? { deployId } : {}),
  };
}

export function newRequestId(): string {
  return `req_${crypto.randomUUID()}`;
}
