import assert from "node:assert/strict";
import test from "node:test";
import type { ScopeChecker } from "@relayauth/sdk";
import type { RelayAuthTokenClaims } from "@relayauth/types";
import { Context, Hono, type MiddlewareHandler } from "hono";
import type { AppEnv } from "../env.js";
import {
  assertJsonResponse,
  createTestRequest,
  generateTestToken,
  mockD1,
  mockDO,
  mockKV,
} from "./test-helpers.js";

type ScopeMiddlewareOptions = {
  onError?: (error: Error) => Response | Promise<Response> | void | Promise<void>;
};

type ScopeMiddlewareModule = {
  requireScope: (scope: string, options?: ScopeMiddlewareOptions) => MiddlewareHandler<AppEnv>;
  requireScopes: (scopes: string[], options?: ScopeMiddlewareOptions) => MiddlewareHandler<AppEnv>;
  requireAnyScope: (scopes: string[], options?: ScopeMiddlewareOptions) => MiddlewareHandler<AppEnv>;
};

type ScopeContextVars = {
  identity?: RelayAuthTokenClaims;
  scopeChecker?: ScopeChecker;
};

function createBindings(overrides: Partial<AppEnv["Bindings"]> = {}): AppEnv["Bindings"] {
  return {
    IDENTITY_DO: mockDO(),
    DB: mockD1(),
    REVOCATION_KV: mockKV(),
    SIGNING_KEY: "dev-secret",
    SIGNING_KEY_ID: "dev-key",
    INTERNAL_SECRET: "internal-test-secret",
    ...overrides,
  };
}

async function loadScopeMiddleware(): Promise<ScopeMiddlewareModule> {
  let moduleRecord: Record<string, unknown>;

  try {
    moduleRecord = (await import("../middleware/scope.js")) as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    assert.fail(`Expected scope middleware module at ../middleware/scope.js: ${message}`);
  }

  assert.equal(typeof moduleRecord.requireScope, "function", "scope middleware should export requireScope()");
  assert.equal(typeof moduleRecord.requireScopes, "function", "scope middleware should export requireScopes()");
  assert.equal(typeof moduleRecord.requireAnyScope, "function", "scope middleware should export requireAnyScope()");

  return moduleRecord as unknown as ScopeMiddlewareModule;
}

function createAuthorizationHeader(claims: Partial<RelayAuthTokenClaims> = {}): HeadersInit {
  return {
    Authorization: `Bearer ${generateTestToken(claims)}`,
  };
}

function getScopeVars(c: Context<AppEnv>): ScopeContextVars {
  return (c as Context<AppEnv> & { var: ScopeContextVars }).var;
}

async function requestApp(
  app: Hono<AppEnv>,
  request: Request,
  bindingsOverrides: Partial<AppEnv["Bindings"]> = {},
): Promise<Response> {
  return app.request(request, undefined, createBindings(bindingsOverrides));
}

test('requireScope("relaycast:channel:read:*") middleware allows request with matching token', async () => {
  const { requireScope } = await loadScopeMiddleware();
  const app = new Hono<AppEnv>();

  app.use("/channels/general", requireScope("relaycast:channel:read:*"));
  app.get("/channels/general", (c) => c.json({ ok: true }));

  const response = await requestApp(
    app,
    createTestRequest(
      "GET",
      "/channels/general",
      undefined,
      createAuthorizationHeader({
        scopes: ["relaycast:channel:read:*"],
      }),
    ),
  );

  await assertJsonResponse<{ ok: boolean }>(response, 200, (body) => {
    assert.equal(body.ok, true);
  });
});

test("requireScope rejects request with 403 when scope not in token", async () => {
  const { requireScope } = await loadScopeMiddleware();
  const app = new Hono<AppEnv>();

  app.use("/channels/general", requireScope("relaycast:channel:read:*"));
  app.get("/channels/general", (c) => c.json({ ok: true }));

  const response = await requestApp(
    app,
    createTestRequest(
      "GET",
      "/channels/general",
      undefined,
      createAuthorizationHeader({
        scopes: ["relaycast:channel:write:*"],
      }),
    ),
  );

  await assertJsonResponse<{ error: string; code?: string }>(response, 403, (body) => {
    assert.equal(typeof body.error, "string");
  });
});

