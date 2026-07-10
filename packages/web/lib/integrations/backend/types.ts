import type { IntegrationBackend as CatalogIntegrationBackend } from "@/lib/integrations/providers";

// TODO(provider-contracts): move these shared backend types to
// @relayfile/provider-contracts once that package is published.
export type IntegrationBackend = CatalogIntegrationBackend;

export interface ProviderBackendConfig {
  backend: IntegrationBackend;
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export interface BackendIntegrationRef {
  provider: string;
  backendIntegrationId: string;
  displayName?: string;
  backendMetadata?: Record<string, unknown>;
}

export interface CreateSetupSessionInput {
  workspaceId: string;
  endUserId: string;
  endUserEmail?: string | null;
  allowedIntegrations: BackendIntegrationRef[];
  successRedirectUrl?: string;
  cancelRedirectUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface SetupSessionResult {
  backend: IntegrationBackend;
  connectLink: string;
  sessionToken?: string;
  expiresAt?: string;
  connectionId?: string;
  backendMetadata?: Record<string, unknown>;
  raw?: unknown;
}

export interface ConnectionLookupInput {
  connectionId: string;
  backendIntegrationId?: string;
  provider?: string;
}

export interface BackendConnection {
  backend: IntegrationBackend;
  connectionId: string;
  provider?: string;
  backendIntegrationId?: string;
  backendMetadata?: Record<string, unknown>;
  status?: "active" | "inactive" | "unknown";
  identity?: Record<string, unknown>;
  raw?: unknown;
}

export interface DeleteConnectionInput {
  connectionId: string;
  backendIntegrationId?: string;
  provider?: string;
}

export interface ProviderBackend {
  readonly backend: IntegrationBackend;

  createSetupSession(input: CreateSetupSessionInput): Promise<SetupSessionResult>;
  getConnection(input: ConnectionLookupInput): Promise<BackendConnection | null>;
  deleteConnection?(input: DeleteConnectionInput): Promise<boolean>;
  proxy?(request: unknown): Promise<unknown>;
  listRecords?(request: unknown): AsyncIterable<unknown>;
  normalizeWebhook?(payload: unknown, headers?: Headers): Promise<unknown>;
}
