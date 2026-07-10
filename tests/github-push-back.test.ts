import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Nango SDK at module level. Token mint goes through
// `nango.getToken(providerConfigKey, connectionId, false, true)` — the
// 4th arg flips Nango into github-app installation-token mode. Tests
// override per-install behavior by re-implementing `nangoGetTokenMock`.
// The previous shape (`nango.post(...)` to GitHub's
// /app/installations/<id>/access_tokens) returned 401 in prod because
// Nango's proxy doesn't auto-attach the App-level JWT for that path.
const nangoGetTokenMock = vi.hoisted(() => vi.fn());
const nangoProxyMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/integrations/nango-service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/integrations/nango-service")>(
    "@/lib/integrations/nango-service",
  );
  return {
    ...actual,
    getNangoClient: () => ({
      getToken: nangoGetTokenMock,
      proxy: nangoProxyMock,
    }),
  };
});

import { createRelayfileWritebackPgliteDb } from "./helpers/relayfile-writeback-pglite-db.ts";
import {
  installationCanAccessRepo,
  parseUnifiedDiff,
  PushBackError,
  pushWorkflowPathPatch,
  applyHunks,
} from "../packages/web/lib/integrations/github-push-back.ts";
import type { WorkflowRecord } from "../packages/web/lib/workflows.ts";
import type { WorkflowRepositoryAllowlistRecord } from "../packages/web/lib/integrations/workflow-repository-allowlists.ts";

// Default Nango getToken behavior: hand back a token tagged with the
// connectionId so test assertions can tell installs apart. Tests
// override via nangoGetTokenMock.mockImplementation(...).
function defaultNangoGetTokenBehavior(): void {
  nangoGetTokenMock.mockImplementation(async (
    _providerConfigKey: string,
    connectionId: string,
  ) => `ghs_${connectionId}`);
  nangoProxyMock.mockImplementation(async () => ({ status: 200, data: { id: 1 } }));
}

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const RELAY_WORKSPACE_ID = "rw_relay";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "33333333-3333-4333-8333-333333333333";

const addPatch = [
  "diff --git a/new.txt b/new.txt",
  "new file mode 100644",
  "index 0000000..1111111",
  "--- /dev/null",
  "+++ b/new.txt",
  "@@ -0,0 +1,2 @@",
  "+hello",
  "+world",
  "",
].join("\n");

const baseRun: WorkflowRecord = {
  runId: RUN_ID,
  sandboxId: "sandbox_1",
  dispatchType: "sandbox",
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
  workflow: "name: test",
  fileType: "yaml",
  status: "completed",
  callbackToken: "callback",
  createdAt: "2026-04-23T00:00:00.000Z",
  updatedAt: "2026-04-23T00:00:00.000Z",
  paths: [],
};

const allowlist: WorkflowRepositoryAllowlistRecord = {
  workspaceId: WORKSPACE_ID,
  repoOwner: "acme",
  repoName: "cloud",
  installationId: "install_1",
  pushAllowed: true,
  allowedAt: new Date("2026-04-23T00:00:00.000Z"),
  allowedBy: USER_ID,
};

type FetchCall = {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
};

let cleanupDb: (() => Promise<void>) | undefined;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createFetchMock(options: {
  secondBaseSha?: string;
  contentsTooLarge?: boolean;
} = {}) {
  const calls: FetchCall[] = [];
  let baseRefReads = 0;
  const fetchImpl = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
    const urlString = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    calls.push({ url: urlString, init: init ?? {}, body });

    // Token mint goes through the Nango SDK now (mocked at module
    // level via nangoGetTokenMock), not through fetchImpl. So this fetch
    // mock should never see a Nango URL — only direct GitHub API calls.
    if (urlString.includes("api.nango.dev")) {
      throw new Error(`fetchImpl received unexpected Nango URL ${urlString} — token mint should go through the SDK, not raw fetch`);
    }

    const path = new URL(urlString).pathname;
    const method = init?.method ?? "GET";
    if (method === "GET" && path === "/repos/acme/cloud") {
      return jsonResponse({ default_branch: "main" });
    }
    if (method === "GET" && path === "/repos/acme/cloud/git/ref/heads/main") {
      baseRefReads += 1;
      return jsonResponse({
        object: {
          sha: baseRefReads === 2 ? options.secondBaseSha ?? "base-a" : "base-a",
        },
      });
    }
    if (method === "POST" && path === "/repos/acme/cloud/git/refs") {
      return jsonResponse({ ref: body.ref, object: { sha: "base-a" } });
    }
    if (method === "GET" && path === "/repos/acme/cloud/contents/new.txt") {
      return jsonResponse({ message: "Not Found" }, 404);
    }
    if (method === "PUT" && path === "/repos/acme/cloud/contents/new.txt") {
      if (options.contentsTooLarge) {
        return jsonResponse({ message: "This file is too large for the Contents API" }, 413);
      }
      return jsonResponse({ commit: { sha: "contents-sha" } });
    }
    if (method === "GET" && path === "/repos/acme/cloud/git/commits/base-a") {
      return jsonResponse({ tree: { sha: "tree-a" } });
    }
    if (method === "POST" && path === "/repos/acme/cloud/git/blobs") {
      return jsonResponse({ sha: "blob-a" });
    }
    if (method === "POST" && path === "/repos/acme/cloud/git/trees") {
      return jsonResponse({ sha: "tree-b" });
    }
    if (method === "POST" && path === "/repos/acme/cloud/git/commits") {
      return jsonResponse({ sha: "git-db-sha" });
    }
    if (method === "PATCH" && path === "/repos/acme/cloud/git/refs/heads/agent-relay/run-33333333-3333-4333-8333-333333333333") {
      return jsonResponse({ object: { sha: "git-db-sha" } });
    }
    if (method === "PATCH" && path === "/repos/acme/cloud/git/refs/heads/feature/api-keys") {
      return jsonResponse({ object: { sha: "git-db-sha" } });
    }
    if (method === "POST" && path === "/repos/acme/cloud/pulls") {
      return jsonResponse({ html_url: "https://github.com/acme/cloud/pull/1" });
    }

    return jsonResponse({ message: `Unhandled ${method} ${path}` }, 500);
  });

  return { fetchImpl, calls };
}

