import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createRelayfileWritebackPgliteDb } from "./helpers/relayfile-writeback-pglite-db";

// ── Module mocks ─────────────────────────────────────────────────────────────
// These are the only surfaces we stub. Everything else (route handler,
// workflowStore, resolveRepoAllowlistOrRelaxed, github-push-back) runs for real against
// the PGlite database seeded below.

const s3PatchBodies = new Map<string, string>();

vi.mock("sst", () => ({
  Resource: {
    WorkflowStorage: {
      bucketName: "workflow-bucket",
    },
  },
}));

vi.mock("@aws-sdk/client-s3", () => {
  class GetObjectCommand {
    readonly input: { Bucket: string; Key: string };
    constructor(input: { Bucket: string; Key: string }) {
      this.input = input;
    }
  }
  class S3Client {
    async send(command: { input: { Bucket: string; Key: string } }) {
      const body = s3PatchBodies.get(command.input.Key);
      if (body === undefined) {
        const err = new Error(`NoSuchKey: ${command.input.Key}`);
        (err as { name: string }).name = "NoSuchKey";
        throw err;
      }
      const bytes = Buffer.from(body, "utf8");
      return {
        Body: (async function* () {
          yield bytes;
        })(),
      };
    }
  }
  return { S3Client, GetObjectCommand };
});

vi.mock("@cloud/core/relayauth/client.js", () => ({
  createRelayAuthClient: () => null,
  revokeWorkflowIdentity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/auth/api-token-store", () => ({
  revokeApiTokenSessionsForRun: vi.fn().mockResolvedValue(undefined),
}));

// Token mint goes through `nango.getToken(providerConfigKey,
// connectionId, false, true)` — the 4th arg flips Nango into github-app
// installation-token mode. The hand-rolled `POST /proxy` path produced
// "Cannot POST /proxy" 404s in prod, and a follow-up that proxied to
// /app/installations/<id>/access_tokens returned 401 because the proxy
// doesn't auto-attach App-level JWT auth.
const nangoGetTokenMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/integrations/nango-service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/integrations/nango-service")>(
    "@/lib/integrations/nango-service",
  );
  return {
    ...actual,
    getNangoClient: () => ({ getToken: nangoGetTokenMock }),
  };
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
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

type FetchCall = {
  url: string;
  method: string;
  body: Record<string, unknown>;
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createMultiRepoFetchMock(calls: FetchCall[]) {
  return vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
    const urlString = String(url);
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ url: urlString, method, body });

    // Token mint runs through the SDK mock (nangoGetTokenMock), not this
    // fetchImpl. If a Nango URL ever shows up here, it's a regression
    // to the hand-rolled HTTP path.
    if (urlString.includes("api.nango.dev")) {
      throw new Error(`fetchImpl received unexpected Nango URL ${urlString} — token mint should go through the SDK`);
    }

    const parsed = new URL(urlString);
    const m = parsed.pathname.match(/^\/repos\/acme\/(cloud|relay)(\/.*)?$/);
    if (!m) {
      return jsonResponse({ message: `Unhandled ${method} ${parsed.pathname}` }, 500);
    }
    const repo = m[1];
    const sub = m[2] ?? "";

    if (method === "GET" && sub === "") {
      return jsonResponse({ default_branch: "main" });
    }
    if (method === "GET" && sub === "/git/ref/heads/main") {
      return jsonResponse({ object: { sha: `base-${repo}` } });
    }
    if (method === "POST" && sub === "/git/refs") {
      return jsonResponse({ ref: body.ref, object: { sha: `base-${repo}` } });
    }
    if (method === "GET" && sub === "/contents/new.txt") {
      return jsonResponse({ message: "Not Found" }, 404);
    }
    if (method === "PUT" && sub === "/contents/new.txt") {
      return jsonResponse({ commit: { sha: `contents-sha-${repo}` } });
    }
    if (method === "POST" && sub === "/pulls") {
      return jsonResponse({ html_url: `https://github.com/acme/${repo}/pull/1` });
    }

    return jsonResponse({ message: `Unhandled ${method} ${parsed.pathname}` }, 500);
  });
}

