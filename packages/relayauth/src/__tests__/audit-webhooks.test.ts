import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import type { AuditAction, AuditEntry, RelayAuthTokenClaims } from "@relayauth/types";

import {
  assertJsonResponse,
  createTestApp,
  createTestRequest,
  generateTestToken,
} from "./test-helpers.js";

type ExtendedAuditAction = AuditAction | "budget.alert";

type DispatchAuditEntry = Omit<AuditEntry, "action"> & {
  action: ExtendedAuditAction;
};

type AuditWebhookSubscription = {
  id: string;
  orgId: string;
  url: string;
  events?: string[];
  secret: string;
  createdAt?: string;
};

type AuditWebhookPayload = {
  type: "audit.event";
  deliveryId: string;
  timestamp: string;
  entry: DispatchAuditEntry;
};

type AuditWebhookDispatcherModule = {
  dispatchWebhook: (
    webhook: AuditWebhookSubscription,
    entry: DispatchAuditEntry,
  ) => Promise<void> | void;
};

type StoredWebhook = AuditWebhookSubscription & {
  createdAt: string;
  updatedAt: string;
};

function normalizeSql(query: string): string {
  return query.replace(/\s+/g, " ").trim().toLowerCase();
}

function createWebhookRecord(
  overrides: Partial<StoredWebhook> = {},
): StoredWebhook {
  const timestamp = overrides.createdAt ?? new Date(Date.UTC(2026, 2, 24, 17, 0, 0)).toISOString();

  return {
    id: overrides.id ?? "awh_01JQTEST000000000000000001",
    orgId: overrides.orgId ?? "org_audit_webhooks",
    url: overrides.url ?? "https://audit.example.com/hooks/primary",
    events: overrides.events ?? ["identity.suspended", "scope.denied"],
    secret: overrides.secret ?? "whsec_test_123",
    createdAt: timestamp,
    updatedAt: overrides.updatedAt ?? timestamp,
  };
}

function createBudgetAlertEntry(
  overrides: Partial<DispatchAuditEntry> = {},
): DispatchAuditEntry {
  return {
    id: overrides.id ?? "aud_budget_alert_01",
    action: overrides.action ?? "budget.alert",
    identityId: overrides.identityId ?? "agent_budget_01",
    orgId: overrides.orgId ?? "org_audit_webhooks",
    workspaceId: overrides.workspaceId ?? "ws_budget_01",
    plane: overrides.plane ?? "relaycast",
    resource: overrides.resource ?? "channel:#billing",
    result: overrides.result ?? "allowed",
    metadata: {
      sponsorId: "user_sponsor_01",
      sponsorChain: JSON.stringify(["user_sponsor_01", "agent_root_01", "agent_budget_01"]),
      budgetRemaining: "20",
      budgetConfig: JSON.stringify({
        maxActionsPerHour: 100,
        maxCostPerDay: 50,
        alertThreshold: 0.8,
      }),
      actualUsage: JSON.stringify({
        actionsThisHour: 80,
        costToday: 40,
      }),
      actionAttempted: "relaycast:channel:write:#billing",
      reason: "budget threshold reached",
      ...overrides.metadata,
    },
    timestamp: overrides.timestamp ?? "2026-03-24T17:00:00.000Z",
  };
}

function createAutoSuspendEntry(
  overrides: Partial<DispatchAuditEntry> = {},
): DispatchAuditEntry {
  return {
    id: overrides.id ?? "aud_identity_suspended_01",
    action: overrides.action ?? "identity.suspended",
    identityId: overrides.identityId ?? "agent_budget_02",
    orgId: overrides.orgId ?? "org_audit_webhooks",
    workspaceId: overrides.workspaceId ?? "ws_budget_02",
    plane: overrides.plane ?? "relayauth",
    resource: overrides.resource ?? "identity:agent_budget_02",
    result: overrides.result ?? "allowed",
    metadata: {
      sponsorId: "user_sponsor_02",
      sponsorChain: JSON.stringify(["user_sponsor_02", "agent_root_02", "agent_budget_02"]),
      budgetRemaining: "0",
      reason: "budget_exceeded",
      ...overrides.metadata,
    },
    timestamp: overrides.timestamp ?? "2026-03-24T17:05:00.000Z",
  };
}