async function setupDb() {
  const testDb = await createRelayfileWritebackPgliteDb();
  cleanupDb = testDb.cleanup;
  testDb.installAsAppDb();
  await testDb.insertWorkspace({ id: WORKSPACE_ID });
  await testDb.insertWorkspaceIntegration({
    workspaceId: WORKSPACE_ID,
    provider: "github",
    connectionId: "conn_github",
    providerConfigKey: "github",
    installationId: "install_1",
  });
}

beforeEach(async () => {
  process.env.NANGO_SECRET_KEY = "nango-secret";
  defaultNangoGetTokenBehavior();
  await setupDb();
});

afterEach(async () => {
  delete process.env.NANGO_SECRET_KEY;
  if (cleanupDb) {
    await cleanupDb();
    cleanupDb = undefined;
  }
  vi.clearAllMocks();
});

describe("github push-back", () => {
  it("uses the fallback branch name when pushBranch is absent", async () => {
    const { fetchImpl, calls } = createFetchMock();

    const result = await pushWorkflowPathPatch({
      run: baseRun,
      path: {
        name: "cloud",
        s3CodeKey: "code-cloud.tar.gz",
        repoOwner: "acme",
        repoName: "cloud",
      },
      allowlist,
      patch: addPatch,
      s3Key: `${USER_ID}/${RUN_ID}/changes-cloud.patch`,
      fetchImpl,
    });

    expect(result).toMatchObject({
      status: "pushed",
      branch: `agent-relay/run-${RUN_ID}`,
      prUrl: "https://github.com/acme/cloud/pull/1",
      sha: "contents-sha",
      strategy: "contents_api",
    });
    const createRef = calls.find((call) => call.body.ref === `refs/heads/agent-relay/run-${RUN_ID}`);
    expect(createRef).toBeDefined();
  });

  it("uses path pushBranch and pushPrBody verbatim when present", async () => {
    const { fetchImpl, calls } = createFetchMock();

    const result = await pushWorkflowPathPatch({
      run: baseRun,
      path: {
        name: "cloud",
        s3CodeKey: "code-cloud.tar.gz",
        repoOwner: "acme",
        repoName: "cloud",
        pushBranch: "feature/api-keys",
        pushPrBody: "Custom PR body",
      },
      allowlist,
      patch: addPatch,
      s3Key: `${USER_ID}/${RUN_ID}/changes-cloud.patch`,
      fetchImpl,
    });

    expect(result).toMatchObject({ status: "pushed", branch: "feature/api-keys" });
    expect(calls.find((call) => call.body.ref === "refs/heads/feature/api-keys")).toBeDefined();
    const pull = calls.find((call) => call.url.endsWith("/repos/acme/cloud/pulls"));
    expect(pull?.body.body).toBe("Custom PR body");
  });

  it("uses a platform default PR body when pushPrBody is absent", async () => {
    const { fetchImpl, calls } = createFetchMock();

    await pushWorkflowPathPatch({
      run: baseRun,
      path: {
        name: "cloud",
        s3CodeKey: "code-cloud.tar.gz",
        repoOwner: "acme",
        repoName: "cloud",
      },
      allowlist,
      patch: addPatch,
      s3Key: `${USER_ID}/${RUN_ID}/changes-cloud.patch`,
      fetchImpl,
    });

    const pull = calls.find((call) => call.url.endsWith("/repos/acme/cloud/pulls"));
    expect(pull?.body.body).toMatch(new RegExp(`/runs/${RUN_ID}`));
    expect(pull?.body.body).toContain(`changes-cloud.patch`);
  });

  it("fails loud without opening a PR when the base branch moves before PR creation", async () => {
    const { fetchImpl, calls } = createFetchMock({ secondBaseSha: "base-b" });

    const result = await pushWorkflowPathPatch({
      run: baseRun,
      path: {
        name: "cloud",
        s3CodeKey: "code-cloud.tar.gz",
        repoOwner: "acme",
        repoName: "cloud",
      },
      allowlist,
      patch: addPatch,
      s3Key: `${USER_ID}/${RUN_ID}/changes-cloud.patch`,
      fetchImpl,
    });

    expect(result).toMatchObject({
      status: "failed",
      code: "base_branch_moved",
      base: { branch: "main", sha: "base-a" },
      observedBaseSha: "base-b",
    });
    expect(calls.some((call) => call.url.endsWith("/repos/acme/cloud/pulls"))).toBe(false);
  });

  it("falls back to the Git Database API when the Contents API rejects a large file", async () => {
    const { fetchImpl, calls } = createFetchMock({ contentsTooLarge: true });

    const result = await pushWorkflowPathPatch({
      run: baseRun,
      path: {
        name: "cloud",
        s3CodeKey: "code-cloud.tar.gz",
        repoOwner: "acme",
        repoName: "cloud",
      },
      allowlist,
      patch: addPatch,
      s3Key: `${USER_ID}/${RUN_ID}/changes-cloud.patch`,
      fetchImpl,
    });

    expect(result).toMatchObject({
      status: "pushed",
      sha: "git-db-sha",
      strategy: "git_db",
    });
    expect(calls.some((call) => call.url.endsWith("/repos/acme/cloud/git/blobs"))).toBe(true);
    expect(calls.some((call) => call.url.endsWith(`/repos/acme/cloud/git/refs/heads/agent-relay/run-${RUN_ID}`))).toBe(true);
  });

  it("parses add, modify, delete, and rename file patches", () => {
    const parsed = parseUnifiedDiff([
      addPatch.trimEnd(),
      "diff --git a/existing.txt b/existing.txt",
      "index 1111111..2222222 100644",
      "--- a/existing.txt",
      "+++ b/existing.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/remove.txt b/remove.txt",
      "deleted file mode 100644",
      "index 1111111..0000000",
      "--- a/remove.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-gone",
      "diff --git a/old-name.txt b/new-name.txt",
      "similarity index 100%",
      "rename from old-name.txt",
      "rename to new-name.txt",
      "",
    ].join("\n"));

    expect(parsed.map((file) => [file.oldPath, file.newPath, file.renameFrom, file.renameTo])).toEqual([
      [null, "new.txt", undefined, undefined],
      ["existing.txt", "existing.txt", undefined, undefined],
      ["remove.txt", null, undefined, undefined],
      ["old-name.txt", "new-name.txt", "old-name.txt", "new-name.txt"],
    ]);
  });

  it("preserves the no-trailing-newline marker in the applied content", () => {
    // Diff that adds a 2-line file with no trailing newline on the last line.
    const noNewlinePatch = [
      "diff --git a/note.txt b/note.txt",
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      "+++ b/note.txt",
      "@@ -0,0 +1,2 @@",
      "+line one",
      "+line two",
      "\\ No newline at end of file",
      "",
    ].join("\n");

    const parsed = parseUnifiedDiff(noNewlinePatch);
    expect(parsed).toHaveLength(1);
    const result = applyHunks("", parsed[0].hunks);
    expect(result).toBe("line one\nline two");
    expect(result.endsWith("\n")).toBe(false);
  });

  it("opens the PR against `master` when the repo's default_branch is master", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const urlString = String(url);
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      calls.push({ url: urlString, init: init ?? {}, body });

      // Nango proxy now goes through the SDK mock (nangoGetTokenMock), not
      // through this fetchImpl. If we see api.nango.dev here, that's a
      // regression to hand-rolled HTTP.
      if (urlString.includes("api.nango.dev")) {
        throw new Error(`fetchImpl received unexpected Nango URL ${urlString} — token mint should go through the SDK`);
      }

      const path = new URL(urlString).pathname;
      const method = init?.method ?? "GET";
      if (method === "GET" && path === "/repos/acme/cloud") {
        return jsonResponse({ default_branch: "master" });
      }
      if (method === "GET" && path === "/repos/acme/cloud/git/ref/heads/master") {
        return jsonResponse({ object: { sha: "base-master" } });
      }
      if (method === "POST" && path === "/repos/acme/cloud/git/refs") {
        return jsonResponse({ ref: body.ref, object: { sha: "base-master" } });
      }
      if (method === "GET" && path === "/repos/acme/cloud/contents/new.txt") {
        return jsonResponse({ message: "Not Found" }, 404);
      }
      if (method === "PUT" && path === "/repos/acme/cloud/contents/new.txt") {
        return jsonResponse({ commit: { sha: "contents-sha" } });
      }
      if (method === "POST" && path === "/repos/acme/cloud/pulls") {
        return jsonResponse({ html_url: "https://github.com/acme/cloud/pull/2" });
      }
      return jsonResponse({ message: `Unhandled ${method} ${path}` }, 500);
    });

    const result = await pushWorkflowPathPatch({
      run: baseRun,
      path: {
        name: "cloud",
        s3CodeKey: "code-cloud.tar.gz",
        repoOwner: "acme",
        repoName: "cloud",
      },
      allowlist,
      patch: addPatch,
      s3Key: `${USER_ID}/${RUN_ID}/changes-cloud.patch`,
      fetchImpl,
    });

    expect(result).toMatchObject({
      status: "pushed",
      base: { branch: "master", sha: "base-master" },
    });
    const pull = calls.find((call) => call.url.endsWith("/repos/acme/cloud/pulls"));
    expect(pull?.body.base).toBe("master");
  });
});

