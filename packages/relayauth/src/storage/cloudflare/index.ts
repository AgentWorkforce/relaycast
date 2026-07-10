import type {
  AuthStorage,
  ContextStorage,
  OrganizationContextRecord,
  TokenStorage,
  WorkspaceContextRecord,
} from "@relayauth/server/storage/interface";
import { CloudflareApiKeyStorage } from "./api-keys.js";
import { CloudflareAuditStorage } from "./audit.js";
import { CloudflareIdentityStorage } from "./identities.js";
import { CloudflarePolicyStorage } from "./policies.js";
import { CloudflareRevocationStorage } from "./revocation.js";
import { CloudflareRoleStorage } from "./roles.js";
import type { CloudflareStorageBindings } from "./types.js";
import { CloudflareAuditWebhookStorage } from "./webhooks.js";

type ActiveTokenRow = {
  id?: string;
  jti?: string;
  tokenId?: string;
  token_id?: string;
};

type OrganizationRow = {
  id?: string;
  orgId?: string;
  org_id?: string;
  scopes?: string | string[];
  scopes_json?: string | string[];
  roles?: string | string[];
  roles_json?: string | string[];
};

type WorkspaceRow = {
  id?: string;
  workspaceId?: string;
  workspace_id?: string;
  orgId?: string;
  org_id?: string;
  scopes?: string | string[];
  scopes_json?: string | string[];
  roles?: string | string[];
  roles_json?: string | string[];
};

const ACTIVE_TOKENS_SQL = `
  SELECT id, jti, token_id AS tokenId
  FROM tokens
  WHERE identity_id = ? AND status = 'active'
`;

const SELECT_ORGANIZATION_SQL = `
  SELECT
    id,
    org_id AS orgId,
    scopes,
    scopes_json,
    roles,
    roles_json
  FROM organizations
  WHERE id = ?
  LIMIT 1
`;

const SELECT_WORKSPACE_SQL = `
  SELECT
    id,
    workspace_id AS workspaceId,
    org_id AS orgId,
    scopes,
    scopes_json,
    roles,
    roles_json
  FROM workspaces
  WHERE id = ?
  LIMIT 1
`;

class CloudflareTokenStorage implements TokenStorage {
  constructor(private readonly db: D1Database) {}

  async listActiveIds(identityId: string): Promise<string[]> {
    const result = await this.db.prepare(ACTIVE_TOKENS_SQL).bind(identityId).all<ActiveTokenRow>();
    return Array.from(
      new Set(
        (result.results ?? [])
          .map((row) => {
            const fromId = normalizeOptionalString(row.id);
            if (fromId) {
              return fromId;
            }

            const fromJti = normalizeOptionalString(row.jti);
            if (fromJti) {
              return fromJti;
            }

            const fromTokenId = normalizeOptionalString(row.tokenId) ?? normalizeOptionalString(row.token_id);
            return fromTokenId ?? "";
          })
          .filter((tokenId): tokenId is string => tokenId.length > 0),
      ),
    );
  }
}

class CloudflareContextStorage implements ContextStorage {
  constructor(private readonly db: D1Database) {}

  async getOrganization(orgId: string): Promise<OrganizationContextRecord | null> {
    const row = await this.db.prepare(SELECT_ORGANIZATION_SQL).bind(orgId.trim()).first<OrganizationRow>();
    return hydrateOrganizationContext(row);
  }

  async getWorkspace(workspaceId: string): Promise<WorkspaceContextRecord | null> {
    const row = await this.db.prepare(SELECT_WORKSPACE_SQL).bind(workspaceId.trim()).first<WorkspaceRow>();
    return hydrateWorkspaceContext(row);
  }
}

export function createCloudflareStorage(bindings: CloudflareStorageBindings): AuthStorage {
  // @relayauth/server's token routes reach past the AuthStorage contract and
  // call `storage.DB.prepare(...)` directly (see routes/tokens.js). The
  // Node sqlite adapter in that package exposes a matching `.DB` shim; the
  // Cloudflare adapter has to as well or every token request 500s with
  // "Cannot read properties of undefined (reading 'prepare')".
  const storage = {
    DB: bindings.DB,
    identities: new CloudflareIdentityStorage(bindings),
    apiKeys: new CloudflareApiKeyStorage(bindings),
    tokens: new CloudflareTokenStorage(bindings.DB),
    revocations: new CloudflareRevocationStorage(bindings),
    roles: new CloudflareRoleStorage(bindings),
    policies: new CloudflarePolicyStorage(bindings),
    audit: new CloudflareAuditStorage(bindings),
    auditWebhooks: new CloudflareAuditWebhookStorage(bindings),
    contexts: new CloudflareContextStorage(bindings.DB),
  };

  return storage;
}

function hydrateOrganizationContext(row: OrganizationRow | null): OrganizationContextRecord | null {
  if (!row) {
    return null;
  }

  const id = normalizeOptionalString(row.id);
  const orgId = normalizeOptionalString(row.orgId) ?? normalizeOptionalString(row.org_id);
  if (!id || !orgId) {
    return null;
  }

  return {
    id,
    orgId,
    scopes: parseStringArrayColumn(row.scopes_json ?? row.scopes),
    roles: parseStringArrayColumn(row.roles_json ?? row.roles),
  };
}

function hydrateWorkspaceContext(row: WorkspaceRow | null): WorkspaceContextRecord | null {
  if (!row) {
    return null;
  }

  const id = normalizeOptionalString(row.id);
  const workspaceId = normalizeOptionalString(row.workspaceId) ?? normalizeOptionalString(row.workspace_id);
  const orgId = normalizeOptionalString(row.orgId) ?? normalizeOptionalString(row.org_id);
  if (!id || !workspaceId || !orgId) {
    return null;
  }

  return {
    id,
    workspaceId,
    orgId,
    scopes: parseStringArrayColumn(row.scopes_json ?? row.scopes),
    roles: parseStringArrayColumn(row.roles_json ?? row.roles),
  };
}

function parseStringArrayColumn(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export type { CloudflareStorageBindings } from "./types.js";
