import assert from "node:assert/strict";
import test from "node:test";
import type { AuditAction, AuditEntry } from "@relayauth/types";
import {
  assertJsonResponse,
  createTestApp,
  createTestRequest,
  generateTestToken,
} from "./test-helpers.js";

type AuditEntryExport = AuditEntry & {
  createdAt?: string;
};

type AuditLogRow = {
  id: string;
  action: AuditAction;
  identity_id: string;
  org_id: string;
  workspace_id: string | null;
  plane: string | null;
  resource: string | null;
  result: AuditEntry["result"];
  metadata_json: string | null;
  ip: string | null;
  user_agent: string | null;
  timestamp: string;
  created_at: string;
};

type AuditExportRequest = {
  format: string;
  orgId: string;
  identityId?: string;
  action?: AuditAction;
  workspaceId?: string;
  plane?: string;
  result?: "allowed" | "denied";
  from?: string;
  to?: string;
  limit?: number;
};

function createAuditEntry(
  index: number,
  overrides: Partial<AuditEntryExport> = {},
): AuditEntryExport {
  const padded = String(index).padStart(5, "0");

  return {
    id: overrides.id ?? `aud_${padded}`,
    action: overrides.action ?? "token.validated",
    identityId: overrides.identityId ?? `agent_${padded}`,
    orgId: overrides.orgId ?? "org_test",
    ...(overrides.workspaceId !== undefined ? { workspaceId: overrides.workspaceId } : {}),
    plane: overrides.plane ?? "relayauth",
    resource: overrides.resource ?? `token:tok_${padded}`,
    result: overrides.result ?? "allowed",
    metadata: overrides.metadata ?? {
      sponsorId: "user_test",
      sponsorChain: JSON.stringify(["user_test", overrides.identityId ?? `agent_${padded}`]),
      requestId: `req_${padded}`,
    },
    ip: overrides.ip ?? "203.0.113.10",
    userAgent: overrides.userAgent ?? "audit-export-tests/1.0",
    timestamp: overrides.timestamp ?? new Date(Date.UTC(2026, 2, 24, 12, 0, index)).toISOString(),
    createdAt:
      overrides.createdAt ?? new Date(Date.UTC(2026, 2, 24, 12, 5, index)).toISOString(),
  };
}

function toAuditRow(entry: AuditEntryExport): AuditLogRow {
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
    return right.timestamp.localeCompare(left.timestamp);
  }

  return right.id.localeCompare(left.id);
}

function normalizeSql(query: string): string {
  return query.replace(/\s+/g, " ").trim().toLowerCase();
}

function createAuditExportD1(entries: AuditEntryExport[]): D1Database {
  const rows = entries.map(toAuditRow).sort(compareAuditRowsDesc);
  const meta = {
    changed_db: false,
    changes: 0,
    duration: 0,
    rows_read: 0,
    rows_written: 0,
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
    } else {
      const limitMatch = normalized.match(/\blimit\s+(\d+)\b/);
      if (limitMatch?.[1]) {
        limit = Number.parseInt(limitMatch[1], 10);
      }
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
      filtered = filtered.filter((row) => row.timestamp >= from);
    }

    const to = values.get("to")?.[0];
    if (typeof to === "string") {
      filtered = filtered.filter((row) => row.timestamp < to);
    }

    const cursor = values.get("cursor");
    if (cursor && typeof cursor[0] === "string" && typeof cursor[2] === "string") {
      const [cursorTimestamp, , cursorId] = cursor;
      filtered = filtered.filter(
        (row) =>
          row.timestamp < cursorTimestamp ||
          (row.timestamp === cursorTimestamp && row.id < cursorId),
      );
    }

    filtered.sort(compareAuditRowsDesc);

    if (typeof limit === "number" && Number.isFinite(limit)) {
      filtered = filtered.slice(0, limit);
    }

    return filtered;
  };

  const createPreparedStatement = (query: string) => ({
    bind: (...params: unknown[]) => ({
      first: async <T>() => (resolveRows(query, params)[0] as T | null) ?? null,
      run: async () => ({ success: true, meta }),
      raw: async <T>() => resolveRows(query, params) as T[],
      all: async <T>() => ({ results: resolveRows(query, params) as T[], success: true, meta }),
    }),
    first: async <T>() => (resolveRows(query, [])[0] as T | null) ?? null,
    run: async () => ({ success: true, meta }),
    raw: async <T>() => resolveRows(query, []) as T[],
    all: async <T>() => ({ results: resolveRows(query, []) as T[], success: true, meta }),
  });

  return {
    prepare: (query: string) => createPreparedStatement(query),
    batch: async <T>(statements: D1PreparedStatement[]) =>
      Promise.all(statements.map((statement) => statement.run())) as Awaited<T>,
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  } as D1Database;
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];

    if (inQuotes) {
      if (character === "\"") {
        if (line[index + 1] === "\"") {
          current += "\"";
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += character;
      }
      continue;
    }

    if (character === ",") {
      values.push(current);
      current = "";
      continue;
    }

    if (character === "\"") {
      inQuotes = true;
      continue;
    }

    current += character;
  }

  values.push(current.replace(/\r$/, ""));
  return values;
}

