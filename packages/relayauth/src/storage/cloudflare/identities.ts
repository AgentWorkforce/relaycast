import type { AgentIdentity, IdentityStatus, IdentityType } from "@relayauth/types";
import type {
  DuplicateIdentityRecord,
  IdentityBudget,
  IdentityChildSummary,
  IdentityStatusCounts,
  IdentityStorage,
  ListIdentitiesOptions,
  StoredIdentity,
} from "@relayauth/server/storage/interface";
import { StorageError } from "@relayauth/server/storage/interface";
import type { CloudflareStorageBindings } from "./types.js";

type IdentityStorageBindings = Pick<CloudflareStorageBindings, "DB" | "IDENTITY_DO" | "INTERNAL_SECRET">;

type DuplicateIdentityRow = {
  id?: string;
  name?: string;
  orgId?: string;
  org_id?: string;
};

type OrgBudgetRow = {
  budget?: IdentityBudget;
  budget_json?: string;
  defaultBudget?: IdentityBudget;
  default_budget?: string;
  data?: string;
  settings_json?: string;
};

type ChildIdentityRow = {
  id?: string;
  name?: string;
  status?: string;
  sponsorId?: string;
  sponsor_id?: string;
  createdAt?: string;
  created_at?: string;
};

type ListIdentityRow = {
  id?: string;
  name?: string;
  type?: string;
  orgId?: string;
  org_id?: string;
  status?: string;
  scopes?: string | string[];
  scopes_json?: string;
  roles?: string | string[];
  roles_json?: string;
  metadata?: string | Record<string, string>;
  metadata_json?: string;
  createdAt?: string;
  created_at?: string;
  updatedAt?: string;
  updated_at?: string;
  lastActiveAt?: string;
  last_active_at?: string;
  suspendedAt?: string;
  suspended_at?: string;
  suspendReason?: string;
  suspend_reason?: string;
};

const DUPLICATE_NAME_SQL = `
  SELECT id, name, org_id AS orgId
  FROM identities
  WHERE org_id = ? AND name = ?
  LIMIT 1
`;

const ORG_BUDGET_SQL = `
  SELECT budget, budget_json, default_budget, settings_json, data
  FROM org_budgets
  WHERE org_id = ?
  LIMIT 1
`;

const CHILD_IDENTITIES_SQL = `
  SELECT id, name, status, sponsor_id, created_at
  FROM identities
  WHERE org_id = ? AND sponsor_id = ?
  ORDER BY created_at DESC, id DESC
`;

/**
 * Coordinates identity reads and writes between Cloudflare D1 and the identity Durable Object.
 */
export class CloudflareIdentityStorage implements IdentityStorage {
  constructor(private readonly bindings: IdentityStorageBindings) {}

  async list(orgId: string, options: ListIdentitiesOptions = {}): Promise<AgentIdentity[]> {
    const query = buildListIdentitiesQuery(orgId, options);
    const result = await this.bindings.DB.prepare(query.sql).bind(...query.params).all<ListIdentityRow>();
    return (result.results ?? [])
      .map(hydrateListIdentity)
      .filter((identity): identity is AgentIdentity => identity !== null);
  }

  async get(id: string): Promise<StoredIdentity | null> {
    const normalizedId = normalizeOptionalString(id);
    if (!normalizedId) {
      return null;
    }

    try {
      const response = await this.requestIdentityDurableObject(normalizedId, "/internal/get", {
        method: "GET",
      });
      return response.json<StoredIdentity>();
    } catch (error) {
      if (error instanceof StorageError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  async create(identity: StoredIdentity): Promise<StoredIdentity> {
    const response = await this.requestIdentityDurableObject(identity.id, "/internal/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(identity),
    });
    return response.json<StoredIdentity>();
  }

  async update(id: string, patch: Partial<StoredIdentity>): Promise<StoredIdentity> {
    const response = await this.requestIdentityDurableObject(id, "/internal/update", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    return response.json<StoredIdentity>();
  }

  async delete(id: string): Promise<void> {
    await this.requestIdentityDurableObject(id, "/internal/delete", {
      method: "DELETE",
    });
  }

  async suspend(id: string, reason: string): Promise<StoredIdentity> {
    const response = await this.requestIdentityDurableObject(id, "/internal/suspend", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason }),
    });
    return response.json<StoredIdentity>();
  }

