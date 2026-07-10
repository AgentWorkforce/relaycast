import test from "node:test";
import assert from "node:assert/strict";

import {
  default as router,
  getMountPrefix,
  getOrigin,
  getUpstreamPath,
  isWebhookWorkerPath,
  readWebhookOriginFlag,
  rewriteLocation,
  shouldUseNangoWebhookWorkerRoute,
} from "../packages/router/index.js";

const env = {
  CLOUD_APP_ORIGIN: "https://cloud-web.internal",
  FILE_OBSERVER_ORIGIN: "https://file-observer.internal",
};

function executionContext(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  } as ExecutionContext;
}

function createRecorder(): {
  env: {
    TRAFFIC_RECORDER: R2Bucket;
    ROUTER_CONFIG: { get(key: string): Promise<string | null> };
  };
  puts: Array<{ key: string; value: string }>;
  waits: Promise<unknown>[];
} {
  const puts: Array<{ key: string; value: string }> = [];
  const waits: Promise<unknown>[] = [];

  return {
    env: {
      TRAFFIC_RECORDER: {
        async put(key: string, value: string) {
          puts.push({ key, value });
        },
      } as unknown as R2Bucket,
      ROUTER_CONFIG: {
        async get(key: string) {
          if (key === "WEBHOOK_ORIGIN") return null;
          if (key === "RECORDER_SAMPLE_RATE") return "100";
          return null;
        },
      },
    },
    puts,
    waits,
  };
}

function recorderExecutionContext(waits: Promise<unknown>[]): ExecutionContext {
  return {
    waitUntil(promise: Promise<unknown>) {
      waits.push(promise);
    },
    passThroughOnException() {},
    props: {},
  } as ExecutionContext;
}

test("agentrelay.com observer routes stay on Relaycast observer", () => {
  assert.equal(
    getOrigin("agentrelay.com", "/observer", env),
    "https://observer.relaycast.dev",
  );
  assert.equal(
    getOrigin("agentrelay.com", "/observer/session/123", env),
    "https://observer.relaycast.dev",
  );
});

test("agentrelay.com file observer routes go to RelayFile observer", () => {
  assert.equal(
    getOrigin("agentrelay.com", "/observer/file", env),
    env.FILE_OBSERVER_ORIGIN,
  );
  assert.equal(
    getOrigin("agentrelay.com", "/observer/file/workspaces", env),
    env.FILE_OBSERVER_ORIGIN,
  );
});

test("agentrelay.com cloud routes go to the cloud app upstream origin", () => {
  assert.equal(
    getOrigin("agentrelay.com", "/cloud", env),
    env.CLOUD_APP_ORIGIN,
  );
  assert.equal(
    getOrigin("agentrelay.com", "/cloud/dashboard", env),
    env.CLOUD_APP_ORIGIN,
  );
});

test("agentrelay.com non-cloud, non-observer routes fall back to the relay web origin", () => {
  assert.equal(
    getOrigin("agentrelay.com", "/", env),
    "https://origin-web.agentrelay.com",
  );
  assert.equal(
    getOrigin("agentrelay.com", "/pricing", env),
    "https://origin-web.agentrelay.com",
  );
});

test("paths that only share the prefix do not match", () => {
  assert.equal(
    getOrigin("agentrelay.com", "/cloudflare", env),
    "https://origin-web.agentrelay.com",
  );
  assert.equal(
    getOrigin("agentrelay.com", "/observers", env),
    "https://origin-web.agentrelay.com",
  );
  assert.equal(
    getOrigin("agentrelay.com", "/observer-files", env),
    "https://origin-web.agentrelay.com",
  );
});

test("cloud routes work on any host", () => {
  assert.equal(
    getOrigin("staging.agentrelay.com", "/cloud", env),
    env.CLOUD_APP_ORIGIN,
  );
  assert.equal(
    getOrigin("example.com", "/cloud/dashboard", env),
    env.CLOUD_APP_ORIGIN,
  );
});

test("cloud routes preserve the /cloud prefix upstream", () => {
  assert.equal(getUpstreamPath("agentrelay.com", "/cloud"), "/cloud");
  assert.equal(getUpstreamPath("agentrelay.com", "/cloud/dashboard"), "/cloud/dashboard");
});

test("agentrelay.com file observer routes strip the public mount prefix upstream", () => {
  assert.equal(getUpstreamPath("agentrelay.com", "/observer/file"), "/");
  assert.equal(getUpstreamPath("agentrelay.com", "/observer/file/dashboard"), "/dashboard");
  assert.equal(getUpstreamPath("agentrelay.com", "/observer/file/_next/static/app.js"), "/_next/static/app.js");
});

