import assert from "node:assert/strict";
import test from "node:test";
import type { AgentIdentity, IdentityStatus, IdentityType, RelayAuthTokenClaims } from "@relayauth/types";
import {
  assertJsonResponse,
  createTestApp,
  createTestRequest,
  generateTestIdentity,
  generateTestToken,
} from "./test-helpers.js";

type ListIdentitiesResponse = {
  data: AgentIdentity[];
  cursor?: string;
};

type ListIdentityRow = AgentIdentity & {
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

function createIdentity(
  index: number,
  overrides: Partial<AgentIdentity> = {},
): AgentIdentity {
  return generateTestIdentity({
    id: overrides.id ?? `agent_${String(index).padStart(3, "0")}`,
    name: overrides.name ?? `Identity ${index}`,
    type: overrides.type ?? "agent",
    orgId: overrides.orgId ?? "org_test",
    status: overrides.status ?? "active",
    scopes: overrides.scopes ?? [`scope:${index}`],
    roles: overrides.roles ?? [`role:${index}`],
    metadata: overrides.metadata ?? { index: String(index) },
    createdAt: overrides.createdAt ?? new Date(Date.UTC(2026, 2, 24, 12, 0, 0, 1000 - index)).toISOString(),
    updatedAt: overrides.updatedAt ?? new Date(Date.UTC(2026, 2, 24, 12, 5, 0, 1000 - index)).toISOString(),
    ...(overrides.lastActiveAt !== undefined ? { lastActiveAt: overrides.lastActiveAt } : {}),
    ...(overrides.suspendedAt !== undefined ? { suspendedAt: overrides.suspendedAt } : {}),
    ...(overrides.suspendReason !== undefined ? { suspendReason: overrides.suspendReason } : {}),
  });
}

function toListRow(identity: AgentIdentity): ListIdentityRow {
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

function decodeCursorCandidate(
  value: string,
): { id?: string; createdAt?: string } | null {
  const tryParse = (candidate: string): { id?: string; createdAt?: string } | null => {
    const trimmed = candidate.trim();
    if (!trimmed) {
      return null;
    }

    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const id = typeof parsed.id === "string" ? parsed.id : undefined;
      const createdAt =
        typeof parsed.createdAt === "string"
          ? parsed.createdAt
          : typeof parsed.created_at === "string"
            ? parsed.created_at
            : undefined;

      if (id || createdAt) {
        return { id, createdAt };
      }
    } catch {
      // Fall through to plain-string handling.
    }

    return {
      ...(trimmed ? { id: trimmed, createdAt: trimmed } : {}),
    };
  };

  const direct = tryParse(value);
  if (direct?.id || direct?.createdAt) {
    return direct;
  }

  for (const encoding of ["base64url", "base64"] as const) {
    try {
      const decoded = Buffer.from(value, encoding).toString("utf8");
      const parsed = tryParse(decoded);
      if (parsed?.id || parsed?.createdAt) {
        return parsed;
      }
    } catch {
      // Ignore invalid base64 variants.
    }
  }

  return null;
}

function createListScenarioD1(identities: AgentIdentity[]): D1Database {
  const meta = {
    changed_db: false,
    changes: 0,
    duration: 0,
    rows_read: 0,
    rows_written: 0,
  };

  const resolveRows = (query: string, params: unknown[]): ListIdentityRow[] => {
    const normalized = normalizeSql(query);
    if (!/from identities\b/.test(normalized) && !/\bidentities\b/.test(normalized)) {
      return [];
    }

    let rows = identities.map(toListRow);
    const stringParams = params.filter((param): param is string => typeof param === "string");
    const numberParams = params.filter((param): param is number => typeof param === "number" && Number.isFinite(param));

    const orgId = stringParams.find((param) => rows.some((row) => row.orgId === param || row.org_id === param));
    if (orgId) {
      rows = rows.filter((row) => row.orgId === orgId || row.org_id === orgId);
    }

    const status = stringParams.find((param): param is IdentityStatus =>
      param === "active" || param === "suspended" || param === "retired",
    );
    if (status) {
      rows = rows.filter((row) => row.status === status);
    }

    const type = stringParams.find((param): param is IdentityType =>
      param === "agent" || param === "human" || param === "service",
    );
    if (type) {
      rows = rows.filter((row) => row.type === type);
    }

    const cursor = stringParams
      .map((param) => decodeCursorCandidate(param))
      .find((candidate) =>
        candidate &&
        rows.some((row) => row.id === candidate.id || row.createdAt === candidate.createdAt),
      );
    if (cursor) {
      const anchorIndex = rows.findIndex(
        (row) => row.id === cursor.id || row.createdAt === cursor.createdAt,
      );
      if (anchorIndex >= 0) {
        rows = rows.slice(anchorIndex + 1);
      }
    }

    const inlineLimitMatch = normalized.match(/\blimit\s+(\d+)\b/);
    const limit = numberParams[0] ?? (inlineLimitMatch ? Number.parseInt(inlineLimitMatch[1] ?? "", 10) : undefined);
    if (typeof limit === "number" && Number.isFinite(limit)) {
      rows = rows.slice(0, limit);
    }

    return rows;
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

async function listIdentities(
  search = "",
  {
    claims,
    identities = [],
  }: {
    claims?: Partial<RelayAuthTokenClaims>;
    identities?: AgentIdentity[];
  } = {},
): Promise<Response> {
  const app = createTestApp({
    DB: createListScenarioD1(identities),
  });
  const token = generateTestToken(claims);
  const request = createTestRequest(
    "GET",
    `/v1/identities${search}`,
    undefined,
    {
      Authorization: `Bearer ${token}`,
    },
  );

  return app.request(request, undefined, app.bindings);
}

test("GET /v1/identities returns 200 with { data: [...], cursor?: string }", async () => {
  const identities = [
    createIdentity(1, {
      id: "agent_contract_1",
      name: "Contract One",
      createdAt: "2026-03-24T12:00:03.000Z",
      updatedAt: "2026-03-24T12:00:03.000Z",
    }),
    createIdentity(2, {
      id: "agent_contract_2",
      name: "Contract Two",
      createdAt: "2026-03-24T12:00:02.000Z",
      updatedAt: "2026-03-24T12:00:02.000Z",
    }),
  ];

  const response = await listIdentities("", { identities });
  const body = await assertJsonResponse<ListIdentitiesResponse>(response, 200);

  assert.ok(Array.isArray(body.data));
  assert.deepEqual(body.data, identities);
  assert.equal("cursor" in body, false);
});

test("GET /v1/identities returns an empty array when no identities exist", async () => {
  const response = await listIdentities();
  const body = await assertJsonResponse<ListIdentitiesResponse>(response, 200);

  assert.deepEqual(body, { data: [] });
});

test("GET /v1/identities returns all identities for the authenticated org", async () => {
  const identities = [
    createIdentity(1, {
      id: "agent_org_1",
      orgId: "org_test",
      createdAt: "2026-03-24T12:00:03.000Z",
      updatedAt: "2026-03-24T12:00:03.000Z",
    }),
    createIdentity(2, {
      id: "agent_org_2",
      orgId: "org_test",
      createdAt: "2026-03-24T12:00:02.000Z",
      updatedAt: "2026-03-24T12:00:02.000Z",
    }),
    createIdentity(3, {
      id: "agent_other_org",
      orgId: "org_other",
      createdAt: "2026-03-24T12:00:01.000Z",
      updatedAt: "2026-03-24T12:00:01.000Z",
    }),
  ];

  const response = await listIdentities("", {
    claims: { org: "org_test" },
    identities,
  });
  const body = await assertJsonResponse<ListIdentitiesResponse>(response, 200);

  assert.deepEqual(body.data.map((identity) => identity.id), ["agent_org_1", "agent_org_2"]);
  assert.ok(body.data.every((identity) => identity.orgId === "org_test"));
});

test("GET /v1/identities supports the status=active filter", async () => {
  const identities = [
    createIdentity(1, {
      id: "agent_active_1",
      status: "active",
      createdAt: "2026-03-24T12:00:03.000Z",
      updatedAt: "2026-03-24T12:00:03.000Z",
    }),
    createIdentity(2, {
      id: "agent_suspended_1",
      status: "suspended",
      suspendedAt: "2026-03-24T11:59:00.000Z",
      suspendReason: "manual_review",
      createdAt: "2026-03-24T12:00:02.000Z",
      updatedAt: "2026-03-24T12:00:02.000Z",
    }),
    createIdentity(3, {
      id: "agent_active_2",
      status: "active",
      createdAt: "2026-03-24T12:00:01.000Z",
      updatedAt: "2026-03-24T12:00:01.000Z",
    }),
  ];

  const response = await listIdentities("?status=active", { identities });
  const body = await assertJsonResponse<ListIdentitiesResponse>(response, 200);

  assert.deepEqual(body.data.map((identity) => identity.id), ["agent_active_1", "agent_active_2"]);
  assert.ok(body.data.every((identity) => identity.status === "active"));
});

test("GET /v1/identities supports the type=agent filter", async () => {
  const identities = [
    createIdentity(1, {
      id: "agent_type_agent_1",
      type: "agent",
      createdAt: "2026-03-24T12:00:03.000Z",
      updatedAt: "2026-03-24T12:00:03.000Z",
    }),
    createIdentity(2, {
      id: "agent_type_human_1",
      type: "human",
      createdAt: "2026-03-24T12:00:02.000Z",
      updatedAt: "2026-03-24T12:00:02.000Z",
    }),
    createIdentity(3, {
      id: "agent_type_service_1",
      type: "service",
      createdAt: "2026-03-24T12:00:01.000Z",
      updatedAt: "2026-03-24T12:00:01.000Z",
    }),
  ];

  const response = await listIdentities("?type=agent", { identities });
  const body = await assertJsonResponse<ListIdentitiesResponse>(response, 200);

  assert.deepEqual(body.data.map((identity) => identity.id), ["agent_type_agent_1"]);
  assert.ok(body.data.every((identity) => identity.type === "agent"));
});

test("GET /v1/identities uses a default limit of 50 results", async () => {
  const identities = Array.from({ length: 60 }, (_, index) =>
    createIdentity(index + 1, {
      id: `agent_default_limit_${String(index + 1).padStart(3, "0")}`,
      createdAt: new Date(Date.UTC(2026, 2, 24, 12, 0, 60 - index)).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 2, 24, 12, 0, 60 - index)).toISOString(),
    }),
  );

  const response = await listIdentities("", { identities });
  const body = await assertJsonResponse<ListIdentitiesResponse>(response, 200);

  assert.equal(body.data.length, 50);
  assert.equal(typeof body.cursor, "string");
});

test("GET /v1/identities caps limit at 100 results", async () => {
  const identities = Array.from({ length: 150 }, (_, index) =>
    createIdentity(index + 1, {
      id: `agent_max_limit_${String(index + 1).padStart(3, "0")}`,
      createdAt: new Date(Date.UTC(2026, 2, 24, 12, 0, 150 - index)).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 2, 24, 12, 0, 150 - index)).toISOString(),
    }),
  );

  const response = await listIdentities("?limit=500", { identities });
  const body = await assertJsonResponse<ListIdentitiesResponse>(response, 200);

  assert.equal(body.data.length, 100);
  assert.equal(typeof body.cursor, "string");
});

