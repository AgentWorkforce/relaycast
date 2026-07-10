import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { AgentIdentity } from "@relayauth/types";
import type { IdentityBudgetUsage, StoredIdentity } from "../durable-objects/identity-do.js";

type SqlRow = Record<string, unknown>;
type SqlCall = { query: string; params: unknown[] };
type D1Call = { query: string; params: unknown[] };
type StoragePutCall = { key: string; value: unknown };

class SqlCursor<T extends SqlRow = SqlRow> implements Iterable<T> {
  constructor(private readonly rows: T[]) {}

  one(): T | null {
    return this.rows[0] ?? null;
  }

  [Symbol.iterator](): Iterator<T> {
    return this.rows[Symbol.iterator]();
  }
}

function normalizeSql(query: string): string {
  return query.replace(/\s+/g, " ").trim();
}

function createSqlStorage() {
  const database = new DatabaseSync(":memory:");
  const sqlCalls: SqlCall[] = [];
  const kv = new Map<string, unknown>();
  const putCalls: StoragePutCall[] = [];

  const storage = {
    sql: {
      exec(query: string, ...params: unknown[]) {
        const normalized = normalizeSql(query);
        sqlCalls.push({ query: normalized, params });

        if (params.length === 0 && normalized.includes(";")) {
          database.exec(query);
          return new SqlCursor([]);
        }

        const statement = database.prepare(query);
        if (/^\s*(select|pragma|with)\b/i.test(query) || /\breturning\b/i.test(query)) {
          return new SqlCursor(statement.all(...params) as SqlRow[]);
        }

        statement.run(...params);
        return new SqlCursor([]);
      },
    },
    get: async <T>(key: string) => (kv.get(key) as T | undefined) ?? undefined,
    put: async (key: string, value: unknown) => {
      putCalls.push({ key, value });
      kv.set(key, value);
    },
    delete: async (key: string) => kv.delete(key),
    deleteAll: async () => {
      kv.clear();
    },
    list: async () => new Map(kv),
    transaction: async <T>(callback: () => Promise<T>) => callback(),
    transactionSync: <T>(callback: () => T) => callback(),
    sync: async () => {},
  };

  return { database, kv, putCalls, sqlCalls, storage };
}

function createRecordingD1() {
  const calls: D1Call[] = [];
  const meta = {
    changed_db: false,
    changes: 0,
    duration: 0,
    rows_read: 0,
    rows_written: 0,
  };

  const db = {
    prepare(query: string) {
      const normalized = normalizeSql(query);
      return {
        bind: (...params: unknown[]) => ({
          first: async <T>() => null as T | null,
          run: async () => {
            calls.push({ query: normalized, params });
            return { success: true, meta };
          },
          raw: async <T>() => [] as T[],
          all: async <T>() => ({ results: [] as T[], success: true, meta }),
        }),
        first: async <T>() => null as T | null,
        run: async () => {
          calls.push({ query: normalized, params: [] });
          return { success: true, meta };
        },
        raw: async <T>() => [] as T[],
        all: async <T>() => ({ results: [] as T[], success: true, meta }),
      };
    },
    batch: async <T>(statements: D1PreparedStatement[]) =>
      Promise.all(statements.map((statement) => statement.run())) as Awaited<T>,
    exec: async (query: string) => {
      calls.push({ query: normalizeSql(query), params: [] });
      return { count: 0, duration: 0 };
    },
    dump: async () => new ArrayBuffer(0),
  } as D1Database;

  return { calls, db };
}

