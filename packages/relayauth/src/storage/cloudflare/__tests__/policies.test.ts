import type { Policy } from "@relayauth/types";
import { describe, expect, it } from "vitest";
import { CloudflarePolicyStorage } from "../policies.js";

function createMockD1() {
  const runs: Array<{ sql: string; params: unknown[] }> = [];
  let nextResult: unknown[] = [];

  const stmt = {
    bind: (...params: unknown[]) => {
      runs[runs.length - 1].params = params;
      return stmt;
    },
    first: async () => nextResult[0] ?? null,
    all: async () => ({ results: nextResult }),
    run: async () => ({ success: true }),
  };

  const db = {
    prepare: (sql: string) => {
      runs.push({ sql, params: [] });
      return stmt;
    },
    _setNextResult: (rows: unknown[]) => { nextResult = rows; },
    _runs: runs,
  };

  return db as any;
}

function makePolicyRow(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `pol_${index}`,
    name: `test-policy-${index}`,
    effect: "allow",
    scopes: JSON.stringify(["fs:read"]),
    conditions: JSON.stringify([{ type: "workspace", operator: "eq", value: "ws_1" }]),
    priority: index * 10,
    org_id: "org_test",
    workspace_id: null,
    created_at: "2026-03-28T00:00:00.000Z",
    ...overrides,
  };
}

describe("CloudflarePolicyStorage", () => {
  it("create() inserts a policy and returns it", async () => {
    const db = createMockD1();
    const storage = new CloudflarePolicyStorage({ DB: db });

    const policy = await storage.create({
      id: "pol_1",
      name: "allow-read",
      effect: "allow",
      scopes: ["fs:read"],
      conditions: [],
      priority: 10,
      orgId: "org_test",
      createdAt: "2026-03-28T00:00:00.000Z",
    } as Policy);

    expect(policy.id).toBe("pol_1");
    expect(policy.name).toBe("allow-read");
    expect(db._runs.length).toBeGreaterThan(0);
  });

  it("get() returns a policy by id", async () => {
    const db = createMockD1();
    db._setNextResult([makePolicyRow(1)]);
    const storage = new CloudflarePolicyStorage({ DB: db });

    const policy = await storage.get("pol_1");
    expect(policy).not.toBeNull();
    expect(policy!.name).toBe("test-policy-1");
    expect(policy!.priority).toBe(10);
  });

  it("get() returns null for non-existent policy", async () => {
    const db = createMockD1();
    db._setNextResult([]);
    const storage = new CloudflarePolicyStorage({ DB: db });

    const policy = await storage.get("pol_nonexistent");
    expect(policy).toBeNull();
  });

  it("list() filters by orgId", async () => {
    const db = createMockD1();
    db._setNextResult([makePolicyRow(1), makePolicyRow(2)]);
    const storage = new CloudflarePolicyStorage({ DB: db });

    const policies = await storage.list("org_test");
    expect(policies.length).toBe(2);
  });

  it("list() filters by orgId and workspaceId", async () => {
    const db = createMockD1();
    db._setNextResult([makePolicyRow(1, { workspace_id: "ws_1" })]);
    const storage = new CloudflarePolicyStorage({ DB: db });

    const policies = await storage.list("org_test", { workspaceId: "ws_1" });
    expect(policies.length).toBe(1);
  });

  it("delete() removes a policy by id", async () => {
    const db = createMockD1();
    db._setNextResult([makePolicyRow(1)]); // get() finds it first
    const storage = new CloudflarePolicyStorage({ DB: db });

    await storage.delete("pol_1");
    // Soft delete uses UPDATE ... SET deleted_at, not DELETE FROM
    const updateSql = db._runs.find((r: any) => r.sql.includes("deleted_at") || r.sql.includes("DELETE"));
    expect(updateSql).toBeDefined();
  });

  it("policies have priority field stored and returned", async () => {
    const db = createMockD1();
    db._setNextResult([makePolicyRow(5, { priority: 50 })]);
    const storage = new CloudflarePolicyStorage({ DB: db });

    const policy = await storage.get("pol_5");
    expect(policy!.priority).toBe(50);
  });
});
