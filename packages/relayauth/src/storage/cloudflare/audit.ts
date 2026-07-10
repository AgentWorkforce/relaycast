import type { AuditAction, AuditEntry } from "@relayauth/types";
import type {
  AuditEntryRecord,
  AuditLogWriteEntry,
  AuditQueryInput,
  AuditQueryOptions,
  AuditStorage,
  DashboardAuditCounts,
  DashboardAuditQuery,
  StoredIdentity,
} from "@relayauth/server/storage/interface";
import type { CloudflareStorageBindings } from "./types.js";

type AuditStorageBindings = Pick<CloudflareStorageBindings, "DB">;

type AuditLogRow = {
  id?: string;
  action?: AuditAction;
  identity_id?: string;
  org_id?: string;
  workspace_id?: string | null;
  plane?: string | null;
  resource?: string | null;
  result?: AuditEntry["result"];
  metadata_json?: string | null;
  ip?: string | null;
  user_agent?: string | null;
  timestamp?: string;
  created_at?: string | null;
};

type DashboardAuditCountRow = {
  action?: string | null;
  count?: number | string | null;
  tokensIssued?: number | string | null;
  tokensRevoked?: number | string | null;
  tokensRefreshed?: number | string | null;
  scopeChecks?: number | string | null;
  scopeDenials?: number | string | null;
};

