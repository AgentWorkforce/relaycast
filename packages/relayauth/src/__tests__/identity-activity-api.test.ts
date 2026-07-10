import assert from "node:assert/strict";
import test from "node:test";
import type { AuditAction, AuditEntry, RelayAuthTokenClaims } from "@relayauth/types";
import type { StoredIdentity } from "../durable-objects/identity-do.js";
import {
  assertJsonResponse,
  createTestApp,
  createTestRequest,
  generateTestIdentity,
  generateTestToken,
} from "./test-helpers.js";

type ActivityEntry = AuditEntry & { createdAt?: string };

type IdentityActivityBudgetUsage = {
  actionsThisHour: number;
  costToday: number;
  percentOfBudget: number;
};

type IdentityActivitySubAgent = {
  id: string;
  name: string;
  status: StoredIdentity["status"];
  children: IdentityActivitySubAgent[];
};

type IdentityActivityResponse = {
  entries: ActivityEntry[];
  nextCursor: string | null;
  hasMore: boolean;
  sponsorChain: string[];
  budgetUsage: IdentityActivityBudgetUsage;
  subAgents: IdentityActivitySubAgent[];
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

type IdentityRow = {
  id: string;
  name: string;
  type: StoredIdentity["type"];
  orgId: string;
  org_id: string;
  status: StoredIdentity["status"];
  scopes: string;
  scopes_json: string;
  roles: string;
  roles_json: string;
  metadata: string;
  metadata_json: string;
  createdAt: string;
  created_at: string;
  updatedAt: string;
  updated_at: string;
  sponsorId: string;
  sponsor_id: string;
  sponsorChain: string;
  sponsor_chain: string;
  workspaceId: string;
  workspace_id: string;
  lastActiveAt?: string;
  last_active_at?: string;
  suspendedAt?: string;
  suspended_at?: string;
  suspendReason?: string;
  suspend_reason?: string;
};

function createStoredIdentity(overrides: Partial<StoredIdentity> = {}): StoredIdentity {
  const base = generateTestIdentity(overrides);
  const sponsorId = overrides.sponsorId ?? "user_activity_owner";

  return {
    ...base,
    sponsorId,
    sponsorChain: overrides.sponsorChain ?? [sponsorId, "agent_root_activity", base.id],
    workspaceId: overrides.workspaceId ?? "ws_activity",
    ...(overrides.budget !== undefined ? { budget: overrides.budget } : {}),
    ...(overrides.budgetUsage !== undefined ? { budgetUsage: overrides.budgetUsage } : {}),
  };
}

function createAuditEntry(
  index: number,
  overrides: Partial<ActivityEntry> = {},
): ActivityEntry {
  const padded = String(index).padStart(3, "0");
  const identityId = overrides.identityId ?? "agent_activity_target";

  return {
    id: overrides.id ?? `aud_activity_${padded}`,
    action: overrides.action ?? "token.validated",
    identityId,
    orgId: overrides.orgId ?? "org_activity",
    ...(overrides.workspaceId !== undefined ? { workspaceId: overrides.workspaceId } : {}),
    plane: overrides.plane ?? "relayauth",
    resource: overrides.resource ?? `resource:${padded}`,
    result: overrides.result ?? "allowed",
    metadata: overrides.metadata ?? {
      sponsorId: "user_activity_owner",
      sponsorChain: JSON.stringify(["user_activity_owner", "agent_root_activity", identityId]),
      requestId: `req_activity_${padded}`,
    },
    ip: overrides.ip ?? "203.0.113.25",
    userAgent: overrides.userAgent ?? "identity-activity-tests/1.0",
    timestamp: overrides.timestamp ?? new Date(Date.UTC(2026, 2, 24, 12, 0, index)).toISOString(),
    createdAt:
      overrides.createdAt ?? new Date(Date.UTC(2026, 2, 24, 12, 5, index)).toISOString(),
  };
}

function toAuditRow(entry: ActivityEntry): AuditLogRow {
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

function toIdentityRow(identity: StoredIdentity): IdentityRow {
  return {
    id: identity.id,
    name: identity.name,
    type: identity.type,
    orgId: identity.orgId,
    org_id: identity.orgId,
    status: identity.status,
    scopes: JSON.stringify(identity.scopes),
    scopes_json: JSON.stringify(identity.scopes),
    roles: JSON.stringify(identity.roles),
    roles_json: JSON.stringify(identity.roles),
    metadata: JSON.stringify(identity.metadata),
    metadata_json: JSON.stringify(identity.metadata),
    createdAt: identity.createdAt,
    created_at: identity.createdAt,
    updatedAt: identity.updatedAt,
    updated_at: identity.updatedAt,
    sponsorId: identity.sponsorId,
    sponsor_id: identity.sponsorId,
    sponsorChain: JSON.stringify(identity.sponsorChain),
    sponsor_chain: JSON.stringify(identity.sponsorChain),
    workspaceId: identity.workspaceId,
    workspace_id: identity.workspaceId,
    ...(identity.lastActiveAt !== undefined
      ? { lastActiveAt: identity.lastActiveAt, last_active_at: identity.lastActiveAt }
      : {}),
    ...(identity.suspendedAt !== undefined
      ? { suspendedAt: identity.suspendedAt, suspended_at: identity.suspendedAt }
      : {}),
    ...(identity.suspendReason !== undefined
      ? { suspendReason: identity.suspendReason, suspend_reason: identity.suspendReason }
      : {}),
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

function encodeCursor(timestamp: string, id: string): string {
  return Buffer.from(`${timestamp}|${id}`).toString("base64url");
}

function createIdentityActivityD1({
  entries = [],
  identities = [],
}: {
  entries?: ActivityEntry[];
  identities?: StoredIdentity[];
} = {}): D1Database {
  const auditRows = entries.map(toAuditRow).sort(compareAuditRowsDesc);
  const identityRows = identities.map(toIdentityRow);
  const meta = {
    changed_db: false,
    changes: 0,
    duration: 0,
    rows_read: 0,
    rows_written: 0,
  };

  const resolveAuditRows = (query: string, params: unknown[]): AuditLogRow[] => {
    const normalized = normalizeSql(query);
    if (!/\bfrom audit_logs\b/.test(normalized)) {
      return [];
    }

    let filtered = [...auditRows];
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

  const resolveIdentityRows = (query: string, params: unknown[]): IdentityRow[] => {
    const normalized = normalizeSql(query);
    if (!/\bfrom identities\b/.test(normalized)) {
      return [];
    }

    let filtered = [...identityRows];
    let limit: number | undefined;
    let boundParams = [...params];

    const lastParam = boundParams.at(-1);
    if (typeof lastParam === "number" && Number.isFinite(lastParam)) {
      limit = lastParam;
      boundParams = boundParams.slice(0, -1);
    }

    const clausePositions = [
      { type: "orgId", index: normalized.search(/\borg_id\s*=\s*\?/i), arity: 1 },
      { type: "id", index: normalized.search(/\bid\s*=\s*\?/i), arity: 1 },
      { type: "sponsorId", index: normalized.search(/\bsponsor_id\s*=\s*\?/i), arity: 1 },
      { type: "workspaceId", index: normalized.search(/\bworkspace_id\s*=\s*\?/i), arity: 1 },
      { type: "status", index: normalized.search(/\bstatus\s*=\s*\?/i), arity: 1 },
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

    const id = values.get("id")?.[0];
    if (typeof id === "string") {
      filtered = filtered.filter((row) => row.id === id);
    }

    const sponsorId = values.get("sponsorId")?.[0];
    if (typeof sponsorId === "string") {
      filtered = filtered.filter((row) => row.sponsor_id === sponsorId);
    }

    const workspaceId = values.get("workspaceId")?.[0];
    if (typeof workspaceId === "string") {
      filtered = filtered.filter((row) => row.workspace_id === workspaceId);
    }

    const status = values.get("status")?.[0];
    if (typeof status === "string") {
      filtered = filtered.filter((row) => row.status === status);
    }

    if (typeof limit === "number" && Number.isFinite(limit)) {
      filtered = filtered.slice(0, limit);
    }

    return filtered;
  };

  const resolveRows = (query: string, params: unknown[]): unknown[] => {
    if (/\bfrom audit_logs\b/i.test(query)) {
      return resolveAuditRows(query, params);
    }

    if (/\bfrom identities\b/i.test(query)) {
      return resolveIdentityRows(query, params);
    }

    return [];
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

function createIdentityNamespace(
  identities: StoredIdentity[],
): DurableObjectNamespace {
  const byId = new Map(identities.map((identity) => [identity.id, identity]));

  return {
    idFromName: (name: string) => name,
    get: (id: DurableObjectId | string) => ({
      fetch: async (request: Request) => {
        const identityId = String(id);
        const identity = byId.get(identityId);
        const { pathname } = new URL(request.url);

        if (pathname === "/internal/get" && request.method === "GET") {
          if (!identity) {
            return new Response(JSON.stringify({ error: "identity_not_found" }), {
              status: 404,
              headers: { "content-type": "application/json" },
            });
          }

          return new Response(JSON.stringify(identity), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        return new Response(JSON.stringify({ error: `unexpected_do_request:${request.method}:${pathname}` }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      },
    }),
  } as unknown as DurableObjectNamespace;
}

function createActivitySearch(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.set(key, String(value));
    }
  }

  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
}

async function getIdentityActivity(
  identityId: string,
  search = "",
  {
    claims,
    authorization,
    entries = [],
    identities = [],
  }: {
    claims?: Partial<RelayAuthTokenClaims>;
    authorization?: string;
    entries?: ActivityEntry[];
    identities?: StoredIdentity[];
  } = {},
): Promise<Response> {
  const app = createTestApp({
    DB: createIdentityActivityD1({ entries, identities }),
    IDENTITY_DO: createIdentityNamespace(identities),
  });
  const token = authorization ?? `Bearer ${generateTestToken(claims)}`;
  const request = createTestRequest(
    "GET",
    `/v1/identities/${identityId}/activity${search}`,
    undefined,
    {
      Authorization: token,
    },
  );

  return app.request(request, undefined, app.bindings);
}

function summarizeSubAgents(nodes: IdentityActivitySubAgent[]): unknown[] {
  return nodes.map((node) => ({
    id: node.id,
    name: node.name,
    status: node.status,
    children: summarizeSubAgents(node.children),
  }));
}

test("GET /v1/identities/:id/activity returns audit entries plus budget usage, sponsorChain, and sub-agent tree", async () => {
  const identity = createStoredIdentity({
    id: "agent_activity_target",
    orgId: "org_activity_contract",
    name: "Target Agent",
    sponsorChain: ["user_activity_owner", "agent_root_activity", "agent_activity_target"],
    budget: {
      maxActionsPerHour: 100,
      maxCostPerDay: 100,
    },
    budgetUsage: {
      actionsThisHour: 45,
      costToday: 45,
      lastResetAt: "2026-03-24T00:00:00.000Z",
    },
  });
  const child = createStoredIdentity({
    id: "agent_activity_child",
    orgId: identity.orgId,
    name: "Child Agent",
    sponsorId: identity.id,
    sponsorChain: [...identity.sponsorChain, identity.id],
  });
  const grandchild = createStoredIdentity({
    id: "agent_activity_grandchild",
    orgId: identity.orgId,
    name: "Grandchild Agent",
    sponsorId: child.id,
    sponsorChain: [...child.sponsorChain, child.id],
  });
  const sibling = createStoredIdentity({
    id: "agent_activity_sibling",
    orgId: identity.orgId,
    name: "Sibling Agent",
    sponsorId: "agent_someone_else",
    sponsorChain: ["user_activity_owner", "agent_root_activity", "agent_someone_else"],
  });
  const entries = [
    createAuditEntry(1, {
      id: "aud_activity_003",
      orgId: identity.orgId,
      identityId: identity.id,
      action: "scope.denied",
      result: "denied",
      timestamp: "2026-03-24T12:00:03.000Z",
      createdAt: "2026-03-24T12:05:03.000Z",
    }),
    createAuditEntry(2, {
      id: "aud_activity_002",
      orgId: identity.orgId,
      identityId: identity.id,
      action: "token.validated",
      timestamp: "2026-03-24T12:00:02.000Z",
      createdAt: "2026-03-24T12:05:02.000Z",
    }),
    createAuditEntry(3, {
      id: "aud_activity_001",
      orgId: identity.orgId,
      identityId: "agent_other_identity",
      timestamp: "2026-03-24T12:00:01.000Z",
      createdAt: "2026-03-24T12:05:01.000Z",
    }),
  ];

  const response = await getIdentityActivity(identity.id, "", {
    claims: {
      org: identity.orgId,
      scopes: ["relayauth:audit:read"],
    },
    entries,
    identities: [identity, child, grandchild, sibling],
  });
  const body = await assertJsonResponse<IdentityActivityResponse>(response, 200);

  assert.deepEqual(
    body.entries.map((entry) => entry.id),
    ["aud_activity_003", "aud_activity_002"],
  );
  assert.deepEqual(body.sponsorChain, identity.sponsorChain);
  assert.deepEqual(body.budgetUsage, {
    actionsThisHour: 45,
    costToday: 45,
    percentOfBudget: 45,
  });
  assert.deepEqual(summarizeSubAgents(body.subAgents), [
    {
      id: "agent_activity_child",
      name: "Child Agent",
      status: "active",
      children: [
        {
          id: "agent_activity_grandchild",
          name: "Grandchild Agent",
          status: "active",
          children: [],
        },
      ],
    },
  ]);
  assert.equal(body.nextCursor, null);
  assert.equal(body.hasMore, false);
});

test("GET /v1/identities/:id/activity only returns entries for the requested identity", async () => {
  const identity = createStoredIdentity({
    id: "agent_activity_filter_target",
    orgId: "org_activity_filter",
  });
  const entries = [
    createAuditEntry(1, {
      id: "aud_filter_003",
      orgId: identity.orgId,
      identityId: identity.id,
      timestamp: "2026-03-24T12:00:03.000Z",
    }),
    createAuditEntry(2, {
      id: "aud_filter_002",
      orgId: identity.orgId,
      identityId: "agent_activity_filter_other",
      timestamp: "2026-03-24T12:00:02.000Z",
    }),
    createAuditEntry(3, {
      id: "aud_filter_001",
      orgId: identity.orgId,
      identityId: identity.id,
      timestamp: "2026-03-24T12:00:01.000Z",
    }),
  ];

  const response = await getIdentityActivity(identity.id, "", {
    claims: {
      org: identity.orgId,
      scopes: ["relayauth:audit:read"],
    },
    entries,
    identities: [identity],
  });
  const body = await assertJsonResponse<IdentityActivityResponse>(response, 200);

  assert.deepEqual(body.entries.map((entry) => entry.id), ["aud_filter_003", "aud_filter_001"]);
  assert.ok(body.entries.every((entry) => entry.identityId === identity.id));
});

test("GET /v1/identities/:id/activity supports action filter", async () => {
  const identity = createStoredIdentity({
    id: "agent_activity_action_target",
    orgId: "org_activity_action",
  });
  const entries = [
    createAuditEntry(1, {
      id: "aud_action_003",
      orgId: identity.orgId,
      identityId: identity.id,
      action: "scope.denied",
      result: "denied",
      timestamp: "2026-03-24T12:00:03.000Z",
    }),
    createAuditEntry(2, {
      id: "aud_action_002",
      orgId: identity.orgId,
      identityId: identity.id,
      action: "token.validated",
      timestamp: "2026-03-24T12:00:02.000Z",
    }),
    createAuditEntry(3, {
      id: "aud_action_001",
      orgId: identity.orgId,
      identityId: identity.id,
      action: "scope.denied",
      result: "denied",
      timestamp: "2026-03-24T12:00:01.000Z",
    }),
  ];

  const response = await getIdentityActivity(
    identity.id,
    createActivitySearch({ action: "scope.denied" }),
    {
      claims: {
        org: identity.orgId,
        scopes: ["relayauth:audit:read"],
      },
      entries,
      identities: [identity],
    },
  );
  const body = await assertJsonResponse<IdentityActivityResponse>(response, 200);

  assert.deepEqual(body.entries.map((entry) => entry.id), ["aud_action_003", "aud_action_001"]);
  assert.ok(body.entries.every((entry) => entry.action === "scope.denied"));
});

test("GET /v1/identities/:id/activity supports inclusive from and exclusive to filters", async () => {
  const identity = createStoredIdentity({
    id: "agent_activity_range_target",
    orgId: "org_activity_range",
  });
  const entries = [
    createAuditEntry(1, {
      id: "aud_range_004",
      orgId: identity.orgId,
      identityId: identity.id,
      timestamp: "2026-03-24T12:00:04.000Z",
    }),
    createAuditEntry(2, {
      id: "aud_range_003",
      orgId: identity.orgId,
      identityId: identity.id,
      timestamp: "2026-03-24T12:00:03.000Z",
    }),
    createAuditEntry(3, {
      id: "aud_range_002",
      orgId: identity.orgId,
      identityId: identity.id,
      timestamp: "2026-03-24T12:00:02.000Z",
    }),
    createAuditEntry(4, {
      id: "aud_range_001",
      orgId: identity.orgId,
      identityId: identity.id,
      timestamp: "2026-03-24T12:00:01.000Z",
    }),
  ];

  const response = await getIdentityActivity(
    identity.id,
    createActivitySearch({
      from: "2026-03-24T12:00:02.000Z",
      to: "2026-03-24T12:00:04.000Z",
    }),
    {
      claims: {
        org: identity.orgId,
        scopes: ["relayauth:audit:read"],
      },
      entries,
      identities: [identity],
    },
  );
  const body = await assertJsonResponse<IdentityActivityResponse>(response, 200);

  assert.deepEqual(body.entries.map((entry) => entry.id), ["aud_range_003", "aud_range_002"]);
});

test("GET /v1/identities/:id/activity supports cursor-based pagination", async () => {
  const identity = createStoredIdentity({
    id: "agent_activity_page_target",
    orgId: "org_activity_page",
  });
  const entries = [
    createAuditEntry(1, {
      id: "aud_page_004",
      orgId: identity.orgId,
      identityId: identity.id,
      timestamp: "2026-03-24T12:00:04.000Z",
    }),
    createAuditEntry(2, {
      id: "aud_page_003",
      orgId: identity.orgId,
      identityId: identity.id,
      timestamp: "2026-03-24T12:00:03.000Z",
    }),
    createAuditEntry(3, {
      id: "aud_page_002",
      orgId: identity.orgId,
      identityId: identity.id,
      timestamp: "2026-03-24T12:00:02.000Z",
    }),
    createAuditEntry(4, {
      id: "aud_page_001",
      orgId: identity.orgId,
      identityId: identity.id,
      timestamp: "2026-03-24T12:00:01.000Z",
    }),
  ];

  const firstPageResponse = await getIdentityActivity(
    identity.id,
    createActivitySearch({ limit: 2 }),
    {
      claims: {
        org: identity.orgId,
        scopes: ["relayauth:audit:read"],
      },
      entries,
      identities: [identity],
    },
  );
  const firstPage = await assertJsonResponse<IdentityActivityResponse>(firstPageResponse, 200);

  assert.deepEqual(firstPage.entries.map((entry) => entry.id), ["aud_page_004", "aud_page_003"]);
  assert.equal(firstPage.hasMore, true);
  assert.equal(
    firstPage.nextCursor,
    encodeCursor("2026-03-24T12:00:03.000Z", "aud_page_003"),
  );

  const secondPageResponse = await getIdentityActivity(
    identity.id,
    createActivitySearch({
      limit: 2,
      cursor: firstPage.nextCursor ?? undefined,
    }),
    {
      claims: {
        org: identity.orgId,
        scopes: ["relayauth:audit:read"],
      },
      entries,
      identities: [identity],
    },
  );
  const secondPage = await assertJsonResponse<IdentityActivityResponse>(secondPageResponse, 200);

  assert.deepEqual(secondPage.entries.map((entry) => entry.id), ["aud_page_002", "aud_page_001"]);
  assert.equal(secondPage.nextCursor, null);
  assert.equal(secondPage.hasMore, false);
});

test("GET /v1/identities/:id/activity returns 404 when the identity does not exist", async () => {
  const response = await getIdentityActivity(
    "agent_activity_missing",
    "",
    {
      claims: {
        org: "org_activity_missing",
        scopes: ["relayauth:audit:read"],
      },
      entries: [],
      identities: [],
    },
  );

  const body = await assertJsonResponse<{ error: string }>(response, 404);
  assert.deepEqual(body, { error: "identity_not_found" });
});

test("GET /v1/identities/:id/activity returns 401 without a valid auth token", async () => {
  const identity = createStoredIdentity({
    id: "agent_activity_auth_target",
    orgId: "org_activity_auth",
  });

  const response = await getIdentityActivity(identity.id, "", {
    authorization: "Bearer definitely-not-a-valid-token",
    identities: [identity],
  });

  assert.equal(response.status, 401);
});

test("GET /v1/identities/:id/activity returns 403 without relayauth:audit:read scope", async () => {
  const identity = createStoredIdentity({
    id: "agent_activity_scope_target",
    orgId: "org_activity_scope",
  });

  const response = await getIdentityActivity(identity.id, "", {
    claims: {
      org: identity.orgId,
      scopes: ["relayauth:identity:read:*"],
    },
    identities: [identity],
  });

  assert.equal(response.status, 403);
});

test("GET /v1/identities/:id/activity only returns entries from the caller's org", async () => {
  const identity = createStoredIdentity({
    id: "agent_activity_org_target",
    orgId: "org_activity_visible",
  });
  const entries = [
    createAuditEntry(1, {
      id: "aud_org_003",
      orgId: identity.orgId,
      identityId: identity.id,
      timestamp: "2026-03-24T12:00:03.000Z",
    }),
    createAuditEntry(2, {
      id: "aud_org_002",
      orgId: "org_activity_hidden",
      identityId: identity.id,
      timestamp: "2026-03-24T12:00:02.000Z",
    }),
    createAuditEntry(3, {
      id: "aud_org_001",
      orgId: identity.orgId,
      identityId: identity.id,
      timestamp: "2026-03-24T12:00:01.000Z",
    }),
  ];

  const response = await getIdentityActivity(identity.id, "", {
    claims: {
      org: identity.orgId,
      scopes: ["relayauth:audit:read"],
    },
    entries,
    identities: [identity],
  });
  const body = await assertJsonResponse<IdentityActivityResponse>(response, 200);

  assert.deepEqual(body.entries.map((entry) => entry.id), ["aud_org_003", "aud_org_001"]);
  assert.ok(body.entries.every((entry) => entry.orgId === identity.orgId));
});
