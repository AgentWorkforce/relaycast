import assert from "node:assert/strict";
import test from "node:test";
import type { AgentIdentity, AuditEntry, RelayAuthTokenClaims } from "@relayauth/types";
import {
  assertJsonResponse,
  createTestApp,
  createTestRequest,
  generateTestIdentity,
  generateTestToken,
} from "./test-helpers.js";

type DashboardStatsResponse = {
  tokensIssued: number;
  tokensRevoked: number;
  scopeChecks: number;
  scopeDenials: number;
  activeIdentities: number;
  suspendedIdentities: number;
};

type AuditLogRow = {
  id: string;
  action: AuditEntry["action"];
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

type IdentityRow = AgentIdentity & {
  org_id: string;
  created_at: string;
  updated_at: string;
  last_active_at?: string;
  suspended_at?: string;
  suspend_reason?: string;
  scopes_json: string;
  roles_json: string;
  metadata_json: string;
};

function createAuditEntry(
  index: number,
  overrides: Partial<AuditEntry & { createdAt?: string }> = {},
): AuditEntry & { createdAt?: string } {
  const padded = String(index).padStart(3, "0");
  const identityId = overrides.identityId ?? `agent_stats_${padded}`;

  return {
    id: overrides.id ?? `aud_stats_${padded}`,
    action: overrides.action ?? "token.issued",
    identityId,
    orgId: overrides.orgId ?? "org_stats",
    ...(overrides.workspaceId !== undefined ? { workspaceId: overrides.workspaceId } : {}),
    ...(overrides.plane !== undefined ? { plane: overrides.plane } : {}),
    ...(overrides.resource !== undefined ? { resource: overrides.resource } : {}),
    result: overrides.result ?? "allowed",
    metadata: overrides.metadata ?? {
      sponsorId: "user_stats_owner",
      sponsorChain: JSON.stringify(["user_stats_owner", identityId]),
      requestId: `req_stats_${padded}`,
    },
    ...(overrides.ip !== undefined ? { ip: overrides.ip } : {}),
    ...(overrides.userAgent !== undefined ? { userAgent: overrides.userAgent } : {}),
    timestamp:
      overrides.timestamp ?? new Date(Date.UTC(2026, 2, 24, 12, 0, index)).toISOString(),
    createdAt:
      overrides.createdAt ?? new Date(Date.UTC(2026, 2, 24, 12, 5, index)).toISOString(),
  };
}

function createIdentity(
  index: number,
  overrides: Partial<AgentIdentity> = {},
): AgentIdentity {
  return generateTestIdentity({
    id: overrides.id ?? `agent_identity_${String(index).padStart(3, "0")}`,
    name: overrides.name ?? `Stats Identity ${index}`,
    orgId: overrides.orgId ?? "org_stats",
    status: overrides.status ?? "active",
    createdAt:
      overrides.createdAt ?? new Date(Date.UTC(2026, 2, 24, 9, 0, index)).toISOString(),
    updatedAt:
      overrides.updatedAt ?? new Date(Date.UTC(2026, 2, 24, 10, 0, index)).toISOString(),
    ...(overrides.lastActiveAt !== undefined ? { lastActiveAt: overrides.lastActiveAt } : {}),
    ...(overrides.suspendedAt !== undefined ? { suspendedAt: overrides.suspendedAt } : {}),
    ...(overrides.suspendReason !== undefined ? { suspendReason: overrides.suspendReason } : {}),
  });
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

function toIdentityRow(identity: AgentIdentity): IdentityRow {
  return {
    ...identity,
    org_id: identity.orgId,
    created_at: identity.createdAt,
    updated_at: identity.updatedAt,
    ...(identity.lastActiveAt !== undefined ? { last_active_at: identity.lastActiveAt } : {}),
    ...(identity.suspendedAt !== undefined ? { suspended_at: identity.suspendedAt } : {}),
    ...(identity.suspendReason !== undefined ? { suspend_reason: identity.suspendReason } : {}),
    scopes_json: JSON.stringify(identity.scopes),
    roles_json: JSON.stringify(identity.roles),
    metadata_json: JSON.stringify(identity.metadata),
  };
}

function normalizeSql(query: string): string {
  return query.replace(/\s+/g, " ").trim().toLowerCase();
}

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}\.\d{3}z$/i.test(value)
  );
}

