import { createHmac } from "node:crypto";
import { beforeEach, vi } from "vitest";

// Mock @relayauth/sdk's TokenVerifier so contract tests can produce any
// scope/workspace/claim combination without signing real RS256 tokens.
// signJwt(...) stores the intended claims in `pendingClaims` and returns a
// synthetic token; the mocked verifier reads `pendingClaims` on verify.
const pendingClaims: { value: Record<string, unknown> | null } = {
  value: null,
};

vi.mock("@relayauth/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@relayauth/sdk")>();
  class MockTokenVerifier {
    async verify() {
      if (!pendingClaims.value) {
        throw new Error("contract-test: pendingClaims not set before verify()");
      }
      return pendingClaims.value;
    }
  }
  return { ...actual, TokenVerifier: MockTokenVerifier };
});

import { app } from "../src/app.js";
import type { AppEnv } from "../src/env.js";
import { RelayFileClient } from "@relayfile/sdk";
import { setMetricEmitter } from "../src/durable-objects/metrics.js";

type DoCall = {
  name: string;
  request: Request;
};

function createTestEnv(
  handler?: (request: Request, name: string) => Promise<Response> | Response,
) {
  const calls: DoCall[] = [];

  const namespace = {
    idFromName(name: string) {
      return name as unknown as DurableObjectId;
    },
    get(id: DurableObjectId) {
      return {
        fetch: async (request: Request) => {
          const name = id as unknown as string;
          calls.push({ name, request: request.clone() as unknown as Request });
          if (handler) {
            return handler(request, name);
          }
          return new Response(JSON.stringify({ ok: true }), {
            headers: { "Content-Type": "application/json" },
          });
        },
      } as DurableObjectStub;
    },
  } as DurableObjectNamespace;

  const env: AppEnv["Bindings"] = {
    DB: {} as D1Database,
    CONTENT_BUCKET: {} as R2Bucket,
    ENVELOPE_QUEUE: {} as Queue,
    WRITEBACK_QUEUE: {} as Queue,
    WORKSPACE_DO: namespace,
    KV: {} as KVNamespace,
    ENVIRONMENT: "test",
    INTERNAL_HMAC_SECRET: "test-internal-secret",
  };

  return {
    calls,
    env,
  };
}

function base64Url(input: string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

// Stores claims on the shared `pendingClaims` so the mocked TokenVerifier
// resolves them, then returns a dummy token string. Shape mirrors the
// RelayAuthTokenClaims the real verifier would produce (RS256 + wks/sub).
function signJwt(
  scopes: string[],
  workspaceId = "ws_123",
  sponsorId = "contract-test",
): string {
  pendingClaims.value = {
    aud: ["relayfile"],
    wks: workspaceId,
    sub: "contract-test",
    sponsorId,
    scopes,
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      aud: "relayfile",
      wks: workspaceId,
      sub: "contract-test",
      sponsorId,
      scopes,
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  );
  // Signature is never verified — the mocked TokenVerifier returns pendingClaims.
  return `${header}.${payload}.mock-signature`;
}

function signInternalRequest(timestamp: string, body: string): string {
  return createHmac("sha256", "test-internal-secret")
    .update(`${timestamp}\n${body}`)
    .digest("hex");
}

function authorizedRequest(
  url: string,
  token: string,
  init: RequestInit = {},
): Request {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("X-Correlation-Id", "corr_scope");
  return new Request(url, { ...init, headers });
}

function jsonBodyInit(
  body: Record<string, unknown>,
): Pick<RequestInit, "body" | "headers"> {
  const serialized = JSON.stringify(body);
  const byteLength = new TextEncoder().encode(serialized).byteLength;
  return {
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(byteLength),
    },
    body: serialized,
  };
}

function scopedReadToken(): string {
  return signJwt(["fs:read", "workspace:mount-sponsor:read:/allowed/**"]);
}

function scopedWriteToken(): string {
  return signJwt(["fs:write", "workspace:mount-sponsor:write:/allowed/**"]);
}