test("requireScope rejects request with 401 when no Authorization header is present", async () => {
  const { requireScope } = await loadScopeMiddleware();
  const app = new Hono<AppEnv>();

  app.use("/channels/general", requireScope("relaycast:channel:read:*"));
  app.get("/channels/general", (c) => c.json({ ok: true }));

  const response = await requestApp(app, createTestRequest("GET", "/channels/general"));

  await assertJsonResponse<{ error: string; code?: string }>(response, 401, (body) => {
    assert.equal(typeof body.error, "string");
  });
});

test("requireScope rejects request with 401 when the token is invalid or expired", async (t) => {
  const { requireScope } = await loadScopeMiddleware();

  await t.test("invalid token", async () => {
    const app = new Hono<AppEnv>();

    app.use("/channels/general", requireScope("relaycast:channel:read:*"));
    app.get("/channels/general", (c) => c.json({ ok: true }));

    const response = await requestApp(
      app,
      createTestRequest(
        "GET",
        "/channels/general",
        undefined,
        {
          Authorization: "Bearer definitely-not-a-jwt",
        },
      ),
    );

    await assertJsonResponse<{ error: string; code?: string }>(response, 401, (body) => {
      assert.equal(typeof body.error, "string");
    });
  });

  await t.test("expired token", async () => {
    const app = new Hono<AppEnv>();

    app.use("/channels/general", requireScope("relaycast:channel:read:*"));
    app.get("/channels/general", (c) => c.json({ ok: true }));

    const now = Math.floor(Date.now() / 1000);
    const response = await requestApp(
      app,
      createTestRequest(
        "GET",
        "/channels/general",
        undefined,
        createAuthorizationHeader({
          scopes: ["relaycast:channel:read:*"],
          iat: now - 120,
          exp: now - 60,
        }),
      ),
    );

    await assertJsonResponse<{ error: string; code?: string }>(response, 401, (body) => {
      assert.equal(typeof body.error, "string");
    });
  });
});

test('requireScopes(["a", "b"]) requires ALL scopes', async (t) => {
  const { requireScopes } = await loadScopeMiddleware();

  await t.test("rejects when one required scope is missing", async () => {
    const app = new Hono<AppEnv>();

    app.use("/multi", requireScopes(["relaycast:channel:read:*", "relaycast:channel:write:*"]));
    app.get("/multi", (c) => c.json({ ok: true }));

    const response = await requestApp(
      app,
      createTestRequest(
        "GET",
        "/multi",
        undefined,
        createAuthorizationHeader({
          scopes: ["relaycast:channel:read:*"],
        }),
      ),
    );

    await assertJsonResponse<{ error: string; code?: string }>(response, 403, (body) => {
      assert.equal(typeof body.error, "string");
    });
  });

  await t.test("allows when all required scopes are present", async () => {
    const app = new Hono<AppEnv>();

    app.use("/multi", requireScopes(["relaycast:channel:read:*", "relaycast:channel:write:*"]));
    app.get("/multi", (c) => c.json({ ok: true }));

    const response = await requestApp(
      app,
      createTestRequest(
        "GET",
        "/multi",
        undefined,
        createAuthorizationHeader({
          scopes: ["relaycast:channel:read:*", "relaycast:channel:write:*"],
        }),
      ),
    );

    await assertJsonResponse<{ ok: boolean }>(response, 200, (body) => {
      assert.equal(body.ok, true);
    });
  });
});

test('requireAnyScope(["a", "b"]) requires at least ONE scope', async (t) => {
  const { requireAnyScope } = await loadScopeMiddleware();

  await t.test("allows when one required scope is present", async () => {
    const app = new Hono<AppEnv>();

    app.use("/any", requireAnyScope(["relaycast:channel:read:*", "relaycast:channel:write:*"]));
    app.get("/any", (c) => c.json({ ok: true }));

    const response = await requestApp(
      app,
      createTestRequest(
        "GET",
        "/any",
        undefined,
        createAuthorizationHeader({
          scopes: ["relaycast:channel:read:*"],
        }),
      ),
    );

    await assertJsonResponse<{ ok: boolean }>(response, 200, (body) => {
      assert.equal(body.ok, true);
    });
  });

  await t.test("rejects when none of the required scopes are present", async () => {
    const app = new Hono<AppEnv>();

    app.use("/any", requireAnyScope(["relaycast:channel:read:*", "relaycast:channel:write:*"]));
    app.get("/any", (c) => c.json({ ok: true }));

    const response = await requestApp(
      app,
      createTestRequest(
        "GET",
        "/any",
        undefined,
        createAuthorizationHeader({
          scopes: ["relayfile:fs:read:*"],
        }),
      ),
    );

    await assertJsonResponse<{ error: string; code?: string }>(response, 403, (body) => {
      assert.equal(typeof body.error, "string");
    });
  });
});

