import type { Role } from "@relayauth/types";
import { describe, expect, it } from "vitest";
import { CloudflareRoleStorage } from "../roles.js";

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

function makeRoleRow(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `role_${index}`,
    name: `test-role-${index}`,
    description: `Test role ${index}`,
    scopes: JSON.stringify(["fs:read", "fs:write"]),
    org_id: "org_test",
    workspace_id: null,
    built_in: 0,
    created_at: "2026-03-28T00:00:00.000Z",
    ...overrides,
  };
}

describe("CloudflareRoleStorage", () => {
  it("create() inserts a role and returns it", async () => {
    const db = createMockD1();
    const storage = new CloudflareRoleStorage({ DB: db });

    const role = await storage.create({
      id: "role_1",
      name: "backend-dev",
      description: "Backend developer",
      scopes: ["fs:read", "fs:write"],
      orgId: "org_test",
      builtIn: false,
      createdAt: "2026-03-28T00:00:00.000Z",
    } as Role);

    expect(role.id).toBe("role_1");
    expect(role.name).toBe("backend-dev");
    expect(db._runs.length).toBeGreaterThan(0);
  });

  it("get() returns a role by id", async () => {
    const db = createMockD1();
    db._setNextResult([makeRoleRow(1)]);
    const storage = new CloudflareRoleStorage({ DB: db });

    const role = await storage.get("role_1");
    expect(role).not.toBeNull();
    expect(role!.name).toBe("test-role-1");
  });

  it("get() returns null for non-existent role", async () => {
    const db = createMockD1();
    db._setNextResult([]);
    const storage = new CloudflareRoleStorage({ DB: db });

    const role = await storage.get("role_nonexistent");
    expect(role).toBeNull();
  });

  it("list() filters by orgId", async () => {
    const db = createMockD1();
    db._setNextResult([makeRoleRow(1), makeRoleRow(2)]);
    const storage = new CloudflareRoleStorage({ DB: db });

    const roles = await storage.list("org_test");
    expect(roles.length).toBe(2);
  });

  it("list() filters by orgId and workspaceId", async () => {
    const db = createMockD1();
    db._setNextResult([makeRoleRow(1, { workspace_id: "ws_1" })]);
    const storage = new CloudflareRoleStorage({ DB: db });

    const roles = await storage.list("org_test", { workspaceId: "ws_1" });
    expect(roles.length).toBe(1);
  });

  it("delete() removes a role by id", async () => {
    const db = createMockD1();
    db._setNextResult([makeRoleRow(1)]); // get() finds it first
    const storage = new CloudflareRoleStorage({ DB: db });

    await storage.delete("role_1");
    const deleteSql = db._runs.find((r: any) => r.sql.includes("DELETE"));
    expect(deleteSql).toBeDefined();
  });
});