// Regression coverage for the silent-failure class of bugs that hid a
// missing NANGO_SECRET_KEY binding from production for >24h. Each test
// pins the failure-mode contract so a future refactor can't reintroduce
// "swallow misconfiguration as if it were a data-state issue".
describe("installationCanAccessRepo failure-mode contract", () => {
  // Inherits the file-level beforeEach/afterEach: that already seeds
  // the workspace + a `github` integration row pointing at install_1
  // and sets NANGO_SECRET_KEY. Re-seeding here would clobber the
  // outer cleanupDb handle and leak a PGlite instance per test
  // (CodeRabbit caught this on a prior revision).
  const PROBE_INPUT = {
    workspaceId: WORKSPACE_ID,
    installationId: "install_1",
    repoOwner: "acme",
    repoName: "cloud",
  };

  it("throws PushBackError(installation_token_failed) when NANGO_SECRET_KEY is missing — must not return false", async () => {
    delete process.env.NANGO_SECRET_KEY;
    const fetchImpl = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) => jsonResponse({}, 200));

    let caught: unknown;
    try {
      await installationCanAccessRepo({ ...PROBE_INPUT, fetchImpl });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PushBackError);
    expect((caught as PushBackError).code).toBe("installation_token_failed");
    expect((caught as PushBackError).message).toMatch(/NANGO_SECRET_KEY is not configured/);
    // Critically: the probe MUST NOT have hit GitHub. If we reached the
    // repo endpoint after a failed mint we'd be sending a Bearer of an
    // empty token and bumping rate limits on every retried submit.
    const githubCalls = fetchImpl.mock.calls.filter((call) =>
      String(call[0]).includes("api.github.com"),
    );
    expect(githubCalls).toHaveLength(0);
  });

  it("throws when the Nango SDK mint call fails — token-mint config errors must not get downgraded", async () => {
    // SDK throws on connection revoked / nango proxy 4xx. Our wrapper
    // squashes the underlying axios error into PushBackError(installation_token_failed)
    // so callers (resolver, push-back fanout) discriminate cleanly.
    nangoGetTokenMock.mockRejectedValueOnce(
      new Error("Request failed with status code 401: connection_revoked"),
    );
    const fetchImpl = vi.fn(async () => {
      throw new Error("unexpected fetch — mint should fail before any GitHub API call");
    });

    await expect(
      installationCanAccessRepo({ ...PROBE_INPUT, fetchImpl }),
    ).rejects.toMatchObject({
      name: "PushBackError",
      code: "installation_token_failed",
    });
  });

  it("returns false on 404 from the repo probe (install genuinely cannot reach repo)", async () => {
    const fetchImpl = vi.fn(async (url: URL | RequestInfo) => {
      const urlString = String(url);
      // Nango proxy now goes through the SDK mock (nangoGetTokenMock), not
      // through this fetchImpl. If we see api.nango.dev here, that's a
      // regression to hand-rolled HTTP.
      if (urlString.includes("api.nango.dev")) {
        throw new Error(`fetchImpl received unexpected Nango URL ${urlString} — token mint should go through the SDK`);
      }
      if (urlString.endsWith("/repos/acme/cloud")) {
        return jsonResponse({ message: "Not Found" }, 404);
      }
      throw new Error(`unexpected fetch: ${urlString}`);
    });

    await expect(
      installationCanAccessRepo({ ...PROBE_INPUT, fetchImpl }),
    ).resolves.toBe(false);
  });

  it("returns false on 403 from the repo probe (install reaches repo but lacks scope)", async () => {
    const fetchImpl = vi.fn(async (url: URL | RequestInfo) => {
      const urlString = String(url);
      // Nango proxy now goes through the SDK mock (nangoGetTokenMock), not
      // through this fetchImpl. If we see api.nango.dev here, that's a
      // regression to hand-rolled HTTP.
      if (urlString.includes("api.nango.dev")) {
        throw new Error(`fetchImpl received unexpected Nango URL ${urlString} — token mint should go through the SDK`);
      }
      if (urlString.endsWith("/repos/acme/cloud")) {
        return jsonResponse({ message: "forbidden" }, 403);
      }
      throw new Error(`unexpected fetch: ${urlString}`);
    });

    await expect(
      installationCanAccessRepo({ ...PROBE_INPUT, fetchImpl }),
    ).resolves.toBe(false);
  });

  it("throws PushBackError(github_api_error) on 5xx from the probe (transient — operator should see real error)", async () => {
    const fetchImpl = vi.fn(async (url: URL | RequestInfo) => {
      const urlString = String(url);
      // Nango proxy now goes through the SDK mock (nangoGetTokenMock), not
      // through this fetchImpl. If we see api.nango.dev here, that's a
      // regression to hand-rolled HTTP.
      if (urlString.includes("api.nango.dev")) {
        throw new Error(`fetchImpl received unexpected Nango URL ${urlString} — token mint should go through the SDK`);
      }
      if (urlString.endsWith("/repos/acme/cloud")) {
        return jsonResponse({ message: "service unavailable" }, 503);
      }
      throw new Error(`unexpected fetch: ${urlString}`);
    });

    await expect(
      installationCanAccessRepo({ ...PROBE_INPUT, fetchImpl }),
    ).rejects.toMatchObject({
      name: "PushBackError",
      code: "github_api_error",
    });
  });

  it("returns true on 200 (happy path)", async () => {
    const fetchImpl = vi.fn(async (url: URL | RequestInfo) => {
      const urlString = String(url);
      // Nango proxy now goes through the SDK mock (nangoGetTokenMock), not
      // through this fetchImpl. If we see api.nango.dev here, that's a
      // regression to hand-rolled HTTP.
      if (urlString.includes("api.nango.dev")) {
        throw new Error(`fetchImpl received unexpected Nango URL ${urlString} — token mint should go through the SDK`);
      }
      if (urlString.endsWith("/repos/acme/cloud")) {
        return jsonResponse({ id: 12345, default_branch: "main" });
      }
      throw new Error(`unexpected fetch: ${urlString}`);
    });

    await expect(
      installationCanAccessRepo({ ...PROBE_INPUT, fetchImpl }),
    ).resolves.toBe(true);
  });
});

