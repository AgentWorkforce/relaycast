import {
  diagnoseListTreePathRange,
  listTree,
  queryFiles,
} from "../src/durable-objects/handlers/fs.js";
import { RUNTIME_FILES } from "../src/durable-objects/runtime-files.js";
import type { TokenClaims } from "../src/middleware/auth.js";

const RUNTIME_PATHS = RUNTIME_FILES.map((file) => file.path);

type QueryCall = {
  sql: string;
  bindings: unknown[];
};

type StoredFile = {
  path: string;
  revision: string;
  contentType: string;
  contentRef: string;
  size: number;
  encoding: "utf-8" | "base64";
  updatedAt: string;
  semanticsJson: string;
  provider: string;
  providerObjectId: string;
  contentHash: string;
};

type FileRow = {
  path: string;
  revision: string;
  content_type: string;
  content_ref: string;
  size: number;
  encoding: "utf-8" | "base64";
  updated_at: string;
  semantics_json: string;
  provider: string;
  provider_object_id: string;
  content_hash: string;
};

function createContext(files: StoredFile[]) {
  const calls: QueryCall[] = [];

  const rows: FileRow[] = files.map((file) => ({
    path: file.path,
    revision: file.revision,
    content_type: file.contentType,
    content_ref: file.contentRef,
    size: file.size,
    encoding: file.encoding,
    updated_at: file.updatedAt,
    semantics_json: file.semanticsJson,
    provider: file.provider,
    provider_object_id: file.providerObjectId,
    content_hash: "",
  }));

  const context = {
    calls,
    allRows<T>(sql: string, ...bindings: unknown[]): T[] {
      calls.push({ sql, bindings });
      if (sql.includes("COUNT(*)") && bindings.length >= 3) {
        const [base, lower, upper] = bindings as [string, string, string];
        return [
          {
            count: rows.filter(
              (row) =>
                row.path === base || (row.path >= lower && row.path < upper),
            ).length,
          },
        ] as T[];
      }
      if (bindings.length >= 4) {
        const [base, lower, upper] = bindings as [string, string, string];
        const hasCursor = bindings.length === 5;
        const cursor = hasCursor ? String(bindings[3]) : null;
        const limit = Number(bindings[hasCursor ? 4 : 3]);
        return rows
          .filter(
            (row) =>
              row.path === base || (row.path >= lower && row.path < upper),
          )
          .filter((row) => (cursor ? row.path > cursor : true))
          .slice(0, limit) as T[];
      }
      if (bindings.length === 1 && typeof bindings[0] === "number") {
        return rows.slice(0, bindings[0]) as T[];
      }
      return rows as T[];
    },
    getFileRow(path: string): StoredFile | null {
      return files.find((file) => file.path === path) ?? null;
    },
    toWorkspaceFile(row: FileRow): StoredFile {
      return {
        path: row.path,
        revision: row.revision,
        contentType: row.content_type,
        contentRef: row.content_ref,
        size: row.size,
        encoding: row.encoding,
        updatedAt: row.updated_at,
        semanticsJson: row.semantics_json,
        provider: row.provider,
        providerObjectId: row.provider_object_id,
        contentHash: row.content_hash,
      };
    },
  };

  return context;
}

function storedFile(path: string): StoredFile {
  return {
    path,
    revision: "rev_1",
    contentType: path.endsWith(".json") ? "application/json" : "text/markdown",
    contentRef: `content:${path}`,
    size: 10,
    encoding: "utf-8",
    updatedAt: "2026-04-17T00:00:00.000Z",
    semanticsJson: "{}",
    provider: "notion",
    providerObjectId: path,
    contentHash: "",
  };
}

function aclProtectedFile(path: string): StoredFile {
  return {
    ...storedFile(path),
    semanticsJson: JSON.stringify({ permissions: ["scope:finance"] }),
  };
}