describe("relayfile contract", () => {
  beforeEach(() => {
    // Reset so a test that forgets to call signJwt(...) doesn't silently
    // inherit the previous test's claims via the shared mock.
    pendingClaims.value = null;
  });

  it("serves health without auth", async () => {
    const { env } = createTestEnv();
    const response = await app.fetch(
      new Request("https://relayfile.test/health"),
      env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("returns spec-shaped not-found errors", async () => {
    const { env } = createTestEnv();
    const response = await app.fetch(
      new Request("https://relayfile.test/not-found"),
      env,
    );
    const body = (await response.json()) as {
      code: string;
      message: string;
      correlationId: string;
    };

    expect(response.status).toBe(404);
    expect(body.code).toBe("not_found");
    expect(body.message).toBe("Route not found");
    expect(body.correlationId.length).toBeGreaterThan(0);
  });

  it("requires correlation ids on protected filesystem routes", async () => {
    const { env } = createTestEnv();
    const token = signJwt(["fs:read"]);
    const response = await app.fetch(
      new Request("https://relayfile.test/v1/workspaces/ws_123/fs/tree", {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }),
      env,
    );
    const body = (await response.json()) as { code: string; message: string };

    expect(response.status).toBe(400);
    expect(body.code).toBe("bad_request");
    expect(body.message).toContain("X-Correlation-Id");
  });

  it("normalizes dynamic route ids before emitting Worker route metrics", async () => {
    const metrics: Array<{
      name: string;
      value: number;
      labels?: Record<string, string | number | boolean>;
    }> = [];
    const previousEmitter = setMetricEmitter({
      emit(name, value, labels) {
        metrics.push({ name, value, labels });
      },
    });
    const { env } = createTestEnv();

    try {
      const token = signJwt(["ops:read"]);
      const response = await app.fetch(
        new Request(
          "https://relayfile.test/v1/workspaces/ws_123/ops/op_high_cardinality_123",
          {
            headers: {
              Authorization: `Bearer ${token}`,
              "X-Correlation-Id": "corr_ops_metric",
            },
          },
        ),
        env,
      );

      expect(response.status).toBe(200);
      expect(metrics).toContainEqual({
        name: "relayfile_worker_route_requests_total",
        value: 1,
        labels: {
          route: "GET /v1/workspaces/:workspaceId/ops/:opId",
          method: "GET",
          status: 200,
          workspace_id: "ws_123",
        },
      });
    } finally {
      setMetricEmitter(previousEmitter);
    }
  });

  it("rejects websocket upgrades without a token", async () => {
    const { env } = createTestEnv();
    const response = await app.fetch(
      new Request("https://relayfile.test/v1/workspaces/ws_123/fs/ws", {
        headers: {
          Upgrade: "websocket",
        },
      }),
      env,
    );
    const body = (await response.json()) as { code: string };

    expect(response.status).toBe(401);
    expect(body.code).toBe("unauthorized");
  });

  it("forwards write requests to the workspace durable object with contract headers intact", async () => {
    const { env, calls } = createTestEnv(async (request) => {
      const body = await request.json();
      return new Response(
        JSON.stringify({
          opId: "op_1",
          status: "queued",
          targetRevision: "rev_2",
          echoed: body,
        }),
        {
          status: 202,
          headers: { "Content-Type": "application/json" },
        },
      );
    });

    const token = signJwt(["fs:write"]);
    const response = await app.fetch(
      new Request(
        "https://relayfile.test/v1/workspaces/ws_123/fs/file?path=/docs/readme.md",
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "If-Match": "rev_1",
            "X-Correlation-Id": "corr_123",
          },
          body: JSON.stringify({
            content: "# updated",
            contentType: "text/markdown",
          }),
        },
      ),
      env,
    );
    const body = (await response.json()) as { opId: string };

    expect(response.status).toBe(202);
    expect(body.opId).toBe("op_1");
    const workspaceCalls = calls.filter((call) => call.name === "ws_123");
    expect(calls.some((call) => call.name === "ws_123:write-admission")).toBe(
      true,
    );
    await expect(
      calls
        .find((call) => call.name === "ws_123:write-admission")
        ?.request.json(),
    ).resolves.toMatchObject({
      workspaceId: "ws_123",
      purpose: "fs_file_put",
      writeClass: "foreground_content",
      foregroundReserved: 1,
      backgroundMax: 3,
    });
    expect(workspaceCalls).toHaveLength(1);
    expect(workspaceCalls[0].request.headers.get("X-Workspace-Id")).toBe(
      "ws_123",
    );
    expect(workspaceCalls[0].request.headers.get("If-Match")).toBe("rev_1");
  });

  it("authorizes path-scoped mount tokens per file on fs/bulk writes", async () => {
    const bare = createTestEnv(async (_request, name) => {
      if (name === "ws_123:write-admission") {
        return Response.json({ accepted: true });
      }
      return Response.json(
        { opId: "op_bulk", status: "queued", targetRevision: "rev_bulk" },
        { status: 202 },
      );
    });
    const bareResponse = await app.fetch(
      authorizedRequest(
        "https://relayfile.test/v1/workspaces/ws_123/fs/bulk",
        signJwt(["fs:write"]),
        {
          method: "POST",
          ...jsonBodyInit({
            files: [
              {
                path: "/elsewhere/file.md",
                content: "hello",
                contentType: "text/markdown",
              },
            ],
          }),
        },
      ),
      bare.env,
    );

    expect(bareResponse.status).toBe(202);
    expect(
      bare.calls.some((call) => call.name === "ws_123:write-admission"),
    ).toBe(true);
    expect(bare.calls.some((call) => call.name === "ws_123")).toBe(true);

    const scoped = createTestEnv(async (_request, name) => {
      if (name === "ws_123:write-admission") {
        return Response.json({ accepted: true });
      }
      return Response.json(
        { opId: "op_bulk", status: "queued", targetRevision: "rev_bulk" },
        { status: 202 },
      );
    });
    const scopedAllowedResponse = await app.fetch(
      authorizedRequest(
        "https://relayfile.test/v1/workspaces/ws_123/fs/bulk",
        scopedWriteToken(),
        {
          method: "POST",
          ...jsonBodyInit({
            files: [
              {
                path: "/allowed/file.md",
                content: "hello",
                contentType: "text/markdown",
              },
            ],
          }),
        },
      ),
      scoped.env,
    );

    expect(scopedAllowedResponse.status).toBe(202);
    expect(
      scoped.calls.some((call) => call.name === "ws_123:write-admission"),
    ).toBe(true);
    expect(scoped.calls.some((call) => call.name === "ws_123")).toBe(true);

    const scopedDenied = createTestEnv();
    const scopedDeniedResponse = await app.fetch(
      authorizedRequest(
        "https://relayfile.test/v1/workspaces/ws_123/fs/bulk",
        scopedWriteToken(),
        {
          method: "POST",
          ...jsonBodyInit({
            files: [
              {
                path: "/elsewhere/file.md",
                content: "hello",
                contentType: "text/markdown",
              },
            ],
          }),
        },
      ),
      scopedDenied.env,
    );

    expect(scopedDeniedResponse.status).toBe(403);
    expect(scopedDenied.calls).toHaveLength(0);

    const slackAlias = createTestEnv(async (_request, name) => {
      if (name === "ws_123:write-admission") {
        return Response.json({ accepted: true });
      }
      return Response.json(
        { opId: "op_bulk", status: "queued", targetRevision: "rev_bulk" },
        { status: 202 },
      );
    });
    const slackAliasToken = signJwt([
      "fs:write",
      "workspace:slack-comms:write:/slack/channels/C0B902XR6PN__epic-pear-cloud-relay-execution/messages/**",
    ]);
    const slackAliasResponse = await app.fetch(
      authorizedRequest(
        "https://relayfile.test/v1/workspaces/ws_123/fs/bulk",
        slackAliasToken,
        {
          method: "POST",
          ...jsonBodyInit({
            files: [
              {
                path: "/slack/channels/C0B902XR6PN/messages/integration-wave-back.json",
                content: "hello",
                contentType: "application/json",
              },
            ],
          }),
        },
      ),
      slackAlias.env,
    );

    expect(slackAliasResponse.status).toBe(202);
    expect(
      slackAlias.calls.some((call) => call.name === "ws_123:write-admission"),
    ).toBe(true);
    expect(slackAlias.calls.some((call) => call.name === "ws_123")).toBe(true);

    const slackDmDenied = createTestEnv();
    const slackDmDeniedResponse = await app.fetch(
      authorizedRequest(
        "https://relayfile.test/v1/workspaces/ws_123/fs/bulk",
        slackAliasToken,
        {
          method: "POST",
          ...jsonBodyInit({
            files: [
              {
                path: "/slack/channels/D0B2MHP6E3T/messages/1780871703_094399.json",
                content: "hello",
                contentType: "application/json",
              },
            ],
          }),
        },
      ),
      slackDmDenied.env,
    );

    expect(slackDmDeniedResponse.status).toBe(403);
    expect(slackDmDenied.calls).toHaveLength(0);
  });

  it("routes provider fs/bulk writes to the same shard as provider reads", async () => {
    const { env, calls } = createTestEnv(async (request, name) => {
      if (name === "ws_123:write-admission") {
        return Response.json({ accepted: true });
      }
      expect(name).toBe("ws_123:linear");
      const body = (await request.json()) as { files?: unknown[] };
      return Response.json(
        {
          written: body.files?.length ?? 0,
          errorCount: 0,
          errors: [],
          correlationId: "corr_bulk_shard",
        },
        { status: 202 },
      );
    });
    env.RELAYFILE_SHARDED_WORKSPACE = "*";

    const response = await app.fetch(
      authorizedRequest(
        "https://relayfile.test/v1/workspaces/ws_123/fs/bulk",
        signJwt(["fs:write"]),
        {
          method: "POST",
          ...jsonBodyInit({
            files: [
              {
                path: "/linear/labels/label-1.json",
                content: '{"id":"label-1"}',
                contentType: "application/json",
                encoding: "utf-8",
              },
              {
                path: "/linear/labels/by-name/bug.json",
                content: '{"id":"label-1"}',
                contentType: "application/json",
                encoding: "utf-8",
              },
            ],
          }),
        },
      ),
      env,
    );
    const body = (await response.json()) as { written: number };

    expect(response.status).toBe(202);
    expect(body.written).toBe(2);
    expect(calls.map((call) => call.name)).toEqual([
      "ws_123:write-admission",
      "ws_123:linear",
    ]);
  });

  it("routes provider fs/bulk, fs/file, and fs/tree through the same shard", async () => {
    const bucketGet = vi.fn(async () => {
      const content = '{"id":"label-1"}';
      return {
        async arrayBuffer() {
          return new TextEncoder().encode(content).buffer;
        },
        async text() {
          return content;
        },
      } as R2ObjectBody;
    });
    const { env, calls } = createTestEnv(async (request, name) => {
      if (name === "ws_123:write-admission") {
        return Response.json({ accepted: true });
      }
      expect(name).toBe("ws_123:linear");

      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname.endsWith("/fs/bulk")) {
        const body = (await request.json()) as {
          files?: Array<{ path: string }>;
        };
        expect(body.files?.map((file) => file.path)).toEqual([
          "/linear/labels/label-1.json",
          "/linear/labels/_index.json",
        ]);
        return Response.json(
          {
            written: body.files?.length ?? 0,
            errorCount: 0,
            errors: [],
            correlationId: "corr_linear_labels",
          },
          { status: 202 },
        );
      }

      if (
        request.method === "POST" &&
        url.pathname === "/internal/read-file-metadata"
      ) {
        const body = (await request.json()) as { path: string };
        expect(body.path).toBe("/linear/labels/label-1.json");
        return Response.json(
          {
            path: "/linear/labels/label-1.json",
            revision: "rev_label_1",
            contentType: "application/json",
            contentRef: "content/ws_123/linear/labels/label-1.json@rev_label_1",
            encoding: "utf-8",
            provider: "linear",
            providerObjectId: "label-1",
            lastEditedAt: "2026-06-18T00:00:00.000Z",
            semantics: {},
          },
          { headers: { ETag: "rev_label_1" } },
        );
      }

      if (request.method === "GET" && url.pathname.endsWith("/fs/tree")) {
        expect(url.searchParams.get("path")).toBe("/linear/labels");
        return Response.json({
          path: "/linear/labels",
          files: [
            { path: "/linear/labels/label-1.json", type: "file" },
            { path: "/linear/labels/_index.json", type: "file" },
          ],
        });
      }

      throw new Error(`unexpected request ${request.method} ${url.pathname}`);
    });
    env.RELAYFILE_SHARDED_WORKSPACE = "*";
    env.CONTENT_BUCKET = { get: bucketGet } as unknown as R2Bucket;

    const writeResponse = await app.fetch(
      authorizedRequest(
        "https://relayfile.test/v1/workspaces/ws_123/fs/bulk",
        signJwt(["fs:write"]),
        {
          method: "POST",
          ...jsonBodyInit({
            files: [
              {
                path: "/linear/labels/label-1.json",
                content: '{"id":"label-1"}',
                contentType: "application/json",
                encoding: "utf-8",
              },
              {
                path: "/linear/labels/_index.json",
                content: '{"items":[{"id":"label-1"}]}',
                contentType: "application/json",
                encoding: "utf-8",
              },
            ],
          }),
        },
      ),
      env,
    );
    const writeBody = (await writeResponse.json()) as { written: number };

    const readResponse = await app.fetch(
      authorizedRequest(
        "https://relayfile.test/v1/workspaces/ws_123/fs/file?path=/linear/labels/label-1.json",
        signJwt(["fs:read"]),
      ),
      env,
    );
    const readBody = (await readResponse.json()) as {
      path: string;
      content: string;
    };

    const treeResponse = await app.fetch(
      authorizedRequest(
        "https://relayfile.test/v1/workspaces/ws_123/fs/tree?path=/linear/labels",
        signJwt(["fs:read"]),
      ),
      env,
    );
    const treeBody = (await treeResponse.json()) as {
      files: Array<{ path: string }>;
    };

    expect(writeResponse.status).toBe(202);
    expect(writeBody.written).toBe(2);
    expect(readResponse.status).toBe(200);
    expect(readBody).toMatchObject({
      path: "/linear/labels/label-1.json",
      content: '{"id":"label-1"}',
    });
    expect(treeResponse.status).toBe(200);
    expect(treeBody.files.map((file) => file.path)).toEqual([
      "/linear/labels/label-1.json",
      "/linear/labels/_index.json",
    ]);
    expect(calls.map((call) => call.name)).toEqual([
      "ws_123:write-admission",
      "ws_123:linear",
      "ws_123:linear",
      "ws_123:linear",
    ]);
  });

  it("keeps GitHub repo-root fs/tree on the coordinator path until fan-out is wired", async () => {
    const { env, calls } = createTestEnv(async (_request, name) => {
      expect(name).toBe("ws_123");
      return Response.json({
        path: "/github/repos/AgentWorkforce/cloud",
        files: [],
      });
    });
    env.RELAYFILE_SHARDED_WORKSPACE = "*";

    const response = await app.fetch(
      authorizedRequest(
        "https://relayfile.test/v1/workspaces/ws_123/fs/tree?path=/github/repos/AgentWorkforce/cloud",
        signJwt(["fs:read"]),
      ),
      env,
    );
    const body = (await response.json()) as { path: string };

    expect(response.status).toBe(200);
    expect(body.path).toBe("/github/repos/AgentWorkforce/cloud");
    expect(calls.map((call) => call.name)).toEqual(["ws_123"]);
  });

  it("fans mixed-provider fs/bulk writes out to each provider shard", async () => {
    const { env, calls } = createTestEnv(async (request, name) => {
      if (name === "ws_123:write-admission") {
        return Response.json({ accepted: true });
      }
      const body = (await request.json()) as { files?: unknown[] };
      return Response.json(
        {
          written: body.files?.length ?? 0,
          errorCount: 0,
          errors: [],
          correlationId: "corr_bulk_shard",
          bytesWritten: body.files?.length ?? 0,
          syncCount: 1,
        },
        { status: 202 },
      );
    });
    env.RELAYFILE_SHARDED_WORKSPACE = "*";

    const response = await app.fetch(
      authorizedRequest(
        "https://relayfile.test/v1/workspaces/ws_123/fs/bulk",
        signJwt(["fs:write"]),
        {
          method: "POST",
          ...jsonBodyInit({
            files: [
              {
                path: "/linear/labels/label-1.json",
                content: '{"id":"label-1"}',
                contentType: "application/json",
                encoding: "utf-8",
              },
              {
                path: "/notion/pages/page-1.json",
                content: '{"id":"page-1"}',
                contentType: "application/json",
                encoding: "utf-8",
              },
            ],
          }),
        },
      ),
      env,
    );
    const body = (await response.json()) as {
      written: number;
      errorCount: number;
      bytesWritten: number;
      syncCount: number;
    };

    expect(response.status).toBe(202);
    expect(body).toMatchObject({
      written: 2,
      errorCount: 0,
      bytesWritten: 2,
      syncCount: 2,
    });
    expect(calls.map((call) => call.name).sort()).toEqual([
      "ws_123:linear",
      "ws_123:notion",
      "ws_123:write-admission",
    ]);
  });

  it("rejects path-scoped fs/bulk oversize bodies before write admission", async () => {
    const { env, calls } = createTestEnv();
    const response = await app.fetch(
      authorizedRequest(
        "https://relayfile.test/v1/workspaces/ws_123/fs/bulk",
        scopedWriteToken(),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": String(50 * 1024 * 1024),
          },
          body: "{}",
        },
      ),
      env,
    );
    const body = (await response.json()) as { code: string };

    expect(response.status).toBe(413);
    expect(body.code).toBe("payload_too_large");
    expect(calls).toHaveLength(0);
  });

  it("rejects path-scoped fs/bulk without Content-Length before write admission", async () => {
    const { env, calls } = createTestEnv();
    const response = await app.fetch(
      authorizedRequest(
        "https://relayfile.test/v1/workspaces/ws_123/fs/bulk",
        scopedWriteToken(),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Transfer-Encoding": "chunked",
          },
        },
      ),
      env,
    );
    const body = (await response.json()) as { code: string };

    expect(response.status).toBe(411);
    expect(body.code).toBe("length_required");
    expect(calls).toHaveLength(0);
  });

  it("classifies dispatch claim paths as foreground control for write admission", async () => {
    const { env, calls } = createTestEnv(
      async () =>
        new Response(
          JSON.stringify({
            opId: "op_claim",
            status: "queued",
            targetRevision: "rev_claim",
          }),
          {
            status: 202,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );

    const token = signJwt(["fs:write"]);
    const response = await app.fetch(
      new Request(
        "https://relayfile.test/v1/workspaces/ws_123/fs/file?path=/github/_agents/cloud-small-issue-codex/dispatch-claims/issues/AgentWorkforce__cloud__1290.json",
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "If-Match": "rev_1",
            "X-Correlation-Id": "corr_claim",
          },
          body: JSON.stringify({
            content: "{}",
            contentType: "application/json",
          }),
        },
      ),
      env,
    );

    expect(response.status).toBe(202);
    await expect(
      calls
        .find((call) => call.name === "ws_123:write-admission")
        ?.request.json(),
    ).resolves.toMatchObject({
      workspaceId: "ws_123",
      purpose: "fs_file_put",
      writeClass: "foreground_control",
    });
  });

  it("classifies dispatch claim deletes as foreground control for write admission", async () => {
    const { env, calls } = createTestEnv(
      async () =>
        new Response(
          JSON.stringify({
            opId: "op_claim_delete",
            status: "queued",
            targetRevision: "rev_claim_delete",
          }),
          {
            status: 202,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );

    const token = signJwt(["fs:write"]);
    const response = await app.fetch(
      new Request(
        "https://relayfile.test/v1/workspaces/ws_123/fs/file?path=/github/_agents/cloud-small-issue-codex/dispatch-claims/issues/AgentWorkforce__cloud__1290.json",
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${token}`,
            "X-Correlation-Id": "corr_claim_delete",
          },
        },
      ),
      env,
    );

    expect(response.status).toBe(202);
    await expect(
      calls
        .find((call) => call.name === "ws_123:write-admission")
        ?.request.json(),
    ).resolves.toMatchObject({
      workspaceId: "ws_123",
      purpose: "fs_file_delete",
      writeClass: "foreground_control",
    });
  });

  it("honors explicit zero write-admission lane reservations", async () => {
    const { env, calls } = createTestEnv(
      async () =>
        new Response(
          JSON.stringify({
            opId: "op_zero",
            status: "queued",
            targetRevision: "rev_zero",
          }),
          {
            status: 202,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
    Object.assign(env, {
      RELAYFILE_WRITE_ADMISSION_FOREGROUND_RESERVED: "0",
      RELAYFILE_WRITE_ADMISSION_BACKGROUND_MAX: "0",
    });

    const token = signJwt(["fs:write"]);
    const response = await app.fetch(
      new Request("https://relayfile.test/v1/workspaces/ws_123/fs/file", {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "If-Match": "rev_1",
          "X-Correlation-Id": "corr_zero",
        },
        body: JSON.stringify({
          content: "# zero",
          contentType: "text/markdown",
        }),
      }),
      env,
    );

    expect(response.status).toBe(202);
    await expect(
      calls
        .find((call) => call.name === "ws_123:write-admission")
        ?.request.json(),
    ).resolves.toMatchObject({
      foregroundReserved: 0,
      backgroundMax: 0,
    });
  });

  it("retries foreground content write admission 429s using Retry-After before forwarding", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const executionCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;
    const { env, calls } = createTestEnv(async (_request, name) => {
      if (name === "ws_123:write-admission") {
        const admissionAttempts = calls.filter(
          (call) => call.name === "ws_123:write-admission",
        ).length;
        if (admissionAttempts === 1) {
          return new Response(
            JSON.stringify({
              code: "workspace_busy",
              reason: "write_admission_limit",
            }),
            {
              status: 429,
              headers: {
                "Content-Type": "application/json",
                "Retry-After": "0.25",
              },
            },
          );
        }
        return new Response(JSON.stringify({ ok: true, leaseId: "lease_2" }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          opId: "op_retry",
          status: "queued",
          targetRevision: "rev_retry",
        }),
        {
          status: 202,
          headers: { "Content-Type": "application/json" },
        },
      );
    });

    const token = signJwt(["fs:write"]);
    const responsePromise = app.fetch(
      new Request(
        "https://relayfile.test/v1/workspaces/ws_123/fs/file?path=/docs/retry.md",
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "If-Match": "rev_1",
            "X-Correlation-Id": "corr_retry",
          },
          body: JSON.stringify({
            content: "# retry",
            contentType: "text/markdown",
          }),
        },
      ),
      env,
      executionCtx,
    );

    try {
      await vi.waitFor(() =>
        expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 250),
      );
      await vi.advanceTimersByTimeAsync(250);
      const response = await responsePromise;

      expect(response.status).toBe(202);
      expect(
        calls.filter((call) => call.name === "ws_123:write-admission"),
      ).toHaveLength(3);
      expect(calls.filter((call) => call.name === "ws_123")).toHaveLength(1);
      expect(executionCtx.waitUntil).toHaveBeenCalledTimes(1);
    } finally {
      setTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("caps foreground content Retry-After sleeps before retrying admission", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const executionCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;
    const { env, calls } = createTestEnv(async (_request, name) => {
      if (name === "ws_123:write-admission") {
        const admissionAttempts = calls.filter(
          (call) => call.name === "ws_123:write-admission",
        ).length;
        if (admissionAttempts === 1) {
          return new Response(
            JSON.stringify({
              code: "workspace_busy",
              reason: "write_admission_limit",
            }),
            {
              status: 429,
              headers: {
                "Content-Type": "application/json",
                "Retry-After": "3600",
              },
            },
          );
        }
        return new Response(JSON.stringify({ ok: true, leaseId: "lease_3" }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          opId: "op_retry_cap",
          status: "queued",
          targetRevision: "rev_retry_cap",
        }),
        {
          status: 202,
          headers: { "Content-Type": "application/json" },
        },
      );
    });

    const token = signJwt(["fs:write"]);
    const responsePromise = app.fetch(
      new Request(
        "https://relayfile.test/v1/workspaces/ws_123/fs/file?path=/docs/retry-cap.md",
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "If-Match": "rev_1",
            "X-Correlation-Id": "corr_retry_cap",
          },
          body: JSON.stringify({
            content: "# retry cap",
            contentType: "text/markdown",
          }),
        },
      ),
      env,
      executionCtx,
    );

    try {
      await vi.waitFor(() =>
        expect(setTimeoutSpy).toHaveBeenCalledWith(
          expect.any(Function),
          30_000,
        ),
      );
      await vi.advanceTimersByTimeAsync(30_000);
      const response = await responsePromise;

      expect(response.status).toBe(202);
      expect(
        calls.filter((call) => call.name === "ws_123:write-admission"),
      ).toHaveLength(3);
    } finally {
      setTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not retry best-effort foreground control write admission 429s", async () => {
    const { env, calls } = createTestEnv(async (_request, name) => {
      if (name === "ws_123:write-admission") {
        return new Response(
          JSON.stringify({
            code: "workspace_busy",
            reason: "write_admission_limit",
          }),
          {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": "0",
            },
          },
        );
      }
      throw new Error("workspace DO should not receive rejected claim writes");
    });

    const token = signJwt(["fs:write"]);
    const response = await app.fetch(
      new Request(
        "https://relayfile.test/v1/workspaces/ws_123/fs/file?path=/github/_agents/cloud-small-issue-codex/dispatch-claims/issues/AgentWorkforce__cloud__1290.json",
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "If-Match": "0",
            "X-Correlation-Id": "corr_claim_busy",
          },
          body: JSON.stringify({
            content: "{}",
            contentType: "application/json",
          }),
        },
      ),
      env,
    );

    expect(response.status).toBe(429);
    expect(
      calls.filter((call) => call.name === "ws_123:write-admission"),
    ).toHaveLength(1);
    expect(calls.filter((call) => call.name === "ws_123")).toHaveLength(0);
  });

  it.each(["nango-sync-worker", "nango-sync-workflow"])(
    "classifies provider sync writes from %s as background integration for write admission",
    async (agentName) => {
      const { env, calls } = createTestEnv(
        async () =>
          new Response(
            JSON.stringify({
              opId: "op_sync",
              status: "queued",
              targetRevision: "rev_sync",
            }),
            {
              status: 202,
              headers: { "Content-Type": "application/json" },
            },
          ),
      );

      const token = signJwt(["fs:write"], "ws_123", agentName);
      const response = await app.fetch(
        new Request(
          "https://relayfile.test/v1/workspaces/ws_123/fs/file?path=/notion/pages/page_1.json",
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              "If-Match": "rev_1",
              "X-Correlation-Id": "corr_sync_write",
            },
            body: JSON.stringify({
              content: "{}",
              contentType: "application/json",
            }),
          },
        ),
        env,
      );

      expect(response.status).toBe(202);
      await expect(
        calls
          .find((call) => call.name === "ws_123:write-admission")
          ?.request.json(),
      ).resolves.toMatchObject({
        workspaceId: "ws_123",
        purpose: "fs_file_put",
        writeClass: "background_integration",
      });
    },
  );

  it("translates WorkspaceDO overload throws on public filesystem routes to 429", async () => {
    const { env, calls } = createTestEnv(async () => {
      throw new Error(
        "Durable Object is overloaded. Requests queued for too long.",
      );
    });
    (
      env as typeof env & { RELAYFILE_DO_RETRY_AFTER_SECONDS: string }
    ).RELAYFILE_DO_RETRY_AFTER_SECONDS = "7";

    const token = signJwt(["fs:read"]);
    const response = await app.fetch(
      new Request("https://relayfile.test/v1/workspaces/ws_123/fs/tree", {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Correlation-Id": "corr_overloaded",
        },
      }),
      env,
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("7");
    expect(body.code).toBe("workspace_busy");
    expect(body.reason).toBe("durable_object_overloaded");
    expect(body.correlationId).toBe("corr_overloaded");
    expect(calls).toHaveLength(1);
  });

  it("verifies internal webhook HMACs before forwarding", async () => {
    const { env, calls } = createTestEnv(
      async () =>
        new Response(
          JSON.stringify({
            status: "queued",
            id: "env_1",
            correlationId: "corr_123",
          }),
          {
            status: 202,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );

    const payload = JSON.stringify({
      envelopeId: "env_1",
      workspaceId: "ws_123",
      provider: "github",
      deliveryId: "delivery_1",
      receivedAt: "2026-03-25T10:00:00.000Z",
      correlationId: "corr_123",
      payload: {
        event_type: "file.updated",
        path: "/docs/readme.md",
        data: {
          content: "# updated",
        },
      },
    });
    const timestamp = new Date().toISOString();
    const signature = signInternalRequest(timestamp, payload);

    const response = await app.fetch(
      new Request("https://relayfile.test/v1/internal/webhook-envelopes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Correlation-Id": "corr_123",
          "X-Relay-Timestamp": timestamp,
          "X-Relay-Signature": signature,
        },
        body: payload,
      }),
      env,
    );

    expect(response.status).toBe(202);
    expect(calls.some((call) => call.name === "ws_123:write-admission")).toBe(
      true,
    );
    await expect(
      calls
        .find((call) => call.name === "ws_123:write-admission")
        ?.request.json(),
    ).resolves.toMatchObject({
      workspaceId: "ws_123",
      purpose: "webhook_envelope",
      writeClass: "background_integration",
    });
    expect(calls.filter((call) => call.name === "ws_123")).toHaveLength(1);
  });

  it("returns write-admission 429 before forwarding an internal webhook envelope", async () => {
    const { env, calls } = createTestEnv(async (_request, name) => {
      if (name === "ws_123:write-admission") {
        return new Response(
          JSON.stringify({
            code: "workspace_busy",
            reason: "workspace_write_inflight_limit",
            correlationId: "corr_123",
          }),
          {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": "5",
            },
          },
        );
      }
      throw new Error(
        "workspace DO should not be called when admission rejects",
      );
    });

    const payload = JSON.stringify({
      envelopeId: "env_busy",
      workspaceId: "ws_123",
      provider: "github",
      deliveryId: "delivery_busy",
      receivedAt: "2026-03-25T10:00:00.000Z",
      correlationId: "corr_123",
      payload: {
        event_type: "file.updated",
        path: "/github/repos/AgentWorkforce/cloud/issues/1240/meta.json",
        data: { content: "{}" },
      },
    });
    const timestamp = new Date().toISOString();
    const signature = signInternalRequest(timestamp, payload);

    const response = await app.fetch(
      new Request("https://relayfile.test/v1/internal/webhook-envelopes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Correlation-Id": "corr_123",
          "X-Relay-Timestamp": timestamp,
          "X-Relay-Signature": signature,
        },
        body: payload,
      }),
      env,
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("5");
    expect(calls.filter((call) => call.name === "ws_123")).toHaveLength(0);
    expect(
      calls.filter((call) => call.name === "ws_123:write-admission"),
    ).toHaveLength(1);
  });

  it("uses sync:trigger for generic webhook ingestion and forwards to the workspace durable object", async () => {
    const { env, calls } = createTestEnv(
      async () =>
        new Response(
          JSON.stringify({
            status: "queued",
            id: "env_2",
            correlationId: "corr_456",
          }),
          {
            status: 202,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );

    const token = signJwt(["sync:trigger"]);
    const response = await app.fetch(
      new Request(
        "https://relayfile.test/v1/workspaces/ws_123/webhooks/ingest",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "X-Correlation-Id": "corr_456",
          },
          body: JSON.stringify({
            provider: "github",
            event_type: "file.updated",
            path: "/docs/readme.md",
            data: {
              content: "# updated",
            },
          }),
        },
      ),
      env,
    );

    expect(response.status).toBe(202);
    expect(calls.some((call) => call.name === "ws_123:write-admission")).toBe(
      true,
    );
    expect(calls.filter((call) => call.name === "ws_123")).toHaveLength(1);
  });

  it("registers outbound webhook subscriptions with path-scoped fs:read authorization", async () => {
    const { env, calls } = createTestEnv(async (request) => {
      const body = await request.json();
      return new Response(
        JSON.stringify({
          subscriptionId: "whsub_1",
          echoed: body,
        }),
        {
          status: 201,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
    env.RELAYFILE_WEBHOOK_HOST_ALLOWLIST = "factory.example.com";
    const token = signJwt(["workspace:mount-sponsor:read:/linear/issues/**"]);

    const response = await app.fetch(
      authorizedRequest(
        "https://relayfile.test/v1/workspaces/ws_123/webhooks",
        token,
        {
          method: "POST",
          ...jsonBodyInit({
            url: "https://factory.example.com/hooks/relayfile#ignored",
            pathGlobs: ["/linear/issues/**"],
          }),
        },
      ),
      env,
    );
    const body = (await response.json()) as {
      subscriptionId: string;
      echoed: { url: string; pathGlobs: string[] };
    };

    expect(response.status).toBe(201);
    expect(body.subscriptionId).toBe("whsub_1");
    expect(body.echoed).toEqual({
      url: "https://factory.example.com/hooks/relayfile",
      pathGlobs: ["/linear/issues/**"],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].request.url).toBe(
      "https://relayfile.test/v1/workspaces/ws_123/webhooks",
    );
  });

  it("rejects outbound webhook URLs that are not safe public https endpoints", async () => {
    const { env, calls } = createTestEnv();
    const token = signJwt(["fs:read"]);

    const response = await app.fetch(
      authorizedRequest(
        "https://relayfile.test/v1/workspaces/ws_123/webhooks",
        token,
        {
          method: "POST",
          ...jsonBodyInit({
            url: "https://127.0.0.1/hooks/relayfile",
            pathGlobs: ["/**"],
          }),
        },
      ),
      env,
    );
    const body = (await response.json()) as { code: string; message: string };

    expect(response.status).toBe(400);
    expect(body.code).toBe("invalid_webhook_url");
    expect(body.message).toContain("host is not allowed");
    expect(calls).toHaveLength(0);
  });

  it("requires fs:read on every subscribed outbound webhook path glob", async () => {
    const { env, calls } = createTestEnv();
    const token = signJwt(["workspace:mount-sponsor:read:/linear/issues/**"]);

    const response = await app.fetch(
      authorizedRequest(
        "https://relayfile.test/v1/workspaces/ws_123/webhooks",
        token,
        {
          method: "POST",
          ...jsonBodyInit({
            url: "https://factory.example.com/hooks/relayfile",
            pathGlobs: ["/slack/channels/**"],
          }),
        },
      ),
      env,
    );
    const body = (await response.json()) as { code: string; message: string };

    expect(response.status).toBe(403);
    expect(body.code).toBe("forbidden");
    expect(body.message).toContain("fs:read");
    expect(calls).toHaveLength(0);
  });

  it("requires exact workspace-wide fs:read for outbound webhook admin routes", async () => {
    const { env, calls } = createTestEnv();
    const narrowToken = signJwt([
      "workspace:mount-sponsor:read:/linear/issues/**",
    ]);

    const denied = await app.fetch(
      authorizedRequest(
        "https://relayfile.test/v1/workspaces/ws_123/webhooks",
        narrowToken,
      ),
      env,
    );
    const deniedBody = (await denied.json()) as {
      code: string;
      message: string;
    };

    expect(denied.status).toBe(403);
    expect(deniedBody.code).toBe("forbidden");
    expect(deniedBody.message).toContain("fs:read");
    expect(calls).toHaveLength(0);

    const pathScopedToken = signJwt(["relayfile:fs:read:/linear/issues/**"]);
    const pathScopedDenied = await app.fetch(
      authorizedRequest(
        "https://relayfile.test/v1/workspaces/ws_123/webhooks",
        pathScopedToken,
      ),
      env,
    );
    const pathScopedDeniedBody = (await pathScopedDenied.json()) as {
      code: string;
      message: string;
    };

    expect(pathScopedDenied.status).toBe(403);
    expect(pathScopedDeniedBody.code).toBe("forbidden");
    expect(pathScopedDeniedBody.message).toContain("fs:read");
    expect(calls).toHaveLength(0);

    const deletePathScopedToken = signJwt([
      "relayfile:fs:read:/linear/issues/**",
    ]);
    const deletePathScopedDenied = await app.fetch(
      authorizedRequest(
        "https://relayfile.test/v1/workspaces/ws_123/webhooks/whsub_1",
        deletePathScopedToken,
        { method: "DELETE" },
      ),
      env,
    );
    const deletePathScopedDeniedBody =
      (await deletePathScopedDenied.json()) as {
        code: string;
        message: string;
      };

    expect(deletePathScopedDenied.status).toBe(403);
    expect(deletePathScopedDeniedBody.code).toBe("forbidden");
    expect(deletePathScopedDeniedBody.message).toContain("fs:read");
    expect(calls).toHaveLength(0);

    const workspaceWideToken = signJwt(["fs:read"]);
    const allowed = await app.fetch(
      authorizedRequest(
        "https://relayfile.test/v1/workspaces/ws_123/webhooks",
        workspaceWideToken,
      ),
      env,
    );

    expect(allowed.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("hydrates fs/file content in the parent Worker after DO metadata authorization", async () => {
    const bucketGet = vi.fn(async (key: string) => {
      expect(key).toBe("content/ws_123/docs/readme.md@rev_2");
      return {
        async arrayBuffer() {
          return new TextEncoder().encode("# readme").buffer;
        },
        async text() {
          return "# readme";
        },
      } as R2ObjectBody;
    });
    const { env, calls } = createTestEnv(async (request) => {
      expect(new URL(request.url).pathname).toBe(
        "/internal/read-file-metadata",
      );
      const body = (await request.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        workspaceId: "ws_123",
        path: "/docs/readme.md",
      });
      return Response.json(
        {
          path: "/docs/readme.md",
          revision: "rev_2",
          contentType: "text/markdown",
          contentRef: "content/ws_123/docs/readme.md@rev_2",
          encoding: "utf-8",
          provider: "notion",
          lastEditedAt: "2026-05-27T08:00:00.000Z",
          semantics: {},
          contentHash: "a".repeat(64),
        },
        { headers: { ETag: "rev_2" } },
      );
    });
    env.CONTENT_BUCKET = { get: bucketGet } as unknown as R2Bucket;

    const token = signJwt(["fs:read"]);
    const response = await app.fetch(
      new Request(
        "https://relayfile.test/v1/workspaces/ws_123/fs/file?path=/docs/readme.md",
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "X-Correlation-Id": "corr_read",
          },
        },
      ),
      env,
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get("ETag")).toBe("rev_2");
    expect(body.content).toBe("# readme");
    expect(body.contentHash).toBe("a".repeat(64));
    expect(bucketGet).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(1);
  });

  it("returns 304 for matching If-None-Match without reading R2", async () => {
    const metrics: Array<{
      name: string;
      value: number;
      labels?: Record<string, string | number | boolean>;
    }> = [];
    const previousEmitter = setMetricEmitter({
      emit(name, value, labels) {
        metrics.push({ name, value, labels });
      },
    });
    const bucketGet = vi.fn();
    const { env, calls } = createTestEnv(async () =>
      Response.json(
        {
          path: "/docs/readme.md",
          revision: "rev_2",
          contentType: "text/markdown",
          contentRef: "content/ws_123/docs/readme.md@rev_2",
          encoding: "utf-8",
          provider: "notion",
          lastEditedAt: "2026-05-27T08:00:00.000Z",
          semantics: {},
        },
        { headers: { ETag: "rev_2" } },
      ),
    );
    env.CONTENT_BUCKET = { get: bucketGet } as unknown as R2Bucket;

    try {
      const token = signJwt(["fs:read"]);
      const response = await app.fetch(
        new Request(
          "https://relayfile.test/v1/workspaces/ws_123/fs/file?path=/docs/readme.md",
          {
            headers: {
              Authorization: `Bearer ${token}`,
              "If-None-Match": '"rev_2"',
              "X-Correlation-Id": "corr_read_304",
            },
          },
        ),
        env,
      );

      expect(response.status).toBe(304);
      expect(response.headers.get("ETag")).toBe("rev_2");
      expect(await response.text()).toBe("");
      expect(bucketGet).not.toHaveBeenCalled();
      expect(calls).toHaveLength(1);
      expect(metrics).toContainEqual({
        name: "relayfile_worker_fs_file_not_modified_total",
        value: 1,
        labels: { workspace_id: "ws_123" },
      });
      expect(metrics).toContainEqual({
        name: "relayfile_worker_route_requests_total",
        value: 1,
        labels: {
          route: "GET /v1/workspaces/:workspaceId/fs/file",
          method: "GET",
          status: 304,
          workspace_id: "ws_123",
        },
      });
    } finally {
      setMetricEmitter(previousEmitter);
    }
  });

  it("bulk-reads files through parent Worker R2 hydration", async () => {
    const bucketGet = vi.fn(async (key: string) => {
      const bodyByKey: Record<string, string> = {
        "content/ws_123/allowed/a.md@rev_a": "# a",
        "content/ws_123/allowed/b.md@rev_b": "# b",
      };
      return {
        async arrayBuffer() {
          return new TextEncoder().encode(bodyByKey[key]).buffer;
        },
        async text() {
          return bodyByKey[key];
        },
      } as R2ObjectBody;
    });
    const { env, calls } = createTestEnv(async (request) => {
      expect(new URL(request.url).pathname).toBe(
        "/internal/read-file-metadata",
      );
      const body = (await request.json()) as { path: string };
      const name = body.path.endsWith("/a.md") ? "a" : "b";
      return Response.json(
        {
          path: body.path,
          revision: `rev_${name}`,
          contentType: "text/markdown",
          contentRef: `content/ws_123${body.path}@rev_${name}`,
          encoding: "utf-8",
          provider: "github",
          lastEditedAt: "2026-06-17T00:00:00.000Z",
          semantics: {},
        },
        { headers: { ETag: `rev_${name}` } },
      );
    });
    env.CONTENT_BUCKET = { get: bucketGet } as unknown as R2Bucket;

    const response = await app.fetch(
      authorizedRequest(
        "https://relayfile.test/v1/workspaces/ws_123/fs/bulk-read",
        scopedReadToken(),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            paths: ["/allowed/a.md", "/allowed/b.md"],
          }),
        },
      ),
      env,
    );
    const body = (await response.json()) as {
      files: Array<{ path: string; content: string }>;
    };

    expect(response.status).toBe(200);
    expect(body.files).toEqual([
      expect.objectContaining({ path: "/allowed/a.md", content: "# a" }),
      expect.objectContaining({ path: "/allowed/b.md", content: "# b" }),
    ]);
    expect(bucketGet).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(2);
  });

  it("rejects bulk-read paths outside a path-scoped mount token", async () => {
    const { env, calls } = createTestEnv();
    const response = await app.fetch(
      authorizedRequest(
        "https://relayfile.test/v1/workspaces/ws_123/fs/bulk-read",
        scopedReadToken(),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            paths: ["/allowed/a.md", "/secret/b.md"],
          }),
        },
      ),
      env,
    );
    const body = (await response.json()) as { code: string };

    expect(response.status).toBe(403);
    expect(body.code).toBe("forbidden");
    expect(calls).toHaveLength(0);
  });

  it("serves virtual activity summary through the Worker fs/file path without R2", async () => {
    const bucketGet = vi.fn();
    const { env } = createTestEnv(async () =>
      Response.json({
        path: "/.skills/activity-summary.md",
        revision: "runtime_activity_summary_v1",
        contentType: "text/markdown; charset=utf-8",
        contentRef: "runtime:activity-summary",
        encoding: "utf-8",
        provider: "runtime",
        providerObjectId: "activity-summary",
        lastEditedAt: "2026-05-18T00:00:00.000Z",
        semantics: {},
      }),
    );
    env.CONTENT_BUCKET = { get: bucketGet } as unknown as R2Bucket;

    const token = signJwt(["fs:read"]);
    const response = await app.fetch(
      new Request(
        "https://relayfile.test/v1/workspaces/ws_123/fs/file?path=/.skills/activity-summary.md",
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "X-Correlation-Id": "corr_runtime",
          },
        },
      ),
      env,
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(String(body.content)).toContain("/digests/today.md");
    expect(bucketGet).not.toHaveBeenCalled();
  });

  it("enforces path-scoped mount tokens on fs/file reads", async () => {
    const bucketGet = vi.fn(async (key: string) => {
      expect(key).toBe("content/ws_123/allowed/readme.md@rev_1");
      return {
        async arrayBuffer() {
          return new TextEncoder().encode("# allowed").buffer;
        },
        async text() {
          return "# allowed";
        },
      } as R2ObjectBody;
    });
    const { env, calls } = createTestEnv(async (request) => {
      expect(new URL(request.url).pathname).toBe(
        "/internal/read-file-metadata",
      );
      const body = (await request.json()) as Record<string, unknown>;
      expect(body.path).toBe("/allowed/readme.md");
      return Response.json(
        {
          path: "/allowed/readme.md",
          revision: "rev_1",
          contentType: "text/markdown",
          contentRef: "content/ws_123/allowed/readme.md@rev_1",
          encoding: "utf-8",
          provider: "github",
          lastEditedAt: "2026-06-07T00:00:00.000Z",
          semantics: {},
        },
        { headers: { ETag: "rev_1" } },
      );
    });
    env.CONTENT_BUCKET = { get: bucketGet } as unknown as R2Bucket;

    const allowedResponse = await app.fetch(
      authorizedRequest(
        "https://relayfile.test/v1/workspaces/ws_123/fs/file?path=/allowed/readme.md",
        scopedReadToken(),
      ),
      env,
    );

    expect(allowedResponse.status).toBe(200);
    expect(
      ((await allowedResponse.json()) as Record<string, unknown>).content,
    ).toBe("# allowed");
    expect(calls).toHaveLength(1);

    const denied = createTestEnv();
    const deniedResponse = await app.fetch(
      authorizedRequest(
        "https://relayfile.test/v1/workspaces/ws_123/fs/file?path=/secret/readme.md",
        scopedReadToken(),
      ),
      denied.env,
    );

    expect(deniedResponse.status).toBe(403);
    expect(denied.calls).toHaveLength(0);
  });

  it("authorizes raw Slack channel fs/file reads under same-channel alias grants", async () => {
    const bucketGet = vi.fn(async (key: string) => {
      expect(key).toBe(
        "content/ws_123/slack/channels/C0B8ZL2L9GC/messages/1780847052.json@rev_1",
      );
      return {
        async arrayBuffer() {
          return new TextEncoder().encode('{"text":"ok"}').buffer;
        },
        async text() {
          return '{"text":"ok"}';
        },
      } as R2ObjectBody;
    });
    const { env, calls } = createTestEnv(async (request) => {
      expect(new URL(request.url).pathname).toBe(
        "/internal/read-file-metadata",
      );
      const body = (await request.json()) as Record<string, unknown>;
      expect(body.path).toBe(
        "/slack/channels/C0B8ZL2L9GC/messages/1780847052.json",
      );
      return Response.json(
        {
          path: "/slack/channels/C0B8ZL2L9GC/messages/1780847052.json",
          revision: "rev_1",
          contentType: "application/json",
          contentRef:
            "content/ws_123/slack/channels/C0B8ZL2L9GC/messages/1780847052.json@rev_1",
          encoding: "utf-8",
          provider: "slack",
          lastEditedAt: "2026-06-07T00:00:00.000Z",
          semantics: {},
        },
        { headers: { ETag: "rev_1" } },
      );
    });
    env.CONTENT_BUCKET = { get: bucketGet } as unknown as R2Bucket;
    const token = signJwt([
      "fs:read",
      "workspace:pear-integrations-slack-channels-C0B8ZL2L9GC__pear-pty-investigation-messages:read:/slack/channels/C0B8ZL2L9GC__pear-pty-investigation/messages/**",
    ]);

    const allowedResponse = await app.fetch(
      authorizedRequest(
        "https://relayfile.test/v1/workspaces/ws_123/fs/file?path=/slack/channels/C0B8ZL2L9GC/messages/1780847052.json",
        token,
      ),
      env,
    );

    expect(allowedResponse.status).toBe(200);
    expect(calls).toHaveLength(1);

    const denied = createTestEnv();
    const deniedResponse = await app.fetch(
      authorizedRequest(
        "https://relayfile.test/v1/workspaces/ws_123/fs/file?path=/slack/channels/COTHER/messages/1780847052.json",
        token,
      ),
      denied.env,
    );

    expect(deniedResponse.status).toBe(403);
    expect(denied.calls).toHaveLength(0);
  });

  it("enforces path-scoped mount tokens on fs/file writes", async () => {
    const { env, calls } = createTestEnv(async (_request, name) => {
      if (name === "ws_123:write-admission") {
        return Response.json({ accepted: true });
      }
      return Response.json(
        { opId: "op_allowed", status: "queued", targetRevision: "rev_2" },
        { status: 202 },
      );
    });

    const allowedResponse = await app.fetch(
      authorizedRequest(
        "https://relayfile.test/v1/workspaces/ws_123/fs/file?path=/allowed/write.md",
        scopedWriteToken(),
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "# write" }),
        },
      ),
      env,
    );

    expect(allowedResponse.status).toBe(202);
    expect(calls.some((call) => call.name === "ws_123:write-admission")).toBe(
      true,
    );
    expect(calls.some((call) => call.name === "ws_123")).toBe(true);

    const denied = createTestEnv();
    const deniedResponse = await app.fetch(
      authorizedRequest(
        "https://relayfile.test/v1/workspaces/ws_123/fs/file?path=/secret/write.md",
        scopedWriteToken(),
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "# denied" }),
        },
      ),
      denied.env,
    );

    expect(deniedResponse.status).toBe(403);
    expect(denied.calls).toHaveLength(0);
  });

  it("enforces path-scoped mount tokens on fs/tree, fs/query, and fs/export", async () => {
    const cases = [
      {
        route: "tree",
        insideUrl:
          "https://relayfile.test/v1/workspaces/ws_123/fs/tree?path=/allowed",
        outsideUrl:
          "https://relayfile.test/v1/workspaces/ws_123/fs/tree?path=/secret",
        omittedUrl: "https://relayfile.test/v1/workspaces/ws_123/fs/tree",
        allowsOmittedForScopedToken: true,
      },
      {
        route: "query",
        insideUrl:
          "https://relayfile.test/v1/workspaces/ws_123/fs/query?path=/allowed",
        outsideUrl:
          "https://relayfile.test/v1/workspaces/ws_123/fs/query?path=/secret",
        omittedUrl: "https://relayfile.test/v1/workspaces/ws_123/fs/query",
        allowsOmittedForScopedToken: true,
      },
      {
        route: "export",
        insideUrl:
          "https://relayfile.test/v1/workspaces/ws_123/fs/export?path=/allowed",
        outsideUrl:
          "https://relayfile.test/v1/workspaces/ws_123/fs/export?path=/secret",
        omittedUrl: "https://relayfile.test/v1/workspaces/ws_123/fs/export",
        allowsOmittedForScopedToken: false,
      },
    ];

    for (const testCase of cases) {
      const { env, calls } = createTestEnv(async (request) => {
        if (testCase.route === "export") {
          expect(new URL(request.url).pathname).toBe(
            "/internal/export-manifest",
          );
          return Response.json({
            fileCount: 0,
            entries: [],
            nextCursor: null,
          });
        }
        return Response.json({ ok: true, route: testCase.route });
      });

      const insideResponse = await app.fetch(
        authorizedRequest(testCase.insideUrl, scopedReadToken()),
        env,
      );

      expect(insideResponse.status).toBe(200);
      if (testCase.route === "export") {
        expect(await insideResponse.text()).toBe("[]");
      } else {
        expect(await insideResponse.json()).toMatchObject({
          ok: true,
          route: testCase.route,
        });
      }
      expect(calls).toHaveLength(1);

      const deniedUrls = [testCase.outsideUrl];
      if (!testCase.allowsOmittedForScopedToken) {
        deniedUrls.push(testCase.omittedUrl);
      }
      for (const deniedUrl of deniedUrls) {
        const denied = createTestEnv();
        const response = await app.fetch(
          authorizedRequest(deniedUrl, scopedReadToken()),
          denied.env,
        );

        expect(response.status).toBe(403);
        expect(denied.calls).toHaveLength(0);
      }

      if (testCase.allowsOmittedForScopedToken) {
        const omitted = createTestEnv(async () =>
          Response.json({ ok: true, route: testCase.route }),
        );
        const omittedResponse = await app.fetch(
          authorizedRequest(testCase.omittedUrl, scopedReadToken()),
          omitted.env,
        );

        expect(omittedResponse.status).toBe(200);
        expect(omitted.calls).toHaveLength(1);
      }

      const bare = createTestEnv(async () =>
        testCase.route === "export"
          ? Response.json({ fileCount: 0, entries: [], nextCursor: null })
          : Response.json({ ok: true }),
      );
      const bareResponse = await app.fetch(
        authorizedRequest(testCase.omittedUrl, signJwt(["fs:read"])),
        bare.env,
      );

      expect(bareResponse.status).toBe(200);
      expect(bare.calls).toHaveLength(1);
    }

    const conflictingExport = createTestEnv();
    const conflictingExportResponse = await app.fetch(
      authorizedRequest(
        "https://relayfile.test/v1/workspaces/ws_123/fs/export?path=/allowed&pathPrefix=/secret",
        scopedReadToken(),
      ),
      conflictingExport.env,
    );

    expect(conflictingExportResponse.status).toBe(403);
    expect(conflictingExport.calls).toHaveLength(0);
  });

  it("allows fs/events for path-scoped mount tokens and pure bare fs:read tokens", async () => {
    const scoped = createTestEnv();
    const scopedResponse = await app.fetch(
      authorizedRequest(
        "https://relayfile.test/v1/workspaces/ws_123/fs/events",
        scopedReadToken(),
      ),
      scoped.env,
    );

    expect(scopedResponse.status).toBe(200);
    expect(scoped.calls).toHaveLength(1);

    const bare = createTestEnv();
    const bareResponse = await app.fetch(
      authorizedRequest(
        "https://relayfile.test/v1/workspaces/ws_123/fs/events",
        signJwt(["fs:read"]),
      ),
      bare.env,
    );

    expect(bareResponse.status).toBe(200);
    expect(bare.calls).toHaveLength(1);
  });

  it("forwards fs/changes for listLastNChanges through the worker router", async () => {
    const { env, calls } = createTestEnv(async () =>
      Response.json({ events: [] }),
    );
    const response = await app.fetch(
      authorizedRequest(
        "https://relayfile.test/v1/workspaces/ws_123/fs/changes?last=1",
        signJwt(["fs:read"]),
      ),
      env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ events: [] });
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.request.url).pathname).toBe(
      "/v1/workspaces/ws_123/fs/changes",
    );

    const scoped = createTestEnv(async () => Response.json({ events: [] }));
    const scopedResponse = await app.fetch(
      authorizedRequest(
        "https://relayfile.test/v1/workspaces/ws_123/fs/changes?last=1",
        scopedReadToken(),
      ),
      scoped.env,
    );

    expect(scopedResponse.status).toBe(200);
    expect(scoped.calls).toHaveLength(1);
  });

  it("serves fs/changes in the wire shape consumed by RelayFileClient.listLastNChanges", async () => {
    const token = signJwt(["fs:read"]);
    const { env, calls } = createTestEnv(async () =>
      Response.json({
        events: [
          {
            id: "evt_123",
            workspace: "ws_123",
            type: "relayfile.changed",
            occurredAt: "2026-05-06T00:02:00.000Z",
            resource: {
              path: "/github/issues/new.json",
              kind: "github.issue",
              id: "new",
              provider: "github",
            },
            summary: {
              title: "new",
              fieldsChanged: ["file.updated"],
            },
            digest: "sha256:abc123",
          },
        ],
      }),
    );
    const client = new RelayFileClient({
      baseUrl: "https://relayfile.test",
      token,
      fetchImpl: async (input, init) =>
        app.fetch(new Request(input, init), env),
    });

    const result = await client.listLastNChanges(1, {
      workspaceId: "ws_123",
      token,
    });

    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.request.url).pathname).toBe(
      "/v1/workspaces/ws_123/fs/changes",
    );
    expect(result.events[0]?.id).toBe("evt_123");
    expect(result.events[0]?.resource.path).toBe("/github/issues/new.json");
    await expect(result.events[0]?.expand("summary")).resolves.toMatchObject({
      level: "summary",
      path: "/github/issues/new.json",
      summary: { title: "new" },
    });
  });

  it("accepts either admin scope for backend status", async () => {
    const { env, calls } = createTestEnv(
      async () =>
        new Response(
          JSON.stringify({
            backendProfile: "cloudflare-workers",
            stateBackend: "durable_object_sqlite+d1",
            envelopeQueue: "relayfile-envelopes-test",
            envelopeQueueDepth: 0,
            envelopeQueueCapacity: 10000,
            writebackQueue: "relayfile-writeback-test",
            writebackQueueDepth: 0,
            writebackQueueCapacity: 10000,
          }),
          {
            headers: { "Content-Type": "application/json" },
          },
        ),
    );

    const token = signJwt(["admin:replay"], "admin-workspace");
    const response = await app.fetch(
      new Request("https://relayfile.test/v1/admin/backends", {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Correlation-Id": "corr_admin",
        },
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("__admin__");
  });

  it("legacy-draft drain requires the admin:workspace scope (cloud#2029 #2)", async () => {
    const { env } = createTestEnv();
    const token = signJwt(["fs:read", "fs:write"], "rw_abcd1234");
    const response = await app.fetch(
      authorizedRequest(
        "https://relayfile.test/v1/workspaces/rw_abcd1234/admin/drain-legacy-writeback-drafts",
        token,
        {
          method: "POST",
          ...jsonBodyInit({
            commandRoots: ["/slack/channels/C/messages"],
            dryRun: true,
          }),
        },
      ),
      env,
    );
    expect(response.status).toBe(403);
  });

  it("legacy-draft drain forwards to the workspace DO drain handler with admin:workspace (cloud#2029 #2)", async () => {
    const { env, calls } = createTestEnv(
      async () =>
        new Response(
          JSON.stringify({ dryRun: true, scanned: 0, eligible: 0, removed: 0 }),
          { headers: { "Content-Type": "application/json" } },
        ),
    );
    const token = signJwt(["admin:workspace"], "rw_abcd1234");
    const response = await app.fetch(
      authorizedRequest(
        "https://relayfile.test/v1/workspaces/rw_abcd1234/admin/drain-legacy-writeback-drafts",
        token,
        {
          method: "POST",
          ...jsonBodyInit({
            commandRoots: ["/slack/channels/C/messages"],
            dryRun: true,
          }),
        },
      ),
      env,
    );
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    // Forwarded to the DO's internal drain handler (not a public path).
    expect(new URL(calls[0].request.url).pathname).toBe(
      "/internal/drain-legacy-writeback-drafts",
    );
  });

  it("DELETE /v1/workspaces/:id requires the admin:workspace scope", async () => {
    const { env } = createTestEnv();
    const token = signJwt(["fs:read", "fs:write"], "rw_abcd1234");
    const response = await app.fetch(
      new Request("https://relayfile.test/v1/workspaces/rw_abcd1234", {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Correlation-Id": "corr_del",
        },
      }),
      env,
    );
    expect(response.status).toBe(403);
  });

  it("DELETE /v1/workspaces/:id purges R2 + DO + D1 with admin:workspace", async () => {
    const deletedKeys: string[] = [];
    const bucket = {
      async list() {
        return { objects: [{ key: "rw_abcd1234/a@1" }], truncated: false };
      },
      async delete(keys: string[] | string) {
        deletedKeys.push(...(Array.isArray(keys) ? keys : [keys]));
      },
    } as unknown as R2Bucket;
    const db = {
      prepare() {
        return { bind: () => ({ run: async () => ({}) }) };
      },
      async batch(stmts: Array<{ run: () => Promise<unknown> }>) {
        await Promise.all(stmts.map((s) => s.run()));
        return [];
      },
    } as unknown as D1Database;

    const { env } = createTestEnv(
      async () =>
        new Response(JSON.stringify({ status: "cleaned" }), {
          headers: { "Content-Type": "application/json" },
        }),
    );
    env.CONTENT_BUCKET = bucket;
    env.DB = db;

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const token = signJwt(["admin:workspace"], "rw_abcd1234");
    const response = await app.fetch(
      new Request("https://relayfile.test/v1/workspaces/rw_abcd1234", {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Correlation-Id": "corr_del2",
        },
      }),
      env,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      workspaceId: string;
      deletedObjects: number;
      doCleaned: boolean;
      metadataCleaned: boolean;
    };
    expect(body.workspaceId).toBe("rw_abcd1234");
    expect(body.deletedObjects).toBe(1);
    expect(body.doCleaned).toBe(true);
    expect(body.metadataCleaned).toBe(true);
    expect(deletedKeys).toEqual(["rw_abcd1234/a@1"]);
    log.mockRestore();
  });
});
