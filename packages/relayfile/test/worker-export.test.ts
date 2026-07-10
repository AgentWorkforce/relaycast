import { describe, expect, it, vi } from "vitest";
import { handleExportFromWorker } from "../src/routes/export.js";
import type { Context } from "hono";
import type { AppEnv } from "../src/env.js";

/**
 * Hardening item 1 contract test: the parent-Worker export handler must
 *
 *   (a) page through the DO's metadata-only manifest endpoint, NOT call
 *       any DO endpoint that reads a body, and
 *   (b) read file bodies directly from R2 via the Worker's
 *       `CONTENT_BUCKET` binding.
 *
 * We assert this by:
 *   - stubbing the WorkspaceDO with a fetch handler that responds only to
 *     `/internal/export-manifest` (any other path fails the test),
 *   - stubbing CONTENT_BUCKET.get with a counter,
 *   - asserting the wire output matches what the DO-side streaming
 *     implementation produced (a JSON array of FileReadResponse, in the
 *     same order, with the same fields).
 */

type FileFixture = {
  path: string;
  revision: string;
  contentType: string;
  contentRef: string;
  size: number;
  encoding: "utf-8" | "base64";
  provider: string;
  providerObjectId: string;
  updatedAt: string;
  semanticsJson: string;
  contentHash: string;
  body: string; // text body for utf-8, base64-string for base64 fixtures
};

function makeFixture(overrides: Partial<FileFixture> = {}): FileFixture {
  return {
    path: "/notes/a.md",
    revision: "rev_1",
    contentType: "text/markdown",
    contentRef: "ws_test/notes/a.md@rev_1",
    size: 5,
    encoding: "utf-8",
    provider: "notion",
    providerObjectId: "obj_a",
    updatedAt: "2026-05-06T00:00:00.000Z",
    semanticsJson: "{}",
    contentHash: "deadbeef",
    body: "hello",
    ...overrides,
  };
}

function buildMockEnvAndContext(
  fixtures: FileFixture[],
  format = "json",
  requestUrl = `https://api.relayfile.example/v1/workspaces/ws_test/fs/export?format=${format}`,
  pageSize?: number,
): {
  c: Context<AppEnv>;
  doFetchCalls: {
    url: string;
    method: string;
    body: string | null;
    foreground: boolean;
  }[];
  r2GetCalls: string[];
} {
  const doFetchCalls: {
    url: string;
    method: string;
    body: string | null;
    foreground: boolean;
  }[] = [];
  const r2GetCalls: string[] = [];

  // Build a mock DO stub. Only the manifest endpoint is allowed; anything
  // else MUST fail (proves the Worker never falls back to the DO for body
  // bytes).
  const doStubFetch = async (req: Request): Promise<Response> => {
    const body = req.body ? await req.text() : null;
    doFetchCalls.push({
      url: req.url,
      method: req.method,
      body,
      foreground:
        req.headers.get("X-Relayfile-Admission") === "clone-foreground",
    });
    const url = new URL(req.url);
    if (url.pathname !== "/internal/export-manifest") {
      return new Response(
        JSON.stringify({
          code: "test_failure",
          message: `forbidden DO call from worker export: ${url.pathname}`,
        }),
        { status: 500 },
      );
    }
    const parsed = body
      ? (JSON.parse(body) as {
          afterPath?: string;
          maxBodyBytes?: number;
          pathPrefix?: string;
        })
      : {};
    const afterPath = parsed.afterPath ?? null;
    const pathPrefix = parsed.pathPrefix ?? null;
    const maxBodyBytes =
      typeof parsed.maxBodyBytes === "number"
        ? parsed.maxBodyBytes
        : Number.POSITIVE_INFINITY;
    const visibleFixtures = pathPrefix
      ? fixtures.filter((fixture) => fixture.path.startsWith(`${pathPrefix}/`))
      : fixtures;
    const totalSize = visibleFixtures.reduce(
      (total, fixture) => total + fixture.size,
      0,
    );
    if (afterPath == null && totalSize > maxBodyBytes) {
      return new Response(
        JSON.stringify({
          code: "payload_too_large",
          message:
            `workspace export body is more than ${maxBodyBytes} bytes, ` +
            `which exceeds the export body limit of ${maxBodyBytes}; ` +
            "use the paginated tree/read APIs (GET /fs/tree, GET /fs/file) instead",
        }),
        { status: 413, headers: { "Content-Type": "application/json" } },
      );
    }
    const startIdx =
      afterPath == null
        ? 0
        : visibleFixtures.findIndex((f) => f.path > afterPath);
    const remaining = startIdx === -1 ? [] : visibleFixtures.slice(startIdx);
    // Default: everything in one page (so tests can verify "nextCursor: null").
    // With pageSize set, paginate so multi-page manifest paths (e.g. the clone
    // tar export over thousands of files) are actually exercised.
    const entries = pageSize != null ? remaining.slice(0, pageSize) : remaining;
    const hasMore = pageSize != null && remaining.length > entries.length;
    return new Response(
      JSON.stringify({
        fileCount: visibleFixtures.length,
        entries: entries.map(({ body: _b, ...meta }) => meta),
        nextCursor: hasMore ? entries[entries.length - 1].path : null,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const r2Bucket = {
    get: vi.fn(async (key: string) => {
      r2GetCalls.push(key);
      const fixture = fixtures.find((f) => f.contentRef === key);
      if (!fixture) return null;
      if (fixture.encoding === "utf-8") {
        return {
          text: async () => fixture.body,
          arrayBuffer: async () =>
            new TextEncoder().encode(fixture.body).buffer,
        };
      }
      // base64 fixture: decode and return arrayBuffer
      return {
        text: async () => fixture.body,
        arrayBuffer: async () => {
          const bin = atob(fixture.body);
          const u8 = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i += 1) u8[i] = bin.charCodeAt(i);
          return u8.buffer;
        },
      };
    }),
  };

  const c = {
    env: {
      DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => null,
          }),
        }),
      },
      CONTENT_BUCKET: r2Bucket,
      WORKSPACE_DO: {
        idFromName: () => ({}),
        get: () => ({ fetch: doStubFetch }),
      },
    },
    req: {
      url: requestUrl,
      query: (key: string) =>
        new URL(requestUrl).searchParams.get(key) ?? undefined,
      header: (key: string) =>
        key.toLowerCase() === "x-correlation-id" ? "corr_test" : undefined,
      raw: {
        headers: new Headers({
          "X-Correlation-Id": "corr_test",
          Authorization: "Bearer test",
        }),
      },
    },
    json: (payload: unknown, status?: number) =>
      new Response(JSON.stringify(payload), {
        status: status ?? 200,
        headers: { "Content-Type": "application/json" },
      }),
    get: (_key: string) => undefined,
  } as unknown as Context<AppEnv>;

  return { c, doFetchCalls, r2GetCalls };
}

