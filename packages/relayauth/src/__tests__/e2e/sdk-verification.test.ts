import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createSign, generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import test from "node:test";
import type { AgentIdentity, CreateIdentityInput, JWKSResponse, RelayAuthTokenClaims, TokenPair } from "@relayauth/types";
import {
  RelayAuthClient,
  ScopeChecker,
  TokenRevokedError,
  TokenVerifier,
  relayAuth,
  relayAuthExpress,
  requireScope,
  requireScopeExpress,
} from "@relayauth/sdk";
import { Hono } from "hono";

import { createTestApp, generateTestToken, mockKV } from "../test-helpers.js";

type StoredIdentityRecord = AgentIdentity & {
  sponsorId: string;
  sponsorChain: string[];
  workspaceId: string;
};

type TokenRecord = {
  token: string;
  claims: RelayAuthTokenClaims;
  identityId: string;
};

type TokenIssueOptions = {
  scopes?: string[];
  audience?: string[];
  expiresIn?: number;
};

type MockRequest = {
  headers?: {
    authorization?: string | string[];
  };
  identity?: RelayAuthTokenClaims;
};

type MockResponse = {
  statusCode?: number;
  jsonBody?: unknown;
  statusCalls: number[];
  jsonCalls: unknown[];
  status: (code: number) => MockResponse;
  json: (body: unknown) => MockResponse;
};

type NextSpy = (() => void | Promise<void>) & {
  callCount: number;
};

type JwtHeader = {
  alg?: string;
  typ?: string;
  kid?: string;
};

const ORG_ID = "org_sdk_verification_e2e";
const WORKSPACE_ID = "ws_sdk_verification_e2e";
const ADMIN_SCOPE = "relayauth:admin:*";
const READ_SCOPE = "relayauth:identity:read:*";
const DEFAULT_AUDIENCE = ["relayauth-sdk", "relay-api"];
const SIGNING_KEY = "dev-secret";

