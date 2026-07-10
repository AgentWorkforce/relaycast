import assert from "node:assert/strict";
import test from "node:test";
import type { AuditAction, AuditEntry, RelayAuthTokenClaims } from "@relayauth/types";

import type { StoredIdentity } from "../../durable-objects/identity-do.js";
import { countExpiredEntries, purgeExpiredEntries } from "../../engine/audit-retention.js";
import { writeAuditEntry } from "../../engine/audit-logger.js";
import { dispatchWebhook } from "../../engine/audit-webhook-dispatcher.js";
import { checkAccess } from "../../engine/policy-evaluation.js";
import {
  assertJsonResponse,
  createTestApp,
  createTestRequest,
  generateTestIdentity,
  generateTestToken,
} from "../test-helpers.js";

type ExtendedAuditAction =
  | AuditAction
  | "budget.exceeded"
  | "budget.alert"
  | "scope.escalation_denied";

type ObservedAuditEntry = Omit<AuditEntry, "action"> & {
  action: ExtendedAuditAction;
  createdAt?: string;
};

type AuditQueryResponse = {
  entries: ObservedAuditEntry[];
  nextCursor: string | null;
  hasMore: boolean;
};

type AuditActivityResponse = {
  entries: ObservedAuditEntry[];
  nextCursor: string | null;
  hasMore: boolean;
  sponsorChain: string[];
  budgetUsage: {
    actionsThisHour: number;
    costToday: number;
    percentOfBudget: number;
  };
  subAgents: IdentityActivityNode[];
};

type IdentityActivityNode = {
  id: string;
  name: string;
  status: StoredIdentity["status"];
  children: IdentityActivityNode[];
};

type DashboardStatsResponse = {
  tokensIssued: number;
  tokensRevoked: number;
  tokensRefreshed?: number;
  scopeChecks: number;
  scopeDenials: number;
  activeIdentities: number;
  suspendedIdentities: number;
};

type AuditWebhookRecord = {
  id: string;
  orgId: string;
  url: string;
  secret: string;
  events?: string[];
  createdAt?: string;
  updatedAt?: string;
};

