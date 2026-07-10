import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("..", import.meta.url);
const script = new URL("../scripts/assert-nango-webhook-subscriptions.mjs", import.meta.url);

describe("assert-nango-webhook-subscriptions", () => {
  it("verifies matching declared and live webhook subscriptions", async () => {
    await withFixture(
      {
        declared: [
          {
            providerConfigKey: "github-relay",
            syncs: [
              {
                name: "fetch-open-issues",
                webhookSubscriptions: ["issues.labeled", "issues.opened"],
              },
            ],
          },
        ],
        live: [
          {
            providerConfigKey: "github-relay",
            syncs: [
              {
                name: "fetch-open-issues",
                webhookSubscriptions: ["issues.opened", "issues.labeled"],
              },
            ],
          },
        ],
      },
      async ({ configPath, serverUrl }) => {
        const { stdout } = await runVerifier(configPath, serverUrl, ["--providers", "github-relay"]);

        assert.match(stdout, /Verified 1 Nango webhook subscription sets/);
      },
    );
  });

  it("fails when live Nango still has a webhook subscription set removed from declarations", async () => {
    await withFixture(
      {
        declared: [
          {
            providerConfigKey: "github-relay",
            syncs: [],
          },
        ],
        live: [
          {
            providerConfigKey: "github-relay",
            syncs: [
              {
                name: "fetch-open-issues",
                webhookSubscriptions: ["issues.opened"],
              },
            ],
          },
        ],
      },
      async ({ configPath, serverUrl }) => {
        await assert.rejects(
          runVerifier(configPath, serverUrl, ["--providers", "github-relay"]),
          (error) => {
            assert.match(error.stderr, /extra live webhookSubscriptions \[issues.opened\]/);
            return true;
          },
        );
      },
    );
  });

  it("fails with duplicate live sync definitions before comparing webhook drift", async () => {
    await withFixture(
      {
        declared: [
          {
            providerConfigKey: "github-relay",
            syncs: [
              {
                name: "fetch-open-issues",
                webhookSubscriptions: ["issues.opened", "issues.labeled"],
              },
            ],
          },
        ],
        live: [
          {
            providerConfigKey: "github-relay",
            syncs: [
              {
                id: 3131278,
                name: "fetch-open-issues",
                input: "SyncMetadata_github_relay_fetchopenissues",
                last_deployed: "2026-06-14T13:33:27.007Z",
                webhookSubscriptions: ["issues.opened", "issues.labeled"],
              },
              {
                id: 2098375,
                name: "fetch-open-issues",
                input: "SyncMetadata_github_sage_fetchopenissues",
                last_deployed: "2026-04-20T11:35:25.718Z",
                webhookSubscriptions: ["issues.opened"],
              },
            ],
          },
        ],
      },
      async ({ configPath, serverUrl }) => {
        await assert.rejects(
          runVerifier(configPath, serverUrl, ["--providers", "github-relay"]),
          (error) => {
            assert.match(
              error.stderr,
              /github-relay:fetch-open-issues: duplicate live Nango webhook subscription definitions \(2 entries\)/,
            );
            assert.match(error.stderr, /id=3131278 input=SyncMetadata_github_relay_fetchopenissues/);
            assert.match(error.stderr, /id=2098375 input=SyncMetadata_github_sage_fetchopenissues/);
            assert.doesNotMatch(error.stderr, /github-relay:fetch-open-issues: webhookSubscriptions drift/);
            return true;
          },
        );
      },
    );
  });

  it("fails when declarations contain duplicate webhook-backed sync definitions", async () => {
    await withFixture(
      {
        declared: [
          {
            providerConfigKey: "github-relay",
            syncs: [
              {
                name: "fetch-open-issues",
                webhookSubscriptions: ["issues.opened"],
              },
              {
                name: "fetch-open-issues",
                webhookSubscriptions: ["issues.labeled"],
              },
            ],
          },
        ],
        live: [
          {
            providerConfigKey: "github-relay",
            syncs: [
              {
                name: "fetch-open-issues",
                webhookSubscriptions: ["issues.opened"],
              },
            ],
          },
        ],
      },
      async ({ configPath, serverUrl }) => {
        await assert.rejects(
          runVerifier(configPath, serverUrl, ["--providers", "github-relay"]),
          (error) => {
            assert.match(
              error.stderr,
              /github-relay:fetch-open-issues: duplicate declared Nango webhook subscription definitions \(2 entries\)/,
            );
            assert.doesNotMatch(error.stderr, /github-relay:fetch-open-issues: webhookSubscriptions drift/);
            return true;
          },
        );
      },
    );
  });

  it("retries transient live config request failures", async () => {
    let requests = 0;
    await withFixture(
      {
        declared: [
          {
            providerConfigKey: "github-relay",
            syncs: [
              {
                name: "fetch-open-issues",
                webhookSubscriptions: ["issues.opened"],
              },
            ],
          },
        ],
        live: () => {
          requests += 1;
          if (requests === 1) {
            return { status: 503, body: "try again" };
          }
          return [
            {
              providerConfigKey: "github-relay",
              syncs: [
                {
                  name: "fetch-open-issues",
                  webhookSubscriptions: ["issues.opened"],
                },
              ],
            },
          ];
        },
      },
      async ({ configPath, serverUrl }) => {
        const { stdout, stderr } = await runVerifier(configPath, serverUrl, [
          "--providers",
          "github-relay",
          "--retries",
          "2",
        ]);

        assert.match(stderr, /retrying in 0ms/);
        assert.match(stdout, /Verified 1 Nango webhook subscription sets/);
        assert.equal(requests, 2);
      },
    );
  });

  it("normalizes object-form syncs inside provider arrays", async () => {
    await withFixture(
      {
        declared: [
          {
            providerConfigKey: "github-relay",
            syncs: {
              "fetch-open-issues": {
                webhookSubscriptions: ["issues.opened"],
              },
            },
          },
        ],
        live: [
          {
            providerConfigKey: "github-relay",
            syncs: [
              {
                name: "fetch-open-issues",
                webhookSubscriptions: ["issues.opened"],
              },
            ],
          },
        ],
      },
      async ({ configPath, serverUrl }) => {
        const { stdout } = await runVerifier(configPath, serverUrl, ["--providers", "github-relay"]);

        assert.match(stdout, /Verified 1 Nango webhook subscription sets/);
      },
    );
  });

  it("normalizes hyphenated webhook subscription keys inside provider arrays", async () => {
    await withFixture(
      {
        declared: [
          {
            providerConfigKey: "github-relay",
            syncs: [
              {
                name: "fetch-open-issues",
                "webhook-subscriptions": ["issues.opened"],
              },
            ],
          },
        ],
        live: [
          {
            providerConfigKey: "github-relay",
            syncs: [
              {
                name: "fetch-open-issues",
                "webhook-subscriptions": ["issues.opened"],
              },
            ],
          },
        ],
      },
      async ({ configPath, serverUrl }) => {
        const { stdout } = await runVerifier(configPath, serverUrl, ["--providers", "github-relay"]);

        assert.match(stdout, /Verified 1 Nango webhook subscription sets/);
      },
    );
  });

  it("uses an environment-specific secret when --environment is provided", async () => {
    await withFixture(
      {
        declared: [
          {
            providerConfigKey: "github-relay",
            syncs: [
              {
                name: "fetch-open-issues",
                webhookSubscriptions: ["issues.opened"],
              },
            ],
          },
        ],
        live: [
          {
            providerConfigKey: "github-relay",
            syncs: [
              {
                name: "fetch-open-issues",
                webhookSubscriptions: ["issues.opened"],
              },
            ],
          },
        ],
        expectedAuthorization: "Bearer prod-secret",
      },
      async ({ configPath, serverUrl }) => {
        const { stdout } = await runVerifier(configPath, serverUrl, ["--environment", "production"], {
          NANGO_SECRET_KEY: "dev-secret",
          NANGO_SECRET_KEY_PROD: "prod-secret",
        });

        assert.match(stdout, /Verified 1 Nango webhook subscription sets/);
      },
    );
  });

  it("rejects zero retry attempts", async () => {
    await withFixture(
      {
        declared: [],
        live: [],
      },
      async ({ configPath, serverUrl }) => {
        await assert.rejects(
          runVerifier(configPath, serverUrl, ["--retries", "0"]),
          (error) => {
            assert.match(error.stderr, /--retries must be greater than 0/);
            return true;
          },
        );
      },
    );
  });
});