function createAuthorizationHeader(
  claims: Partial<RelayAuthTokenClaims> = {},
): HeadersInit {
  return {
    Authorization: `Bearer ${generateTestToken(claims)}`,
  };
}

function parseWebhook(body: unknown): AuditWebhookSubscription {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const candidate = body as Record<string, unknown>;

    if (candidate.webhook && typeof candidate.webhook === "object") {
      return parseWebhook(candidate.webhook);
    }

    if (candidate.data && typeof candidate.data === "object" && !Array.isArray(candidate.data)) {
      return parseWebhook(candidate.data);
    }

    if (
      typeof candidate.id === "string" &&
      typeof candidate.orgId === "string" &&
      typeof candidate.url === "string" &&
      typeof candidate.secret === "string"
    ) {
      return {
        id: candidate.id,
        orgId: candidate.orgId,
        url: candidate.url,
        secret: candidate.secret,
        ...(Array.isArray(candidate.events) ? { events: candidate.events.filter((value): value is string => typeof value === "string") } : {}),
        ...(typeof candidate.createdAt === "string" ? { createdAt: candidate.createdAt } : {}),
      };
    }
  }

  assert.fail(`Expected webhook subscription payload, received: ${JSON.stringify(body)}`);
}

function parseWebhookList(body: unknown): AuditWebhookSubscription[] {
  if (Array.isArray(body)) {
    return body.map(parseWebhook);
  }

  if (body && typeof body === "object" && !Array.isArray(body)) {
    const candidate = body as Record<string, unknown>;

    if (Array.isArray(candidate.data)) {
      return candidate.data.map(parseWebhook);
    }

    if (Array.isArray(candidate.webhooks)) {
      return candidate.webhooks.map(parseWebhook);
    }
  }

  assert.fail(`Expected webhook list payload, received: ${JSON.stringify(body)}`);
}