type AuditLogRow = {
  id: string;
  action: ExtendedAuditAction;
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

type HarnessState = {
  auditLogs: AuditLogRow[];
  auditWebhooks: Map<string, AuditWebhookRecord>;
  identities: Map<string, StoredIdentity>;
  executed: Array<{ query: string; params: unknown[] }>;
};

type AuditHarness = {
  app: ReturnType<typeof createTestApp>;
  db: D1Database;
  state: HarnessState;
  request: (
    method: string,
    path: string,
    options?: {
      body?: unknown;
      claims?: Partial<RelayAuthTokenClaims>;
      headers?: HeadersInit;
    },
  ) => Promise<Response>;
};

type SeededScenario = {
  harness: AuditHarness;
  targetIdentity: StoredIdentity;
  childIdentity: StoredIdentity;
  grandchildIdentity: StoredIdentity;
  budgetExceededIdentity: StoredIdentity;
  budgetAlertIdentity: StoredIdentity;
};

type AuditWriteInput = Parameters<typeof writeAuditEntry>[1];

const ORG_ID = "org_audit_observability";
const WORKSPACE_ID = "ws_audit_observability";
const BUDGET_SCOPE = "relaycast:workspace:write:billing";

const TIMESTAMPS = {
  tokenIssued: "2026-03-24T09:00:00.000Z",
  identityCreated: "2026-03-24T10:00:00.000Z",
  scopeChecked: "2026-03-24T11:00:00.000Z",
  scopeDenied: "2026-03-24T12:00:00.000Z",
  scopeEscalationDenied: "2026-03-24T12:30:00.000Z",
} as const;

const CSV_HEADER = [
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
].join(",");

test("Audit & Observability E2E", async (t) => {
  const scenario = await seedScenario();

  await t.test("records base and extended audit actions with the full sponsorChain", async () => {
    const response = await scenario.harness.request("GET", `/v1/audit?orgId=${ORG_ID}`);
    const body = await assertJsonResponse<AuditQueryResponse>(response, 200);

    const actions = new Set(body.entries.map((entry) => entry.action));
    assert.deepEqual(
      actions,
      new Set<ExtendedAuditAction>([
        "token.issued",
        "identity.created",
        "scope.checked",
        "scope.denied",
        "budget.exceeded",
        "budget.alert",
        "scope.escalation_denied",
      ]),
    );

    const issued = body.entries.find((entry) => entry.action === "token.issued");
    assert.ok(issued?.metadata?.sponsorChain);
    assert.deepEqual(
      JSON.parse(issued.metadata.sponsorChain),
      scenario.targetIdentity.sponsorChain,
    );

    const budgetExceeded = body.entries.find((entry) => entry.action === "budget.exceeded");
    assert.ok(budgetExceeded?.metadata?.sponsorChain);
    assert.deepEqual(
      JSON.parse(budgetExceeded.metadata.sponsorChain),
      scenario.budgetExceededIdentity.sponsorChain,
    );

    const scopeEscalation = body.entries.find(
      (entry) => entry.action === "scope.escalation_denied",
    );
    assert.equal(
      scopeEscalation?.metadata?.actionAttempted,
      "relaycast:workspace:admin:billing",
    );
  });

  await t.test("filters audit entries by identity, action, and date range", async () => {
    const byIdentityResponse = await scenario.harness.request(
      "GET",
      `/v1/audit?orgId=${ORG_ID}&identityId=${scenario.targetIdentity.id}`,
    );
    const byIdentity = await assertJsonResponse<AuditQueryResponse>(byIdentityResponse, 200);

    assert.equal(byIdentity.entries.length, 5);
    assert.ok(
      byIdentity.entries.every((entry) => entry.identityId === scenario.targetIdentity.id),
    );

    const byActionResponse = await scenario.harness.request(
      "GET",
      `/v1/audit?orgId=${ORG_ID}&action=scope.checked`,
    );
    const byAction = await assertJsonResponse<AuditQueryResponse>(byActionResponse, 200);

    assert.equal(byAction.entries.length, 1);
    assert.equal(byAction.entries[0]?.action, "scope.checked");

    const byRangeResponse = await scenario.harness.request(
      "GET",
      `/v1/audit?orgId=${ORG_ID}&from=2026-03-24T09:30:00.000Z&to=2026-03-24T12:15:00.000Z`,
    );
    const byRange = await assertJsonResponse<AuditQueryResponse>(byRangeResponse, 200);

    assert.deepEqual(
      new Set(byRange.entries.map((entry) => entry.action)),
      new Set<ExtendedAuditAction>(["identity.created", "scope.checked", "scope.denied"]),
    );
  });

  await t.test("exports audit entries as JSON and CSV", async () => {
    const jsonResponse = await scenario.harness.request("POST", "/v1/audit/export", {
      body: {
        format: "json",
        orgId: ORG_ID,
      },
    });
    const jsonBody = await assertJsonResponse<ObservedAuditEntry[]>(jsonResponse, 200);

    assert.equal(jsonBody.length, 7);
    assert.ok(jsonBody.some((entry) => entry.action === "budget.exceeded"));
    assert.ok(jsonBody.some((entry) => entry.action === "scope.escalation_denied"));

    const csvResponse = await scenario.harness.request("POST", "/v1/audit/export", {
      body: {
        format: "csv",
        orgId: ORG_ID,
      },
    });

    assert.equal(csvResponse.status, 200);
    assert.match(csvResponse.headers.get("content-type") ?? "", /text\/csv/i);

    const csv = await csvResponse.text();
    const lines = csv.trim().split("\n");
    assert.equal(lines[0], CSV_HEADER);
    assert.equal(lines.length, 8);

    const csvRows = lines.slice(1).map(parseCsvLine);
    assert.ok(csvRows.some((row) => row[1] === "budget.exceeded"));
    assert.ok(csvRows.some((row) => row[1] === "scope.escalation_denied"));
  });

  await t.test("creates, lists, dispatches, and deletes audit webhooks", async (subtest) => {
    const createResponse = await scenario.harness.request("POST", "/v1/audit/webhooks", {
      body: {
        orgId: ORG_ID,
        url: "https://audit.example.com/hooks/budget-alert",
        events: ["budget.alert"],
        secret: "whsec_audit_budget_alert",
      },
    });
    const createdWebhook = await assertJsonResponse<AuditWebhookRecord>(createResponse, 201);

    assert.deepEqual(createdWebhook.events, ["budget.alert"]);

    const listResponse = await scenario.harness.request(
      "GET",
      `/v1/audit/webhooks?orgId=${ORG_ID}`,
    );
    const listedWebhooks = await assertJsonResponse<AuditWebhookRecord[]>(listResponse, 200);

    assert.equal(listedWebhooks.length, 1);
    assert.equal(listedWebhooks[0]?.id, createdWebhook.id);
    assert.equal(listedWebhooks[0]?.secret, "****lert");

    const alertRow = scenario.harness.state.auditLogs.find((row) => row.action === "budget.alert");
    assert.ok(alertRow, "expected a budget.alert audit row");

    const requests: Array<{ request: Request; body: string }> = [];
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const body = await request.text();
      requests.push({ request, body });
      return new Response(null, { status: 202 });
    }) as typeof globalThis.fetch;

    subtest.after(() => {
      globalThis.fetch = originalFetch;
    });

    await dispatchWebhook(createdWebhook, toObservedAuditEntry(alertRow));

    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.request.url, createdWebhook.url);
    assert.match(requests[0]?.request.headers.get("x-relayauth-signature") ?? "", /^sha256=/);

    const payload = JSON.parse(requests[0]?.body ?? "{}") as {
      type: string;
      entry: ObservedAuditEntry;
    };

    assert.equal(payload.type, "audit.event");
    assert.equal(payload.entry.action, "budget.alert");
    assert.deepEqual(
      JSON.parse(payload.entry.metadata?.sponsorChain ?? "[]"),
      scenario.budgetAlertIdentity.sponsorChain,
    );

    const deleteResponse = await scenario.harness.request(
      "DELETE",
      `/v1/audit/webhooks/${createdWebhook.id}?orgId=${ORG_ID}`,
    );
    assert.equal(deleteResponse.status, 204);

    const listAfterDeleteResponse = await scenario.harness.request(
      "GET",
      `/v1/audit/webhooks?orgId=${ORG_ID}`,
    );
    const listAfterDelete = await assertJsonResponse<AuditWebhookRecord[]>(
      listAfterDeleteResponse,
      200,
    );

    assert.deepEqual(listAfterDelete, []);
  });

  await t.test("returns identity activity scoped to one identity", async () => {
    const response = await scenario.harness.request(
      "GET",
      `/v1/identities/${scenario.targetIdentity.id}/activity`,
    );
    const body = await assertJsonResponse<AuditActivityResponse>(response, 200);

    assert.equal(body.entries.length, 5);
    assert.ok(body.entries.every((entry) => entry.identityId === scenario.targetIdentity.id));
    assert.deepEqual(body.sponsorChain, scenario.targetIdentity.sponsorChain);
    assert.equal(body.subAgents[0]?.id, scenario.childIdentity.id);
    assert.equal(body.subAgents[0]?.children[0]?.id, scenario.grandchildIdentity.id);
  });

  await t.test("reports dashboard stats from the actions performed", async () => {
    const response = await scenario.harness.request("GET", "/v1/stats");
    const body = await assertJsonResponse<DashboardStatsResponse>(response, 200);

    assert.equal(body.tokensIssued, 1);
    assert.equal(body.scopeChecks, 1);
    assert.equal(body.scopeDenials, 1);
    assert.equal(body.activeIdentities, 4);
    assert.equal(body.suspendedIdentities, 1);
  });

  await t.test("purges retained audit rows older than the cutoff", async () => {
    await writeAuditEntry(scenario.harness.db, {
      id: "aud_retention_old",
      action: "token.issued",
      identityId: scenario.targetIdentity.id,
      orgId: ORG_ID,
      workspaceId: WORKSPACE_ID,
      plane: "relayauth",
      resource: "token:legacy",
      result: "allowed",
      metadata: {
        sponsorId: scenario.targetIdentity.sponsorId,
        sponsorChain: JSON.stringify(scenario.targetIdentity.sponsorChain),
      },
      timestamp: daysAgo(120),
    });

    const beforePurge = await countExpiredEntries(scenario.harness.db, 90);
    assert.deepEqual(beforePurge, { expiredCount: 1 });

    const purged = await purgeExpiredEntries(scenario.harness.db, 90);
    assert.deepEqual(purged, { deletedCount: 1 });

    const afterPurge = await countExpiredEntries(scenario.harness.db, 90);
    assert.deepEqual(afterPurge, { expiredCount: 0 });
    assert.equal(
      scenario.harness.state.auditLogs.some((row) => row.id === "aud_retention_old"),
      false,
    );
  });
});