test("middleware sets c.var.identity with the verified token claims", async () => {
  const { requireScope } = await loadScopeMiddleware();
  const app = new Hono<AppEnv>();
  const claims: Partial<RelayAuthTokenClaims> = {
    sub: "agent_scope_identity",
    org: "org_scope_identity",
    scopes: ["relaycast:channel:read:*"],
  };

  app.use("/identity", requireScope("relaycast:channel:read:*"));
  app.get("/identity", (c) => {
    const { identity } = getScopeVars(c);
    return c.json({
      sub: identity?.sub,
      org: identity?.org,
      scopes: identity?.scopes,
    });
  });

  const response = await requestApp(
    app,
    createTestRequest("GET", "/identity", undefined, createAuthorizationHeader(claims)),
  );

  await assertJsonResponse<{
    sub?: string;
    org?: string;
    scopes?: string[];
  }>(response, 200, (body) => {
    assert.equal(body.sub, claims.sub);
    assert.equal(body.org, claims.org);
    assert.deepEqual(body.scopes, claims.scopes);
  });
});

test("middleware sets c.var.scopeChecker with a ScopeChecker instance", async () => {
  const { requireScope } = await loadScopeMiddleware();
  const app = new Hono<AppEnv>();

  app.use("/scope-checker", requireScope("relaycast:channel:read:*"));
  app.get("/scope-checker", (c) => {
    const { scopeChecker } = getScopeVars(c);
    const checker = scopeChecker as
      | (ScopeChecker & {
          constructor?: { name?: string };
          check?: (scope: string) => boolean;
        })
      | undefined;

    return c.json({
      exists: Boolean(checker),
      constructorName: checker?.constructor?.name,
      canReadGeneral: checker?.check?.("relaycast:channel:read:general") ?? false,
    });
  });

  const response = await requestApp(
    app,
    createTestRequest(
      "GET",
      "/scope-checker",
      undefined,
      createAuthorizationHeader({
        scopes: ["relaycast:channel:read:*"],
      }),
    ),
  );

  await assertJsonResponse<{
    exists: boolean;
    constructorName?: string;
    canReadGeneral: boolean;
  }>(response, 200, (body) => {
    assert.equal(body.exists, true);
    assert.equal(body.constructorName, "ScopeChecker");
    assert.equal(body.canReadGeneral, true);
  });
});

test("a custom error handler can be provided for scope failures", async () => {
  const { requireScope } = await loadScopeMiddleware();
  const app = new Hono<AppEnv>();
  let handledError: Error | undefined;

  app.use(
    "/custom-error",
    requireScope("relaycast:channel:write:*", {
      onError: (error) => {
        handledError = error;
        return new Response(
          JSON.stringify({
            error: "custom_scope_failure",
            detail: error.message,
          }),
          {
            status: 418,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      },
    }),
  );
  app.get("/custom-error", (c) => c.json({ ok: true }));

  const response = await requestApp(
    app,
    createTestRequest(
      "GET",
      "/custom-error",
      undefined,
      createAuthorizationHeader({
        scopes: ["relaycast:channel:read:*"],
      }),
    ),
  );

  await assertJsonResponse<{ error: string; detail: string }>(response, 418, (body) => {
    assert.equal(body.error, "custom_scope_failure");
    assert.equal(typeof body.detail, "string");
  });
  assert.ok(handledError instanceof Error);
});

test('middleware extracts the token from an "Bearer {token}" Authorization header', async () => {
  const { requireScope } = await loadScopeMiddleware();
  const app = new Hono<AppEnv>();
  const claims: Partial<RelayAuthTokenClaims> = {
    sub: "agent_bearer_header",
    scopes: ["relaycast:*:*:*"],
  };

  app.use("/bearer", requireScope("relaycast:channel:read:general"));
  app.get("/bearer", (c) => {
    const { identity } = getScopeVars(c);
    return c.json({ sub: identity?.sub });
  });

  const response = await requestApp(
    app,
    createTestRequest("GET", "/bearer", undefined, {
      Authorization: `Bearer ${generateTestToken(claims)}`,
    }),
  );

  await assertJsonResponse<{ sub?: string }>(response, 200, (body) => {
    assert.equal(body.sub, claims.sub);
  });
});