  async retire(id: string, reason?: string): Promise<StoredIdentity> {
    const response = await this.requestIdentityDurableObject(id, "/internal/retire", {
      method: "POST",
      ...(reason
        ? {
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ reason }),
          }
        : {}),
    });
    return response.json<StoredIdentity>();
  }

  async reactivate(id: string): Promise<StoredIdentity> {
    const response = await this.requestIdentityDurableObject(id, "/internal/reactivate", {
      method: "POST",
    });
    return response.json<StoredIdentity>();
  }

  async findDuplicate(orgId: string, name: string): Promise<DuplicateIdentityRecord | null> {
    const row = await this.bindings.DB
      .prepare(DUPLICATE_NAME_SQL)
      .bind(orgId, name)
      .first<DuplicateIdentityRow>();
    const id = normalizeOptionalString(row?.id);
    const normalizedName = normalizeOptionalString(row?.name);
    const normalizedOrgId = normalizeOptionalString(row?.orgId) ?? normalizeOptionalString(row?.org_id);
    return id && normalizedName && normalizedOrgId
      ? { id, name: normalizedName, orgId: normalizedOrgId }
      : null;
  }

  async loadOrgBudget(orgId: string): Promise<IdentityBudget | undefined> {
    const row = await this.bindings.DB.prepare(ORG_BUDGET_SQL).bind(orgId).first<OrgBudgetRow>();
    if (!row) {
      return undefined;
    }

    if (isIdentityBudget(row.budget)) {
      return row.budget;
    }

    if (isIdentityBudget(row.defaultBudget)) {
      return row.defaultBudget;
    }

    return (
      parseBudgetValue(row.budget_json) ??
      parseBudgetValue(row.default_budget) ??
      parseSettingsBudget(row.settings_json) ??
      parseBudgetValue(row.data)
    );
  }

  async listChildIds(orgId: string, sponsorId: string): Promise<string[]> {
    const result = await this.bindings.DB.prepare(CHILD_IDENTITIES_SQL).bind(orgId, sponsorId).all<ChildIdentityRow>();
    return Array.from(
      new Set(
        (result.results ?? [])
          .map((row) => normalizeOptionalString(row.id) ?? "")
          .filter((id): id is string => id.length > 0 && id !== sponsorId),
      ),
    );
  }

  async listChildren(orgId: string, sponsorId: string): Promise<IdentityChildSummary[]> {
    const result = await this.bindings.DB.prepare(CHILD_IDENTITIES_SQL).bind(orgId, sponsorId).all<ChildIdentityRow>();
    return (result.results ?? [])
      .map(hydrateChildIdentity)
      .filter((child): child is IdentityChildSummary => child !== null)
      .sort(compareChildIdentities);
  }

  async getStatusCounts(orgId: string): Promise<IdentityStatusCounts> {
    const result = await this.bindings.DB
      .prepare(`
        SELECT
          SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS activeIdentities,
          SUM(CASE WHEN status = 'suspended' THEN 1 ELSE 0 END) AS suspendedIdentities
        FROM identities
        WHERE org_id = ? AND status IN ('active', 'suspended')
      `)
      .bind(orgId)
      .all<DashboardIdentityCountRow>();

    return summarizeIdentityCounts(result.results ?? []);
  }

  private async requestIdentityDurableObject(
    identityId: string,
    path: string,
    init: RequestInit,
  ): Promise<Response> {
    const normalizedIdentityId = normalizeRequiredString(identityId, "identityId is required");
    const durableObjectId = this.bindings.IDENTITY_DO.idFromName(normalizedIdentityId);
    const durableObject = this.bindings.IDENTITY_DO.get(durableObjectId);
    const headers = new Headers(init.headers);
    headers.set("x-internal-secret", this.bindings.INTERNAL_SECRET);
    const response = await durableObject.fetch(
      new Request(`http://identity-do${path}`, {
        ...init,
        headers,
      }),
    );

    if (response.ok) {
      return response;
    }

    const message = await readResponseError(response, "Identity storage request failed");
    throw new StorageError(message, response.status, "identity_storage_error");
  }
}

type DashboardIdentityCountRow = {
  status?: string | null;
  count?: number | string | null;
  activeIdentities?: number | string | null;
  suspendedIdentities?: number | string | null;
};

function buildListIdentitiesQuery(
  orgId: string,
  options: ListIdentitiesOptions,
): { sql: string; params: Array<string | number> } {
  const clauses = ["org_id = ?"];
  const params: Array<string | number> = [orgId];

  if (options.status) {
    clauses.push("status = ?");
    params.push(options.status);
  }

  if (options.type) {
    clauses.push("type = ?");
    params.push(options.type);
  }

  if (options.cursorId) {
    clauses.push("(created_at, id) < (SELECT created_at, id FROM identities WHERE id = ?)");
    params.push(options.cursorId);
  }

  params.push(options.limit ?? 50);

  return {
    sql: `
      SELECT *
      FROM identities
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `,
    params,
  };
}