async function seedScenario(): Promise<SeededScenario> {
  const targetIdentity = createStoredIdentity({
    id: "agent_observed_target",
    name: "Observed Target",
    sponsorId: "agent_observed_parent",
    sponsorChain: ["user_observed_owner", "agent_observed_parent", "agent_observed_target"],
    budget: {
      maxActionsPerHour: 20,
      maxCostPerDay: 50,
      alertThreshold: 0.8,
    },
    budgetUsage: {
      actionsThisHour: 3,
      costToday: 4,
      lastResetAt: "2026-03-24T00:00:00.000Z",
    },
  });

  const childIdentity = createStoredIdentity({
    id: "agent_observed_child",
    name: "Observed Child",
    sponsorId: targetIdentity.id,
    sponsorChain: [...targetIdentity.sponsorChain, "agent_observed_child"],
  });

  const grandchildIdentity = createStoredIdentity({
    id: "agent_observed_grandchild",
    name: "Observed Grandchild",
    sponsorId: childIdentity.id,
    sponsorChain: [...childIdentity.sponsorChain, "agent_observed_grandchild"],
    status: "suspended",
  });

  const budgetExceededIdentity = createStoredIdentity({
    id: "agent_budget_exceeded",
    name: "Budget Exceeded Agent",
    sponsorId: "agent_observed_parent",
    sponsorChain: ["user_observed_owner", "agent_observed_parent", "agent_budget_exceeded"],
    scopes: ["relaycast:workspace:write:*"],
    budget: {
      maxActionsPerHour: 10,
      maxCostPerDay: 100,
      alertThreshold: 0.8,
    },
    budgetUsage: {
      actionsThisHour: 11,
      costToday: 20,
      lastResetAt: "2026-03-24T00:00:00.000Z",
    },
  });

  const budgetAlertIdentity = createStoredIdentity({
    id: "agent_budget_alert",
    name: "Budget Alert Agent",
    sponsorId: "agent_observed_parent",
    sponsorChain: ["user_observed_owner", "agent_observed_parent", "agent_budget_alert"],
    scopes: ["relaycast:workspace:write:*"],
    budget: {
      maxActionsPerHour: 10,
      maxCostPerDay: 100,
      alertThreshold: 0.8,
    },
    budgetUsage: {
      actionsThisHour: 8,
      costToday: 20,
      lastResetAt: "2026-03-24T00:00:00.000Z",
    },
  });

  const harness = createAuditHarness([
    targetIdentity,
    childIdentity,
    grandchildIdentity,
    budgetExceededIdentity,
    budgetAlertIdentity,
  ]);

  await writeAuditEntry(
    harness.db,
    createManualAuditWrite("token.issued", targetIdentity, {
      id: "aud_token_issued",
      plane: "relayauth",
      resource: "token:agent_observed_target",
      timestamp: TIMESTAMPS.tokenIssued,
    }),
  );

  await writeAuditEntry(
    harness.db,
    createManualAuditWrite("identity.created", targetIdentity, {
      id: "aud_identity_created",
      plane: "relayauth",
      resource: `identity:${targetIdentity.id}`,
      timestamp: TIMESTAMPS.identityCreated,
    }),
  );

  await writeAuditEntry(
    harness.db,
    createManualAuditWrite("scope.checked", targetIdentity, {
      id: "aud_scope_checked",
      plane: "relaycast",
      resource: "relaycast:workspace:write:billing",
      timestamp: TIMESTAMPS.scopeChecked,
    }),
  );

  await writeAuditEntry(
    harness.db,
    createManualAuditWrite("scope.denied", targetIdentity, {
      id: "aud_scope_denied",
      plane: "relaycast",
      resource: "relaycast:workspace:delete:billing",
      result: "denied",
      timestamp: TIMESTAMPS.scopeDenied,
    }),
  );

  await writeAuditEntry(
    harness.db,
    createManualAuditWrite("scope.escalation_denied", targetIdentity, {
      id: "aud_scope_escalation_denied",
      plane: "relaycast",
      resource: "relaycast:workspace:admin:billing",
      result: "denied",
      timestamp: TIMESTAMPS.scopeEscalationDenied,
      metadata: {
        sponsorId: targetIdentity.sponsorId,
        sponsorChain: JSON.stringify(targetIdentity.sponsorChain),
        actionAttempted: "relaycast:workspace:admin:billing",
      },
    }),
  );

  const exceededDecision = await checkAccess(
    harness.db,
    budgetExceededIdentity.id,
    ORG_ID,
    BUDGET_SCOPE,
  );
  assert.equal(exceededDecision.allowed, false);
  assert.equal(exceededDecision.reason, "budget_exceeded");

  const alertDecision = await checkAccess(
    harness.db,
    budgetAlertIdentity.id,
    ORG_ID,
    BUDGET_SCOPE,
  );
  assert.equal(alertDecision.allowed, true);
  assert.equal(alertDecision.reason, "scope_allowed");

  return {
    harness,
    targetIdentity,
    childIdentity,
    grandchildIdentity,
    budgetExceededIdentity,
    budgetAlertIdentity,
  };
}

