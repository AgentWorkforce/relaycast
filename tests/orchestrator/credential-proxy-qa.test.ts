import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  getKnownCredentialMountPaths,
  resolveProxyCredentialEnv,
} from "../../packages/core/src/auth/cli-credentials.js";
import {
  mintCredentialProxyToken,
  PROXY_TOKEN_AUDIENCE,
  type ProxyTokenClaims,
} from "../../packages/core/src/auth/proxy-token.js";

type VerifiedProxyClaims = ProxyTokenClaims & {
  budget: number;
  exp: number;
};

type SandboxInvocationResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

const QA_PROXY_SECRET = "credential-proxy-qa-secret";
const QA_UPSTREAM_SECRET = "raw-provider-secret-anthropic";
const sandboxFixturePath = path.resolve(
  process.cwd(),
  "tests/fixtures/credential-proxy-sandbox-client.mjs",
);

const cleanupTasks = new Set<() => Promise<void>>();

afterEach(async () => {
  for (const task of cleanupTasks) {
    await task();
    cleanupTasks.delete(task);
  }
});

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + padding, "base64").toString("utf8");
}

function verifyProxyToken(token: string, secret: string): VerifiedProxyClaims {
  const [header, payload, signature] = token.split(".");
  if (!header || !payload || !signature) {
    throw new Error("invalid token format");
  }

  const expected = createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

  assert.equal(signature, expected, "proxy token signature mismatch");
  return JSON.parse(decodeBase64Url(payload)) as VerifiedProxyClaims;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body.length > 0 ? (JSON.parse(body) as unknown) : {};
}