async function withFixture({ declared, live, expectedAuthorization = "Bearer test-secret" }, callback) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "nango-webhook-subscriptions-"));
  const configPath = path.join(tempDir, "nango.json");
  await writeFile(configPath, JSON.stringify(declared), "utf8");

  const server = createServer((request, response) => {
    if (request.url !== "/scripts/config") {
      response.writeHead(404).end();
      return;
    }

    assert.equal(request.headers.authorization, expectedAuthorization);
    const result = typeof live === "function" ? live() : live;
    if (result && typeof result === "object" && "status" in result) {
      response.writeHead(result.status, { "content-type": "text/plain" });
      response.end(result.body);
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(result));
  });

  try {
    const serverUrl = await listen(server);
    await callback({ configPath, serverUrl });
  } finally {
    await close(server);
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function runVerifier(configPath, serverUrl, extraArgs = [], extraEnv = {}) {
  return execFileAsync(
    process.execPath,
    [
      script.pathname,
      "--config",
      configPath,
      "--retries",
      "1",
      "--delay-ms",
      "0",
      ...extraArgs,
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        NANGO_SECRET_KEY: "test-secret",
        NANGO_API_URL: serverUrl,
        ...extraEnv,
      },
      encoding: "utf8",
    },
  );
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unexpected server address."));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
