import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import type { AgentIdentity, CreateIdentityInput, RelayAuthTokenClaims } from "@relayauth/types";
import type { IdentityBudget } from "../durable-objects/identity-do.js";
import { assertJsonResponse, createTestApp, createTestRequest, mockDO } from "./test-helpers.js";

type CreateIdentityRequest = CreateIdentityInput & {
  sponsorId?: string;
  budget?: IdentityBudget;
  orgId?: string;
};

type CreatedIdentity = AgentIdentity & {
  sponsorId?: string;
  sponsorChain?: string[];
  workspaceId?: string;
  budget?: IdentityBudget;
};

type D1Scenario = {
  duplicateIdentity?: {
    id: string;
    name: string;
    orgId: string;
  };
  orgBudget?: IdentityBudget;
};

function base64UrlEncode(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function signHs256(payload: Record<string, unknown>, secret: string): string {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const unsigned = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto
    .createHmac("sha256", secret)
    .update(unsigned)
    .digest("base64url");
  return `${unsigned}.${signature}`;
}

function createAuthToken(overrides: Partial<RelayAuthTokenClaims> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const sponsorId = overrides.sponsorId ?? "user_sponsor_1";
  const sub = overrides.sub ?? "agent_parent_1";

  const payload: RelayAuthTokenClaims = {
    sub,
    org: overrides.org ?? "org_auth_ctx",
    wks: overrides.wks ?? "ws_auth_ctx",
    scopes: overrides.scopes ?? ["relayauth:identity:create", "relayauth:identity:manage"],
    sponsorId,
    sponsorChain: overrides.sponsorChain ?? [sponsorId, sub],
    token_type: overrides.token_type ?? "access",
    iss: overrides.iss ?? "relayauth:test",
    aud: overrides.aud ?? ["relayauth"],
    exp: overrides.exp ?? now + 3600,
    iat: overrides.iat ?? now,
    jti: overrides.jti ?? crypto.randomUUID(),
    nbf: overrides.nbf,
    sid: overrides.sid,
    meta: overrides.meta,
    parentTokenId: overrides.parentTokenId,
    budget: overrides.budget,
  };

  return signHs256(payload as Record<string, unknown>, "dev-secret");
}

function normalizeSql(query: string): string {
  return query.replace(/\s+/g, " ").trim().toLowerCase();
}

function createScenarioD1({ duplicateIdentity, orgBudget }: D1Scenario = {}): D1Database {
  const meta = {
    changed_db: false,
    changes: 0,
    duration: 0,
    rows_read: 0,
    rows_written: 0,
  };

  const resolveRows = (query: string, params: unknown[]): unknown[] => {
    const normalized = normalizeSql(query);

    if (
      duplicateIdentity &&
      /(identity|identities)/.test(normalized) &&
      /name/.test(normalized) &&
      params.some((param) => String(param ?? "") === duplicateIdentity.name)
    ) {
      return [
        {
          id: duplicateIdentity.id,
          name: duplicateIdentity.name,
          orgId: duplicateIdentity.orgId,
          org_id: duplicateIdentity.orgId,
          count: 1,
          exists: 1,
        },
      ];
    }

    if (orgBudget && /budget/.test(normalized) && /(org|organization)/.test(normalized)) {
      const budgetJson = JSON.stringify(orgBudget);
      return [
        {
          budget: orgBudget,
          budget_json: budgetJson,
          defaultBudget: orgBudget,
          default_budget: budgetJson,
          data: budgetJson,
          settings_json: JSON.stringify({ budget: orgBudget }),
        },
      ];
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

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function extractIdentityPayload(body: unknown): Partial<CreatedIdentity> {
  if (!body || typeof body !== "object") {
    return {};
  }

  if ("identity" in body && body.identity && typeof body.identity === "object") {
    return body.identity as Partial<CreatedIdentity>;
  }

  return body as Partial<CreatedIdentity>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

function createIdentityDoStub() {
  return mockDO(async (request) => {
    const rawBody = await request.json().catch(() => undefined);
    const candidate = extractIdentityPayload(rawBody);
    const timestamp = new Date().toISOString();

    return jsonResponse(
      {
        id:
          typeof candidate.id === "string" && candidate.id.length > 0
            ? candidate.id
            : `agent_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
        name: candidate.name ?? "Generated Identity",
        type: candidate.type ?? "agent",
        orgId: candidate.orgId ?? "org_test",
        status: candidate.status ?? "active",
        scopes: Array.isArray(candidate.scopes) ? candidate.scopes : [],
        roles: Array.isArray(candidate.roles) ? candidate.roles : [],
        metadata: isStringRecord(candidate.metadata) ? candidate.metadata : {},
        createdAt: candidate.createdAt ?? timestamp,
        updatedAt: candidate.updatedAt ?? timestamp,
        ...(typeof candidate.workspaceId === "string" ? { workspaceId: candidate.workspaceId } : {}),
        ...(typeof candidate.sponsorId === "string" ? { sponsorId: candidate.sponsorId } : {}),
        ...(Array.isArray(candidate.sponsorChain) ? { sponsorChain: candidate.sponsorChain } : {}),
        ...(candidate.budget ? { budget: candidate.budget } : {}),
      } satisfies CreatedIdentity,
      201,
    );
  });
}

function assertIsoTimestamp(value: string, fieldName: string): void {
  assert.equal(typeof value, "string", `${fieldName} should be a string`);
  assert.equal(Number.isNaN(Date.parse(value)), false, `${fieldName} should be an ISO timestamp`);
}

async function postCreateIdentity(
  body: CreateIdentityRequest,
  {
    claims,
    db,
  }: {
    claims?: Partial<RelayAuthTokenClaims>;
    db?: D1Database;
  } = {},
): Promise<Response> {
  const app = createTestApp({
    DB: db ?? createScenarioD1(),
    IDENTITY_DO: createIdentityDoStub(),
  });
  const request = createTestRequest(
    "POST",
    "/v1/identities",
    body,
    {
      Authorization: `Bearer ${createAuthToken(claims)}`,
    },
  );

  return app.request(request, undefined, app.bindings);
}

test("POST /v1/identities returns 201 with a created identity and preserves optional fields", async () => {
  const response = await postCreateIdentity({
    name: "builder-bot",
    sponsorId: "user_sponsor_1",
    scopes: ["relayauth:identity:read", "relayauth:identity:update"],
    roles: ["builder", "deployer"],
    metadata: {
      environment: "test",
      owner: "qa",
    },
    workspaceId: "ws_edge",
    orgId: "org_untrusted_payload",
  });

  const body = await assertJsonResponse<CreatedIdentity>(response, 201);

  assert.match(body.id, /^agent_[A-Za-z0-9_-]+$/);
  assert.equal(body.name, "builder-bot");
  assert.equal(body.type, "agent");
  assert.equal(body.status, "active");
  assert.equal(body.orgId, "org_auth_ctx");
  assert.equal(body.sponsorId, "user_sponsor_1");
  assert.deepEqual(body.scopes, ["relayauth:identity:read", "relayauth:identity:update"]);
  assert.deepEqual(body.roles, ["builder", "deployer"]);
  assert.deepEqual(body.metadata, { environment: "test", owner: "qa" });
  assert.equal(body.workspaceId, "ws_edge");
  assertIsoTimestamp(body.createdAt, "createdAt");
  assertIsoTimestamp(body.updatedAt, "updatedAt");
});

test("POST /v1/identities returns 400 when name is missing", async () => {
  const response = await postCreateIdentity({
    sponsorId: "user_sponsor_1",
  } as CreateIdentityRequest);

  const body = await assertJsonResponse<Record<string, unknown>>(response, 400);

  assert.match(JSON.stringify(body), /name/i);
});

test("POST /v1/identities returns 400 when sponsorId is missing", async () => {
  const response = await postCreateIdentity({
    name: "missing-sponsor",
  });

  const body = await assertJsonResponse<Record<string, unknown>>(response, 400);

  assert.match(JSON.stringify(body), /sponsor/i);
});

test("POST /v1/identities auto-populates sponsorChain from the authenticated parent agent", async () => {
  const response = await postCreateIdentity(
    {
      name: "child-agent",
      sponsorId: "user_jane",
    },
    {
      claims: {
        sub: "agent_parent_9",
        org: "org_delegated",
        wks: "ws_delegate",
        sponsorId: "user_jane",
        sponsorChain: ["user_jane", "agent_root_1", "agent_parent_9"],
      },
    },
  );

  const body = await assertJsonResponse<CreatedIdentity>(response, 201);

  assert.deepEqual(body.sponsorChain, ["user_jane", "agent_root_1", "agent_parent_9", "agent_parent_9"]);
});

test("POST /v1/identities defaults budget from the org when the request omits budget", async () => {
  const orgBudget: IdentityBudget = {
    maxActionsPerHour: 120,
    maxCostPerDay: 35,
    alertThreshold: 0.85,
    autoSuspend: true,
  };
  const response = await postCreateIdentity(
    {
      name: "budgeted-agent",
      sponsorId: "user_budget_owner",
    },
    {
      db: createScenarioD1({ orgBudget }),
    },
  );

  const body = await assertJsonResponse<CreatedIdentity>(response, 201);

  assert.deepEqual(body.budget, orgBudget);
});

test("POST /v1/identities returns 409 when an identity with the same name already exists in the org", async () => {
  const response = await postCreateIdentity(
    {
      name: "existing-agent",
      sponsorId: "user_sponsor_1",
    },
    {
      db: createScenarioD1({
        duplicateIdentity: {
          id: "agent_existing_1",
          name: "existing-agent",
          orgId: "org_auth_ctx",
        },
      }),
    },
  );

  const body = await assertJsonResponse<Record<string, unknown>>(response, 409);

  assert.match(JSON.stringify(body), /exist|conflict|duplicate/i);
});