function createAuditHarness(identities: StoredIdentity[]): AuditHarness {
  const state: HarnessState = {
    auditLogs: [],
    auditWebhooks: new Map<string, AuditWebhookRecord>(),
    identities: new Map(identities.map((identity) => [identity.id, clone(identity)])),
    executed: [],
  };

  const meta = {
    changed_db: false,
    changes: 0,
    duration: 0,
    rows_read: 0,
    rows_written: 0,
  };

  const db = {
    prepare(query: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async first<T>() {
              const rows = resolveAll(state, query, params);
              return (rows[0] as T | undefined) ?? null;
            },
            async run() {
              return executeRun(state, query, params, meta);
            },
            async raw<T>() {
              return resolveAll(state, query, params) as T[];
            },
            async all<T>() {
              return {
                results: resolveAll(state, query, params) as T[],
                success: true,
                meta,
              };
            },
          };
        },
        async first<T>() {
          const rows = resolveAll(state, query, []);
          return (rows[0] as T | undefined) ?? null;
        },
        async run() {
          return executeRun(state, query, [], meta);
        },
        async raw<T>() {
          return resolveAll(state, query, []) as T[];
        },
        async all<T>() {
          return {
            results: resolveAll(state, query, []) as T[],
            success: true,
            meta,
          };
        },
      };
    },
    async batch<T>(statements: D1PreparedStatement[]) {
      return Promise.all(statements.map((statement) => statement.run())) as Awaited<T>;
    },
    async exec() {
      return { count: 0, duration: 0 };
    },
    async dump() {
      return new ArrayBuffer(0);
    },
  } as D1Database;

  const identityDo = {
    idFromName(name: string) {
      return `${name}-id`;
    },
    get(id: string) {
      const identityId = id.replace(/-id$/, "");
      return {
        async fetch(request: Request) {
          if (new URL(request.url).pathname !== "/internal/get") {
            return new Response("unsupported", { status: 400 });
          }

          const identity = state.identities.get(identityId);
          if (!identity) {
            return new Response("identity_not_found", { status: 404 });
          }

          return new Response(JSON.stringify(identity), {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          });
        },
      };
    },
  } as unknown as DurableObjectNamespace;

  const app = createTestApp({
    DB: db,
    IDENTITY_DO: identityDo,
  });

  return {
    app,
    db,
    state,
    async request(method, path, options = {}) {
      const headers = new Headers(options.headers);
      if (!headers.has("Authorization")) {
        headers.set(
          "Authorization",
          `Bearer ${generateTestToken({
            sub: "agent_observability_admin",
            org: ORG_ID,
            wks: WORKSPACE_ID,
            scopes: [
              "relayauth:audit:read",
              "relayauth:audit:manage",
              "relayauth:stats:read",
            ],
            sponsorId: "user_observed_owner",
            sponsorChain: ["user_observed_owner", "agent_observability_admin"],
            ...options.claims,
          })}`,
        );
      }

      const request = createTestRequest(method, path, options.body, headers);
      return app.request(request, undefined, app.bindings);
    },
  };
}