test("GET /v1/identities supports cursor-based pagination", async () => {
  const identities = [
    createIdentity(1, {
      id: "agent_page_1",
      createdAt: "2026-03-24T12:00:04.000Z",
      updatedAt: "2026-03-24T12:00:04.000Z",
    }),
    createIdentity(2, {
      id: "agent_page_2",
      createdAt: "2026-03-24T12:00:03.000Z",
      updatedAt: "2026-03-24T12:00:03.000Z",
    }),
    createIdentity(3, {
      id: "agent_page_3",
      createdAt: "2026-03-24T12:00:02.000Z",
      updatedAt: "2026-03-24T12:00:02.000Z",
    }),
    createIdentity(4, {
      id: "agent_page_4",
      createdAt: "2026-03-24T12:00:01.000Z",
      updatedAt: "2026-03-24T12:00:01.000Z",
    }),
  ];

  const firstPageResponse = await listIdentities("?limit=2", { identities });
  const firstPage = await assertJsonResponse<ListIdentitiesResponse>(firstPageResponse, 200);

  assert.deepEqual(firstPage.data.map((identity) => identity.id), ["agent_page_1", "agent_page_2"]);
  assert.equal(typeof firstPage.cursor, "string");

  const secondPageResponse = await listIdentities(`?limit=2&cursor=${encodeURIComponent(firstPage.cursor ?? "")}`, {
    identities,
  });
  const secondPage = await assertJsonResponse<ListIdentitiesResponse>(secondPageResponse, 200);

  assert.deepEqual(secondPage.data.map((identity) => identity.id), ["agent_page_3", "agent_page_4"]);
  assert.equal("cursor" in secondPage, false);
});

test("GET /v1/identities sorts results by createdAt descending", async () => {
  const identities = [
    createIdentity(2, {
      id: "agent_newest",
      createdAt: "2026-03-24T12:00:03.000Z",
      updatedAt: "2026-03-24T12:00:03.000Z",
    }),
    createIdentity(3, {
      id: "agent_middle",
      createdAt: "2026-03-24T12:00:02.000Z",
      updatedAt: "2026-03-24T12:00:02.000Z",
    }),
    createIdentity(1, {
      id: "agent_oldest",
      createdAt: "2026-03-24T12:00:01.000Z",
      updatedAt: "2026-03-24T12:00:01.000Z",
    }),
  ];

  const response = await listIdentities("", { identities });
  const body = await assertJsonResponse<ListIdentitiesResponse>(response, 200);

  assert.deepEqual(body.data.map((identity) => identity.id), ["agent_newest", "agent_middle", "agent_oldest"]);
});
