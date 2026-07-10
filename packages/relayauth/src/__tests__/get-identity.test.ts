import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import type { AgentIdentity, RelayAuthTokenClaims } from "@relayauth/types";
import {
  assertJsonResponse,
  createTestApp,
  createTestRequest,
  generateTestIdentity,
  mockDO,
} from "./test-helpers.js";

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
  const sponsorId = overrides.sponsorId ?? "user_reader_1";
  const sub = overrides.sub ?? "agent_reader_1";

  const payload: RelayAuthTokenClaims = {
    sub,
    org: overrides.org ?? "org_test",
    wks: overrides.wks ?? "ws_test",
    scopes: overrides.scopes ?? ["relayauth:identity:read:*"],
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

async function getIdentity(
  identityId: string,
  {
    claims,
    response,
  }: {
    claims?: Partial<RelayAuthTokenClaims>;
    response?: Response | ((request: Request) => Response | Promise<Response>);
  } = {},
): Promise<Response> {
  const app = createTestApp({
    IDENTITY_DO: mockDO(response),
  });
  const request = createTestRequest(
    "GET",
    `/v1/identities/${identityId}`,
    undefined,
    {
      Authorization: `Bearer ${createAuthToken(claims)}`,
    },
  );

  return app.request(request, undefined, app.bindings);
}

function assertBaseIdentityFields(body: AgentIdentity): void {
  assert.equal(typeof body.id, "string");
  assert.equal(typeof body.name, "string");
  assert.match(body.type, /^(agent|human|service)$/);
  assert.equal(typeof body.orgId, "string");
  assert.match(body.status, /^(active|suspended|retired)$/);
  assert.ok(Array.isArray(body.scopes));
  assert.ok(Array.isArray(body.roles));
  assert.equal(typeof body.metadata, "object");
  assert.equal(body.metadata === null, false);
  assert.equal(typeof body.createdAt, "string");
  assert.equal(typeof body.updatedAt, "string");
}

test("GET /v1/identities/:id returns 200 with the full identity object", async () => {
  const identity = generateTestIdentity({
    id: "agent_get_123",
    name: "Retriever",
    type: "service",
    orgId: "org_lookup",
    status: "active",
    scopes: ["relayauth:identity:read:*", "relayauth:identity:manage:*"],
    roles: ["operator", "observer"],
    metadata: {
      team: "platform",
      region: "eu-west-1",
    },
    createdAt: "2026-03-01T10:00:00.000Z",
    updatedAt: "2026-03-02T11:30:00.000Z",
    lastActiveAt: "2026-03-03T12:45:00.000Z",
  });

  const response = await getIdentity(identity.id, {
    claims: { org: identity.orgId },
    response: () => jsonResponse(identity, 200),
  });

  const body = await assertJsonResponse<AgentIdentity>(response, 200);

  assert.deepEqual(body, identity);
});

test("GET /v1/identities/:id returns all identity fields", async () => {
  const identity = generateTestIdentity({
    id: "agent_full_fields",
    name: "Full Fields",
    type: "human",
    orgId: "org_full_fields",
    status: "suspended",
    scopes: ["relayauth:identity:read:*"],
    roles: ["admin"],
    metadata: {
      owner: "alice",
      costCenter: "42",
    },
    createdAt: "2026-02-01T00:00:00.000Z",
    updatedAt: "2026-02-10T00:00:00.000Z",
    lastActiveAt: "2026-02-09T23:59:59.000Z",
    suspendedAt: "2026-02-08T12:00:00.000Z",
    suspendReason: "manual_review",
  });

  const response = await getIdentity(identity.id, {
    claims: { org: identity.orgId },
    response: () => jsonResponse(identity, 200),
  });

  const body = await assertJsonResponse<AgentIdentity>(response, 200);

  assertBaseIdentityFields(body);
  assert.equal(body.id, identity.id);
  assert.equal(body.name, identity.name);
  assert.equal(body.type, identity.type);
  assert.equal(body.orgId, identity.orgId);
  assert.equal(body.status, identity.status);
  assert.deepEqual(body.scopes, identity.scopes);
  assert.deepEqual(body.roles, identity.roles);
  assert.deepEqual(body.metadata, identity.metadata);
  assert.equal(body.createdAt, identity.createdAt);
  assert.equal(body.updatedAt, identity.updatedAt);
  assert.equal(body.lastActiveAt, identity.lastActiveAt);
  assert.equal(body.suspendedAt, identity.suspendedAt);
  assert.equal(body.suspendReason, identity.suspendReason);
});

test("GET /v1/identities/:id returns 404 for a non-existent identity", async () => {
  const response = await getIdentity("agent_missing_404", {
    response: () => jsonResponse({ error: "identity_not_found" }, 404),
  });

  assert.equal(response.status, 404);
});

test('GET /v1/identities/:id returns 404 with { error: "identity_not_found" } for a missing identity', async () => {
  const response = await getIdentity("agent_missing_body", {
    response: () => jsonResponse({ error: "identity_not_found" }, 404),
  });

  const body = await assertJsonResponse<{ error: string }>(response, 404);

  assert.deepEqual(body, { error: "identity_not_found" });
});

test("GET /v1/identities/:id returns suspended and retired identities", async () => {
  const identities: AgentIdentity[] = [
    generateTestIdentity({
      id: "agent_suspended_1",
      status: "suspended",
      suspendedAt: "2026-03-10T09:00:00.000Z",
      suspendReason: "budget_exceeded",
    }),
    generateTestIdentity({
      id: "agent_retired_1",
      status: "retired",
    }),
  ];

  for (const identity of identities) {
    const response = await getIdentity(identity.id, {
      claims: { org: identity.orgId },
      response: () => jsonResponse(identity, 200),
    });

    const body = await assertJsonResponse<AgentIdentity>(response, 200);

    assert.equal(body.id, identity.id);
    assert.equal(body.status, identity.status);
  }
});