function resolveAll(state: HarnessState, query: string, params: unknown[]): unknown[] {
  const normalized = normalizeSql(query);

  if (/\bfrom audit_logs\b/.test(normalized) && /\bgroup by action\b/.test(normalized)) {
    return summarizeAuditCounts(state.auditLogs, normalized, params);
  }

  if (/\bselect count\(\*\) as count\b/.test(normalized) && /\bfrom audit_logs\b/.test(normalized)) {
    return [{ count: countExpiredRows(state.auditLogs, params), expiredCount: countExpiredRows(state.auditLogs, params) }];
  }

  if (/\bfrom audit_logs\b/.test(normalized)) {
    return selectAuditLogs(state.auditLogs, normalized, params);
  }

  if (/\bfrom audit_webhooks\b/.test(normalized)) {
    const [orgId] = params;
    return Array.from(state.auditWebhooks.values())
      .filter((record) => typeof orgId !== "string" || record.orgId === orgId)
      .sort(
        (left, right) =>
          right.createdAt?.localeCompare(left.createdAt ?? "") ?? right.id.localeCompare(left.id),
      )
      .map((record) => ({
        id: record.id,
        orgId: record.orgId,
        org_id: record.orgId,
        url: record.url,
        webhook_url: record.url,
        secret: record.secret,
        webhook_secret: record.secret,
        events: record.events ?? null,
        events_json: record.events ? JSON.stringify(record.events) : null,
        createdAt: record.createdAt,
        created_at: record.createdAt,
        updatedAt: record.updatedAt,
        updated_at: record.updatedAt,
      }));
  }

  if (/\bfrom identities\b/.test(normalized) && /\bgroup by status\b/.test(normalized)) {
    const [orgId] = params;
    const counts = new Map<StoredIdentity["status"], number>();

    for (const identity of state.identities.values()) {
      if (typeof orgId === "string" && identity.orgId !== orgId) {
        continue;
      }

      if (identity.status === "active" || identity.status === "suspended") {
        counts.set(identity.status, (counts.get(identity.status) ?? 0) + 1);
      }
    }

    return Array.from(counts.entries()).map(([status, count]) => ({ status, count }));
  }

  if (
    /\bselect roles, roles_json\b/.test(normalized)
    && /\bfrom identities\b/.test(normalized)
    && /\bwhere id = \?/.test(normalized)
  ) {
    const [identityId] = params;
    const identity = typeof identityId === "string" ? state.identities.get(identityId) : undefined;
    if (!identity) {
      return [];
    }

    return [
      {
        roles: identity.roles,
        roles_json: JSON.stringify(identity.roles),
      },
    ];
  }

  if (/\bfrom identities\b/.test(normalized) && /\bsponsor_id = \?/.test(normalized)) {
    const [orgId, sponsorId] = params;
    return Array.from(state.identities.values())
      .filter(
        (identity) =>
          (typeof orgId !== "string" || identity.orgId === orgId)
          && (typeof sponsorId !== "string" || identity.sponsorId === sponsorId),
      )
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
      )
      .map((identity) => ({
        id: identity.id,
        name: identity.name,
        status: identity.status,
        sponsorId: identity.sponsorId,
        sponsor_id: identity.sponsorId,
        createdAt: identity.createdAt,
        created_at: identity.createdAt,
      }));
  }

  if (
    /\bfrom identities\b/.test(normalized)
    && /\bwhere org_id = \? and id = \?/.test(normalized)
  ) {
    const [orgId, identityId] = params;
    const identity =
      typeof identityId === "string" ? state.identities.get(identityId) : undefined;

    if (!identity || (typeof orgId === "string" && identity.orgId !== orgId)) {
      return [];
    }

    return [toIdentityRow(identity)];
  }

  if (/\bfrom policies\b/.test(normalized)) {
    return [];
  }

  return [];
}

