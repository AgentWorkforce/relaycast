export type IntegrationConnectionScope =
  | { kind: "deployer_user" }
  | { kind: "workspace" }
  | { kind: "workspace_service_account"; name: string };

export const DEFAULT_INTEGRATION_CONNECTION_SCOPE: IntegrationConnectionScope = {
  kind: "workspace",
};

const SCOPE_KINDS = new Set([
  "deployer_user",
  "workspace",
  "workspace_service_account",
]);

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function parseIntegrationConnectionScope(
  value: unknown,
): IntegrationConnectionScope | null {
  if (value === undefined || value === null) {
    return DEFAULT_INTEGRATION_CONNECTION_SCOPE;
  }

  const record = readRecord(value);
  const kind = readString(record?.kind);
  if (!kind || !SCOPE_KINDS.has(kind)) {
    return null;
  }

  if (kind === "workspace_service_account") {
    const name = readString(record?.name);
    return name ? { kind, name } : null;
  }

  return kind === "deployer_user" ? { kind } : { kind: "workspace" };
}

export function readIntegrationConnectionScopeFromSearchParams(
  searchParams: URLSearchParams,
): IntegrationConnectionScope | null {
  const kind =
    searchParams.get("scope.kind") ??
    searchParams.get("scopeKind") ??
    searchParams.get("scope");
  const name =
    searchParams.get("scope.name") ??
    searchParams.get("scopeName") ??
    searchParams.get("name");

  return parseIntegrationConnectionScope(
    kind ? { kind, ...(name ? { name } : {}) } : undefined,
  );
}

export function buildIntegrationConnectionScopeTags(input: {
  scope: IntegrationConnectionScope;
  workspaceId: string;
  userId: string;
}): Record<string, unknown> {
  return {
    workspaceId: input.workspaceId,
    end_user_id: input.workspaceId,
    relayfile_integration_scope_kind: input.scope.kind,
    relayfile_integration_user_id: input.userId,
    ...(input.scope.kind === "workspace_service_account"
      ? { relayfile_integration_scope_name: input.scope.name }
      : {}),
  };
}

export function readIntegrationConnectionScopeFromRecord(
  payload: Record<string, unknown>,
): { scope: IntegrationConnectionScope; userId: string | null } | null {
  const endUser = readRecord(payload.endUser) ?? readRecord(payload.end_user);
  const endUserTags = readRecord(endUser?.tags);
  const payloadTags = readRecord(payload.tags);
  const kind =
    readString(payload.relayfile_integration_scope_kind) ??
    readString(endUserTags?.relayfile_integration_scope_kind) ??
    readString(payloadTags?.relayfile_integration_scope_kind);
  const name =
    readString(payload.relayfile_integration_scope_name) ??
    readString(endUserTags?.relayfile_integration_scope_name) ??
    readString(payloadTags?.relayfile_integration_scope_name);
  const userId =
    readString(payload.relayfile_integration_user_id) ??
    readString(endUserTags?.relayfile_integration_user_id) ??
    readString(payloadTags?.relayfile_integration_user_id);
  const scope = parseIntegrationConnectionScope(
    kind ? { kind, ...(name ? { name } : {}) } : undefined,
  );

  return scope ? { scope, userId } : null;
}