test("SDK & Verification E2E", async (t) => {
  const harness = await createSdkVerificationHarness();
  t.after(async () => {
    await harness.close();
  });

  const client = new RelayAuthClient({
    baseUrl: harness.baseUrl,
    token: harness.adminToken,
  });
  const verifier = new TokenVerifier({
    jwksUrl: harness.jwksUrl,
    issuer: harness.baseUrl,
    audience: DEFAULT_AUDIENCE,
    checkRevocation: true,
    revocationUrl: harness.revocationUrl,
  });

  let createdIdentity: AgentIdentity;
  let issuedTokenPair: TokenPair;
  let verifiedClaims: RelayAuthTokenClaims;
  let refreshedTokenPair: TokenPair;

  await t.test("1. TypeScript SDK E2E", async () => {
    createdIdentity = await client.createIdentity(ORG_ID, {
      name: "SDK Verification Agent",
      type: "agent",
      scopes: [READ_SCOPE, ADMIN_SCOPE],
      roles: ["sdk-e2e"],
      metadata: {
        suite: "sdk-verification",
      },
      workspaceId: WORKSPACE_ID,
    } satisfies CreateIdentityInput);

    assert.equal(createdIdentity.orgId, ORG_ID);
    assert.deepEqual(createdIdentity.scopes, [READ_SCOPE, ADMIN_SCOPE]);

    issuedTokenPair = await client.issueToken(createdIdentity.id, {
      scopes: [READ_SCOPE],
      audience: DEFAULT_AUDIENCE,
      expiresIn: 3600,
    });

    verifiedClaims = await verifier.verify(issuedTokenPair.accessToken);
    assert.equal(verifiedClaims.sub, createdIdentity.id);
    assert.deepEqual(verifiedClaims.aud, DEFAULT_AUDIENCE);
    assert.deepEqual(verifiedClaims.scopes, [READ_SCOPE]);

    ScopeChecker.fromToken(verifiedClaims).require(READ_SCOPE);
    assert.equal(ScopeChecker.fromToken(verifiedClaims).check(ADMIN_SCOPE), false);

    refreshedTokenPair = await client.refreshToken(issuedTokenPair.refreshToken);
    const refreshedClaims = await verifier.verify(refreshedTokenPair.accessToken);

    assert.notEqual(refreshedTokenPair.accessToken, issuedTokenPair.accessToken);
    assert.notEqual(refreshedClaims.jti, verifiedClaims.jti);
    assert.equal(refreshedClaims.sub, createdIdentity.id);

    await client.revokeToken(verifiedClaims.jti);

    await assert.rejects(
      () => verifier.verify(issuedTokenPair.accessToken),
      (error: unknown) => {
        assert.ok(error instanceof TokenRevokedError);
        return true;
      },
    );

    const stillActiveClaims = await verifier.verify(refreshedTokenPair.accessToken);
    assert.equal(stillActiveClaims.sub, createdIdentity.id);
  });

  await t.test("2. Hono Middleware E2E", async () => {
    const app = new Hono();

    app.use(
      "/api/*",
      relayAuth({
        jwksUrl: harness.jwksUrl,
        issuer: harness.baseUrl,
        audience: DEFAULT_AUDIENCE,
        checkRevocation: true,
        revocationUrl: harness.revocationUrl,
      }),
    );
    app.get("/api/me", (c) => {
      const identity = c.get("identity");
      return c.json({
        sub: identity.sub,
        scopes: identity.scopes,
      });
    });
    app.use("/api/admin/*", requireScope(ADMIN_SCOPE));
    app.get("/api/admin/panel", (c) => {
      const identity = c.get("identity");
      return c.json({
        ok: true,
        sub: identity.sub,
      });
    });

    const unauthorized = await app.request("/api/me");
    await assertJsonResponse<{ error: string; code: string }>(unauthorized, 401, (body) => {
      assert.equal(body.code, "missing_authorization");
    });

    const adminToken = (
      await client.issueToken(createdIdentity.id, {
        scopes: [READ_SCOPE, ADMIN_SCOPE],
        audience: DEFAULT_AUDIENCE,
      })
    ).accessToken;
    const valid = await app.request("/api/me", {
      headers: {
        Authorization: `Bearer ${adminToken}`,
      },
    });
    await assertJsonResponse<{ sub: string; scopes: string[] }>(valid, 200, (body) => {
      assert.equal(body.sub, createdIdentity.id);
      assert.deepEqual(body.scopes, [READ_SCOPE, ADMIN_SCOPE]);
    });

    const missingScopeToken = (
      await client.issueToken(createdIdentity.id, {
        scopes: [READ_SCOPE],
        audience: DEFAULT_AUDIENCE,
      })
    ).accessToken;
    const forbidden = await app.request("/api/admin/panel", {
      headers: {
        Authorization: `Bearer ${missingScopeToken}`,
      },
    });
    await assertJsonResponse<{ error: string; code: string }>(forbidden, 403, (body) => {
      assert.equal(body.code, "insufficient_scope");
    });

    const allowed = await app.request("/api/admin/panel", {
      headers: {
        Authorization: `Bearer ${adminToken}`,
      },
    });
    await assertJsonResponse<{ ok: boolean; sub: string }>(allowed, 200, (body) => {
      assert.equal(body.ok, true);
      assert.equal(body.sub, createdIdentity.id);
    });
  });

  await t.test("3. Express Middleware E2E", async () => {
    const middleware = relayAuthExpress({
      jwksUrl: harness.jwksUrl,
      issuer: harness.baseUrl,
      audience: DEFAULT_AUDIENCE,
      checkRevocation: true,
      revocationUrl: harness.revocationUrl,
    });
    const scopeMiddleware = requireScopeExpress(ADMIN_SCOPE);

    const unauthorizedReq = createMockRequest();
    const unauthorizedRes = createMockResponse();
    const unauthorizedNext = createNextSpy();
    await middleware(unauthorizedReq, unauthorizedRes, unauthorizedNext);
    assert.equal(unauthorizedNext.callCount, 0);
    assert.equal(unauthorizedReq.identity, undefined);
    assert.deepEqual(unauthorizedRes.jsonBody, {
      error: "Missing Authorization header",
      code: "missing_authorization",
    });
    assert.equal(unauthorizedRes.statusCode, 401);

    const adminToken = (
      await client.issueToken(createdIdentity.id, {
        scopes: [READ_SCOPE, ADMIN_SCOPE],
        audience: DEFAULT_AUDIENCE,
      })
    ).accessToken;
    const validReq = createMockRequest(`Bearer ${adminToken}`);
    const validRes = createMockResponse();
    const validNext = createNextSpy();
    await middleware(validReq, validRes, validNext);
    assert.equal(validNext.callCount, 1);
    assert.equal(validReq.identity?.sub, createdIdentity.id);
    assert.equal(validRes.statusCode, undefined);

    const missingScopeToken = (
      await client.issueToken(createdIdentity.id, {
        scopes: [READ_SCOPE],
        audience: DEFAULT_AUDIENCE,
      })
    ).accessToken;
    const forbiddenReq = createMockRequest(`Bearer ${missingScopeToken}`);
    const forbiddenAuthRes = createMockResponse();
    const forbiddenAuthNext = createNextSpy();
    await middleware(forbiddenReq, forbiddenAuthRes, forbiddenAuthNext);
    assert.equal(forbiddenAuthNext.callCount, 1);

    const forbiddenScopeRes = createMockResponse();
    const forbiddenScopeNext = createNextSpy();
    await scopeMiddleware(forbiddenReq, forbiddenScopeRes, forbiddenScopeNext);
    assert.equal(forbiddenScopeNext.callCount, 0);
    assert.equal(forbiddenScopeRes.statusCode, 403);
    assert.deepEqual(forbiddenScopeRes.jsonBody, {
      error: `Insufficient scope: requires ${ADMIN_SCOPE}, has [${READ_SCOPE}]`,
      code: "insufficient_scope",
    });

    const allowedScopeRes = createMockResponse();
    const allowedScopeNext = createNextSpy();
    await scopeMiddleware(validReq, allowedScopeRes, allowedScopeNext);
    assert.equal(allowedScopeNext.callCount, 1);
    assert.equal(allowedScopeRes.statusCode, undefined);
  });

  await t.test("6. Cross-language verification", async () => {
    const segments = issuedTokenPair.accessToken.split(".");
    assert.equal(segments.length, 3);

    for (const segment of segments) {
      assert.match(segment, /^[A-Za-z0-9_-]+$/);
      assert.equal(segment.includes("="), false);
    }

    const header = decodeBase64UrlJson<JwtHeader>(segments[0]);
    const payload = decodeBase64UrlJson<RelayAuthTokenClaims>(segments[1]);
    assert.equal(header?.alg, "RS256");
    assert.equal(header?.typ, "JWT");
    assert.equal(typeof header?.kid, "string");
    assert.equal(payload?.sub, createdIdentity.id);
    assert.deepEqual(payload?.aud, DEFAULT_AUDIENCE);

    const jwksResponse = await fetch(harness.jwksUrl);
    const jwks = await assertJsonResponse<JWKSResponse>(jwksResponse, 200);
    assert.equal(jwks.keys.length, 1);
    assert.equal((jwks.keys[0] as JsonWebKey).kty, "RSA");
    assert.equal(typeof (jwks.keys[0] as JsonWebKey).n, "string");
    assert.equal(typeof (jwks.keys[0] as JsonWebKey).e, "string");
  });
});

