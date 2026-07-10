import assert from "node:assert/strict";
import test from "node:test";
import type { AuditAction, AuditEntry } from "@relayauth/types";
import {
  assertJsonResponse,
  createTestApp,
  createTestRequest,
  generateTestToken,
} from "./test-helpers.js";

type AuditQueryResponse = {
  entries: Array<AuditEntry & { createdAt?: string }>;
  nextCursor: string | null;
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

function createAuditEntry(
  index: number,
  overrides: Partial<AuditEntry & { createdAt?: string }> = {},
): AuditEntry & { createdAt?: string } {
  return {
    id: overrides.id ?? `aud_${String(index).padStart(3, "0")}`,
    action: overrides.action ?? "token.validated",
    identityId: overrides.identityId ?? `agent_${String(index).padStart(3, "0")}`,
    orgId: overrides.orgId ?? "org_test",
    ...(overrides.workspaceId !== undefined ? { workspaceId: overrides.workspaceId } : {}),
    plane: overrides.plane ?? "relayauth",
    resource: overrides.resource ?? `/resources/${index}`,
    result: overrides.result ?? "allowed",
    metadata: overrides.metadata ?? {
      sponsorId: "user_test",
      sponsorChain: JSON.stringify(["user_test", overrides.identityId ?? `agent_${String(index).padStart(3, "0")}`]),
      requestId: `req_${String(index).padStart(3, "0")}`,
    },
    ip: overrides.ip ?? "203.0.113.10",
    userAgent: overrides.userAgent ?? "audit-query-tests/1.0",
    timestamp: overrides.timestamp ?? new Date(Date.UTC(2026, 2, 24, 12, 0, index)).toISOString(),
    createdAt:
      overrides.createdAt ?? new Date(Date.UTC(2026, 2, 24, 12, 5, index)).toISOString(),
  };
}

function toAuditRow(entry: AuditEntry & { createdAt?: string }): AuditLogRow {
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

function createAuditQueryD1(entries: Array<AuditEntry & { createdAt?: string }>): D1Database {
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

function createAuditSearch(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.set(key, String(value));
    }
  }

  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
}

async function queryAudit(
  search = "",
  {
    claims,
    entries = [],
    authorization,
  }: {
    claims?: Parameters<typeof generateTestToken>[0];
    entries?: Array<AuditEntry & { createdAt?: string }>;
    authorization?: string;
  } = {},
): Promise<Response> {
  const app = createTestApp({
    DB: createAuditQueryD1(entries),
  });
  const token = authorization ?? `Bearer ${generateTestToken(claims)}`;
  const request = createTestRequest("GET", `/v1/audit${search}`, undefined, {
    Authorization: token,
  });

  return app.request(request, undefined, app.bindings);
}

test("GET /v1/audit returns paginated audit entries", async () => {
  const entries = [
    createAuditEntry(1, {
      id: "aud_feed_003",
      orgId: "org_audit_feed",
      identityId: "agent_feed_1",
      timestamp: "2026-03-24T12:00:03.000Z",
      createdAt: "2026-03-24T12:05:03.000Z",
    }),
    createAuditEntry(2, {
      id: "aud_feed_002",
      orgId: "org_audit_feed",
      identityId: "agent_feed_2",
      timestamp: "2026-03-24T12:00:02.000Z",
      createdAt: "2026-03-24T12:05:02.000Z",
    }),
  ];

  const response = await queryAudit(createAuditSearch({ orgId: "org_audit_feed" }), {
    claims: {
      org: "org_audit_feed",
      scopes: ["relayauth:audit:read"],
    },
    entries,
  });
  const body = await assertJsonResponse<AuditQueryResponse>(response, 200);

  assert.deepEqual(body.entries, entries);
  assert.equal(body.nextCursor, null);
});

test("GET /v1/audit filters by identityId query param", async () => {
  const entries = [
    createAuditEntry(1, {
      id: "aud_identity_003",
      orgId: "org_audit_identity",
      identityId: "agent_target",
      timestamp: "2026-03-24T12:00:03.000Z",
    }),
    createAuditEntry(2, {
      id: "aud_identity_002",
      orgId: "org_audit_identity",
      identityId: "agent_other",
      timestamp: "2026-03-24T12:00:02.000Z",
    }),
    createAuditEntry(3, {
      id: "aud_identity_001",
      orgId: "org_audit_identity",
      identityId: "agent_target",
      timestamp: "2026-03-24T12:00:01.000Z",
    }),
  ];

  const response = await queryAudit(
    createAuditSearch({
      orgId: "org_audit_identity",
      identityId: "agent_target",
    }),
    {
      claims: {
        org: "org_audit_identity",
        scopes: ["relayauth:audit:read"],
      },
      entries,
    },
  );
  const body = await assertJsonResponse<AuditQueryResponse>(response, 200);

  assert.deepEqual(
    body.entries.map((entry) => entry.id),
    ["aud_identity_003", "aud_identity_001"],
  );
  assert.ok(body.entries.every((entry) => entry.identityId === "agent_target"));
});

test("GET /v1/audit filters by action query param", async () => {
  const entries = [
    createAuditEntry(1, {
      id: "aud_action_003",
      orgId: "org_audit_action",
      action: "scope.denied",
      result: "denied",
      timestamp: "2026-03-24T12:00:03.000Z",
    }),
    createAuditEntry(2, {
      id: "aud_action_002",
      orgId: "org_audit_action",
      action: "token.validated",
      timestamp: "2026-03-24T12:00:02.000Z",
    }),
    createAuditEntry(3, {
      id: "aud_action_001",
      orgId: "org_audit_action",
      action: "scope.denied",
      result: "denied",
      timestamp: "2026-03-24T12:00:01.000Z",
    }),
  ];

  const response = await queryAudit(
    createAuditSearch({
      orgId: "org_audit_action",
      action: "scope.denied",
    }),
    {
      claims: {
        org: "org_audit_action",
        scopes: ["relayauth:audit:read"],
      },
      entries,
    },
  );
  const body = await assertJsonResponse<AuditQueryResponse>(response, 200);

  assert.deepEqual(
    body.entries.map((entry) => entry.id),
    ["aud_action_003", "aud_action_001"],
  );
  assert.ok(body.entries.every((entry) => entry.action === "scope.denied"));
});

test("GET /v1/audit filters by orgId query param", async () => {
  const entries = [
    createAuditEntry(1, {
      id: "aud_org_003",
      orgId: "org_target",
      timestamp: "2026-03-24T12:00:03.000Z",
    }),
    createAuditEntry(2, {
      id: "aud_org_002",
      orgId: "org_other",
      timestamp: "2026-03-24T12:00:02.000Z",
    }),
    createAuditEntry(3, {
      id: "aud_org_001",
      orgId: "org_target",
      timestamp: "2026-03-24T12:00:01.000Z",
    }),
  ];

  const response = await queryAudit(createAuditSearch({ orgId: "org_target" }), {
    claims: {
      org: "org_target",
      scopes: ["relayauth:audit:read"],
    },
    entries,
  });
  const body = await assertJsonResponse<AuditQueryResponse>(response, 200);

  assert.deepEqual(body.entries.map((entry) => entry.id), ["aud_org_003", "aud_org_001"]);
  assert.ok(body.entries.every((entry) => entry.orgId === "org_target"));
});

test("GET /v1/audit filters by date range using inclusive from and exclusive to", async () => {
  const entries = [
    createAuditEntry(1, {
      id: "aud_range_004",
      orgId: "org_audit_range",
      timestamp: "2026-03-24T12:00:00.000Z",
    }),
    createAuditEntry(2, {
      id: "aud_range_003",
      orgId: "org_audit_range",
      timestamp: "2026-03-24T11:00:00.000Z",
    }),
    createAuditEntry(3, {
      id: "aud_range_002",
      orgId: "org_audit_range",
      timestamp: "2026-03-24T10:00:00.000Z",
    }),
    createAuditEntry(4, {
      id: "aud_range_001",
      orgId: "org_audit_range",
      timestamp: "2026-03-24T09:59:59.999Z",
    }),
  ];

  const response = await queryAudit(
    createAuditSearch({
      orgId: "org_audit_range",
      from: "2026-03-24T10:00:00.000Z",
      to: "2026-03-24T12:00:00.000Z",
    }),
    {
      claims: {
        org: "org_audit_range",
        scopes: ["relayauth:audit:read"],
      },
      entries,
    },
  );
  const body = await assertJsonResponse<AuditQueryResponse>(response, 200);

  assert.deepEqual(body.entries.map((entry) => entry.id), ["aud_range_003", "aud_range_002"]);
});

test("GET /v1/audit filters by result query param", async () => {
  const entries = [
    createAuditEntry(1, {
      id: "aud_result_003",
      orgId: "org_audit_result",
      result: "denied",
      timestamp: "2026-03-24T12:00:03.000Z",
    }),
    createAuditEntry(2, {
      id: "aud_result_002",
      orgId: "org_audit_result",
      result: "allowed",
      timestamp: "2026-03-24T12:00:02.000Z",
    }),
    createAuditEntry(3, {
      id: "aud_result_001",
      orgId: "org_audit_result",
      result: "denied",
      timestamp: "2026-03-24T12:00:01.000Z",
    }),
  ];

  const response = await queryAudit(
    createAuditSearch({
      orgId: "org_audit_result",
      result: "denied",
    }),
    {
      claims: {
        org: "org_audit_result",
        scopes: ["relayauth:audit:read"],
      },
      entries,
    },
  );
  const body = await assertJsonResponse<AuditQueryResponse>(response, 200);

  assert.deepEqual(body.entries.map((entry) => entry.id), ["aud_result_003", "aud_result_001"]);
  assert.ok(body.entries.every((entry) => entry.result === "denied"));
});

test("GET /v1/audit supports cursor-based pagination with limit", async () => {
  const entries = [
    createAuditEntry(1, {
      id: "aud_page_003",
      orgId: "org_audit_page",
      timestamp: "2026-03-24T12:00:01.000Z",
    }),
    createAuditEntry(2, {
      id: "aud_page_002",
      orgId: "org_audit_page",
      timestamp: "2026-03-24T12:00:00.000Z",
    }),
    createAuditEntry(3, {
      id: "aud_page_001",
      orgId: "org_audit_page",
      timestamp: "2026-03-24T12:00:00.000Z",
    }),
  ];

  const firstPageResponse = await queryAudit(
    createAuditSearch({
      orgId: "org_audit_page",
      limit: 2,
    }),
    {
      claims: {
        org: "org_audit_page",
        scopes: ["relayauth:audit:read"],
      },
      entries,
    },
  );
  const firstPage = await assertJsonResponse<AuditQueryResponse>(firstPageResponse, 200);

  assert.deepEqual(firstPage.entries.map((entry) => entry.id), ["aud_page_003", "aud_page_002"]);
  assert.equal(typeof firstPage.nextCursor, "string");

  const secondPageResponse = await queryAudit(
    createAuditSearch({
      orgId: "org_audit_page",
      limit: 2,
      cursor: firstPage.nextCursor ?? undefined,
    }),
    {
      claims: {
        org: "org_audit_page",
        scopes: ["relayauth:audit:read"],
      },
      entries,
    },
  );
  const secondPage = await assertJsonResponse<AuditQueryResponse>(secondPageResponse, 200);

  assert.deepEqual(secondPage.entries.map((entry) => entry.id), ["aud_page_001"]);
  assert.equal(secondPage.nextCursor, null);
});

test("GET /v1/audit returns 400 when orgId is missing", async () => {
  const response = await queryAudit("", {
    claims: { org: "org_test", scopes: ["relayauth:audit:read"] },
  });
  const body = await response.json() as { error: string };

  assert.equal(response.status, 400);
  assert.equal(body.error, "orgId query param is required");
});

test("GET /v1/audit returns 400 for invalid action", async () => {
  const response = await queryAudit(createAuditSearch({ orgId: "org_test", action: "bogus.action" }), {
    claims: { org: "org_test", scopes: ["relayauth:audit:read"] },
  });
  const body = await response.json() as { error: string };

  assert.equal(response.status, 400);
  assert.match(body.error, /invalid action/);
});

test("GET /v1/audit returns 400 for invalid cursor", async () => {
  const response = await queryAudit(createAuditSearch({ orgId: "org_test", cursor: "not-valid-base64-cursor" }), {
    claims: { org: "org_test", scopes: ["relayauth:audit:read"] },
  });
  const body = await response.json() as { error: string };

  assert.equal(response.status, 400);
  assert.equal(body.error, "invalid cursor");
});

test("GET /v1/audit returns 400 for invalid limit", async () => {
  const response = await queryAudit(createAuditSearch({ orgId: "org_test", limit: "abc" }), {
    claims: { org: "org_test", scopes: ["relayauth:audit:read"] },
  });
  const body = await response.json() as { error: string };

  assert.equal(response.status, 400);
  assert.equal(body.error, "limit must be a positive integer");
});

test("GET /v1/audit returns 401 without valid auth token", async () => {
  const response = await queryAudit(createAuditSearch({ orgId: "org_auth_failure" }), {
    authorization: "Bearer definitely-not-a-valid-token",
  });

  assert.equal(response.status, 401);
});

test("GET /v1/audit returns 403 without relayauth:audit:read scope", async () => {
  const response = await queryAudit(createAuditSearch({ orgId: "org_scope_failure" }), {
    claims: {
      org: "org_scope_failure",
      scopes: ["relayauth:identity:read:*"],
    },
  });

  assert.equal(response.status, 403);
});