test("non-apex file observer-looking routes preserve their path upstream", () => {
  assert.equal(getUpstreamPath("staging.agentrelay.com", "/observer/file"), "/observer/file");
  assert.equal(getUpstreamPath("example.com", "/observer/file/dashboard"), "/observer/file/dashboard");
});

test("file observer mount prefix is only set when routed to file observer origin", () => {
  assert.equal(getMountPrefix("agentrelay.com", "/observer/file"), "/observer/file");
  assert.equal(getMountPrefix("agentrelay.com", "/observer/file/dashboard"), "/observer/file");
  assert.equal(getMountPrefix("staging.agentrelay.com", "/observer/file"), "");
  assert.equal(getMountPrefix("example.com", "/observer/file/dashboard"), "");
});

test("cloud redirects to the public file observer are not re-prefixed", () => {
  assert.equal(
    rewriteLocation(
      "https://agentrelay.com/observer/file#workspaceId=workspace-a",
      new URL("https://agentrelay.com"),
      "agentrelay.com",
      "https:",
      "/cloud",
    ),
    "https://agentrelay.com/observer/file#workspaceId=workspace-a",
  );
  assert.equal(
    rewriteLocation(
      "/observer/file#workspaceId=workspace-a",
      new URL("https://agentrelay.com"),
      "agentrelay.com",
      "https:",
      "/cloud",
    ),
    "/observer/file#workspaceId=workspace-a",
  );
});

test("cloud redirects outside the file observer still keep the cloud prefix", () => {
  assert.equal(
    rewriteLocation(
      "https://agentrelay.com/dashboard",
      new URL("https://agentrelay.com"),
      "agentrelay.com",
      "https:",
      "/cloud",
    ),
    "https://agentrelay.com/cloud/dashboard",
  );
  assert.equal(
    rewriteLocation(
      "/dashboard",
      new URL("https://agentrelay.com"),
      "agentrelay.com",
      "https:",
      "/cloud",
    ),
    "/cloud/dashboard",
  );
});

test("non-apex hosts use the fallback proxy for non-cloud paths", () => {
  assert.equal(
    getOrigin("example.com", "/observer", env),
    "https://origin-web.agentrelay.com",
  );
  assert.equal(
    getOrigin("staging.agentrelay.com", "/pricing", env),
    "https://origin-web.agentrelay.com",
  );
});

