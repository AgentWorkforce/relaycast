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
const script = new URL("../scripts/refresh-nango-webhook-syncs.mjs", import.meta.url);

describe("refresh-nango-webhook-syncs", () => {
  it("pauses and restarts webhook-backed syncs for the selected provider", async () => {
    const requests = [];
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
              {
                name: "fetch-open-pull-requests",
                webhookSubscriptions: ["pull_request.opened"],
              },
              {
                name: "fetch-repositories",
                webhookSubscriptions: [],
              },
            ],
          },
          {
            providerConfigKey: "slack-relay",
            syncs: [
              {
                name: "fetch-channels",
                webhookSubscriptions: ["channel_created"],
              },
            ],
          },
        ],
        requests,
      },
      async ({ configPath, serverUrl }) => {
        const { stdout } = await runRefresh(configPath, serverUrl, ["--providers", "github-relay"]);

        assert.match(stdout, /Refreshed 1 Nango webhook sync schedule set/);
        assert.deepEqual(requests, [
          {
            path: "/sync/pause",
            body: {
              provider_config_key: "github-relay",
              syncs: ["fetch-open-issues", "fetch-open-pull-requests"],
            },
          },
          {
            path: "/sync/start",
            body: {
              provider_config_key: "github-relay",
              syncs: ["fetch-open-issues", "fetch-open-pull-requests"],
            },
          },
        ]);
      },
    );
  });

  it("normalizes object-form sync declarations", async () => {
    const requests = [];
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
        requests,
      },
      async ({ configPath, serverUrl }) => {
        const { stdout } = await runRefresh(configPath, serverUrl);

        assert.match(stdout, /Refreshed 1 Nango webhook sync schedule set/);
        assert.deepEqual(requests.map((request) => request.body.syncs), [["fetch-open-issues"], ["fetch-open-issues"]]);
      },
    );
  });

  it("skips API calls when no webhook-backed syncs match the provider filter", async () => {
    const requests = [];
    await withFixture(
      {
        declared: [
          {
            providerConfigKey: "github-relay",
            syncs: [
              {
                name: "fetch-repositories",
                webhookSubscriptions: [],
              },
            ],
          },
        ],
        requests,
      },
      async ({ configPath, serverUrl }) => {
        const { stdout } = await runRefresh(configPath, serverUrl, ["--providers", "github-relay"]);

        assert.match(stdout, /No Nango webhook-backed syncs matched/);
        assert.deepEqual(requests, []);
      },
    );
  });

  it("uses an environment-specific secret when --environment is provided", async () => {
    const requests = [];
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
        requests,
        expectedAuthorization: "Bearer prod-secret",
      },
      async ({ configPath, serverUrl }) => {
        const { stdout } = await runRefresh(configPath, serverUrl, ["--environment", "production"], {
          NANGO_SECRET_KEY: "dev-secret",
          NANGO_SECRET_KEY_PROD: "prod-secret",
        });

        assert.match(stdout, /Refreshed 1 Nango webhook sync schedule set/);
      },
    );
  });

  it("fails when Nango rejects a sync command", async () => {
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
        requests: [],
        failurePath: "/sync/pause",
      },
      async ({ configPath, serverUrl }) => {
        await assert.rejects(
          runRefresh(configPath, serverUrl),
          (error) => {
            assert.match(error.stderr, /Nango sync pause request failed for github-relay/);
            return true;
          },
        );
      },
    );
  });

  it("warns and continues when Nango has no existing sync schedules", async () => {
    const requests = [];
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
        requests,
        failurePath: "/sync/pause",
        failureBody: JSON.stringify({ error: { code: "no_syncs_found" } }),
      },
      async ({ configPath, serverUrl }) => {
        const { stderr, stdout } = await runRefresh(configPath, serverUrl);

        assert.match(stderr, /no sync schedules for github-relay/);
        assert.match(stdout, /Refreshed 1 Nango webhook sync schedule set/);
        assert.deepEqual(requests.map((request) => request.path), ["/sync/pause", "/sync/start"]);
      },
    );
  });
});

async function withFixture(
  { declared, requests, expectedAuthorization = "Bearer test-secret", failurePath, failureBody = "try again later" },
  callback,
) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "nango-webhook-refresh-"));
  const configPath = path.join(tempDir, "nango.json");
  await writeFile(configPath, JSON.stringify(declared), "utf8");

  const server = createServer(async (request, response) => {
    if (request.url !== "/sync/pause" && request.url !== "/sync/start") {
      response.writeHead(404).end();
      return;
    }

    assert.equal(request.headers.authorization, expectedAuthorization);
    const body = JSON.parse(await readRequestBody(request));
    requests.push({ path: request.url, body });

    if (request.url === failurePath) {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(failureBody);
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ success: true }));
  });

  try {
    const serverUrl = await listen(server);
    await callback({ configPath, serverUrl });
  } finally {
    await close(server);
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function runRefresh(configPath, serverUrl, extraArgs = [], extraEnv = {}) {
  return execFileAsync(
    process.execPath,
    [
      script.pathname,
      "--config",
      configPath,
      "--pause-delay-ms",
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

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
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