async function postAuditExport(
  body: AuditExportRequest,
  {
    claims,
    entries = [],
    authorization,
  }: {
    claims?: Parameters<typeof generateTestToken>[0];
    entries?: AuditEntryExport[];
    authorization?: string;
  } = {},
): Promise<Response> {
  const app = createTestApp({
    DB: createAuditExportD1(entries),
  });
  const token = authorization ?? `Bearer ${generateTestToken(claims)}`;
  const request = createTestRequest("POST", "/v1/audit/export", body, {
    Authorization: token,
  });

  return app.request(request, undefined, app.bindings);
}

test("POST /v1/audit/export with format=json returns JSON array", async () => {
  const entries: AuditEntryExport[] = [
    createAuditEntry(2, {
      id: "aud_export_json_002",
      orgId: "org_export_json",
      identityId: "agent_export_json_2",
      timestamp: "2026-03-24T12:00:02.000Z",
      createdAt: "2026-03-24T12:05:02.000Z",
    }),
    createAuditEntry(1, {
      id: "aud_export_json_001",
      orgId: "org_export_json",
      identityId: "agent_export_json_1",
      timestamp: "2026-03-24T12:00:01.000Z",
      createdAt: "2026-03-24T12:05:01.000Z",
    }),
  ];

  const response = await postAuditExport(
    {
      format: "json",
      orgId: "org_export_json",
    },
    {
      claims: {
        org: "org_export_json",
        scopes: ["relayauth:audit:read"],
      },
      entries,
    },
  );
  const body = await assertJsonResponse<AuditEntryExport[]>(response, 200);

  assert.ok(Array.isArray(body));
  assert.deepEqual(body, entries);
});

test("POST /v1/audit/export with format=csv returns CSV with headers", async () => {
  const entry = createAuditEntry(1, {
    id: "aud_export_csv_001",
    orgId: "org_export_csv",
    timestamp: "2026-03-24T12:00:01.000Z",
    createdAt: "2026-03-24T12:05:01.000Z",
  });

  const response = await postAuditExport(
    {
      format: "csv",
      orgId: "org_export_csv",
    },
    {
      claims: {
        org: "org_export_csv",
        scopes: ["relayauth:audit:read"],
      },
      entries: [entry],
    },
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/csv/i);

  const text = await response.text();
  const lines = text.trimEnd().split(/\r?\n/);

  assert.equal(
    lines[0],
    "id,action,identityId,orgId,workspaceId,plane,resource,result,metadata,ip,userAgent,timestamp,createdAt",
  );
  assert.equal(lines.length, 2);
});

test("CSV export includes all AuditEntry fields as columns", async () => {
  const entry = createAuditEntry(1, {
    id: "aud_export_columns_001",
    action: "scope.denied",
    identityId: "agent_export_columns",
    orgId: "org_export_columns",
    workspaceId: "ws_export_columns",
    plane: "relayauth",
    resource: "token:tok_export_columns",
    result: "denied",
    metadata: {
      scope: "relayauth:audit:read",
      reason: "missing grant",
    },
    ip: "198.51.100.42",
    userAgent: "@relayauth/sdk/1.0.0",
    timestamp: "2026-03-24T12:00:01.000Z",
    createdAt: "2026-03-24T12:05:01.000Z",
  });

  const response = await postAuditExport(
    {
      format: "csv",
      orgId: "org_export_columns",
    },
    {
      claims: {
        org: "org_export_columns",
        scopes: ["relayauth:audit:read"],
      },
      entries: [entry],
    },
  );

  assert.equal(response.status, 200);
  const text = await response.text();
  const [headerLine = "", rowLine = ""] = text.trimEnd().split(/\r?\n/);

  assert.deepEqual(parseCsvLine(headerLine), [
    "id",
    "action",
    "identityId",
    "orgId",
    "workspaceId",
    "plane",
    "resource",
    "result",
    "metadata",
    "ip",
    "userAgent",
    "timestamp",
    "createdAt",
  ]);

  assert.deepEqual(parseCsvLine(rowLine), [
    "aud_export_columns_001",
    "scope.denied",
    "agent_export_columns",
    "org_export_columns",
    "ws_export_columns",
    "relayauth",
    "token:tok_export_columns",
    "denied",
    JSON.stringify(entry.metadata),
    "198.51.100.42",
    "'@relayauth/sdk/1.0.0",
    "2026-03-24T12:00:01.000Z",
    "2026-03-24T12:05:01.000Z",
  ]);
});