async function executeRun(
  state: HarnessState,
  query: string,
  params: unknown[],
  meta: {
    changed_db: boolean;
    changes: number;
    duration: number;
    rows_read: number;
    rows_written: number;
  },
) {
  const normalized = normalizeSql(query);
  state.executed.push({ query: normalized, params: [...params] });

  if (/\binsert into audit_logs\b/.test(normalized)) {
    const row = toAuditLogRow(params);
    state.auditLogs.push(row);

    return {
      success: true,
      meta: {
        ...meta,
        changes: 1,
        rows_written: 1,
      },
    };
  }

  if (/\binsert into audit_webhooks\b/.test(normalized)) {
    const record = toWebhookRecord(params);
    state.auditWebhooks.set(record.id, record);

    return {
      success: true,
      meta: {
        ...meta,
        changes: 1,
        rows_written: 1,
      },
    };
  }

  if (/\bdelete from audit_webhooks\b/.test(normalized)) {
    const [orgId, id] = params;
    const existing = typeof id === "string" ? state.auditWebhooks.get(id) : undefined;
    const deleted =
      existing && typeof orgId === "string" && existing.orgId === orgId
        ? state.auditWebhooks.delete(id)
        : false;

    return {
      success: true,
      meta: {
        ...meta,
        changes: deleted ? 1 : 0,
        rows_written: deleted ? 1 : 0,
      },
    };
  }

  if (/\bdelete from audit_logs\b/.test(normalized) && /\bcreated_at < \?/.test(normalized)) {
    const before = state.auditLogs.length;
    const cutoff = typeof params[0] === "string" ? params[0] : "";
    state.auditLogs = state.auditLogs.filter((row) => row.created_at >= cutoff);
    const changes = before - state.auditLogs.length;

    return {
      success: true,
      meta: {
        ...meta,
        changes,
        rows_written: changes,
      },
    };
  }

  return {
    success: true,
    meta,
  };
}

