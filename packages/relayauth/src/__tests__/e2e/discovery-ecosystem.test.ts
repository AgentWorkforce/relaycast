import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createSign, generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import test from "node:test";
import type {
  AgentConfiguration,
  AgentIdentity,
  JWKSResponse,
  RelayAuthTokenClaims,
  TokenPair,
} from "@relayauth/types";
import {
  agentCardToConfiguration,
  configurationToAgentCard,
  generateScopes,
  ScopeChecker,
  TokenVerifier,
  type A2aAgentCard,
  type OpenAPISpec,
} from "@relayauth/sdk";
import { createTestApp } from "../test-helpers.js";

type StoredIdentityRecord = AgentIdentity & {
  sponsorId: string;
  sponsorChain: string[];
  workspaceId: string;
};

type DiscoveryEcosystemHarness = Awaited<ReturnType<typeof createDiscoveryEcosystemHarness>>;

type TokenIssueOptions = {
  scopes?: string[];
  audience?: string[];
  expiresIn?: number;
};

type JsonObject = Record<string, unknown>;

const ORG_ID = "org_discovery_ecosystem_e2e";
const WORKSPACE_ID = "ws_discovery_ecosystem_e2e";
const DEFAULT_AUDIENCE = ["relayauth-discovery-e2e"];
const READ_SCOPE = "cloud:projects:read";
const WRITE_SCOPE = "cloud:projects:write";
const MANAGE_SCOPE = "relayauth:identity:manage:*";

