import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

type ApiTokenRow = {
  id: string;
  tokenFamilyId: string;
  subjectType: string;
  userId: string;
  workspaceId: string;
  organizationId: string;
  sandboxId?: string | null;
  runId?: string | null;
  scopes: string;
  accessTokenHash: string;
  accessTokenExpiresAt: Date;
  refreshTokenHash: string;
  refreshTokenExpiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt?: Date | null;
  lastRefreshedAt?: Date | null;
  revokedAt?: Date | null;
  revokedReason?: string | null;
};

type FieldSelection = Record<string, { name: string }>;
type SqlChunk = { constructor?: { name?: string } };
type SqlExpression = SqlChunk & { queryChunks: unknown[] };
type StringChunk = SqlChunk & { value: string[] };
type ParamChunk = SqlChunk & { value: unknown };
type ColumnChunk = SqlChunk & { name: string };
type TestGlobals = typeof globalThis & { __appDbOverride?: unknown };
function isSqlExpression(value: unknown): value is SqlExpression {
  return Boolean(value && typeof value === "object" && "queryChunks" in value);
}

function isStringChunk(value: unknown, expected?: string): value is StringChunk {
  if (!value || typeof value !== "object" || !("value" in value)) {
    return false;
  }

  const chunk = value as StringChunk;
  if (!Array.isArray(chunk.value)) {
    return false;
  }

  return expected === undefined || chunk.value.join("") === expected;
}

function isColumnChunk(value: unknown): value is ColumnChunk {
  return Boolean(value && typeof value === "object" && "name" in value && "table" in value);
}

function isParamChunk(value: unknown): value is ParamChunk {
  return Boolean(value && typeof value === "object" && "value" in value && "encoder" in value);
}

function getColumnKey(column: ColumnChunk): keyof ApiTokenRow {
  return column.name.replace(/_([a-z])/g, (_match, character: string) => character.toUpperCase()) as keyof ApiTokenRow;
}

function evaluateWhere(condition: SqlExpression, row: ApiTokenRow): boolean {
  const chunks = condition.queryChunks;

  if (
    chunks.length === 5 &&
    isStringChunk(chunks[0], "") &&
    isColumnChunk(chunks[1]) &&
    isStringChunk(chunks[2], " = ") &&
    isParamChunk(chunks[3]) &&
    isStringChunk(chunks[4], "")
  ) {
    return row[getColumnKey(chunks[1])] === chunks[3].value;
  }

  if (
    chunks.length === 3 &&
    isStringChunk(chunks[0], "") &&
    isColumnChunk(chunks[1]) &&
    isStringChunk(chunks[2], " is null")
  ) {
    return row[getColumnKey(chunks[1])] == null;
  }

  if (
    chunks.length === 3 &&
    isStringChunk(chunks[0], "(") &&
    isSqlExpression(chunks[1]) &&
    isStringChunk(chunks[2], ")")
  ) {
    return chunks[1].queryChunks
      .filter(isSqlExpression)
      .every((nestedCondition) => evaluateWhere(nestedCondition, row));
  }

  throw new Error(`Unsupported auth token query shape: ${String(condition.constructor?.name)}`);
}

function projectRow(row: ApiTokenRow, fields?: FieldSelection) {
  if (!fields) {
    return { ...row };
  }

  return Object.fromEntries(
    Object.entries(fields).map(([alias, column]) => [alias, row[getColumnKey(column)]]),
  );
}

function createInMemoryAuthDb() {
  const rows: ApiTokenRow[] = [];

  const db = {
    rows,
    insert() {
      return {
        values: async (value: ApiTokenRow) => {
          rows.push({ ...value });
        },
      };
    },
    select(fields?: FieldSelection) {
      return {
        from() {
          return {
            where(condition: SqlExpression) {
              return {
                limit: async (count: number) =>
                  rows
                    .filter((row) => evaluateWhere(condition, row))
                    .slice(0, count)
                    .map((row) => projectRow(row, fields)),
              };
            },
          };
        },
      };
    },
    update() {
      return {
        set(patch: Partial<ApiTokenRow>) {
          return {
            where: async (condition: SqlExpression) => {
              for (const row of rows) {
                if (evaluateWhere(condition, row)) {
                  Object.assign(row, patch);
                }
              }
            },
          };
        },
      };
    },
  };

  return db;
}