test("fallback proxy uses only the corrected relay web origin", async () => {
  const originalFetch = globalThis.fetch;
  const upstreamRequests: string[] = [];

  globalThis.fetch = (async (request: RequestInfo | URL) => {
    const requestUrl = request instanceof Request ? request.url : request.toString();
    upstreamRequests.push(requestUrl);
    return new Response("origin-ok");
  }) as typeof fetch;

  try {
    const response = await router.fetch(
      new Request("https://agentrelay.com/"),
      env,
      executionContext(),
    );

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "origin-ok");
    assert.deepEqual(upstreamRequests, ["https://origin-web.agentrelay.com/"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("isWebhookWorkerPath matches only the four exact handler paths", () => {
  // Exact handler paths — must route to the worker when the flag is set.
  assert.equal(isWebhookWorkerPath("/api/v1/webhooks/composio"), true);
  assert.equal(isWebhookWorkerPath("/api/v1/webhooks/github"), true);
  assert.equal(isWebhookWorkerPath("/api/v1/webhooks/hookdeck"), true);
  assert.equal(isWebhookWorkerPath("/api/v1/webhooks/nango"), true);
  assert.equal(isWebhookWorkerPath("/cloud/api/v1/webhooks/nango"), true);
});

test("isWebhookWorkerPath excludes sub-paths that have no worker handler", () => {
  // Regression: the Composio OAuth callback is a Next.js GET route. The router
  // must not forward it to the webhook worker (which would return 404).
  assert.equal(
    isWebhookWorkerPath("/api/v1/webhooks/composio/connect/callback"),
    false,
  );
  assert.equal(
    isWebhookWorkerPath("/cloud/api/v1/webhooks/composio/connect/callback"),
    false,
  );
  assert.equal(isWebhookWorkerPath("/api/v1/webhooks/github/extra"), false);
  assert.equal(isWebhookWorkerPath("/api/v1/webhooks/nango/sync"), false);
  assert.equal(isWebhookWorkerPath("/api/v1/webhooks/unknown"), false);
  assert.equal(isWebhookWorkerPath("/api/v1/webhooks"), false);
  assert.equal(isWebhookWorkerPath("/api/v1/webhooks/"), false);
  assert.equal(isWebhookWorkerPath("/api/v1/other"), false);
});

test("nango webhook worker route scaffold is inert with the flag unset", async () => {
  const envWithNoFlag = {
    ...env,
    ROUTER_CONFIG: {
      async get(key: string) {
        assert.equal(key, "WEBHOOK_ORIGIN");
        return null;
      },
    },
  };

  assert.equal(await readWebhookOriginFlag(envWithNoFlag), null);
  assert.equal(
    await shouldUseNangoWebhookWorkerRoute("/cloud/api/v1/webhooks/nango", envWithNoFlag),
    false,
  );
  assert.equal(
    getOrigin("agentrelay.com", "/cloud/api/v1/webhooks/nango", envWithNoFlag),
    env.CLOUD_APP_ORIGIN,
  );
});

test("nango webhook worker route is gated by WEBHOOK_ORIGIN=worker", async () => {
  const envWithFlag = {
    ...env,
    ROUTER_CONFIG: {
      async get(key: string) {
        assert.equal(key, "WEBHOOK_ORIGIN");
        return "worker";
      },
    },
  };

  assert.equal(
    await shouldUseNangoWebhookWorkerRoute("/cloud/api/v1/webhooks/nango", envWithFlag),
    true,
  );
  assert.equal(
    await shouldUseNangoWebhookWorkerRoute("/api/v1/webhooks/nango", envWithFlag),
    true,
  );
  assert.equal(
    await shouldUseNangoWebhookWorkerRoute("/cloud/api/v1/webhooks/github", envWithFlag),
    false,
  );
  assert.equal(
    await shouldUseNangoWebhookWorkerRoute("/cloud/api/v1/webhooks/hookdeck", envWithFlag),
    false,
  );
  assert.equal(
    await shouldUseNangoWebhookWorkerRoute("/cloud/api/v1/webhooks/composio", envWithFlag),
    false,
  );
});

test("cloud routes use cloud-web worker without reading cloudOrigin", async () => {
  const configReads: string[] = [];
  const logs: string[] = [];
  const originalConsoleLog = console.log;
  let cloudWebCalls = 0;
  const testEnv = {
    ...env,
    ROUTER_CONFIG: {
      async get(key: string) {
        configReads.push(key);
        return null;
      },
    },
    CLOUD_WEB_WORKER: {
      async fetch() {
        cloudWebCalls += 1;
        return new Response("cloud-web");
      },
    },
  };

  console.log = ((message?: unknown) => {
    logs.push(String(message));
  }) as typeof console.log;

  try {
    const firstResponse = await router.fetch(
      new Request("https://agentrelay.com/cloud/dashboard"),
      testEnv,
      executionContext(),
    );
    const secondResponse = await router.fetch(
      new Request("https://agentrelay.com/cloud/settings"),
      testEnv,
      executionContext(),
    );

    assert.equal(await firstResponse.text(), "cloud-web");
    assert.equal(await secondResponse.text(), "cloud-web");
  } finally {
    console.log = originalConsoleLog;
  }

  assert.equal(cloudWebCalls, 2);
  assert.equal(configReads.includes("cloudOrigin"), false);
  assert.deepEqual(logs.map((line) => JSON.parse(line)), [
    { router_phase: "5a_lambda_eliminated" },
  ]);
});

test("cloud routes fail closed when cloud-web worker binding is unavailable", async () => {
  const originalFetch = globalThis.fetch;
  let originCalls = 0;
  const testEnv = {
    ...env,
  };

  globalThis.fetch = (async () => {
    originCalls += 1;
    return new Response("lambda-origin");
  }) as typeof fetch;

  try {
    const response = await router.fetch(
      new Request("https://agentrelay.com/cloud/dashboard"),
      testEnv,
      executionContext(),
    );

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "cloud web worker binding unavailable",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(originCalls, 0);
});

test("WEBHOOK_ORIGIN unset keeps cloud-prefixed nango webhooks on cloud-web worker", async () => {
  let cloudWebCalls = 0;
  let webhookCalls = 0;
  const testEnv = {
    ...env,
    ROUTER_CONFIG: {
      async get(key: string) {
        if (key === "WEBHOOK_ORIGIN") return null;
        return null;
      },
    },
    CLOUD_WEB_WORKER: {
      async fetch() {
        cloudWebCalls += 1;
        return new Response("cloud-web");
      },
    },
    WEBHOOK_WORKER: {
      async fetch() {
        webhookCalls += 1;
        return new Response("webhook-worker");
      },
    },
  };

  const response = await router.fetch(
    new Request("https://agentrelay.com/cloud/api/v1/webhooks/nango", {
      method: "POST",
      body: "{}",
    }),
    testEnv,
    executionContext(),
  );

  assert.equal(await response.text(), "cloud-web");
  assert.equal(cloudWebCalls, 1);
  assert.equal(webhookCalls, 0);
});

test("WEBHOOK_ORIGIN=worker routes only cloud-prefixed nango webhook to WebhookWorker", async () => {
  let cloudWebCalls = 0;
  let webhookCalls = 0;
  const webhookRequests: string[] = [];
  const testEnv = {
    ...env,
    ROUTER_CONFIG: {
      async get(key: string) {
        if (key === "WEBHOOK_ORIGIN") return "worker";
        return null;
      },
    },
    CLOUD_WEB_WORKER: {
      async fetch() {
        cloudWebCalls += 1;
        return new Response("cloud-web");
      },
    },
    WEBHOOK_WORKER: {
      async fetch(workerRequest: Request) {
        webhookCalls += 1;
        webhookRequests.push(workerRequest.url);
        return new Response("webhook-worker");
      },
    },
  };

  const nangoResponse = await router.fetch(
    new Request("https://agentrelay.com/cloud/api/v1/webhooks/nango?probe=1", {
      method: "POST",
      body: "{}",
    }),
    testEnv,
    executionContext(),
  );
  const githubResponse = await router.fetch(
    new Request("https://agentrelay.com/cloud/api/v1/webhooks/github", {
      method: "POST",
      body: "{}",
    }),
    testEnv,
    executionContext(),
  );
  const hookdeckResponse = await router.fetch(
    new Request("https://agentrelay.com/cloud/api/v1/webhooks/hookdeck", {
      method: "POST",
      body: "{}",
    }),
    testEnv,
    executionContext(),
  );
  const composioResponse = await router.fetch(
    new Request("https://agentrelay.com/cloud/api/v1/webhooks/composio", {
      method: "POST",
      body: "{}",
    }),
    testEnv,
    executionContext(),
  );

  assert.equal(await nangoResponse.text(), "webhook-worker");
  assert.equal(await githubResponse.text(), "cloud-web");
  assert.equal(await hookdeckResponse.text(), "cloud-web");
  assert.equal(await composioResponse.text(), "cloud-web");
  assert.equal(webhookCalls, 1);
  assert.equal(cloudWebCalls, 3);
  assert.deepEqual(webhookRequests, [
    "https://agentrelay.com/api/v1/webhooks/nango?probe=1",
  ]);
});

test("flag unset records cloud-web nango webhook traffic when recorder env is bound", async () => {
  let cloudWebCalls = 0;
  let webhookCalls = 0;
  const recorder = createRecorder();
  const testEnv = {
    ...env,
    ...recorder.env,
    CLOUD_WEB_WORKER: {
      async fetch() {
        cloudWebCalls += 1;
        return new Response("cloud-web");
      },
    },
    WEBHOOK_WORKER: {
      async fetch() {
        webhookCalls += 1;
        return new Response("webhook-worker");
      },
    },
  };

  const response = await router.fetch(
    new Request("https://agentrelay.com/cloud/api/v1/webhooks/nango?probe=1", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": "router-recorder-test",
      },
      body: "{}",
    }),
    testEnv,
    recorderExecutionContext(recorder.waits),
  );

  assert.equal(await response.text(), "cloud-web");
  await Promise.all(recorder.waits);
  assert.equal(cloudWebCalls, 1);
  assert.equal(webhookCalls, 0);
  assert.equal(recorder.puts.length, 1);

  const recorded = JSON.parse(recorder.puts[0]!.value) as {
    path: string;
    query: string;
    response_status: number;
  };
  assert.equal(recorded.path, "/cloud/api/v1/webhooks/nango");
  assert.equal(recorded.query, "probe=1");
  assert.equal(recorded.response_status, 200);
});

test("WEBHOOK_ORIGIN=worker origin fallback strips cloud prefix for nango webhook", async () => {
  const originalFetch = globalThis.fetch;
  let cloudWebCalls = 0;
  const originRequests: string[] = [];
  const testEnv = {
    ...env,
    ROUTER_CONFIG: {
      async get(key: string) {
        if (key === "WEBHOOK_ORIGIN") return "worker";
        return null;
      },
    },
    CLOUD_WEB_WORKER: {
      async fetch() {
        cloudWebCalls += 1;
        return new Response("cloud-web");
      },
    },
    WEBHOOK_WORKER_ORIGIN: "https://webhook-worker.example",
  };

  globalThis.fetch = (async (request: RequestInfo | URL) => {
    const url = request instanceof Request ? request.url : request.toString();
    originRequests.push(url);
    return new Response("webhook-origin");
  }) as typeof fetch;

  try {
    const response = await router.fetch(
      new Request("https://agentrelay.com/cloud/api/v1/webhooks/nango?probe=1", {
        method: "POST",
        body: "{}",
      }),
      testEnv,
      executionContext(),
    );

    assert.equal(await response.text(), "webhook-origin");
    assert.equal(cloudWebCalls, 0);
    assert.deepEqual(originRequests, [
      "https://webhook-worker.example/api/v1/webhooks/nango?probe=1",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