test("Discovery & ecosystem E2E", async (t) => {
  const harness = await createDiscoveryEcosystemHarness();
  t.after(async () => {
    await harness.close();
  });

  await t.test("1. discovery flow", async () => {
    const response = await fetch(`${harness.baseUrl}/.well-known/agent-configuration`);
    assert.equal(response.status, 200);

    const configuration = (await response.json()) as AgentConfiguration;
    assert.equal(configuration.issuer, harness.baseUrl);
    assert.equal(configuration.jwks_uri, `${harness.baseUrl}/.well-known/jwks.json`);
    assert.equal(configuration.identity_endpoint, `${harness.baseUrl}/v1/identities`);
    assert.equal(configuration.token_endpoint, `${harness.baseUrl}/v1/tokens`);
    assert.equal(configuration.scopes_endpoint, `${harness.baseUrl}/v1/scopes`);
    assert.equal(configuration.endpoints.agent_configuration?.url, `${harness.baseUrl}/.well-known/agent-configuration`);
    assert.equal(configuration.endpoints.identities?.url, `${harness.baseUrl}/v1/identities`);
    assert.equal(configuration.endpoints.tokens?.url, `${harness.baseUrl}/v1/tokens`);

    // Discovery currently publishes supported scopes through scope_definitions/examples.
    assert.ok(Array.isArray(configuration.scope_definitions));
    assert.ok(configuration.scope_definitions.length > 0);
    assert.ok(
      configuration.scope_definitions.some((definition) => definition.pattern.includes("relayauth:identity")),
    );
    assert.ok(
      configuration.scope_definitions.flatMap((definition) => definition.examples).length > 0,
    );
  });

  await t.test("2. OpenAPI-to-scopes flow", async () => {
    const spec: OpenAPISpec = {
      openapi: "3.1.0",
      info: {
        title: "Ecosystem API",
      },
      paths: {
        "/projects": {
          get: {
            summary: "List projects",
          },
          post: {
            summary: "Create project",
          },
        },
        "/projects/{id}": {
          delete: {
            summary: "Delete project",
          },
        },
        "/projects/{id}/members": {
          get: {
            summary: "List project members",
          },
        },
        "/audit": {
          post: {
            summary: "Write audit entry",
            "x-relayauth-scope": "cloud:audit:write",
          },
        },
      },
    };

    const scopes = generateScopes(spec, "cloud");
    const byScope = new Map(scopes.map((definition) => [definition.scope, definition]));

    assert.ok(byScope.has("cloud:projects:read"));
    assert.ok(byScope.has("cloud:projects:write"));
    assert.ok(byScope.has("cloud:projects:delete:/projects/{id}"));
    assert.ok(byScope.has("cloud:projects.members:read"));
    assert.ok(byScope.has("cloud:audit:write"));

    assert.equal(byScope.get("cloud:projects:read")?.method, "GET");
    assert.equal(byScope.get("cloud:projects:read")?.approval, "session");
    assert.equal(byScope.get("cloud:projects:write")?.approval, "explicit");
    assert.equal(byScope.get("cloud:projects.members:read")?.path, "/projects/{id}/members");

    const checker = ScopeChecker.fromToken({
      scopes: [
        "cloud:projects:read",
      ],
    } as Pick<RelayAuthTokenClaims, "scopes">);

    assert.equal(checker.check("cloud:projects:read"), true);
    assert.equal(checker.check("cloud:projects:write"), false);
    assert.equal(
      checker.checkAll([
        "cloud:projects:read",
      ]),
      true,
    );
  });

  // TODO: Re-enable adapter coverage once RelayAuthAdapter is available from a
  // published npm package entrypoint instead of a cross-package source import.
  await t.test(
    "3. framework adapter flow",
    {
      skip: "RelayAuthAdapter is not exported by @relayauth/sdk and no installed package provides it.",
    },
    async () => {},
  );

  await t.test("4. A2A bridge flow", async () => {
    const originalCard: A2aAgentCard = {
      name: "Ecosystem Agent",
      description: "Agent for ecosystem workflows",
      url: `${harness.baseUrl}/rpc`,
      version: "1.2.3",
      skills: [
        {
          id: "project-search",
          name: "Project Search",
          description: "Search projects",
          examples: ["Search for migration work"],
        },
        {
          id: "member-lookup",
          name: "Member Lookup",
          description: "Lookup project members",
        },
      ],
      authentication: {
        schemes: ["bearer"],
      },
    };

    const configuration = agentCardToConfiguration(originalCard);
    const roundTrippedCard = configurationToAgentCard(configuration, originalCard.name);

    assert.equal(configuration.service_name, originalCard.name);
    assert.equal(configuration.token_endpoint, originalCard.url);
    assert.deepEqual(
      configuration.scope_definitions.map((definition) => definition.pattern),
      [
        "a2a:project-search:invoke:*",
        "a2a:member-lookup:invoke:*",
      ],
    );

    assert.equal(roundTrippedCard.name, originalCard.name);
    assert.equal(roundTrippedCard.url, originalCard.url);
    assert.deepEqual(
      roundTrippedCard.skills?.map((skill) => skill.name),
      originalCard.skills?.map((skill) => skill.name),
    );
    assert.equal(roundTrippedCard.skills?.length, originalCard.skills?.length);
  });

  await t.test(
    "5. integration flow",
    {
      skip: "RelayAuthAdapter is not exported by @relayauth/sdk and no installed package provides it.",
    },
    async () => {},
  );
});