function ensureDurableObjectGlobal() {
  if ("DurableObject" in globalThis) {
    return;
  }

  class TestDurableObject {
    ctx: DurableObjectState;
    env: unknown;

    constructor(ctx: DurableObjectState, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  }

  Object.assign(globalThis, { DurableObject: TestDurableObject });
}

async function loadIdentityDOClass(): Promise<
  new (ctx: DurableObjectState, env: Awaited<ReturnType<typeof loadTestHelpers>>["createTestApp"] extends (
    ...args: never[]
  ) => infer T
    ? T extends { bindings: infer B }
      ? B
      : never
    : never) => {
    create(input: StoredIdentity): Promise<StoredIdentity>;
    get(id?: string): Promise<StoredIdentity | null>;
    update(input: Partial<StoredIdentity>): Promise<StoredIdentity>;
    suspend(reason: string): Promise<StoredIdentity>;
    reactivate(): Promise<StoredIdentity>;
    retire(): Promise<StoredIdentity>;
    delete(): Promise<void>;
  }
> {
  ensureDurableObjectGlobal();
  const module = await import("../durable-objects/identity-do.js");
  return module.IdentityDO;
}

let testHelpersPromise: Promise<typeof import("./test-helpers.js")> | undefined;

function loadTestHelpers() {
  ensureDurableObjectGlobal();
  testHelpersPromise ??= import("./test-helpers.js");
  return testHelpersPromise;
}

function createMockState() {
  const sqlStorage = createSqlStorage();
  const state = {
    id: {
      toString: () => "identity-do-test-id",
      equals: () => false,
    },
    storage: sqlStorage.storage,
    blockConcurrencyWhile: async <T>(callback: () => Promise<T> | T) => await callback(),
    waitUntil: (_promise: Promise<unknown>) => undefined,
    getAlarm: async () => null,
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  } as unknown as DurableObjectState;

  return { state, ...sqlStorage };
}

async function createStoredIdentity(overrides: Partial<StoredIdentity> = {}): Promise<StoredIdentity> {
  const { generateTestIdentity } = await loadTestHelpers();
  const base = generateTestIdentity(overrides as Partial<AgentIdentity>);
  return {
    ...base,
    sponsorId: overrides.sponsorId ?? "user_human_1",
    sponsorChain: overrides.sponsorChain ?? ["user_human_1", "agent_parent_1", base.id],
    workspaceId: overrides.workspaceId ?? "ws_test",
    budget: overrides.budget ?? {
      maxActionsPerHour: 10,
      maxCostPerDay: 25,
      alertThreshold: 0.8,
      autoSuspend: true,
    },
    budgetUsage: overrides.budgetUsage ?? {
      actionsThisHour: 0,
      costToday: 0,
      lastResetAt: new Date().toISOString(),
    },
  };
}

function assertIsoTimestamp(value: string | undefined, fieldName: string) {
  assert.equal(typeof value, "string", `${fieldName} should be set`);
  assert.equal(Number.isNaN(Date.parse(value as string)), false, `${fieldName} should be an ISO timestamp`);
}

function matchesBudgetUsage(candidate: unknown, expected: IdentityBudgetUsage): boolean {
  if (!candidate || typeof candidate !== "object") {
    return false;
  }

  const direct = candidate as Partial<IdentityBudgetUsage>;
  if (
    direct.actionsThisHour === expected.actionsThisHour &&
    direct.costToday === expected.costToday &&
    direct.lastResetAt === expected.lastResetAt
  ) {
    return true;
  }

  if ("budgetUsage" in direct) {
    return matchesBudgetUsage((direct as { budgetUsage?: unknown }).budgetUsage, expected);
  }

  return false;
}

function stripUndefined<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function createHarness() {
  const IdentityDO = await loadIdentityDOClass();
  const { createTestApp } = await loadTestHelpers();
  const { state, database, kv, putCalls, sqlCalls } = createMockState();
  const { calls: d1Calls, db } = createRecordingD1();
  const bindings = createTestApp({ DB: db }).bindings;
  const identityDO = new IdentityDO(state, bindings);

  return { database, d1Calls, identityDO, kv, putCalls, sqlCalls };
}

test("IdentityDO can be instantiated and exposes the expected lifecycle methods", async () => {
  const { identityDO } = await createHarness();

  assert.ok(identityDO);
  assert.equal(typeof identityDO.create, "function");
  assert.equal(typeof identityDO.get, "function");
  assert.equal(typeof identityDO.update, "function");
  assert.equal(typeof identityDO.suspend, "function");
  assert.equal(typeof identityDO.reactivate, "function");
  assert.equal(typeof identityDO.retire, "function");
  assert.equal(typeof identityDO.delete, "function");
});

test("create() requires sponsorId and sponsorChain", async () => {
  const { identityDO } = await createHarness();

  await assert.rejects(
    async () => identityDO.create(await createStoredIdentity({ sponsorId: "" })),
    /sponsorId is required/i,
  );
  await assert.rejects(
    async () => identityDO.create(await createStoredIdentity({ sponsorChain: [] })),
    /sponsorChain is required/i,
  );
});

test("create() stores the identity in SQLite storage with sponsor and budget fields", async () => {
  const { database, identityDO, sqlCalls } = await createHarness();
  const identity = await createStoredIdentity({
    metadata: { environment: "test", owner: "qa" },
    roles: ["tester", "builder"],
    scopes: ["relayauth:identity:read", "relayauth:identity:update"],
  });

  const created = await identityDO.create(identity);
  const row = database
    .prepare("SELECT data FROM identity_records WHERE id = ?")
    .get(identity.id) as { data: string } | undefined;

  assert.equal(created.id, identity.id);
  assert.equal(created.sponsorId, identity.sponsorId);
  assert.deepEqual(created.sponsorChain, identity.sponsorChain);
  assert.deepEqual(created.budget, identity.budget);
  assert.deepEqual(created.budgetUsage, identity.budgetUsage);
  assert.ok(row, "expected create() to persist a SQLite row for the identity");
  assert.deepEqual(JSON.parse(row.data) as StoredIdentity, stripUndefined(identity));
  assert.equal(
    sqlCalls.some(({ query }) => /\bcreate table\b/i.test(query)),
    true,
    "expected IdentityDO to initialize SQLite schema",
  );
  assert.equal(
    sqlCalls.some(({ query }) => /\b(insert|replace)\b/i.test(query)),
    true,
    "expected IdentityDO.create() to write through ctx.storage.sql",
  );
});

test("create() tracks budgetUsage in durable object storage", async () => {
  const { identityDO, putCalls } = await createHarness();
  const identity = await createStoredIdentity({
    budgetUsage: {
      actionsThisHour: 3,
      costToday: 7.5,
      lastResetAt: new Date().toISOString(),
    },
  });

  await identityDO.create(identity);

  assert.equal(
    putCalls.some(({ value }) => matchesBudgetUsage(value, identity.budgetUsage!)),
    true,
    "expected create() to mirror budget usage into DO storage",
  );
});

test("create() auto-suspends when the initial budget is already exceeded and emits an audit event", async () => {
  const { d1Calls, identityDO } = await createHarness();
  const identity = await createStoredIdentity({
    status: "active",
    budget: {
      maxActionsPerHour: 2,
      maxCostPerDay: 10,
      alertThreshold: 0.75,
      autoSuspend: true,
    },
    budgetUsage: {
      actionsThisHour: 3,
      costToday: 1,
      lastResetAt: new Date().toISOString(),
    },
  });

  const created = await identityDO.create(identity);

  assert.equal(created.status, "suspended");
  assert.equal(created.suspendReason, "budget_exceeded");
  assertIsoTimestamp(created.suspendedAt, "suspendedAt");
  assert.equal(
    d1Calls.some(({ query, params }) =>
      /audit/i.test(query) ||
      /budget\.exceeded|identity\.suspended|budget_exceeded/i.test(JSON.stringify(params)),
    ),
    true,
    "expected over-budget creation to generate an audit event write",
  );
});

test("get(id) returns null for a non-existent identity", async () => {
  const { identityDO } = await createHarness();
  const getById = identityDO as typeof identityDO & { get(id: string): Promise<StoredIdentity | null> };

  assert.equal(await getById.get("identity_missing"), null);
});

test("get(id) returns the stored identity", async () => {
  const { identityDO } = await createHarness();
  const identity = await createStoredIdentity();
  const getById = identityDO as typeof identityDO & { get(id: string): Promise<StoredIdentity | null> };

  await identityDO.create(identity);

  assert.deepEqual(await getById.get(identity.id), stripUndefined(identity));
});

test("update() merges metadata, replaces scopes, and refreshes updatedAt", async () => {
  const { identityDO } = await createHarness();
  const identity = await createStoredIdentity({
    metadata: { owner: "qa", region: "eu" },
    scopes: ["relayauth:identity:read"],
  });

  await identityDO.create(identity);
  await new Promise((resolve) => setTimeout(resolve, 5));

  const updated = await identityDO.update({
    metadata: { owner: "ops", tier: "gold" },
    scopes: ["relayauth:identity:read", "relayauth:identity:update"],
  });

  assert.deepEqual(updated.metadata, { owner: "ops", region: "eu", tier: "gold" });
  assert.deepEqual(updated.scopes, ["relayauth:identity:read", "relayauth:identity:update"]);
  assert.notEqual(updated.updatedAt, identity.updatedAt);
  assert.equal(Date.parse(updated.updatedAt) >= Date.parse(identity.updatedAt), true);
});

test('suspend() sets status to "suspended", records reason, and timestamps the change', async () => {
  const { identityDO } = await createHarness();

  await identityDO.create(await createStoredIdentity());
  const suspended = await identityDO.suspend("budget_exceeded");

  assert.equal(suspended.status, "suspended");
  assert.equal(suspended.suspendReason, "budget_exceeded");
  assertIsoTimestamp(suspended.suspendedAt, "suspendedAt");
  assertIsoTimestamp(suspended.updatedAt, "updatedAt");
});

test('reactivate() sets status back to "active" and clears suspension fields', async () => {
  const { identityDO } = await createHarness();

  await identityDO.create(await createStoredIdentity());
  await identityDO.suspend("manual_review");
  const reactivated = await identityDO.reactivate();

  assert.equal(reactivated.status, "active");
  assert.equal(reactivated.suspendReason, undefined);
  assert.equal(reactivated.suspendedAt, undefined);
  assertIsoTimestamp(reactivated.updatedAt, "updatedAt");
});

test('retire() sets status to "retired" and prevents later reactivation', async () => {
  const { identityDO } = await createHarness();

  await identityDO.create(await createStoredIdentity());
  const retired = await identityDO.retire();

  assert.equal(retired.status, "retired");
  await assert.rejects(() => identityDO.reactivate(), /retired|reactivate|permanent/i);
});

test("delete() removes the identity from storage", async () => {
  const { identityDO, sqlCalls } = await createHarness();

  await identityDO.create(await createStoredIdentity());
  await identityDO.delete();

  assert.equal(await identityDO.get(), null);
  assert.equal(
    sqlCalls.some(({ query }) => /\bdelete\b/i.test(query)),
    true,
    "expected IdentityDO.delete() to remove the row through ctx.storage.sql",
  );
});

test("update() auto-suspends when budget usage exceeds the configured limit and emits an audit event", async () => {
  const { d1Calls, identityDO } = await createHarness();

  await identityDO.create(
    await createStoredIdentity({
      budget: {
        maxActionsPerHour: 3,
        maxCostPerDay: 20,
        alertThreshold: 0.75,
        autoSuspend: true,
      },
      budgetUsage: {
        actionsThisHour: 2,
        costToday: 5,
        lastResetAt: new Date().toISOString(),
      },
    }),
  );

  const updated = await identityDO.update({
    budgetUsage: {
      actionsThisHour: 4,
      costToday: 5,
      lastResetAt: new Date().toISOString(),
    },
  });

  assert.equal(updated.status, "suspended");
  assert.equal(updated.suspendReason, "budget_exceeded");
  assertIsoTimestamp(updated.suspendedAt, "suspendedAt");
  assert.equal(
    d1Calls.some(({ query, params }) =>
      /audit/i.test(query) ||
      /budget\.exceeded|identity\.suspended|budget_exceeded/i.test(JSON.stringify(params)),
    ),
    true,
    "expected a budget breach to generate an audit event write",
  );
});