const AUDIT_LOG_INSERT_SQL = `
  INSERT INTO audit_logs (
    id,
    action,
    identity_id,
    org_id,
    workspace_id,
    plane,
    resource,
    result,
    metadata_json,
    ip,
    user_agent,
    timestamp
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const INSERT_AUDIT_EVENT_SQL = `
  INSERT INTO audit_events (
    id,
    org_id,
    workspace_id,
    identity_id,
    action,
    reason,
    payload,
    created_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`;

/**
 * Persists and queries audit data in Cloudflare D1.
 */
export class CloudflareAuditStorage implements AuditStorage {
  constructor(private readonly bindings: AuditStorageBindings) {}

  async write(entry: AuditLogWriteEntry): Promise<void> {
    await this.bindings.DB.prepare(AUDIT_LOG_INSERT_SQL).bind(...toAuditInsertParams(entry)).run();
  }

  async writeBatch(entries: AuditLogWriteEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }

    const statements = entries.map((entry) =>
      this.bindings.DB.prepare(AUDIT_LOG_INSERT_SQL).bind(...toAuditInsertParams(entry)),
    );
    await this.bindings.DB.batch(statements);
  }

  async query(query: AuditQueryInput, options: AuditQueryOptions = {}): Promise<AuditEntryRecord[]> {
    const built = buildAuditQuery(query, options);
    const result = await this.bindings.DB.prepare(built.sql).bind(...built.params).all<AuditLogRow>();
    return (result.results ?? [])
      .map(toAuditEntryRecord)
      .filter((entry): entry is AuditEntryRecord => entry !== null);
  }

  async getActionCounts(orgId: string, query: DashboardAuditQuery): Promise<DashboardAuditCounts> {
    const built = buildAuditCountsQuery(orgId, query);
    const result = await this.bindings.DB.prepare(built.sql).bind(...built.params).all<DashboardAuditCountRow>();
    return summarizeAuditCounts(result.results ?? []);
  }

  async writeIdentitySuspendedEvent(identity: StoredIdentity, reason: string, actorId: string): Promise<void> {
    const payload = JSON.stringify({
      eventType: "identity.suspended",
      status: identity.status,
      sponsorId: identity.sponsorId,
      sponsorChain: identity.sponsorChain,
      actorId,
      reason,
    });

    try {
      await this.bindings.DB.prepare(INSERT_AUDIT_EVENT_SQL)
        .bind(
          crypto.randomUUID(),
          identity.orgId,
          identity.workspaceId,
          identity.id,
          "identity.suspended",
          reason,
          payload,
          identity.updatedAt,
        )
        .run();
    } catch (error) {
      console.error("Failed to write identity suspended audit event", error);
    }
  }
}

function toAuditInsertParams(entry: AuditLogWriteEntry): unknown[] {
  return [
    entry.id,
    entry.action,
    entry.identityId,
    entry.orgId,
    entry.workspaceId ?? null,
    entry.plane ?? null,
    entry.resource ?? null,
    entry.result,
    entry.metadata ? JSON.stringify(entry.metadata) : null,
    entry.ip ?? null,
    entry.userAgent ?? null,
    entry.timestamp,
  ];
}

function buildAuditQuery(
  params: AuditQueryInput,
  options: AuditQueryOptions = {},
): { sql: string; params: unknown[] } {
  const clauses = ["org_id = ?"];
  const values: unknown[] = [params.orgId];

  if (params.identityId) {
    clauses.push("identity_id = ?");
    values.push(params.identityId);
  }

  if (params.action) {
    clauses.push("action = ?");
    values.push(params.action);
  }

  if (params.workspaceId) {
    clauses.push("workspace_id = ?");
    values.push(params.workspaceId);
  }

  if (params.plane) {
    clauses.push("plane = ?");
    values.push(params.plane);
  }

  if (params.result) {
    clauses.push("result = ?");
    values.push(params.result);
  }

  if (params.from) {
    clauses.push("timestamp >= ?");
    values.push(params.from);
  }

  if (params.to) {
    clauses.push("(timestamp < ?)");
    values.push(params.to);
  }

  if (params.cursor) {
    clauses.push("(timestamp < ? OR (timestamp = ? AND id < ?))");
    values.push(params.cursor.timestamp, params.cursor.timestamp, params.cursor.id);
  }

  values.push(params.limit + (options.includeOverflowRow ?? true ? 1 : 0));

  return {
    sql: `
      SELECT
        id,
        action,
        identity_id,
        org_id,
        workspace_id,
        plane,
        resource,
        result,
        metadata_json,
        ip,
        user_agent,
        timestamp,
        created_at
      FROM audit_logs
      WHERE ${clauses.join(" AND ")}
      ORDER BY timestamp DESC, id DESC
      LIMIT ?
    `,
    params: values,
  };
}

function toAuditEntryRecord(row: AuditLogRow | null): AuditEntryRecord | null {
  if (!row) {
    return null;
  }

  const id = normalizeOptionalString(row.id);
  const action = row.action;
  const identityId = normalizeOptionalString(row.identity_id);
  const orgId = normalizeOptionalString(row.org_id);
  const timestamp = normalizeOptionalString(row.timestamp);
  const result = row.result;
  if (!id || !action || !identityId || !orgId || !timestamp || !result) {
    return null;
  }

  const metadata = parseNullableRecordColumn(row.metadata_json);

  return {
    id,
    action,
    identityId,
    orgId,
    ...(normalizeOptionalString(row.workspace_id) ? { workspaceId: normalizeOptionalString(row.workspace_id)! } : {}),
    ...(normalizeOptionalString(row.plane) ? { plane: normalizeOptionalString(row.plane)! } : {}),
    ...(normalizeOptionalString(row.resource) ? { resource: normalizeOptionalString(row.resource)! } : {}),
    result,
    ...(metadata ? { metadata } : {}),
    ...(normalizeOptionalString(row.ip) ? { ip: normalizeOptionalString(row.ip)! } : {}),
    ...(normalizeOptionalString(row.user_agent) ? { userAgent: normalizeOptionalString(row.user_agent)! } : {}),
    timestamp,
    ...(normalizeOptionalString(row.created_at) ? { createdAt: normalizeOptionalString(row.created_at)! } : {}),
  };
}

function buildAuditCountsQuery(
  orgId: string,
  query: DashboardAuditQuery,
): { sql: string; params: unknown[] } {
  const clauses = [
    "org_id = ?",
    "(action IN ('token.issued', 'token.refreshed', 'token.revoked', 'scope.denied') OR (action = 'scope.checked' AND result IN ('allowed', 'denied')))",
  ];
  const params: unknown[] = [orgId];

  if (query.from) {
    clauses.push("timestamp >= ?");
    params.push(query.from);
  }

  if (query.to) {
    clauses.push("timestamp < ?");
    params.push(query.to);
  }

  return {
    sql: `
      SELECT action, COUNT(*) AS count
      FROM audit_logs
      WHERE ${clauses.join(" AND ")}
      GROUP BY action
    `,
    params,
  };
}

function summarizeAuditCounts(rows: DashboardAuditCountRow[]): DashboardAuditCounts {
  const counts: DashboardAuditCounts = {
    tokensIssued: 0,
    tokensRevoked: 0,
    tokensRefreshed: 0,
    scopeChecks: 0,
    scopeDenials: 0,
  };

  for (const row of rows) {
    if (hasAggregateAuditShape(row)) {
      counts.tokensIssued += toCount(row.tokensIssued);
      counts.tokensRevoked += toCount(row.tokensRevoked);
      counts.tokensRefreshed += toCount(row.tokensRefreshed);
      counts.scopeChecks += toCount(row.scopeChecks);
      counts.scopeDenials += toCount(row.scopeDenials);
      continue;
    }

    const action = normalizeOptionalString(row.action);
    if (!action) {
      continue;
    }

    const count = toCount(row.count);
    if (action === "token.issued") {
      counts.tokensIssued += count;
    } else if (action === "token.revoked") {
      counts.tokensRevoked += count;
    } else if (action === "token.refreshed") {
      counts.tokensRefreshed += count;
    } else if (action === "scope.checked") {
      counts.scopeChecks += count;
    } else if (action === "scope.denied") {
      counts.scopeDenials += count;
    }
  }

  return counts;
}

function hasAggregateAuditShape(row: DashboardAuditCountRow): boolean {
  return row.tokensIssued !== undefined
    || row.tokensRevoked !== undefined
    || row.tokensRefreshed !== undefined
    || row.scopeChecks !== undefined
    || row.scopeDenials !== undefined;
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

function parseNullableRecordColumn(value: unknown): Record<string, string> | undefined {
  const parsed = parseRecordColumn(value);
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}
