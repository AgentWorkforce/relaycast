import type { AuditAction, AuditEntry } from "@relayauth/types";
import type {
  AuditEntryRecord,
  AuditLogWriteEntry,
} from "@relayauth/server/storage/interface";
import { describe, expect, it } from "vitest";
import { CloudflareAuditStorage } from "../audit.js";

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

type RecordedStatement = {
  sql: string;
  params: unknown[];
};

function createAuditEntry(
  index: number,
  overrides: Partial<AuditEntryRecord> = {},
): AuditEntryRecord {
  const padded = String(index).padStart(3, "0");

  return {
    id: overrides.id ?? `aud_${padded}`,
    action: overrides.action ?? "token.validated",
    identityId: overrides.identityId ?? `agent_${padded}`,
    orgId: overrides.orgId ?? "org_primary",
    workspaceId: overrides.workspaceId ?? "ws_primary",
    plane: overrides.plane ?? "relayauth",
    resource: overrides.resource ?? `token:tok_${padded}`,
    result: overrides.result ?? "allowed",
    metadata: overrides.metadata ?? {
      requestId: `req_${padded}`,
      sponsorId: "user_test",
    },
    ip: overrides.ip ?? "203.0.113.10",
    userAgent: overrides.userAgent ?? "vitest-audit-storage",
    timestamp:
      overrides.timestamp ?? new Date(Date.UTC(2026, 2, 28, 10, 0, index)).toISOString(),
    createdAt:
      overrides.createdAt ?? new Date(Date.UTC(2026, 2, 28, 10, 5, index)).toISOString(),
  };
}

function toAuditRow(entry: AuditEntryRecord): AuditLogRow {
  return {
    id: entry.id,
    action: entry.action,
    identity_id: entry.identityId,
    org_id: entry.orgId,
    workspace_id: entry.workspaceId ?? null,
    plane: entry.plane ?? null,
    resource: entry.resource ?? null,
    result: entry.result,
    metadata_json: entry.metadata ? JSON.stringify(entry.metadata) : null,
    ip: entry.ip ?? null,
    user_agent: entry.userAgent ?? null,
    timestamp: entry.timestamp,
    created_at: entry.createdAt ?? entry.timestamp,
  };
}

function compareAuditRowsDesc(left: AuditLogRow, right: AuditLogRow): number {
  if (left.timestamp !== right.timestamp) {
    return String(right.timestamp).localeCompare(String(left.timestamp));
  }

  return String(right.id).localeCompare(String(left.id));
}

function normalizeSql(query: string): string {
  return query.replace(/\s+/g, " ").trim().toLowerCase();
}