function hydrateListIdentity(row: ListIdentityRow | null): AgentIdentity | null {
  if (!row) {
    return null;
  }

  const id = normalizeOptionalString(row.id);
  const name = normalizeOptionalString(row.name);
  const orgId = normalizeOptionalString(row.orgId) ?? normalizeOptionalString(row.org_id);
  const createdAt = normalizeOptionalString(row.createdAt) ?? normalizeOptionalString(row.created_at);
  const updatedAt = normalizeOptionalString(row.updatedAt) ?? normalizeOptionalString(row.updated_at);
  if (!id || !name || !orgId || !createdAt || !updatedAt) {
    return null;
  }

  const status = normalizeIdentityStatus(row.status) ?? "active";
  const type = normalizeIdentityType(row.type);
  if (!type) {
    return null;
  }

  return {
    id,
    name,
    type,
    orgId,
    status,
    scopes: parseStringArrayColumn(row.scopes_json ?? row.scopes),
    roles: parseStringArrayColumn(row.roles_json ?? row.roles),
    metadata: parseRecordColumn(row.metadata_json ?? row.metadata),
    createdAt,
    updatedAt,
    ...(normalizeOptionalString(row.lastActiveAt) ?? normalizeOptionalString(row.last_active_at)
      ? { lastActiveAt: normalizeOptionalString(row.lastActiveAt) ?? normalizeOptionalString(row.last_active_at)! }
      : {}),
    ...(normalizeOptionalString(row.suspendedAt) ?? normalizeOptionalString(row.suspended_at)
      ? { suspendedAt: normalizeOptionalString(row.suspendedAt) ?? normalizeOptionalString(row.suspended_at)! }
      : {}),
    ...(normalizeOptionalString(row.suspendReason) ?? normalizeOptionalString(row.suspend_reason)
      ? { suspendReason: normalizeOptionalString(row.suspendReason) ?? normalizeOptionalString(row.suspend_reason)! }
      : {}),
  };
}

function hydrateChildIdentity(row: ChildIdentityRow | null): IdentityChildSummary | null {
  if (!row) {
    return null;
  }

  const id = normalizeOptionalString(row.id);
  const name = normalizeOptionalString(row.name);
  if (!id || !name) {
    return null;
  }

  return {
    id,
    name,
    status: normalizeIdentityStatus(row.status) ?? "active",
    ...(normalizeOptionalString(row.sponsorId) ?? normalizeOptionalString(row.sponsor_id)
      ? { sponsorId: normalizeOptionalString(row.sponsorId) ?? normalizeOptionalString(row.sponsor_id)! }
      : {}),
    ...(normalizeOptionalString(row.createdAt) ?? normalizeOptionalString(row.created_at)
      ? { createdAt: normalizeOptionalString(row.createdAt) ?? normalizeOptionalString(row.created_at)! }
      : {}),
  };
}

function compareChildIdentities(left: IdentityChildSummary, right: IdentityChildSummary): number {
  const leftCreatedAt = left.createdAt ?? "";
  const rightCreatedAt = right.createdAt ?? "";
  return rightCreatedAt.localeCompare(leftCreatedAt) || right.id.localeCompare(left.id);
}

function summarizeIdentityCounts(rows: DashboardIdentityCountRow[]): IdentityStatusCounts {
  const counts: IdentityStatusCounts = {
    activeIdentities: 0,
    suspendedIdentities: 0,
  };

  for (const row of rows) {
    if (row.activeIdentities !== undefined || row.suspendedIdentities !== undefined) {
      counts.activeIdentities += toCount(row.activeIdentities);
      counts.suspendedIdentities += toCount(row.suspendedIdentities);
      continue;
    }

    const status = normalizeOptionalString(row.status);
    const count = toCount(row.count);
    if (status === "active") {
      counts.activeIdentities += count;
    } else if (status === "suspended") {
      counts.suspendedIdentities += count;
    }
  }

  return counts;
}

function toCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
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

function parseRecordColumn(value: unknown): Record<string, string> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parseRecordColumn(parsed);
  } catch {
    return {};
  }
}

function parseBudgetValue(value: string | undefined): IdentityBudget | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return isIdentityBudget(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseSettingsBudget(value: string | undefined): IdentityBudget | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as { budget?: unknown };
    return isIdentityBudget(parsed.budget) ? parsed.budget : undefined;
  } catch {
    return undefined;
  }
}

function isIdentityBudget(value: unknown): value is IdentityBudget {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeIdentityStatus(status: unknown): IdentityStatus | undefined {
  return status === "active" || status === "suspended" || status === "retired" ? status : undefined;
}

function normalizeIdentityType(type: unknown): IdentityType | undefined {
  return type === "agent" || type === "human" || type === "service" ? type : undefined;
}

function normalizeRequiredString(value: unknown, message: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw new StorageError(message, 400, "invalid_storage_input");
  }

  return normalized;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

async function readResponseError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.clone().json<{ error?: unknown }>();
    if (typeof body?.error === "string" && body.error.trim()) {
      return body.error;
    }
  } catch {
    // Fall back to text.
  }

  const text = await response.text().catch(() => "");
  return text || fallback;
}