function createAuditWebhookD1(seed: StoredWebhook[] = []): {
  db: D1Database;
  records: Map<string, StoredWebhook>;
} {
  const records = new Map(seed.map((record) => [record.id, { ...record }]));

  const meta = {
    changed_db: false,
    changes: 0,
    duration: 0,
    rows_read: 0,
    rows_written: 0,
  };

  function toRow(record: StoredWebhook) {
    return {
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
    };
  }

  function parseEvents(value: unknown): string[] | undefined {
    if (Array.isArray(value)) {
      return value.filter((entry): entry is string => typeof entry === "string");
    }

    if (typeof value !== "string" || value.trim().length === 0) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(value) as unknown;
      return parseEvents(parsed);
    } catch {
      return value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
    }
  }

  function parseInsertRecord(query: string, params: unknown[]): StoredWebhook {
    const columnsMatch = query.match(/insert\s+into\s+audit_webhooks\s*\(([^)]+)\)/i);
    const columns = columnsMatch?.[1]
      ?.split(",")
      .map((column) => column.trim().replace(/["'`]/g, "")) ?? [];

    const values = new Map<string, unknown>();
    for (let index = 0; index < columns.length; index += 1) {
      values.set(columns[index] ?? "", params[index]);
    }

    const timestamp = new Date().toISOString();

    return {
      id: String(values.get("id") ?? `awh_${crypto.randomUUID()}`),
      orgId: String(values.get("org_id") ?? values.get("orgId") ?? ""),
      url: String(values.get("url") ?? values.get("webhook_url") ?? ""),
      secret: String(values.get("secret") ?? values.get("webhook_secret") ?? ""),
      ...(parseEvents(values.get("events") ?? values.get("events_json"))
        ? { events: parseEvents(values.get("events") ?? values.get("events_json")) }
        : {}),
      createdAt: String(values.get("created_at") ?? values.get("createdAt") ?? timestamp),
      updatedAt: String(values.get("updated_at") ?? values.get("updatedAt") ?? values.get("created_at") ?? values.get("createdAt") ?? timestamp),
    };
  }

  function extractFilters(query: string, params: unknown[]): Map<string, unknown> {
    const normalized = normalizeSql(query);
    const filters = [
      { key: "orgId", index: normalized.search(/\borg_id\s*=\s*\?|\borgid\s*=\s*\?/i) },
      { key: "id", index: normalized.search(/\bid\s*=\s*\?/i) },
      { key: "url", index: normalized.search(/\bwebhook_url\s*=\s*\?|\burl\s*=\s*\?/i) },
    ]
      .filter((filter) => filter.index >= 0)
      .sort((left, right) => left.index - right.index);

    const values = new Map<string, unknown>();
    for (let index = 0; index < filters.length; index += 1) {
      values.set(filters[index]?.key ?? "", params[index]);
    }

    return values;
  }

  function selectRows(query: string, params: unknown[]) {
    const normalized = normalizeSql(query);
    if (!/\bfrom audit_webhooks\b/.test(normalized)) {
      return [];
    }

    const filters = extractFilters(query, params);
    let results = [...records.values()];

    const orgId = filters.get("orgId");
    if (typeof orgId === "string") {
      results = results.filter((record) => record.orgId === orgId);
    }

    const id = filters.get("id");
    if (typeof id === "string") {
      results = results.filter((record) => record.id === id);
    }

    const url = filters.get("url");
    if (typeof url === "string") {
      results = results.filter((record) => record.url === url);
    }

    results.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));

    return results.map(toRow);
  }

  function deleteRows(query: string, params: unknown[]) {
    const filters = extractFilters(query, params);
    const deleted: StoredWebhook[] = [];

    for (const [id, record] of records.entries()) {
      if (typeof filters.get("orgId") === "string" && record.orgId !== filters.get("orgId")) {
        continue;
      }

      if (typeof filters.get("id") === "string" && record.id !== filters.get("id")) {
        continue;
      }

      deleted.push(record);
      records.delete(id);
    }

    return deleted.map(toRow);
  }

  function createPreparedStatement(query: string) {
    return {
      bind: (...params: unknown[]) => {
        const execute = () => {
          const normalized = normalizeSql(query);

          if (/\binsert\s+into\s+audit_webhooks\b/.test(normalized)) {
            const record = parseInsertRecord(query, params);
            records.set(record.id, record);
            return [toRow(record)];
          }

          if (/\bdelete\s+from\s+audit_webhooks\b/.test(normalized)) {
            return deleteRows(query, params);
          }

          return selectRows(query, params);
        };

        return {
          first: async <T>() => (execute()[0] as T | null) ?? null,
          raw: async <T>() => execute() as T[],
          all: async <T>() => ({
            results: execute() as T[],
            success: true,
            meta,
          }),
          run: async () => {
            const results = execute();
            return {
              success: true,
              meta: {
                ...meta,
                changes: results.length,
                rows_written: results.length,
              },
            };
          },
        };
      },
      first: async <T>() => (selectRows(query, [])[0] as T | null) ?? null,
      raw: async <T>() => selectRows(query, []) as T[],
      all: async <T>() => ({
        results: selectRows(query, []) as T[],
        success: true,
        meta,
      }),
      run: async () => ({
        success: true,
        meta,
      }),
    };
  }

  return {
    records,
    db: {
      prepare: (query: string) => createPreparedStatement(query),
      batch: async <T>(statements: D1PreparedStatement[]) =>
        Promise.all(statements.map((statement) => statement.run())) as Awaited<T>,
      exec: async () => ({ count: 0, duration: 0 }),
      dump: async () => new ArrayBuffer(0),
    } as D1Database,
  };
}

async function requestAuditWebhooks(
  method: string,
  path: string,
  {
    body,
    claims,
    authorization,
    db,
  }: {
    body?: unknown;
    claims?: Partial<RelayAuthTokenClaims>;
    authorization?: string;
    db?: D1Database;
  } = {},
): Promise<Response> {
  const app = createTestApp({
    ...(db ? { DB: db } : {}),
  });
  const request = createTestRequest(
    method,
    path,
    body,
    authorization
      ? { Authorization: authorization }
      : createAuthorizationHeader({
          org: "org_audit_webhooks",
          scopes: ["relayauth:audit:manage"],
          ...claims,
        }),
  );

  return app.request(request, undefined, app.bindings);
}