function workspaceAclFile(path: string, permissions: string[]): StoredFile {
  return {
    ...storedFile(path),
    contentType: "text/plain",
    semanticsJson: JSON.stringify({ permissions }),
  };
}

function claimsWith(scopes: string[]): TokenClaims {
  return {
    workspaceId: "ws_123",
    agentName: "agent_test",
    scopes: new Set(scopes),
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
}

describe("filesystem path range scans", () => {
  it("lists deep Notion database children without LIKE or GLOB patterns", () => {
    const databasePath =
      "/notion/databases/2f86800c-1c90-80e2-a8ec-f2211a6ccd4a";
    const context = createContext([
      storedFile(`${databasePath}/metadata.json`),
      storedFile(`${databasePath}/pages/page-1.json`),
      storedFile(`${databasePath}/pages/page-1/content.md`),
      storedFile(`${databasePath}-sibling/metadata.json`),
    ]);

    const response = listTree(
      context as never,
      "ws_123",
      databasePath,
      1,
      null,
      null,
    );

    const scopedQuery = context.calls[0];
    expect(scopedQuery.sql).toContain("path >= ?");
    expect(scopedQuery.sql).not.toMatch(/\b(?:LIKE|GLOB)\b/);
    // Trailing binding is the SQL LIMIT (MAX_LIST_ROWS = 1000), added by
    // the workspace-DO OOM fix so subtree pre-scans can never materialize
    // more than MAX_LIST_ROWS file rows into the isolate at once.
    expect(scopedQuery.bindings).toEqual([
      databasePath,
      `${databasePath}/`,
      `${databasePath}0`,
      1000,
    ]);
    expect(response.entries.map((entry) => entry.path)).toEqual([
      `${databasePath}/metadata.json`,
      `${databasePath}/pages`,
    ]);
  });

  it("queries the root subtree with a bounded slash range", () => {
    const context = createContext([
      storedFile("/notion/databases/db-1/metadata.json"),
      storedFile("/github/repos/acme/repo/metadata.json"),
    ]);

    queryFiles(
      context as never,
      "ws_123",
      { pathPrefix: "/", limit: 10 },
      null,
    );

    const scopedQuery = context.calls[0];
    expect(scopedQuery.sql).toContain("path < ?");
    expect(scopedQuery.sql).not.toMatch(/\b(?:LIKE|GLOB)\b/);
    expect(scopedQuery.bindings).toEqual(["/", "/", "0", 1000]);
  });

  it("includes the runtime skill file in query results", () => {
    const context = createContext([]);

    const root = queryFiles(
      context as never,
      "ws_123",
      { pathPrefix: "/", limit: 10 },
      null,
    );
    const skills = queryFiles(
      context as never,
      "ws_123",
      { pathPrefix: "/.skills", provider: "runtime", limit: 10 },
      null,
    );

    expect(root.items.map((entry) => entry.path)).toContain(
      "/.skills/activity-summary.md",
    );
    expect(skills.items.map((entry) => entry.path)).toEqual(RUNTIME_PATHS);
    expect(skills.items[0]?.provider).toBe("runtime");
  });

  it("tree and query are scoped before the MAX_LIST_ROWS cap is applied", () => {
    const latePath = "/zz-target/file.md";
    const context = createContext([
      ...Array.from({ length: 1001 }, (_, i) =>
        storedFile(`/aa-earlier/${String(i).padStart(4, "0")}.md`),
      ),
      storedFile(latePath),
    ]);

    const tree = listTree(
      context as never,
      "ws_123",
      "/zz-target",
      1,
      null,
      null,
    );
    const query = queryFiles(
      context as never,
      "ws_123",
      { pathPrefix: "/zz-target", limit: 10 },
      null,
    );

    expect(tree.entries.map((entry) => entry.path)).toEqual([latePath]);
    expect(query.items.map((entry) => entry.path)).toEqual([latePath]);
  });

  it("tree pagination reports a cursor instead of completing an over-cap subtree", () => {
    const context = createContext(
      Array.from({ length: 1001 }, (_, i) =>
        storedFile(`/big/${String(i).padStart(4, "0")}.md`),
      ),
    );

    const first = listTree(context as never, "ws_123", "/big", 1, null, null);
    expect(first.entries).toHaveLength(1000);
    expect(first.nextCursor).toBe("/big/0999.md");

    const second = listTree(
      context as never,
      "ws_123",
      "/big",
      1,
      first.nextCursor,
      null,
    );
    expect(second.entries.map((entry) => entry.path)).toEqual(["/big/1000.md"]);
    expect(second.nextCursor).toBeNull();
  });

  it("tree pagination advances by raw file row and does not duplicate synthetic directories", () => {
    const context = createContext([
      ...Array.from({ length: 1001 }, (_, i) =>
        storedFile(`/src/${String(i).padStart(4, "0")}.md`),
      ),
      storedFile("/zzz/final.md"),
    ]);

    const first = listTree(context as never, "ws_123", "/", 1, null, null);
    expect(first.entries.map((entry) => entry.path)).toEqual([
      "/.skills",
      "/src",
    ]);
    expect(first.nextCursor).toBe("/src/0999.md");

    const second = listTree(
      context as never,
      "ws_123",
      "/",
      1,
      first.nextCursor,
      null,
    );
    expect(second.entries.map((entry) => entry.path)).toEqual(["/zzz"]);
    expect(second.nextCursor).toBeNull();
  });

  it("does not return empty continuation pages for shallow github repo trees with many deep files", () => {
    const repoRoot = "/github/repos/AgentWorkforce/cloud";
    const context = createContext([
      ...Array.from({ length: 3000 }, (_, i) =>
        storedFile(
          `${repoRoot}/issues/1555/comments/${String(i).padStart(4, "0")}.json`,
        ),
      ),
      ...Array.from({ length: 2000 }, (_, i) =>
        storedFile(
          `${repoRoot}/pulls/1539/reviews/${String(i).padStart(4, "0")}.json`,
        ),
      ),
    ]);

    const first = listTree(context as never, "ws_123", repoRoot, 2, null, null);
    expect(first.entries.map((entry) => entry.path)).toEqual([
      `${repoRoot}/issues`,
      `${repoRoot}/issues/1555`,
    ]);
    expect(first.nextCursor).toBe(`${repoRoot}/issues/1555/comments/0999.json`);

    const second = listTree(
      context as never,
      "ws_123",
      repoRoot,
      2,
      first.nextCursor,
      null,
    );
    expect(second.entries.map((entry) => entry.path)).toEqual([
      `${repoRoot}/pulls`,
      `${repoRoot}/pulls/1539`,
    ]);
    expect(second.nextCursor).toBe(`${repoRoot}/pulls/1539/reviews/0999.json`);
    expect(second.nextCursor).not.toContain(
      `${repoRoot}/pulls/1539${repoRoot}`,
    );
  });

  it("diagnoses direct file hits against the SQL prefix range used by tree", () => {
    const issueRoot =
      "/github/repos/AgentWorkforce/cloud/issues/1588__e2e-probe";
    const metaPath = `${issueRoot}/meta.json`;
    const context = createContext([
      storedFile(metaPath),
      storedFile(`${issueRoot}/comments/create-comment.json`),
      storedFile("/slack/channels/proj-cloud/messages/1.json"),
    ]);

    expect(context.getFileRow(metaPath)).not.toBeNull();

    const diagnose = (base: string) => {
      const tree = listTree(context as never, "ws_123", base, 2, null, null);
      const diag = diagnoseListTreePathRange(
        context as never,
        "ws_123",
        base,
        2,
        null,
        null,
        tree,
        metaPath,
      );
      expect(diag.directFile).toMatchObject({
        path: metaPath,
        exists: true,
        aclAllowed: true,
      });
      expect(diag.prefix.count).toBe(2);
      expect(diag.prefix.sample.map((row) => row.path)).toEqual([
        metaPath,
        `${issueRoot}/comments/create-comment.json`,
      ]);
      expect(diag.tree.entryCount).toBeGreaterThan(0);
      return diag;
    };

    expect(diagnose("/github").range).toEqual({
      lower: "/github/",
      upper: "/github0",
    });
    expect(
      diagnose("/github/repos/AgentWorkforce/cloud/issues").tree.entryCount,
    ).toBeGreaterThan(0);
    expect(diagnose(issueRoot).tree.entryCount).toBeGreaterThan(0);
  });

  it("does not include ACL-hidden raw rows in the diagnostic prefix sample", () => {
    const context = createContext([
      storedFile(
        "/github/repos/AgentWorkforce/cloud/issues/1588__probe/meta.json",
      ),
      aclProtectedFile(
        "/github/repos/AgentWorkforce/cloud/issues/secret/meta.json",
      ),
    ]);

    const tree = listTree(
      context as never,
      "ws_123",
      "/github/repos/AgentWorkforce/cloud/issues",
      2,
      null,
      null,
    );
    const diag = diagnoseListTreePathRange(
      context as never,
      "ws_123",
      "/github/repos/AgentWorkforce/cloud/issues",
      2,
      null,
      null,
      tree,
      null,
    );

    expect(diag.prefix.count).toBe(2);
    expect(diag.prefix.sample.map((row) => row.path)).toEqual([
      "/github/repos/AgentWorkforce/cloud/issues/1588__probe/meta.json",
    ]);
  });

  it("lists rows allowed by workspace ACL rules and path-scoped relayfile read tokens", () => {
    const repoRoot = "/github/repos/AgentWorkforce/cloud";
    const issueRoot = `${repoRoot}/issues/1593`;
    const commentPath = `${issueRoot}/comments/create-comment.json`;
    const claims = claimsWith(["relayfile:fs:read:/github/*"]);
    const context = createContext([
      workspaceAclFile("/.relayfile.acl", [
        "allow:scope:workspace:agent_test:read:*",
        "allow:scope:workspace:agent_test:write:*",
        "deny:scope:workspace:agent_test:read:/secrets/*",
        "deny:scope:workspace:agent_test:write:/secrets/*",
      ]),
      storedFile(commentPath),
    ]);

    const tree = listTree(
      context as never,
      "ws_123",
      issueRoot,
      2,
      null,
      claims,
    );
    const diag = diagnoseListTreePathRange(
      context as never,
      "ws_123",
      issueRoot,
      2,
      null,
      claims,
      tree,
      commentPath,
    );

    expect(diag.prefix.count).toBe(1);
    expect(diag.prefix.sample).toMatchObject([
      { path: commentPath, aclAllowed: true },
    ]);
    expect(
      queryFiles(
        context as never,
        "ws_123",
        { pathPrefix: repoRoot },
        claims,
      ).items.map((entry) => entry.path),
    ).toEqual([commentPath]);
    expect(tree.entries.map((entry) => entry.path)).toEqual([
      `${issueRoot}/comments`,
      commentPath,
    ]);
  });

  it("does not treat the runtime skill file as a stored-row pagination overflow", () => {
    const context = createContext(
      Array.from({ length: 999 }, (_, i) =>
        storedFile(`/root/${String(i).padStart(4, "0")}.md`),
      ),
    );

    const response = listTree(context as never, "ws_123", "/", 1, null, null);

    expect(response.entries.map((entry) => entry.path)).toEqual([
      "/.skills",
      "/root",
    ]);
    expect(response.nextCursor).toBeNull();
  });

  it("does not skip direct root files when the runtime skill consumes a page slot", () => {
    const context = createContext(
      Array.from({ length: 1000 }, (_, i) =>
        storedFile(`/f${String(i).padStart(4, "0")}.md`),
      ),
    );

    const first = listTree(context as never, "ws_123", "/", 1, null, null);
    expect(first.entries).toHaveLength(1000);
    expect(first.entries[0]?.path).toBe("/.skills");
    expect(first.entries.at(-1)?.path).toBe("/f0998.md");
    expect(first.nextCursor).toBe("/f0998.md");

    const second = listTree(
      context as never,
      "ws_123",
      "/",
      1,
      first.nextCursor,
      null,
    );
    expect(second.entries.map((entry) => entry.path)).toEqual(["/f0999.md"]);
    expect(second.nextCursor).toBeNull();
  });

  it("tree pagination advances by scanned row when only the runtime skill is visible", () => {
    const context = createContext(
      Array.from({ length: 1000 }, (_, i) =>
        aclProtectedFile(`/secret/${String(i).padStart(4, "0")}.md`),
      ),
    );

    const first = listTree(context as never, "ws_123", "/", 2, null, null);

    expect(first.entries.map((entry) => entry.path)).toEqual([
      "/.skills",
      "/.skills/activity-summary.md",
      "/.skills/workspace-layout",
      "/.skills/writeback-as-files",
    ]);
    expect(first.nextCursor).toBe("/secret/0999.md");

    const second = listTree(
      context as never,
      "ws_123",
      "/",
      2,
      first.nextCursor,
      null,
    );
    expect(second.entries).toEqual([]);
    expect(second.nextCursor).toBeNull();
  });

  it("query scans bounded SQL pages until filters match after the first cap", () => {
    const context = createContext([
      ...Array.from({ length: 1000 }, (_, i) =>
        storedFile(`/query/${String(i).padStart(4, "0")}.md`),
      ),
      {
        ...storedFile("/query/target.md"),
        provider: "github",
      },
    ]);

    const result = queryFiles(
      context as never,
      "ws_123",
      { pathPrefix: "/query", provider: "github", limit: 1 },
      null,
    );

    expect(result.items.map((entry) => entry.path)).toEqual([
      "/query/target.md",
    ]);
    expect(context.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("query returns a continuation instead of scanning an entire sparse no-match tree", () => {
    const context = createContext(
      Array.from({ length: 2500 }, (_, i) =>
        storedFile(`/query-sparse/${String(i).padStart(4, "0")}.md`),
      ),
    );

    const result = queryFiles(
      context as never,
      "ws_123",
      { pathPrefix: "/query-sparse", provider: "github", limit: 10 },
      null,
    );

    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBe("/query-sparse/1999.md");
    expect(context.calls).toHaveLength(2);
  });

  it("does not let the runtime skill inflate query pagination", () => {
    const context = createContext(
      Array.from({ length: 999 }, (_, i) =>
        storedFile(`/query-runtime/${String(i).padStart(4, "0")}.md`),
      ),
    );

    const result = queryFiles(
      context as never,
      "ws_123",
      { pathPrefix: "/", provider: "github", limit: 10 },
      null,
    );

    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeNull();
    expect(context.calls).toHaveLength(1);
  });

  it("query pages path-sorted matches without drops or duplicates", () => {
    const context = createContext(
      Array.from({ length: 5 }, (_, i) => ({
        ...storedFile(`/query-pages/${String(i).padStart(4, "0")}.md`),
        provider: "github",
      })),
    );

    const seen: string[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page = queryFiles(
        context as never,
        "ws_123",
        { pathPrefix: "/query-pages", provider: "github", limit: 2, cursor },
        null,
      );
      seen.push(...page.items.map((item) => item.path));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }

    expect(seen).toEqual([
      "/query-pages/0000.md",
      "/query-pages/0001.md",
      "/query-pages/0002.md",
      "/query-pages/0003.md",
      "/query-pages/0004.md",
    ]);
    expect(new Set(seen).size).toBe(seen.length);
  });
});
