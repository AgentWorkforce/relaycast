import { describe, expect, it, vi } from "vitest";
import {
  envFlagShardingModeResolver,
  fanoutShardNamesForReadPath,
  GITHUB_REPO_SUBSHARDS,
  shardNameForWorkspacePath,
  shardKey,
  ShardedWorkspaceCoordinator,
  type ShardedDoNamespace,
} from "../src/durable-objects/sharding.js";

/**
 * Hardening item 5 — happy-path test for the sharding coordinator
 * skeleton. The skeleton is intentionally narrow: it routes single-
 * provider requests to a per-provider DO stub and surfaces the
 * sharding-mode resolver to the route layer. Cross-provider fan-out is
 * exercised through the merge helper but is not wired into a route.
 */

function makeMockNamespace(): {
  ns: ShardedDoNamespace;
  calls: { workspaceId: string; provider: string; url: string }[];
} {
  const calls: { workspaceId: string; provider: string; url: string }[] = [];
  return {
    calls,
    ns: {
      get: (workspaceId, provider) => ({
        // workerd's typed `fetch` signature is heavily overloaded; for
        // the skeleton test we only need to record the request and
        // return a stub. Cast through `unknown` so the test fixture
        // doesn't have to satisfy every overload variant.
        fetch: (async (req: Request) => {
          calls.push({ workspaceId, provider, url: req.url });
          return new Response(
            JSON.stringify({ workspaceId, provider, ok: true }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }) as unknown as typeof fetch,
      }),
    },
  };
}

describe("shardKey", () => {
  it("composes a stable workspaceId:provider key", () => {
    expect(shardKey("ws_42", "notion")).toBe("ws_42:notion");
  });
});

describe("shardNameForWorkspacePath", () => {
  it.each([
    [
      "/github/repos/AgentWorkforce/cloud/contents/packages/issues/foo.ts@abc.json",
      "github:contents",
    ],
    [
      "/github/repos/AgentWorkforce/cloud/contents/src/pulls/x.ts@abc.json",
      "github:contents",
    ],
    [
      "/github/repos/AgentWorkforce/cloud/issues/1240__slug/meta.json",
      "github:issues",
    ],
    [
      "/github/repos/AgentWorkforce/cloud/pulls/55/comments/c1.json",
      "github:pulls",
    ],
    ["/github/repos/index.json", "github:meta"],
    ["/github/repos/_aliases/by-name/owner__repo/metadata.json", "github:meta"],
    ["/google-mail/threads/19e5ad81fd2c8771.json", "google-mail"],
    ["/google-mail/messages/19e5f736d29da4f1.json", "google-mail"],
    [
      "/GitHub/repos/AgentWorkforce/cloud/issues/1240__slug/meta.json",
      "github:issues",
    ],
    ["/github/other/path.json", "github:meta"],
  ])("routes %s to %s", (path, expected) => {
    expect(shardNameForWorkspacePath(path)).toBe(expected);
  });

  it("returns null for empty or unknown roots so the coordinator owns them", () => {
    expect(shardNameForWorkspacePath("/")).toBeNull();
    expect(shardNameForWorkspacePath("/unknown/path.json")).toBeNull();
  });

  it("fans out whole GitHub repo tree reads across every GitHub sub-shard", () => {
    expect(
      fanoutShardNamesForReadPath("/github/repos/AgentWorkforce/cloud"),
    ).toEqual(GITHUB_REPO_SUBSHARDS);
  });

  it("fans out root reads to non-GitHub providers plus GitHub sub-shards", () => {
    expect(fanoutShardNamesForReadPath("/")).toEqual([
      "confluence",
      "gitlab",
      "google-mail",
      "granola",
      "jira",
      "linear",
      "notion",
      "slack",
      ...GITHUB_REPO_SUBSHARDS,
    ]);
  });

  it("does not fan out once the read path is at GitHub shard granularity", () => {
    expect(
      fanoutShardNamesForReadPath(
        "/github/repos/AgentWorkforce/cloud/contents",
      ),
    ).toEqual([]);
  });
});

describe("envFlagShardingModeResolver", () => {
  it("defaults to monolith when the env var is unset", async () => {
    const resolver = envFlagShardingModeResolver({});
    expect(await resolver.isSharded("ws_anything")).toBe(false);
  });
  it("flips every workspace to sharded when the var is '*'", async () => {
    const resolver = envFlagShardingModeResolver({
      RELAYFILE_SHARDED_WORKSPACE: "*",
    });
    expect(await resolver.isSharded("ws_a")).toBe(true);
    expect(await resolver.isSharded("ws_b")).toBe(true);
  });
  it("honors the per-workspace allowlist CSV", async () => {
    const resolver = envFlagShardingModeResolver({
      RELAYFILE_SHARDED_WORKSPACE: "ws_one,ws_two",
    });
    expect(await resolver.isSharded("ws_one")).toBe(true);
    expect(await resolver.isSharded("ws_two")).toBe(true);
    expect(await resolver.isSharded("ws_three")).toBe(false);
  });
});

describe("ShardedWorkspaceCoordinator", () => {
  it("routes fetchProvider to the right shard (workspaceId, provider) tuple", async () => {
    const { ns, calls } = makeMockNamespace();
    const coord = new ShardedWorkspaceCoordinator(ns, {
      isSharded: async () => true,
    });
    const req = new Request("https://do/fs/tree?path=/notion/", {
      method: "GET",
    });
    const res = await coord.fetchProvider("ws_42", "notion", req);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.workspaceId).toBe("ws_42");
    expect(calls[0]?.provider).toBe("notion");
  });

  it("isSharded delegates to the resolver", async () => {
    const isShardedSpy = vi.fn(async () => true);
    const coord = new ShardedWorkspaceCoordinator(makeMockNamespace().ns, {
      isSharded: isShardedSpy,
    });
    expect(await coord.isSharded("ws_42")).toBe(true);
    expect(isShardedSpy).toHaveBeenCalledWith("ws_42");
  });

  it("mergeProviderManifests fans out to every provider and merges by comparator", async () => {
    const fetchPage = vi.fn(async (provider: string) => {
      // Each provider returns three entries with provider-prefixed paths.
      return {
        entries: [
          { path: `/${provider}/a`, provider },
          { path: `/${provider}/b`, provider },
          { path: `/${provider}/c`, provider },
        ],
        nextCursor: `${provider}-cursor` as string | null,
      };
    });
    const coord = new ShardedWorkspaceCoordinator(makeMockNamespace().ns, {
      isSharded: async () => true,
    });
    const { entries, perProviderCursor } = await coord.mergeProviderManifests({
      workspaceId: "ws_42",
      providers: ["notion", "github"],
      pageSize: 4,
      perProviderCursor: { notion: "notion-in", github: null },
      fetchPage,
      compareEntries: (a, b) =>
        (a as { path: string }).path.localeCompare(
          (b as { path: string }).path,
        ),
    });
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(fetchPage).toHaveBeenCalledWith("notion", "notion-in");
    expect(fetchPage).toHaveBeenCalledWith("github", null);
    // pageSize=4 truncates 6 merged entries.
    expect(entries).toHaveLength(4);
    // Merged in lexicographic path order: /github/a, /github/b, /github/c, /notion/a
    expect(entries.map((e) => (e as { path: string }).path)).toEqual([
      "/github/a",
      "/github/b",
      "/github/c",
      "/notion/a",
    ]);
    expect(perProviderCursor).toEqual({
      notion: "/notion/a",
      github: "github-cursor",
    });
  });

  it("mergeProviderManifests resumes without skipping un-emitted provider entries", async () => {
    const pages: Record<string, Array<{ path: string; provider: string }>> = {
      notion: [
        { path: "/notion/a", provider: "notion" },
        { path: "/notion/b", provider: "notion" },
        { path: "/notion/c", provider: "notion" },
      ],
      github: [
        { path: "/github/a", provider: "github" },
        { path: "/github/b", provider: "github" },
        { path: "/github/c", provider: "github" },
      ],
    };
    const fetchPage = vi.fn(async (provider: string, after: string | null) => {
      const entries = pages[provider].filter((entry) =>
        after ? entry.path > after : true,
      );
      return {
        entries,
        nextCursor: entries.at(-1)?.path ?? null,
      };
    });
    const coord = new ShardedWorkspaceCoordinator(makeMockNamespace().ns, {
      isSharded: async () => true,
    });
    const first = await coord.mergeProviderManifests({
      workspaceId: "ws_42",
      providers: ["notion", "github"],
      pageSize: 4,
      fetchPage,
      compareEntries: (a, b) => a.path.localeCompare(b.path),
    });
    const second = await coord.mergeProviderManifests({
      workspaceId: "ws_42",
      providers: ["notion", "github"],
      pageSize: 4,
      perProviderCursor: first.perProviderCursor,
      fetchPage,
      compareEntries: (a, b) => a.path.localeCompare(b.path),
    });

    expect(
      [...first.entries, ...second.entries].map((entry) => entry.path),
    ).toEqual([
      "/github/a",
      "/github/b",
      "/github/c",
      "/notion/a",
      "/notion/b",
      "/notion/c",
    ]);
  });

  it("mergeProviderManifests does not refetch exhausted providers from the beginning", async () => {
    const pages: Record<string, Array<{ path: string; provider: string }>> = {
      notion: [{ path: "/notion/only", provider: "notion" }],
      github: [
        { path: "/github/a", provider: "github" },
        { path: "/github/b", provider: "github" },
        { path: "/github/c", provider: "github" },
      ],
    };
    const fetchPage = vi.fn(async (provider: string, after: string | null) => {
      const entries = pages[provider].filter((entry) =>
        after ? entry.path > after : true,
      );
      return {
        entries: entries.slice(0, 1),
        nextCursor: entries.length > 1 ? (entries[0]?.path ?? null) : null,
      };
    });
    const coord = new ShardedWorkspaceCoordinator(makeMockNamespace().ns, {
      isSharded: async () => true,
    });

    const first = await coord.mergeProviderManifests({
      workspaceId: "ws_42",
      providers: ["notion", "github"],
      pageSize: 2,
      fetchPage,
      compareEntries: (a, b) => a.path.localeCompare(b.path),
    });
    const second = await coord.mergeProviderManifests({
      workspaceId: "ws_42",
      providers: ["notion", "github"],
      pageSize: 2,
      perProviderCursor: first.perProviderCursor,
      fetchPage,
      compareEntries: (a, b) => a.path.localeCompare(b.path),
    });

    expect(
      [...first.entries, ...second.entries].map((entry) => entry.path),
    ).toEqual(["/github/a", "/notion/only", "/github/b"]);
    expect(
      fetchPage.mock.calls.filter(([provider]) => provider === "notion"),
    ).toHaveLength(1);
  });

  it("end-to-end happy path: single-provider write routes to the provider shard only", async () => {
    const { ns, calls } = makeMockNamespace();
    const coord = new ShardedWorkspaceCoordinator(ns, {
      isSharded: async (id) => id === "ws_sharded",
    });
    expect(await coord.isSharded("ws_sharded")).toBe(true);
    expect(await coord.isSharded("ws_mono")).toBe(false);

    const req = new Request("https://do/write-file?path=/notion/x.md", {
      method: "PUT",
      headers: {
        "If-Match": "0",
        "Content-Type": "application/octet-stream",
        "X-Relayfile-Path": "/notion/x.md",
      },
      body: new TextEncoder().encode("hello"),
    });
    const res = await coord.fetchProvider("ws_sharded", "notion", req);
    expect(res.status).toBe(200);
    // CRITICAL invariant: only ONE provider shard was touched, never
    // the workspace-level monolith.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.provider).toBe("notion");
  });
});