async function loadDispatcher(): Promise<AuditWebhookDispatcherModule> {
  let moduleRecord: Record<string, unknown>;

  try {
    moduleRecord = (await import("../engine/audit-webhook-dispatcher.js")) as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    assert.fail(
      `Expected audit webhook dispatcher module at ../engine/audit-webhook-dispatcher.js: ${message}`,
    );
  }

  assert.equal(
    typeof moduleRecord.dispatchWebhook,
    "function",
    "audit webhook dispatcher should export dispatchWebhook()",
  );

  return moduleRecord as unknown as AuditWebhookDispatcherModule;
}

test("POST /v1/audit/webhooks creates a webhook subscription with url, events, and secret", async () => {
  const { db, records } = createAuditWebhookD1();
  const response = await requestAuditWebhooks(
    "POST",
    "/v1/audit/webhooks",
    {
      db,
      body: {
        orgId: "org_audit_webhooks",
        url: "https://audit.example.com/hooks/budget",
        events: ["identity.suspended", "scope.denied"],
        secret: "whsec_budget_alert_123",
      },
    },
  );

  const body = await assertJsonResponse<unknown>(response, 201);
  const webhook = parseWebhook(body);

  assert.match(webhook.id, /^awh_|^[A-Za-z0-9_-]+$/);
  assert.equal(webhook.orgId, "org_audit_webhooks");
  assert.equal(webhook.url, "https://audit.example.com/hooks/budget");
  assert.deepEqual(webhook.events, ["identity.suspended", "scope.denied"]);
  assert.equal(webhook.secret, "****_123");
  assert.equal(records.size, 1, "expected webhook subscription to persist in D1");
});

test("GET /v1/audit/webhooks lists webhook subscriptions for an org", async () => {
  const { db } = createAuditWebhookD1([
    createWebhookRecord({
      id: "awh_org_match_1",
      orgId: "org_audit_webhooks",
      url: "https://audit.example.com/hooks/budget-alerts",
      events: ["identity.suspended"],
      secret: "whsec_budget_alert",
      createdAt: "2026-03-24T17:00:00.000Z",
    }),
    createWebhookRecord({
      id: "awh_org_match_2",
      orgId: "org_audit_webhooks",
      url: "https://audit.example.com/hooks/sponsor-notify",
      events: ["scope.denied"],
      secret: "whsec_sponsor",
      createdAt: "2026-03-24T17:01:00.000Z",
    }),
    createWebhookRecord({
      id: "awh_other_org_1",
      orgId: "org_other",
      url: "https://audit.example.com/hooks/other-org",
      events: ["token.validated"],
      secret: "whsec_other",
      createdAt: "2026-03-24T17:02:00.000Z",
    }),
  ]);

  const response = await requestAuditWebhooks(
    "GET",
    "/v1/audit/webhooks?orgId=org_audit_webhooks",
    { db },
  );

  const body = await assertJsonResponse<unknown>(response, 200);
  const webhooks = parseWebhookList(body);

  assert.deepEqual(
    webhooks.map((webhook) => webhook.id),
    ["awh_org_match_2", "awh_org_match_1"],
  );
  assert.equal(
    webhooks.every((webhook) => webhook.orgId === "org_audit_webhooks"),
    true,
    "expected GET to be org-scoped",
  );
  assert.match(webhooks[0]?.secret ?? "", /^\*{4}/, "expected secret to be masked on list");
});