async function createSdkVerificationHarness() {
  const identities = new Map<string, StoredIdentityRecord>();
  const revokedTokenIds = new Set<string>();
  const tokensByValue = new Map<string, TokenRecord>();
  const tokensById = new Map<string, TokenRecord>();
  const keyId = "sdk-e2e-key";
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicJwk = publicKey.export({ format: "jwk" }) as JsonWebKey & {
    alg?: string;
    kid?: string;
    use?: string;
  };
  publicJwk.alg = "RS256";
  publicJwk.kid = keyId;
  publicJwk.use = "sig";

  const revocationKv = createRecordingKv(revokedTokenIds);
  const app = createTestApp({
    DB: createIdentityDatabase(identities, tokensById),
    IDENTITY_DO: createIdentityNamespace(identities),
    REVOCATION_KV: revocationKv,
  });

  const server = createServer(async (incoming, outgoing) => {
    try {
      const request = await toFetchRequest(incoming, `http://${incoming.headers.host ?? "127.0.0.1"}`);
      const response = await dispatch(request);
      await writeFetchResponse(outgoing, response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await writeFetchResponse(outgoing, jsonResponse({ error: message }, 500));
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const jwksUrl = `${baseUrl}/.well-known/jwks.json`;
  const revocationUrl = `${baseUrl}/v1/tokens/revocation`;
  const adminToken = generateTestToken(
    {
      sub: "agent_sdk_admin",
      org: ORG_ID,
      wks: WORKSPACE_ID,
      scopes: ["relayauth:*:*:*"],
      sponsorId: "user_sdk_admin",
      sponsorChain: ["user_sdk_admin", "agent_sdk_admin"],
    },
    SIGNING_KEY,
  );

  async function dispatch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/.well-known/jwks.json" && request.method === "GET") {
      return jsonResponse({
        keys: [publicJwk],
      } satisfies JWKSResponse);
    }

    if (url.pathname === "/v1/tokens" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      const identityId = typeof body?.identityId === "string" ? body.identityId : "";
      const options = body && typeof body === "object" ? (body as TokenIssueOptions) : {};
      const identity = identities.get(identityId);

      if (!identity) {
        return jsonResponse({ error: "identity_not_found", message: "Identity not found" }, 404);
      }

      if (identity.status === "suspended") {
        return jsonResponse({ error: "identity_suspended", message: "Identity suspended" }, 403);
      }

      return jsonResponse(
        issueTokenPair({
          identity,
          issuer: baseUrl,
          audience: options.audience,
          scopes: options.scopes,
          expiresIn: options.expiresIn,
          privateKey,
          keyId,
          tokensById,
          tokensByValue,
        }),
      );
    }

    if (url.pathname === "/v1/tokens/refresh" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      const refreshToken =
        body && typeof body === "object" && typeof (body as { refreshToken?: unknown }).refreshToken === "string"
          ? (body as { refreshToken: string }).refreshToken
          : "";
      const record = tokensByValue.get(refreshToken);

      if (!record) {
        return jsonResponse({ error: "invalid_token", message: "Invalid access token" }, 401);
      }

      if (revokedTokenIds.has(record.claims.jti)) {
        return jsonResponse({ error: "token_revoked", message: "Token has been revoked" }, 401);
      }

      if (record.claims.token_type !== "refresh") {
        return jsonResponse({ error: "invalid_token", message: "Invalid access token" }, 401);
      }

      if (record.claims.exp <= Math.floor(Date.now() / 1000)) {
        return jsonResponse({ error: "token_expired", message: "Token has expired" }, 401);
      }

      const identity = identities.get(record.identityId);
      if (!identity) {
        return jsonResponse({ error: "identity_not_found", message: "Identity not found" }, 404);
      }

      return jsonResponse(
        issueTokenPair({
          identity,
          issuer: baseUrl,
          audience: record.claims.aud,
          scopes: record.claims.scopes,
          privateKey,
          keyId,
          tokensById,
          tokensByValue,
        }),
      );
    }

    if (url.pathname === "/v1/tokens/revoke" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      const tokenId =
        body && typeof body === "object" && typeof (body as { tokenId?: unknown }).tokenId === "string"
          ? (body as { tokenId: string }).tokenId
          : "";

      if (tokenId) {
        revokedTokenIds.add(tokenId);
        await revocationKv.put(
          `revoked:${tokenId}`,
          JSON.stringify({
            tokenId,
            revokedAt: new Date().toISOString(),
          }),
        );
      }

      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/v1/tokens/introspect" && request.method === "GET") {
      const token = url.searchParams.get("token") ?? "";
      const record = tokensByValue.get(token);
      const isActive =
        record
        && !revokedTokenIds.has(record.claims.jti)
        && record.claims.exp > Math.floor(Date.now() / 1000);
      return jsonResponse(isActive ? record.claims : null);
    }

    if (url.pathname === "/v1/tokens/revocation" && request.method === "GET") {
      const jti = url.searchParams.get("jti") ?? "";
      return jsonResponse({
        revoked: revokedTokenIds.has(jti),
      });
    }

    if (url.pathname === "/v1/identities" && request.method === "POST") {
      const originalBody = await request.clone().text();
      const payload = parseJsonObject(originalBody);
      const claims = decodeBearerClaims(request.headers.get("authorization"));
      if (!claims) {
        return jsonResponse({ error: "Invalid access token" }, 401);
      }

      const name = typeof payload?.name === "string" ? payload.name.trim() : "";
      if (!name) {
        return jsonResponse({ error: "name is required" }, 400);
      }

      const sponsorId =
        typeof payload?.sponsorId === "string" && payload.sponsorId.trim()
          ? payload.sponsorId.trim()
          : claims.sponsorId;
      if (!sponsorId) {
        return jsonResponse({ error: "sponsorId is required" }, 400);
      }

      const duplicate = Array.from(identities.values()).find(
        (identity) => identity.orgId === claims.org && identity.name === name,
      );
      if (duplicate) {
        return jsonResponse({ error: `Identity '${name}' already exists in this org` }, 409);
      }

      const timestamp = new Date().toISOString();
      const createdIdentity: StoredIdentityRecord = {
        id: `agent_${randomUUID().replace(/-/g, "")}`,
        name,
        type:
          payload?.type === "human" || payload?.type === "service"
            ? payload.type
            : "agent",
        orgId: claims.org,
        status: "active",
        scopes: normalizeStringArray(payload?.scopes),
        roles: normalizeStringArray(payload?.roles),
        metadata: normalizeMetadata(payload?.metadata),
        createdAt: timestamp,
        updatedAt: timestamp,
        sponsorId,
        sponsorChain: [...claims.sponsorChain, claims.sub],
        workspaceId:
          typeof payload?.workspaceId === "string" && payload.workspaceId.trim()
            ? payload.workspaceId.trim()
            : claims.wks,
      };

      identities.set(createdIdentity.id, createdIdentity);
      return jsonResponse(createdIdentity, 201);
    }

    return app.request(request, undefined, app.bindings);
  }

  return {
    app,
    adminToken,
    baseUrl,
    jwksUrl,
    revocationUrl,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },
  };
}

function createIdentityNamespace(
  identities: Map<string, StoredIdentityRecord>,
): DurableObjectNamespace {
  return {
    idFromName: (name: string) => name,
    get(id: string) {
      return {
        fetch: async (request: Request) => {
          const url = new URL(request.url);

          if (url.pathname === "/internal/create" && request.method === "POST") {
            const identity = (await request.json()) as StoredIdentityRecord;
            identities.set(identity.id, identity);
            return jsonResponse(identity, 201);
          }

          if (url.pathname === "/internal/get" && request.method === "GET") {
            const identity = identities.get(id);
            return identity
              ? jsonResponse(identity)
              : jsonResponse({ error: "identity_not_found" }, 404);
          }

          return jsonResponse({ error: "unsupported_identity_operation" }, 400);
        },
      };
    },
  } as unknown as DurableObjectNamespace;
}

function createIdentityDatabase(
  identities: Map<string, StoredIdentityRecord>,
  tokensById: Map<string, TokenRecord>,
): D1Database {
  const meta = {
    changed_db: false,
    changes: 0,
    duration: 0,
    rows_read: 0,
    rows_written: 0,
  };

  function resolveRows(query: string, params: unknown[]): unknown[] {
    const normalized = normalizeSql(query);

    if (/from identities/.test(normalized) && /where org_id = \? and name = \?/.test(normalized)) {
      const [orgId, name] = params;
      const duplicate = Array.from(identities.values()).find(
        (identity) => identity.orgId === orgId && identity.name === name,
      );

      return duplicate
        ? [
            {
              id: duplicate.id,
              name: duplicate.name,
              orgId: duplicate.orgId,
              org_id: duplicate.orgId,
            },
          ]
        : [];
    }

    if (/from org_budgets/.test(normalized)) {
      return [];
    }

    if (/from tokens/.test(normalized)) {
      const [identityId] = params;
      return Array.from(tokensById.values())
        .filter((record) => record.identityId === identityId && record.claims.token_type === "access")
        .map((record) => ({
          id: record.claims.jti,
          jti: record.claims.jti,
          tokenId: record.claims.jti,
          token_id: record.claims.jti,
        }));
    }

    return [];
  }

  function createStatement(query: string, params: unknown[]) {
    return {
      first: async <T>() => (resolveRows(query, params)[0] as T | null) ?? null,
      run: async () => ({ success: true, meta }),
      raw: async <T>() => resolveRows(query, params) as T[],
      all: async <T>() => ({
        results: resolveRows(query, params) as T[],
        success: true,
        meta,
      }),
    };
  }

  return {
    prepare(query: string) {
      return {
        bind: (...params: unknown[]) => createStatement(query, params),
        first: async <T>() => (resolveRows(query, [])[0] as T | null) ?? null,
        run: async () => ({ success: true, meta }),
        raw: async <T>() => resolveRows(query, []) as T[],
        all: async <T>() => ({
          results: resolveRows(query, []) as T[],
          success: true,
          meta,
        }),
      };
    },
    batch: async <T>(statements: D1PreparedStatement[]) =>
      Promise.all(statements.map((statement) => statement.run())) as Awaited<T>,
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  } as D1Database;
}

function createRecordingKv(revokedTokenIds: Set<string>): KVNamespace {
  const base = mockKV();

  return {
    ...base,
    put: async (key: string, value: string) => {
      const tokenId = key.startsWith("revoked:") ? key.slice("revoked:".length) : "";
      if (tokenId) {
        revokedTokenIds.add(tokenId);
      }
      await base.put(key, value);
    },
  } as KVNamespace;
}

function issueTokenPair({
  identity,
  issuer,
  audience,
  scopes,
  expiresIn,
  privateKey,
  keyId,
  tokensById,
  tokensByValue,
}: {
  identity: StoredIdentityRecord;
  issuer: string;
  audience?: string[];
  scopes?: string[];
  expiresIn?: number;
  privateKey: KeyObject;
  keyId: string;
  tokensById: Map<string, TokenRecord>;
  tokensByValue: Map<string, TokenRecord>;
}): TokenPair {
  const now = Math.floor(Date.now() / 1000);
  const grantedScopes = scopes?.length ? [...scopes] : [...identity.scopes];
  const aud = audience?.length ? [...audience] : [...DEFAULT_AUDIENCE];
  const accessJti = randomUUID();
  const refreshJti = randomUUID();
  const accessExp = now + (Number.isFinite(expiresIn) && (expiresIn as number) > 0 ? (expiresIn as number) : 3600);
  const refreshExp = now + 7 * 24 * 60 * 60;
  const accessClaims: RelayAuthTokenClaims = {
    sub: identity.id,
    org: identity.orgId,
    wks: identity.workspaceId,
    scopes: grantedScopes,
    sponsorId: identity.sponsorId,
    sponsorChain: [...identity.sponsorChain],
    token_type: "access",
    iss: issuer,
    aud,
    exp: accessExp,
    iat: now,
    jti: accessJti,
    meta: {
      identityName: identity.name,
    },
  };
  const refreshClaims: RelayAuthTokenClaims = {
    ...accessClaims,
    token_type: "refresh",
    scopes: grantedScopes,
    exp: refreshExp,
    jti: refreshJti,
  };

  const accessToken = signRs256Jwt(accessClaims, privateKey, keyId);
  const refreshToken = signRs256Jwt(refreshClaims, privateKey, keyId);

  tokensById.set(accessJti, { token: accessToken, claims: accessClaims, identityId: identity.id });
  tokensById.set(refreshJti, { token: refreshToken, claims: refreshClaims, identityId: identity.id });
  tokensByValue.set(accessToken, { token: accessToken, claims: accessClaims, identityId: identity.id });
  tokensByValue.set(refreshToken, { token: refreshToken, claims: refreshClaims, identityId: identity.id });

  return {
    accessToken,
    refreshToken,
    accessTokenExpiresAt: new Date(accessExp * 1000).toISOString(),
    refreshTokenExpiresAt: new Date(refreshExp * 1000).toISOString(),
    tokenType: "Bearer",
  };
}

function signRs256Jwt(
  claims: RelayAuthTokenClaims,
  privateKey: KeyObject,
  keyId: string,
): string {
  const header = {
    alg: "RS256",
    typ: "JWT",
    kid: keyId,
  };
  const encodedHeader = encodeBase64Url(JSON.stringify(header));
  const encodedPayload = encodeBase64Url(JSON.stringify(claims));
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;
  const signature = createSign("RSA-SHA256").update(unsignedToken).end().sign(privateKey);
  return `${unsignedToken}.${encodeBase64Url(signature)}`;
}

function encodeBase64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64UrlJson<T>(value: string): T | null {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

function decodeBearerClaims(authorization: string | null): RelayAuthTokenClaims | null {
  if (!authorization) {
    return null;
  }

  const [scheme, token] = authorization.split(/\s+/, 2);
  if (scheme !== "Bearer" || !token) {
    return null;
  }

  const [, payload] = token.split(".");
  return payload ? decodeBase64UrlJson<RelayAuthTokenClaims>(payload) : null;
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function normalizeSql(query: string): string {
  return query.replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function normalizeMetadata(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

async function toFetchRequest(incoming: IncomingMessage, origin: string): Promise<Request> {
  const url = new URL(incoming.url ?? "/", origin);
  const headers = new Headers();

  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        headers.append(name, entry);
      }
      continue;
    }

    if (typeof value === "string") {
      headers.set(name, value);
    }
  }

  const hasBody = incoming.method !== "GET" && incoming.method !== "HEAD";
  const chunks: Buffer[] = [];
  if (hasBody) {
    for await (const chunk of incoming) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
  }

  return new Request(url, {
    method: incoming.method,
    headers,
    body: hasBody && chunks.length > 0 ? Buffer.concat(chunks) : undefined,
  });
}

async function writeFetchResponse(
  outgoing: ServerResponse,
  response: Response,
): Promise<void> {
  outgoing.statusCode = response.status;

  for (const [name, value] of response.headers.entries()) {
    outgoing.setHeader(name, value);
  }

  const body = Buffer.from(await response.arrayBuffer());
  outgoing.end(body);
}

async function assertJsonResponse<T>(
  response: Response,
  status: number,
  bodyCheck?: (body: T) => void | Promise<void>,
): Promise<T> {
  assert.equal(response.status, status);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/i);
  const body = (await response.json()) as T;
  if (bodyCheck) {
    await bodyCheck(body);
  }
  return body;
}

function createMockRequest(authorization?: string): MockRequest {
  return {
    headers: authorization ? { authorization } : {},
  };
}

function createMockResponse(): MockResponse {
  const response: MockResponse = {
    statusCalls: [],
    jsonCalls: [],
    status(code) {
      response.statusCode = code;
      response.statusCalls.push(code);
      return response;
    },
    json(body) {
      response.jsonBody = body;
      response.jsonCalls.push(body);
      return response;
    },
  };

  return response;
}

function createNextSpy(): NextSpy {
  const next = (() => {
    next.callCount += 1;
  }) as NextSpy;

  next.callCount = 0;
  return next;
}