function extractAuditFilters(
  query: string,
  params: unknown[],
): {
  orgId?: string;
  from?: string;
  to?: string;
} {
  const normalized = normalizeSql(query);
  const stringParams = params.filter((param): param is string => typeof param === "string");
  let offset = 0;
  const filters: { orgId?: string; from?: string; to?: string } = {};

  const tryConsume = (pattern: RegExp): string | undefined => {
    if (!pattern.test(normalized)) {
      return undefined;
    }

    const value = stringParams[offset];
    offset += 1;
    return value;
  };

  filters.orgId = tryConsume(/\borg_id\s*=\s*\?/i);

  const from = tryConsume(/\btimestamp\s*>=\s*\?/i);
  if (isIsoTimestamp(from)) {
    filters.from = from;
  }

  const to = tryConsume(/\btimestamp\s*<\s*\?/i);
  if (isIsoTimestamp(to)) {
    filters.to = to;
  }

  if (!filters.orgId) {
    filters.orgId = stringParams.find((value) => value.startsWith("org_"));
  }

  if (!filters.from) {
    filters.from = stringParams.find(isIsoTimestamp);
  }

  if (!filters.to) {
    const timestamps = stringParams.filter(isIsoTimestamp);
    filters.to = timestamps[1];
  }

  return filters;
}

function createDashboardStatsD1({
  entries = [],
  identities = [],
}: {
  entries?: Array<AuditEntry & { createdAt?: string }>;
  identities?: AgentIdentity[];
} = {}): D1Database {
  const auditRows = entries.map(toAuditRow);
  const identityRows = identities.map(toIdentityRow);
  const meta = {
    changed_db: false,
    changes: 0,
    duration: 0,
    rows_read: 0,
    rows_written: 0,
  };

  const resolveAggregateRow = (
    query: string,
    params: unknown[],
  ): DashboardStatsResponse | null => {
    const normalized = normalizeSql(query);
    const referencesAuditLogs = /\baudit_logs\b/.test(normalized);
    const referencesIdentities = /\bidentities\b/.test(normalized);

    if (!referencesAuditLogs && !referencesIdentities) {
      return null;
    }

    const { orgId, from, to } = extractAuditFilters(query, params);

    const filteredAuditRows = auditRows.filter((row) => {
      if (orgId && row.org_id !== orgId) {
        return false;
      }

      if (from && row.timestamp < from) {
        return false;
      }

      if (to && row.timestamp >= to) {
        return false;
      }

      return true;
    });

    const filteredIdentityRows = identityRows.filter((row) => !orgId || row.org_id === orgId);

    return {
      tokensIssued: filteredAuditRows.filter((row) => row.action === "token.issued").length,
      tokensRevoked: filteredAuditRows.filter((row) => row.action === "token.revoked").length,
      scopeChecks: filteredAuditRows.filter(
        (row) =>
          row.action === "scope.checked" &&
          (row.result === "allowed" || row.result === "denied"),
      ).length,
      scopeDenials: filteredAuditRows.filter((row) => row.action === "scope.denied").length,
      activeIdentities: filteredIdentityRows.filter((row) => row.status === "active").length,
      suspendedIdentities: filteredIdentityRows.filter((row) => row.status === "suspended").length,
    };
  };

  const createPreparedStatement = (query: string) => ({
    bind: (...params: unknown[]) => ({
      first: async <T>() => (resolveAggregateRow(query, params) as T | null) ?? null,
      run: async () => ({ success: true, meta }),
      raw: async <T>() => {
        const row = resolveAggregateRow(query, params);
        return (row ? [row] : []) as T[];
      },
      all: async <T>() => {
        const row = resolveAggregateRow(query, params);
        return {
          results: (row ? [row] : []) as T[],
          success: true,
          meta,
        };
      },
    }),
    first: async <T>() => (resolveAggregateRow(query, []) as T | null) ?? null,
    run: async () => ({ success: true, meta }),
    raw: async <T>() => {
      const row = resolveAggregateRow(query, []);
      return (row ? [row] : []) as T[];
    },
    all: async <T>() => {
      const row = resolveAggregateRow(query, []);
      return {
        results: (row ? [row] : []) as T[],
        success: true,
        meta,
      };
    },
  });

  return {
    prepare: (query: string) => createPreparedStatement(query),
    batch: async <T>(statements: D1PreparedStatement[]) =>
      Promise.all(statements.map((statement) => statement.run())) as Awaited<T>,
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  } as D1Database;
}

function createStatsSearch(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.set(key, value);
    }
  }

  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
}

async function getDashboardStats(
  search = "",
  {
    claims,
    authorization,
    entries = [],
    identities = [],
  }: {
    claims?: Partial<RelayAuthTokenClaims>;
    authorization?: string;
    entries?: Array<AuditEntry & { createdAt?: string }>;
    identities?: AgentIdentity[];
  } = {},
): Promise<Response> {
  const app = createTestApp({
    DB: createDashboardStatsD1({
      entries,
      identities,
    }),
  });
  const headers = new Headers();

  if (authorization !== undefined) {
    headers.set("Authorization", authorization);
  } else if (claims) {
    headers.set("Authorization", `Bearer ${generateTestToken(claims)}`);
  } else {
    headers.set(
      "Authorization",
      `Bearer ${generateTestToken({
        org: "org_stats",
        scopes: ["relayauth:stats:read"],
      })}`,
    );
  }

  const request = createTestRequest("GET", `/v1/stats${search}`, undefined, headers);
  return app.request(request, undefined, app.bindings);
}