// Build a fetch mock for the github-API legs of a push. Token mint
// goes through the Nango SDK (mocked separately via nangoGetTokenMock);
// this helper also wires nangoGetTokenMock to honor `tokenStatus` so
// per-install mint failures stay configurable from one place.
//
// `tokenStatus` maps installationId -> HTTP status the SDK simulates.
// 200 = SDK returns a token "ghs_<id>". Anything else = SDK throws
// (which our mintInstallationToken wraps as installation_token_failed).
// `defaultRepoStatus` drives the GET /repos/{owner}/{repo} response.
function createMultiInstallFetchMock(options: {
  tokenStatus: Record<string, number>;
  defaultRepoStatus?: number;
  repoStatusByToken?: Record<string, number>;
}) {
  // Wire the SDK mock to honor per-install mint behavior. Multi-install
  // fixtures seed integrations with `connectionId: \`conn_${installationId}\``,
  // so we recover the installationId from the connection arg. nango.getToken
  // throws (axios-style) on non-2xx; mintInstallationToken catches and wraps
  // as PushBackError(installation_token_failed).
  nangoGetTokenMock.mockImplementation(
    async (_providerConfigKey: string, connectionId: string) => {
      const installationId = connectionId.startsWith("conn_")
        ? connectionId.slice("conn_".length)
        : connectionId;
      const status = options.tokenStatus[installationId] ?? 200;
      if (status === 200) {
        return `ghs_${installationId}`;
      }
      throw new Error(`Request failed with status code ${status}: mint failed for ${installationId}`);
    },
  );
  nangoProxyMock.mockImplementation(
    async ({ connectionId, endpoint, method }: {
      connectionId: string;
      endpoint: string;
      method: string;
    }) => {
      if (method !== "GET" || endpoint !== "/repos/acme/cloud") {
        throw new Error(`unexpected Nango proxy ${method} ${endpoint}`);
      }
      const installationId = connectionId.startsWith("conn_")
        ? connectionId.slice("conn_".length)
        : connectionId;
      const repoStatus = options.repoStatusByToken?.[installationId] ?? options.defaultRepoStatus ?? 200;
      if (repoStatus === 200) {
        return { status: 200, data: { default_branch: "main" } };
      }
      throw Object.assign(new Error("Not Found"), {
        response: { status: repoStatus, data: { message: "Not Found" } },
      });
    },
  );

  const calls: FetchCall[] = [];
  const fetchImpl = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
    const urlString = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    calls.push({ url: urlString, init: init ?? {}, body });

    if (urlString.includes("api.nango.dev")) {
      throw new Error(`fetchImpl received unexpected Nango URL ${urlString} — token mint should go through the SDK`);
    }

    const path = new URL(urlString).pathname;
    const method = init?.method ?? "GET";
    if (method === "GET" && path === "/repos/acme/cloud") {
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
      const token = auth.startsWith("Bearer ghs_") ? auth.slice("Bearer ghs_".length) : "";
      const repoStatus = options.repoStatusByToken?.[token] ?? options.defaultRepoStatus ?? 200;
      if (repoStatus !== 200) {
        return jsonResponse({ message: "Not Found" }, repoStatus);
      }
      return jsonResponse({ default_branch: "main" });
    }
    if (method === "GET" && path === "/repos/acme/cloud/git/ref/heads/main") {
      return jsonResponse({ object: { sha: "base-sha" } });
    }
    if (method === "POST" && path === "/repos/acme/cloud/git/refs") {
      return jsonResponse({ ref: body.ref, object: { sha: "base-sha" } });
    }
    if (method === "GET" && path === "/repos/acme/cloud/contents/new.txt") {
      return jsonResponse({ message: "Not Found" }, 404);
    }
    if (method === "PUT" && path === "/repos/acme/cloud/contents/new.txt") {
      return jsonResponse({ commit: { sha: "contents-sha" } });
    }
    if (method === "GET" && path === "/repos/acme/cloud/git/commits/base-sha") {
      return jsonResponse({ tree: { sha: "tree-a" } });
    }
    if (method === "POST" && path === "/repos/acme/cloud/git/blobs") {
      return jsonResponse({ sha: "blob-a" });
    }
    if (method === "POST" && path === "/repos/acme/cloud/git/trees") {
      return jsonResponse({ sha: "tree-b" });
    }
    if (method === "POST" && path === "/repos/acme/cloud/git/commits") {
      return jsonResponse({ sha: "git-db-sha" });
    }
    if (method === "PATCH" && path.startsWith("/repos/acme/cloud/git/refs/heads/")) {
      return jsonResponse({ object: { sha: "git-db-sha" } });
    }
    if (method === "POST" && path === "/repos/acme/cloud/pulls") {
      return jsonResponse({ html_url: "https://github.com/acme/cloud/pull/1" });
    }

    return jsonResponse({ message: `Unhandled ${method} ${path}` }, 500);
  });
  return { fetchImpl, calls };
}