// Mirrors github-clone-production.ts buildContentPath. The production helper
// is private to @relayfile/core, so this test copy stays narrow and is
// round-trip covered over the hard path cases below.
function githubContentPath(
  owner: string,
  repo: string,
  repoPath: string,
  headSha: string,
): string {
  const encodedRepoPath = repoPath
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedRepoPath}@${encodeURIComponent(headSha)}.json`;
}

function decodeGithubContentPathForTest(
  contentRoot: string,
  path: string,
  headSha: string,
): string | null {
  const prefix = `${contentRoot}/`;
  const suffix = `@${encodeURIComponent(headSha)}.json`;
  if (!path.startsWith(prefix) || !path.endsWith(suffix)) {
    return null;
  }
  return path
    .slice(prefix.length, -suffix.length)
    .split("/")
    .map((segment) => decodeURIComponent(segment))
    .join("/");
}

describe("handleExportFromWorker (parent-Worker streaming export)", () => {
  it("returns a JSON array of FileReadResponse in path order", async () => {
    const fixtures = [
      makeFixture({ path: "/a.md", contentRef: "r/a", body: "alpha" }),
      makeFixture({ path: "/b.md", contentRef: "r/b", body: "beta" }),
    ];
    const { c } = buildMockEnvAndContext(fixtures);

    const res = await handleExportFromWorker(c, "ws_test");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.startsWith("[")).toBe(true);
    expect(text.endsWith("]")).toBe(true);
    const parsed = JSON.parse(text) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(2);
    expect(parsed[0].path).toBe("/a.md");
    expect(parsed[0].content).toBe("alpha");
    expect(parsed[1].path).toBe("/b.md");
    expect(parsed[1].content).toBe("beta");
  });

  it("treats path as the scoped export prefix used by tree/file APIs", async () => {
    const repoRoot = "/github/repos/AgentWorkforce/cloud";
    const fixtures = [
      makeFixture({
        path: `${repoRoot}/issues/1426/comments/4569559529.json`,
        contentRef: "r/github-comment",
        body: '{"body":"review"}',
      }),
      makeFixture({
        path: "/notion/pages/unrelated.json",
        contentRef: "r/notion",
        body: '{"title":"ignore"}',
      }),
    ];
    const { c, doFetchCalls } = buildMockEnvAndContext(
      fixtures,
      "json",
      `https://api.relayfile.example/v1/workspaces/ws_test/fs/export?format=json&path=${encodeURIComponent(repoRoot)}`,
    );

    const res = await handleExportFromWorker(c, "ws_test");
    expect(res.status).toBe(200);
    const parsed = (await res.json()) as Array<Record<string, unknown>>;

    expect(parsed.map((entry) => entry.path)).toEqual([
      `${repoRoot}/issues/1426/comments/4569559529.json`,
    ]);
    const firstManifestBody = JSON.parse(doFetchCalls[0]?.body ?? "{}") as {
      pathPrefix?: string;
    };
    expect(firstManifestBody.pathPrefix).toBe(repoRoot);
  });

  it("falls back to path when pathPrefix is present but empty", async () => {
    const repoRoot = "/github/repos/AgentWorkforce/cloud";
    const fixtures = [
      makeFixture({
        path: `${repoRoot}/pulls/1584/reviews/1.json`,
        contentRef: "r/github-review",
        body: '{"body":"review"}',
      }),
      makeFixture({
        path: "/notion/pages/unrelated.json",
        contentRef: "r/notion",
        body: '{"title":"ignore"}',
      }),
    ];
    const { c, doFetchCalls } = buildMockEnvAndContext(
      fixtures,
      "json",
      `https://api.relayfile.example/v1/workspaces/ws_test/fs/export?format=json&pathPrefix=&path=${encodeURIComponent(repoRoot)}`,
    );

    const res = await handleExportFromWorker(c, "ws_test");
    expect(res.status).toBe(200);
    const parsed = (await res.json()) as Array<Record<string, unknown>>;

    expect(parsed.map((entry) => entry.path)).toEqual([
      `${repoRoot}/pulls/1584/reviews/1.json`,
    ]);
    const firstManifestBody = JSON.parse(doFetchCalls[0]?.body ?? "{}") as {
      pathPrefix?: string;
    };
    expect(firstManifestBody.pathPrefix).toBe(repoRoot);
  });

  it("hydrates runtime activity-summary export entries without reading R2", async () => {
    const fixtures = [
      makeFixture({
        path: "/.skills/activity-summary.md",
        contentRef: "runtime:activity-summary",
        provider: "runtime",
        providerObjectId: "activity-summary",
        body: "",
      }),
    ];
    const { c, r2GetCalls } = buildMockEnvAndContext(fixtures);

    const res = await handleExportFromWorker(c, "ws_test");
    const parsed = JSON.parse(await res.text()) as Array<
      Record<string, unknown>
    >;

    expect(parsed[0]?.path).toBe("/.skills/activity-summary.md");
    expect(parsed[0]?.content).toEqual(expect.any(String));
    expect(parsed[0]?.content).toContain("/digests/today.md");
    expect(r2GetCalls).toEqual([]);
  });

  it("hydrates runtime activity-summary tar entries without reading R2", async () => {
    const fixtures = [
      makeFixture({
        path: "/.skills/activity-summary.md",
        contentRef: "runtime:activity-summary",
        provider: "runtime",
        providerObjectId: "activity-summary",
        body: "",
      }),
    ];
    const { c, r2GetCalls } = buildMockEnvAndContext(fixtures, "tar");

    const res = await handleExportFromWorker(c, "ws_test");
    const tarBytes = await gunzip(new Uint8Array(await res.arrayBuffer()));

    expect(
      readTarTextByName(tarBytes, "workspace/.skills/activity-summary.md"),
    ).toContain("/digests/today.md");
    expect(r2GetCalls).toEqual([]);
  });

  it("normalizes exported semantics to the core FileReadResponse contract", async () => {
    const fixtures = [
      makeFixture({ path: "/empty.md", semanticsJson: "" }),
      makeFixture({
        path: "/normalized.md",
        semanticsJson: JSON.stringify({
          relations: ["z", "a", "z"],
          permissions: ["write", "read", "write"],
          comments: ["two", "one", "two"],
        }),
      }),
    ];
    const { c } = buildMockEnvAndContext(fixtures);

    const res = await handleExportFromWorker(c, "ws_test");
    const parsed = (await res.json()) as Array<Record<string, unknown>>;

    expect(parsed[0].semantics).toEqual({});
    expect(parsed[1].semantics).toEqual({
      relations: ["a", "z"],
      permissions: ["read", "write"],
      comments: ["one", "two"],
    });
  });

  it("preserves base64-encoded file bodies in JSON export", async () => {
    const fixtures = [
      makeFixture({
        path: "/binary.dat",
        contentRef: "r/binary",
        contentType: "application/octet-stream",
        encoding: "base64",
        body: "/w==",
      }),
    ];
    const { c } = buildMockEnvAndContext(fixtures);

    const res = await handleExportFromWorker(c, "ws_test");
    expect(res.status).toBe(200);
    const parsed = (await res.json()) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0].path).toBe("/binary.dat");
    expect(parsed[0].encoding).toBe("base64");
    expect(parsed[0].content).toBe("/w==");
  });

  it("exports a decoded GitHub working-tree tar for only the requested repo subtree", async () => {
    const owner = "acme";
    const repo = "demo";
    const headSha = "abc123@sha";
    const contentRoot = `/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents`;
    const trickyRepoPaths = [
      "packages/core/src/foo.ts",
      "docs/space name.md",
      "unicodé/π.txt",
      "literal@name.json",
      ".github/workflows/ci.yml",
      "deep/a/b/c.ts",
    ];
    const fixtures = [
      ...trickyRepoPaths.map((repoPath, index) =>
        makeFixture({
          path: githubContentPath(owner, repo, repoPath, headSha),
          contentRef: `r/${index}`,
          body: `body-${index}`,
        }),
      ),
      makeFixture({
        path: githubContentPath(
          owner,
          "other-repo",
          "packages/core/src/foo.ts",
          headSha,
        ),
        contentRef: "r/other-repo",
        body: "wrong repo",
      }),
      makeFixture({
        path: githubContentPath(owner, repo, "old.ts", "old-sha"),
        contentRef: "r/old-sha",
        body: "old sha",
      }),
    ];
    const url =
      `https://api.relayfile.example/v1/workspaces/ws_test/fs/export?format=tar` +
      `&pathPrefix=${encodeURIComponent(contentRoot)}` +
      `&decode=github-working-tree` +
      `&headSha=${encodeURIComponent(headSha)}`;
    const { c, doFetchCalls } = buildMockEnvAndContext(fixtures, "tar", url);

    const res = await handleExportFromWorker(c, "ws_test");
    expect(res.status).toBe(200);
    const tarBytes = await gunzip(new Uint8Array(await res.arrayBuffer()));

    expect(readTarNames(tarBytes)).toEqual(trickyRepoPaths);
    expect(readTarTextByName(tarBytes, "packages/core/src/foo.ts")).toBe(
      "body-0",
    );
    expect(readTarTextByName(tarBytes, "old.ts")).toBeNull();
    expect(
      readTarTextByName(
        tarBytes,
        "workspace/github/repos/acme/demo/contents/packages/core/src/foo.ts@abc123%40sha.json",
      ),
    ).toBeNull();
    const firstManifestBody = JSON.parse(doFetchCalls[0]?.body ?? "{}") as {
      pathPrefix?: string;
    };
    expect(firstManifestBody.pathPrefix).toBe(contentRoot);
  });

  it("round-trips the GitHub clone content-path encoder across hard paths", () => {
    const owner = "space owner";
    const repo = "demo@repo";
    const headSha = "abc123@sha";
    const contentRoot = `/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents`;
    const repoPaths = [
      "packages/core/src/foo.ts",
      "docs/space name.md",
      "unicodé/π.txt",
      "literal@name.json",
      ".github/workflows/ci.yml",
      "deep/a/b/c.ts",
    ];

    for (const repoPath of repoPaths) {
      const encoded = githubContentPath(owner, repo, repoPath, headSha);
      expect(
        decodeGithubContentPathForTest(contentRoot, encoded, headSha),
      ).toBe(repoPath);
    }
  });

  it("round-trips binary bytes through decoded GitHub working-tree tar export", async () => {
    const owner = "acme";
    const repo = "demo";
    const headSha = "binary-sha";
    const contentRoot = `/github/repos/${owner}/${repo}/contents`;
    const binaryBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10,
    ]);
    const binaryBody = btoa(String.fromCharCode(...binaryBytes));
    const fixtures = [
      makeFixture({
        path: githubContentPath(owner, repo, "assets/logo.png", headSha),
        contentRef: "r/logo",
        contentType: "image/png",
        encoding: "base64",
        size: binaryBytes.byteLength,
        body: binaryBody,
      }),
    ];
    const url =
      `https://api.relayfile.example/v1/workspaces/ws_test/fs/export?format=tar` +
      `&pathPrefix=${encodeURIComponent(contentRoot)}` +
      `&decode=github-working-tree` +
      `&headSha=${encodeURIComponent(headSha)}`;
    const { c } = buildMockEnvAndContext(fixtures, "tar", url);

    const res = await handleExportFromWorker(c, "ws_test");
    expect(res.status).toBe(200);
    const tarBytes = await gunzip(new Uint8Array(await res.arrayBuffer()));

    expect(readTarBytesByName(tarBytes, "assets/logo.png")).toEqual(
      binaryBytes,
    );
  });

  it("skips decoded GitHub tar entries that would escape the repo tree", async () => {
    const owner = "acme";
    const repo = "demo";
    const headSha = "safe-sha";
    const contentRoot = `/github/repos/${owner}/${repo}/contents`;
    const suffix = `@${encodeURIComponent(headSha)}.json`;
    const fixtures = [
      makeFixture({
        path: `${contentRoot}/safe.ts${suffix}`,
        contentRef: "r/safe",
        body: "safe",
      }),
      makeFixture({
        path: `${contentRoot}/..%2Fescape.ts${suffix}`,
        contentRef: "r/escape",
        body: "escape",
      }),
      makeFixture({
        path: `${contentRoot}/%2Fabsolute.ts${suffix}`,
        contentRef: "r/absolute",
        body: "absolute",
      }),
    ];
    const url =
      `https://api.relayfile.example/v1/workspaces/ws_test/fs/export?format=tar` +
      `&pathPrefix=${encodeURIComponent(contentRoot)}` +
      `&decode=github-working-tree` +
      `&headSha=${encodeURIComponent(headSha)}`;
    const { c, r2GetCalls } = buildMockEnvAndContext(fixtures, "tar", url);

    const res = await handleExportFromWorker(c, "ws_test");
    expect(res.status).toBe(200);
    const tarBytes = await gunzip(new Uint8Array(await res.arrayBuffer()));

    expect(readTarNames(tarBytes)).toEqual(["safe.ts"]);
    expect(r2GetCalls).toEqual(["r/safe"]);
  });

  it("makes ZERO DO body fetches — only the manifest endpoint is called", async () => {
    const fixtures = Array.from({ length: 5 }, (_, i) =>
      makeFixture({
        path: `/f/${i}`,
        contentRef: `r/${i}`,
        body: `body-${i}`,
      }),
    );
    const { c, doFetchCalls, r2GetCalls } = buildMockEnvAndContext(fixtures);

    const res = await handleExportFromWorker(c, "ws_test");
    await res.text();

    // CRITICAL invariant: every DO call hit the metadata-only manifest
    // endpoint, never a body-reading endpoint.
    for (const call of doFetchCalls) {
      const path = new URL(call.url).pathname;
      expect(path).toBe("/internal/export-manifest");
    }
    // CRITICAL invariant: bodies came from R2, not from the DO.
    expect(r2GetCalls).toHaveLength(fixtures.length);
    expect(r2GetCalls).toEqual(fixtures.map((f) => f.contentRef));
  });

  it("forwards the DO's 413 response unchanged when the workspace exceeds the export ceiling", async () => {
    const doStubFetch = async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          code: "payload_too_large",
          message:
            "workspace has 999999 files which exceeds the export limit of 100",
        }),
        { status: 413 },
      );
    const c = {
      env: {
        CONTENT_BUCKET: { get: vi.fn() },
        WORKSPACE_DO: {
          idFromName: () => ({}),
          get: () => ({ fetch: doStubFetch }),
        },
      },
      req: {
        url: "https://api.relayfile.example/v1/workspaces/ws/fs/export",
        query: (key: string) => (key === "format" ? "json" : undefined),
        raw: { headers: new Headers() },
      },
      get: () => undefined,
    } as unknown as Context<AppEnv>;

    const res = await handleExportFromWorker(c, "ws_test");
    expect(res.status).toBe(413);
  });

  it("returns 413 before body streaming when estimated export body bytes exceed the worker limit", async () => {
    const fixtures = [
      makeFixture({ path: "/a.md", contentRef: "r/a", size: 20 }),
      makeFixture({ path: "/b.md", contentRef: "r/b", size: 20 }),
    ];
    const { c, r2GetCalls } = buildMockEnvAndContext(fixtures);
    Object.assign(c.env, { RELAYFILE_MAX_EXPORT_BODY_BYTES: "32" });

    const res = await handleExportFromWorker(c, "ws_test");

    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toMatchObject({
      code: "payload_too_large",
    });
    expect(r2GetCalls).toEqual([]);
  });

  it("passes the worker export body limit to the first manifest request", async () => {
    const fixtures = [makeFixture({ path: "/a.md", contentRef: "r/a" })];
    const { c, doFetchCalls } = buildMockEnvAndContext(fixtures);
    Object.assign(c.env, { RELAYFILE_MAX_EXPORT_BODY_BYTES: "64" });

    const res = await handleExportFromWorker(c, "ws_test");
    await res.text();

    const firstBody = JSON.parse(doFetchCalls[0]?.body ?? "{}") as Record<
      string,
      unknown
    >;
    expect(firstBody.maxBodyBytes).toBe(64);
  });

  it("errors the stream when a later manifest page fails", async () => {
    const fixture = makeFixture({
      path: "/a.md",
      contentRef: "r/a",
      body: "alpha",
    });
    const { body: _body, ...entry } = fixture;
    const r2Get = vi.fn(async () => ({
      text: async () => fixture.body,
      arrayBuffer: async () => new TextEncoder().encode(fixture.body).buffer,
    }));
    const doStubFetch = vi.fn(async (req: Request): Promise<Response> => {
      const parsed = (await req.json()) as { afterPath?: string | null };
      if (parsed.afterPath == null) {
        return new Response(
          JSON.stringify({
            fileCount: 2,
            entries: [entry],
            nextCursor: "/a.md",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          code: "manifest_unavailable",
          message: "second manifest page unavailable",
        }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      );
    });
    const c = {
      env: {
        CONTENT_BUCKET: { get: r2Get },
        WORKSPACE_DO: {
          idFromName: () => ({}),
          get: () => ({ fetch: doStubFetch }),
        },
      },
      req: {
        url: "https://api.relayfile.example/v1/workspaces/ws/fs/export",
        query: (key: string) => (key === "format" ? "json" : undefined),
        raw: { headers: new Headers() },
      },
      get: () => undefined,
    } as unknown as Context<AppEnv>;

    const res = await handleExportFromWorker(c, "ws_test");

    expect(res.status).toBe(200);
    await expect(res.text()).rejects.toThrow(
      "export manifest paging failed with status 503",
    );
    expect(r2Get).toHaveBeenCalledTimes(1);
    expect(doStubFetch).toHaveBeenCalledTimes(2);
  });

  it("returns 400 on unknown export format without touching the DO", async () => {
    const doStubFetch = vi.fn();
    const c = {
      env: {
        CONTENT_BUCKET: { get: vi.fn() },
        WORKSPACE_DO: {
          idFromName: () => ({}),
          get: () => ({ fetch: doStubFetch }),
        },
      },
      req: {
        url: "https://api.relayfile.example/v1/workspaces/ws/fs/export?format=xml",
        query: (key: string) => (key === "format" ? "xml" : undefined),
        raw: { headers: new Headers() },
      },
      json: (payload: unknown, status: number) =>
        new Response(JSON.stringify(payload), { status }),
      get: () => undefined,
    } as unknown as Context<AppEnv>;
    const res = await handleExportFromWorker(c, "ws_test");
    expect(res.status).toBe(400);
    expect(doStubFetch).not.toHaveBeenCalled();
  });

  it("errors the export stream when a manifest body is missing from R2", async () => {
    const fixtures = [
      makeFixture({ path: "/missing.md", contentRef: "r/missing" }),
    ];
    const { c } = buildMockEnvAndContext(fixtures);
    (c.env.CONTENT_BUCKET.get as ReturnType<typeof vi.fn>).mockResolvedValue(
      null,
    );

    const res = await handleExportFromWorker(c, "ws_test");
    await expect(res.text()).rejects.toThrow("export content missing from R2");
  });

  it("does not read file bodies before the response reader pulls", async () => {
    const fixtures = Array.from({ length: 3 }, (_, i) =>
      makeFixture({
        path: `/f/${i}`,
        contentRef: `r/${i}`,
        body: `body-${i}`,
      }),
    );
    const { c, r2GetCalls } = buildMockEnvAndContext(fixtures);
    const res = await handleExportFromWorker(c, "ws_test");

    expect(r2GetCalls).toEqual([]);

    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("[");
    await reader.cancel();
  });

  it("rejects traversal-capable tar member names", async () => {
    const fixtures = [
      makeFixture({ path: "/../../evil.txt", contentRef: "r/evil" }),
    ];
    const { c } = buildMockEnvAndContext(fixtures, "tar");

    const res = await handleExportFromWorker(c, "ws_test");
    await expect(res.arrayBuffer()).rejects.toThrow("unsafe tar entry path");
  });

  it("escapes patch paths so stored newlines cannot forge file headers", async () => {
    const fixtures = [
      makeFixture({
        path: "/safe.md\n--- /etc/evil\n+++ /etc/evil\n@@",
        contentRef: "r/safe",
        body: "line\n--- /etc/body\n@@",
      }),
    ];
    const { c } = buildMockEnvAndContext(fixtures, "patch");

    const res = await handleExportFromWorker(c, "ws_test");
    const patch = await res.text();

    expect(patch).not.toContain("\n--- /etc/evil");
    expect(patch).not.toContain("\n+++ /etc/evil");
    expect(patch).toContain('--- "/safe.md\\n--- /etc/evil');
    expect(patch).toContain("+--- /etc/body");
  });

  it("writes distinct ustar names for long paths sharing the first 100 bytes", async () => {
    const commonDir = `/deep/${"a".repeat(90)}`;
    const fixtures = [
      makeFixture({
        path: `${commonDir}/one.md`,
        contentRef: "r/one",
        body: "one",
      }),
      makeFixture({
        path: `${commonDir}/two.md`,
        contentRef: "r/two",
        body: "two",
      }),
    ];
    const { c } = buildMockEnvAndContext(fixtures, "tar");

    const res = await handleExportFromWorker(c, "ws_test");
    const tarBytes = await gunzip(new Uint8Array(await res.arrayBuffer()));
    const names = readTarNames(tarBytes);

    expect(names).toEqual([
      `workspace${commonDir}/one.md`,
      `workspace${commonDir}/two.md`,
    ]);
  });

  it("writes numeric tar mtime when updatedAt is unparseable", async () => {
    const fixtures = [
      makeFixture({
        path: "/bad-time.md",
        contentRef: "r/bad-time",
        updatedAt: "not-a-date",
      }),
    ];
    const { c } = buildMockEnvAndContext(fixtures, "tar");

    const res = await handleExportFromWorker(c, "ws_test");
    const tarBytes = await gunzip(new Uint8Array(await res.arrayBuffer()));
    const mtime = readTarString(new TextDecoder(), tarBytes, 136, 12);

    expect(mtime).toMatch(/^[0-7]+$/);
    expect(mtime).not.toContain("NaN");
  });

  it("tar export uses its own body ceiling, not the buffered-export limit (#1250)", async () => {
    // Streaming tar reads bodies one-at-a-time, so it must use the higher tar
    // ceiling and NOT 413 on a total that would reject a buffered json export.
    const fixtures = [
      makeFixture({ path: "/a.md", contentRef: "r/a", size: 20 }),
      makeFixture({ path: "/b.md", contentRef: "r/b", size: 20 }),
    ];
    const { c, doFetchCalls } = buildMockEnvAndContext(
      fixtures,
      "tar",
      "https://api.relayfile.example/v1/workspaces/ws_test/fs/export?format=tar&gzip=0",
    );
    Object.assign(c.env, {
      RELAYFILE_MAX_EXPORT_BODY_BYTES: "32", // would 413 a json export (40 > 32)
      RELAYFILE_MAX_EXPORT_TAR_BODY_BYTES: "1000000",
    });

    const res = await handleExportFromWorker(c, "ws_test");
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    const firstBody = JSON.parse(doFetchCalls[0]?.body ?? "{}") as Record<
      string,
      unknown
    >;
    expect(firstBody.maxBodyBytes).toBe(1000000);
  });

  it("tar export defaults to a multi-GiB body ceiling when unset (#1250)", async () => {
    const fixtures = [makeFixture({ path: "/a.md", contentRef: "r/a" })];
    const { c, doFetchCalls } = buildMockEnvAndContext(
      fixtures,
      "tar",
      "https://api.relayfile.example/v1/workspaces/ws_test/fs/export?format=tar&gzip=0",
    );

    const res = await handleExportFromWorker(c, "ws_test");
    await res.arrayBuffer();
    const firstBody = JSON.parse(doFetchCalls[0]?.body ?? "{}") as Record<
      string,
      unknown
    >;
    expect(firstBody.maxBodyBytes).toBe(4 * 1024 * 1024 * 1024);
  });

  it("gzip=0 streams a raw uncompressed tar; default tar stays gzipped (#1250)", async () => {
    const fixtures = [
      makeFixture({ path: "/notes/a.md", contentRef: "r/a", body: "hello" }),
    ];

    const raw = buildMockEnvAndContext(
      fixtures,
      "tar",
      "https://api.relayfile.example/v1/workspaces/ws_test/fs/export?format=tar&gzip=0",
    );
    const rawRes = await handleExportFromWorker(raw.c, "ws_test");
    expect(rawRes.headers.get("Content-Type")).toBe("application/x-tar");
    const rawBytes = new Uint8Array(await rawRes.arrayBuffer());
    // Raw tar begins with the first entry's header (readable name), not the
    // gzip magic byte 0x1f.
    expect(rawBytes[0]).not.toBe(0x1f);
    expect(readTarString(new TextDecoder(), rawBytes, 0, 100)).toContain(
      "notes/a.md",
    );

    const gz = buildMockEnvAndContext(
      fixtures,
      "tar",
      "https://api.relayfile.example/v1/workspaces/ws_test/fs/export?format=tar",
    );
    const gzRes = await handleExportFromWorker(gz.c, "ws_test");
    expect(gzRes.headers.get("Content-Type")).toBe("application/gzip");
    const gzBytes = new Uint8Array(await gzRes.arrayBuffer());
    expect(gzBytes[0]).toBe(0x1f); // gzip magic
    expect(gzBytes[1]).toBe(0x8b);
  });

  it("streams decoded GitHub working tree exports from an R2 base snapshot without touching the WorkspaceDO", async () => {
    const manifestRef =
      "workspaces/ws_test/bases/github/repos/octo/demo/abc123/manifest.v1.ndjson";
    const blobA = "immutable/github/blobs/sha256/aa/".padEnd(97, "a");
    const blobB = "immutable/github/blobs/sha256/bb/".padEnd(97, "b");
    const entries = [
      {
        path: githubContentPath("octo", "demo", "README.md", "abc123"),
        repoPath: "README.md",
        contentHash: "a".repeat(64),
        blobRef: blobA,
        size: 7,
        encoding: "utf-8",
        contentType: "text/markdown; charset=utf-8",
        headSha: "abc123",
        updatedAt: "2026-05-27T00:00:00.000Z",
        mode: 0o644,
      },
      {
        path: githubContentPath("octo", "demo", "src/app.ts", "abc123"),
        repoPath: "src/app.ts",
        contentHash: "b".repeat(64),
        blobRef: blobB,
        size: 20,
        encoding: "utf-8",
        contentType: "text/plain; charset=utf-8",
        headSha: "abc123",
        updatedAt: "2026-05-27T00:00:00.000Z",
        mode: 0o644,
      },
    ];
    const doFetch = vi.fn(async () => {
      throw new Error(
        "WorkspaceDO should not be touched for base snapshot export",
      );
    });
    const r2Get = vi.fn(async (key: string) => {
      if (key === manifestRef) {
        return {
          text: async () =>
            `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
        };
      }
      const body = key === blobA ? "# Demo\n" : "export const ok = 1;\n";
      return {
        arrayBuffer: async () => new TextEncoder().encode(body).buffer,
      };
    });
    const requestUrl =
      "https://api.relayfile.example/v1/workspaces/ws_test/fs/export" +
      "?format=tar&decode=github-working-tree" +
      "&pathPrefix=%2Fgithub%2Frepos%2Focto%2Fdemo%2Fcontents" +
      "&headSha=abc123&gzip=0";
    const c = {
      env: {
        DB: {
          prepare: () => ({
            bind: () => ({
              first: async () => ({
                workspace_id: "ws_test",
                owner: "octo",
                repo: "demo",
                head_sha: "abc123",
                content_root: "/github/repos/octo/demo/contents",
                manifest_ref: manifestRef,
                file_count: 2,
                bytes: 27,
                current: 1,
                created_at: "2026-05-27T00:00:00.000Z",
                updated_at: "2026-05-27T00:00:00.000Z",
              }),
            }),
          }),
        },
        CONTENT_BUCKET: { get: r2Get },
        WORKSPACE_DO: {
          idFromName: () => ({}),
          get: () => ({ fetch: doFetch }),
        },
        RELAYFILE_GITHUB_BASE_SNAPSHOT_WORKSPACES: "ws_test",
      },
      req: {
        url: requestUrl,
        query: (key: string) =>
          new URL(requestUrl).searchParams.get(key) ?? undefined,
        raw: { headers: new Headers({ Authorization: "Bearer test" }) },
      },
      json: (payload: unknown, status?: number) =>
        new Response(JSON.stringify(payload), { status: status ?? 200 }),
      get: () => undefined,
    } as unknown as Context<AppEnv>;

    const res = await handleExportFromWorker(c, "ws_test");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/x-tar");
    const tarBytes = new Uint8Array(await res.arrayBuffer());
    expect(readTarString(new TextDecoder(), tarBytes, 0, 100)).toContain(
      "README.md",
    );
    const secondOffset = 512 + 7 + (512 - (7 % 512));
    expect(
      readTarString(new TextDecoder(), tarBytes, secondOffset, 100),
    ).toContain("src/app.ts");
    expect(doFetch).not.toHaveBeenCalled();
    expect(r2Get).toHaveBeenCalledWith(manifestRef);
    expect(r2Get).toHaveBeenCalledWith(blobA);
    expect(r2Get).toHaveBeenCalledWith(blobB);
  });

  it("uses the legacy manifest path for gated GitHub base exports unless gzip=0 is requested", async () => {
    const manifestRef =
      "workspaces/ws_test/bases/github/repos/octo/demo/abc123/manifest.v1.ndjson";
    const fixture = makeFixture({
      path: githubContentPath("octo", "demo", "README.md", "abc123"),
      contentRef: "legacy/r2/readme",
      body: "# Legacy\n",
      size: 9,
    });
    const requestUrl =
      "https://api.relayfile.example/v1/workspaces/ws_test/fs/export" +
      "?format=tar&decode=github-working-tree" +
      "&pathPrefix=%2Fgithub%2Frepos%2Focto%2Fdemo%2Fcontents" +
      "&headSha=abc123";
    const built = buildMockEnvAndContext([fixture], "tar", requestUrl);
    Object.assign(built.c.env, {
      DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => ({
              workspace_id: "ws_test",
              owner: "octo",
              repo: "demo",
              head_sha: "abc123",
              content_root: "/github/repos/octo/demo/contents",
              manifest_ref: manifestRef,
              file_count: 1,
              bytes: 9,
              current: 1,
              created_at: "2026-05-27T00:00:00.000Z",
              updated_at: "2026-05-27T00:00:00.000Z",
            }),
          }),
        }),
      },
      RELAYFILE_GITHUB_BASE_SNAPSHOT_WORKSPACES: "ws_test",
    });

    const res = await handleExportFromWorker(built.c, "ws_test");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/gzip");
    await res.arrayBuffer();
    expect(built.doFetchCalls).toHaveLength(1);
    expect(built.r2GetCalls).toEqual(["legacy/r2/readme"]);
  });

  it("falls back to the WorkspaceDO manifest when a base snapshot manifest is unavailable", async () => {
    const fixture = makeFixture({
      path: githubContentPath("octo", "demo", "README.md", "abc123"),
      contentRef: "legacy/r2/readme",
      body: "# Legacy\n",
      size: 9,
    });
    const requestUrl =
      "https://api.relayfile.example/v1/workspaces/ws_test/fs/export" +
      "?format=tar&decode=github-working-tree" +
      "&pathPrefix=%2Fgithub%2Frepos%2Focto%2Fdemo%2Fcontents" +
      "&headSha=abc123&gzip=0";
    const built = buildMockEnvAndContext([fixture], "tar", requestUrl);
    Object.assign(built.c.env, {
      DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => ({
              workspace_id: "ws_test",
              owner: "octo",
              repo: "demo",
              head_sha: "abc123",
              content_root: "/github/repos/octo/demo/contents",
              manifest_ref: "missing-manifest",
              file_count: 1,
              bytes: 9,
              current: 1,
              created_at: "2026-05-27T00:00:00.000Z",
              updated_at: "2026-05-27T00:00:00.000Z",
            }),
          }),
        }),
      },
      CONTENT_BUCKET: {
        get: vi.fn(async (key: string) => {
          if (key === "missing-manifest") return null;
          return {
            arrayBuffer: async () =>
              new TextEncoder().encode("# Legacy\n").buffer,
            text: async () => "# Legacy\n",
          };
        }),
      },
      RELAYFILE_GITHUB_BASE_SNAPSHOT_WORKSPACES: "ws_test",
    });

    const res = await handleExportFromWorker(built.c, "ws_test");
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    expect(built.doFetchCalls).toHaveLength(1);
  });

  it("DEFAULT gzipped tar keeps the buffered limit — fat repo 413s before gzipping (#1250)", async () => {
    // The higher ceiling is coupled to gzip=0: a default (gzipped) tar must NOT
    // get it, so a fat repo 413s fast instead of raising the limit and then
    // burning CompressionStream CPU on a huge tar.
    const fixtures = [
      makeFixture({ path: "/a.md", contentRef: "r/a", size: 20 }),
      makeFixture({ path: "/b.md", contentRef: "r/b", size: 20 }),
    ];
    const { c, r2GetCalls } = buildMockEnvAndContext(
      fixtures,
      "tar",
      "https://api.relayfile.example/v1/workspaces/ws_test/fs/export?format=tar",
    );
    Object.assign(c.env, {
      RELAYFILE_MAX_EXPORT_BODY_BYTES: "32",
      RELAYFILE_MAX_EXPORT_TAR_BODY_BYTES: "1000000", // must NOT apply to gzipped tar
    });

    const res = await handleExportFromWorker(c, "ws_test");
    expect(res.status).toBe(413);
    expect(r2GetCalls).toEqual([]); // never reached body streaming/gzip
  });

  it("tags the clone-materialize manifest fetch as foreground for the DO admission lane (cloud#1261)", async () => {
    const fixtures = [
      makeFixture({
        path: "/github/repos/acme/api/contents/a.ts@h.json",
        contentRef: "r/a",
        body: "x",
      }),
    ];
    // Clone tar (decode=github-working-tree) → its manifest fetch is tagged
    // foreground so the DO admission reserves a lane (never starved).
    const tar = buildMockEnvAndContext(
      fixtures,
      "tar",
      "https://api.relayfile.example/v1/workspaces/ws_test/fs/export?format=tar&gzip=0&decode=github-working-tree&pathPrefix=/github/repos/acme/api/contents&headSha=h",
    );
    await (await handleExportFromWorker(tar.c, "ws_test")).arrayBuffer();
    const tarManifest = tar.doFetchCalls.find((call) =>
      call.url.includes("/internal/export-manifest"),
    );
    expect(tarManifest?.foreground).toBe(true);

    // A non-clone json export is NOT foreground → gated as background.
    const json = buildMockEnvAndContext(fixtures, "json");
    await (await handleExportFromWorker(json.c, "ws_test")).text();
    const jsonManifest = json.doFetchCalls.find((call) =>
      call.url.includes("/internal/export-manifest"),
    );
    expect(jsonManifest?.foreground).toBe(false);
  });

  it("tags EVERY manifest page foreground for a MULTI-PAGE clone tar export (cloud#1261)", async () => {
    // cloud is thousands of files → the clone tar manifest is multi-page. The
    // foreground tag must survive iterateManifest's recursive page fetches, or
    // pages 2+ revert to the throttled background lane and 429 mid-materialize.
    const fixtures = [
      makeFixture({
        path: "/github/repos/acme/api/contents/a.ts@h.json",
        contentRef: "r/a",
        body: "aaaaa",
      }),
      makeFixture({
        path: "/github/repos/acme/api/contents/b.ts@h.json",
        contentRef: "r/b",
        body: "bbbbb",
      }),
    ];
    const { c, doFetchCalls } = buildMockEnvAndContext(
      fixtures,
      "tar",
      "https://api.relayfile.example/v1/workspaces/ws_test/fs/export?format=tar&gzip=0&decode=github-working-tree&pathPrefix=/github/repos/acme/api/contents&headSha=h",
      1, // pageSize=1 → forces ≥2 manifest pages
    );
    await (await handleExportFromWorker(c, "ws_test")).arrayBuffer();

    const manifestCalls = doFetchCalls.filter((call) =>
      call.url.includes("/internal/export-manifest"),
    );
    expect(manifestCalls.length).toBeGreaterThanOrEqual(2); // genuinely multi-page
    // EVERY page — including the recursive page 2+ — carries the foreground tag.
    expect(manifestCalls.every((call) => call.foreground)).toBe(true);
  });
});

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const stream = new Response(copy.buffer).body!.pipeThrough(
    new DecompressionStream("gzip"),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function readTarNames(bytes: Uint8Array): string[] {
  const decoder = new TextDecoder();
  const names: string[] = [];
  for (let offset = 0; offset + 512 <= bytes.byteLength; ) {
    const block = bytes.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) break;
    const name = readTarString(decoder, block, 0, 100);
    const sizeText = readTarString(decoder, block, 124, 12).trim();
    const size = Number.parseInt(sizeText || "0", 8);
    const prefix = readTarString(decoder, block, 345, 155);
    names.push(prefix ? `${prefix}/${name}` : name);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

function readTarTextByName(
  bytes: Uint8Array,
  targetName: string,
): string | null {
  const decoder = new TextDecoder();
  for (let offset = 0; offset + 512 <= bytes.byteLength; ) {
    const block = bytes.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) break;
    const name = readTarString(decoder, block, 0, 100);
    const sizeText = readTarString(decoder, block, 124, 12).trim();
    const size = Number.parseInt(sizeText || "0", 8);
    const prefix = readTarString(decoder, block, 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const bodyOffset = offset + 512;
    if (fullName === targetName) {
      return decoder.decode(bytes.subarray(bodyOffset, bodyOffset + size));
    }
    offset = bodyOffset + Math.ceil(size / 512) * 512;
  }
  return null;
}

function readTarBytesByName(
  bytes: Uint8Array,
  targetName: string,
): Uint8Array | null {
  const decoder = new TextDecoder();
  for (let offset = 0; offset + 512 <= bytes.byteLength; ) {
    const block = bytes.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) break;
    const name = readTarString(decoder, block, 0, 100);
    const sizeText = readTarString(decoder, block, 124, 12).trim();
    const size = Number.parseInt(sizeText || "0", 8);
    const prefix = readTarString(decoder, block, 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const bodyOffset = offset + 512;
    if (fullName === targetName) {
      return bytes.slice(bodyOffset, bodyOffset + size);
    }
    offset = bodyOffset + Math.ceil(size / 512) * 512;
  }
  return null;
}

function readTarString(
  decoder: TextDecoder,
  block: Uint8Array,
  offset: number,
  length: number,
): string {
  const slice = block.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return decoder.decode(end >= 0 ? slice.subarray(0, end) : slice);
}
