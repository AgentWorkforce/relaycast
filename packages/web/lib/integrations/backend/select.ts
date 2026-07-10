import {
  type WorkspaceIntegrationProvider,
  getAllowedBackends,
  getBackendIntegrationId,
  getDefaultBackend,
} from "@/lib/integrations/providers";
import { BackendPolicyError } from "./errors";
import type { IntegrationBackend } from "./types";

export type IntegrationBackendSelection = {
  provider: string;
  backend: IntegrationBackend;
  backendIntegrationId: string;
  backendMetadata?: Record<string, unknown>;
};

export type IntegrationBackendPolicy = {
  defaultBackend: IntegrationBackend;
  allowedBackends: readonly IntegrationBackend[];
};

export type SelectIntegrationBackendInput = {
  workspaceId: string;
  provider: WorkspaceIntegrationProvider;
  requestedBackend?: IntegrationBackend;
  policy?: IntegrationBackendPolicy;
};

export function selectIntegrationBackend(
  input: SelectIntegrationBackendInput,
): IntegrationBackendSelection {
  void input.workspaceId;

  const policy = input.policy ?? {
    defaultBackend: getDefaultBackend(input.provider),
    allowedBackends: getAllowedBackends(input.provider),
  };
  const backend = input.requestedBackend ?? policy.defaultBackend;

  if (!policy.allowedBackends.includes(backend)) {
    throw new BackendPolicyError(
      "backend_not_allowed",
      `${input.provider} is not allowed to use the ${backend} integration backend`,
      backend,
    );
  }

  const backendIntegrationId = getBackendIntegrationId(input.provider, backend);
  if (!backendIntegrationId) {
    throw new BackendPolicyError(
      "backend_misconfigured",
      `${input.provider} does not define a ${backend} integration backend id`,
      backend,
    );
  }

  return {
    provider: input.provider,
    backend,
    backendIntegrationId,
  };
}