function selectAuditLogs(
  rows: AuditLogRow[],
  normalized: string,
  params: unknown[],
): AuditLogRow[] {
  let filtered = [...rows];
  let boundParams = [...params];
  let limit: number | undefined;

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
        row.timestamp < cursorTimestamp
        || (row.timestamp === cursorTimestamp && row.id < cursorId),
    );
  }

  filtered.sort(compareAuditRowsDesc);

  if (typeof limit === "number") {
    filtered = filtered.slice(0, limit);
  }

  return filtered.map((row) => ({ ...row }));
}

function summarizeAuditCounts(
  rows: AuditLogRow[],
  normalized: string,
  params: unknown[],
): Array<{ action: string; count: number }> {
  const [orgId, ...rest] = params;
  let offset = 0;
  let from: string | undefined;
  let to: string | undefined;

  if (/\btimestamp >= \?\b/.test(normalized) && typeof rest[offset] === "string") {
    from = rest[offset] as string;
    offset += 1;
  }

  if (/\btimestamp < \?\b/.test(normalized) && typeof rest[offset] === "string") {
    to = rest[offset] as string;
  }

  const counts = new Map<string, number>();

  for (const row of rows) {
    if (typeof orgId === "string" && row.org_id !== orgId) {
      continue;
    }

    if (from && row.timestamp < from) {
      continue;
    }

    if (to && row.timestamp >= to) {
      continue;
    }

    const shouldInclude =
      row.action === "token.issued"
      || row.action === "token.revoked"
      || row.action === "token.refreshed"
      || row.action === "scope.denied"
      || (row.action === "scope.checked"
        && (row.result === "allowed" || row.result === "denied"));

    if (!shouldInclude) {
      continue;
    }

    counts.set(row.action, (counts.get(row.action) ?? 0) + 1);
  }

  return Array.from(counts.entries()).map(([action, count]) => ({ action, count }));
}

function countExpiredRows(rows: AuditLogRow[], params: unknown[]): number {
  const cutoff = typeof params[0] === "string" ? params[0] : "";
  return rows.filter((row) => row.created_at < cutoff).length;
}

function toAuditLogRow(params: unknown[]): AuditLogRow {
  const [
    id,
    action,
    identityId,
    orgId,
    workspaceId,
    plane,
    resource,
    result,
    metadataJson,
    ip,
    userAgent,
    timestamp,
  ] = params;

  const ts = typeof timestamp === "string" ? timestamp : new Date().toISOString();

  return {
    id: String(id),
    action: action as ExtendedAuditAction,
    identity_id: String(identityId),
    org_id: String(orgId),
    workspace_id: typeof workspaceId === "string" ? workspaceId : null,
    plane: typeof plane === "string" ? plane : null,
    resource: typeof resource === "string" ? resource : null,
    result: result as AuditEntry["result"],
    metadata_json: typeof metadataJson === "string" ? metadataJson : null,
    ip: typeof ip === "string" ? ip : null,
    user_agent: typeof userAgent === "string" ? userAgent : null,
    timestamp: ts,
    created_at: ts,
  };
}

function toObservedAuditEntry(row: AuditLogRow): ObservedAuditEntry {
  return {
    id: row.id,
    action: row.action,
    identityId: row.identity_id,
    orgId: row.org_id,
    ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}),
    ...(row.plane ? { plane: row.plane } : {}),
    ...(row.resource ? { resource: row.resource } : {}),
    result: row.result,
    ...(row.metadata_json ? { metadata: JSON.parse(row.metadata_json) as Record<string, string> } : {}),
    ...(row.ip ? { ip: row.ip } : {}),
    ...(row.user_agent ? { userAgent: row.user_agent } : {}),
    timestamp: row.timestamp,
    createdAt: row.created_at,
  };
}

function toWebhookRecord(params: unknown[]): AuditWebhookRecord {
  const [id, orgId, url, secret, eventsJson, createdAt, updatedAt] = params;

  return {
    id: String(id),
    orgId: String(orgId),
    url: String(url),
    secret: String(secret),
    ...(typeof eventsJson === "string" && eventsJson.trim().length > 0
      ? { events: JSON.parse(eventsJson) as string[] }
      : {}),
    ...(typeof createdAt === "string" ? { createdAt } : {}),
    ...(typeof updatedAt === "string" ? { updatedAt } : {}),
  };
}