describe("workflow callback → push-back (PGlite integration)", () => {
  let cleanupDb: (() => Promise<void>) | undefined;
  let fetchCalls: FetchCall[];

  beforeEach(async () => {
    process.env.NANGO_SECRET_KEY = "nango-secret";
    nangoGetTokenMock.mockImplementation(async () => "installation-token");
    s3PatchBodies.clear();
    s3PatchBodies.set(`${USER_ID}/${RUN_ID}/changes-cloud.patch`, addPatch);
    s3PatchBodies.set(`${USER_ID}/${RUN_ID}/changes-relay.patch`, addPatch);

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
    for (const repoName of ["cloud", "relay"]) {
      await testDb.insertAllowedRepo({
        workspaceId: WORKSPACE_ID,
        repoOwner: "acme",
        repoName,
        installationId: "install_1",
        pushAllowed: true,
        allowedBy: USER_ID,
      });
    }
    await testDb.insertWorkflowRun({
      id: RUN_ID,
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      callbackToken: "callback-token",
      status: "running",
      paths: [
        { name: "cloud", s3CodeKey: "code-cloud.tar.gz", repoOwner: "acme", repoName: "cloud" },
        { name: "relay", s3CodeKey: "code-relay.tar.gz", repoOwner: "acme", repoName: "relay" },
      ],
    });

    fetchCalls = [];
    vi.stubGlobal("fetch", createMultiRepoFetchMock(fetchCalls));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.NANGO_SECRET_KEY;
    if (cleanupDb) {
      await cleanupDb();
      cleanupDb = undefined;
    }
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("completed callback persists per-path pushedTo and creates a PR per allowlisted repo", async () => {
    const { POST } = await import("../packages/web/app/api/v1/workflows/callback/route.ts");
    const { getDb } = await import("../packages/web/lib/db/index.ts");
    const { workflowRuns } = await import("../packages/web/lib/db/schema.ts");

    const req = new Request("https://cloud.test/api/v1/workflows/callback", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-callback-token": "callback-token",
      },
      body: JSON.stringify({ runId: RUN_ID, status: "completed" }),
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);

    const [row] = await getDb()
      .select({ status: workflowRuns.status, pushedTo: workflowRuns.pushedTo })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, RUN_ID));

    expect(row.status).toBe("completed");
    expect(row.pushedTo).toMatchObject({
      cloud: {
        status: "pushed",
        branch: `agent-relay/run-${RUN_ID}`,
        prUrl: "https://github.com/acme/cloud/pull/1",
        strategy: "contents_api",
      },
      relay: {
        status: "pushed",
        branch: `agent-relay/run-${RUN_ID}`,
        prUrl: "https://github.com/acme/relay/pull/1",
        strategy: "contents_api",
      },
    });

    const createdBranches = fetchCalls.filter(
      (c) => c.method === "POST" && c.url.endsWith("/git/refs"),
    );
    expect(createdBranches.map((c) => c.body.ref)).toEqual([
      `refs/heads/agent-relay/run-${RUN_ID}`,
      `refs/heads/agent-relay/run-${RUN_ID}`,
    ]);

    const openedPrs = fetchCalls.filter(
      (c) => c.method === "POST" && c.url.endsWith("/pulls"),
    );
    expect(openedPrs).toHaveLength(2);
    expect(openedPrs.map((c) => new URL(c.url).pathname)).toEqual([
      "/repos/acme/cloud/pulls",
      "/repos/acme/relay/pulls",
    ]);
  });

  it("skips push-back for paths whose allowlist row has pushAllowed=false and still succeeds", async () => {
    const { getDb } = await import("../packages/web/lib/db/index.ts");
    const { workflowRepositoryAllowlists, workflowRuns } = await import(
      "../packages/web/lib/db/schema.ts"
    );
    await getDb()
      .update(workflowRepositoryAllowlists)
      .set({ pushAllowed: false })
      .where(eq(workflowRepositoryAllowlists.repoName, "relay"));

    const { POST } = await import("../packages/web/app/api/v1/workflows/callback/route.ts");

    const req = new Request("https://cloud.test/api/v1/workflows/callback", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-callback-token": "callback-token",
      },
      body: JSON.stringify({ runId: RUN_ID, status: "completed" }),
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);

    const [row] = await getDb()
      .select({ pushedTo: workflowRuns.pushedTo })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, RUN_ID));

    expect(row.pushedTo).toMatchObject({
      cloud: { status: "pushed" },
    });
    expect((row.pushedTo as Record<string, unknown>).relay).toBeUndefined();

    const openedPrs = fetchCalls.filter(
      (c) => c.method === "POST" && c.url.endsWith("/pulls"),
    );
    expect(openedPrs).toHaveLength(1);
    expect(new URL(openedPrs[0].url).pathname).toBe("/repos/acme/cloud/pulls");
  });
});