async function createDiscoveryEcosystemHarness() {
  const identities = new Map<string, StoredIdentityRecord>();
  const app = createTestApp();
  const keyId = "discovery-ecosystem-key";
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicJwk = publicKey.export({ format: "jwk" }) as JsonWebKey & {
    alg?: string;
    kid?: string;
    use?: string;
  };
  publicJwk.alg = "RS256";
  publicJwk.kid = keyId;
  publicJwk.use = "sig";

  const adminIdentity: StoredIdentityRecord = {
    id: "agent_discovery_admin",
    name: "Discovery Admin",
    type: "agent",
    orgId: ORG_ID,
    status: "active",
    scopes: [MANAGE_SCOPE, "cloud:*:*:*"],
    roles: ["admin"],
    metadata: {
      suite: "discovery-ecosystem",
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sponsorId: "user_discovery_admin",
    sponsorChain: ["user_discovery_admin", "agent_discovery_admin"],
    workspaceId: WORKSPACE_ID,
  };
  identities.set(adminIdentity.id, adminIdentity);

  const server = createServer(async (incoming, outgoing) => {
    try {
      const request = await toFetchRequest(
        incoming,
        `http://${incoming.headers.host ?? "127.0.0.1"}`,
      );
      const response = await dispatch(request);
      await writeFetchResponse(outgoing, response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await writeFetchResponse(
        outgoing,
        jsonResponse({ error: "internal_error", message }, 500),
      );
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let verifier: TokenVerifier | undefined;

  const adminToken = signRs256Jwt(
    {
      sub: adminIdentity.id,
      org: adminIdentity.orgId,
      wks: adminIdentity.workspaceId,
      scopes: [...adminIdentity.scopes],
      sponsorId: adminIdentity.sponsorId,
      sponsorChain: [...adminIdentity.sponsorChain],
      token_type: "access",
      iss: baseUrl,
      aud: DEFAULT_AUDIENCE,
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      jti: randomUUID(),
      meta: {
        identityName: adminIdentity.name,
      },
    },
    privateKey,
    keyId,
  );

  function getVerifier(): TokenVerifier {
    verifier ??= new TokenVerifier({
      jwksUrl: `${baseUrl}/.well-known/jwks.json`,
      issuer: baseUrl,
      audience: DEFAULT_AUDIENCE,
      checkRevocation: false,
    });
    return verifier;
  }

  async function dispatch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/.well-known/jwks.json" && request.method === "GET") {
      return jsonResponse({
        keys: [publicJwk],
      } satisfies JWKSResponse);
    }

    if (url.pathname === "/v1/identities" && request.method === "POST") {
      const claims = await verifyBearerClaims(request.headers.get("authorization"), getVerifier());
      if (!claims) {
        return jsonResponse({ error: "Invalid access token" }, 401);
      }

      if (!ScopeChecker.fromToken(claims).check(MANAGE_SCOPE)) {
        return jsonResponse({ error: "insufficient_scope", required: MANAGE_SCOPE }, 403);
      }

      const payload = (await request.json().catch(() => null)) as JsonObject | null;
      const name = typeof payload?.name === "string" ? payload.name.trim() : "";
      if (!name) {
        return jsonResponse({ error: "name is required" }, 400);
      }

      const sponsorId =
        typeof payload?.sponsorId === "string" && payload.sponsorId.trim().length > 0
          ? payload.sponsorId.trim()
          : claims.sponsorId;
      if (!sponsorId) {
        return jsonResponse({ error: "sponsorId is required" }, 400);
      }

      const duplicate = Array.from(identities.values()).find(
        (identity) => identity.orgId === claims.org && identity.name === name,
      );
      if (duplicate) {
        return jsonResponse({ error: "identity_already_exists" }, 409);
      }

      const timestamp = new Date().toISOString();
      const identity: StoredIdentityRecord = {
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
          typeof payload?.workspaceId === "string" && payload.workspaceId.trim().length > 0
            ? payload.workspaceId.trim()
            : claims.wks,
      };

      identities.set(identity.id, identity);
      return jsonResponse(identity, 201);
    }

    if (url.pathname === "/v1/tokens" && request.method === "POST") {
      const payload = (await request.json().catch(() => null)) as JsonObject | null;
      const identityId = typeof payload?.identityId === "string" ? payload.identityId : "";
      const identity = identities.get(identityId);

      if (!identity) {
        return jsonResponse({ error: "identity_not_found" }, 404);
      }

      return jsonResponse(
        issueTokenPair({
          identity,
          issuer: baseUrl,
          audience: normalizeStringArray(payload?.audience, DEFAULT_AUDIENCE),
          scopes: normalizeStringArray(payload?.scopes, identity.scopes),
          expiresIn:
            typeof payload?.expiresIn === "number" && Number.isFinite(payload.expiresIn)
              ? payload.expiresIn
              : undefined,
          privateKey,
          keyId,
        }),
      );
    }

    if (url.pathname === "/ecosystem/projects/demo" && request.method === "GET") {
      const claims = await verifyBearerClaims(request.headers.get("authorization"), getVerifier());
      if (!claims) {
        return jsonResponse({ error: "Invalid access token" }, 401);
      }

      if (!ScopeChecker.fromToken(claims).check(READ_SCOPE)) {
        return jsonResponse({ error: "insufficient_scope", required: READ_SCOPE }, 403);
      }

      return jsonResponse({
        id: "demo",
        ok: true,
        scope: READ_SCOPE,
      });
    }

    if (url.pathname === "/ecosystem/projects/demo" && request.method === "POST") {
      const claims = await verifyBearerClaims(request.headers.get("authorization"), getVerifier());
      if (!claims) {
        return jsonResponse({ error: "Invalid access token" }, 401);
      }

      if (!ScopeChecker.fromToken(claims).check(WRITE_SCOPE)) {
        return jsonResponse({ error: "insufficient_scope", required: WRITE_SCOPE }, 403);
      }

      return jsonResponse({
        id: "demo",
        ok: true,
        scope: WRITE_SCOPE,
      });
    }

    return app.request(request, undefined, app.bindings);
  }

  return {
    adminToken,
    baseUrl,
    identities,
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

async function verifyBearerClaims(
  authorization: string | null,
  verifier: TokenVerifier,
): Promise<RelayAuthTokenClaims | null> {
  if (!authorization) {
    return null;
  }

  const [scheme, token] = authorization.split(/\s+/, 2);
  if (scheme !== "Bearer" || !token) {
    return null;
  }

  try {
    return await verifier.verify(token);
  } catch {
    return null;
  }
}

function issueTokenPair({
  identity,
  issuer,
  audience,
  scopes,
  expiresIn,
  privateKey,
  keyId,
}: {
  identity: StoredIdentityRecord;
  issuer: string;
  audience: string[];
  scopes: string[];
  expiresIn?: number;
  privateKey: KeyObject;
  keyId: string;
}): TokenPair {
  const now = Math.floor(Date.now() / 1000);
  const accessJti = randomUUID();
  const refreshJti = randomUUID();
  const accessExp = now + (typeof expiresIn === "number" && expiresIn > 0 ? expiresIn : 3600);
  const refreshExp = now + 24 * 60 * 60;

  const accessClaims: RelayAuthTokenClaims = {
    sub: identity.id,
    org: identity.orgId,
    wks: identity.workspaceId,
    scopes: [...scopes],
    sponsorId: identity.sponsorId,
    sponsorChain: [...identity.sponsorChain],
    token_type: "access",
    iss: issuer,
    aud: [...audience],
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
    exp: refreshExp,
    jti: refreshJti,
  };

  return {
    accessToken: signRs256Jwt(accessClaims, privateKey, keyId),
    refreshToken: signRs256Jwt(refreshClaims, privateKey, keyId),
    accessTokenExpiresAt: new Date(accessExp * 1000).toISOString(),
    refreshTokenExpiresAt: new Date(refreshExp * 1000).toISOString(),
    tokenType: "Bearer",
  };
}

function signRs256Jwt(
  payload: RelayAuthTokenClaims,
  privateKey: KeyObject,
  keyId: string,
): string {
  const header = {
    alg: "RS256",
    typ: "JWT",
    kid: keyId,
  };
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signer = createSign("RSA-SHA256");
  signer.update(`${encodedHeader}.${encodedPayload}`);
  signer.end();
  const signature = signer.sign(privateKey).toString("base64url");
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function normalizeStringArray(value: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function normalizeMetadata(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) =>
      typeof entry === "string" ? [[key, entry]] : [],
    ),
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

async function toFetchRequest(
  incoming: IncomingMessage,
  baseUrl: string,
): Promise<Request> {
  const url = new URL(incoming.url ?? "/", baseUrl);
  const headers = new Headers();

  for (const [key, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
      continue;
    }

    if (value !== undefined) {
      headers.set(key, value);
    }
  }

  const body = await readIncomingBody(incoming);
  return new Request(url, {
    method: incoming.method,
    headers,
    body: body.length > 0 ? body : undefined,
    duplex: body.length > 0 ? "half" : undefined,
  });
}

function readIncomingBody(incoming: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    incoming.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    incoming.on("error", reject);
  });
}

async function writeFetchResponse(
  outgoing: ServerResponse,
  response: Response,
): Promise<void> {
  outgoing.statusCode = response.status;
  response.headers.forEach((value, key) => {
    outgoing.setHeader(key, value);
  });

  const body = Buffer.from(await response.arrayBuffer());
  outgoing.end(body);
}