function toIdentityRow(identity: StoredIdentity) {
  return {
    id: identity.id,
    name: identity.name,
    type: identity.type,
    orgId: identity.orgId,
    org_id: identity.orgId,
    status: identity.status,
    scopes: identity.scopes,
    scopes_json: JSON.stringify(identity.scopes),
    roles: identity.roles,
    roles_json: JSON.stringify(identity.roles),
    metadata: identity.metadata,
    metadata_json: JSON.stringify(identity.metadata),
    createdAt: identity.createdAt,
    created_at: identity.createdAt,
    updatedAt: identity.updatedAt,
    updated_at: identity.updatedAt,
    sponsorId: identity.sponsorId,
    sponsor_id: identity.sponsorId,
    sponsorChain: JSON.stringify(identity.sponsorChain),
    sponsor_chain: JSON.stringify(identity.sponsorChain),
    sponsor_chain_json: JSON.stringify(identity.sponsorChain),
    workspaceId: identity.workspaceId,
    workspace_id: identity.workspaceId,
    ...(identity.budget ? { budget: identity.budget, budget_json: JSON.stringify(identity.budget) } : {}),
    ...(identity.budgetUsage
      ? {
          budgetUsage: identity.budgetUsage,
          budget_usage: identity.budgetUsage,
          budget_usage_json: JSON.stringify(identity.budgetUsage),
        }
      : {}),
  };
}

function createStoredIdentity(overrides: Partial<StoredIdentity> = {}): StoredIdentity {
  const base = generateTestIdentity({
    id: overrides.id ?? `agent_${Math.random().toString(16).slice(2)}`,
    name: overrides.name ?? "Audit Identity",
    orgId: overrides.orgId ?? ORG_ID,
    status: overrides.status ?? "active",
    scopes: overrides.scopes ?? [],
    roles: overrides.roles ?? [],
    metadata: overrides.metadata ?? {},
    createdAt: overrides.createdAt ?? "2026-03-24T08:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-03-24T08:00:00.000Z",
  });

  const sponsorId = overrides.sponsorId ?? "user_observed_owner";

  return {
    ...base,
    sponsorId,
    sponsorChain: overrides.sponsorChain ?? [sponsorId, base.id],
    workspaceId: overrides.workspaceId ?? WORKSPACE_ID,
    ...(overrides.budget !== undefined ? { budget: overrides.budget } : {}),
    ...(overrides.budgetUsage !== undefined ? { budgetUsage: overrides.budgetUsage } : {}),
  };
}

function createManualAuditWrite(
  action: ExtendedAuditAction,
  identity: StoredIdentity,
  overrides: Partial<AuditWriteInput> = {},
): AuditWriteInput {
  const defaultResult: AuditEntry["result"] =
    action === "scope.denied" || action === "scope.escalation_denied" ? "denied" : "allowed";

  return {
    id: overrides.id,
    action,
    identityId: overrides.identityId ?? identity.id,
    orgId: overrides.orgId ?? identity.orgId,
    workspaceId: overrides.workspaceId ?? identity.workspaceId,
    plane: overrides.plane ?? "relayauth",
    resource: overrides.resource ?? `resource:${action}`,
    result: overrides.result ?? defaultResult,
    metadata: {
      sponsorId: identity.sponsorId,
      sponsorChain: JSON.stringify(identity.sponsorChain),
      ...(action === "scope.escalation_denied"
        ? { actionAttempted: "relaycast:workspace:admin:billing" }
        : { requestId: `${action}:${identity.id}` }),
      ...(overrides.metadata ?? {}),
    },
    ip: overrides.ip ?? "203.0.113.10",
    userAgent: overrides.userAgent ?? "audit-observability-e2e/1.0",
    timestamp: overrides.timestamp,
  };
}

function compareAuditRowsDesc(left: AuditLogRow, right: AuditLogRow): number {
  return right.timestamp.localeCompare(left.timestamp) || right.id.localeCompare(left.id);
}

function normalizeSql(query: string): string {
  return query.replace(/\s+/g, " ").trim().toLowerCase();
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

    if (character === "\"") {
      inQuotes = true;
      continue;
    }

    if (character === ",") {
      values.push(current);
      current = "";
      continue;
    }

    current += character;
  }

  values.push(current);
  return values;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}