test("GET /v1/stats returns aggregate stats object", async () => {
  const response = await getDashboardStats("", {
    claims: {
      org: "org_stats_contract",
      scopes: ["relayauth:stats:read"],
    },
    entries: [
      createAuditEntry(1, { orgId: "org_stats_contract", action: "token.issued" }),
      createAuditEntry(2, { orgId: "org_stats_contract", action: "token.revoked" }),
      createAuditEntry(3, { orgId: "org_stats_contract", action: "scope.checked", result: "allowed" }),
      createAuditEntry(4, { orgId: "org_stats_contract", action: "scope.denied", result: "denied" }),
    ],
    identities: [
      createIdentity(1, { orgId: "org_stats_contract", status: "active" }),
      createIdentity(2, { orgId: "org_stats_contract", status: "suspended" }),
    ],
  });
  const body = await assertJsonResponse<DashboardStatsResponse>(response, 200);

  assert.deepEqual(Object.keys(body).sort(), [
    "activeIdentities",
    "scopeChecks",
    "scopeDenials",
    "suspendedIdentities",
    "tokensIssued",
    "tokensRevoked",
  ]);
  assert.equal(typeof body.tokensIssued, "number");
  assert.equal(typeof body.tokensRevoked, "number");
  assert.equal(typeof body.scopeChecks, "number");
  assert.equal(typeof body.scopeDenials, "number");
  assert.equal(typeof body.activeIdentities, "number");
  assert.equal(typeof body.suspendedIdentities, "number");
});

test("GET /v1/stats includes tokensIssued count", async () => {
  const response = await getDashboardStats("", {
    claims: {
      org: "org_tokens_issued",
      scopes: ["relayauth:stats:read"],
    },
    entries: [
      createAuditEntry(1, { orgId: "org_tokens_issued", action: "token.issued" }),
      createAuditEntry(2, { orgId: "org_tokens_issued", action: "token.issued" }),
      createAuditEntry(3, { orgId: "org_tokens_issued", action: "token.revoked" }),
    ],
  });
  const body = await assertJsonResponse<DashboardStatsResponse>(response, 200);

  assert.equal(body.tokensIssued, 2);
});

test("GET /v1/stats includes tokensRevoked count", async () => {
  const response = await getDashboardStats("", {
    claims: {
      org: "org_tokens_revoked",
      scopes: ["relayauth:stats:read"],
    },
    entries: [
      createAuditEntry(1, { orgId: "org_tokens_revoked", action: "token.revoked" }),
      createAuditEntry(2, { orgId: "org_tokens_revoked", action: "token.revoked" }),
      createAuditEntry(3, { orgId: "org_tokens_revoked", action: "token.issued" }),
    ],
  });
  const body = await assertJsonResponse<DashboardStatsResponse>(response, 200);

  assert.equal(body.tokensRevoked, 2);
});

test("GET /v1/stats includes scopeChecks count for allowed and denied evaluations", async () => {
  const response = await getDashboardStats("", {
    claims: {
      org: "org_scope_checks",
      scopes: ["relayauth:stats:read"],
    },
    entries: [
      createAuditEntry(1, { orgId: "org_scope_checks", action: "scope.checked", result: "allowed" }),
      createAuditEntry(2, { orgId: "org_scope_checks", action: "scope.checked", result: "denied" }),
      createAuditEntry(3, { orgId: "org_scope_checks", action: "scope.checked", result: "error" }),
      createAuditEntry(4, { orgId: "org_scope_checks", action: "scope.denied", result: "denied" }),
    ],
  });
  const body = await assertJsonResponse<DashboardStatsResponse>(response, 200);

  assert.equal(body.scopeChecks, 2);
});

test("GET /v1/stats includes scopeDenials count", async () => {
  const response = await getDashboardStats("", {
    claims: {
      org: "org_scope_denials",
      scopes: ["relayauth:stats:read"],
    },
    entries: [
      createAuditEntry(1, { orgId: "org_scope_denials", action: "scope.denied", result: "denied" }),
      createAuditEntry(2, { orgId: "org_scope_denials", action: "scope.denied", result: "denied" }),
      createAuditEntry(3, { orgId: "org_scope_denials", action: "scope.checked", result: "denied" }),
    ],
  });
  const body = await assertJsonResponse<DashboardStatsResponse>(response, 200);

  assert.equal(body.scopeDenials, 2);
});

