export interface S3Credentials {
  backend?: "s3" | "cloud-api"
  accessKeyId: string
  secretAccessKey: string
  sessionToken: string
  bucket: string
  prefix: string
  cloudApiUrl?: string
  cloudApiAccessToken?: string
  cloudApiRefreshToken?: string
}

// Daytona auth helpers live in Cloud's Daytona runtime adapter. This file
// re-exports them so existing internal callers compile unchanged.
export {
  resolveDaytonaAuthCredentials,
  applyDaytonaAuthEnv,
} from "@cloud/daytona-runner"
export type {
  DaytonaAuthCredentials,
  ResolvedDaytonaAuthCredentials,
} from "@cloud/daytona-runner"

// Canonical relaycast gateway (relaycast-cloud, agentrelay.com zone) injected as
// RELAY_BASE_URL when a launch doesn't supply one. Prod supplies the resolved
// gateway explicitly via resolveRelaycastUrl().
export const DEFAULT_RELAY_BASE_URL = "https://cast.agentrelay.com"

export interface CredentialBundle {
  s3Credentials: S3Credentials
  cliCredentials: string
  credentialProxyUrl?: string
  credentialProxyTokens?: Record<string, string>
  workspaceId: string
  relayApiKey: string
  /**
   * Relaycast base URL the `relayApiKey` was minted against. Threaded into
   * the per-agent sandbox as `RELAY_BASE_URL` so `agent-relay mcp-args
   * --register` can reach the right relaycast backend. Defaults to
   * DEFAULT_RELAY_BASE_URL when unset.
   */
  relayBaseUrl: string
  runId: string
  userId: string
  cloudApiUrl?: string
  cloudApiAccessToken?: string
  cloudApiRefreshToken?: string
  cloudApiAccessTokenExpiresAt?: string
  callbackUrl?: string
  callbackToken?: string
  daytonaApiKey?: string
  daytonaJwtToken?: string
  daytonaOrganizationId?: string
  s3CodeKey?: string
  workflowConfig?: string
}

export interface StepCredentials {
  s3Credentials: S3Credentials
  cliCredentials: string
  credentialProxyUrl?: string
  credentialProxyTokens?: Record<string, string>
  workspaceId: string
  relayApiKey: string
  relayBaseUrl: string
  runId: string
  userId: string
  sandboxId: string
  cloudApiUrl?: string
  cloudApiAccessToken?: string
  cloudApiRefreshToken?: string
  cloudApiAccessTokenExpiresAt?: string
}

export function buildCredentialBundle(params: {
  s3Credentials: S3Credentials
  cliCredentials: string
  credentialProxyUrl?: string
  credentialProxyTokens?: Record<string, string>
  workspaceId: string
  relayApiKey: string
  relayBaseUrl?: string
  runId: string
  userId: string
  cloudApiUrl?: string
  cloudApiAccessToken?: string
  cloudApiRefreshToken?: string
  cloudApiAccessTokenExpiresAt?: string
  callbackUrl?: string
  callbackToken?: string
  daytonaApiKey?: string
  daytonaJwtToken?: string
  daytonaOrganizationId?: string
  s3CodeKey?: string
  workflowConfig?: string
}): CredentialBundle {
  const relayBaseUrl = params.relayBaseUrl?.trim() || DEFAULT_RELAY_BASE_URL
  return {
    ...params,
    relayBaseUrl,
  }
}

export function buildStepCredentials(bundle: CredentialBundle, sandboxId: string): StepCredentials {
  return {
    s3Credentials: bundle.s3Credentials,
    cliCredentials: bundle.cliCredentials,
    credentialProxyUrl: bundle.credentialProxyUrl,
    credentialProxyTokens: bundle.credentialProxyTokens,
    workspaceId: bundle.workspaceId,
    relayApiKey: bundle.relayApiKey,
    relayBaseUrl: bundle.relayBaseUrl,
    runId: bundle.runId,
    userId: bundle.userId,
    sandboxId,
    cloudApiUrl: bundle.cloudApiUrl,
    cloudApiAccessToken: bundle.cloudApiAccessToken,
    cloudApiRefreshToken: bundle.cloudApiRefreshToken,
    cloudApiAccessTokenExpiresAt: bundle.cloudApiAccessTokenExpiresAt,
  }
}

export function credentialsToEnv(creds: StepCredentials): Record<string, string> {
  return {
    WORKFLOW_STORAGE_BACKEND: creds.s3Credentials.backend ?? "s3",
    WORKFLOW_STORAGE_CLOUD_API_URL: creds.s3Credentials.cloudApiUrl ?? creds.cloudApiUrl ?? "",
    WORKFLOW_STORAGE_CLOUD_API_ACCESS_TOKEN: creds.s3Credentials.cloudApiAccessToken ?? creds.cloudApiAccessToken ?? "",
    S3_ACCESS_KEY_ID: creds.s3Credentials.accessKeyId,
    S3_SECRET_ACCESS_KEY: creds.s3Credentials.secretAccessKey,
    S3_SESSION_TOKEN: creds.s3Credentials.sessionToken,
    S3_BUCKET: creds.s3Credentials.bucket,
    S3_PREFIX: creds.s3Credentials.prefix,
    RELAY_WORKSPACE_ID: creds.workspaceId,
    RELAY_API_KEY: creds.relayApiKey,
    RELAY_BASE_URL: creds.relayBaseUrl,
    RUN_ID: creds.runId,
    USER_ID: creds.userId,
    SANDBOX_ID: creds.sandboxId,
    CLOUD_API_URL: creds.cloudApiUrl ?? "",
    CLOUD_API_ACCESS_TOKEN: creds.cloudApiAccessToken ?? "",
    CLOUD_API_REFRESH_TOKEN: creds.s3Credentials.cloudApiRefreshToken ?? creds.cloudApiRefreshToken ?? "",
    CLOUD_API_ACCESS_TOKEN_EXPIRES_AT: creds.cloudApiAccessTokenExpiresAt ?? "",
  }
}