describe("auth token lifecycle", () => {
  let db: ReturnType<typeof createInMemoryAuthDb>;
  let apiTokenStore: typeof import("../../packages/web/lib/auth/api-token-store.js");
  let requestAuth: typeof import("../../packages/web/lib/auth/request-auth.js");

  beforeEach(async () => {
    apiTokenStore = await import("../../packages/web/lib/auth/api-token-store.js");
    requestAuth = await import("../../packages/web/lib/auth/request-auth.js");
    db = createInMemoryAuthDb();
    (globalThis as TestGlobals).__appDbOverride = db as any;
  });

  afterEach(() => {
    (globalThis as TestGlobals).__appDbOverride = undefined;
  });

  it("creates and resolves token sessions", async () => {
    const issued = await apiTokenStore.createApiTokenSession({
      subjectType: "sandbox",
      userId: "user-1",
      workspaceId: "ws-1",
      organizationId: "org-1",
      runId: "run-1",
      scopes: ["workflow:runs:read", "workflow:runs:read", "workflow:logs:read"],
    });

    assert.match(issued.accessToken, /^cld_at_/);
    assert.match(issued.refreshToken, /^cld_rt_/);

    const resolved = await apiTokenStore.resolveApiToken(issued.accessToken);
    assert.ok(resolved);
    assert.equal(resolved.id, issued.sessionId);
    assert.equal(resolved.runId, "run-1");
    assert.deepEqual(resolved.scopes, ["workflow:logs:read", "workflow:runs:read"]);
    assert.ok(resolved.lastUsedAt);
    assert.equal(db.rows[0]?.lastUsedAt, resolved.lastUsedAt);
  });

  it("rotates refresh and access tokens on refresh", async () => {
    const issued = await apiTokenStore.createApiTokenSession({
      subjectType: "sandbox",
      userId: "user-1",
      workspaceId: "ws-1",
      organizationId: "org-1",
      runId: "run-refresh",
      scopes: ["workflow:runs:read"],
    });

    const refreshed = await apiTokenStore.refreshApiTokenSession(issued.refreshToken);
    assert.ok(refreshed);
    assert.notEqual(refreshed.accessToken, issued.accessToken);
    assert.notEqual(refreshed.refreshToken, issued.refreshToken);
    assert.equal(refreshed.sessionId, issued.sessionId);

    assert.equal(await apiTokenStore.resolveApiToken(issued.accessToken), null);
    assert.equal(await apiTokenStore.refreshApiTokenSession(issued.refreshToken), null);

    const resolved = await apiTokenStore.resolveApiToken(refreshed.accessToken);
    assert.equal(resolved?.id, issued.sessionId);
    assert.ok(db.rows[0]?.lastRefreshedAt);
  });

  it("revokes a session by token", async () => {
    const issued = await apiTokenStore.createApiTokenSession({
      subjectType: "cli",
      userId: "user-1",
      workspaceId: "ws-1",
      organizationId: "org-1",
      scopes: ["workflow:runs:read"],
    });

    assert.equal(await apiTokenStore.revokeApiTokenSession(issued.accessToken, "user_requested"), true);
    assert.equal(await apiTokenStore.resolveApiToken(issued.accessToken), null);
    assert.equal(await apiTokenStore.refreshApiTokenSession(issued.refreshToken), null);
    assert.equal(db.rows[0]?.revokedReason, "user_requested");
  });

  it("revokes every token session attached to a run", async () => {
    const runScopedA = await apiTokenStore.createApiTokenSession({
      subjectType: "sandbox",
      userId: "user-1",
      workspaceId: "ws-1",
      organizationId: "org-1",
      runId: "run-revoke",
      scopes: ["workflow:runs:read"],
    });
    const runScopedB = await apiTokenStore.createApiTokenSession({
      subjectType: "sandbox",
      userId: "user-1",
      workspaceId: "ws-1",
      organizationId: "org-1",
      runId: "run-revoke",
      scopes: ["workflow:runs:read"],
    });
    const otherRun = await apiTokenStore.createApiTokenSession({
      subjectType: "sandbox",
      userId: "user-1",
      workspaceId: "ws-1",
      organizationId: "org-1",
      runId: "run-other",
      scopes: ["workflow:runs:read"],
    });

    await apiTokenStore.revokeApiTokenSessionsForRun("run-revoke", "run_completed");

    assert.equal(await apiTokenStore.resolveApiToken(runScopedA.accessToken), null);
    assert.equal(await apiTokenStore.resolveApiToken(runScopedB.accessToken), null);
    assert.ok(await apiTokenStore.resolveApiToken(otherRun.accessToken));
    assert.equal(
      db.rows.filter((row) => row.runId === "run-revoke").every((row) => row.revokedReason === "run_completed"),
      true,
    );
  });

  it("requireAuthScope rejects token auth without the required scope", () => {
    const auth = {
      userId: "user-1",
      workspaceId: "ws-1",
      organizationId: "org-1",
      source: "token" as const,
      scopes: ["workflow:logs:read"] as string[],
      runId: "run-1",
      subjectType: "sandbox" as const,
    };

    assert.equal(requestAuth.requireAuthScope(auth, "workflow:runs:read"), false);
    assert.equal(requestAuth.requireAuthScope(auth, "workflow:logs:read"), true);
    assert.equal(
      requestAuth.requireAuthScope({ ...auth, scopes: ["cli:auth"] }, "workflow:invoke:write"),
      false,
    );
    assert.equal(
      requestAuth.requireAuthScope({ ...auth, source: "session" }, "workflow:runs:read"),
      true,
    );
  });

  it("prevents run-scoped tokens from accessing other runs", async () => {
    const allowedRunId = `run-allowed-${crypto.randomUUID()}`;
    const otherRunId = `run-other-${crypto.randomUUID()}`;
    const issued = await apiTokenStore.createApiTokenSession({
      subjectType: "sandbox",
      userId: "user-1",
      workspaceId: "ws-1",
      organizationId: "org-1",
      runId: allowedRunId,
      scopes: ["workflow:runs:read"],
    });

    const auth = await requestAuth.resolveRequestAuth({
      headers: new Headers({ authorization: `Bearer ${issued.accessToken}` }),
      cookies: {
        get() {
          return undefined;
        },
      },
    } as Parameters<typeof requestAuth.resolveRequestAuth>[0]);
    assert.ok(auth);
    assert.equal(auth.source, "token");
    assert.equal(requestAuth.requireAuthRunAccess(auth, allowedRunId), true);
    assert.equal(requestAuth.requireAuthRunAccess(auth, otherRunId), false);
  });

  it("rejects expired access tokens and expired refresh tokens", async () => {
    const expiredAccess = await apiTokenStore.createApiTokenSession({
      subjectType: "sandbox",
      userId: "user-1",
      workspaceId: "ws-1",
      organizationId: "org-1",
      scopes: ["workflow:runs:read"],
      accessTokenTtlSeconds: -60,
      refreshTokenTtlSeconds: 60,
    });
    const expiredRefresh = await apiTokenStore.createApiTokenSession({
      subjectType: "sandbox",
      userId: "user-1",
      workspaceId: "ws-1",
      organizationId: "org-1",
      scopes: ["workflow:runs:read"],
      accessTokenTtlSeconds: 60,
      refreshTokenTtlSeconds: -60,
    });

    assert.equal(await apiTokenStore.resolveApiToken(expiredAccess.accessToken), null);
    assert.equal(await apiTokenStore.refreshApiTokenSession(expiredRefresh.refreshToken), null);

    const refreshRow = db.rows.find((row) => row.id === expiredRefresh.sessionId);
    assert.equal(refreshRow?.revokedReason, "refresh_token_expired");
    assert.ok(refreshRow?.revokedAt);
  });
});