function createAuditD1(seed: AuditEntryRecord[] = []) {
  const rows = seed.map(toAuditRow).sort(compareAuditRowsDesc);
  const statements: RecordedStatement[] = [];
  const meta = {
    changed_db: false,
    changes: 0,
    duration: 0,
    rows_read: 0,
    rows_written: 0,
  };

  const insertRow = (params: unknown[]) => {
    const row: AuditLogRow = {
      id: typeof params[0] === "string" ? params[0] : undefined,
      action: params[1] as AuditAction | undefined,
      identity_id: typeof params[2] === "string" ? params[2] : undefined,
      org_id: typeof params[3] === "string" ? params[3] : undefined,
      workspace_id: typeof params[4] === "string" ? params[4] : null,
      plane: typeof params[5] === "string" ? params[5] : null,
      resource: typeof params[6] === "string" ? params[6] : null,
      result: params[7] as AuditEntry["result"] | undefined,
      metadata_json: typeof params[8] === "string" ? params[8] : null,
      ip: typeof params[9] === "string" ? params[9] : null,
      user_agent: typeof params[10] === "string" ? params[10] : null,
      timestamp: typeof params[11] === "string" ? params[11] : undefined,
      created_at: typeof params[11] === "string" ? params[11] : null,
    };

    rows.push(row);
    rows.sort(compareAuditRowsDesc);
    return row;
  };

  const resolveRows = (query: string, params: unknown[]): AuditLogRow[] => {
    const normalized = normalizeSql(query);
    if (!/\bfrom audit_logs\b/.test(normalized)) {
      return [];
    }

    let filtered = [...rows];
    let limit: number | undefined;
    let boundParams = [...params];

    const lastParam = boundParams.at(-1);
    if (typeof lastParam === "number" && Number.isFinite(lastParam)) {
      limit = lastParam;
      boundParams = boundParams.slice(0, -1);
    }

    const clausePositions = [
      { type: "orgId", index: normalized.search(/\borg_id\s*=\s*\?/i), arity: 1 },
      { type: "identityId", index: normalized.search(/\bidentity_id\s*=\s*\?/i), arity: 1 },
      { type: "action", index: normalized.search(/\baction\s*=\s*\?/i), arity: 1 },
      { type: "workspaceId", index: normalized.search(/\bworkspace_id\s*=\s*\?/i), arity: 1 },
      { type: "plane", index: normalized.search(/\bplane\s*=\s*\?/i), arity: 1 },
      { type: "result", index: normalized.search(/\bresult\s*=\s*\?/i), arity: 1 },
      { type: "from", index: normalized.search(/\btimestamp\s*>=\s*\?/i), arity: 1 },
      { type: "to", index: normalized.search(/\btimestamp\s*<\s*\?(?!\s*or)/i), arity: 1 },
      {
        type: "cursor",
        index: normalized.search(
          /\(\s*timestamp\s*<\s*\?\s+or\s+\(\s*timestamp\s*=\s*\?\s+and\s+id\s*<\s*\?\s*\)\s*\)/i,
        ),
        arity: 3,
      },
    ]
      .filter((clause) => clause.index >= 0)
      .sort((left, right) => left.index - right.index);

    const values = new Map<string, unknown[]>();
    let offset = 0;
    for (const clause of clausePositions) {
      values.set(clause.type, boundParams.slice(offset, offset + clause.arity));
      offset += clause.arity;
    }

    const orgId = values.get("orgId")?.[0];
    if (typeof orgId === "string") {
      filtered = filtered.filter((row) => row.org_id === orgId);
    }

    const identityId = values.get("identityId")?.[0];
    if (typeof identityId === "string") {
      filtered = filtered.filter((row) => row.identity_id === identityId);
    }

    const action = values.get("action")?.[0];
    if (typeof action === "string") {
      filtered = filtered.filter((row) => row.action === action);
    }

    const workspaceId = values.get("workspaceId")?.[0];
    if (typeof workspaceId === "string") {
      filtered = filtered.filter((row) => row.workspace_id === workspaceId);
    }

    const plane = values.get("plane")?.[0];
    if (typeof plane === "string") {
      filtered = filtered.filter((row) => row.plane === plane);
    }

    const result = values.get("result")?.[0];
    if (typeof result === "string") {
      filtered = filtered.filter((row) => row.result === result);
    }

    const from = values.get("from")?.[0];
    if (typeof from === "string") {
      filtered = filtered.filter((row) => String(row.timestamp) >= from);
    }

    const to = values.get("to")?.[0];
    if (typeof to === "string") {
      filtered = filtered.filter((row) => String(row.timestamp) < to);
    }

    const cursor = values.get("cursor");
    if (
      cursor
      && typeof cursor[0] === "string"
      && typeof cursor[1] === "string"
      && typeof cursor[2] === "string"
    ) {
      const [cursorTimestamp, sameTimestamp, cursorId] = cursor;
      filtered = filtered.filter(
        (row) =>
          String(row.timestamp) < cursorTimestamp
          || (String(row.timestamp) === sameTimestamp && String(row.id) < cursorId),
      );
    }

    filtered.sort(compareAuditRowsDesc);

    if (typeof limit === "number" && Number.isFinite(limit)) {
      filtered = filtered.slice(0, limit);
    }

    return filtered;
  };

  const execute = (query: string, params: unknown[]) => {
    statements.push({ sql: query, params: [...params] });
    const normalized = normalizeSql(query);

    if (/\binsert\s+into\s+audit_logs\b/.test(normalized)) {
      insertRow(params);
      return [];
    }

    return resolveRows(query, params);
  };

  const createPreparedStatement = (query: string) => ({
    bind: (...params: unknown[]) => ({
      first: async <T>() => (execute(query, params)[0] as T | null) ?? null,
      raw: async <T>() => execute(query, params) as T[],
      all: async <T>() => ({
        results: execute(query, params) as T[],
        success: true,
        meta,
      }),
      run: async () => {
        execute(query, params);
        const changes = /\binsert\s+into\b/.test(normalizeSql(query)) ? 1 : 0;
        return {
          success: true,
          meta: {
            ...meta,
            changes,
            rows_written: changes,
          },
        };
      },
    }),
    first: async <T>() => (resolveRows(query, [])[0] as T | null) ?? null,
    raw: async <T>() => resolveRows(query, []) as T[],
    all: async <T>() => ({
      results: resolveRows(query, []) as T[],
      success: true,
      meta,
    }),
    run: async () => ({
      success: true,
      meta,
    }),
  });

  return {
    rows,
    statements,
    db: {
      prepare: (query: string) => createPreparedStatement(query),
      batch: async <T>(preparedStatements: D1PreparedStatement[]) =>
        Promise.all(preparedStatements.map((statement) => statement.run())) as Awaited<T>,
      exec: async () => ({ count: 0, duration: 0 }),
      dump: async () => new ArrayBuffer(0),
    } as D1Database,
  };
}