test("DELETE /v1/audit/webhooks/:id removes a webhook subscription", async () => {
  const target = createWebhookRecord({
    id: "awh_delete_me",
    orgId: "org_audit_webhooks",
  });
  const { db, records } = createAuditWebhookD1([target]);

  const deleteResponse = await requestAuditWebhooks(
    "DELETE",
    "/v1/audit/webhooks/awh_delete_me?orgId=org_audit_webhooks",
    { db },
  );

  assert.equal(
    deleteResponse.status === 200 || deleteResponse.status === 204,
    true,
    `expected DELETE to return 200 or 204, received ${deleteResponse.status}`,
  );
  assert.equal(records.has(target.id), false, "expected subscription to be removed from D1");

  const listResponse = await requestAuditWebhooks(
    "GET",
    "/v1/audit/webhooks?orgId=org_audit_webhooks",
    { db },
  );
  const listBody = await assertJsonResponse<unknown>(listResponse, 200);
  const webhooks = parseWebhookList(listBody);

  assert.deepEqual(webhooks, []);
});

test("POST /v1/audit/webhooks returns 401 without valid auth token", async () => {
  const response = await requestAuditWebhooks(
    "POST",
    "/v1/audit/webhooks",
    {
      authorization: "Bearer definitely-not-a-valid-token",
      body: {
        orgId: "org_audit_webhooks",
        url: "https://audit.example.com/hooks/secure",
        events: ["identity.suspended"],
        secret: "whsec_invalid_auth",
      },
    },
  );

  assert.equal(response.status, 401);
});

test("POST /v1/audit/webhooks returns 403 without relayauth:audit:manage scope", async () => {
  const response = await requestAuditWebhooks(
    "POST",
    "/v1/audit/webhooks",
    {
      claims: {
        org: "org_audit_webhooks",
        scopes: ["relayauth:audit:read"],
      },
      body: {
        orgId: "org_audit_webhooks",
        url: "https://audit.example.com/hooks/forbidden",
        events: ["identity.suspended"],
        secret: "whsec_forbidden_scope",
      },
    },
  );

  assert.equal(response.status, 403);
});

test("POST /v1/audit/webhooks returns 400 for invalid webhook URL", async () => {
  const response = await requestAuditWebhooks(
    "POST",
    "/v1/audit/webhooks",
    {
      body: {
        orgId: "org_audit_webhooks",
        url: "not-a-valid-url",
        events: ["identity.suspended"],
        secret: "whsec_invalid_url",
      },
    },
  );

  const body = await assertJsonResponse<{ error: string }>(response, 400);
  assert.match(body.error, /url/i);
});

test("POST /v1/audit/webhooks returns 400 for SSRF-prone URLs (private IPs, localhost, metadata)", async (t) => {
  const ssrfUrls = [
    "http://127.0.0.1/admin",
    "http://localhost:8080/internal",
    "http://10.0.0.1/secret",
    "http://172.16.0.1/internal",
    "http://192.168.1.1/admin",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/admin",
    "http://0.0.0.0/",
  ];

  for (const url of ssrfUrls) {
    await t.test(`rejects ${url}`, async () => {
      const response = await requestAuditWebhooks(
        "POST",
        "/v1/audit/webhooks",
        {
          body: {
            orgId: "org_audit_webhooks",
            url,
            events: ["identity.suspended"],
            secret: "whsec_ssrf_test",
          },
        },
      );

      assert.equal(response.status, 400, `expected 400 for SSRF URL: ${url}`);
    });
  }
});