test("GET /v1/stats includes activeIdentities count", async () => {
  const response = await getDashboardStats("", {
    claims: {
      org: "org_active_identities",
      scopes: ["relayauth:stats:read"],
    },
    identities: [
      createIdentity(1, { orgId: "org_active_identities", status: "active" }),
      createIdentity(2, { orgId: "org_active_identities", status: "active" }),
      createIdentity(3, { orgId: "org_active_identities", status: "suspended" }),
      createIdentity(4, { orgId: "org_active_identities", status: "retired" }),
    ],
  });
  const body = await assertJsonResponse<DashboardStatsResponse>(response, 200);

  assert.equal(body.activeIdentities, 2);
});

test("GET /v1/stats includes suspendedIdentities count", async () => {
  const response = await getDashboardStats("", {
    claims: {
      org: "org_suspended_identities",
      scopes: ["relayauth:stats:read"],
    },
    identities: [
      createIdentity(1, { orgId: "org_suspended_identities", status: "suspended" }),
      createIdentity(2, { orgId: "org_suspended_identities", status: "suspended" }),
      createIdentity(3, { orgId: "org_suspended_identities", status: "active" }),
    ],
  });
  const body = await assertJsonResponse<DashboardStatsResponse>(response, 200);

  assert.equal(body.suspendedIdentities, 2);
});

test("GET /v1/stats supports time range filter via from/to query params", async () => {
  const response = await getDashboardStats(
    createStatsSearch({
      from: "2026-03-24T12:00:02.000Z",
      to: "2026-03-24T12:00:05.000Z",
    }),
    {
      claims: {
        org: "org_time_range",
        scopes: ["relayauth:stats:read"],
      },
      entries: [
        createAuditEntry(1, {
          orgId: "org_time_range",
          action: "token.issued",
          timestamp: "2026-03-24T12:00:01.000Z",
        }),
        createAuditEntry(2, {
          orgId: "org_time_range",
          action: "token.issued",
          timestamp: "2026-03-24T12:00:02.000Z",
        }),
        createAuditEntry(3, {
          orgId: "org_time_range",
          action: "token.revoked",
          timestamp: "2026-03-24T12:00:03.000Z",
        }),
        createAuditEntry(4, {
          orgId: "org_time_range",
          action: "scope.checked",
          result: "allowed",
          timestamp: "2026-03-24T12:00:04.000Z",
        }),
        createAuditEntry(5, {
          orgId: "org_time_range",
          action: "scope.denied",
          result: "denied",
          timestamp: "2026-03-24T12:00:05.000Z",
        }),
      ],
      identities: [
        createIdentity(1, { orgId: "org_time_range", status: "active" }),
        createIdentity(2, { orgId: "org_time_range", status: "suspended" }),
      ],
    },
  );
  const body = await assertJsonResponse<DashboardStatsResponse>(response, 200);

  assert.equal(body.tokensIssued, 1);
  assert.equal(body.tokensRevoked, 1);
  assert.equal(body.scopeChecks, 1);
  assert.equal(body.scopeDenials, 0);
});

test("GET /v1/stats is scoped to the caller's org", async () => {
  const response = await getDashboardStats("", {
    claims: {
      org: "org_scoped",
      scopes: ["relayauth:stats:read"],
    },
    entries: [
      createAuditEntry(1, { orgId: "org_scoped", action: "token.issued" }),
      createAuditEntry(2, { orgId: "org_scoped", action: "token.revoked" }),
      createAuditEntry(3, { orgId: "org_other", action: "token.issued" }),
      createAuditEntry(4, { orgId: "org_other", action: "scope.denied", result: "denied" }),
    ],
    identities: [
      createIdentity(1, { orgId: "org_scoped", status: "active" }),
      createIdentity(2, { orgId: "org_other", status: "active" }),
      createIdentity(3, { orgId: "org_other", status: "suspended" }),
    ],
  });
  const body = await assertJsonResponse<DashboardStatsResponse>(response, 200);

  assert.equal(body.tokensIssued, 1);
  assert.equal(body.tokensRevoked, 1);
  assert.equal(body.scopeChecks, 0);
  assert.equal(body.scopeDenials, 0);
  assert.equal(body.activeIdentities, 1);
  assert.equal(body.suspendedIdentities, 0);
});

test("GET /v1/stats returns 401 without valid auth token", async () => {
  const app = createTestApp({
    DB: createDashboardStatsD1(),
  });
  const request = createTestRequest("GET", "/v1/stats");
  const response = await app.request(request, undefined, app.bindings);

  assert.equal(response.status, 401);
});

test("GET /v1/stats returns 403 without relayauth:stats:read scope", async () => {
  const response = await getDashboardStats("", {
    claims: {
      org: "org_scope_failure",
      scopes: ["relayauth:audit:read"],
    },
  });

  assert.equal(response.status, 403);
});