describe("CloudflareAuditStorage", () => {
  it("write() inserts an audit entry with all fields", async () => {
    const { db, rows, statements } = createAuditD1();
    const storage = new CloudflareAuditStorage({ DB: db });

    const entry: AuditLogWriteEntry = {
      id: "aud_write_full",
      action: "scope.denied",
      identityId: "agent_write_full",
      orgId: "org_write_full",
      workspaceId: "ws_write_full",
      plane: "relayfile",
      resource: "file:/secure/report.txt",
      result: "denied",
      metadata: {
        requestId: "req_write_full",
        policyId: "pol_write_full",
      },
      ip: "198.51.100.42",
      userAgent: "unit-test/1.0",
      timestamp: "2026-03-28T10:15:00.000Z",
    };

    await storage.write(entry);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: "aud_write_full",
      action: "scope.denied",
      identity_id: "agent_write_full",
      org_id: "org_write_full",
      workspace_id: "ws_write_full",
      plane: "relayfile",
      resource: "file:/secure/report.txt",
      result: "denied",
      metadata_json: JSON.stringify({
        requestId: "req_write_full",
        policyId: "pol_write_full",
      }),
      ip: "198.51.100.42",
      user_agent: "unit-test/1.0",
      timestamp: "2026-03-28T10:15:00.000Z",
      created_at: "2026-03-28T10:15:00.000Z",
    });

    expect(
      statements.some((statement) => /\binsert\s+into\s+audit_logs\b/.test(normalizeSql(statement.sql))),
    ).toBe(true);
    expect(statements.at(-1)?.params).toEqual([
      "aud_write_full",
      "scope.denied",
      "agent_write_full",
      "org_write_full",
      "ws_write_full",
      "relayfile",
      "file:/secure/report.txt",
      "denied",
      JSON.stringify({
        requestId: "req_write_full",
        policyId: "pol_write_full",
      }),
      "198.51.100.42",
      "unit-test/1.0",
      "2026-03-28T10:15:00.000Z",
    ]);
  });

  it("query() filters by orgId", async () => {
    const { db } = createAuditD1([
      createAuditEntry(1, { id: "aud_org_match_newer", orgId: "org_match" }),
      createAuditEntry(2, { id: "aud_other_org", orgId: "org_other" }),
      createAuditEntry(3, { id: "aud_org_match_older", orgId: "org_match" }),
    ]);
    const storage = new CloudflareAuditStorage({ DB: db });

    const results = await storage.query(
      {
        orgId: "org_match",
        limit: 10,
      },
      { includeOverflowRow: false },
    );

    expect(results.map((entry) => entry.id)).toEqual([
      "aud_org_match_older",
      "aud_org_match_newer",
    ]);
    expect(results.every((entry) => entry.orgId === "org_match")).toBe(true);
  });

  it("query() filters by action type", async () => {
    const { db } = createAuditD1([
      createAuditEntry(1, { id: "aud_scope_denied", action: "scope.denied" }),
      createAuditEntry(2, { id: "aud_token_validated", action: "token.validated" }),
      createAuditEntry(3, { id: "aud_scope_denied_2", action: "scope.denied" }),
    ]);
    const storage = new CloudflareAuditStorage({ DB: db });

    const results = await storage.query(
      {
        orgId: "org_primary",
        action: "scope.denied",
        limit: 10,
      },
      { includeOverflowRow: false },
    );

    expect(results.map((entry) => entry.id)).toEqual([
      "aud_scope_denied_2",
      "aud_scope_denied",
    ]);
    expect(results.every((entry) => entry.action === "scope.denied")).toBe(true);
  });

  it("query() filters by time range", async () => {
    const { db } = createAuditD1([
      createAuditEntry(1, {
        id: "aud_before_window",
        timestamp: "2026-03-28T09:59:59.000Z",
        createdAt: "2026-03-28T09:59:59.000Z",
      }),
      createAuditEntry(2, {
        id: "aud_in_window_1",
        timestamp: "2026-03-28T10:15:00.000Z",
        createdAt: "2026-03-28T10:15:00.000Z",
      }),
      createAuditEntry(3, {
        id: "aud_in_window_2",
        timestamp: "2026-03-28T10:30:00.000Z",
        createdAt: "2026-03-28T10:30:00.000Z",
      }),
      createAuditEntry(4, {
        id: "aud_after_window",
        timestamp: "2026-03-28T11:00:00.000Z",
        createdAt: "2026-03-28T11:00:00.000Z",
      }),
    ]);
    const storage = new CloudflareAuditStorage({ DB: db });

    const results = await storage.query(
      {
        orgId: "org_primary",
        from: "2026-03-28T10:00:00.000Z",
        to: "2026-03-28T11:00:00.000Z",
        limit: 10,
      },
      { includeOverflowRow: false },
    );

    expect(results.map((entry) => entry.id)).toEqual([
      "aud_in_window_2",
      "aud_in_window_1",
    ]);
  });

  it("query() supports pagination with cursor and limit", async () => {
    const { db } = createAuditD1([
      createAuditEntry(1, {
        id: "aud_001",
        timestamp: "2026-03-28T10:03:00.000Z",
        createdAt: "2026-03-28T10:03:00.000Z",
      }),
      createAuditEntry(2, {
        id: "aud_002",
        timestamp: "2026-03-28T10:04:00.000Z",
        createdAt: "2026-03-28T10:04:00.000Z",
      }),
      createAuditEntry(3, {
        id: "aud_003",
        timestamp: "2026-03-28T10:04:00.000Z",
        createdAt: "2026-03-28T10:04:00.000Z",
      }),
      createAuditEntry(4, {
        id: "aud_004",
        timestamp: "2026-03-28T10:05:00.000Z",
        createdAt: "2026-03-28T10:05:00.000Z",
      }),
    ]);
    const storage = new CloudflareAuditStorage({ DB: db });

    const firstPage = await storage.query(
      {
        orgId: "org_primary",
        limit: 2,
      },
      { includeOverflowRow: false },
    );

    expect(firstPage.map((entry) => entry.id)).toEqual(["aud_004", "aud_003"]);

    const secondPage = await storage.query(
      {
        orgId: "org_primary",
        cursor: {
          timestamp: "2026-03-28T10:04:00.000Z",
          id: "aud_003",
        },
        limit: 2,
      },
      { includeOverflowRow: false },
    );

    expect(secondPage.map((entry) => entry.id)).toEqual(["aud_002", "aud_001"]);
  });

  it("query() returns all entries for an org in a time range for export-style retrieval", async () => {
    const { db } = createAuditD1([
      createAuditEntry(1, {
        id: "aud_export_1",
        orgId: "org_export",
        timestamp: "2026-03-28T08:30:00.000Z",
        createdAt: "2026-03-28T08:30:00.000Z",
      }),
      createAuditEntry(2, {
        id: "aud_export_2",
        orgId: "org_export",
        timestamp: "2026-03-28T09:15:00.000Z",
        createdAt: "2026-03-28T09:15:00.000Z",
      }),
      createAuditEntry(3, {
        id: "aud_export_3",
        orgId: "org_export",
        timestamp: "2026-03-28T09:45:00.000Z",
        createdAt: "2026-03-28T09:45:00.000Z",
      }),
      createAuditEntry(4, {
        id: "aud_other_org",
        orgId: "org_other",
        timestamp: "2026-03-28T09:30:00.000Z",
        createdAt: "2026-03-28T09:30:00.000Z",
      }),
    ]);
    const storage = new CloudflareAuditStorage({ DB: db });

    const results = await storage.query(
      {
        orgId: "org_export",
        from: "2026-03-28T09:00:00.000Z",
        to: "2026-03-28T10:00:00.000Z",
        limit: 50,
      },
      { includeOverflowRow: false },
    );

    expect(results.map((entry) => entry.id)).toEqual([
      "aud_export_3",
      "aud_export_2",
    ]);
  });
});