test("dispatchWebhook() sends budget alert and auto-suspend audit payloads with sponsorId", async (t) => {
  const { dispatchWebhook } = await loadDispatcher();

  await t.test("budget alert webhook fires when the agent hits alertThreshold percent of budget", async () => {
    const webhook = createWebhookRecord({
      id: "awh_budget_alert",
      events: undefined,
      secret: "whsec_budget_alert_dispatch",
      url: "https://audit.example.com/hooks/budget-alert",
    });
    const entry = createBudgetAlertEntry();
    const requests: Array<{ request: Request; body: string }> = [];
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const body = await request.text();
      requests.push({ request, body });
      return new Response(null, { status: 202 });
    }) as typeof globalThis.fetch;

    t.after(() => {
      globalThis.fetch = originalFetch;
    });

    await dispatchWebhook(webhook, entry);

    assert.equal(requests.length, 1, "expected a webhook POST request");
    assert.equal(requests[0]?.request.method, "POST");
    assert.equal(requests[0]?.request.url, webhook.url);

    const payload = JSON.parse(requests[0]?.body ?? "{}") as AuditWebhookPayload;
    assert.equal(payload.type, "audit.event");
    assert.equal(payload.entry.action, "budget.alert");
    assert.equal(payload.entry.metadata?.sponsorId, "user_sponsor_01");
    assert.equal(
      payload.entry.metadata?.reason,
      "budget threshold reached",
      "expected budget alert reason to be preserved in the payload",
    );
  });

  await t.test("auto-suspend webhook fires when an identity is suspended by a budget breach", async () => {
    const webhook = createWebhookRecord({
      id: "awh_auto_suspend",
      events: ["identity.suspended"],
      secret: "whsec_auto_suspend_dispatch",
      url: "https://audit.example.com/hooks/auto-suspend",
    });
    const entry = createAutoSuspendEntry();
    const requests: Array<{ request: Request; body: string }> = [];
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const body = await request.text();
      requests.push({ request, body });
      return new Response(null, { status: 200 });
    }) as typeof globalThis.fetch;

    t.after(() => {
      globalThis.fetch = originalFetch;
    });

    await dispatchWebhook(webhook, entry);

    assert.equal(requests.length, 1, "expected auto-suspend to emit one webhook");

    const payload = JSON.parse(requests[0]?.body ?? "{}") as AuditWebhookPayload;
    assert.equal(payload.entry.action, "identity.suspended");
    assert.equal(payload.entry.metadata?.reason, "budget_exceeded");
    assert.equal(payload.entry.metadata?.sponsorId, "user_sponsor_02");
  });
});

test("dispatchWebhook() includes an HMAC signature header using the webhook secret", async (t) => {
  const { dispatchWebhook } = await loadDispatcher();
  const webhook = createWebhookRecord({
    id: "awh_signature",
    secret: "whsec_signature_123",
    url: "https://audit.example.com/hooks/signature",
    events: ["identity.suspended"],
  });
  const entry = createAutoSuspendEntry();
  const requests: Array<{ request: Request; body: string }> = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const body = await request.text();
    requests.push({ request, body });
    return new Response(null, { status: 200 });
  }) as typeof globalThis.fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await dispatchWebhook(webhook, entry);

  assert.equal(requests.length, 1, "expected one signed webhook request");

  const request = requests[0]?.request;
  const body = requests[0]?.body ?? "";
  const expectedSignature = `sha256=${crypto
    .createHmac("sha256", webhook.secret)
    .update(body)
    .digest("hex")}`;

  assert.equal(request?.headers.get("x-relayauth-signature"), expectedSignature);
  assert.match(request?.headers.get("x-relayauth-delivery-id") ?? "", /\S+/);

  const payload = JSON.parse(body) as AuditWebhookPayload;
  assert.equal(payload.deliveryId, request?.headers.get("x-relayauth-delivery-id"));
});

test("dispatchWebhook() retries on 5xx up to 3 times", async (t) => {
  const { dispatchWebhook } = await loadDispatcher();
  const webhook = createWebhookRecord({
    id: "awh_retry",
    secret: "whsec_retry_123",
    url: "https://audit.example.com/hooks/retry",
    events: ["identity.suspended"],
  });
  const entry = createAutoSuspendEntry();
  let attempts = 0;
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;

  globalThis.fetch = (async () => {
    attempts += 1;
    return new Response("temporary upstream failure", { status: 503 });
  }) as typeof globalThis.fetch;

  globalThis.setTimeout = (((callback: (...args: never[]) => void, _delay?: number, ...args: never[]) => {
    callback(...args);
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof globalThis.setTimeout);

  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  });

  try {
    await dispatchWebhook(webhook, entry);
  } catch {
    // Final failure behavior is implementation-defined; the retry count is the contract under test.
  }

  assert.equal(attempts, 4, "expected 1 initial attempt plus 3 retries on 5xx responses");
});
