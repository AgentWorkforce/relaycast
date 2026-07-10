import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  KeysetCursor,
  filesKeysetCursor,
  operationsKeysetCursor,
} from "../src/durable-objects/keyset-cursor.js";

/**
 * Hardening item 3 tests:
 *   - KeysetCursor yields rows page-by-page and stops cleanly at end.
 *   - filesKeysetCursor uses WHERE path > ? on subsequent pages.
 *   - CI grep gate fires on a deliberately unbounded SELECT.
 */

describe("KeysetCursor", () => {
  it("documents KeysetCursor as an opt-in helper, not the enforcement layer", () => {
    const source = readFileSync(
      fileURLToPath(
        new URL("../src/durable-objects/keyset-cursor.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(source).toContain("opt-in helper");
    expect(source).not.toContain("the *enforcement* layer");
    expect(source).not.toContain("exclusively via {@link KeysetCursor}");
  });

  it("iterates over multiple pages and stops when the last page is short", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: i }));
    let callCount = 0;
    const cursor = new KeysetCursor<{ id: number }, number>({
      fetchPage: ({ after, pageSize }) => {
        callCount += 1;
        // pageSize=2: returns 2 rows, then 2, then 1, then done.
        const startIdx = after == null ? 0 : after + 1;
        return rows.slice(startIdx, startIdx + pageSize);
      },
      cursorOf: (row) => row.id,
      pageSize: 2,
    });

    const collected: number[] = [];
    for await (const row of cursor) {
      collected.push(row.id);
    }
    expect(collected).toEqual([0, 1, 2, 3, 4]);
    expect(callCount).toBe(3);
  });

  it("take(N) stops at the limit without draining the cursor", async () => {
    const cursor = new KeysetCursor<{ id: number }, number>({
      fetchPage: ({ after, pageSize }) => {
        const startIdx = after == null ? 0 : after + 1;
        return Array.from({ length: pageSize }, (_, i) => ({
          id: startIdx + i,
        }));
      },
      cursorOf: (row) => row.id,
      pageSize: 100,
    });
    const out = await cursor.take(3);
    expect(out.map((r) => r.id)).toEqual([0, 1, 2]);
  });

  it("take(0) returns empty without fetching a page", async () => {
    const fetchPage = vi.fn(() => [{ id: 1 }]);
    const cursor = new KeysetCursor<{ id: number }, number>({
      fetchPage,
      cursorOf: (row) => row.id,
      pageSize: 2,
    });
    await expect(cursor.take(0)).resolves.toEqual([]);
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("clamps requested page size to 1000 (MAX_PAGE_SIZE)", async () => {
    let observed = 0;
    const cursor = new KeysetCursor<{ id: number }, number>({
      fetchPage: ({ pageSize }) => {
        observed = pageSize;
        return [];
      },
      cursorOf: (row) => row.id,
      pageSize: 1_000_000,
    });
    for await (const _ of cursor) {
      void _;
    }
    expect(observed).toBe(1000);
  });
});

describe("filesKeysetCursor", () => {
  it("emits SQL with ORDER BY path ASC LIMIT ?, and WHERE path > ? on continuation", async () => {
    const calls: { sql: string; bindings: unknown[] }[] = [];
    const allRows = vi.fn((sql: string, ...bindings: unknown[]) => {
      calls.push({ sql, bindings });
      if (calls.length === 1) {
        return [
          { path: "/a", revision: "rev_1" },
          { path: "/b", revision: "rev_2" },
        ];
      }
      return [];
    });
    const cursor = filesKeysetCursor<{ path: string; revision: string }>({
      allRows: allRows as <T>(query: string, ...bindings: unknown[]) => T[],
      toRow: (row) => row as { path: string; revision: string },
      selectColumns: "path, revision",
      pageSize: 2,
    });
    const paths: string[] = [];
    for await (const row of cursor) {
      paths.push(row.path);
    }
    expect(paths).toEqual(["/a", "/b"]);
    expect(calls[0].sql).toMatch(/ORDER BY path ASC/);
    expect(calls[0].sql).toMatch(/LIMIT \?/);
    expect(calls[0].sql).not.toMatch(/WHERE path > \?/);
    expect(calls[1].sql).toMatch(/WHERE path > \?/);
    expect(calls[1].bindings[0]).toBe("/b");
  });
});

describe("operationsKeysetCursor", () => {
  it("orders by op_id DESC and uses WHERE op_id < ? on continuation", async () => {
    const calls: { sql: string; bindings: unknown[] }[] = [];
    const allRows = vi.fn((sql: string, ...bindings: unknown[]) => {
      calls.push({ sql, bindings });
      if (calls.length === 1) {
        return [{ opId: "op_5" }, { opId: "op_4" }];
      }
      return [];
    });
    const cursor = operationsKeysetCursor<{ opId: string }>({
      allRows: allRows as <T>(query: string, ...bindings: unknown[]) => T[],
      toRow: (row) => row as { opId: string },
      selectColumns: "op_id",
      pageSize: 2,
    });
    const ids: string[] = [];
    for await (const row of cursor) {
      ids.push(row.opId);
    }
    expect(ids).toEqual(["op_5", "op_4"]);
    expect(calls[0].sql).toMatch(/ORDER BY op_id DESC/);
    expect(calls[1].sql).toMatch(/WHERE op_id < \?/);
    expect(calls[1].bindings[0]).toBe("op_4");
  });
});

describe("check-do-unbounded-sql CI gate", () => {
  const scriptPath = fileURLToPath(
    new URL("../scripts/check-do-unbounded-sql.mjs", import.meta.url),
  );

  it("exits zero on the current codebase (no unbounded SELECTs)", () => {
    // Run the script — non-zero exit will throw.
    expect(() =>
      execFileSync(process.execPath, [scriptPath], { stdio: "pipe" }),
    ).not.toThrow();
  });

  it("is wired into the repository CI workflow", () => {
    const workflow = readFileSync(
      fileURLToPath(
        new URL("../../../.github/workflows/ci.yml", import.meta.url),
      ),
      "utf8",
    );
    expect(workflow).toContain("check:do-unbounded-sql");
  });

  it("fires on a deliberately unbounded SELECT fixture", () => {
    // Drop a temporary .ts file under durable-objects/ that violates the
    // rule and assert the gate flags it.
    const fixturePath = join(
      fileURLToPath(new URL("../src/durable-objects/", import.meta.url)),
      "__unbounded-fixture-temp.ts",
    );
    writeFileSync(
      fixturePath,
      `export function bad() {
  return \`
    SELECT path FROM files
    ORDER BY path ASC
  \`;
}
`,
      "utf8",
    );
    try {
      let threw = false;
      try {
        execFileSync(process.execPath, [scriptPath], { stdio: "pipe" });
      } catch (err) {
        threw = true;
        const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? "";
        expect(stderr).toContain("SELECT ... FROM files without LIMIT");
      }
      expect(threw).toBe(true);
    } finally {
      unlinkSync(fixturePath);
    }
  });

  it("fires on a path equality plus range-scan fixture without LIMIT", () => {
    const fixturePath = join(
      fileURLToPath(new URL("../src/durable-objects/", import.meta.url)),
      "__unbounded-range-fixture-temp.ts",
    );
    writeFileSync(
      fixturePath,
      `export function badRange() {
  return \`
    SELECT path FROM files
    WHERE path = ? OR (path >= ? AND path < ?)
    ORDER BY path ASC
  \`;
}
`,
      "utf8",
    );
    try {
      let threw = false;
      try {
        execFileSync(process.execPath, [scriptPath], { stdio: "pipe" });
      } catch (err) {
        threw = true;
        const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? "";
        expect(stderr).toContain("SELECT ... FROM files without LIMIT");
      }
      expect(threw).toBe(true);
    } finally {
      unlinkSync(fixturePath);
    }
  });

  it("does not let a later bounded statement mask an earlier unbounded SELECT", () => {
    const fixturePath = join(
      fileURLToPath(new URL("../src/durable-objects/", import.meta.url)),
      "__unbounded-sibling-fixture-temp.ts",
    );
    writeFileSync(
      fixturePath,
      `export function siblingStatements() {
  const bad = \`
    SELECT path FROM files
    ORDER BY path ASC
  \`;
  const good = \`
    SELECT path FROM files
    ORDER BY path ASC
    LIMIT ?
  \`;
  return { bad, good };
}
`,
      "utf8",
    );
    try {
      let threw = false;
      try {
        execFileSync(process.execPath, [scriptPath], { stdio: "pipe" });
      } catch (err) {
        threw = true;
        const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? "";
        expect(stderr).toContain("SELECT ... FROM files without LIMIT");
      }
      expect(threw).toBe(true);
    } finally {
      unlinkSync(fixturePath);
    }
  });
});