// pushWorkflowPathPatch's relaxed-mode multi-install fanout: when the
// allowlist record carries no installationId hint (the synthetic
// `system:relaxed` shape) push-back is responsible for discovering
// the workspace's github-* installs and trying each. Strict mode
// (allowlist with a specific installationId) skips the fanout
// entirely and uses the hint as the operator's authoritative routing
// decision.
describe("pushWorkflowPathPatch — multi-install fanout (relaxed mode)", () => {
  const seedWorkspaceWithInstalls = async (
    testDb: Awaited<ReturnType<typeof createRelayfileWritebackPgliteDb>>,
    installs: Array<{
      workspaceId?: string;
      provider: string;
      installationId: string | null;
      connectionId?: string;
      providerConfigKey?: string;
    }>,
  ) => {
    cleanupDb = testDb.cleanup;
    testDb.installAsAppDb();
    await testDb.insertWorkspace({ id: WORKSPACE_ID });
    for (const i of installs) {
      await testDb.insertWorkspaceIntegration({
        workspaceId: i.workspaceId ?? WORKSPACE_ID,
        provider: i.provider,
        connectionId: i.connectionId ?? `conn_${i.installationId ?? "null"}`,
        providerConfigKey: i.providerConfigKey ?? (i.provider === "github" ? "github" : i.provider),
        installationId: i.installationId,
      });
      // Stagger updatedAt so the alias-by-recency ordering is
      // predictable when tests care about it.
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };

  const seedUserInstall = async (
    testDb: Awaited<ReturnType<typeof createRelayfileWritebackPgliteDb>>,
    input: {
      userId?: string;
      provider: string;
      installationId: string | null;
      connectionId?: string;
      providerConfigKey?: string;
    },
  ) => {
    await testDb.insertUserIntegration({
      userId: input.userId ?? USER_ID,
      provider: input.provider,
      connectionId: input.connectionId ?? `conn_${input.installationId ?? "null"}`,
      providerConfigKey: input.providerConfigKey ?? (input.provider === "github" ? "github" : input.provider),
      installationId: input.installationId,
    });
  };

  const RELAXED_ALLOWLIST: WorkflowRepositoryAllowlistRecord = {
    workspaceId: WORKSPACE_ID,
    repoOwner: "acme",
    repoName: "cloud",
    installationId: "", // synthetic relaxed sentinel
    pushAllowed: true,
    allowedAt: new Date(0),
    allowedBy: "system:relaxed",
  };

  it("returns failed(integration_not_found) when the workspace has no github-* installs", async () => {
    const testDb = await createRelayfileWritebackPgliteDb();
    cleanupDb = testDb.cleanup;
    testDb.installAsAppDb();
    await testDb.insertWorkspace({ id: WORKSPACE_ID });

    const fetchImpl = vi.fn(async () => {
      throw new Error("push-back must not hit network when there are no installs to try");
    });

    const result = await pushWorkflowPathPatch({
      run: baseRun,
      path: { name: "cloud", s3CodeKey: "code.tar.gz", repoOwner: "acme", repoName: "cloud" },
      allowlist: RELAXED_ALLOWLIST,
      patch: addPatch,
      s3Key: "key",
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(result).toMatchObject({
      status: "failed",
      code: "integration_not_found",
    });
  });

  it("tries each github-* install in order and returns the first success", async () => {
    const testDb = await createRelayfileWritebackPgliteDb();
    await seedWorkspaceWithInstalls(testDb, [
      { provider: "github", installationId: "install_legacy" },
      { provider: "github-ricky", installationId: "install_fresh" },
    ]);

    // First install fails at token mint, second succeeds + pushes.
    const { fetchImpl, calls } = createMultiInstallFetchMock({
      tokenStatus: {
        install_legacy: 401,  // token mint fails
        install_fresh: 200,   // mints + pushes
      },
    });

    const result = await pushWorkflowPathPatch({
      run: baseRun,
      path: { name: "cloud", s3CodeKey: "code.tar.gz", repoOwner: "acme", repoName: "cloud" },
      allowlist: RELAXED_ALLOWLIST,
      patch: addPatch,
      s3Key: "key",
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(result).toMatchObject({ status: "pushed" });
    // Sanity: at least one install got its mint attempted via the SDK.
    expect(nangoGetTokenMock).toHaveBeenCalled();
    // Pull was opened against acme/cloud.
    const pull = calls.find((c) => c.url.endsWith("/repos/acme/cloud/pulls"));
    expect(pull).toBeDefined();
  });

  it("uses a github connection with an empty stored installationId when its token probes successfully", async () => {
    const testDb = await createRelayfileWritebackPgliteDb();
    await seedWorkspaceWithInstalls(testDb, [
      {
        provider: "github-pusher",
        installationId: "install_selected",
        connectionId: "conn_selected",
        providerConfigKey: "github-pusher",
      },
      {
        provider: "github",
        installationId: "",
        connectionId: "conn_relay",
        providerConfigKey: "github-relay",
      },
    ]);

    const { fetchImpl, calls } = createMultiInstallFetchMock({
      tokenStatus: {
        selected: 200,
        relay: 200,
      },
      repoStatusByToken: {
        selected: 404,
        relay: 200,
      },
    });

    const result = await pushWorkflowPathPatch({
      run: baseRun,
      path: { name: "cloud", s3CodeKey: "code.tar.gz", repoOwner: "acme", repoName: "cloud" },
      allowlist: RELAXED_ALLOWLIST,
      patch: addPatch,
      s3Key: "key",
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(result).toMatchObject({ status: "pushed" });
    expect(nangoGetTokenMock).toHaveBeenCalledWith("github-relay", "conn_relay", false, true);
    const pull = calls.find((c) => c.url.endsWith("/repos/acme/cloud/pulls"));
    expect(pull).toBeDefined();
  });

  it("tries user integrations before workspace integrations", async () => {
    const testDb = await createRelayfileWritebackPgliteDb();
    await seedWorkspaceWithInstalls(testDb, [
      {
        workspaceId: WORKSPACE_ID,
        provider: "github-pusher",
        installationId: "install_selected",
        connectionId: "conn_selected",
        providerConfigKey: "github-pusher",
      },
    ]);
    await seedUserInstall(testDb, {
      provider: "github",
      installationId: "",
      connectionId: "conn_user",
      providerConfigKey: "github-relay",
    });

    const { fetchImpl, calls } = createMultiInstallFetchMock({
      tokenStatus: {
        user: 200,
        selected: 200,
      },
      repoStatusByToken: {
        user: 200,
        selected: 404,
      },
    });

    const result = await pushWorkflowPathPatch({
      run: baseRun,
      path: { name: "cloud", s3CodeKey: "code.tar.gz", repoOwner: "acme", repoName: "cloud" },
      allowlist: RELAXED_ALLOWLIST,
      patch: addPatch,
      s3Key: "key",
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(result).toMatchObject({ status: "pushed" });
    expect(nangoGetTokenMock).toHaveBeenCalledWith("github-relay", "conn_user", false, true);
    const selectedMintCalls = nangoGetTokenMock.mock.calls.filter(([, connectionId]) =>
      String(connectionId ?? "") === "conn_selected",
    );
    expect(selectedMintCalls).toHaveLength(0);
    const pull = calls.find((c) => c.url.endsWith("/repos/acme/cloud/pulls"));
    expect(pull).toBeDefined();
  });

  it("falls back to workspace integrations when user integrations cannot access the repo", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const testDb = await createRelayfileWritebackPgliteDb();
    try {
      await seedWorkspaceWithInstalls(testDb, [
        { provider: "github-ricky", installationId: "install_fresh" },
      ]);
      await seedUserInstall(testDb, {
        provider: "github",
        installationId: "",
        connectionId: "conn_user_selected",
        providerConfigKey: "github-relay",
      });

      const { fetchImpl, calls } = createMultiInstallFetchMock({
        tokenStatus: {
          user_selected: 200,
          install_fresh: 200,
        },
        repoStatusByToken: {
          user_selected: 404,
          install_fresh: 200,
        },
      });

      const result = await pushWorkflowPathPatch({
        run: baseRun,
        path: { name: "cloud", s3CodeKey: "code.tar.gz", repoOwner: "acme", repoName: "cloud" },
        allowlist: RELAXED_ALLOWLIST,
        patch: addPatch,
        s3Key: "key",
        fetchImpl: fetchImpl as typeof fetch,
      });

      expect(result).toMatchObject({ status: "pushed" });
      expect(nangoGetTokenMock).toHaveBeenCalledWith("github-relay", "conn_user_selected", false, true);
      expect(nangoGetTokenMock).toHaveBeenCalledWith("github-ricky", "conn_install_fresh", false, true);
      const logged = JSON.stringify(warnSpy.mock.calls);
      expect(logged).toContain("\"tokenPrefix\":\"ghs_\"");
      expect(logged).toContain("\"githubMessage\":\"Not Found\"");
      expect(logged).not.toContain("ghs_user_selected");
      const pull = calls.find((c) => c.url.endsWith("/repos/acme/cloud/pulls"));
      expect(pull).toBeDefined();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("tries the run relay workspace before the app workspace", async () => {
    const testDb = await createRelayfileWritebackPgliteDb();
    await seedWorkspaceWithInstalls(testDb, [
      {
        workspaceId: WORKSPACE_ID,
        provider: "github-pusher",
        installationId: "install_selected",
        connectionId: "conn_selected",
        providerConfigKey: "github-pusher",
      },
      {
        workspaceId: RELAY_WORKSPACE_ID,
        provider: "github",
        installationId: "",
        connectionId: "conn_relay",
        providerConfigKey: "github-relay",
      },
    ]);

    const { fetchImpl, calls } = createMultiInstallFetchMock({
      tokenStatus: {
        selected: 200,
        relay: 200,
      },
      repoStatusByToken: {
        selected: 404,
        relay: 200,
      },
    });

    const result = await pushWorkflowPathPatch({
      run: { ...baseRun, relayWorkspaceId: RELAY_WORKSPACE_ID },
      path: { name: "cloud", s3CodeKey: "code.tar.gz", repoOwner: "acme", repoName: "cloud" },
      allowlist: RELAXED_ALLOWLIST,
      patch: addPatch,
      s3Key: "key",
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(result).toMatchObject({ status: "pushed" });
    expect(nangoGetTokenMock).toHaveBeenCalledWith("github-relay", "conn_relay", false, true);
    const selectedMintCalls = nangoGetTokenMock.mock.calls.filter(([, connectionId]) =>
      String(connectionId ?? "") === "conn_selected",
    );
    expect(selectedMintCalls).toHaveLength(0);
    const pull = calls.find((c) => c.url.endsWith("/repos/acme/cloud/pulls"));
    expect(pull).toBeDefined();
  });

  it("skips a selected-repo install whose token probes 404 and pushes with the next reachable connection", async () => {
    const testDb = await createRelayfileWritebackPgliteDb();
    await seedWorkspaceWithInstalls(testDb, [
      { provider: "github-ricky", installationId: "install_fresh" },
      { provider: "github", installationId: "install_selected" },
    ]);

    const { fetchImpl, calls } = createMultiInstallFetchMock({
      tokenStatus: {
        install_selected: 200,
        install_fresh: 200,
      },
      repoStatusByToken: {
        install_selected: 404,
        install_fresh: 200,
      },
    });

    const result = await pushWorkflowPathPatch({
      run: baseRun,
      path: { name: "cloud", s3CodeKey: "code.tar.gz", repoOwner: "acme", repoName: "cloud" },
      allowlist: RELAXED_ALLOWLIST,
      patch: addPatch,
      s3Key: "key",
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(result).toMatchObject({ status: "pushed" });
    expect(nangoGetTokenMock).toHaveBeenCalledWith("github", "conn_install_selected", false, true);
    expect(nangoGetTokenMock).toHaveBeenCalledWith("github-ricky", "conn_install_fresh", false, true);
    const pull = calls.find((c) => c.url.endsWith("/repos/acme/cloud/pulls"));
    expect(pull).toBeDefined();
  });

  it("when every install fails, surfaces config errors (token-mint) over data errors (404)", async () => {
    const testDb = await createRelayfileWritebackPgliteDb();
    await seedWorkspaceWithInstalls(testDb, [
      { provider: "github", installationId: "install_404" },             // mint OK, repo 404
      { provider: "github-ricky", installationId: "install_token_dead" }, // mint fails
    ]);
    await seedUserInstall(testDb, {
      provider: "github",
      installationId: "",
      connectionId: "conn_user_404",
      providerConfigKey: "github-relay",
    });

    const { fetchImpl } = createMultiInstallFetchMock({
      tokenStatus: {
        user_404: 200,
        install_404: 200,
        install_token_dead: 401,
      },
      defaultRepoStatus: 404,
    });

    const result = await pushWorkflowPathPatch({
      run: baseRun,
      path: { name: "cloud", s3CodeKey: "code.tar.gz", repoOwner: "acme", repoName: "cloud" },
      allowlist: RELAXED_ALLOWLIST,
      patch: addPatch,
      s3Key: "key",
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(result).toMatchObject({
      status: "failed",
      code: "installation_token_failed",
    });
  });

  it("strict-mode allowlist (specific installationId) skips fanout entirely", async () => {
    // When the allowlist row carries a specific installationId, push-
    // back honors that single choice — strict mode means the operator
    // explicitly designated which install to use. The decoy install
    // would push successfully if fanout ran; the test asserts we
    // never attempt to mint with it.
    const testDb = await createRelayfileWritebackPgliteDb();
    await seedWorkspaceWithInstalls(testDb, [
      { provider: "github", installationId: "install_explicit" },
      { provider: "github-ricky", installationId: "install_decoy" },
    ]);

    const { fetchImpl, calls } = createMultiInstallFetchMock({
      tokenStatus: {
        install_explicit: 200,
        install_decoy: 200,
      },
    });

    const explicitAllowlist: WorkflowRepositoryAllowlistRecord = {
      ...RELAXED_ALLOWLIST,
      installationId: "install_explicit",
      allowedBy: "operator",
    };

    const result = await pushWorkflowPathPatch({
      run: baseRun,
      path: { name: "cloud", s3CodeKey: "code.tar.gz", repoOwner: "acme", repoName: "cloud" },
      allowlist: explicitAllowlist,
      patch: addPatch,
      s3Key: "key",
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(result).toMatchObject({ status: "pushed" });
    // Decoy install must not have been touched. The SDK mock records
    // every getToken call (positional args: providerConfigKey,
    // connectionId, ...). Decoy's connection is "conn_install_decoy".
    const decoyMintCalls = nangoGetTokenMock.mock.calls.filter(
      ([, connectionId]) => String(connectionId ?? "").includes("install_decoy"),
    );
    expect(decoyMintCalls).toHaveLength(0);
  });
});