test("Export respects the same filters as the audit query API", async () => {
  const entries: AuditEntryExport[] = [
    createAuditEntry(1, {
      id: "aud_export_filters_match",
      orgId: "org_export_filters",
      identityId: "agent_target",
      action: "scope.denied",
      workspaceId: "ws_target",
      plane: "relayauth",
      result: "denied",
      timestamp: "2026-03-24T11:00:00.000Z",
    }),
    createAuditEntry(2, {
      id: "aud_export_filters_identity",
      orgId: "org_export_filters",
      identityId: "agent_other",
      action: "scope.denied",
      workspaceId: "ws_target",
      plane: "relayauth",
      result: "denied",
      timestamp: "2026-03-24T11:00:01.000Z",
    }),
    createAuditEntry(3, {
      id: "aud_export_filters_action",
      orgId: "org_export_filters",
      identityId: "agent_target",
      action: "token.validated",
      workspaceId: "ws_target",
      plane: "relayauth",
      result: "denied",
      timestamp: "2026-03-24T11:00:02.000Z",
    }),
    createAuditEntry(4, {
      id: "aud_export_filters_workspace",
      orgId: "org_export_filters",
      identityId: "agent_target",
      action: "scope.denied",
      workspaceId: "ws_other",
      plane: "relayauth",
      result: "denied",
      timestamp: "2026-03-24T11:00:03.000Z",
    }),
    createAuditEntry(5, {
      id: "aud_export_filters_plane",
      orgId: "org_export_filters",
      identityId: "agent_target",
      action: "scope.denied",
      workspaceId: "ws_target",
      plane: "relaycast",
      result: "denied",
      timestamp: "2026-03-24T11:00:04.000Z",
    }),
    createAuditEntry(6, {
      id: "aud_export_filters_result",
      orgId: "org_export_filters",
      identityId: "agent_target",
      action: "scope.denied",
      workspaceId: "ws_target",
      plane: "relayauth",
      result: "allowed",
      timestamp: "2026-03-24T11:00:05.000Z",
    }),
    createAuditEntry(7, {
      id: "aud_export_filters_from",
      orgId: "org_export_filters",
      identityId: "agent_target",
      action: "scope.denied",
      workspaceId: "ws_target",
      plane: "relayauth",
      result: "denied",
      timestamp: "2026-03-24T09:59:59.999Z",
    }),
    createAuditEntry(8, {
      id: "aud_export_filters_to",
      orgId: "org_export_filters",
      identityId: "agent_target",
      action: "scope.denied",
      workspaceId: "ws_target",
      plane: "relayauth",
      result: "denied",
      timestamp: "2026-03-24T12:00:00.000Z",
    }),
    createAuditEntry(9, {
      id: "aud_export_filters_org",
      orgId: "org_other",
      identityId: "agent_target",
      action: "scope.denied",
      workspaceId: "ws_target",
      plane: "relayauth",
      result: "denied",
      timestamp: "2026-03-24T11:00:06.000Z",
    }),
  ];

  const response = await postAuditExport(
    {
      format: "json",
      orgId: "org_export_filters",
      identityId: "agent_target",
      action: "scope.denied",
      workspaceId: "ws_target",
      plane: "relayauth",
      result: "denied",
      from: "2026-03-24T10:00:00.000Z",
      to: "2026-03-24T12:00:00.000Z",
    },
    {
      claims: {
        org: "org_export_filters",
        scopes: ["relayauth:audit:read"],
      },
      entries,
    },
  );
  const body = await assertJsonResponse<AuditEntryExport[]>(response, 200);

  assert.deepEqual(
    body.map((entry) => entry.id),
    ["aud_export_filters_match"],
  );
});

test("Export has a max row limit of 10000", async () => {
  const entries = Array.from({ length: 10050 }, (_, index) =>
    createAuditEntry(index + 1, {
      orgId: "org_export_limit",
    }),
  );

  const response = await postAuditExport(
    {
      format: "json",
      orgId: "org_export_limit",
      limit: 20000,
    },
    {
      claims: {
        org: "org_export_limit",
        scopes: ["relayauth:audit:read"],
      },
      entries,
    },
  );
  const body = await assertJsonResponse<AuditEntryExport[]>(response, 200);

  assert.equal(body.length, 10000);
  assert.equal(body[0]?.id, "aud_10050");
  assert.equal(body.at(-1)?.id, "aud_00051");
});

test("POST /v1/audit/export returns 401 without valid auth token", async () => {
  const response = await postAuditExport(
    {
      format: "json",
      orgId: "org_export_auth_failure",
    },
    {
      authorization: "Bearer definitely-not-a-valid-token",
    },
  );

  assert.equal(response.status, 401);
});

test("POST /v1/audit/export returns 403 without relayauth:audit:read scope", async () => {
  const response = await postAuditExport(
    {
      format: "json",
      orgId: "org_export_scope_failure",
    },
    {
      claims: {
        org: "org_export_scope_failure",
        scopes: ["relayauth:identity:read:*"],
      },
    },
  );

  assert.equal(response.status, 403);
});

test("POST /v1/audit/export returns 400 for invalid format parameter", async () => {
  const response = await postAuditExport(
    {
      format: "xml",
      orgId: "org_export_invalid_format",
    },
    {
      claims: {
        org: "org_export_invalid_format",
        scopes: ["relayauth:audit:read"],
      },
    },
  );
  const body = await assertJsonResponse<{ error: string }>(response, 400);

  assert.match(body.error, /format/i);
});