async function startJsonServer(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
): Promise<{ server: ReturnType<typeof createServer>; baseUrl: string }> {
  const server = createServer((request, response) => {
    void handler(request, response).catch((error: unknown) => {
      response.statusCode = 500;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server did not expose a TCP address");
  }

  cleanupTasks.add(
    async () =>
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function runSandboxProcess(env: Record<string, string>): Promise<SandboxInvocationResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [sandboxFixturePath], {
      env: {
        PATH: process.env.PATH ?? "",
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
        HOME: env.HOME ?? process.env.HOME ?? tmpdir(),
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({
        exitCode,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
  });
}

describe("credential proxy QA path", () => {
  it("proves sandbox env is proxy-only while provider calls still succeed", async () => {
    const providerRequests: Array<{ authorization: string | undefined; body: unknown }> = [];
    const proxyRequests: Array<{ authorization: string | undefined; claims: VerifiedProxyClaims }> = [];

    const provider = await startJsonServer(async (request, response) => {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/messages");

      providerRequests.push({
        authorization: request.headers.authorization,
        body: await readJsonBody(request),
      });

      response.statusCode = request.headers.authorization === `Bearer ${QA_UPSTREAM_SECRET}` ? 200 : 401;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          ok: response.statusCode === 200,
          adapter: "anthropic",
        }),
      );
    });

    const remainingBudget = new Map<string, number>();
    const proxy = await startJsonServer(async (request, response) => {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/messages");

      const authorization = request.headers.authorization;
      assert.ok(authorization?.startsWith("Bearer "), "sandbox must call proxy with bearer auth");
      const token = authorization!.slice("Bearer ".length);
      const claims = verifyProxyToken(token, QA_PROXY_SECRET);

      assert.equal(claims.aud, PROXY_TOKEN_AUDIENCE);
      assert.equal(claims.provider, "anthropic");
      assert.equal(claims.credentialId, "user-qa");
      assert.ok(claims.exp > Math.floor(Date.now() / 1000));

      const currentBudget = remainingBudget.get(token) ?? claims.budget;
      if (currentBudget <= 0) {
        response.statusCode = 429;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ error: "budget exhausted" }));
        return;
      }

      remainingBudget.set(token, currentBudget - 1);
      proxyRequests.push({ authorization, claims });

      const upstreamResponse = await fetch(`${provider.baseUrl}${request.url}`, {
        method: request.method,
        headers: {
          Authorization: `Bearer ${QA_UPSTREAM_SECRET}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(await readJsonBody(request)),
      });

      response.statusCode = upstreamResponse.status;
      response.setHeader("content-type", upstreamResponse.headers.get("content-type") ?? "application/json");
      response.end(await upstreamResponse.text());
    });

    const sandboxHome = await mkdtemp(path.join(tmpdir(), "credential-proxy-qa-"));
    cleanupTasks.add(async () => {
      await rm(sandboxHome, { recursive: true, force: true });
    });

    const token = await mintCredentialProxyToken({
      subject: "workspace-qa",
      provider: "anthropic",
      credentialId: "user-qa",
      secret: QA_PROXY_SECRET,
      budget: 2,
      ttlSeconds: 300,
    });

    const result = await runSandboxProcess({
      HOME: sandboxHome,
      ...resolveProxyCredentialEnv("claude", proxy.baseUrl, token),
      QA_CREDENTIAL_PATHS: JSON.stringify(getKnownCredentialMountPaths(sandboxHome)),
      QA_REQUEST_COUNT: "1",
    });

    assert.equal(result.exitCode, 0, result.stderr);
    const output = JSON.parse(result.stdout) as {
      envSnapshot: Record<string, string>;
      fileChecks: Array<{ path: string; exists: boolean }>;
      responses: Array<{ status: number; body: { ok?: boolean } }>;
    };

    assert.deepEqual(
      Object.keys(output.envSnapshot).sort(),
      [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_BASE_URL",
        "CREDENTIAL_PROXY_TOKEN",
        "CREDENTIAL_PROXY_URL",
      ],
    );
    assert.ok(output.fileChecks.every((entry) => entry.exists === false));
    assert.equal(output.responses.length, 1);
    assert.equal(output.responses[0]?.status, 200);
    assert.equal(output.responses[0]?.body.ok, true);

    assert.equal(proxyRequests.length, 1);
    assert.equal(providerRequests.length, 1);
    assert.equal(providerRequests[0]?.authorization, `Bearer ${QA_UPSTREAM_SECRET}`);
  });

  it("enforces proxy budget without leaking the upstream secret into the sandbox", async () => {
    const providerRequests: Array<{ authorization: string | undefined }> = [];

    const provider = await startJsonServer(async (request, response) => {
      providerRequests.push({ authorization: request.headers.authorization });
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true }));
    });

    const remainingBudget = new Map<string, number>();
    const proxy = await startJsonServer(async (request, response) => {
      const authorization = request.headers.authorization;
      assert.ok(authorization?.startsWith("Bearer "), "sandbox must call proxy with bearer auth");
      const token = authorization!.slice("Bearer ".length);
      const claims = verifyProxyToken(token, QA_PROXY_SECRET);
      const currentBudget = remainingBudget.get(token) ?? claims.budget;

      if (currentBudget <= 0) {
        response.statusCode = 429;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ error: "budget exhausted" }));
        return;
      }

      remainingBudget.set(token, currentBudget - 1);
      const upstream = await fetch(`${provider.baseUrl}${request.url}`, {
        method: request.method,
        headers: {
          Authorization: `Bearer ${QA_UPSTREAM_SECRET}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(await readJsonBody(request)),
      });

      response.statusCode = upstream.status;
      response.setHeader("content-type", "application/json");
      response.end(await upstream.text());
    });

    const sandboxHome = await mkdtemp(path.join(tmpdir(), "credential-proxy-budget-"));
    cleanupTasks.add(async () => {
      await rm(sandboxHome, { recursive: true, force: true });
    });

    const token = await mintCredentialProxyToken({
      subject: "workspace-qa",
      provider: "anthropic",
      credentialId: "user-qa",
      secret: QA_PROXY_SECRET,
      budget: 1,
      ttlSeconds: 300,
    });

    const result = await runSandboxProcess({
      HOME: sandboxHome,
      ...resolveProxyCredentialEnv("claude", proxy.baseUrl, token),
      QA_CREDENTIAL_PATHS: JSON.stringify(getKnownCredentialMountPaths(sandboxHome)),
      QA_REQUEST_COUNT: "2",
    });

    assert.equal(result.exitCode, 0, result.stderr);
    const output = JSON.parse(result.stdout) as {
      responses: Array<{ status: number }>;
    };

    assert.deepEqual(
      output.responses.map((entry) => entry.status),
      [200, 429],
    );
    assert.equal(providerRequests.length, 1);
    assert.equal(providerRequests[0]?.authorization, `Bearer ${QA_UPSTREAM_SECRET}`);
  });

  it("rejects expired proxy tokens before the provider adapter is called", async () => {
    let providerCalls = 0;

    const provider = await startJsonServer(async (_request, response) => {
      providerCalls += 1;
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true }));
    });

    const proxy = await startJsonServer(async (request, response) => {
      const authorization = request.headers.authorization;
      assert.ok(authorization?.startsWith("Bearer "), "sandbox must call proxy with bearer auth");
      const claims = verifyProxyToken(authorization!.slice("Bearer ".length), QA_PROXY_SECRET);

      if (claims.exp <= Math.floor(Date.now() / 1000)) {
        response.statusCode = 401;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ error: "token expired" }));
        return;
      }

      const upstream = await fetch(`${provider.baseUrl}${request.url}`, {
        method: request.method,
        headers: {
          Authorization: `Bearer ${QA_UPSTREAM_SECRET}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(await readJsonBody(request)),
      });

      response.statusCode = upstream.status;
      response.setHeader("content-type", "application/json");
      response.end(await upstream.text());
    });

    const sandboxHome = await mkdtemp(path.join(tmpdir(), "credential-proxy-expired-"));
    cleanupTasks.add(async () => {
      await rm(sandboxHome, { recursive: true, force: true });
    });

    const token = [
      encodeBase64Url(JSON.stringify({ alg: "HS256", typ: "JWT" })),
      encodeBase64Url(
        JSON.stringify({
          aud: PROXY_TOKEN_AUDIENCE,
          sub: "workspace-qa",
          provider: "anthropic",
          credentialId: "user-qa",
          budget: 1,
          iat: Math.floor(Date.now() / 1000) - 120,
          exp: Math.floor(Date.now() / 1000) - 60,
        } satisfies VerifiedProxyClaims),
      ),
    ].join(".");
    const expiredSignature = createHmac("sha256", QA_PROXY_SECRET)
      .update(token)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
    const expiredToken = `${token}.${expiredSignature}`;

    const result = await runSandboxProcess({
      HOME: sandboxHome,
      ...resolveProxyCredentialEnv("claude", proxy.baseUrl, expiredToken),
      QA_CREDENTIAL_PATHS: JSON.stringify(getKnownCredentialMountPaths(sandboxHome)),
      QA_REQUEST_COUNT: "1",
    });

    assert.equal(result.exitCode, 0, result.stderr);
    const output = JSON.parse(result.stdout) as {
      responses: Array<{ status: number; body: { error?: string } }>;
    };

    assert.deepEqual(output.responses.map((entry) => entry.status), [401]);
    assert.equal(output.responses[0]?.body.error, "token expired");
    assert.equal(providerCalls, 0);
  });
});
